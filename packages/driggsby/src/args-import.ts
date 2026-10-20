// Argv parsing for `driggsby import`: `import <FILE>` with the account it
// goes in (--account, or --create-account with its type and name), `import
// <ID>` with --wait and one answer flag, `import undo <FILE or ID> [--yes]`,
// `import list`, and `accounts list`.
// Same contract as the rest of the tree: help on -h/--help, usage errors
// exit 2 and name the fix, echoed argv is sanitized, and "--" ends options
// (so a file whose name starts with "-" still imports).
import { helpCommand, type ParsedCommand, unexpectedArgument } from "./args-shared.ts";
import { CliError } from "./cli-error.ts";
import { ACCOUNTS_HELP, IMPORT_HELP } from "./help.ts";
import { type ImportCommandOptions } from "./import/import-command.ts";
import { sanitizeForTerminal } from "./terminal-text.ts";

export const IMPORT_USAGE =
  "Usage: npx driggsby@latest import <FILE or ID> [--wait] [--account <ID> | --create-account --account-type <card|bank> --account-name <NAME>]";
const UNDO_USAGE = "Usage: npx driggsby@latest import undo <FILE or ID> [--yes]";
const LIST_USAGE = "Usage: npx driggsby@latest import list";
const ACCOUNTS_USAGE = "Usage: npx driggsby@latest accounts list";

const ANSWER_VALUES: Record<"--dates" | "--amounts", readonly string[]> = {
  "--dates": ["day-first", "month-first"],
  "--amounts": ["positive-is-out", "positive-is-in"],
};
const ACCOUNT_VALUE = /^acct_[A-Za-z0-9_-]{1,64}$/;
const ACCOUNT_TYPES: readonly string[] = ["card", "bank"];
const NAME_LIMIT = 100;
type ValueFlag = "--account" | "--account-type" | "--account-name" | "--dates" | "--amounts";

interface Found {
  target: string | null;
  wait: boolean;
  account: string | null;
  create: boolean;
  type: "card" | "bank" | null;
  name: string | null;
  dates: string | null;
  amounts: string | null;
}

export function parseAccounts(argv: string[]): ParsedCommand {
  const [first, ...rest] = argv;
  if (first === undefined || first === "-h" || first === "--help") {
    return helpCommand(ACCOUNTS_HELP);
  }
  if (first !== "list") {
    throw unexpectedArgument(first, ACCOUNTS_USAGE);
  }
  for (const token of rest) {
    if (token === "-h" || token === "--help") {
      return helpCommand(ACCOUNTS_HELP);
    }
    throw unexpectedArgument(token, ACCOUNTS_USAGE);
  }
  return { kind: "import", options: { action: "accounts" } };
}

export function parseImport(argv: string[]): ParsedCommand {
  const first = argv[0];
  if (first === "list") {
    return command(parseList(argv.slice(1)));
  }
  if (first === "undo") {
    return command(parseUndo(argv.slice(1)));
  }
  return command(parseRun(argv));
}

function command(options: ImportCommandOptions | ParsedCommand): ParsedCommand {
  return "kind" in options ? options : { kind: "import", options };
}

function parseList(argv: string[]): ImportCommandOptions | ParsedCommand {
  for (const token of argv) {
    if (token === "-h" || token === "--help") {
      return helpCommand(IMPORT_HELP);
    }
    throw unexpectedArgument(token, LIST_USAGE);
  }
  return { action: "list" };
}

function parseUndo(argv: string[]): ImportCommandOptions | ParsedCommand {
  let target: string | null = null;
  let yes = false;
  let optionsEnded = false;
  for (const token of argv) {
    if (!optionsEnded && token === "--") {
      optionsEnded = true;
    } else if (!optionsEnded && (token === "-h" || token === "--help")) {
      return helpCommand(IMPORT_HELP);
    } else if (!optionsEnded && token === "--yes") {
      yes = true;
    } else if (target === null && (optionsEnded || !token.startsWith("-"))) {
      target = token;
    } else {
      throw unexpectedArgument(token, UNDO_USAGE);
    }
  }
  if (target === null) {
    throw missing("<FILE or ID>", UNDO_USAGE);
  }
  return { action: "undo", target, yes };
}

