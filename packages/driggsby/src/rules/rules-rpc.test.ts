import assert from "node:assert/strict";
import { test } from "node:test";

import { terminalSafeJson } from "../terminal-text.ts";
import { interpretToolCall } from "./rules-rpc.ts";

test("terminalSafeJson escapes C1 controls, bidi overrides, and invisible code points, and stays valid JSON", () => {
  const value = { name: "Rent\u009b31m\u202eevil\u2066x\u200by\u{e0041}z" };
  const text = terminalSafeJson(value);
  assert.ok(!/[\u007f-\u009f\u2028\u2029]|\p{Default_Ignorable_Code_Point}/u.test(text));
  assert.ok(text.includes("\\udb40\\udc41"));
  assert.deepEqual(JSON.parse(text), value);
});

test("a refusal keeps its structured details", () => {
  const details = { error: "Answer the suggestion first.", suggestions: [{ id: "wide_match", options: ["all_history", "from_date"] }] };
  const outcome = interpretToolCall({ jsonrpc: "2.0", id: 1, result: { isError: true, structuredContent: details, content: [] } });
  assert.deepEqual(outcome, { kind: "refused", message: "Answer the suggestion first.", details });
});

test("a protocol error is an error with the server's sanitized message", () => {
  const outcome = interpretToolCall({ jsonrpc: "2.0", id: 1, error: { code: -32602, message: "rule is \u001b[31mrequired" } });
  assert.deepEqual(outcome, { kind: "error", message: "rule is [31mrequired" });
});

test("a success is the structured content", () => {
  assert.deepEqual(interpretToolCall({ jsonrpc: "2.0", id: 1, result: { isError: false, structuredContent: { rules: [] } } }), {
    kind: "ok",
    result: { rules: [] },
  });
});

test("a message cut at the cap says so", () => {
  const outcome = interpretToolCall({ jsonrpc: "2.0", id: 1, error: { code: -32602, message: "x".repeat(5_000) } });
  assert.ok(outcome.kind === "error" && outcome.message.length === 1_000 && outcome.message.endsWith("…"));
});
