// The single home of the base-URL policy: which origin API requests (and
// the bearer token they carry) may travel to, and what DRIGGSBY_BASE_URL is
// allowed to override it with. The driggsby CLI wraps these exports rather
// than restating them — two copies of this policy would let an edit to one
// silently change where a credential may travel under the other.
import { DeployError } from "./errors.ts";

export const PUBLIC_BASE_URL = "https://app.driggsby.com";

function isLoopbackHostname(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1";
}

// Whether this base URL points at this machine. Plain http — and, in the
// driggsby CLI, the machine's saved sign-in — is acceptable only here (or at
// Driggsby itself). The input must already be a parseable URL.
export function isLoopbackBaseUrl(baseUrl: string): boolean {
  return isLoopbackHostname(new URL(baseUrl).hostname);
}

// Resolves the API origin from the environment. The token travels only over
// https, or plain http to a local dev server on this machine.
export function resolveBaseUrl(env: NodeJS.ProcessEnv): string {
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
    throw new DeployError(
      `DRIGGSBY_BASE_URL is set but is not a valid URL. Unset it to use\n${PUBLIC_BASE_URL}.`,
    );
  }
  if (
    parsed.protocol !== "https:" &&
    !(parsed.protocol === "http:" && isLoopbackHostname(parsed.hostname))
  ) {
    throw new DeployError(
      `DRIGGSBY_BASE_URL must be an https URL (or http on localhost). Unset it\nto use ${PUBLIC_BASE_URL}.`,
    );
  }
  // API paths are appended to this value directly, so a query or fragment
  // would end up in the middle of every request path. Checked on the raw
  // string, not URL.search/.hash — a bare trailing "?" or "#" parses to an
  // empty search/hash yet still corrupts every appended path.
  if (trimmed.includes("?") || trimmed.includes("#")) {
    throw new DeployError(
      `DRIGGSBY_BASE_URL can't include a query or fragment. Unset it to use\n${PUBLIC_BASE_URL}.`,
    );
  }
  return trimmed;
}

// The Driggsby page address the server hands back after a deploy is printed
// first and unquoted, as this tool's own word on where to go, so it is
// accepted only on the origin this run is signed in to: an answer naming any
// other host (a lookalike included) yields null, and the caller prints the
// app's own address alone. Anything that does not parse as a URL, or that
// carries userinfo (which reads as a different host), is no address either.
// What comes back is the parsed href, so control bytes in a path arrive
// percent-encoded rather than raw.
export function consoleUrlOnOrigin(consoleUrl: string | null, baseUrl: string): string | null {
  if (consoleUrl === null) {
    return null;
  }
  try {
    const parsed = new URL(consoleUrl);
    if (parsed.username !== "" || parsed.password !== "") {
      return null;
    }
    return parsed.origin === new URL(baseUrl).origin ? parsed.href : null;
  } catch {
    return null;
  }
}
