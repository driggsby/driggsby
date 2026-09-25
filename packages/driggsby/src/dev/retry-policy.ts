// How `driggsby dev` retries a failed tool call: the same policy the
// Driggsby console's dashboard host uses, so a preview loads (or fails)
// the way the deployed app would. A timeout is retried once (an immediate
// retry of a timeout usually times out again); a busy or unavailable
// answer, a rate limit, and a failed request up to three times; a wrong
// input never. The wait backs off with full jitter and is never shorter
// than the server asked.

export type FailureKind = "timeout" | "unavailable" | "busy" | "rate_limited" | "transport";

export interface RetryHint {
  kind: FailureKind;
  // The server's retry hint in milliseconds, when it gave one.
  afterMs: number | null;
}

export const RETRY_LIMITS: Readonly<Record<FailureKind, number>> = {
  timeout: 1,
  unavailable: 3,
  busy: 3,
  rate_limited: 3,
  transport: 3,
};

// The failure kinds the Driggsby service names. Only these reach an app's
// onError; anything else in a kind field is dropped.
export const SERVICE_FAILURE_KINDS: ReadonlySet<string> = new Set(["timeout", "unavailable", "busy", "rate_limited"]);

const BACKOFF_BASE_MS = 1_000;
const BACKOFF_CAP_MS = 8_000;
// A server-provided wait is honored, but never beyond this.
const MAX_RETRY_AFTER_MS = 60_000;

// Full jitter: a random wait up to an exponentially growing ceiling, and
// never sooner than the server asked.
export function retryDelayMs(attempt: number, afterMs: number | null, random: () => number = Math.random): number {
  const ceiling = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** attempt);
  const jitter = Math.floor(random() * ceiling);
  const serverWait = afterMs === null ? 0 : Math.min(Math.max(afterMs, 0), MAX_RETRY_AFTER_MS);
  return Math.max(serverWait, jitter);
}

// The service's named kind of a refused tool call (structuredContent.kind),
// or null for anything else.
export function refusalKind(structuredContent: unknown): FailureKind | null {
  if (typeof structuredContent !== "object" || structuredContent === null) {
    return null;
  }
  const kind = (structuredContent as Record<string, unknown>).kind;
  return typeof kind === "string" && SERVICE_FAILURE_KINDS.has(kind) ? (kind as FailureKind) : null;
}

// A retryable refusal in an MCP tool result: a named kind, retryable true,
// and an optional retry_after_ms in structuredContent.
export function refusalRetryHint(structuredContent: unknown): RetryHint | null {
  const kind = refusalKind(structuredContent);
  if (kind === null || (structuredContent as Record<string, unknown>).retryable !== true) {
    return null;
  }
  const after = (structuredContent as Record<string, unknown>).retry_after_ms;
  return { kind, afterMs: typeof after === "number" && Number.isFinite(after) ? after : null };
}

// An HTTP failure that can pass on its own: a request timeout (408), a
// limit (429), or a server error (5xx). Any other status would fail the
// same way again.
export function httpRetryHint(status: number, retryAfterHeader: string | null): RetryHint | null {
  if (status !== 408 && status !== 429 && status < 500) {
    return null;
  }
  const seconds = retryAfterHeader === null ? Number.NaN : Number.parseInt(retryAfterHeader, 10);
  return { kind: "transport", afterMs: Number.isFinite(seconds) ? seconds * 1_000 : null };
}
