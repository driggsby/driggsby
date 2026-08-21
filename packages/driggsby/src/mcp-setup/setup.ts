import { createInterface } from "node:readline/promises";

import { CliError } from "../cli-error.ts";
import { trimLikeRust } from "../terminal-text.ts";
import { runClientCommand } from "./client-command.ts";
import { classifyExistingMcpConfig, type ClientCommandOutput } from "./classify.ts";
import {
  buildInspectorCommand,
  buildInstallerCommand,
  buildScopedRemoverCommand,
  type McpConfigCommand,
} from "./commands.ts";
import {
  type CliMcpClient,
  cliMcpClient,
  displayName,
  type KnownClient,
  type McpScope,
  parseClient,
  validateMcpScope,
} from "./known-client.ts";
import {
  alreadySetupBlock,
  autoSetupFailureBlock,
  existingConfigDiffersBlock,
  manualCommandBlock,
  otherClientInstructionsBlock,
  successBlock,
} from "./text.ts";

export interface McpSetupOptions {
  client: string | undefined;
  print: boolean;
  scope: McpScope | undefined;
}

export async function runMcpSetup(options: McpSetupOptions): Promise<void> {
  const client = await resolveClient(options.client);
  validateMcpScope(client, options.scope);

  const installClient = cliMcpClient(client);
  if (installClient === null) {
    write(otherClientInstructionsBlock());
    return;
  }

  const installer = buildInstallerCommand(installClient, options.scope);
  if (options.print) {
    write(manualCommandBlock(client, installer));
    return;
  }

  write(`Checking for Driggsby in ${displayName(client)} MCP config...\n`);
  if (await handleExistingConfig(client, installClient, options.scope, installer)) {
    return;
  }

  write(`Adding Driggsby to ${displayName(client)} MCP config...\n`);
  const result = await runClientCommand(installer, streamConfigOutput(client));
  switch (result.kind) {
    case "output":
      if (result.output.succeeded) {
        write(successBlock(client, codexCompletedLogin(result.output)));
      } else if (commandReportsExistingConfig(result.output)) {
        const remover = buildScopedRemoverCommand(installClient, options.scope);
        write(existingConfigDiffersBlock(client, remover, installer));
      } else {
        write(autoSetupFailureBlock(client, "The client command returned an error.", installer));
      }
      return;
    case "not-found":
      write(
        autoSetupFailureBlock(
          client,
          `${displayName(client)} is not installed or not on PATH.`,
          installer,
        ),
      );
      return;
    case "spawn-error":
      write(autoSetupFailureBlock(client, "Could not start the client command.", installer));
      return;
    case "timed-out":
      write(autoSetupFailureBlock(client, "The client command timed out.", installer));
      return;
  }
}

async function resolveClient(requested: string | undefined): Promise<KnownClient> {
  if (requested !== undefined) {
    return parseClient(requested);
  }
  return promptForClient();
}

// The stdin/stdout surface promptForClient talks to, injectable so the menu
// (including its EOF handling) is unit-testable without a pty.
export interface PromptStreams {
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
  isInteractive: boolean;
}

function defaultPromptStreams(): PromptStreams {
  return {
    input: process.stdin,
    output: process.stdout,
    isInteractive: process.stdin.isTTY,
  };
}

export async function promptForClient(
  streams: PromptStreams = defaultPromptStreams(),
): Promise<KnownClient> {
  if (!streams.isInteractive) {
    throw new CliError(
      "Pass a client name.\n\nExamples:\n  npx driggsby@latest mcp setup claude-code\n  npx driggsby@latest mcp setup codex\n  npx driggsby@latest mcp setup other",
      1,
    );
  }

  streams.output.write("Which client are you setting up?\n\n  1. Claude Code\n  2. Codex\n  3. Other\n\n");
  // terminal: false keeps the prompt a plain write (no cursor-control
  // escapes); the TTY's own canonical mode handles echo, as in the original.
  const readline = createInterface({
    input: streams.input,
    output: streams.output,
    terminal: false,
  });
  // EOF (Ctrl+D) never settles readline's question(); it only closes the
  // interface. Race the two so EOF becomes "no valid choice", exactly what
  // the original did with a zero-byte read.
  const closedAsEmptyChoice = new Promise<string>((resolve) => {
    readline.once("close", () => {
      resolve("");
    });
  });
  let choice: string;
  try {
    choice = trimLikeRust(
      await Promise.race([readline.question("Choose 1-3: "), closedAsEmptyChoice]),
    );
  } finally {
    readline.close();
  }
  switch (choice) {
    case "1":
      return "claude-code";
    case "2":
      return "codex";
    case "3":
      return "other";
    default:
      throw new CliError("Choose 1, 2, or 3.", 1);
  }
}

// Returns true when an existing config entry fully handled the run (already
// set up, or differs with remediation printed). Probe failures fall through
// to a normal install attempt.
async function handleExistingConfig(
  client: KnownClient,
  installClient: CliMcpClient,
  scope: McpScope | undefined,
  installer: McpConfigCommand,
): Promise<boolean> {
  const result = await runClientCommand(buildInspectorCommand(installClient), false);
  if (result.kind !== "output") {
    return false;
  }
  switch (classifyExistingMcpConfig(installClient, scope, result.output)) {
    case "matches":
      write(alreadySetupBlock(client));
      return true;
    case "differs":
      write(
        existingConfigDiffersBlock(
          client,
          buildScopedRemoverCommand(installClient, scope),
          installer,
        ),
      );
      return true;
    case "missing":
    case "unknown":
      return false;
  }
}

// Only Codex streams: its MCP add performs an interactive OAuth login
// in-band, and swallowing that output makes setup look hung.
function streamConfigOutput(client: KnownClient): boolean {
  return client === "codex";
}

function commandReportsExistingConfig(output: ClientCommandOutput): boolean {
  return output.stdout.includes("already exists") || output.stderr.includes("already exists");
}

function codexCompletedLogin(output: ClientCommandOutput): boolean {
  return (
    output.stdout.includes("Successfully logged in.") ||
    output.stderr.includes("Successfully logged in.")
  );
}

function write(text: string): void {
  process.stdout.write(text);
}
