import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildInspectorCommand,
  buildInstallerCommand,
  buildScopedRemoverCommand,
  DRIGGSBY_MCP_URL,
  renderShellCommand,
} from "./commands.ts";

test("codex installer uses the remote MCP URL", () => {
  const command = buildInstallerCommand("codex", undefined);

  assert.equal(command.program, "codex");
  assert.deepEqual(command.args, ["mcp", "add", "driggsby", "--url", DRIGGSBY_MCP_URL]);
});

test("claude code installer defaults to user scope", () => {
  const command = buildInstallerCommand("claude-code", undefined);

  assert.equal(command.program, "claude");
  assert.deepEqual(command.args, [
    "mcp",
    "add",
    "--transport",
    "http",
    "-s",
    "user",
    "driggsby",
    DRIGGSBY_MCP_URL,
  ]);
});

test("claude code installer names this computer in headers after the URL", () => {
  const command = buildInstallerCommand("claude-code", undefined, [
    "X-Driggsby-Device-Name: mbp-studio",
    "X-Driggsby-Device-System: macOS 15.6",
  ]);

  assert.deepEqual(command.args.slice(-6), [
    "driggsby",
    DRIGGSBY_MCP_URL,
    "--header",
    "X-Driggsby-Device-Name: mbp-studio",
    "--header",
    "X-Driggsby-Device-System: macOS 15.6",
  ]);
});

test("codex has no header option, so its installer never carries one", () => {
  const command = buildInstallerCommand("codex", undefined, ["X-Driggsby-Device-Name: mbp-studio"]);

  assert.deepEqual(command.args, ["mcp", "add", "driggsby", "--url", DRIGGSBY_MCP_URL]);
});

test("claude code installer honors local scope", () => {
  const command = buildInstallerCommand("claude-code", "local");

  assert.ok(command.args.join(" ").includes("-s local"));
});

test("claude code remover defaults to user scope", () => {
  const command = buildScopedRemoverCommand("claude-code", undefined);

  assert.deepEqual(command.args, ["mcp", "remove", "driggsby", "-s", "user"]);
});

test("inspector commands read the named driggsby config", () => {
  assert.deepEqual(buildInspectorCommand("claude-code").args, ["mcp", "get", "driggsby"]);
  assert.deepEqual(buildInspectorCommand("codex").args, ["mcp", "get", "driggsby", "--json"]);
});

test("shell rendering quotes the URL and anything outside the safe set", () => {
  assert.equal(
    renderShellCommand(buildInstallerCommand("codex", undefined)),
    "codex mcp add driggsby --url 'https://app.driggsby.com/mcp'",
  );
  assert.equal(
    renderShellCommand({ program: "x", args: ["it's"] }),
    "x 'it'\\''s'",
  );
});
