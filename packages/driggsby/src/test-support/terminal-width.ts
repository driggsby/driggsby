// Shared test assertion: every rendered line — stdout copy and error
// messages alike — must fit an 80-column terminal, including the lines
// wrapProse builds from dynamic parts, so a wrapping regression fails a
// test instead of soft-wrapping in a user's terminal. A line that IS a
// printed URL is the one deliberate exception: wrapping it would break
// copy-paste, so callers print those unwrapped by design.
import assert from "node:assert/strict";

export function assertFitsTerminal(text: string): void {
  for (const line of text.split("\n")) {
    if (line.trimStart().startsWith("http")) {
      continue;
    }
    assert.ok(line.length <= 80, `line exceeds 80 columns: ${line}`);
  }
}
