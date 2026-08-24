// Turns a failed fetch to the Driggsby API into one exact-fix message for
// restricted-network environments (agent sandboxes with egress allowlists
// are the common case). Written for a zero-context agent: it names the one
// domain to allow and the one command to rerun. Anything that is not a
// connection-level failure returns null so the caller's own handling runs.
import { CliError } from "../cli-error.ts";
import { wrapProse } from "../terminal-text.ts";

const CONNECTION_FAILURE_CODES = new Set([
  "ENOTFOUND",
  "EAI_AGAIN",
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EPIPE",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_SOCKET",
]);

export interface BlockedNetworkContext {
  host: string;
  retryCommand: string;
}

export function blockedNetworkError(
  error: unknown,
  context: BlockedNetworkContext,
): CliError | null {
  if (!hasConnectionFailure(error, 0)) {
    return null;
  }
  // The host is dynamic, so both sentences go through wrapProse: an agent
  // reading this to build an egress allowlist must never see the hostname
  // split across a soft-wrapped line.
  return new CliError(
    `${wrapProse(`We couldn't reach ${context.host} from this machine.`)}\n\n` +
      `${wrapProse(`If this environment restricts network access, allow HTTPS access to ${context.host} and try again:`)}\n` +
      `  ${context.retryCommand}`,
    1,
  );
}

// Walks the error's cause chain (and AggregateError members — undici reports
// multi-address connection failures that way) looking for a known
// connection-level errno code.
function hasConnectionFailure(error: unknown, depth: number): boolean {
  if (depth > 6 || typeof error !== "object" || error === null) {
    return false;
  }
  const code = (error as { code?: unknown }).code;
  if (typeof code === "string" && CONNECTION_FAILURE_CODES.has(code)) {
    return true;
  }
  // An AbortSignal.timeout fires as a DOMException named TimeoutError: the
  // stalled-but-connected shape (an egress proxy that accepts and never
  // replies) that the errno codes above don't cover.
  if ((error as { name?: unknown }).name === "TimeoutError") {
    return true;
  }
  if (error instanceof AggregateError && error.errors.some((inner) => hasConnectionFailure(inner, depth + 1))) {
    return true;
  }
  const cause = (error as { cause?: unknown }).cause;
  return hasConnectionFailure(cause, depth + 1);
}
