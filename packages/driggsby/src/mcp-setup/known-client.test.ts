import assert from "node:assert/strict";
import { test } from "node:test";

import { CliError } from "../cli-error.ts";
import { parseClient, validateMcpScope } from "./known-client.ts";

test("parses supported clients, case- and whitespace-insensitively", () => {
  assert.equal(parseClient("claude-code"), "claude-code");
  assert.equal(parseClient("codex"), "codex");
  assert.equal(parseClient("other"), "other");
  assert.equal(parseClient("  Claude-Code  "), "claude-code");
  assert.equal(parseClient("CODEX"), "codex");
});

test("rejects unsupported clients with the exact message and exit code 1", () => {
  for (const value of ["   ", "raycast", "claude-desktop"]) {
    assert.throws(
      () => parseClient(value),
      (error: unknown) => error instanceof CliError && error.exitCode === 1,
    );
  }
  assert.throws(
    () => parseClient("raycast"),
    new CliError(
      "Unsupported client: raycast\n\nSupported clients:\n  claude-code\n  codex\n  other",
      1,
    ),
  );
});

test("mcp scope is only supported for Claude Code", () => {
  assert.doesNotThrow(() => {
    validateMcpScope("claude-code", "user");
  });
  assert.doesNotThrow(() => {
    validateMcpScope("codex", undefined);
  });
  for (const client of ["codex", "other"] as const) {
    assert.throws(
      () => {
        validateMcpScope(client, "user");
      },
      new CliError("-s is supported only for Claude Code.", 1),
    );
  }
});

test("client-id trimming matches Rust's str::trim, not JS trim", () => {
  // U+0085 (NEL) is Rust whitespace: trimmed, so the client resolves.
  assert.equal(parseClient("\u0085claude-code\u0085"), "claude-code");
  // U+FEFF (ZWNBSP) is NOT Rust whitespace: it survives and the id fails.
  assert.throws(
    () => parseClient("\ufeffclaude-code"),
    (error: unknown) => error instanceof CliError && error.exitCode === 1,
  );
});
