// The Driggsby SDK protocol core. A Driggsby app loads the SDK on its own
// origin and talks to the embedding Driggsby host page over postMessage,
// speaking the frozen driggsby-sdk/1 protocol. This module is pure protocol
// state — no DOM, no window — so `node --test` can exercise the
// security-sensitive parts directly: the host-origin allowlist, the
// first-valid-hello pin, and the parent-source requirement.
//
// The whole public surface an app sees is:
//   driggsby.watch(tool, params, callback) -> unsubscribe()
// Every read is a live subscription: the host announces "data-changed" and
// each watch re-runs; results are deduped by JSON identity so unchanged
// data never re-renders.
//
// The production copy of this runtime is the one Driggsby serves to every
// deployed app at /-/driggsby-sdk.js on the app's own origin; that copy is
// canonical. This package carries the same runtime so `driggsby dev` can
// serve it locally, and so bundler users can import the types. Protocol v1
// is frozen — the contract tests beside this file pin the exact wire
// messages, and the protocol version string is the drift tripwire.

export const PROTOCOL = "driggsby-sdk/1";

// Generous ceiling on concurrent subscriptions per app; a real dashboard
// uses a handful.
export const MAX_WATCHES = 32;

// The only hosts allowed to drive an embedded app: the Driggsby console,
// or — ONLY when the SDK itself is being served from a local runtime — a
// local-dev host page. Never learned from the first message — a hello from
// anywhere else is ignored. The local branch is gated on the app's own
// hostname so the production bundle pins to exactly one possible host
// origin.
const EXACT_ALLOWED_HOST_ORIGINS = new Set(["https://app.driggsby.com"]);
const LOCAL_HOST_ORIGIN_PATTERN = /^http:\/\/(localhost|127\.0\.0\.1)(:\d{1,5})?$/;
const LOCAL_APP_HOSTNAME_PATTERN = /^(localhost|127\.0\.0\.1|.+\.localhost)$/;

export function isLocalAppHostname(hostname: string): boolean {
  return LOCAL_APP_HOSTNAME_PATTERN.test(hostname);
}

export function isAllowedHostOrigin(origin: string, allowLocalHostOrigins: boolean): boolean {
  if (EXACT_ALLOWED_HOST_ORIGINS.has(origin)) return true;
  return allowLocalHostOrigins && LOCAL_HOST_ORIGIN_PATTERN.test(origin);
}

export type WatchCallback = (result: unknown) => void;
export type PostFunction = (message: Record<string, unknown>, targetOrigin: string) => void;

// The app's in-page location, as a URL fragment. The host mirrors it into
// its own page URL (so refresh and shared links restore it) and hands it
// back in the hello after a reload. The shape is deliberately narrow — a
// short, boring hash — and must stay identical to the host's sanitizer;
// anything else normalizes to ''.
const APP_ROUTE_PATTERN = /^#[A-Za-z0-9/\-._]{1,256}$/;

export function sanitizeAppRoute(value: unknown): string {
  return typeof value === "string" && APP_ROUTE_PATTERN.test(value) ? value : "";
}

interface WatchEntry {
  tool: string;
  params: Record<string, unknown>;
  callback: WatchCallback;
  // JSON of the last delivery (result or error), for dedupe.
  lastDeliveredJson: string | null;
}

interface ProtocolMessage {
  type: string;
  id: string | null;
  result: unknown;
  errorMessage: string | null;
  route: string;
}

// Untrusted wire data -> a normalized message, or null when it is not ours.
function parseProtocolMessage(data: unknown): ProtocolMessage | null {
  if (typeof data !== "object" || data === null) return null;
  const record = data as Record<string, unknown>;
  if (record.protocol !== PROTOCOL) return null;
  const type = record.type;
  if (typeof type !== "string") return null;

  let errorMessage: string | null = null;
  const error = record.error;
  if (typeof error === "object" && error !== null) {
    const message = (error as Record<string, unknown>).message;
    errorMessage = typeof message === "string" ? message : "Something went wrong running this tool.";
  }

  return {
    type,
    id: typeof record.id === "string" ? record.id : null,
    result: record.result,
    errorMessage,
    route: sanitizeAppRoute(record.route),
  };
}

export class SdkCore {
  // Wired by the page entry: remove the standalone note, log tool errors,
  // reload on a new deployed version, restore the host-remembered route.
  onHostReady: (() => void) | null = null;
  onToolError: ((tool: string, message: string) => void) | null = null;
  onNewVersion: (() => void) | null = null;
  onRestoreRoute: ((route: string) => void) | null = null;

  private readonly post: PostFunction;
  private readonly allowLocalHostOrigins: boolean;
  private hostOrigin: string | null = null;
  private readonly watches = new Map<string, WatchEntry>();
  private sequence = 0;

