import { readFileSync } from "node:fs";

// Read the version from this package's own manifest so it can never drift
// from what npm published. Resolved relative to this module, which sits one
// directory below the package root both in src/ (tests) and dist/ (shipped).
const manifest = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as { version: string };

export const VERSION: string = manifest.version;
