// The app-token claim flow's HTTP client, against Driggsby's public
// app-token claim API: create a pending claim, send the user to claim_url,
// poll with the claim id + poll secret until the user approves. The app
// token is returned by exactly one poll; callers must never poll again after
// an approval.
import { CliError } from "../cli-error.ts";
import { sanitizeForTerminal } from "../terminal-text.ts";

const CLAIM_SCOPE = "driggsby.app_deploy";
const CLAIM_APP_NAME = "Driggsby CLI";
const REQUEST_TIMEOUT_MS = 15_000;
// The server names its own claim lifetime; this cap keeps a buggy or hostile
// expires_in from making the CLI wait (and poll) effectively forever.
const MAX_EXPIRES_IN_SECONDS = 1_800;
// Both endpoints answer with small JSON objects; anything enormous is not a
// real Driggsby response. The cap bounds what gets parsed and surfaced, not
// what the network buffers — the request timeout bounds that.
const MAX_RESPONSE_BODY_CHARS = 1_000_000;
// Server error_description fields are one or two sentences; a bound keeps a
// misbehaving origin from flooding the terminal through an error message.
const MAX_ERROR_DESCRIPTION_CHARS = 300;

export const SIGN_IN_START_FAILURE =
  "We weren't able to start a Driggsby sign-in just now. Please try again in\na minute.";
// Poll failures happen after the user may already have approved, so "start a
// sign-in" would be the wrong stage to describe.
const SIGN_IN_FINISH_FAILURE =
  "We weren't able to finish your Driggsby sign-in just now. Please try again\nin a minute.";

export interface ClaimRequest {
  claimRequestId: string;
  claimUrl: string;
  pollSecret: string;
  expiresInSeconds: number;
}

export async function createClaimRequest(baseUrl: string): Promise<ClaimRequest> {
  const response = await fetch(`${baseUrl}/app-tokens/claim-requests`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ app_name: CLAIM_APP_NAME, scope: CLAIM_SCOPE }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    // Never follow a redirect: a 307/308 would replay this claim flow —
    // and, on the poll below, the poll secret — to whatever origin a
    // Location header names. These endpoints never legitimately redirect.
    redirect: "error",
  });
  const body = await readJsonBody(response);

  if (response.status !== 201) {
    // The server's error_description fields are written to be user-facing;
    // errorDescription surfaces them sanitized and length-bounded.
    throw new CliError(errorDescription(body) ?? SIGN_IN_START_FAILURE, 1);
  }
  const record = asRecord(body);
  const claimRequestId = stringField(record, "claim_request_id");
  const claimUrl = stringField(record, "claim_url");
  const pollSecret = stringField(record, "poll_secret");
  const expiresIn = record?.expires_in;
  if (
    claimRequestId === null ||
    claimUrl === null ||
    pollSecret === null ||
    typeof expiresIn !== "number" ||
    !Number.isFinite(expiresIn) ||
    expiresIn <= 0
  ) {
    throw new CliError(SIGN_IN_START_FAILURE, 1);
  }
  return {
    claimRequestId,
    claimUrl,
    pollSecret,
    expiresInSeconds: Math.min(expiresIn, MAX_EXPIRES_IN_SECONDS),
  };
}

export interface PollCredentials {
  claimRequestId: string;
  pollSecret: string;
}

export type PollResult =
  | { kind: "pending" }
  | { kind: "approved"; appToken: string }
  | { kind: "gone" }
  // A momentary server or network hiccup; the caller keeps polling until the
  // claim expires.
  | { kind: "transient" };

export async function pollClaimRequest(
  baseUrl: string,
  credentials: PollCredentials,
): Promise<PollResult> {
  let response: Response;
  try {
    response = await fetch(`${baseUrl}/app-tokens/claim-requests/poll`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        claim_request_id: credentials.claimRequestId,
        poll_secret: credentials.pollSecret,
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      // Same as the create call: a redirect must never carry the poll secret
      // (or accept a token from) another origin.
      redirect: "error",
    });
  } catch {
    return { kind: "transient" };
  }
  const body = await readJsonBody(response);
  const record = asRecord(body);

  if (response.status === 404 || response.status === 410) {
    // The claim no longer exists server-side — the same end state as an
    // explicit "gone" answer; retrying the same claim can never succeed.
    return { kind: "gone" };
  }
  if (response.status === 429) {
    // Rate limiting from an edge layer is momentary; the poll loop's own
    // interval is the backoff.
    return { kind: "transient" };
  }
  if (response.status >= 400 && response.status < 500) {
    // A 4xx (invalid_poll_request and friends) means our request is wrong —
    // a bug, not something a retry can fix — so fail now instead of polling
    // uselessly until the claim expires.
    throw new CliError(errorDescription(body) ?? SIGN_IN_FINISH_FAILURE, 1);
  }
  if (response.status !== 200) {
    return { kind: "transient" };
  }
  switch (record?.status) {
    case "pending":
      return { kind: "pending" };
    case "approved": {
      const appToken = stringField(record, "app_token");
      if (appToken === null) {
        throw new CliError(SIGN_IN_FINISH_FAILURE, 1);
      }
      return { kind: "approved", appToken };
    }
    case "gone":
      return { kind: "gone" };
    default:
      return { kind: "transient" };
  }
}

async function readJsonBody(response: Response): Promise<unknown> {
  let text: string;
  try {
    text = await response.text();
  } catch {
    return null;
  }
  if (text.length > MAX_RESPONSE_BODY_CHARS) {
    return null;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function stringField(record: Record<string, unknown> | null, field: string): string | null {
  const value = record?.[field];
  return typeof value === "string" && value !== "" ? value : null;
}

// The server's user-facing error text, stripped of terminal control bytes
// like every other string this CLI did not author, and length-bounded.
function errorDescription(body: unknown): string | null {
  const raw = stringField(asRecord(body), "error_description");
  if (raw === null) {
    return null;
  }
  return sanitizeForTerminal(raw.slice(0, MAX_ERROR_DESCRIPTION_CHARS));
}
