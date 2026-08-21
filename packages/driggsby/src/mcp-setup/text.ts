// Every user-facing mcp-setup text block, byte-compatible with the original
// Rust CLI output (pinned by the fixture parity tests). Terminal command
// suggestions are raw and copy-pasteable — never wrapped in backticks.
import { DRIGGSBY_MCP_URL, type McpConfigCommand, renderShellCommand } from "./commands.ts";
import { displayName, type KnownClient } from "./known-client.ts";

export function nextStepLines(client: KnownClient, completedLogin: boolean): string[] {
  switch (client) {
    case "claude-code":
      return ["  Open Claude Code, run /mcp, and authenticate Driggsby to get started."];
    case "codex":
      if (completedLogin) {
        return ["  Open Codex and ask it to use Driggsby."];
      }
      return [
        "  Complete the Driggsby sign-in in the browser window opened by Codex.",
        "  If no browser window opened, run:",
        "    codex mcp login driggsby",
      ];
    case "other":
      return otherClientInstructionLines();
  }
}

function alreadySetupNextStepLines(client: KnownClient): string[] {
  switch (client) {
    case "claude-code":
      return ["  Open Claude Code, run /mcp, and authenticate Driggsby if prompted."];
    case "codex":
      return [
        "  Open Codex and ask it to use Driggsby.",
        "  If Codex asks you to sign in, run:",
        "    codex mcp login driggsby",
      ];
    case "other":
      return [];
  }
}

function otherClientInstructionLines(): string[] {
  return [
    "  Add a remote MCP server named driggsby.",
    "  Set its URL to https://app.driggsby.com/mcp.",
    "  Choose OAuth authentication if the client asks.",
    "  Complete the Driggsby browser sign-in when prompted.",
    "",
    "Requirement:",
    "  The MCP client must support OAuth-based MCP authentication.",
  ];
}

export function successBlock(client: KnownClient, completedLogin: boolean): string {
  return (
    `${displayName(client)} is set up.\n\nDriggsby MCP URL:\n  ${DRIGGSBY_MCP_URL}\n\nNext:\n` +
    joinLines(nextStepLines(client, completedLogin))
  );
}

export function alreadySetupBlock(client: KnownClient): string {
  return (
    `Driggsby is already set up in ${displayName(client)} MCP config.\n\n` +
    `Driggsby MCP URL:\n  ${DRIGGSBY_MCP_URL}\n\nNext:\n` +
    joinLines(alreadySetupNextStepLines(client))
  );
}

export function existingConfigDiffersBlock(
  client: KnownClient,
  remover: McpConfigCommand,
  installer: McpConfigCommand,
): string {
  return (
    `Driggsby already exists in ${displayName(client)} MCP config, ` +
    `but it does not match the expected Driggsby setup.\n\n` +
    `Expected Driggsby MCP URL:\n  ${DRIGGSBY_MCP_URL}\n\n` +
    `To replace the existing entry, run:\n` +
    `  ${renderShellCommand(remover)}\n` +
    `  ${renderShellCommand(installer)}\n`
  );
}

export function manualCommandBlock(client: KnownClient, installer: McpConfigCommand): string {
  return (
    `Run this command to add Driggsby to ${displayName(client)}:\n\n` +
    `  ${renderShellCommand(installer)}\n\n` +
    `After adding it:\n` +
    joinLines(nextStepLines(client, false))
  );
}

export function autoSetupFailureBlock(
  client: KnownClient,
  reason: string,
  installer: McpConfigCommand,
): string {
  return (
    `Could not add Driggsby to ${displayName(client)}: ${reason}\n\n` +
    manualCommandBlock(client, installer)
  );
}

export function otherClientInstructionsBlock(): string {
  return (
    `Driggsby currently supports OAuth-based remote MCP only.\n\n` +
    `Driggsby OAuth MCP URL:\n  ${DRIGGSBY_MCP_URL}\n\n` +
    `For another MCP client or agent:\n` +
    joinLines(otherClientInstructionLines())
  );
}

function joinLines(lines: string[]): string {
  return lines.map((line) => `${line}\n`).join("");
}
