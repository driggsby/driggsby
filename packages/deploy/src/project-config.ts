// Reads and validates the project's driggsby.json. This is the one file that
// names the app (slug) and what to publish (serve). Validation mirrors the
// deploy API's slug rules so mistakes fail fast, locally, with the fix.
import { readFile, realpath } from "node:fs/promises";
import { join, relative, resolve, isAbsolute } from "node:path";

import { DeployError } from "./errors.ts";
import { slugProblem } from "./limits.ts";

export interface ProjectConfig {
  slug: string;
  // Absolute path to the directory whose contents get deployed.
  serveDirectory: string;
  // The relative "serve" value as written, for display ("." when omitted).
  serve: string;
  devCommand: string | null;
}

const MISSING_CONFIG_MESSAGE =
  "No driggsby.json found in this directory. Create one next to the files you\n" +
  "want to deploy:\n\n" +
  '  { "slug": "your-app-name", "serve": "." }\n\n' +
  '"slug" names your app (it becomes your-app-name.driggsby.dev) and "serve"\n' +
  "is the folder to publish, relative to driggsby.json.";

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

  // dev_command is attacker-controlled text from a cloned or generated
  // driggsby.json. Nothing executes it today; any future consumer must spawn
  // it without a shell and never let it reach one.
  const devCommand = config.dev_command;
  return {
    slug,
    serveDirectory,
    serve,
    devCommand: typeof devCommand === "string" && devCommand !== "" ? devCommand : null,
  };
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
