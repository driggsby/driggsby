// Hand-rolled argv parsing for the small fixed command tree, mirroring the
// original clap behavior: help to stderr with exit 2 when a required
// subcommand is missing, help to stdout with exit 0 when asked for, and
// clap-shaped errors (exit 2) for unknown arguments.
import { CliError } from "./cli-error.ts";
import { MCP_HELP, MCP_SETUP_HELP, ROOT_HELP } from "./help.ts";
import { type McpScope } from "./mcp-setup/known-client.ts";

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

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === undefined) {
      break;
    }
    if (token === "-h" || token === "--help") {
      return { kind: "print-help", text: MCP_SETUP_HELP, stream: "stdout", exitCode: 0 };
    }
    if (token === "--print") {
      print = true;
      continue;
    }
    if (token === "-s" || token.startsWith("-s=") || (token.startsWith("-s") && token.length > 2)) {
      let value: string | undefined;
      if (token === "-s") {
        value = argv[index + 1];
        if (value === undefined) {
          throw new CliError(
            `error: a value is required for '-s <MCP_SCOPE>' but none was supplied\n\nFor more information, try '--help'.`,
            2,
          );
        }
        index += 1;
      } else {
        value = token.startsWith("-s=") ? token.slice(3) : token.slice(2);
      }
      scope = parseScopeValue(value);
      continue;
    }
    if (token.startsWith("-")) {
      throw unexpectedArgument(token, SETUP_USAGE);
    }
    if (client !== undefined) {
      throw unexpectedArgument(token, SETUP_USAGE);
    }
    client = token;
  }

  return { kind: "mcp-setup", client, print, scope };
}

function parseScopeValue(value: string): McpScope {
  if (value === "local" || value === "user") {
    return value;
  }
  throw new CliError(
    `error: invalid value '${value}' for '-s <MCP_SCOPE>'\n  [possible values: local, user]\n\nFor more information, try '--help'.`,
    2,
  );
}

function unexpectedArgument(argument: string, usage: string): CliError {
  return new CliError(
    `error: unexpected argument '${argument}' found\n\n${usage}\n\nFor more information, try '--help'.`,
    2,
  );
}

function unrecognizedSubcommand(subcommand: string, usage: string): CliError {
  return new CliError(
    `error: unrecognized subcommand '${subcommand}'\n\n${usage}\n\nFor more information, try '--help'.`,
    2,
  );
}
