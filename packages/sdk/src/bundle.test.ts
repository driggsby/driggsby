import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

// The served SDK must be exactly one self-contained file: Driggsby's
// serving endpoint refuses a build with extra chunks or stylesheets, and
// `driggsby dev` serves this file verbatim on the app origin. pretest runs
// the build, so dist/driggsby-sdk.js is the artifact under test.
const BUNDLE_PATH = join(import.meta.dirname, "..", "dist", "driggsby-sdk.js");

test("the browser bundle is one self-contained ESM file", async () => {
  const bundle = await readFile(BUNDLE_PATH, "utf8");
  assert.ok(bundle.length > 0);
  assert.ok(!/^\s*import\b/m.test(bundle), "the bundle must not import anything at runtime");
  assert.ok(!/\brequire\(/.test(bundle), "the bundle must not require anything at runtime");
});

test("the browser bundle carries the frozen protocol marker and handshake", async () => {
  const bundle = await readFile(BUNDLE_PATH, "utf8");
  assert.ok(bundle.includes("driggsby-sdk/1"));
  assert.ok(bundle.includes("https://app.driggsby.com"));
  // The one-call public surface and the standalone note must survive
  // bundling and minification-free output.
  assert.ok(bundle.includes("watch"));
  assert.ok(bundle.includes("data-driggsby-standalone-note"));
});
