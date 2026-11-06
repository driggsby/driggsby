// The replay's "press j": one vote, on the person's own Driggsby account, to
// roll bill negotiation out. Driggsby keeps one vote per person, so pressing
// it again changes nothing. The saved sign-in rides along (requireDeploySession
// has already pinned it to Driggsby itself), and the request never follows a
// redirect.
import { CliError } from "../cli-error.ts";
import { type DeploySession, SIGN_IN_AGAIN_MESSAGE } from "../deploy/api-session.ts";

export const POLL_SLUG = "bill-negotiation";
const CHOICE = "yes";
const VOTE_TIMEOUT_MS = 15_000;

export type VoteOutcome = "voted" | "closed";

export async function castVote(session: DeploySession, fetchImpl: typeof fetch = fetch): Promise<VoteOutcome> {
  // Bare headers on purpose, as for every CLI call: Driggsby refuses anything
  // that looks like a browser call, and Node's fetch adds no Origin of its own.
  const response = await fetchImpl(new URL(`/cli/polls/${POLL_SLUG}/vote`, session.baseUrl), {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.token}` },
    body: JSON.stringify({ choice: CHOICE }),
    redirect: "error",
    signal: AbortSignal.timeout(VOTE_TIMEOUT_MS),
  });
  if (response.ok) return "voted";
  if (response.status === 409) return "closed";
  if (response.status === 401 || response.status === 403) throw new CliError(SIGN_IN_AGAIN_MESSAGE, 1);
  throw new CliError("Driggsby couldn't count your vote just now. Please try again:\n  npx driggsby@latest replay att", 1);
}
