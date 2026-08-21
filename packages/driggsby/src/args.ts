// Hand-rolled argv parsing for the small fixed command tree, byte-matching
// the original clap 4.6 behavior: help routing, exit codes, error text, "did
// you mean" tips (via the ported Jaro similarity in clap-suggestions.ts),
// "--" end-of-options, and short-flag cluster dispatch.
import { didYouMean } from "./clap-suggestions.ts";
import { CliError } from "./cli-error.ts";
import { MCP_HELP, MCP_SETUP_HELP_LONG, MCP_SETUP_HELP_SHORT, ROOT_HELP } from "./help.ts";
import { type McpScope } from "./mcp-setup/known-client.ts";
import { sanitizeForTerminal } from "./terminal-text.ts";

const ROOT_USAGE = "Usage: npx driggsby@latest <COMMAND>";
const MCP_USAGE = "Usage: npx driggsby@latest mcp <COMMAND>";
const SETUP_USAGE = "Usage: npx driggsby@latest mcp setup [OPTIONS] [CLIENT]";

export type ParsedCommand =
  | { kind: "print-help"; text: string; stream: "stdout" | "stderr"; exitCode: 0 | 2 }
  | { kind: "print-version" }
  | { kind: "mcp-setup"; client: string | undefined; print: boolean; scope: McpScope | undefined };

// Everything level-specific about the root and mcp command levels, which
// share one dispatch shape.
interface CommandLevel {
  helpText: string;
  usage: string;
  subcommands: readonly string[];
  // Long flags without their leading dashes, in clap's iteration order.
  longFlags: readonly string[];
  // Rendered as: Usage: <prefix> --<flag> <COMMAND>
  usagePrefix: string;
  hasVersion: boolean;
}

const ROOT_LEVEL: CommandLevel = {
  helpText: ROOT_HELP,
  usage: ROOT_USAGE,
  subcommands: ["mcp"],
  longFlags: ["help", "version"],
  usagePrefix: "npx driggsby@latest",
  hasVersion: true,
};

const MCP_LEVEL: CommandLevel = {
  helpText: MCP_HELP,
  usage: MCP_USAGE,
  subcommands: ["setup"],
  longFlags: ["help"],
  usagePrefix: "npx driggsby@latest mcp",
  hasVersion: false,
};

export function parseArgv(argv: string[]): ParsedCommand {
  return parseLevel(ROOT_LEVEL, argv);
}

function parseLevel(level: CommandLevel, argv: string[]): ParsedCommand {
  const first = argv[0];
  if (first === undefined) {
    return { kind: "print-help", text: level.helpText, stream: "stderr", exitCode: 2 };
  }
  if (first === "-h" || first === "--help") {
    return { kind: "print-help", text: level.helpText, stream: "stdout", exitCode: 0 };
  }
  if (level.hasVersion && (first === "-V" || first === "--version")) {
    return { kind: "print-version" };
  }
  if (level.subcommands.includes(first)) {
    const rest = argv.slice(1);
    return first === "mcp" ? parseLevel(MCP_LEVEL, rest) : parseMcpSetup(rest);
  }
  if (first === "--") {
    return parseLevelAfterEndOfOptions(level, argv[1]);
  }
  if (first.startsWith("--")) {
    throw unknownLongFlagAtLevel(level, first);
  }
  if (first.startsWith("-") && first.length > 1) {
    return dispatchShortCluster(level, first);
  }
  throw unrecognizedSubcommand(level, first);
}

// After "--", everything is positional — and these levels take no
// positionals, so clap reports the token as unexpected (with a targeted tip
// when it names a real subcommand of this level).
function parseLevelAfterEndOfOptions(level: CommandLevel, next: string | undefined): ParsedCommand {
  if (next === undefined) {
    return { kind: "print-help", text: level.helpText, stream: "stderr", exitCode: 2 };
  }
  if (level.subcommands.includes(next)) {
    throw unexpectedArgument(next, level.usage, removeDashesTip(next));
  }
  throw unrecognizedSubcommand(level, next);
}

// clap dispatches a short-flag cluster on its first character: -hx prints
// help, -Vx prints the version, and anything else errors naming just the
// first short (-xy → '-x').
function dispatchShortCluster(level: CommandLevel, token: string): ParsedCommand {
  const firstShort = token.slice(1, 2);
  if (firstShort === "h") {
    return { kind: "print-help", text: level.helpText, stream: "stdout", exitCode: 0 };
  }
  if (level.hasVersion && firstShort === "V") {
    return { kind: "print-version" };
  }
  throw unexpectedArgument(`-${firstShort}`, level.usage);
}

function unknownLongFlagAtLevel(level: CommandLevel, token: string): CliError {
  const flagName = token.slice(2).split("=", 1)[0] ?? "";
  const shown = sanitizeForTerminal(`--${flagName}`);
  const similar = didYouMean(flagName, level.longFlags);
  if (similar !== undefined) {
    const usage = `Usage: ${level.usagePrefix} --${similar} <COMMAND>`;
    return unexpectedArgument(shown, usage, similarArgumentTip(similar));
  }
  return unexpectedArgument(shown, level.usage);
}

const SETUP_LONG_FLAGS = ["print", "help"] as const;

