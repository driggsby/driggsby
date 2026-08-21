import { CliError } from "../cli-error.ts";
import { sanitizeForTerminal } from "../terminal-text.ts";

export type KnownClient = "claude-code" | "codex" | "other";

// The subset of clients whose own CLI can install the MCP config for us.
export type CliMcpClient = "claude-code" | "codex";

export type McpScope = "local" | "user";

const SUPPORTED_CLIENTS_NOTE = "Supported clients:\n  claude-code\n  codex\n  other";

export function displayName(client: KnownClient): string {
  switch (client) {
    case "claude-code":
      return "Claude Code";
    case "codex":
      return "Codex";
    case "other":
      return "Other MCP client";
  }
}

// ASCII-only lowercasing, matching the Rust CLI's to_ascii_lowercase: a
// non-ASCII uppercase letter stays as-is and fails the lookup below.
export function canonicalizeClientId(input: string): string {
  return input.trim().replace(/[A-Z]/g, (letter) => letter.toLowerCase());
}

export function parseClient(value: string): KnownClient {
  const canonical = canonicalizeClientId(value);
  if (canonical === "") {
    throw new CliError(`Client is required.\n\n${SUPPORTED_CLIENTS_NOTE}`, 1);
  }
  if (canonical === "claude-code" || canonical === "codex" || canonical === "other") {
    return canonical;
  }
  throw new CliError(
    `Unsupported client: ${sanitizeForTerminal(canonical)}\n\n${SUPPORTED_CLIENTS_NOTE}`,
    1,
  );
}

export function validateMcpScope(client: KnownClient, scope: McpScope | undefined): void {
  if (scope === undefined || client === "claude-code") {
    return;
  }
  throw new CliError("-s is supported only for Claude Code.", 1);
}

export function cliMcpClient(client: KnownClient): CliMcpClient | null {
  return client === "other" ? null : client;
}
