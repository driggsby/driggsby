// Argv parsing for `driggsby rules <ACTION> [--params <JSON> | --params-file
// <PATH>] [--yes]`. --params is the rule tool's arguments object, verbatim;
// --params-file reads the same object from a file, for rules too big or
// too quote-heavy for a shell line. Usage errors exit 2; echoed argv is
// sanitized by the shared builders. Help, the action, and the flag rules
// are all checked before any params are parsed or any file is read.
import { closeSync, constants, fstatSync, openSync, readSync, statSync } from "node:fs";

import { helpCommand, type ParsedCommand, unexpectedArgument, unexpectedFlagValue } from "./args-shared.ts";
import { didYouMean } from "./clap-suggestions.ts";
import { CliError } from "./cli-error.ts";
import { RULES_HELP } from "./help.ts";
import { isRuleAction, RULE_ACTIONS } from "./rules/rule-actions.ts";
import { quotedForTerminal } from "./terminal-text.ts";

const RULES_USAGE = "Usage: npx driggsby@latest rules <ACTION> [--params <JSON>] [--yes]";
// A saved rule with learned patterns and its answers is a few KB; this
// bounds a mistaken path to something like a log file.
export const MAX_PARAMS_FILE_BYTES = 1_048_576;
const MAX_PARAMS_FILE_MB = String(MAX_PARAMS_FILE_BYTES / 1_048_576);

type ParamsSource = { flag: "--params"; json: string } | { flag: "--params-file"; path: string };

export function parseRules(argv: string[]): ParsedCommand {
  let actionToken: string | null = null;
  let source: ParamsSource | null = null;
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
    const flag = !optionsEnded ? paramsFlag(token) : null;
    if (flag !== null) {
      if (source !== null) {
        throw usageError("error: give the params once, with either --params or --params-file");
      }
      const attached = token.length > flag.length;
      const value = attached ? token.slice(flag.length + 1) : argv[index + 1];
      if (value === undefined || value === "" || (!attached && value.length > 1 && value.startsWith("-"))) {
        throw usageError(`error: a value is required for '${flag}' but none was supplied`);
      }
      source = flag === "--params" ? { flag, json: value } : { flag, path: value };
      index += attached ? 0 : 1;
      continue;
    }
    if (actionToken === null && (optionsEnded || !token.startsWith("-"))) {
      actionToken = token;
      continue;
    }
    throw unexpectedArgument(token, RULES_USAGE);
  }
  if (actionToken === null) {
    throw usageError("error: the following required arguments were not provided:\n  <ACTION>");
  }
  if (!isRuleAction(actionToken)) {
    throw unknownAction(actionToken);
  }
  const action = actionToken;
  if (action === "describe" && source !== null) {
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
  return { kind: "rules", action, params: source === null ? {} : resolveParams(source), yes };
}

// "--params", "--params=…", "--params-file", "--params-file=…" → the flag.
function paramsFlag(token: string): "--params" | "--params-file" | null {
  for (const flag of ["--params-file", "--params"] as const) {
    if (token === flag || token.startsWith(`${flag}=`)) {
      return flag;
    }
  }
  return null;
}

function resolveParams(source: ParamsSource): Record<string, unknown> {
  if (source.flag === "--params") {
    return parseParamsObject(
      source.json,
      "--params",
      "\nFor JSON that's hard to quote in this shell, save it to a file and pass\n--params-file <PATH> instead.",
    );
  }
  return parseParamsObject(readParamsFile(source.path), "--params-file", "");
}

function parseParamsObject(rawValue: string, flag: string, hint: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawValue);
  } catch {
    parsed = null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw usageError(
      `error: invalid value for '${flag}':\n'${flag}' must be a JSON object, like '{"rule_ref":"rule_..."}'${hint}`,
    );
  }
  return parsed as Record<string, unknown>;
}

// The path is the caller's own; neither it nor the contents are ever echoed
// back. The read is bounded by bytes actually read, not by the size stat
// reports (pseudo-files report 0, and a file can grow between stat and
// read). Special files are refused before they are opened, since opening a
// FIFO blocks; on POSIX the open is also non-blocking, so a FIFO swapped in
// after the check is refused by the fstat instead of hanging.
function readParamsFile(path: string): string {
  let bytes: Buffer;
  try {
    if (!statSync(path).isFile()) {
      throw new ParamsFileProblem("the path isn't a regular file");
    }
    bytes = readAtMost(path, MAX_PARAMS_FILE_BYTES + 1);
  } catch (error) {
    throw usageError(`error: couldn't read the --params-file: ${paramsFileProblem(error)}`);
  }
  if (bytes.length > MAX_PARAMS_FILE_BYTES) {
    throw usageError(`error: couldn't read the --params-file: it's over ${MAX_PARAMS_FILE_MB} MB`);
  }
  return decodeParamsFile(bytes);
}

class ParamsFileProblem extends Error {}

function readAtMost(path: string, limit: number): Buffer {
  const descriptor = openSync(path, process.platform === "win32" ? "r" : constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    if (!fstatSync(descriptor).isFile()) {
      throw new ParamsFileProblem("the path isn't a regular file");
    }
    const buffer = Buffer.alloc(limit);
    let length = 0;
    while (length < limit) {
      const read = readSync(descriptor, buffer, length, limit - length, null);
      if (read === 0) {
        break;
      }
      length += read;
    }
    return buffer.subarray(0, length);
  } finally {
    closeSync(descriptor);
  }
}

function paramsFileProblem(error: unknown): string {
  if (error instanceof ParamsFileProblem) {
    return error.message;
  }
  const code = error instanceof Error && "code" in error ? error.code : undefined;
  if (code === "ENOENT") {
    return "there's no file at that path";
  }
  if (code === "EACCES" || code === "EPERM") {
    return "this account isn't allowed to read it";
  }
  return `it must be a readable JSON file under ${MAX_PARAMS_FILE_MB} MB`;
}

// Editors and shells on Windows often save "UTF-8" with a byte-order mark,
// and Windows PowerShell 5.1's > writes UTF-16LE; both read as the JSON
// they hold.
function decodeParamsFile(bytes: Buffer): string {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) {
    return bytes.subarray(2).toString("utf16le");
  }
  const text = bytes.toString("utf8");
  return text.startsWith("\uFEFF") ? text.slice(1) : text;
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
