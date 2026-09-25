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

// Claude Code 2.1.281's layout for an entry an earlier version gave device
// headers: Claude Code doesn't send its sign-in to it, so setup replaces it.
test("claude code entry carrying device headers differs", () => {
  const probe = output(
    true,
    "driggsby:\n  Scope: User config (available in all your projects)\n  Status: ✔ Connected\n  Type: http\n" +
      "  URL: https://app.driggsby.com/mcp\n  Headers:\n    X-Driggsby-Device-Name: mbp-studio\n" +
      "    X-Driggsby-Device-System: macOS 15.6\n\nTo remove this server, run: claude mcp remove \"driggsby\" -s user\n",
  );

  assert.equal(classifyExistingMcpConfig("claude-code", undefined, probe), "differs");
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
