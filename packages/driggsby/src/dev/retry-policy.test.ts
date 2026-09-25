import assert from "node:assert/strict";
import { test } from "node:test";

import { httpRetryHint, refusalRetryHint, retryDelayMs } from "./retry-policy.ts";

test("the wait is full jitter under a growing ceiling, never below the server's hint, never past 60 s", () => {
  assert.equal(retryDelayMs(0, null, () => 0.999), 999);
  assert.equal(retryDelayMs(2, null, () => 0.999), 3_996);
  assert.equal(retryDelayMs(9, null, () => 0.999), 7_992, "the ceiling stops at 8 s");
  assert.equal(retryDelayMs(0, 2_500, () => 0), 2_500);
  assert.equal(retryDelayMs(0, 10_000_000, () => 0), 60_000);
  assert.equal(retryDelayMs(0, -5, () => 0), 0);
});

test("only a retryable refusal with a known kind is a hint, and a bad retry_after_ms is ignored", () => {
  assert.deepEqual(refusalRetryHint({ kind: "busy", retryable: true, retry_after_ms: 1_200 }), { kind: "busy", afterMs: 1_200 });
  assert.deepEqual(refusalRetryHint({ kind: "timeout", retryable: true, retry_after_ms: Number.NaN }), { kind: "timeout", afterMs: null });
  assert.equal(refusalRetryHint({ kind: "busy", retryable: false }), null);
  assert.equal(refusalRetryHint({ kind: "melted", retryable: true }), null);
  assert.equal(refusalRetryHint(null), null);
});

test("408, 429 and 5xx retry as a failed request, with Retry-After in seconds; other statuses don't", () => {
  assert.deepEqual(httpRetryHint(429, "3"), { kind: "transport", afterMs: 3_000 });
  assert.deepEqual(httpRetryHint(408, null), { kind: "transport", afterMs: null });
  assert.deepEqual(httpRetryHint(503, "Wed, 21 Oct 2015 07:28:00 GMT"), { kind: "transport", afterMs: null });
  assert.equal(httpRetryHint(404, "3"), null);
  assert.equal(httpRetryHint(400, null), null);
});
