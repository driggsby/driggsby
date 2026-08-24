// Shared plumbing for the deploy command family: resolve the saved app token
// and map every failure to one clear, fix-naming message. The deploy package
// signs requests; this layer decides what a person or agent reads when
// something goes wrong.
import { DeployApiError, DeployError } from "@driggsby/deploy";

import { apiBaseUrl, apiHost, baseUrlMayReceiveSavedSignIn } from "../api/base-url.ts";
import { blockedNetworkError } from "../api/network-error.ts";
import { CliError } from "../cli-error.ts";
import {
  type CredentialEnvironment,
  readStoredToken,
} from "../credentials/store.ts";
import { capForTerminal, wrapProse } from "../terminal-text.ts";

const LOGIN_COMMAND = "npx driggsby@latest login";
const MAX_ERROR_DESCRIPTION_CHARS = 300;

// Server-supplied display strings go through capForTerminal (sanitize plus
// a hard length bound) with bounds sized to each string's real contract so
// a legitimate value is never truncated: a slug tops out at 63 characters,
// while the app URL wraps the slug in a scheme and domain
// (https://<slug>.driggsby.dev, up to 84 characters). Anything longer is a
// server bug and gets cut rather than allowed to garble the output.
export const MAX_SERVER_TEXT_CHARS = 80;
export const MAX_SERVER_URL_CHARS = 200;

export interface DeploySession {
  baseUrl: string;
  token: string;
}

export async function requireDeploySession(
  environment: CredentialEnvironment,
): Promise<DeploySession> {
  const baseUrl = apiBaseUrl(environment.env);
  const stored = await readStoredToken(environment);
  if (stored === null) {
    throw new CliError(
      "You're not signed in on this machine yet. Sign in first — it takes\n" +
        `about a minute:\n  ${LOGIN_COMMAND}`,
      1,
    );
  }
  // The saved sign-in unlocks this person's financial data, so it only ever
  // travels to Driggsby itself (plus loopback for local development). A
  // DRIGGSBY_BASE_URL pointing anywhere else must bring its own token via
  // DRIGGSBY_TOKEN (source "env") — without this pin, setting that one
  // environment variable would redirect the saved credential to an
  // arbitrary host.
  if (stored.source !== "env" && !baseUrlMayReceiveSavedSignIn(baseUrl)) {
    throw new CliError(
      wrapProse(
        "Your saved Driggsby sign-in is only ever sent to Driggsby itself (or a local dev server on this machine), and DRIGGSBY_BASE_URL points somewhere else. Unset DRIGGSBY_BASE_URL, or set DRIGGSBY_TOKEN to a token that belongs to that server.",
      ),
      1,
    );
  }
  return { baseUrl, token: stored.token };
}

// Turns any failure from a deploy-family command into the CliError the user
// sees. `retryCommand` names the exact command to run again.
export function deployFailure(error: unknown, baseUrl: string, retryCommand: string): CliError {
  if (error instanceof CliError) {
    return error;
  }
  // A DeployApiError is a real HTTP response from the server, never a
  // connection failure — and its `code` is a server-supplied string, so it
  // could collide with an errno name like ECONNRESET and turn a genuine
  // refusal into firewall advice if blockedNetworkError saw it first.
  if (error instanceof DeployApiError) {
    return apiFailure(error, retryCommand);
  }
  if (error instanceof DeployError) {
    return new CliError(error.message, 1);
  }
  const blocked = blockedNetworkError(error, { host: apiHost(baseUrl), retryCommand });
  if (blocked !== null) {
    return blocked;
  }
  return new CliError(
    `We weren't able to finish this just now. Please try again:\n  ${retryCommand}`,
    1,
  );
}

function apiFailure(error: DeployApiError, retryCommand: string): CliError {
  // A 503's server description talks to the protocol client ("retry the same
  // PUT"), so it gets CLI-authored copy naming the actual re-run instead.
  // The copy stays neutral about what failed: a 503 can come from any
  // endpoint, including ones that upload nothing.
  if (error.status === 503) {
    return new CliError(
      `Driggsby is briefly unavailable just now. Please try again:\n  ${retryCommand}`,
      1,
    );
  }
  if (error.status === 401) {
    return new CliError(
      "Your sign-in on this machine isn't valid anymore. Sign in again:\n" +
        `  ${LOGIN_COMMAND}`,
      1,
    );
  }
  if (error.code === "deploy_scope_required") {
    return new CliError(
      "Your saved sign-in can read your Driggsby data but wasn't approved for\n" +
        `deploys. Sign in again and approve deploy access:\n  ${LOGIN_COMMAND}`,
      1,
    );
  }
  // The server's error_description gets the same treatment as every other
  // string this CLI did not author: stripped of terminal control bytes and
  // length-bounded before it reaches the terminal.
  const description = capForTerminal(error.message, MAX_ERROR_DESCRIPTION_CHARS).trim();
  if (description === "") {
    return new CliError(
      "The Driggsby deploy API refused this request without saying why. Please\ntry again in a minute.",
      1,
    );
  }
  return new CliError(wrapProse(description), 1);
}