function parseMcpSetup(argv: string[]): ParsedCommand {
  let client: string | undefined;
  let print = false;
  let scope: McpScope | undefined;
  let optionsEnded = false;

  const acceptPositional = (token: string): void => {
    if (client !== undefined) {
      throw unexpectedArgument(token, SETUP_USAGE);
    }
    client = token;
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === undefined) {
      break;
    }
    if (optionsEnded) {
      acceptPositional(token);
      continue;
    }
    if (token === "--") {
      optionsEnded = true;
      continue;
    }
    if (token === "--help") {
      return { kind: "print-help", text: MCP_SETUP_HELP_LONG, stream: "stdout", exitCode: 0 };
    }
    if (token === "--print") {
      if (print) {
        throw usedMultipleTimes("--print");
      }
      print = true;
      continue;
    }
    if (token.startsWith("--help=") || token.startsWith("--print=")) {
      throw unexpectedFlagValue(token);
    }
    if (token.startsWith("-s")) {
      // clap's error precedence, byte-verified against the Rust binary: a
      // MISSING value (nothing next, or a dash-leading token other than bare
      // "-") reports "a value is required" even when -s was already used; a
      // SUPPLIED value (attached, or a real next token, even "") reports
      // duplication first, then emptiness, then validity.
      let value: string;
      if (token === "-s") {
        const next = argv[index + 1];
        if (next === undefined || (next !== "-" && next.startsWith("-"))) {
          throw scopeValueRequired();
        }
        value = next;
        index += 1;
      } else {
        value = token.startsWith("-s=") ? token.slice(3) : token.slice(2);
      }
      if (scope !== undefined) {
        throw usedMultipleTimes("-s <MCP_SCOPE>");
      }
      if (value === "") {
        throw scopeValueRequired();
      }
      scope = parseScopeValue(value);
      continue;
    }
    if (token.startsWith("--")) {
      throw unknownSetupLongFlag(token);
    }
    if (token.startsWith("-") && token.length > 1) {
      // Short cluster: -h... prints the short help; anything else errors
      // naming the first short with the pass-as-value tip (-py → '-p').
      const firstShort = token.slice(1, 2);
      if (firstShort === "h") {
        return { kind: "print-help", text: MCP_SETUP_HELP_SHORT, stream: "stdout", exitCode: 0 };
      }
      throw unexpectedArgument(`-${firstShort}`, SETUP_USAGE, passAsValueTip(`-${firstShort}`));
    }
    acceptPositional(token);
  }

  return { kind: "mcp-setup", client, print, scope };
}

function parseScopeValue(value: string): McpScope {
  if (value === "local" || value === "user") {
    return value;
  }
  const shown = sanitizeForTerminal(value);
  const similar = didYouMean(value, ["local", "user"]);
  const tip = similar === undefined ? "" : `\n\n  tip: a similar value exists: '${similar}'`;
  throw new CliError(
    `error: invalid value '${shown}' for '-s <MCP_SCOPE>'\n  [possible values: local, user]${tip}\n\nFor more information, try '--help'.`,
    2,
  );
}

function unknownSetupLongFlag(token: string): CliError {
  const flagName = token.slice(2).split("=", 1)[0] ?? "";
  const shown = sanitizeForTerminal(`--${flagName}`);
  const similar = didYouMean(flagName, SETUP_LONG_FLAGS);
  if (similar !== undefined) {
    const usage = `Usage: npx driggsby@latest mcp setup --${similar} [CLIENT]`;
    return unexpectedArgument(shown, usage, similarArgumentTip(similar));
  }
  return unexpectedArgument(shown, SETUP_USAGE, passAsValueTip(shown));
}

// "--print=true" / "--help=x": these flags take no value.
function unexpectedFlagValue(token: string): CliError {
  const equalsAt = token.indexOf("=");
  const flag = token.slice(0, equalsAt);
  const value = sanitizeForTerminal(token.slice(equalsAt + 1));
  const usage = `Usage: npx driggsby@latest mcp setup ${flag} [CLIENT]`;
  return new CliError(
    `error: unexpected value '${value}' for '${flag}' found; no more were expected\n\n${usage}\n\nFor more information, try '--help'.`,
    2,
  );
}

function usedMultipleTimes(argumentName: string): CliError {
  return new CliError(
    `error: the argument '${argumentName}' cannot be used multiple times\n\n${SETUP_USAGE}\n\nFor more information, try '--help'.`,
    2,
  );
}

function scopeValueRequired(): CliError {
  return new CliError(
    `error: a value is required for '-s <MCP_SCOPE>' but none was supplied\n  [possible values: local, user]\n\nFor more information, try '--help'.`,
    2,
  );
}

function similarArgumentTip(flagName: string): string {
  return `  tip: a similar argument exists: '--${flagName}'`;
}

function passAsValueTip(shownArgument: string): string {
  return `  tip: to pass '${shownArgument}' as a value, use '-- ${shownArgument}'`;
}

function removeDashesTip(subcommand: string): string {
  return `  tip: subcommand '${subcommand}' exists; to use it, remove the '--' before it`;
}

function unexpectedArgument(argument: string, usage: string, tipLine?: string): CliError {
  const shown = sanitizeForTerminal(argument);
  const tip = tipLine === undefined ? "" : `${tipLine}\n\n`;
  return new CliError(
    `error: unexpected argument '${shown}' found\n\n${tip}${usage}\n\nFor more information, try '--help'.`,
    2,
  );
}

function unrecognizedSubcommand(level: CommandLevel, subcommand: string): CliError {
  const similar = didYouMean(subcommand, level.subcommands);
  const tip = similar === undefined ? "" : `  tip: a similar subcommand exists: '${similar}'\n\n`;
  return new CliError(
    `error: unrecognized subcommand '${sanitizeForTerminal(subcommand)}'\n\n${tip}${level.usage}\n\nFor more information, try '--help'.`,
    2,
  );
}
