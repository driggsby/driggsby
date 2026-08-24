// Server-enforced deploy limits, mirrored client-side so a bad deploy fails
// fast with a clear local message instead of a round trip. Values match the
// Driggsby deploy API; the server remains the authority.
export const MAX_FILE_BYTES = 26_214_400; // 25 MiB per file (prints as 26.2 MB)
export const MAX_TOTAL_BYTES = 52_428_800; // 50 MiB per version (prints as 52.4 MB)
export const MAX_FILE_COUNT = 2_000;
export const MAX_PATH_LENGTH = 512;

// A path segment the deploy API accepts: ASCII letters, digits, dot, dash,
// underscore. No spaces, no path tricks, nothing percent-encoded.
export const PATH_SEGMENT_PATTERN = /^[A-Za-z0-9._-]+$/;

// App slugs: 3-63 chars, lowercase letters/digits/dashes, no leading or
// trailing dash, and no "xn--"-style label (dashes in positions 3 and 4).
export const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;
export const SLUG_PUNYCODE_PATTERN = /^..--/;

// Slugs the server refuses because they collide with Driggsby's own hosts
// and reserved names. Kept in sync with the deploy API.
export const RESERVED_SLUGS: readonly string[] = [
  "www", "app", "api", "mcp", "mail", "email", "smtp", "admin", "operator",
  "console", "dashboard", "dashboards", "deploy", "deploys", "blog", "docs",
  "help", "support", "status", "assets", "static", "cdn", "dev", "test",
  "staging", "demo", "driggsby", "plaid", "auth", "login", "signin", "signup",
  "connect", "settings", "billing", "security", "abuse", "postmaster",
  "webmaster", "root",
];

// Returns a human-readable problem with the slug, or null when it is valid.
export function slugProblem(slug: string): string | null {
  if (!SLUG_PATTERN.test(slug)) {
    return (
      "an app slug must be 3-63 characters of lowercase letters, digits, and\n" +
      "dashes, and must start and end with a letter or digit"
    );
  }
  if (SLUG_PUNYCODE_PATTERN.test(slug)) {
    return "an app slug can't have dashes in its third and fourth characters";
  }
  if (RESERVED_SLUGS.includes(slug)) {
    return "that slug is reserved by Driggsby — pick another name";
  }
  return null;
}
