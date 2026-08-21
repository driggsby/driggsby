// Hand-rolled argv parsing for the small fixed command tree, mirroring the
// original clap behavior: help to stderr with exit 2 when a required
// subcommand is missing, help to stdout with exit 0 when asked for, and
// clap-shaped errors (exit 2) for unknown arguments.
import { CliError } from "./cli-error.ts";
import { MCP_HELP, MCP_SETUP_HELP, ROOT_HELP } from "./help.ts";
import { type McpScope } from "./mcp-setup/known-client.ts";
import { sanitizeForTerminal } from "./terminal-text.ts";

const ROOT_USAGE = "Usage: npx driggsby@latest <COMMAND>";
const MCP_USAGE = "Usage: npx driggsby@latest mcp <COMMAND>";
const SETUP_USAGE = "Usage: npx driggsby@latest mcp setup [OPTIONS] [CLIENT]";

export type ParsedCommand =
  | { kind: "print-help"; text: string; stream: "stdout" | "stderr"; exitCode: 0 | 2 }
  | { kind: "print-version" }
  | { kind: "mcp-setup"; client: string | undefined; print: boolean; scope: McpScope | undefined };

export function parseArgv(argv: string[]): ParsedCommand {
  const first = argv[0];
  if (first === undefined) {
    return { kind: "print-help", text: ROOT_HELP, stream: "stderr", exitCode: 2 };
  }
  if (first === "-h" || first === "--help") {
    return { kind: "print-help", text: ROOT_HELP, stream: "stdout", exitCode: 0 };
  }
  if (first === "-V" || first === "--version") {
    return { kind: "print-version" };
  }
  if (first === "mcp") {
    return parseMcp(argv.slice(1));
  }
  if (first.startsWith("-")) {
    throw unexpectedArgument(first, ROOT_USAGE);
  }
  throw unrecognizedSubcommand(first, ROOT_USAGE);
}

function parseMcp(argv: string[]): ParsedCommand {
  const first = argv[0];
  if (first === undefined) {
    return { kind: "print-help", text: MCP_HELP, stream: "stderr", exitCode: 2 };
  }
  if (first === "-h" || first === "--help") {
    return { kind: "print-help", text: MCP_HELP, stream: "stdout", exitCode: 0 };
  }
  if (first === "setup") {
    return parseMcpSetup(argv.slice(1));
  }
  if (first.startsWith("-")) {
    throw unexpectedArgument(first, MCP_USAGE);
  }
  throw unrecognizedSubcommand(first, MCP_USAGE);
}

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
      // clap's end-of-options marker: everything after is positional.
      optionsEnded = true;
      continue;
    }
    if (token === "-h" || token === "--help") {
      return { kind: "print-help", text: MCP_SETUP_HELP, stream: "stdout", exitCode: 0 };
    }
    if (token === "--print") {
      print = true;
      continue;
    }
    if (token.startsWith("-s")) {
      // Exactly "-s" takes its value from the next argv slot; "-s<value>"
      // and "-s=<value>" carry it attached.
      let value: string | undefined;
      if (token === "-s") {
        // clap refuses a dash-leading next token as the value ("a value is
        // required"), rather than swallowing another flag.
        value = argv[index + 1];
        // clap refuses a dash-leading next token as the value ("a value is
        // required") — except a bare "-", which it accepts as a value.
        if (value !== undefined && value !== "-" && value.startsWith("-")) {
          value = undefined;
        } else {
          index += 1;
        }
      } else {
        value = token.startsWith("-s=") ? token.slice(3) : token.slice(2);
      }
      if (scope !== undefined) {
        // clap reports duplication before it even looks at the second value.
        throw new CliError(
          `error: the argument '-s <MCP_SCOPE>' cannot be used multiple times\n\n${SETUP_USAGE}\n\nFor more information, try '--help'.`,
          2,
        );
      }
      if (value === undefined || value === "") {
        throw new CliError(
          `error: a value is required for '-s <MCP_SCOPE>' but none was supplied\n  [possible values: local, user]\n\nFor more information, try '--help'.`,
          2,
        );
      }
      scope = parseScopeValue(value);
      continue;
    }
    if (token !== "-" && token.startsWith("-")) {
      throw unexpectedArgument(token, SETUP_USAGE, { tip: true });
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
  throw new CliError(
    `error: invalid value '${shown}' for '-s <MCP_SCOPE>'\n  [possible values: local, user]\n\nFor more information, try '--help'.`,
    2,
  );
}

function unexpectedArgument(
  argument: string,
  usage: string,
  options: { tip?: boolean } = {},
): CliError {
  const shown = sanitizeForTerminal(argument);
  const tip =
    options.tip === true ? `  tip: to pass '${shown}' as a value, use '-- ${shown}'\n\n` : "";
  return new CliError(
    `error: unexpected argument '${shown}' found\n\n${tip}${usage}\n\nFor more information, try '--help'.`,
    2,
  );
}

function unrecognizedSubcommand(subcommand: string, usage: string): CliError {
  return new CliError(
    `error: unrecognized subcommand '${sanitizeForTerminal(subcommand)}'\n\n${usage}\n\nFor more information, try '--help'.`,
    2,
  );
}
