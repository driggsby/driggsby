// Argv parsing for the deploy command family: deploy, rollback, versions.
// Same behavior contract as the rest of the tree — help on -h/--help, usage
// errors exit 2, echoed argv is sanitized — without chasing clap byte quirks.
import {
  helpCommand,
  type ParsedCommand,
  unexpectedArgument,
  unexpectedFlagValue,
} from "./args-shared.ts";
import { CliError } from "./cli-error.ts";
import { DEPLOY_HELP, ROLLBACK_HELP, VERSIONS_HELP } from "./help.ts";
import { sanitizeForTerminal } from "./terminal-text.ts";

const DEPLOY_USAGE = "Usage: npx driggsby@latest deploy [--preview]";
const ROLLBACK_USAGE = "Usage: npx driggsby@latest rollback [--to <VERSION>]";
const VERSIONS_USAGE = "Usage: npx driggsby@latest versions";

export function parseDeploy(argv: string[]): ParsedCommand {
  let preview = false;
  let optionsEnded = false;
  for (const token of argv) {
    if (!optionsEnded && token === "--") {
      optionsEnded = true;
      continue;
    }
    if (!optionsEnded && (token === "-h" || token === "--help")) {
      return helpCommand(DEPLOY_HELP);
    }
    if (!optionsEnded && token === "--preview") {
      preview = true;
      continue;
    }
    if (!optionsEnded && token.startsWith("--preview=")) {
      throw unexpectedFlagValue("--preview", token.slice("--preview=".length), DEPLOY_USAGE);
    }
    throw unexpectedArgument(token, DEPLOY_USAGE);
  }
  return { kind: "deploy", preview };
}

export function parseRollback(argv: string[]): ParsedCommand {
  let toVersion: number | null = null;
  let optionsEnded = false;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] ?? "";
    if (!optionsEnded && token === "--") {
      optionsEnded = true;
      continue;
    }
    if (!optionsEnded && (token === "-h" || token === "--help")) {
      return helpCommand(ROLLBACK_HELP);
    }
    if (!optionsEnded && token === "--to") {
      const value = argv[index + 1];
      if (value === undefined) {
        throw missingToValue();
      }
      toVersion = parseVersionNumber(value);
      index += 1;
      continue;
    }
    if (!optionsEnded && token.startsWith("--to=")) {
      toVersion = parseVersionNumber(token.slice("--to=".length));
      continue;
    }
    throw unexpectedArgument(token, ROLLBACK_USAGE);
  }
  return { kind: "rollback", toVersion };
}

export function parseVersions(argv: string[]): ParsedCommand {
  let optionsEnded = false;
  for (const token of argv) {
    if (!optionsEnded && token === "--") {
      optionsEnded = true;
      continue;
    }
    if (!optionsEnded && (token === "-h" || token === "--help")) {
      return helpCommand(VERSIONS_HELP);
    }
    throw unexpectedArgument(token, VERSIONS_USAGE);
  }
  return { kind: "versions" };
}

// Version numbers are the small positive integers shown by `versions` (v1,
// v2, ...). Anything else is a usage mistake, reported like other bad argv —
// including a digit string too large for an exact integer, which would
// otherwise serialize in scientific notation and reach the server as
// something like 1e+23.
function parseVersionNumber(rawValue: string): number {
  const parsed = Number.parseInt(rawValue, 10);
  if (!/^[0-9]+$/.test(rawValue) || !Number.isSafeInteger(parsed) || parsed < 1) {
    throw new CliError(
      `error: invalid value '${sanitizeForTerminal(rawValue)}' for '--to': expected a version number like 3\n\n` +
        `${ROLLBACK_USAGE}\n\nFor more information, try '--help'.`,
      2,
    );
  }
  return parsed;
}

function missingToValue(): CliError {
  return new CliError(
    `error: a value is required for '--to' but none was supplied\n\n${ROLLBACK_USAGE}\n\nFor more information, try '--help'.`,
    2,
  );
}
