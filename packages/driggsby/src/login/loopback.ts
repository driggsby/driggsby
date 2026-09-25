// The loopback listener for driggsby login (RFC 8252). When this CLI opens
// Driggsby's approval page itself, approving there sends the browser to
// http://127.0.0.1:<port>/callback with the one-time code (or
// error=access_denied). A browser on any other computer lands on its own
// loopback, where nothing listens, so the code reaches only this machine.
//
// Any page in any browser on this computer can also reach the loopback, so
// a callback proves nothing by itself: the caller trades each code (only
// the approval's real code works with this CLI's verifier) and confirms a
// denial with Driggsby before believing it. Each callback's browser waits
// until the caller answers it, then goes back to the Driggsby page that
// says how the sign-in went.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

export type LoopbackCallback =
  | { kind: "code"; code: string; answer: (landingUrl: string) => void }
  | { kind: "denied"; answer: (landingUrl: string) => void };

export interface Loopback {
  redirectUri: string;
  // The next well-formed callback; answer it to send its browser on.
  next: () => Promise<LoopbackCallback>;
  close: () => void;
}

const HOST = "127.0.0.1";
const CALLBACK_PATH = "/callback";
// Driggsby's codes are four groups of five; anything else is not one.
const CODE_PATTERN = /^[A-Za-z0-9-]{1,64}$/;
// A browser is never left hanging if a callback goes unanswered.
const HELD_RESPONSE_MS = 30_000;
// Callbacks waiting for the caller; more than this is someone knocking.
const MAX_QUEUED = 8;
const HEADERS = { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" };

// null when this environment can't listen on the loopback (a sandbox that
// forbids it): the approval page then shows the code to paste instead.
export function startLoopback(): Promise<Loopback | null> {
  return new Promise((resolve) => {
    const queued: LoopbackCallback[] = [];
    const waiting: ((callback: LoopbackCallback) => void)[] = [];
    const held = new Set<ServerResponse>();
    let port = 0;

    const server = createServer((request, response) => {
      const parsed = readCallback(request, port);
      if (parsed === null || queued.length >= MAX_QUEUED) {
        response.writeHead(404, { ...HEADERS, "Content-Type": "text/plain; charset=utf-8" });
        response.end("Not found\n");
        return;
      }
      held.add(response);
      const timer = setTimeout(() => {
        answer(response, null);
        held.delete(response);
      }, HELD_RESPONSE_MS);
      const reply = (landingUrl: string): void => {
        clearTimeout(timer);
        answer(response, landingUrl);
        held.delete(response);
      };
      const callback: LoopbackCallback =
        parsed.kind === "code" ? { kind: "code", code: parsed.code, answer: reply } : { kind: "denied", answer: reply };
      const taker = waiting.shift();
      if (taker === undefined) {
        queued.push(callback);
      } else {
        taker(callback);
      }
    });

    let stopped = false;
    const stop = (): void => {
      if (stopped) {
        return;
      }
      stopped = true;
      for (const response of held) {
        answer(response, null);
      }
      held.clear();
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
        next: () => {
          const ready = queued.shift();
          return ready === undefined ? new Promise((take) => waiting.push(take)) : Promise.resolve(ready);
        },
        close: stop,
      });
    });
  });
}

type Parsed = { kind: "code"; code: string } | { kind: "denied" };

// Only a GET for /callback, addressed to this very listener (a Host header
// naming anything else is a DNS-rebinding page, not Driggsby's redirect),
// carrying a code or Driggsby's denial. Everything else is ignored.
function readCallback(request: IncomingMessage, port: number): Parsed | null {
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
