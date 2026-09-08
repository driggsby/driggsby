// The two local servers behind `driggsby dev`, mirroring production's
// topology: the host origin (the page a person opens; serves the host page
// and the CLI's tool-call endpoint) and the app origin (the app's own
// files, plus the Driggsby SDK at /-/driggsby-sdk.js). Both bind loopback
// only. The app token never appears here — the broker callback holds it in
// the CLI process.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import { DEV_IDENTITY_PATH } from "./dev-state.ts";
import { hostPageHtml, HOST_PAGE_JS } from "./host-page.ts";
import { serveStaticFile } from "./static-files.ts";
import { APP_TOOL_ALLOWLIST } from "./tool-allowlist.ts";

// The one wording for "this call didn't happen" cases the app can't fix by
// changing its code (overload, network trouble). Tool-specific refusals get
// their own messages.
export const GENERIC_TOOL_TROUBLE = "We couldn't run that just now. Try again in a moment.";

export const TOOL_NOT_ALLOWED_MESSAGE =
  "That tool isn't available to Driggsby apps. Apps can use read-only tools like get_overview and list_accounts.";

const MAX_TOOL_CALL_BODY_BYTES = 65_536;

export type BrokerResult =
  | { ok: true; result: unknown }
  | { ok: false; error: { message: string } };

export interface DevServerOptions {
  slug: string;
  // The app's declared background from driggsby.json (validated hex, or
  // null): the host page paints it behind the frame like production does.
  background: string | null;
  serveDirectory: string;
  sdkBundle: string;
  runToolCall: (tool: string, argumentsObject: Record<string, unknown>) => Promise<BrokerResult>;
  // Real runs use the fixed dev ports; tests pass 0 for ephemeral ones.
  hostPort: number;
  appPort: number;
}

export interface DevServers {
  hostOrigin: string;
  appOrigin: string;
  hostPort: number;
  appPort: number;
  // Pushes a change event to every connected host page (served files
  // changed; the app should reload).
  notifyChange: () => void;
  // How many host pages hold an open event stream right now; zero means no
  // page is looking at the preview.
  clientCount: () => number;
  close: () => Promise<void>;
}

export async function startDevServers(options: DevServerOptions): Promise<DevServers> {
  // Both origins bind and advertise 127.0.0.1: advertising "localhost"
  // while binding only the IPv4 loopback breaks on machines whose browser
  // resolves localhost to ::1 first.
  let appPortForGuard = 0;
  // Filled in once the host server binds; app responses embed it in their
  // frame-ancestors policy so only the real host page can frame the app.
  let hostOriginForFraming = "";
  const appServer = createServer((request, response) => {
    void handleAppRequest(options, appPortForGuard, hostOriginForFraming, request, response);
  });
  await listenLoopback(appServer, options.appPort);
  const appPort = boundPort(appServer);
  appPortForGuard = appPort;
  const appOrigin = `http://127.0.0.1:${String(appPort)}`;

  const sseClients = new Set<ServerResponse>();
  let hostPort = 0;
  const hostServer = createServer((request, response) => {
    void handleHostRequest(options, hostPort, appOrigin, sseClients, request, response);
  });
  try {
    await listenLoopback(hostServer, options.hostPort);
  } catch (error) {
    // The app server is already listening; a failed host bind must not
    // leave it squatting its port while the command reports failure.
    await closeServer(appServer);
    throw error;
  }
  hostPort = boundPort(hostServer);
  hostOriginForFraming = `http://127.0.0.1:${String(hostPort)}`;

  return {
    hostOrigin: hostOriginForFraming,
    appOrigin,
    hostPort,
    appPort,
    notifyChange: () => {
      for (const client of sseClients) {
        client.write("event: change\ndata: files-changed\n\n");
      }
    },
    clientCount: () => sseClients.size,
    close: async () => {
      for (const client of sseClients) {
        client.end();
      }
      sseClients.clear();
      await Promise.all([closeServer(hostServer), closeServer(appServer)]);
    },
  };
}

