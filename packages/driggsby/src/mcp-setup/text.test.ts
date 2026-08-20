import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { buildInstallerCommand } from "./commands.ts";
import {
  manualCommandBlock,
  nextStepLines,
  otherClientInstructionsBlock,
  successBlock,
} from "./text.ts";

function fixture(name: string): string {
  return readFileSync(new URL(`../__fixtures__/${name}`, import.meta.url), "utf8");
}

test("next steps are client-specific", () => {
  assert.deepEqual(nextStepLines("claude-code", false), [
    "  Open Claude Code, run /mcp, and authenticate Driggsby to get started.",
  ]);
  assert.deepEqual(nextStepLines("codex", false), [
    "  Complete the Driggsby sign-in in the browser window opened by Codex.",
    "  If no browser window opened, run:",
    "    codex mcp login driggsby",
  ]);
  assert.deepEqual(nextStepLines("codex", true), ["  Open Codex and ask it to use Driggsby."]);
});

test("success block matches the original CLI byte-for-byte", () => {
  assert.equal(
    successBlock("claude-code", false),
    "Claude Code is set up.\n\nDriggsby MCP URL:\n  https://app.driggsby.com/mcp\n\nNext:\n  Open Claude Code, run /mcp, and authenticate Driggsby to get started.\n",
  );
});

test("manual command blocks match the Rust CLI fixtures byte-for-byte", () => {
  assert.equal(
    manualCommandBlock("claude-code", buildInstallerCommand("claude-code", undefined)),
    fixture("print-claude.txt"),
  );
  assert.equal(
    manualCommandBlock("claude-code", buildInstallerCommand("claude-code", "local")),
    fixture("print-claude-local.txt"),
  );
  assert.equal(
    manualCommandBlock("codex", buildInstallerCommand("codex", undefined)),
    fixture("print-codex.txt"),
  );
});

test("other-client instructions match the Rust CLI fixture byte-for-byte", () => {
  assert.equal(otherClientInstructionsBlock(), fixture("other.txt"));
});
