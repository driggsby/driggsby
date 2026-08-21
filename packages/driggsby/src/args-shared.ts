// The parsed-command union and the CliError builders shared by the level
// dispatcher (args.ts) and the mcp setup parser (args-mcp-setup.ts). Every
// builder sanitizes what it interpolates, so no control bytes can reach the
// terminal through an echoed argument, tip, or usage line.
import { CliError } from "./cli-error.ts";
import { type McpScope } from "./mcp-setup/known-client.ts";
import { sanitizeForTerminal } from "./terminal-text.ts";

export type ParsedCommand =
  | { kind: "print-help"; text: string; stream: "stdout" | "stderr"; exitCode: 0 | 2 }
  | { kind: "print-version" }
  | { kind: "mcp-setup"; client: string | undefined; print: boolean; scope: McpScope | undefined }
  | { kind: "login" }
  | { kind: "logout" };

// "--print=true" / "--help=x" / "--version=x": these flags take no value.
export function unexpectedFlagValue(flag: string, rawValue: string, usage: string): CliError {
  const value = sanitizeForTerminal(rawValue);
  return new CliError(
    `error: unexpected value '${value}' for '${sanitizeForTerminal(flag)}' found; no more were expected\n\n${sanitizeForTerminal(usage)}\n\nFor more information, try '--help'.`,
    2,
  );
}

export function unexpectedArgument(argument: string, usage: string, tipLine?: string): CliError {
  const shown = sanitizeForTerminal(argument);
  const tip = tipLine === undefined ? "" : `${sanitizeForTerminal(tipLine)}\n\n`;
  return new CliError(
    `error: unexpected argument '${shown}' found\n\n${tip}${sanitizeForTerminal(usage)}\n\nFor more information, try '--help'.`,
    2,
  );
}

export function similarArgumentTip(flagName: string): string {
  return `  tip: a similar argument exists: '--${flagName}'`;
}

export function passAsValueTip(shownArgument: string): string {
  return `  tip: to pass '${shownArgument}' as a value, use '-- ${shownArgument}'`;
}

export function removeDashesTip(subcommand: string): string {
  return `  tip: subcommand '${subcommand}' exists; to use it, remove the '--' before it`;
}
