// Where the CLI's own API calls go. DRIGGSBY_BASE_URL is a maintainer/test
// override (pointing e2e runs at a local server); it is deliberately absent
// from public documentation.
import { CliError } from "../cli-error.ts";

const PUBLIC_BASE_URL = "https://app.driggsby.com";

export function apiBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.DRIGGSBY_BASE_URL?.trim();
  if (raw === undefined || raw === "") {
    return PUBLIC_BASE_URL;
  }
  const trimmed = raw.replace(/\/+$/, "");
  let parsed: URL;
  try {
    // Validate eagerly so a broken override fails with one clear message
    // instead of a confusing fetch error later.
    parsed = new URL(trimmed);
  } catch {
    throw new CliError(
      "DRIGGSBY_BASE_URL is set but is not a valid URL. Unset it to use\nhttps://app.driggsby.com.",
      1,
    );
  }
  // The claim exchange carries an app token; it never travels in cleartext.
  // Plain http is allowed only against a local dev server on this machine.
  const isLoopback = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && isLoopback)) {
    throw new CliError(
      "DRIGGSBY_BASE_URL must be an https URL (or http on localhost). Unset it to\nuse https://app.driggsby.com.",
      1,
    );
  }
  return trimmed;
}

export function apiHost(baseUrl: string): string {
  return new URL(baseUrl).host;
}
