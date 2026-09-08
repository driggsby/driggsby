// The addresses printed under a "✓ Live ... at:" line. The Driggsby page for
// the app comes first: that is where the person sees it running with their
// own data. The app's own origin follows, named for what it is, because the
// app gets no Driggsby data when opened there. Both are server-supplied
// strings, sanitized and length-bounded before printing. A server that
// predates the Driggsby page hands back only the app's own address, which
// then prints alone, as it always did.
import { consoleUrlOnOrigin } from "@driggsby/deploy";

import { MAX_SERVER_URL_CHARS } from "./api-session.ts";
import { capForTerminal, wrapProse } from "../terminal-text.ts";

export interface LiveAddresses {
  url: string | null;
  consoleUrl: string | null;
}

// The Driggsby page is accepted only on the origin this run is signed in
// to (see consoleUrlOnOrigin). Sanitizing happens at print time; a value
// that sanitizes to nothing is no address.
export function liveAddresses(url: string | null, consoleUrl: string | null, baseUrl: string): LiveAddresses {
  return { url: printable(url), consoleUrl: consoleUrlOnOrigin(printable(consoleUrl), baseUrl) };
}

export function hasLiveAddress(addresses: LiveAddresses): boolean {
  return addresses.consoleUrl !== null || addresses.url !== null;
}

// Empty when there is nothing to print, so "at:" is promised only when an
// address follows.
export function liveAddressLines(addresses: LiveAddresses): string {
  const primary = addresses.consoleUrl ?? addresses.url;
  if (primary === null) {
    return "";
  }
  let text = `\n  ${capForTerminal(primary, MAX_SERVER_URL_CHARS)}\n`;
  if (addresses.consoleUrl !== null && addresses.url !== null) {
    text +=
      `\n${wrapProse("The app's own address, which gets no Driggsby data when opened on its own:")}\n\n` +
      `  ${capForTerminal(addresses.url, MAX_SERVER_URL_CHARS)}\n`;
  }
  return text;
}

function printable(value: string | null): string | null {
  return value !== null && capForTerminal(value, MAX_SERVER_URL_CHARS).trim() !== "" ? value : null;
}
