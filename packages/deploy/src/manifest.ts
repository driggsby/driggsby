// Walks the serve directory into the deploy manifest: every deployable file
// with its SHA-256 and byte size. The exclusions here are a safety boundary,
// not tidiness — the deploy API serves whatever it is given, so dotfiles
// (.env, .git) at any depth and the serve root's own driggsby.json must
// never leave this machine. (A nested driggsby.json is an ordinary file: it
// belongs to whatever subfolder carries it, not to this deploy.)
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";

import { DeployError } from "./errors.ts";
import { quotedForTerminal } from "./terminal-text.ts";
import {
  MAX_FILE_BYTES,
  MAX_FILE_COUNT,
  MAX_PATH_LENGTH,
  MAX_TOTAL_BYTES,
  PATH_SEGMENT_PATTERN,
} from "./limits.ts";

export interface DeployFile {
  // Forward-slash relative path, exactly as sent in the manifest.
  path: string;
  absolutePath: string;
  byteSize: number;
  sha256: string;
}

export interface CollectedDeploy {
  // Sorted by path for a deterministic manifest.
  files: DeployFile[];
  totalBytes: number;
  // Relative paths of symlinks that were skipped (never followed). These
  // are raw filesystem names that bypass the manifest's character
  // validation — sanitize them before printing to a terminal.
  skippedSymlinks: string[];
  // Relative paths of node_modules directories that were left out of the
  // deploy (see the walk for why).
  skippedNodeModules: string[];
}

// Test seam only: shrink the mirrored server limits so limit handling is
// testable without multi-megabyte fixtures.
export interface CollectOptions {
  limitOverridesForTests?: {
    maxFileBytes?: number;
    maxTotalBytes?: number;
    maxFileCount?: number;
  };
}

export async function collectDeployFiles(
  serveDirectory: string,
  options: CollectOptions = {},
): Promise<CollectedDeploy> {
  const maxFileBytes = options.limitOverridesForTests?.maxFileBytes ?? MAX_FILE_BYTES;
  const maxTotalBytes = options.limitOverridesForTests?.maxTotalBytes ?? MAX_TOTAL_BYTES;
  const maxFileCount = options.limitOverridesForTests?.maxFileCount ?? MAX_FILE_COUNT;

  const files: DeployFile[] = [];
  const skippedSymlinks: string[] = [];
  const skippedNodeModules: string[] = [];
  // Count and total-size limits are enforced INSIDE the walk, before each
  // file is hashed — a limit must fail as soon as it is crossed, not after
  // reading and SHA-256ing hundreds of megabytes that were never going to
  // deploy.
  const limits = { maxFileBytes, maxTotalBytes, maxFileCount };
  // silentlySkippedCount covers the entries the walk drops without reporting
  // them to the caller (dotfiles, dot-directories, the top-level
  // driggsby.json) — the empty-folder message below must still know they
  // were there.
  const tally = { totalBytes: 0, silentlySkippedCount: 0 };
  await walkDirectory(serveDirectory, [], files, {
    skippedSymlinks,
    skippedNodeModules,
    limits,
    tally,
  });
  files.sort((a, b) => (a.path < b.path ? -1 : 1));

  if (files.length === 0) {
    // When the folder isn't actually empty, saying "has no files" would
    // contradict what the user sees in front of them — name what happened.
    if (
      skippedSymlinks.length > 0 ||
      skippedNodeModules.length > 0 ||
      tally.silentlySkippedCount > 0
    ) {
      throw new DeployError(
        "There's nothing to deploy — everything in the serve folder was\n" +
          "skipped (symlinks, node_modules, dotfiles, and driggsby.json itself\n" +
          "never deploy). Add your app's files (starting with index.html) and\n" +
          "deploy again.",
      );
    }
    throw new DeployError(
      "There's nothing to deploy — the serve folder has no files. Add your\n" +
        "app's files (starting with index.html) and deploy again.",
    );
  }
  requireIndexHtml(files);
  const totalBytes = files.reduce((sum, file) => sum + file.byteSize, 0);
  return { files, totalBytes, skippedSymlinks, skippedNodeModules };
}

interface WalkLimits {
  maxFileBytes: number;
  maxTotalBytes: number;
  maxFileCount: number;
}

interface WalkState {
  skippedSymlinks: string[];
  skippedNodeModules: string[];
  limits: WalkLimits;
  tally: { totalBytes: number; silentlySkippedCount: number };
}

