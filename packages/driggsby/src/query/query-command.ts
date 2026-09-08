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
import { deployFailure, requireDeploySession } from "../deploy/api-session.ts";

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

const SIGN_IN_AGAIN_MESSAGE =
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
  const baseUrl = apiBaseUrl(environment.env);
  const retryCommand = `npx driggsby@latest query ${options.tool}`;
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
      // answer the caller needs; it is already capped and sanitized.
      throw new CliError(outcome.error.message, 1);
    }
    io.out(`${JSON.stringify(outcome.result, null, 2)}\n`);
    return 0;
  } catch (error) {
    throw deployFailure(error, baseUrl, retryCommand);
  }
}
