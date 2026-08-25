// The static file half of the local app origin: what `driggsby dev` serves
// from the project's serve folder. It serves what a deploy would publish —
// dotfiles at any depth, the top-level driggsby.json, node_modules, and
// symlinks are never served, just as the deploy walk never uploads them —
// so the local preview and the deployed app agree on what exists. The
// exclusions here match case-insensitively (stricter than the deploy walk):
// most local filesystems are case-insensitive, so /DRIGGSBY.JSON must not
// reach the file the exact-case check would have refused.
import { lstat, readFile, realpath } from "node:fs/promises";
import { extname, join, normalize, relative, isAbsolute, sep } from "node:path";

const CONTENT_TYPES: Record<string, string> = {
  ".avif": "image/avif",
  ".css": "text/css; charset=utf-8",
  ".gif": "image/gif",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

export interface StaticResponse {
  status: number;
  contentType: string;
  body: Buffer | string;
}

// Resolves a request path to a file under the serve folder, or null when the
// path is outside what dev serves (bad encoding, traversal, an excluded
// file, a symlink, or a missing file). "/" serves index.html, like the
// deployed app.
export async function serveStaticFile(
  serveDirectory: string,
  rawPath: string,
): Promise<StaticResponse | null> {
  const relativePath = safeRelativePath(rawPath);
  if (relativePath === null) {
    return null;
  }
  const filePath = join(serveDirectory, relativePath);
  if (!(await isRegularFileInside(serveDirectory, filePath))) {
    return null;
  }
  let body: Buffer;
  try {
    body = await readFile(filePath);
  } catch {
    return null;
  }
  const contentType = CONTENT_TYPES[extname(relativePath).toLowerCase()] ?? "application/octet-stream";
  return { status: 200, contentType, body };
}

// Request path -> a safe relative file path, or null. Everything that could
// step outside the serve folder or reach an unpublished file fails closed.
// The exclusions mirror the deploy walk: dotfiles and node_modules at any
// depth, driggsby.json only at the top level (a nested one is an ordinary
// file there too) — refused in any casing, per the header note.
function safeRelativePath(rawPath: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(rawPath);
  } catch {
    return null;
  }
  if (decoded.includes("\0")) {
    return null;
  }
  const withoutLeadingSlash = decoded.replace(/^\/+/, "");
  const relativePath = withoutLeadingSlash === "" ? "index.html" : withoutLeadingSlash;

  const normalized = normalize(relativePath);
  if (normalized.startsWith("..") || isAbsolute(normalized) || /^[A-Za-z]:/.test(normalized)) {
    return null;
  }
  const segments = normalized.split(sep);
  for (const segment of segments) {
    const lowered = segment.toLowerCase();
    if (segment === "" || lowered === ".." || lowered === "node_modules" || segment.startsWith(".")) {
      return null;
    }
  }
  if (normalized.toLowerCase() === "driggsby.json") {
    return null;
  }
  return normalized;
}

// The deploy walk skips symlinks, so dev refuses them too — locally that
// also stops a link from serving files outside the project. The realpath
// containment check backs the segment checks with the filesystem's own view.
async function isRegularFileInside(serveDirectory: string, filePath: string): Promise<boolean> {
  try {
    const stats = await lstat(filePath);
    if (!stats.isFile()) {
      return false;
    }
    const realRoot = await realpath(serveDirectory);
    const realFile = await realpath(filePath);
    const relativePath = relative(realRoot, realFile);
    return relativePath !== "" && !relativePath.startsWith("..") && !isAbsolute(relativePath);
  } catch {
    return false;
  }
}
