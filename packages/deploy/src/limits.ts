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
// There is no reserved-name list to mirror: Driggsby assigns every app's
// final address by adding a unique ending to the name you pick, so any
// readable name works and names never collide.
export const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;
export const SLUG_PUNYCODE_PATTERN = /^..--/;

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
  return null;
}
