import assert from "node:assert/strict";
import { test } from "node:test";

import { toolCallLine } from "./tool-call-line.ts";

test("a call that loaded prints a check and its time; one that failed prints a cross and why", () => {
  assert.equal(toolCallLine("query_cash_sql", { ok: true, result: {} }, 210), "✓ query_cash_sql 0.21s\n");
  assert.equal(
    toolCallLine("get_history", { ok: false, error: { message: "Synthetic refusal.", kind: "busy" } }, 4_000),
    "✗ get_history: Synthetic refusal.\n",
  );
});

test("a long failure wraps, and its continuation lines are indented under the cross", () => {
  const message = `${"word ".repeat(40).trim()}.`;
  const lines = toolCallLine("get_history", { ok: false, error: { message } }, 0).trimEnd().split("\n");

  assert.ok(lines.length > 1);
  assert.ok(lines[0]?.startsWith("✗ get_history: "));
  assert.ok(lines.slice(1).every((line) => line.startsWith("    ")));
});
