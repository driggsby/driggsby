// driggsby login: create an app-token claim, send the user to the approval
// page, poll until they approve, and store the token. The token is shown to
// no one — it goes straight from the poll response into the credential
// store.
import { apiBaseUrl, apiHost } from "../api/base-url.ts";
import { blockedNetworkError } from "../api/network-error.ts";
import { CliError } from "../cli-error.ts";
import {
  type CredentialEnvironment,
  type CredentialSource,
  defaultCredentialEnvironment,
  describeStorageLocation,
  environmentToken,
  saveToken,
} from "../credentials/store.ts";
import { sanitizeForTerminal, wrapProse } from "../terminal-text.ts";
import {
  type ClaimRequest,
  createClaimRequest,
  pollClaimRequest,
  SIGN_IN_START_FAILURE,
} from "./claim-client.ts";
import { tryOpenUrl } from "./open-url.ts";

const LOGIN_RETRY_COMMAND = "npx driggsby@latest login";
const DEFAULT_POLL_INTERVAL_MS = 4_000;

// The side-effect surface runLogin talks to, injectable so the whole flow is
// testable against a fake consent server with an instant clock.
export interface LoginIo {
  out: (text: string) => void;
  openUrl: (url: string) => Promise<boolean>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  pollIntervalMs: number;
}

function defaultLoginIo(): LoginIo {
  return {
    out: (text) => {
      process.stdout.write(text);
    },
    openUrl: tryOpenUrl,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => Date.now(),
    pollIntervalMs: DEFAULT_POLL_INTERVAL_MS,
  };
}

export async function runLogin(
  environment: CredentialEnvironment = defaultCredentialEnvironment(),
  io: LoginIo = defaultLoginIo(),
): Promise<void> {
  const baseUrl = apiBaseUrl(environment.env);

  io.out("Sign in to Driggsby\n\n");

  const claim = await createClaim(baseUrl);
  const claimUrl = approvedClaimUrl(claim.claimUrl, baseUrl);

  const browserOpened = await io.openUrl(claimUrl);
  io.out(
    browserOpened
      ? "Your browser should open a Driggsby approval page. If it doesn't, open\nthis link:\n\n"
      : "Open this link in your browser to approve access for this machine:\n\n",
  );
  io.out(`  ${claimUrl}\n\n`);
  const minutes = approximateMinutes(claim.expiresInSeconds);
  const minutesWord = minutes === 1 ? "minute" : "minutes";
  io.out(`Waiting for your approval (the link is good for about ${minutes} ${minutesWord})...\n`);

  const appToken = await pollUntilApproved(baseUrl, claim, io);
  // Warnings are held back and printed after the "Approved." line — and when
  // one fires, it replaces the all-clear closer: the last thing the user
  // reads must never contradict a warning they were just shown.
  const warnings: string[] = [];
  const storedIn = await storeApprovedToken(appToken, environment, (text) => warnings.push(text));
  const envTokenWarning = shadowingEnvTokenWarning(environment);
  if (envTokenWarning !== null) {
    warnings.push(envTokenWarning);
  }

  io.out(
    `\n${wrapProse(`Approved. Your Driggsby app token is now saved in ${describeStorageLocation(storedIn)}.`)}\n`,
  );
  if (warnings.length > 0) {
    io.out(`\n${warnings.join("\n")}`);
    return;
  }
  io.out(
    "\nNext:\n  You're all set — driggsby commands that need your account will use this\n  saved token automatically.\n",
  );
}

// The one-time token is already consumed by the time saving starts, so a
// storage failure must say clearly that a fresh sign-in is needed — never
// the generic "something went wrong".
async function storeApprovedToken(
  appToken: string,
  environment: CredentialEnvironment,
  warn: (text: string) => void,
): Promise<CredentialSource> {
  try {
    return await saveToken(appToken, environment, warn);
  } catch (error) {
    if (error instanceof CliError) {
      throw error;
    }
    throw new CliError(
      "Your sign-in was approved, but we couldn't save the Driggsby app token\n" +
        `on this machine. Please sign in again:\n  ${LOGIN_RETRY_COMMAND}`,
      1,
    );
  }
}

async function createClaim(baseUrl: string): Promise<ClaimRequest> {
  try {
    return await createClaimRequest(baseUrl);
  } catch (error) {
    const blocked = blockedNetworkError(error, {
      host: apiHost(baseUrl),
      retryCommand: LOGIN_RETRY_COMMAND,
    });
    if (blocked !== null) {
      throw blocked;
    }
    if (error instanceof CliError) {
      throw error;
    }
    throw new CliError(SIGN_IN_START_FAILURE, 1);
  }
}

// The approval page must live on the origin the CLI is talking to. Anything
// else means a broken or untrustworthy response, and the CLI refuses to
// print or open it. What comes back is the PARSER'S normalized href with
// terminal control bytes stripped — the raw server string is never printed
// or handed to the browser opener.
function approvedClaimUrl(rawClaimUrl: string, baseUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(rawClaimUrl);
  } catch {
    throw new CliError(SIGN_IN_START_FAILURE, 1);
  }
  if (parsed.origin !== new URL(baseUrl).origin) {
    throw new CliError(SIGN_IN_START_FAILURE, 1);
  }
  // URL.origin ignores userinfo, so user:pass@ would pass the origin check
  // while confusing the printed link. Claim URLs never carry credentials.
  if (parsed.username !== "" || parsed.password !== "") {
    throw new CliError(SIGN_IN_START_FAILURE, 1);
  }
  return sanitizeForTerminal(parsed.href);
}

async function pollUntilApproved(
  baseUrl: string,
  claim: ClaimRequest,
  io: LoginIo,
): Promise<string> {
  const deadline = io.now() + claim.expiresInSeconds * 1_000;
  const credentials = { claimRequestId: claim.claimRequestId, pollSecret: claim.pollSecret };

  while (io.now() < deadline) {
    await io.sleep(io.pollIntervalMs);
    const result = await pollClaimRequest(baseUrl, credentials);
    switch (result.kind) {
      case "approved":
        // The token is delivered exactly once; from here on, never poll again.
        return result.appToken;
      case "gone":
        throw new CliError(
          "This sign-in link is no longer active — it may have been declined or timed out.\n\n" +
            `Start a fresh sign-in:\n  ${LOGIN_RETRY_COMMAND}`,
          1,
        );
      case "pending":
      case "transient":
        break;
    }
  }
  throw new CliError(
    "The sign-in link expired before it was approved.\n\n" +
      `Start a fresh sign-in:\n  ${LOGIN_RETRY_COMMAND}`,
    1,
  );
}

// DRIGGSBY_TOKEN outranks every saved token, so a login that saved one has
// not actually changed which token commands use. The warning joins the same
// held-back channel as storage warnings: after the "Approved." line, in
// place of the all-clear closer.
function shadowingEnvTokenWarning(environment: CredentialEnvironment): string | null {
  if (environmentToken(environment) === null) {
    return null;
  }
  return (
    "Note: DRIGGSBY_TOKEN is set in this environment, and driggsby commands\n" +
    "use it instead of the token saved just now. Unset DRIGGSBY_TOKEN to\n" +
    "switch to the saved token.\n"
  );
}

function approximateMinutes(seconds: number): number {
  return Math.max(1, Math.round(seconds / 60));
}
