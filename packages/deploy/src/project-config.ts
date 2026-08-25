// Reads and validates the project's driggsby.json. This is the one file that
// names the app (slug) and what to publish (serve). Validation mirrors the
// deploy API's slug rules so mistakes fail fast, locally, with the fix.
import { readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join, relative, resolve, isAbsolute } from "node:path";

import { DeployError } from "./errors.ts";
import { slugProblem } from "./limits.ts";
import { quotedForTerminal } from "./terminal-text.ts";

export interface ProjectConfig {
  slug: string;
  // Absolute path to the directory whose contents get deployed.
  serveDirectory: string;
  // The relative "serve" value as written, for display ("." when omitted).
  serve: string;
  devCommand: string | null;
  // The app's own page background color, declared so Driggsby can paint
  // it while the app loads. null when the project doesn't declare one.
  background: string | null;
}

// Exactly a bare lowercase hex color — the same shape the deploy API
// enforces, checked locally so a typo fails fast with the fix.
const BACKGROUND_PATTERN = /^#[0-9a-f]{6}$/;

const MISSING_CONFIG_MESSAGE =
  "No driggsby.json found in this directory. Create one next to the files you\n" +
  "want to deploy:\n\n" +
  '  { "slug": "your-app-name", "serve": "." }\n\n' +
  '"slug" names your app — the first deploy gives it a unique address like\n' +
  'your-app-name-x7k2qf.driggsby.dev and saves that assigned name back into\n' +
  'this file — and "serve" is the folder to publish, relative to\n' +
  "driggsby.json.";

