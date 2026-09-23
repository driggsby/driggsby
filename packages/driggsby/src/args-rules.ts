// Argv parsing for `driggsby rules <ACTION> [--params <JSON> | --params-file
// <PATH>] [--yes]`. --params is the rule tool's arguments object, verbatim;
// --params-file reads the same object from a file, for rules too big or
// too quote-heavy for a shell line. Usage errors exit 2; echoed argv is
// sanitized by the shared builders.
import { readFileSync, statSync } from "node:fs";

import { helpCommand, type ParsedCommand, unexpectedArgument, unexpectedFlagValue } from "./args-shared.ts";
import { didYouMean } from "./clap-suggestions.ts";
import { CliError } from "./cli-error.ts";
import { RULES_HELP } from "./help.ts";
import { isRuleAction, RULE_ACTIONS, type RuleAction } from "./rules/rule-actions.ts";
import { quotedForTerminal } from "./terminal-text.ts";

const RULES_USAGE = "Usage: npx driggsby@latest rules <ACTION> [--params <JSON>] [--yes]";
// A saved rule with learned patterns and its answers is a few KB; this
// bounds a mistaken path to something like a log file.
export const MAX_PARAMS_FILE_BYTES = 1_048_576;

export function parseRules(argv: string[]): ParsedCommand {
  let action: RuleAction | null = null;
  let params: Record<string, unknown> | null = null;
  let yes = false;
  let optionsEnded = false;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] ?? "";
    if (!optionsEnded && token === "--") {
      optionsEnded = true;
      continue;
    }
    if (!optionsEnded && (token === "-h" || token === "--help")) {
      return helpCommand(RULES_HELP);
    }
    if (!optionsEnded && token === "--yes") {
      yes = true;
      continue;
    }
    if (!optionsEnded && token.startsWith("--yes=")) {
      throw unexpectedFlagValue("--yes", token.slice("--yes=".length), RULES_USAGE);
    }
    // Params come once, from one source; the check runs before any file is
    // read, so a second source is named as the mistake it is.
    if (!optionsEnded && (token === "--params" || token === "--params-file")) {
      if (params !== null) {
        throw paramsTwice();
      }
      const value = argv[index + 1];
      if (value === undefined || (value.length > 1 && value.startsWith("-"))) {
        throw usageError(`error: a value is required for '${token}' but none was supplied`);
      }
      params = token === "--params" ? parseParamsObject(value, token) : readParamsFile(value);
      index += 1;
      continue;
    }
    if (!optionsEnded && (token.startsWith("--params=") || token.startsWith("--params-file="))) {
      if (params !== null) {
        throw paramsTwice();
      }
      params = token.startsWith("--params=")
        ? parseParamsObject(token.slice("--params=".length), "--params")
        : readParamsFile(token.slice("--params-file=".length));
      continue;
    }
    if (action === null && (optionsEnded || !token.startsWith("-"))) {
      if (!isRuleAction(token)) {
        throw unknownAction(token);
      }
      action = token;
      continue;
    }
    throw unexpectedArgument(token, RULES_USAGE);
  }
  if (action === null) {
    throw usageError("error: the following required arguments were not provided:\n  <ACTION>");
  }
  if (action === "describe" && params !== null) {
    throw usageError("error: rules describe takes no params");
  }
  if (action === "delete" && !yes) {
    throw usageError(
      "error: deleting a rule can't be undone — its categories and tags come off every\n" +
        "transaction it covers. To delete it, run the same command again with --yes.",
    );
  }
  if (action !== "delete" && yes) {
    throw usageError("error: '--yes' only applies to rules delete");
  }
  return { kind: "rules", action, params: params ?? {} };
}

function parseParamsObject(rawValue: string, flag: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawValue);
  } catch {
    parsed = null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw usageError(
      `error: invalid value for '${flag}':\n'${flag}' must be a JSON object, like '{"rule_ref":"rule_..."}'`,
    );
  }
  return parsed as Record<string, unknown>;
}

// The path is the caller's own; its contents are never echoed back.
function readParamsFile(path: string): Record<string, unknown> {
  let raw: string;
  try {
    const stats = statSync(path);
    if (!stats.isFile() || stats.size > MAX_PARAMS_FILE_BYTES) {
      throw new Error("not a readable params file");
    }
    raw = readFileSync(path, "utf8");
  } catch {
    throw usageError(
      `error: couldn't read the --params-file: it must be a JSON file under ${String(MAX_PARAMS_FILE_BYTES / 1_048_576)} MB`,
    );
  }
  return parseParamsObject(raw, "--params-file");
}

function paramsTwice(): CliError {
  return usageError("error: give the params once, with either --params or --params-file");
}

function unknownAction(token: string): CliError {
  const similar = didYouMean(token, RULE_ACTIONS);
  const tip = similar === undefined ? "" : `\n\n  tip: a similar action exists: '${similar}'`;
  return usageError(
    `error: ${quotedForTerminal(token, 60)} isn't a rules action. Actions: ${RULE_ACTIONS.join(", ")}.${tip}`,
  );
}

function usageError(firstLines: string): CliError {
  return new CliError(`${firstLines}\n\n${RULES_USAGE}\n\nFor more information, try '--help'.`, 2);
}
