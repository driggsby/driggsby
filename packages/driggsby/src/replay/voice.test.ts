import assert from "node:assert/strict";
import { test } from "node:test";

import { CUES } from "./att-story.ts";
import { lineAt, playerCommand } from "./voice.ts";

test("a jump picks up the line being said at the new moment, how far in", () => {
  const [first, second] = CUES;
  assert.ok(first !== undefined && second !== undefined);
  assert.equal(lineAt(CUES, 0), null, "before the first sound, nothing to say");
  assert.deepEqual(lineAt(CUES, first.at), { file: first.file, offset: 0 });
  const mid = lineAt(CUES, second.at + 1.25);
  assert.ok(mid !== null);
  assert.equal(mid.file, second.file);
  assert.ok(Math.abs(mid.offset - 1.25) < 1e-9);
  const last = CUES.at(-1);
  assert.equal(lineAt(CUES, 10_000)?.file, last?.file, "past the end, the last sound (the player stays silent past its end)");
});

test("player commands are one tab-separated line, and a path that could break one is dropped", () => {
  assert.equal(playerCommand(["play", "/a b/att-01.m4a", "1.500", 2, 0]), "play\t/a b/att-01.m4a\t1.500\t2\t0\n");
  assert.equal(playerCommand(["pause"]), "pause\n");
  assert.equal(playerCommand(["play", "/odd\tpath.m4a", "0", 1, 0]), null);
  assert.equal(playerCommand(["play", "/odd\npath.m4a", "0", 1, 0]), null);
});