async function walkDirectory(
  absoluteDirectory: string,
  segments: string[],
  files: DeployFile[],
  state: WalkState,
): Promise<void> {
  let entries;
  try {
    entries = await readdir(absoluteDirectory, { withFileTypes: true });
  } catch {
    throw new DeployError(
      segments.length === 0
        ? 'We couldn\'t read the serve folder named in driggsby.json. Check its\n"serve" value and try again.'
        : `We couldn't read the folder ${quotedForTerminal(segments.join("/"), 80)} inside the\nserve folder. Check it and try again.`,
    );
  }
  for (const entry of entries) {
    // Dotfiles and dot-directories never deploy: they are where secrets and
    // repo internals live (.env, .git), and the deployed app serves every
    // uploaded file to the internet.
    if (entry.name.startsWith(".")) {
      state.tally.silentlySkippedCount += 1;
      continue;
    }
    if (segments.length === 0 && entry.name === "driggsby.json") {
      state.tally.silentlySkippedCount += 1;
      continue;
    }
    const relativePath = [...segments, entry.name].join("/");
    // Symlinks never deploy: following one would publish content from
    // outside the serve folder. (Hard links are indistinguishable from
    // regular files and deploy normally — build tools legitimately
    // hard-link outputs, and anyone able to create one inside this folder
    // could just as well copy the file here.)
    if (entry.isSymbolicLink()) {
      state.skippedSymlinks.push(relativePath);
      continue;
    }
    if (entry.isDirectory()) {
      // node_modules never deploys: Driggsby apps are served as static
      // files, so a dependency tree is dev-machine clutter that would blow
      // the file-count limit — and its scoped-package folders (@types, ...)
      // would otherwise trip the character check with a "rename it" message
      // that is exactly wrong for the most common first-run mistake
      // (pointing "serve" at a project root).
      if (entry.name === "node_modules") {
        state.skippedNodeModules.push(relativePath);
        continue;
      }
      validateSegment(entry.name, relativePath, segments.length === 0);
      await walkDirectory(join(absoluteDirectory, entry.name), [...segments, entry.name], files, state);
      continue;
    }
    if (!entry.isFile()) {
      continue;
    }
    validateSegment(entry.name, relativePath, segments.length === 0);
    if (relativePath.length > MAX_PATH_LENGTH) {
      throw new DeployError(
        `One file's path is too long to deploy (over ${MAX_PATH_LENGTH} characters):\n` +
          `${quotedForTerminal(relativePath, 80)}...\nShorten the folder or file names and deploy again.`,
      );
    }
    const absolutePath = join(absoluteDirectory, entry.name);
    const info = await stat(absolutePath);
    if (info.size > state.limits.maxFileBytes) {
      throw new DeployError(
        `${quotedForTerminal(relativePath, 80)} is ${formatBytes(info.size)}, and a single file can\n` +
          `be at most ${formatBytes(state.limits.maxFileBytes)}. Shrink or remove it and deploy again.`,
      );
    }
    if (files.length >= state.limits.maxFileCount) {
      throw new DeployError(
        `This deploy has more than ${state.limits.maxFileCount} files, and that's as many as a\n` +
          "Driggsby app can hold. Remove what the app doesn't need and deploy\nagain.",
      );
    }
    state.tally.totalBytes += info.size;
    if (state.tally.totalBytes > state.limits.maxTotalBytes) {
      throw new DeployError(
        `This deploy is over ${formatBytes(state.limits.maxTotalBytes)} in total, and that's as much as a\n` +
          "Driggsby app can hold. Slim it down and deploy again.",
      );
    }
    files.push({
      path: relativePath,
      absolutePath,
      byteSize: info.size,
      sha256: await sha256File(absolutePath),
    });
  }
}

function validateSegment(name: string, relativePath: string, isTopLevel: boolean): void {
  // "-" is a valid character but a reserved top-level name: Driggsby serves
  // its own pages under the app's /-/ namespace. Deeper down, "-" is an
  // ordinary name the deploy API accepts.
  if (isTopLevel && name === "-") {
    throw new DeployError(
      `${quotedForTerminal(relativePath, 80)} can't be deployed: "-" is a name Driggsby reserves\n` +
        "for its own pages on your app's address. Rename it and deploy again.",
    );
  }
  if (!PATH_SEGMENT_PATTERN.test(name) || name === "." || name === "..") {
    throw new DeployError(
      `${quotedForTerminal(relativePath, 80)} can't be deployed: file and folder names may only\n` +
        "use letters, digits, dots, dashes, and underscores (no spaces). Rename\n" +
        "it and deploy again.",
    );
  }
}

function requireIndexHtml(files: DeployFile[]): void {
  if (files.some((file) => file.path === "index.html")) {
    return;
  }
  const hasPackageJson = files.some((file) => file.path === "package.json");
  const buildHint = hasPackageJson
    ? "\n\nThis looks like a project that needs a build step. Run your build, then\n" +
      'point "serve" in driggsby.json at the build output folder (often "dist"\n' +
      'or "build") — Driggsby apps deploy as static files.'
    : "";
  throw new DeployError(
    "The serve folder has no index.html at its top level, so the deployed app\n" +
      "would show an empty page. Add an index.html (or point \"serve\" in\n" +
      `driggsby.json at the folder that has one) and deploy again.${buildHint}`,
  );
}

async function sha256File(absolutePath: string): Promise<string> {
  const hash = createHash("sha256");
  await pipeline(createReadStream(absolutePath), hash);
  return hash.digest("hex");
}

export function formatBytes(bytes: number): string {
  if (bytes < 1_000) {
    return `${bytes} B`;
  }
  if (bytes < 1_000_000) {
    return `${trimmedFixed(bytes / 1_000)} KB`;
  }
  return `${trimmedFixed(bytes / 1_000_000)} MB`;
}

// 6.2, but 42 (not 42.0) — one decimal only when it says something.
function trimmedFixed(value: number): string {
  const rounded = value >= 100 ? Math.round(value).toString() : value.toFixed(1);
  return rounded.endsWith(".0") ? rounded.slice(0, -2) : rounded;
}
