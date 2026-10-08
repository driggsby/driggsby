// Argv parsing for `driggsby query <TOOL> [--sql <SQL>] [--params <JSON>]`.
// Same behavior contract as the rest of the tree: help on -h/--help, usage
// errors exit 2, echoed argv is sanitized. The tool is checked against the
// allowlist here so a typo is a usage error naming the thirteen, not a
// server round trip.
import { helpCommand, type ParsedCommand, unexpectedArgument } from "./args-shared.ts";
import { didYouMean } from "./clap-suggestions.ts";
import { CliError } from "./cli-error.ts";
import { APP_TOOL_ALLOWLIST } from "./dev/tool-allowlist.ts";
import { QUERY_HELP } from "./help.ts";
import { ITEM_ACTION_TOOLS } from "./items/item-actions.ts";
import { RULE_ACTION_TOOLS } from "./rules/rule-actions.ts";
import { quotedForTerminal, wrapNames } from "./terminal-text.ts";

// The tools that take SQL: --sql applies only to these, and a retry
// line names --sql only for them.
export const SQL_TOOLS: ReadonlySet<string> = new Set(["query_cash_sql", "query_investment_sql", "query_item_sql"]);

const QUERY_USAGE = "Usage: npx driggsby@latest query <TOOL> [--sql <SQL>] [--params <JSON>]";

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
      if (sql.trim() === "") {
        throw missingFlagValue("--sql");
      }
      continue;
    }
    if (!optionsEnded && token === "--params") {
      params = parseParams(requireFlagValue(argv, index, "--params", { allowBlank: true }));
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
  if (sql !== null && !SQL_TOOLS.has(tool)) {
    throw sqlForNonSqlTool(tool);
  }
  const merged: Record<string, unknown> = { ...(params ?? {}) };
  if (sql !== null) {
    merged.sql = sql;
  }
  return { kind: "query", tool, params: merged };
}

// A following flag is never a value: `--sql --params '{}'` is a missing SQL,
// not SQL that reads "--params" (SQL that must start with "-" can use the
// --sql= spelling).
function requireFlagValue(
  argv: string[],
  index: number,
  flag: string,
  options: { allowBlank?: boolean } = {},
): string {
  const value = argv[index + 1];
  const looksLikeFlag = value !== undefined && value.length > 1 && value.startsWith("-");
  const blank = value === undefined || looksLikeFlag || (value.trim() === "" && options.allowBlank !== true);
  if (blank) {
    throw missingFlagValue(flag);
  }
  return value;
}

function missingFlagValue(flag: string): CliError {
  return new CliError(
    `error: a value is required for '${flag}' but none was supplied\n\n${QUERY_USAGE}\n\nFor more information, try '--help'.`,
    2,
  );
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
    `error: invalid value for '--params':\n'--params' must be a JSON object, like '{"history_type":"liabilities"}'\n\n` +
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

// A tool with a command of its own (the items and rules actions): its
// refusal names that command rather than a read tool that looks alike.
function commandFor(tool: string): string | undefined {
  const commands: [string, Record<string, string>][] = [["items", ITEM_ACTION_TOOLS], ["rules", RULE_ACTION_TOOLS]];
  for (const [command, tools] of commands) {
    const action = Object.keys(tools).find((name) => tools[name] === tool);
    if (action !== undefined) return `npx driggsby@latest ${command} ${action}`;
  }
  return undefined;
}

function unknownTool(tool: string): CliError {
  const command = commandFor(tool);
  const similar = command === undefined ? didYouMean(tool, [...APP_TOOL_ALLOWLIST]) : undefined;
  const tip =
    command !== undefined
      ? `  tip: run ${tool} with its own command:\n    ${command}\n\n`
      : similar === undefined
        ? ""
        : `  tip: a similar tool exists: '${similar}'\n\n`;
  return new CliError(
    `error: ${quotedForTerminal(tool, 60)} isn't a tool a Driggsby app can call.\n` +
      `Apps can watch these read-only tools:\n` +
      `${wrapNames([...APP_TOOL_ALLOWLIST], "  ")}\n\n${tip}${QUERY_USAGE}\n\nFor more information, try '--help'.`,
    2,
  );
}

function sqlForNonSqlTool(tool: string): CliError {
  return new CliError(
    `error: '--sql' only applies to query_cash_sql, query_investment_sql, or query_item_sql;\n` +
      `'${tool}' takes no SQL.\n\n` +
      `${QUERY_USAGE}\n\nFor more information, try '--help'.`,
    2,
  );
}
