// The addresses printed under a "Live ... at:" line, by the driggsby CLI
// and by this package's own bin alike. The Driggsby page for the app comes
// first: that is where the person sees it running with their own data. The
// app's own origin follows, named for what it is, because the app gets no
// Driggsby data when opened there. Both are server-supplied strings,
// sanitized and length-bounded before printing. A server that predates
// the Driggsby page hands back only the app's own address, which then
// prints alone, as it always did.
import { consoleUrlOnOrigin } from "./base-url.ts";
import { capForTerminal, wrapProse } from "./terminal-text.ts";

// Longer than any address Driggsby issues (a slug tops out at 63
// characters), short enough that a hostile answer cannot flood the terminal.
export const MAX_LIVE_ADDRESS_CHARS = 200;

export interface LiveAddresses {
  url: string | null;
  consoleUrl: string | null;
}

// The Driggsby page is accepted only on the origin this run is signed in
// to (see consoleUrlOnOrigin). Both values are sanitized here, so what is
// decided on is exactly what prints; a value that sanitizes to nothing is
// no address.
export function liveAddresses(url: string | null, consoleUrl: string | null, baseUrl: string): LiveAddresses {
  return { url: printable(url), consoleUrl: printable(consoleUrlOnOrigin(consoleUrl, baseUrl)) };
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
  let text = `\n  ${primary}\n`;
  if (addresses.consoleUrl !== null && addresses.url !== null) {
    text +=
      `\n${wrapProse("The app's own address, which shows no Driggsby data when opened directly:")}\n\n` +
      `  ${addresses.url}\n`;
  }
  return text;
}

function printable(value: string | null): string | null {
  if (value === null) {
    return null;
  }
  const clean = capForTerminal(value, MAX_LIVE_ADDRESS_CHARS).trim();
  return clean === "" ? null : clean;
}
