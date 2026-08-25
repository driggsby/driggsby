// The browser entry for the Driggsby SDK. A Driggsby app loads this file
// from its own origin with one tag:
//
//   <script type="module" src="/-/driggsby-sdk.js"></script>
//
// and then reads live data with the one-call surface:
//
//   driggsby.watch('list_accounts', {}, (result) => render(result));
//
// All protocol and security logic lives in sdk-core.ts (unit tested under
// node --test); this entry only binds it to the real window: the
// parent-source check, the ready handshake, reload on new-version, and the
// standalone note when no Driggsby host is embedding the page. This entry
// must stay dependency-free (that one local import only) so it bundles to
// a single self-contained file.
import { PROTOCOL, SdkCore, isLocalAppHostname } from "./sdk-core.ts";

interface DriggsbyApi {
  watch: (
    tool: string,
    params: Record<string, unknown> | null | undefined,
    callback: (result: unknown) => void,
  ) => () => void;
}

declare global {
  interface Window {
    driggsby?: DriggsbyApi;
  }
}

const STANDALONE_NOTE_ATTRIBUTE = "data-driggsby-standalone-note";
// How long we wait for the host's hello before concluding the page was
// opened directly (no embedding host) and showing the note.
const STANDALONE_NOTE_DELAY_MS = 800;

function showStandaloneNote(): void {
  if (document.querySelector(`[${STANDALONE_NOTE_ATTRIBUTE}]`) !== null) return;
  const note = document.createElement("div");
  note.setAttribute(STANDALONE_NOTE_ATTRIBUTE, "");
  // Inline styles on purpose: this element lands inside arbitrary user
  // apps, so it cannot depend on any stylesheet.
  note.style.cssText =
    "position:fixed;left:16px;right:16px;bottom:16px;max-width:480px;margin:0 auto;" +
    "padding:14px 18px;border-radius:12px;background:#1c1c1e;color:#f2f2f4;" +
    "font:14px/1.5 system-ui,sans-serif;box-shadow:0 8px 30px rgba(0,0,0,0.35);z-index:2147483647";
  note.textContent =
    "This dashboard shows your data when you open it from Driggsby. " +
    "Head to your Driggsby console and open it from the Dashboards page.";
  document.body.appendChild(note);
}

function removeStandaloneNote(): void {
  document.querySelector(`[${STANDALONE_NOTE_ATTRIBUTE}]`)?.remove();
}

function whenBodyReady(callback: () => void): void {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", callback, { once: true });
    return;
  }
  callback();
}

const core = new SdkCore((message, targetOrigin) => {
  window.parent.postMessage(message, targetOrigin);
}, {
  // A localhost host origin is only ever legitimate when this app is
  // itself served from a local runtime; the production bundle pins to
  // exactly the Driggsby console origin.
  allowLocalHostOrigins: isLocalAppHostname(window.location.hostname),
});
core.onNewVersion = () => {
  window.location.reload();
};
core.onToolError = (tool, message) => {
  console.error(`Driggsby: the ${tool} call didn't work — ${message}`);
};
// Route sync (zero app code for hash-routed apps): the host remembers the
// app's location — restore what it hands us in the hello, and report every
// later in-page move so refresh and redeploy reloads land on the same page.
// The route lands in the host page's URL, so apps should keep sensitive
// identifiers and amounts out of their hash routes. On host-ready, a hash
// the app already navigated to during boot is reported too (skipped when
// blank — a restore may be about to arrive, and blank must not clear it).
// location.replace, not location.hash: the restore must not push a history
// entry the user never created, or the first browser Back after a deep
// link rewinds the app's route instead of leaving the host page. The
// target is rebuilt absolute so a page's <base href> can't turn the
// fragment change into a real navigation.
core.onHostReady = () => {
  removeStandaloneNote();
  if (window.location.hash !== "") core.reportRoute(window.location.hash);
};
core.onRestoreRoute = (route) => {
  if (window.location.hash === route) return;
  window.location.replace((window.location.href.split("#")[0] ?? "") + route);
};
window.addEventListener("hashchange", () => {
  core.reportRoute(window.location.hash);
});

window.addEventListener("message", (event: MessageEvent) => {
  core.handleMessage(event.origin, event.source === window.parent, event.data);
});

window.driggsby = {
  watch: (tool, params, callback) => core.watch(tool, params, callback),
};

if (window.parent === window) {
  // Opened directly in a tab: no host will ever answer.
  whenBodyReady(showStandaloneNote);
} else {
  // Announce ourselves to whoever embedded us. The ready message carries
  // nothing, so "*" is safe; the host proves itself with a hello from an
  // allowlisted origin before a single call leaves the page.
  window.parent.postMessage({ protocol: PROTOCOL, type: "ready" }, "*");
  window.setTimeout(() => {
    if (!core.hostReady) whenBodyReady(showStandaloneNote);
  }, STANDALONE_NOTE_DELAY_MS);
}
