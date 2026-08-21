// Hand-rolled argv parsing for the small fixed command tree. The root and mcp
// levels (and the whole mcp setup surface, in args-mcp-setup.ts) byte-match
// the original clap 4.6 behavior: help routing, exit codes, error text, "did
// you mean" tips (via the ported Jaro similarity in clap-suggestions.ts),
// "--" end-of-options, and short-flag cluster dispatch. Newer commands
// (login, logout) keep the same behavior and exit codes without chasing
// clap's byte-level quirks.
import { parseMcpSetup } from "./args-mcp-setup.ts";
import {
  type ParsedCommand,
  removeDashesTip,
  similarArgumentTip,
  unexpectedArgument,
  unexpectedFlagValue,
} from "./args-shared.ts";
import { didYouMean } from "./clap-suggestions.ts";
import { CliError } from "./cli-error.ts";
import { LOGIN_HELP, LOGOUT_HELP, MCP_HELP, ROOT_HELP } from "./help.ts";
import { sanitizeForTerminal } from "./terminal-text.ts";

export { type ParsedCommand } from "./args-shared.ts";

const ROOT_USAGE = "Usage: npx driggsby@latest <COMMAND>";
const MCP_USAGE = "Usage: npx driggsby@latest mcp <COMMAND>";

// Everything level-specific about the root and mcp command levels, which
// share one dispatch shape.
interface CommandLevel {
  helpText: string;
  usage: string;
  subcommands: readonly string[];
  // Long flags without their leading dashes, in clap's iteration order.
  longFlags: readonly string[];
  // Each direct subcommand's own long flags, for clap's cross-level
  // "tip: 'setup --print' exists" fallback.
  subcommandFlags: readonly { name: string; longFlags: readonly string[] }[];
  // Rendered as: Usage: <prefix> --<flag> <COMMAND>
  usagePrefix: string;
  hasVersion: boolean;
}

const ROOT_LEVEL: CommandLevel = {
  helpText: ROOT_HELP,
  usage: ROOT_USAGE,
  subcommands: ["mcp", "login", "logout"],
  longFlags: ["help", "version"],
  subcommandFlags: [
    { name: "mcp", longFlags: ["help"] },
    { name: "login", longFlags: ["help"] },
    { name: "logout", longFlags: ["help"] },
  ],
  usagePrefix: "npx driggsby@latest",
  hasVersion: true,
};

const MCP_LEVEL: CommandLevel = {
  helpText: MCP_HELP,
  usage: MCP_USAGE,
  subcommands: ["setup"],
  longFlags: ["help"],
  subcommandFlags: [{ name: "setup", longFlags: ["print", "help"] }],
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
    return dispatchSubcommand(first, argv.slice(1));
  }
  if (first === "--") {
    return parseLevelAfterEndOfOptions(level, argv[1]);
  }
  if (first.startsWith("--help=")) {
    throw unexpectedFlagValue("--help", first.slice("--help=".length), levelFlagUsage(level, "help"));
  }
  if (level.hasVersion && first.startsWith("--version=")) {
    throw unexpectedFlagValue(
      "--version",
      first.slice("--version=".length),
      levelFlagUsage(level, "version"),
    );
  }
  if (first.startsWith("--")) {
    throw unknownLongFlagAtLevel(level, first, argv.slice(1));
  }
  if (first.startsWith("-") && first.length > 1) {
    return dispatchShortCluster(level, first);
  }
  throw unrecognizedSubcommand(level, first);
}

function dispatchSubcommand(name: string, rest: string[]): ParsedCommand {
  switch (name) {
    case "mcp":
      return parseLevel(MCP_LEVEL, rest);
    case "login":
      return parseBareCommand({ kind: "login" }, LOGIN_HELP, "Usage: npx driggsby@latest login", rest);
    case "logout":
      return parseBareCommand({ kind: "logout" }, LOGOUT_HELP, "Usage: npx driggsby@latest logout", rest);
    case "setup":
      return parseMcpSetup(rest);
    default:
      // Every name in a CommandLevel's subcommands list must have a case
      // above; reaching here is a wiring bug, not a user error.
      throw new Error(`unhandled subcommand dispatch: ${name}`);
  }
}

// Parsing for commands that take no arguments beyond help: login and logout.
// Same exit codes and error shape as the rest of the tree, no clap quirks.
function parseBareCommand(
  command: ParsedCommand,
  helpText: string,
  usage: string,
  argv: string[],
): ParsedCommand {
  let optionsEnded = false;
  for (const token of argv) {
    if (!optionsEnded && token === "--") {
      optionsEnded = true;
      continue;
    }
    if (!optionsEnded && (token === "-h" || token === "--help")) {
      return { kind: "print-help", text: helpText, stream: "stdout", exitCode: 0 };
    }
    throw unexpectedArgument(token, usage);
  }
  return command;
}

function levelFlagUsage(level: CommandLevel, flagName: string): string {
  return `Usage: ${level.usagePrefix} --${flagName} <COMMAND>`;
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
// first short (-xy → '-x'). "Character" means one code point, like Rust's
// char — never half of a surrogate pair.
function dispatchShortCluster(level: CommandLevel, token: string): ParsedCommand {
  const firstShort = Array.from(token.slice(1))[0] ?? "";
  if (firstShort === "h") {
    return { kind: "print-help", text: level.helpText, stream: "stdout", exitCode: 0 };
  }
  if (level.hasVersion && firstShort === "V") {
    return { kind: "print-version" };
  }
  throw unexpectedArgument(`-${firstShort}`, level.usage);
}

function unknownLongFlagAtLevel(
  level: CommandLevel,
  token: string,
  remainingArgs: readonly string[],
): CliError {
  const flagName = token.slice(2).split("=", 1)[0] ?? "";
  const shown = `--${flagName}`;
  const similar = didYouMean(flagName, level.longFlags);
  if (similar !== undefined) {
    const usage = `Usage: ${level.usagePrefix} --${similar} <COMMAND>`;
    return unexpectedArgument(shown, usage, similarArgumentTip(similar));
  }
  // clap's cross-level fallback: when a LATER argv token names one of this
  // level's subcommands and that subcommand has a similar flag, point the
  // user at the flag's real home ("tip: 'setup --print' exists").
  for (const subcommand of level.subcommandFlags) {
    if (!remainingArgs.includes(subcommand.name)) {
      continue;
    }
    const subcommandSimilar = didYouMean(flagName, subcommand.longFlags);
    if (subcommandSimilar !== undefined) {
      return unexpectedArgument(
        shown,
        level.usage,
        `  tip: '${subcommand.name} --${subcommandSimilar}' exists`,
      );
    }
  }
  return unexpectedArgument(shown, level.usage);
}

function unrecognizedSubcommand(level: CommandLevel, subcommand: string): CliError {
  const similar = didYouMean(subcommand, level.subcommands);
  const tip = similar === undefined ? "" : `  tip: a similar subcommand exists: '${similar}'\n\n`;
  return new CliError(
    `error: unrecognized subcommand '${sanitizeForTerminal(subcommand)}'\n\n${tip}${level.usage}\n\nFor more information, try '--help'.`,
    2,
  );
}