export async function readProjectConfig(projectDirectory: string): Promise<ProjectConfig> {
  const configPath = join(projectDirectory, "driggsby.json");
  let raw: string;
  try {
    raw = await readFile(configPath, "utf8");
  } catch {
    throw new DeployError(MISSING_CONFIG_MESSAGE);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new DeployError(
      "driggsby.json isn't valid JSON. It should look like:\n\n" +
        '  { "slug": "your-app-name", "serve": "." }',
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new DeployError('driggsby.json must be a JSON object with a "slug" field.');
  }
  const config = parsed as Record<string, unknown>;

  const slug = config.slug;
  if (typeof slug !== "string" || slug === "") {
    throw new DeployError(
      'driggsby.json is missing its "slug" field. Add one:\n\n' +
        '  { "slug": "your-app-name", "serve": "." }',
    );
  }
  const problem = slugProblem(slug);
  if (problem !== null) {
    throw new DeployError(`The "slug" in driggsby.json won't work: ${problem}.`);
  }

  // Only a genuinely absent "serve" defaults to "." — `?? "."` would let an
  // explicit `"serve": null` silently publish the whole project root, while
  // every other malformed value fails closed below.
  const serve = config.serve === undefined ? "." : config.serve;
  if (typeof serve !== "string" || serve === "") {
    throw new DeployError(
      'The "serve" field in driggsby.json must be a folder path relative to\n' +
        'driggsby.json, like "." or "dist".',
    );
  }
  const serveDirectory = await resolveServeDirectory(projectDirectory, serve);

  // A declared background must be exactly the shape the server accepts;
  // anything else fails here, locally, instead of as a refused deploy.
  // Friendly slop (case, whitespace) normalizes rather than failing.
  const rawBackground = config.background;
  let background: string | null = null;
  if (rawBackground !== undefined && rawBackground !== null) {
    const normalized =
      typeof rawBackground === "string" ? rawBackground.trim().toLowerCase() : "";
    if (!BACKGROUND_PATTERN.test(normalized)) {
      throw new DeployError(
        'The "background" field in driggsby.json must be a plain lowercase hex\n' +
          'color like "#0b0c0f" — your app\'s own page background, so Driggsby can\n' +
          "paint it while the app loads. Remove the field if you don't want one.",
      );
    }
    background = normalized;
  }

  // dev_command is attacker-controlled text from a cloned or generated
  // driggsby.json. Nothing executes it today; any future consumer must spawn
  // it without a shell and never let it reach one.
  const devCommand = config.dev_command;
  return {
    slug,
    serveDirectory,
    serve,
    devCommand: typeof devCommand === "string" && devCommand !== "" ? devCommand : null,
    background,
  };
}

// Persists the server-assigned slug into driggsby.json, keeping every other
// field as-is. This runs after the app is created and BEFORE any bytes
// upload, so a deploy that dies mid-upload never strands an app whose name
// the project forgot. A failed write aborts the deploy with the manual fix,
// because deploying on without saving the name would create a second app on
// the next run.
export async function writeAssignedSlug(
  projectDirectory: string,
  assignedSlug: string,
): Promise<void> {
  const configPath = join(projectDirectory, "driggsby.json");
  let config: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(await readFile(configPath, "utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("driggsby.json is not a JSON object");
    }
    config = parsed as Record<string, unknown>;
    config.slug = assignedSlug;
    // Temp-file-plus-rename, so a crash mid-write can never leave a
    // truncated driggsby.json holding half of a name only the server knows.
    // The temp name starts with a dot: the deploy walk excludes dotfiles at
    // every depth, so a leftover from a crash between write and rename can
    // never be swept into a later deploy and published.
    const temporaryPath = join(projectDirectory, `.driggsby.json.${randomUUID()}.tmp`);
    try {
      await writeFile(temporaryPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
      await rename(temporaryPath, configPath);
    } catch (error) {
      await rm(temporaryPath, { force: true });
      throw error;
    }
  } catch {
    // The assigned slug came from the server, so it prints through
    // quotedForTerminal like every other string this package did not author.
    throw new DeployError(
      `Driggsby created your app as ${quotedForTerminal(assignedSlug, 80)}, but we couldn't save\n` +
        'that name into driggsby.json. Update its "slug" field to exactly that\n' +
        "value, then deploy again.",
    );
  }
}

const SERVE_ESCAPES_PROJECT_MESSAGE =
  'The "serve" folder in driggsby.json must stay inside the project —\n' +
  'a value like "." or "dist", not a path outside it.';

// Everything under the serve folder is uploaded and served publicly, so the
// stay-inside-the-project boundary must hold on real paths, not just the
// written value: checking the string alone would let a serve folder that is
// (or sits under) a symlink pointing outside the project leak outside files
// into the deploy. A serve folder that doesn't exist yet skips the realpath
// check — versions and rollback never read it, and the deploy walk reports
// that case with its own message. The returned path stays as written (only
// the check uses real paths), so paths shown to the user match their config.
async function resolveServeDirectory(projectDirectory: string, serve: string): Promise<string> {
  const projectRoot = resolve(projectDirectory);
  const serveDirectory = resolve(projectRoot, serve);
  if (escapesRoot(relative(projectRoot, serveDirectory))) {
    throw new DeployError(SERVE_ESCAPES_PROJECT_MESSAGE);
  }
  let realProjectRoot: string;
  let realServeDirectory: string;
  try {
    realProjectRoot = await realpath(projectRoot);
    realServeDirectory = await realpath(serveDirectory);
  } catch (error) {
    // Only "it doesn't exist yet" may skip the check; any other resolution
    // failure (permissions, symlink loops) fails closed rather than walking
    // an unverified path.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return serveDirectory;
    }
    throw new DeployError(
      'We couldn\'t check the "serve" folder named in driggsby.json. Check its\n' +
        '"serve" value and try again.',
    );
  }
  if (escapesRoot(relative(realProjectRoot, realServeDirectory))) {
    throw new DeployError(SERVE_ESCAPES_PROJECT_MESSAGE);
  }
  return serveDirectory;
}

function escapesRoot(relativePath: string): boolean {
  return relativePath.startsWith("..") || isAbsolute(relativePath);
}
