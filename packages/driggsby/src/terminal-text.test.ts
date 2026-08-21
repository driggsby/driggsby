import assert from "node:assert/strict";
import { test } from "node:test";

import { wrapProse } from "./terminal-text.ts";

test("wrapProse keeps every line within the width without splitting words", () => {
  const input =
    "We weren't able to remove your Driggsby app token from your macOS keychain " +
    "and the ~/.driggsby/credentials.json file, so it may still be saved there.";
  const wrapped = wrapProse(input, 76);
  for (const line of wrapped.split("\n")) {
    assert.ok(line.length <= 76, `line exceeds 76 columns: ${line}`);
  }
  // Words survive intact; only spaces become line breaks, so rejoining with
  // spaces reproduces the input exactly.
  assert.equal(wrapped.replaceAll("\n", " "), input);
  assert.ok(wrapped.includes("~/.driggsby/credentials.json"));
});

test("wrapProse leaves short text and overlong single words alone", () => {
  assert.equal(wrapProse("Signed out.", 76), "Signed out.");
  const longWord = "x".repeat(100);
  assert.equal(wrapProse(`before ${longWord} after`, 76), `before\n${longWord}\nafter`);
});
