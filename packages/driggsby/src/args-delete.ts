// Argv parsing for driggsby delete: one optional positional (the app's
// address name), --yes for scripts and agents, help, and the shared
// usage-error shape — usage errors exit 2, echoed argv is sanitized by the
// shared builders.
import {
  helpCommand,
  type ParsedCommand,
  unexpectedArgument,
  unexpectedFlagValue,
} from "./args-shared.ts";
import { DELETE_HELP } from "./help.ts";

const DELETE_USAGE = "Usage: npx driggsby@latest delete [APP-ADDRESS-NAME] [--yes]";

export function parseDelete(argv: string[]): ParsedCommand {
  let slug: string | null = null;
  let yes = false;
  let optionsEnded = false;
  for (const token of argv) {
    if (!optionsEnded && token === "--") {
      optionsEnded = true;
      continue;
    }
    if (!optionsEnded && (token === "-h" || token === "--help")) {
      return helpCommand(DELETE_HELP);
    }
    if (!optionsEnded && token === "--yes") {
      yes = true;
      continue;
    }
    if (!optionsEnded && token.startsWith("--yes=")) {
      throw unexpectedFlagValue("--yes", token.slice("--yes=".length), DELETE_USAGE);
    }
    // Any other flag-looking token is a mistake, not a name; after "--"
    // everything is positional and the server refuses unknown names.
    if (!optionsEnded && token.startsWith("-") && token !== "-") {
      throw unexpectedArgument(token, DELETE_USAGE);
    }
    if (slug !== null) {
      throw unexpectedArgument(token, DELETE_USAGE);
    }
    slug = token;
  }
  return { kind: "delete", slug, yes };
}
