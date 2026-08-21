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
  subcommands: ["mcp"],
  longFlags: ["help", "version"],
  subcommandFlags: [{ name: "mcp", longFlags: ["help"] }],
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
    const rest = argv.slice(1);
    return first === "mcp" ? parseLevel(MCP_LEVEL, rest) : parseMcpSetup(rest);
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
  const shown = sanitizeForTerminal(`--${flagName}`);
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

const SETUP_LONG_FLAGS = ["print", "help"] as const;

// clap holds the most recent slot-form "-s <value>" or positional as a single
// PENDING argument; it enters the matcher (and gets validated) only when the
// next token starts a new argument parse, or when argv ends.
type PendingArg =
  | { kind: "client" }
  | { kind: "scope"; value: string; isDuplicate: boolean };

function parseMcpSetup(argv: string[]): ParsedCommand {
  let client: string | undefined;
  let print = false;
  let scope: McpScope | undefined;
  let optionsEnded = false;
  // The matcher state clap re-renders error usage lines from: flags that have
  // RESOLVED into the matcher, in argv order. Unknown-long-flag errors render
  // these (plus <CLIENT> once the positional resolved); "--print=x"/"--help=x"
  // render the derive group form once anything resolved. Shorts, positionals,
  // and duplicate errors keep the static usage. A second slot-form -s removes
  // the earlier "-s <MCP_SCOPE>" entry while its own value is still pending
  // (clap's Set action self-override), and a duplicate never re-adds it.
  const seenFlags: string[] = [];
  let committedArgs = 0;
  let clientInMatcher = false;
  let pending: PendingArg | null = null;

  // Resolution, byte-verified against the Rust binary: recognized argument
  // starts (--print, -s, --help/-h, an accepted positional, end of argv)
  // PROPAGATE the pending arg's errors — duplication first, then emptiness,
  // then value validity — while error paths (unknown long flag) resolve in
  // DISCARD mode: the token's own error wins, but a non-duplicate entry still
  // lands in the matcher and shows up in the rebuilt usage line.
  const resolvePending = (propagateErrors: boolean): void => {
    if (pending === null) {
      return;
    }
    const resolved = pending;
    pending = null;
    if (resolved.kind === "client") {
      clientInMatcher = true;
      committedArgs += 1;
      return;
    }
    if (resolved.isDuplicate) {
      if (propagateErrors) {
        throw usedMultipleTimes("-s <MCP_SCOPE>");
      }
      return;
    }
    seenFlags.push("-s <MCP_SCOPE>");
    committedArgs += 1;
    if (resolved.value === "") {
      if (propagateErrors) {
        throw scopeValueRequired();
      }
      return;
    }
    if (resolved.value !== "local" && resolved.value !== "user") {
      if (propagateErrors) {
        throw invalidScopeValue(resolved.value);
      }
      return;
    }
    scope = resolved.value;
  };

  const acceptPositional = (token: string): void => {
    // clap flags the extra positional eagerly, before resolving the pending
    // arg (codex -s bogus -- y reports 'y', not the invalid scope).
    if (client !== undefined) {
      throw unexpectedArgument(token, SETUP_USAGE);
    }
    resolvePending(true);
    client = token;
    pending = { kind: "client" };
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
      resolvePending(true);
      return { kind: "print-help", text: MCP_SETUP_HELP_LONG, stream: "stdout", exitCode: 0 };
    }
    if (token === "--print") {
      resolvePending(true);
      if (print) {
        throw usedMultipleTimes("--print");
      }
      print = true;
      seenFlags.push("--print");
      committedArgs += 1;
      continue;
    }
    if (token.startsWith("--help=") || token.startsWith("--print=")) {
      // clap computes this error's usage BEFORE resolving the pending arg,
      // so a pending -s or positional never influences the group form.
      const equalsAt = token.indexOf("=");
      const flag = token.slice(0, equalsAt);
      throw unexpectedFlagValue(flag, token.slice(equalsAt + 1), setupEqualsErrorUsage(flag, committedArgs > 0));
    }
    if (token.startsWith("-s")) {
      resolvePending(true);
      if (token === "-s") {
        // A MISSING value (nothing next, or a RECOGNIZED flag token next —
        // "--", exact --help/--print, or a short cluster starting with 'h' or
        // 's') reports "a value is required"; an UNRECOGNIZED dash-leading
        // token abandons this -s and is reported through its own error path.
        const next = argv[index + 1];
        if (next === undefined) {
          throw scopeValueRequired();
        }
        if (next !== "-" && next.startsWith("-")) {
          if (isRecognizedSetupFlagToken(next)) {
            throw scopeValueRequired();
          }
          continue;
        }
        // Slot-form value (bare "-" included): validation is DEFERRED to
        // resolution. A repeat occurrence also evicts the earlier matcher
        // entry now, while its own value is still pending.
        if (scope !== undefined) {
          const at = seenFlags.indexOf("-s <MCP_SCOPE>");
          if (at !== -1) {
            seenFlags.splice(at, 1);
          }
        }
        pending = { kind: "scope", value: next, isDuplicate: scope !== undefined };
        index += 1;
        continue;
      }
      // Attached form (-s=x / -sx): duplication, emptiness, and validity all
      // report eagerly, in that order.
      const value = token.startsWith("-s=") ? token.slice(3) : token.slice(2);
      if (scope !== undefined) {
        throw usedMultipleTimes("-s <MCP_SCOPE>");
      }
      if (value === "") {
        throw scopeValueRequired();
      }
      if (value !== "local" && value !== "user") {
        throw invalidScopeValue(value);
      }
      scope = value;
      seenFlags.push("-s <MCP_SCOPE>");
      committedArgs += 1;
      continue;
    }
    if (token.startsWith("--")) {
      resolvePending(false);
      throw unknownSetupLongFlag(token, seenFlags, clientInMatcher);
    }
    if (token.startsWith("-") && token.length > 1) {
      // Short cluster: -h... prints the short help (after resolving the
      // pending arg, so -s bogus -h reports the invalid scope); anything else
      // errors naming the first short (one code point, like Rust's char) with
      // the pass-as-value tip (-py → '-p'), discarding any pending error.
      const firstShort = Array.from(token.slice(1))[0] ?? "";
      if (firstShort === "h") {
        resolvePending(true);
        return { kind: "print-help", text: MCP_SETUP_HELP_SHORT, stream: "stdout", exitCode: 0 };
      }
      throw unexpectedArgument(`-${firstShort}`, SETUP_USAGE, passAsValueTip(`-${firstShort}`));
    }
    acceptPositional(token);
  }

  resolvePending(true);
  return { kind: "mcp-setup", client, print, scope };
}

