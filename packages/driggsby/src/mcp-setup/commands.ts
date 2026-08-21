import { type CliMcpClient, type McpScope } from "./known-client.ts";

export const DRIGGSBY_MCP_URL = "https://app.driggsby.com/mcp";

export interface McpConfigCommand {
  program: string;
  args: string[];
}

export function buildInstallerCommand(
  client: CliMcpClient,
  scope: McpScope | undefined,
): McpConfigCommand {
  switch (client) {
    case "claude-code":
      return {
        program: "claude",
        args: [
          "mcp",
          "add",
          "--transport",
          "http",
          "-s",
          scope ?? "user",
          "driggsby",
          DRIGGSBY_MCP_URL,
        ],
      };
    case "codex":
      return {
        program: "codex",
        args: ["mcp", "add", "driggsby", "--url", DRIGGSBY_MCP_URL],
      };
  }
}

export function buildInspectorCommand(client: CliMcpClient): McpConfigCommand {
  switch (client) {
    case "claude-code":
      return { program: "claude", args: ["mcp", "get", "driggsby"] };
    case "codex":
      return { program: "codex", args: ["mcp", "get", "driggsby", "--json"] };
  }
}

export function buildScopedRemoverCommand(
  client: CliMcpClient,
  scope: McpScope | undefined,
): McpConfigCommand {
  switch (client) {
    case "claude-code":
      return {
        program: "claude",
        args: ["mcp", "remove", "driggsby", "-s", scope ?? "user"],
      };
    case "codex":
      return { program: "codex", args: ["mcp", "remove", "driggsby"] };
  }
}

export function renderShellCommand(command: McpConfigCommand): string {
  return [command.program, ...command.args].map(shellQuote).join(" ");
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9\-_./=]*$/.test(value)) {
    return value;
  }
  return `'${value.replaceAll("'", "'\\''")}'`;
}
