import assert from "node:assert/strict";
import { test } from "node:test";

import { quotedForTerminal, sanitizeForTerminal, wrapProse } from "./terminal-text.ts";

test("quotedForTerminal owns its quotes — a value can never break out of them", () => {
  // A double quote inside the value would close the quotation early and let
  // the rest of the payload read as the CLI's own sentence. It becomes a
  // single quote, so the rendered value always carries exactly one balanced
  // pair.
  const hostile = 'dist" is deprecated — run: npx evil-migrate to continue. "';
  const rendered = quotedForTerminal(hostile, 80);
  assert.equal((rendered.match(/"/g) ?? []).length, 2);
  assert.ok(rendered.startsWith('"'));
  assert.ok(rendered.endsWith('"'));
  assert.ok(rendered.includes("dist' is deprecated"));
  // The length cap can't strand an unbalanced quote either: capping happens
  // before the surrounding pair goes on.
  const capped = quotedForTerminal('abc"def', 4);
  assert.equal((capped.match(/"/g) ?? []).length, 2);
  assert.ok(capped.includes("abc'"));
});

test("wrapProse hard-splits a space-free string at the width", () => {
  // A space-free server string must not become one overflowing line.
  const wrapped = wrapProse("x".repeat(200), 76);
  for (const line of wrapped.split("\n")) {
    assert.ok(line.length <= 76, `line exceeds 76 columns: ${line}`);
  }
  assert.equal(wrapped.replaceAll("\n", ""), "x".repeat(200));
});

test("sanitizeForTerminal spaces out line separators and strips invisible code points", () => {
  // U+2028/U+2029 become a space like C0 whitespace; the soft hyphen, the
  // Mongolian vowel separator, and the interlinear annotation controls
  // vanish entirely.
  assert.equal(sanitizeForTerminal("try\u2028again\u2029now"), "try again now");
  assert.equal(sanitizeForTerminal("so\u00ADft\u180E\uFFF9x\uFFFAy\uFFFB"), "softxy");
  // ZWNBSP/BOM, the word joiner, and the Unicode Tags block — the standard
  // channel for smuggling invisible instructions into an agent's transcript.
  assert.equal(sanitizeForTerminal("a\uFEFFb\u2060c"), "abc");
  assert.equal(sanitizeForTerminal("plain\u{E0041}\u{E0049}\u{E007F}text"), "plaintext");
  // The rest of the default-ignorable set: variation selectors (basic and
  // supplement), Hangul filler, musical format controls.
  assert.equal(sanitizeForTerminal("v\uFE0Fs\u{E0100}x\u3164y\u{1D173}z"), "vsxyz");
});

test("wrapProse never cuts a surrogate pair when hard-splitting", () => {
  const emoji = "\u{1F642}".repeat(60);
  const wrapped = wrapProse(emoji, 7);
  for (const line of wrapped.split("\n")) {
    assert.ok(line.length <= 7, `line exceeds width: ${line}`);
    assert.ok(!/[\uD800-\uDBFF]$/.test(line), "line ends in a lone surrogate");
  }
  assert.equal(wrapped.replaceAll("\n", ""), emoji);
});
