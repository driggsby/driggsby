import assert from "node:assert/strict";
import { test } from "node:test";

import { classifyExistingMcpConfig, type ClientCommandOutput } from "./classify.ts";

function output(succeeded: boolean, stdout: string, stderr = ""): ClientCommandOutput {
  return { succeeded, stdout, stderr };
}

test("claude code user config matches the expected remote MCP", () => {
  const probe = output(
    true,
    "driggsby:\n  Scope: User config (available in all your projects)\n  Status: x Failed to connect\n  Type: http\n  URL: https://app.driggsby.com/mcp\n",
  );

  assert.equal(classifyExistingMcpConfig("claude-code", undefined, probe), "matches");
});

test("claude code scope mismatch differs", () => {
  const probe = output(
    true,
    "driggsby:\n  Scope: User config (available in all your projects)\n  Type: http\n  URL: https://app.driggsby.com/mcp\n",
  );

  assert.equal(classifyExistingMcpConfig("claude-code", "local", probe), "differs");
});

test("codex remote config matches the expected remote MCP", () => {
  const probe = output(
    true,
    '{\n  "name": "driggsby",\n  "enabled": true,\n  "transport": {\n    "type": "streamable_http",\n    "url": "https://app.driggsby.com/mcp"\n  }\n}\n',
  );

  assert.equal(classifyExistingMcpConfig("codex", undefined, probe), "matches");
});

test("a different URL differs", () => {
  const probe = output(true, '{\n  "enabled": true,\n  "type": "streamable_http",\n  "url": "https://example.com/mcp"\n}\n');

  assert.equal(classifyExistingMcpConfig("codex", undefined, probe), "differs");
});

test("missing config is not a conflict", () => {
  const probe = output(false, "", "Error: No MCP server named 'driggsby' found.");

  assert.equal(classifyExistingMcpConfig("codex", undefined, probe), "missing");
});

test("an unreadable probe is unknown", () => {
  const probe = output(false, "", "some transient failure");

  assert.equal(classifyExistingMcpConfig("codex", undefined, probe), "unknown");
});
