// Where the CLI's own API calls go. DRIGGSBY_BASE_URL is a maintainer/test
// override (pointing e2e runs at a local server); it is deliberately absent
// from public documentation. The policy itself — which URLs are acceptable,
// and which may receive credentials — lives once, in @driggsby/deploy's
// base-url module; this file only maps its failures to this CLI's error
// type.
import { DeployError, isLoopbackBaseUrl, PUBLIC_BASE_URL, resolveBaseUrl } from "@driggsby/deploy";

import { CliError } from "../cli-error.ts";

export function apiBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  try {
    return resolveBaseUrl(env);
  } catch (error) {
    if (error instanceof DeployError) {
      throw new CliError(error.message, 1);
    }
    throw error;
  }
}

export function apiHost(baseUrl: string): string {
  return new URL(baseUrl).host;
}

// Whether the machine's SAVED sign-in (keychain/keyring/credentials file)
// may be sent to this base URL: Driggsby itself, or a dev server on this
// machine. Any other DRIGGSBY_BASE_URL must bring its own token via
// DRIGGSBY_TOKEN — otherwise setting a single environment variable (a
// .envrc in a cloned repo is enough) would redirect the saved credential,
// which unlocks the person's financial data, to an arbitrary host.
export function baseUrlMayReceiveSavedSignIn(baseUrl: string): boolean {
  return baseUrl === PUBLIC_BASE_URL || isLoopbackBaseUrl(baseUrl);
}
