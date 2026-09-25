// The loopback listener for driggsby login (RFC 8252). When this CLI opens
// Driggsby's approval page itself, approving there sends the browser to
// http://127.0.0.1:<port>/callback with the one-time code (or
// error=access_denied). A browser on any other computer lands on its own
// loopback, where nothing listens, so the code reaches only this machine.
// The browser's request is held until the sign-in finishes, then sent back
// to the Driggsby page that says how it went.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

export type LoopbackCallback = { kind: "code"; code: string } | { kind: "denied" };

export interface Loopback {
  redirectUri: string;
  // Resolves once, on the first well-formed callback.
  callback: Promise<LoopbackCallback>;
  // Sends the waiting browser to landingUrl, then stops listening.
  finish: (landingUrl: string) => void;
  close: () => void;
}

const HOST = "127.0.0.1";
const CALLBACK_PATH = "/callback";
// Driggsby's codes are four groups of five; anything else is not one.
const CODE_PATTERN = /^[A-Za-z0-9-]{1,64}$/;
// A browser is never left hanging if the sign-in stalls after its callback.
const HELD_RESPONSE_MS = 30_000;
const HEADERS = { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" };

// null when this environment can't listen on the loopback (a sandbox that
// forbids it): the approval page then shows the code to paste instead.
export function startLoopback(): Promise<Loopback | null> {
  return new Promise((resolve) => {
    let deliver: (value: LoopbackCallback) => void = () => undefined;
    const callback = new Promise<LoopbackCallback>((resolveCallback) => {
      deliver = resolveCallback;
    });
    let port = 0;
    let held: ServerResponse | null = null;
    let heldTimer: NodeJS.Timeout | null = null;
    let received = false;

    const server = createServer((request, response) => {
      const parsed = received ? null : readCallback(request, port);
      if (parsed === null) {
        response.writeHead(404, { ...HEADERS, "Content-Type": "text/plain; charset=utf-8" });
        response.end("Not found\n");
        return;
      }
      received = true;
      held = response;
      heldTimer = setTimeout(() => {
        answer(response, null);
      }, HELD_RESPONSE_MS);
      deliver(parsed);
    });

    let stopped = false;
    const stop = (): void => {
      if (stopped) {
        return;
      }
      stopped = true;
      if (heldTimer !== null) {
        clearTimeout(heldTimer);
      }
      server.close();
      server.closeAllConnections();
    };

    server.once("error", () => {
      resolve(null);
    });
    server.listen(0, HOST, () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        stop();
        resolve(null);
        return;
      }
      port = address.port;
      resolve({
        redirectUri: `http://${HOST}:${port}${CALLBACK_PATH}`,
        callback,
        finish: (landingUrl) => {
          if (held !== null) {
            answer(held, landingUrl);
            held = null;
          }
          stop();
        },
        close: stop,
      });
    });
  });
}

// Only a GET for /callback, addressed to this very listener (a Host header
// naming anything else is a DNS-rebinding page, not Driggsby's redirect),
// carrying a code or Driggsby's denial. Everything else is ignored.
function readCallback(request: IncomingMessage, port: number): LoopbackCallback | null {
  if (request.method !== "GET" || request.headers.host !== `${HOST}:${port}`) {
    return null;
  }
  let url: URL;
  try {
    url = new URL(request.url ?? "", `http://${HOST}:${port}`);
  } catch {
    return null;
  }
  if (url.pathname !== CALLBACK_PATH) {
    return null;
  }
  const code = url.searchParams.get("code");
  if (code !== null && CODE_PATTERN.test(code)) {
    return { kind: "code", code };
  }
  return url.searchParams.get("error") === "access_denied" ? { kind: "denied" } : null;
}

function answer(response: ServerResponse, landingUrl: string | null): void {
  if (response.writableEnded) {
    return;
  }
  if (landingUrl === null) {
    response.writeHead(200, { ...HEADERS, "Content-Type": "text/plain; charset=utf-8" });
    response.end("You can close this tab and go back to your terminal.\n");
    return;
  }
  response.writeHead(303, { ...HEADERS, Location: landingUrl });
  response.end();
}