function parseRun(argv: string[]): ImportCommandOptions | ParsedCommand {
  const found: Found = { target: null, wait: false, account: null, create: false, type: null, name: null, dates: null, amounts: null };
  let optionsEnded = false;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] ?? "";
    if (!optionsEnded && token === "--") {
      optionsEnded = true;
      continue;
    }
    if (!optionsEnded && (token === "-h" || token === "--help")) {
      return helpCommand(IMPORT_HELP);
    }
    if (!optionsEnded && token === "--wait") {
      found.wait = true;
      continue;
    }
    if (!optionsEnded && token === "--create-account") {
      found.create = true;
      continue;
    }
    const flag = optionsEnded ? null : valueFlag(token);
    if (flag !== null) {
      const inline = token.includes("=") ? token.slice(token.indexOf("=") + 1) : null;
      const value = inline ?? argv[index + 1];
      if (inline === null) {
        index += 1;
      }
      setValue(found, flag, value);
      continue;
    }
    if (found.target === null && (optionsEnded || !token.startsWith("-"))) {
      found.target = token;
      continue;
    }
    throw unexpectedArgument(token, IMPORT_USAGE);
  }
  if (found.target === null) {
    throw missing("<FILE or ID>", IMPORT_USAGE);
  }
  return { action: "run", target: found.target, wait: found.wait, account: found.account, create: checkedCreate(found), dates: found.dates, amounts: found.amounts };
}

// The new account, whole, or a usage error naming what's missing; one way to
// name the account, and an account flag never alongside an answer.
function checkedCreate(found: Found): { type: "card" | "bank"; name: string } | null {
  if (found.account !== null && found.create) {
    throw usage("name an existing account (--account) or a new one (--create-account), not both");
  }
  if (!found.create && (found.type !== null || found.name !== null)) {
    throw usage("--account-type and --account-name go with --create-account");
  }
  if ((found.account !== null || found.create) && (found.dates !== null || found.amounts !== null)) {
    throw usage("--dates and --amounts answer an import's question; --account and --create-account start an import. Give one or the other");
  }
  if (!found.create) {
    return null;
  }
  if (found.type === null || found.name === null) {
    throw usage("--create-account needs --account-type <card|bank> and --account-name <NAME>");
  }
  return { type: found.type, name: found.name };
}

function valueFlag(token: string): ValueFlag | null {
  const name = token.split("=", 1)[0];
  return name === "--account" || name === "--account-type" || name === "--account-name" || name === "--dates" || name === "--amounts" ? name : null;
}

function setValue(found: Found, flag: ValueFlag, value: string | undefined): void {
  if (value === undefined || value.trim() === "" || value.trim().startsWith("--")) {
    throw new CliError(`error: a value is required for '${flag}' but none was supplied\n\n${IMPORT_USAGE}\n\nFor more information, try '--help'.`, 2);
  }
  if (flag === "--account") {
    if (!ACCOUNT_VALUE.test(value)) {
      throw new CliError(
        `error: invalid value '${sanitizeForTerminal(value)}' for '--account': name the account by its ID, like acct_7kq2\n` +
          `(npx driggsby@latest accounts list shows each one)\n\n${IMPORT_USAGE}\n\nFor more information, try '--help'.`,
        2,
      );
    }
    found.account = once(found.account, flag, value);
    return;
  }
  if (flag === "--account-type") {
    if (!ACCOUNT_TYPES.includes(value)) {
      throw invalid(flag, value, ACCOUNT_TYPES);
    }
    found.type = once(found.type, flag, value as "card" | "bank");
    return;
  }
  if (flag === "--account-name") {
    const name = value.trim();
    // Characters a terminal or Driggsby would drop are refused here, so the
    // name a retry prints is the name the account gets.
    if (name.length > NAME_LIMIT || sanitizeForTerminal(name) !== name || /\p{Cf}/u.test(name)) {
      throw new CliError(
        `error: invalid value for '--account-name': give the account's name, up to ${String(NAME_LIMIT)} characters\n\n${IMPORT_USAGE}\n\n` +
          "For more information, try '--help'.",
        2,
      );
    }
    found.name = once(found.name, flag, name);
    return;
  }
  const allowed = ANSWER_VALUES[flag];
  if (!allowed.includes(value)) {
    throw invalid(flag, value, allowed);
  }
  if (found.dates !== null || found.amounts !== null) {
    throw usage("give one answer at a time: --dates or --amounts");
  }
  if (flag === "--dates") {
    found.dates = value;
  } else {
    found.amounts = value;
  }
}

function once<T>(current: T | null, flag: ValueFlag, value: T): T {
  if (current !== null) {
    throw usage(`'${flag}' was given more than once`);
  }
  return value;
}

function invalid(flag: ValueFlag, value: string, allowed: readonly string[]): CliError {
  return new CliError(
    `error: invalid value '${sanitizeForTerminal(value)}' for '${flag}'\n  [possible values: ${allowed.join(", ")}]\n\n${IMPORT_USAGE}\n\nFor more information, try '--help'.`,
    2,
  );
}

function usage(problem: string): CliError {
  return new CliError(`error: ${problem}\n\n${IMPORT_USAGE}\n\nFor more information, try '--help'.`, 2);
}

function missing(argument: string, usage: string): CliError {
  return new CliError(`error: the following required arguments were not provided:\n  ${argument}\n\n${usage}\n\nFor more information, try '--help'.`, 2);
}