// ---------------------------------------------------------------------------
// The app origin: the SDK path, then the project's own files.
// ---------------------------------------------------------------------------

async function handleAppRequest(
  options: DevServerOptions,
  appPort: number,
  hostOrigin: string,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  // Only the real host page may frame the app: without this, any other
  // loopback-served page could embed the app origin, pin itself as the
  // app's host, and feed it fabricated numbers. Until the host server has
  // bound (a startup race measured in milliseconds), nothing may frame it.
  // nosniff keeps the browser honest about the served content types.
  const appHeaders = {
    "Content-Security-Policy": `frame-ancestors ${hostOrigin === "" ? "'none'" : hostOrigin};`,
    "X-Content-Type-Options": "nosniff",
  };
  // Same rebinding guard as the host origin: a page on another site that
  // tricked DNS into pointing here carries its own Host, and fails.
  if (!hostHeaderIsLocal(request.headers.host, appPort)) {
    sendText(response, 403, "text/plain; charset=utf-8", "Forbidden.", appHeaders);
    return;
  }
  const path = requestPath(request);
  if (request.method !== "GET" && request.method !== "HEAD") {
    sendText(response, 405, "text/plain; charset=utf-8", "Method not allowed.", appHeaders);
    return;
  }
  if (path === "/-/driggsby-sdk.js") {
    sendText(response, 200, "text/javascript; charset=utf-8", options.sdkBundle, appHeaders);
    return;
  }
  const file = await serveStaticFile(options.serveDirectory, path);
  if (file === null) {
    sendText(response, 404, "text/plain; charset=utf-8", "Not found.", appHeaders);
    return;
  }
  response.writeHead(file.status, {
    "Content-Type": file.contentType,
    "Cache-Control": "no-store",
    ...appHeaders,
  });
  response.end(file.body);
}

// ---------------------------------------------------------------------------
// The host origin: page, script, change events, tool calls.
// ---------------------------------------------------------------------------

async function handleHostRequest(
  options: DevServerOptions,
  hostPort: number,
  appOrigin: string,
  sseClients: Set<ServerResponse>,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  // Rebinding guard: every host-origin route answers only when the browser
  // thinks it is talking to this local origin. A page on some other site
  // that tricked DNS into pointing here carries its own Host, and fails.
  if (!hostHeaderIsLocal(request.headers.host, hostPort)) {
    sendJson(response, 403, { ok: false, error: { message: "Forbidden." } });
    return;
  }
  const path = requestPath(request);

  if (request.method === "GET" && path === DEV_IDENTITY_PATH) {
    // Lets `dev --stop` (and a colliding `dev`) confirm that the process in
    // ~/.driggsby/dev.json is the one actually serving this port.
    sendJson(response, 200, { pid: process.pid });
    return;
  }
  if (request.method === "GET" && path === "/") {
    sendHostPage(response, hostPageHtml(options.slug, appOrigin, options.background), appOrigin);
    return;
  }
  if (request.method === "GET" && path === "/host.js") {
    sendText(response, 200, "text/javascript; charset=utf-8", HOST_PAGE_JS);
    return;
  }
  if (request.method === "GET" && path === "/events") {
    response.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      Connection: "keep-alive",
    });
    response.write(": connected\n\n");
    sseClients.add(response);
    request.on("close", () => {
      sseClients.delete(response);
    });
    return;
  }
  if (request.method === "POST" && path === "/tool-calls") {
    await handleToolCall(options, hostPort, request, response);
    return;
  }
  sendText(response, 404, "text/plain; charset=utf-8", "Not found.");
  return;
}

