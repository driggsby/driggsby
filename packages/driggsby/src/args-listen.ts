// Argv parsing for driggsby listen: one optional flag, --json. Same help
// routing, "--" handling, and exit codes as deploy's --preview.
import { helpCommand, type ParsedCommand, unexpectedArgument, unexpectedFlagValue } from "./args-shared.ts";
import { LISTEN_HELP } from "./help.ts";

const LISTEN_USAGE = "Usage: npx driggsby@latest listen [--json]";

export function parseListen(argv: string[]): ParsedCommand {
  let json = false;
  let optionsEnded = false;
  for (const token of argv) {
    if (!optionsEnded && token === "--") {
      optionsEnded = true;
      continue;
    }
    if (!optionsEnded && (token === "-h" || token === "--help")) {
      return helpCommand(LISTEN_HELP);
    }
    if (!optionsEnded && token === "--json") {
      json = true;
      continue;
    }
    if (!optionsEnded && token.startsWith("--json=")) {
      throw unexpectedFlagValue("--json", token.slice("--json=".length), LISTEN_USAGE);
    }
    throw unexpectedArgument(token, LISTEN_USAGE);
  }
  return { kind: "listen", json };
}
