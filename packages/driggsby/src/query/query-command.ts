// driggsby query: run one read-only tool once with the saved sign-in and
// print its result as JSON — exactly what driggsby.watch hands an app's
// callback for the same tool and params — so an agent can read a result's
// shape before writing render code. stdout carries only the JSON; every
// message is a CliError on stderr, so the output can be piped or saved.
import { apiBaseUrl } from "../api/base-url.ts";
import { CliError } from "../cli-error.ts";
import {
  type CredentialEnvironment,
  defaultCredentialEnvironment,
} from "../credentials/store.ts";
import { McpBroker } from "../dev/mcp-broker.ts";
import { APP_TOOL_ALLOWLIST, SQL_TOOLS } from "../dev/tool-allowlist.ts";
import { deployFailure, requireDeploySession } from "../deploy/api-session.ts";
import { quotedForTerminal, wrapProse } from "../terminal-text.ts";

export interface QueryCommandOptions {
  tool: string;
  params: Record<string, unknown>;
}

export interface QueryCommandIo {
  out: (text: string) => void;
}

// The Driggsby endpoint requires a short reason on most read tools; when
// the caller gives none, this names the CLI rather than the dev preview.
const QUERY_REASON = "Checking this tool's result shape from the driggsby CLI.";

export const SIGN_IN_AGAIN_MESSAGE =
  "Your sign-in on this machine isn't valid anymore. Sign in again:\n  npx driggsby@latest login";

function defaultQueryIo(): QueryCommandIo {
  return {
    out: (text) => {
      process.stdout.write(text);
    },
  };
}

export async function runQuery(
  options: QueryCommandOptions,
  environment: CredentialEnvironment = defaultCredentialEnvironment(),
  io: QueryCommandIo = defaultQueryIo(),
): Promise<number> {
  // The parser already rejects a tool apps cannot call; re-checking here keeps
  // the read-only guarantee (and the echoed retry command) from hanging on
  // one distant caller.
  if (!APP_TOOL_ALLOWLIST.has(options.tool)) {
    throw new CliError(`${quotedForTerminal(options.tool, 60)} isn't a tool a Driggsby app can call.`, 2);
  }
  const baseUrl = apiBaseUrl(environment.env);
  const retryCommand = retryCommandFor(options);
  try {
    const session = await requireDeploySession(environment);
    const broker = new McpBroker({
      baseUrl: session.baseUrl,
      token: session.token,
      defaultReason: QUERY_REASON,
      signInAgainMessage: SIGN_IN_AGAIN_MESSAGE,
      // A connection failure here should read as one (a blocked network
      // names the host to allow), not as a tool that "couldn't run".
      transportErrors: "throw",
    });
    const outcome = await broker.runToolCall(options.tool, options.params);
    if (!outcome.ok) {
      // The tool's own message (a SQL error, a refused param) is the
      // answer the caller needs. The broker sanitized and capped it to one
      // line; wrapping bounds its width. The sign-in-again message is ours
      // and keeps its own line breaks.
      const message = outcome.error.message === SIGN_IN_AGAIN_MESSAGE
        ? outcome.error.message
        : wrapProse(outcome.error.message);
      throw new CliError(message, 1);
    }
    io.out(`${JSON.stringify(outcome.result, null, 2)}\n`);
    return 0;
  } catch (error) {
    throw deployFailure(error, baseUrl, retryCommand);
  }
}

// The command to run again after a network blip. User values are never
// rebuilt into a shell line: no quoting is right for sh, cmd.exe, and
// PowerShell at once, so the line names the flags to repeat in the CLI's
// own <placeholder> convention and stays copy-safe on every shell.
function retryCommandFor(options: QueryCommandOptions): string {
  const parts = [`npx driggsby@latest query ${options.tool}`];
  // Only the SQL tools take --sql; for every other tool a sql key is just
  // another param, and naming --sql would hand back a command the parser
  // refuses.
  const sqlAsFlag = SQL_TOOLS.has(options.tool) && options.params.sql !== undefined;
  if (sqlAsFlag) {
    parts.push("--sql <the same SQL>");
  }
  const otherKeys = Object.keys(options.params).filter((key) => !(sqlAsFlag && key === "sql"));
  if (otherKeys.length > 0) {
    parts.push("--params <the same JSON>");
  }
  return parts.join(" ");
}