  constructor(post: PostFunction, options: { allowLocalHostOrigins?: boolean } = {}) {
    this.post = post;
    this.allowLocalHostOrigins = options.allowLocalHostOrigins ?? false;
  }

  get hostReady(): boolean {
    return this.hostOrigin !== null;
  }

  // params is typed loose on purpose: app authors call this from untyped
  // JavaScript, and a null/omitted params should mean "no params", not a
  // crash.
  watch(tool: string, params: Record<string, unknown> | null | undefined, callback: WatchCallback): () => void {
    // Watches are registered by arbitrary app code; a watch() call that
    // leaked into a render loop would otherwise grow forever and turn
    // every data-changed into an unbounded fan-out of real tool calls.
    // Past the cap: report it and hand back a no-op unsubscribe.
    if (this.watches.size >= MAX_WATCHES) {
      this.onToolError?.(tool, `Watch limit reached (${String(MAX_WATCHES)}); this watch will not receive data. Unsubscribe watches you no longer need.`);
      return () => undefined;
    }
    this.sequence += 1;
    const id = `w${this.sequence}`;
    this.watches.set(id, { tool, params: params ?? {}, callback, lastDeliveredJson: null });
    // Before the host pins, requestWatch posts nothing; the pinning hello
    // fires every registered watch, so pre-hello watches are simply held.
    this.requestWatch(id);
    return () => {
      this.watches.delete(id);
    };
  }

  // fromParent must be the caller's verification that the browser event's
  // source is the actual parent window (event.source === window.parent) —
  // origin alone is not enough, because a sibling frame on an allowed
  // origin could otherwise speak for the host.
  handleMessage(origin: string, fromParent: boolean, data: unknown): void {
    if (!fromParent) return;
    const message = parseProtocolMessage(data);
    if (message === null) return;

    if (message.type === "hello") {
      this.handleHello(origin, message.route);
      return;
    }
    // Everything after the handshake must come from the pinned host origin.
    if (this.hostOrigin === null || origin !== this.hostOrigin) return;

    if (message.type === "result") {
      this.handleResult(message);
    } else if (message.type === "data-changed") {
      this.requestAllWatches();
    } else if (message.type === "new-version") {
      this.onNewVersion?.();
    }
  }

  private handleHello(origin: string, route: string): void {
    if (this.hostOrigin !== null) return; // pinned; later hellos are ignored
    if (!isAllowedHostOrigin(origin, this.allowLocalHostOrigins)) return;
    this.hostOrigin = origin;
    this.onHostReady?.();
    // Restore before the watches fire so the app renders the remembered
    // page (the host page's fragment, or the pre-redeploy location) with
    // its first data, not after it.
    if (route !== "") this.onRestoreRoute?.(route);
    this.requestAllWatches();
  }

  // The app moved to a new in-page location; tell the pinned host so it
  // can mirror the fragment into its own page URL. Anything unmirrorable —
  // an empty hash (the app is back at its no-hash location) or a hash
  // outside the strict shape (a query-bearing route, say) — is reported
  // as the bare-"#" cleared sentinel: the host must forget rather than
  // keep claiming a location the app already left, or a refresh or
  // redeploy reload would yank the user to a stale page. Before the
  // handshake there is nobody to tell.
  reportRoute(hash: string): void {
    if (this.hostOrigin === null) return;
    const route = sanitizeAppRoute(hash) || "#";
    this.post({ protocol: PROTOCOL, type: "route", hash: route }, this.hostOrigin);
  }

  private handleResult(message: ProtocolMessage): void {
    const entry = message.id === null ? undefined : this.watches.get(message.id);
    if (entry === undefined) return;

    if (message.errorMessage !== null) {
      const json = JSON.stringify({ error: message.errorMessage });
      if (json === entry.lastDeliveredJson) return;
      entry.lastDeliveredJson = json;
      this.onToolError?.(entry.tool, message.errorMessage);
      return;
    }

    // Wrapping in an object keeps stringify total: even `result: undefined`
    // serializes (to '{}') instead of returning undefined.
    const json = JSON.stringify({ result: message.result });
    if (json === entry.lastDeliveredJson) return;
    entry.lastDeliveredJson = json;
    entry.callback(message.result);
  }

  private requestAllWatches(): void {
    for (const id of this.watches.keys()) this.requestWatch(id);
  }

  private requestWatch(id: string): void {
    if (this.hostOrigin === null) return;
    const entry = this.watches.get(id);
    if (entry === undefined) return;
    this.post(
      { protocol: PROTOCOL, type: "call", id, tool: entry.tool, params: entry.params },
      this.hostOrigin,
    );
  }
}