function invalidScopeValue(value: string): CliError {
  const shown = sanitizeForTerminal(value);
  const similar = didYouMean(value, ["local", "user"]);
  const tip = similar === undefined ? "" : `\n\n  tip: a similar value exists: '${similar}'`;
  return new CliError(
    `error: invalid value '${shown}' for '-s <MCP_SCOPE>'\n  [possible values: local, user]${tip}\n\nFor more information, try '--help'.`,
    2,
  );
}

// A dash-leading token clap would recognize as one of mcp setup's own flags:
// end-of-options, an exact long flag, or a short cluster led by a known short
// ('h' or 's'). Long forms with an attached =value are NOT recognized here —
// clap reports those through their own unexpected-value error instead.
function isRecognizedSetupFlagToken(token: string): boolean {
  if (token === "--" || token === "--help" || token === "--print") {
    return true;
  }
  if (token.startsWith("--")) {
    return false;
  }
  const firstShort = Array.from(token.slice(1))[0] ?? "";
  return firstShort === "h" || firstShort === "s";
}

function unknownSetupLongFlag(
  token: string,
  seenFlags: readonly string[],
  clientSeen: boolean,
): CliError {
  const flagName = token.slice(2).split("=", 1)[0] ?? "";
  const shown = sanitizeForTerminal(`--${flagName}`);
  const similar = didYouMean(flagName, SETUP_LONG_FLAGS);
  if (similar !== undefined) {
    // clap appends the suggested flag to the seen list unless already there
    // (--print --pront renders "--print [CLIENT]", not "--print --print ...").
    const rendered = seenFlags.includes(`--${similar}`) ? seenFlags : [...seenFlags, `--${similar}`];
    return unexpectedArgument(shown, setupUsageFromSeen(rendered, clientSeen), similarArgumentTip(similar));
  }
  return unexpectedArgument(shown, setupUsageFromSeen(seenFlags, clientSeen), passAsValueTip(shown));
}

// clap re-renders the usage line on unknown-long-flag errors from what it has
// already parsed: the completed flags in argv order, then <CLIENT> once the
// positional was consumed ([CLIENT] otherwise). With nothing consumed and no
// suggestion it falls back to the generic "[OPTIONS] [CLIENT]" form.
function setupUsageFromSeen(flags: readonly string[], clientSeen: boolean): string {
  if (flags.length === 0 && !clientSeen) {
    return SETUP_USAGE;
  }
  const parts = ["Usage: npx driggsby@latest mcp setup", ...flags, clientSeen ? "<CLIENT>" : "[CLIENT]"];
  return parts.join(" ");
}

// The usage clap renders for "--print=x"/"--help=x" at the setup level: with
// nothing committed, the errored flag plus "[CLIENT]"; once any setup arg is
// committed, the derive-generated group "<CLIENT|--print|-s <MCP_SCOPE>>",
// prefixed by "--help" only (--print is a group member and collapses into it).
function setupEqualsErrorUsage(flag: string, anyArgCommitted: boolean): string {
  if (!anyArgCommitted) {
    return `Usage: npx driggsby@latest mcp setup ${flag} [CLIENT]`;
  }
  const group = "<CLIENT|--print|-s <MCP_SCOPE>>";
  const prefix = flag === "--help" ? "--help " : "";
  return `Usage: npx driggsby@latest mcp setup ${prefix}${group}`;
}

// "--print=true" / "--help=x" / "--version=x": these flags take no value.
// The flag and usage are literal-derived today; sanitizing them anyway keeps
// the no-control-bytes guarantee closed for every future caller.
function unexpectedFlagValue(flag: string, rawValue: string, usage: string): CliError {
  const value = sanitizeForTerminal(rawValue);
  return new CliError(
    `error: unexpected value '${value}' for '${sanitizeForTerminal(flag)}' found; no more were expected\n\n${sanitizeForTerminal(usage)}\n\nFor more information, try '--help'.`,
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
  // The tip and usage are sanitized too: some tips embed argv (the
  // pass-as-value tip), usage lines are now computed rather than literal, and
  // sanitizing here closes the class for every current and future caller.
  const tip = tipLine === undefined ? "" : `${sanitizeForTerminal(tipLine)}\n\n`;
  return new CliError(
    `error: unexpected argument '${shown}' found\n\n${tip}${sanitizeForTerminal(usage)}\n\nFor more information, try '--help'.`,
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
