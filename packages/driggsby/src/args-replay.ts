// Argv parsing for driggsby replay: a replay of a call our agent made, played
// in the terminal. Deliberately left out of --help (it is shared from an
// email, not part of the everyday command set). One replay so far: att.
import { type ParsedCommand, unexpectedArgument } from "./args-shared.ts";
import { CliError } from "./cli-error.ts";

const REPLAY_USAGE = "Usage: npx driggsby@latest replay att [--quiet]";
const REPLAYS = ["att"] as const;

export function parseReplay(argv: string[]): ParsedCommand {
  let name: string | null = null;
  let quiet = false;
  for (const token of argv) {
    if (token === "-h" || token === "--help") {
      return { kind: "print-help", text: `${REPLAY_USAGE}\n\nPlays a replay of a call our agent made.\n`, stream: "stdout", exitCode: 0 };
    }
    if (token === "--quiet") {
      quiet = true;
      continue;
    }
    if (name === null && !token.startsWith("-")) {
      name = token;
      continue;
    }
    throw unexpectedArgument(token, REPLAY_USAGE);
  }
  if (name === null || !(REPLAYS as readonly string[]).includes(name)) {
    throw new CliError(`There's one replay so far:\n  npx driggsby@latest replay att`, 2);
  }
  return { kind: "replay", quiet };
}
