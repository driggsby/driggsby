import { DRIGGSBY_MCP_URL } from "./commands.ts";
import { type CliMcpClient, type McpScope } from "./known-client.ts";

export interface ClientCommandOutput {
  succeeded: boolean;
  stdout: string;
  stderr: string;
}

export type ExistingMcpConfig = "missing" | "matches" | "differs" | "unknown";

// Classifies what `claude mcp get driggsby` / `codex mcp get driggsby --json`
// reported so setup can be idempotent: an entry that already matches is left
// alone, a different entry gets remove+add remediation, and anything
// unreadable is treated as unknown so setup just proceeds.
export function classifyExistingMcpConfig(
  client: CliMcpClient,
  scope: McpScope | undefined,
  output: ClientCommandOutput,
): ExistingMcpConfig {
  const text = `${output.stdout}\n${output.stderr}`;
  if (!output.succeeded) {
    return reportsMissingConfig(text) ? "missing" : "unknown";
  }
  return matchesExpectedConfig(client, scope, text) ? "matches" : "differs";
}

function reportsMissingConfig(text: string): boolean {
  return (
    text.includes("No MCP server found") ||
    text.includes("No MCP server named 'driggsby' found") ||
    text.includes("No MCP server found with name")
  );
}

function matchesExpectedConfig(
  client: CliMcpClient,
  scope: McpScope | undefined,
  text: string,
): boolean {
  switch (client) {
    case "claude-code":
      return (
        hasLine(text, "Type: http") &&
        hasLine(text, `URL: ${DRIGGSBY_MCP_URL}`) &&
        hasClaudeScope(text, scope ?? "user")
      );
    case "codex":
      return (
        text.includes('"enabled": true') &&
        text.includes('"type": "streamable_http"') &&
        text.includes(`"url": "${DRIGGSBY_MCP_URL}"`)
      );
  }
}

function hasClaudeScope(text: string, scope: McpScope): boolean {
  const expected = scope === "local" ? "Scope: Local config" : "Scope: User config";
  return text.split("\n").some((line) => line.trim().startsWith(expected));
}

function hasLine(text: string, expected: string): boolean {
  return text.split("\n").some((line) => line.trim() === expected);
}
