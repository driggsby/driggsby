// Argv parsing for driggsby init: one optional positional (the app's name),
// help, and the shared usage-error shape — usage errors exit 2, echoed argv
// is sanitized by the shared builders.
import { type ParsedCommand, unexpectedArgument } from "./args-shared.ts";
import { INIT_HELP } from "./help.ts";

const INIT_USAGE = "Usage: npx driggsby@latest init [NAME]";

export function parseInit(argv: string[]): ParsedCommand {
  let slug: string | null = null;
  let optionsEnded = false;
  for (const token of argv) {
    if (!optionsEnded && token === "--") {
      optionsEnded = true;
      continue;
    }
    if (!optionsEnded && (token === "-h" || token === "--help")) {
      return { kind: "print-help", text: INIT_HELP, stream: "stdout", exitCode: 0 };
    }
    // Any other flag-looking token is a mistake, not a name; after "--"
    // everything is positional and slug validation refuses bad names.
    if (!optionsEnded && token.startsWith("-") && token !== "-") {
      throw unexpectedArgument(token, INIT_USAGE);
    }
    if (slug !== null) {
      throw unexpectedArgument(token, INIT_USAGE);
    }
    slug = token;
  }
  return { kind: "init", slug };
}
