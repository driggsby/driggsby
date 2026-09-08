// Argv parsing for `driggsby dev [--stop]`. Same contract as the rest of the
// tree: help on -h/--help, usage errors exit 2, echoed argv is sanitized.
import { helpCommand, type ParsedCommand, unexpectedArgument, unexpectedFlagValue } from "./args-shared.ts";
import { DEV_HELP } from "./help.ts";

export const DEV_USAGE = "Usage: npx driggsby@latest dev [--stop]";

export function parseDev(argv: string[]): ParsedCommand {
  let stop = false;
  let optionsEnded = false;
  for (const token of argv) {
    if (!optionsEnded && token === "--") {
      optionsEnded = true;
      continue;
    }
    if (!optionsEnded && (token === "-h" || token === "--help")) {
      return helpCommand(DEV_HELP);
    }
    if (!optionsEnded && token === "--stop") {
      stop = true;
      continue;
    }
    if (!optionsEnded && token.startsWith("--stop=")) {
      throw unexpectedFlagValue("--stop", token.slice("--stop=".length), DEV_USAGE);
    }
    throw unexpectedArgument(token, DEV_USAGE);
  }
  return { kind: "dev", stop };
}
