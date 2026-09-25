// Argv parsing for driggsby login: help, and --code to finish a sign-in that
// is waiting on this computer with the code its approval page showed. Same
// contract as the rest of the tree: usage errors exit 2, echoed argv is
// sanitized.
import { helpCommand, type ParsedCommand, unexpectedArgument } from "./args-shared.ts";
import { CliError } from "./cli-error.ts";
import { LOGIN_HELP } from "./help.ts";

const LOGIN_USAGE = "Usage: npx driggsby@latest login [--code <CODE>]";

export function parseLogin(argv: string[]): ParsedCommand {
  let code: string | null = null;
  let optionsEnded = false;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] ?? "";
    if (!optionsEnded && token === "--") {
      optionsEnded = true;
      continue;
    }
    if (!optionsEnded && (token === "-h" || token === "--help")) {
      return helpCommand(LOGIN_HELP);
    }
    if (!optionsEnded && code === null && token === "--code") {
      code = requireCode(argv[index + 1]);
      index += 1;
      continue;
    }
    if (!optionsEnded && code === null && token.startsWith("--code=")) {
      code = requireCode(token.slice("--code=".length));
      continue;
    }
    throw unexpectedArgument(token, LOGIN_USAGE);
  }
  return { kind: "login", code };
}

// A code is never empty or flag-like; a pasted one may carry spaces, which
// Driggsby reads past.
function requireCode(value: string | undefined): string {
  if (value === undefined || value.trim() === "" || value.startsWith("-")) {
    throw new CliError(
      `error: a value is required for '--code <CODE>' but none was supplied\n\n${LOGIN_USAGE}\n\nFor more information, try '--help'.`,
      2,
    );
  }
  return value;
}
