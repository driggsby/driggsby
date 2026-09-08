// Argv parsing for `driggsby query <TOOL> [--sql <SQL>] [--params <JSON>]`.
// Same behavior contract as the rest of the tree: help on -h/--help, usage
// errors exit 2, echoed argv is sanitized. The tool is checked against the
// allowlist here so a typo is a usage error naming the twelve, not a
// server round trip.
import { helpCommand, type ParsedCommand, unexpectedArgument } from "./args-shared.ts";
import { CliError } from "./cli-error.ts";
import { APP_TOOL_ALLOWLIST } from "./dev/tool-allowlist.ts";
import { QUERY_HELP } from "./help.ts";
import { sanitizeForTerminal } from "./terminal-text.ts";

export const QUERY_USAGE = "Usage: npx driggsby@latest query <TOOL> [--sql <SQL>] [--params <JSON>]";

export function parseQuery(argv: string[]): ParsedCommand {
  let tool: string | null = null;
  let sql: string | null = null;
  let params: Record<string, unknown> | null = null;
  let optionsEnded = false;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] ?? "";
    if (!optionsEnded && token === "--") {
      optionsEnded = true;
      continue;
    }
    if (!optionsEnded && (token === "-h" || token === "--help")) {
      return helpCommand(QUERY_HELP);
    }
    if (!optionsEnded && token === "--sql") {
      sql = requireFlagValue(argv, index, "--sql");
      index += 1;
      continue;
    }
    if (!optionsEnded && token.startsWith("--sql=")) {
      sql = token.slice("--sql=".length);
      continue;
    }
    if (!optionsEnded && token === "--params") {
      params = parseParams(requireFlagValue(argv, index, "--params"));
      index += 1;
      continue;
    }
    if (!optionsEnded && token.startsWith("--params=")) {
      params = parseParams(token.slice("--params=".length));
      continue;
    }
    if (tool === null && (optionsEnded || !token.startsWith("-"))) {
      tool = token;
      continue;
    }
    throw unexpectedArgument(token, QUERY_USAGE);
  }
  if (tool === null) {
    throw missingTool();
  }
  if (!APP_TOOL_ALLOWLIST.has(tool)) {
    throw unknownTool(tool);
  }
  const merged: Record<string, unknown> = { ...(params ?? {}) };
  if (sql !== null) {
    merged.sql = sql;
  }
  return { kind: "query", tool, params: merged };
}

function requireFlagValue(argv: string[], index: number, flag: string): string {
  const value = argv[index + 1];
  if (value === undefined) {
    throw new CliError(
      `error: a value is required for '${flag}' but none was supplied\n\n${QUERY_USAGE}\n\nFor more information, try '--help'.`,
      2,
    );
  }
  return value;
}

// --params is the tool's params object, verbatim; anything that is not a
// JSON object (an array, a string, unparseable text) is a usage mistake.
function parseParams(rawValue: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawValue);
  } catch {
    throw invalidParams();
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw invalidParams();
  }
  return parsed as Record<string, unknown>;
}

function invalidParams(): CliError {
  return new CliError(
    `error: invalid value for '--params': '--params' must be a JSON object, like '{"history_type":"liabilities"}'\n\n` +
      `${QUERY_USAGE}\n\nFor more information, try '--help'.`,
    2,
  );
}

function missingTool(): CliError {
  return new CliError(
    `error: the following required arguments were not provided:\n  <TOOL>\n\n${QUERY_USAGE}\n\nFor more information, try '--help'.`,
    2,
  );
}

function unknownTool(tool: string): CliError {
  return new CliError(
    `error: '${sanitizeForTerminal(tool)}' isn't a tool a Driggsby app can call. Apps can watch these read-only tools:\n` +
      `  ${[...APP_TOOL_ALLOWLIST].join(", ")}\n\n${QUERY_USAGE}\n\nFor more information, try '--help'.`,
    2,
  );
}