async function handleToolCall(
  options: DevServerOptions,
  hostPort: number,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  // Cross-site guard: the browser stamps a page's own origin onto
  // cross-origin POSTs. Only the host page itself (same-origin fetch: no
  // Origin header, or the host origin) may run tools.
  const origin = request.headers.origin;
  if (origin !== undefined && !originIsLocalHost(origin, hostPort)) {
    sendJson(response, 403, { ok: false, error: { message: "Forbidden." } });
    return;
  }
  // Defense in depth for callers that carry no Origin at all: a cross-site
  // "simple" POST (text/plain or form-encoded) never has this content type,
  // and a cross-origin JSON POST triggers a preflight this server never
  // grants (no CORS headers, OPTIONS is a 404). The host page always sends
  // JSON, so nothing legitimate is refused.
  const contentType = request.headers["content-type"] ?? "";
  if (!contentType.toLowerCase().startsWith("application/json")) {
    sendJson(response, 415, { ok: false, error: { message: GENERIC_TOOL_TROUBLE } });
    return;
  }

  const body = await readBody(request, MAX_TOOL_CALL_BODY_BYTES);
  if (body === null) {
    sendJson(response, 413, { ok: false, error: { message: GENERIC_TOOL_TROUBLE } });
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    sendJson(response, 400, { ok: false, error: { message: GENERIC_TOOL_TROUBLE } });
    return;
  }
  const record =
    typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  const tool = record.tool;
  if (typeof tool !== "string" || tool.length === 0 || tool.length > 128) {
    sendJson(response, 400, { ok: false, error: { message: GENERIC_TOOL_TROUBLE } });
    return;
  }
  if (!APP_TOOL_ALLOWLIST.has(tool)) {
    sendJson(response, 200, { ok: false, error: { message: TOOL_NOT_ALLOWED_MESSAGE } });
    return;
  }
  const argumentsObject =
    typeof record.arguments === "object" && record.arguments !== null && !Array.isArray(record.arguments)
      ? (record.arguments as Record<string, unknown>)
      : {};

  const result = await options.runToolCall(tool, argumentsObject);
  sendJson(response, 200, result);
}

// ---------------------------------------------------------------------------
// Small pieces.
// ---------------------------------------------------------------------------

function requestPath(request: IncomingMessage): string {
  const url = request.url ?? "/";
  const queryStart = url.indexOf("?");
  return queryStart === -1 ? url : url.slice(0, queryStart);
}

function hostHeaderIsLocal(host: string | undefined, port: number): boolean {
  return host === `localhost:${String(port)}` || host === `127.0.0.1:${String(port)}`;
}

function originIsLocalHost(origin: string, port: number): boolean {
  return (
    origin === `http://localhost:${String(port)}` || origin === `http://127.0.0.1:${String(port)}`
  );
}

async function readBody(request: IncomingMessage, maxBytes: number): Promise<string | null> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    total += buffer.length;
    if (total > maxBytes) {
      return null;
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function sendText(
  response: ServerResponse,
  status: number,
  contentType: string,
  body: string,
  extraHeaders: Record<string, string> = {},
): void {
  // nosniff on every response from either origin: the served content types
  // are always explicit, so the browser never needs to guess.
  response.writeHead(status, {
    "Content-Type": contentType,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    ...extraHeaders,
  });
  response.end(body);
}

function sendJson(response: ServerResponse, status: number, payload: unknown): void {
  sendText(response, status, "application/json; charset=utf-8", JSON.stringify(payload));
}

function sendHostPage(response: ServerResponse, html: string, appOrigin: string): void {
  response.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy":
      "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; " +
      `connect-src 'self'; frame-src ${appOrigin}; frame-ancestors 'none';`,
  });
  response.end(html);
}

async function listenLoopback(server: Server, port: number): Promise<void> {
  await new Promise<void>((resolvePromise, rejectPromise) => {
    server.once("error", rejectPromise);
    server.listen(port, "127.0.0.1", () => {
      server.removeListener("error", rejectPromise);
      // A server-level error after listening (EMFILE, a connection reset
      // mid-accept) affects one connection; without a handler it would be
      // an unhandled 'error' event that crashes the whole dev session.
      server.on("error", () => undefined);
      resolvePromise();
    });
  });
}

function boundPort(server: Server): number {
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("dev server has no bound port");
  }
  return address.port;
}

async function closeServer(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolvePromise) => {
    server.close(() => {
      resolvePromise();
    });
  });
}
