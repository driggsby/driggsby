// A fake of Driggsby's claim endpoints and of the person approving, for the
// login tests. The server keeps Driggsby's PKCE rule: its token endpoint
// mints only for the approval's one code together with the verifier whose
// S256 challenge the claim carried. The "browser" plays the approval page:
// opened with handoff=loopback, it sends the code (or the denial) to the
// CLI's loopback, as Driggsby's page does.
import { mkdtempSync } from "node:fs";
import { createServer, request, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after } from "node:test";

import { type CredentialEnvironment } from "../credentials/store.ts";
import { type CodePrompt } from "../login/await-token.ts";
import { type LoginIo } from "../login/login.ts";
import { startLoopback } from "../login/loopback.ts";
import { challengeFor } from "../login/pkce.ts";

export const APP_TOKEN = "dgb_at_test_1111";
export const APPROVAL_CODE = "7KQ2M-9XH4T-A0B1C-DEFGH";

export interface FakeConsentServer {
  baseUrl: string;
  pollResponses: { status: number; body: unknown }[];
  claimUrlOrigin: string | null;
  claimUrlPath: string | null;
  // The parsed body of each claim create and each code trade, in order.
  createBodies: Record<string, unknown>[];
  tradeBodies: Record<string, unknown>[];
  // Once set (the person denied, or the code was traded), every poll
  // without a scripted answer reads gone.
  claimGone: boolean;
  // Called as a trade spends the claim; its reply waits until this settles.
  onTradeSpent: (() => Promise<void>) | null;
  // Called each time a poll is answered gone.
  onPollGone: (() => void) | null;
  // Trades answered 503 before any is answered for real.
  tradeFailures: number;
}

const servers: Server[] = [];
after(() => {
  for (const server of servers) {
    server.close();
  }
});

// A fake no request ever reaches (logout needs only its base URL).
export function offlineConsentServer(baseUrl: string): FakeConsentServer {
  return {
    baseUrl,
    pollResponses: [],
    claimUrlOrigin: null,
    claimUrlPath: null,
    createBodies: [],
    tradeBodies: [],
    claimGone: false,
    onTradeSpent: null,
    onPollGone: null,
    tradeFailures: 0,
  };
}

export function startConsentServer(): Promise<FakeConsentServer> {
  const fake = offlineConsentServer("");
  const server = createServer((incoming, response) => {
    let raw = "";
    incoming.setEncoding("utf8");
    incoming.on("data", (chunk: string) => {
      raw += chunk;
    });
    incoming.on("end", () => {
      const body = (raw === "" ? {} : JSON.parse(raw)) as Record<string, unknown>;
      const reply = (status: number, payload: unknown): void => {
        response.writeHead(status, { "Content-Type": "application/json" });
        response.end(JSON.stringify(payload));
      };
      if (incoming.url === "/app-tokens/claim-requests") {
        fake.createBodies.push(body);
        reply(201, {
          claim_request_id: "claim-1",
          claim_url: `${fake.claimUrlOrigin ?? fake.baseUrl}${fake.claimUrlPath ?? "/connect/claim-1"}`,
          poll_secret: "secret-1",
          poll_url: `${fake.baseUrl}/app-tokens/claim-requests/poll`,
          token_url: `${fake.baseUrl}/app-tokens/claim-requests/token`,
          expires_in: 600,
        });
        return;
      }
      if (incoming.url === "/app-tokens/claim-requests/token") {
        if (fake.tradeFailures > 0) {
          fake.tradeFailures -= 1;
          reply(503, { error: "temporarily_unavailable" });
          return;
        }
        fake.tradeBodies.push(body);
        const claim = fake.createBodies.at(-1);
        const verifier = body.code_verifier;
        const codeMatches = typeof body.code === "string" && normalize(body.code) === normalize(APPROVAL_CODE);
        const verifierMatches = typeof verifier === "string" && challengeFor(verifier) === claim?.code_challenge;
        if (codeMatches && verifierMatches && fake.tradeBodies.filter((trade) => trade.code === body.code).length === 1) {
          // The claim is spent the moment the trade lands, as on Driggsby.
          fake.claimGone = true;
          void (fake.onTradeSpent?.() ?? Promise.resolve()).then(() => {
            reply(200, { app_token: APP_TOKEN, mcp_url: `${fake.baseUrl}/mcp` });
          });
        } else {
          reply(400, { error: "invalid_grant", error_description: "That sign-in code didn't work." });
        }
        return;
      }
      const next = fake.pollResponses.shift() ?? { status: 200, body: { status: fake.claimGone ? "gone" : "pending" } };
      reply(next.status, next.body);
      if ((next.body as { status?: unknown } | null)?.status === "gone") {
        fake.onPollGone?.();
      }
    });
  });
  servers.push(server);
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        throw new Error("no server address");
      }
      fake.baseUrl = `http://127.0.0.1:${address.port}`;
      resolve(fake);
    });
  });
}

function normalize(code: string): string {
  return code.toUpperCase().replace(/[-\s]/g, "");
}

export interface HarnessOptions {
  extraEnv?: NodeJS.ProcessEnv;
  // What the person does on the page this CLI opens: approve or deny it
  // (reaching the loopback), or nothing; "unavailable" means no browser
  // could be opened at all.
  browser?: "approves" | "denies" | "idle" | "unavailable";
  // Whether this CLI can listen on its loopback.
  loopback?: boolean;
  // Lines typed at the code prompt, or null for no terminal.
  typed?: string[] | null;
  // Callbacks some other page on this computer sends to the loopback
  // first, one after another (query strings).
  knocks?: string[];
  // Awaited as each sleep starts, with its length and the clock's time:
  // a test holds the clock here until another step has happened.
  beforeSleep?: (ms: number, now: number) => Promise<void>;
}

export interface LoginHarness {
  environment: CredentialEnvironment;
  io: LoginIo;
  output: () => string;
  openedUrls: string[];
  questions: string[];
  // Where the approving browser finally landed: the loopback's answer.
  browserLanding: Promise<{ status: number; location: string | undefined }> | null;
}

export function loginHarness(server: FakeConsentServer, options: HarnessOptions = {}): LoginHarness {
  const written: string[] = [];
  const openedUrls: string[] = [];
  const questions: string[] = [];
  let clock = 0;
  const harness: LoginHarness = {
    environment: {
      // win32 forces the file store, which works on every CI platform.
      platform: "win32",
      env: { DRIGGSBY_BASE_URL: server.baseUrl, ...options.extraEnv },
      homeDirectory: mkdtempSync(join(tmpdir(), "driggsby-login-")),
    },
    output: () => written.join(""),
    openedUrls,
    questions,
    browserLanding: null,
    io: {
      out: (text) => written.push(text),
      openUrl: (url) => {
        openedUrls.push(url);
        const browser = options.browser ?? "approves";
        if (browser === "unavailable") {
          return Promise.resolve(false);
        }
        const redirectUri = server.createBodies.at(-1)?.redirect_uri;
        if (browser !== "idle" && new URL(url).searchParams.get("handoff") === "loopback" && typeof redirectUri === "string") {
          const query = browser === "approves" ? `code=${APPROVAL_CODE}` : "error=access_denied";
          harness.browserLanding = (async () => {
            for (const knock of options.knocks ?? []) {
              await visit(`${redirectUri}?${knock}`);
            }
            if (browser === "denies") {
              server.claimGone = true;
            }
            return visit(`${redirectUri}?${query}`);
          })();
        }
        return Promise.resolve(true);
      },
      // The clock jumps, and real time passes a little, so the loopback and
      // the prompt get their turn beside the poll.
      sleep: async (ms, signal) => {
        if (signal?.aborted === true) {
          return;
        }
        await options.beforeSleep?.(ms, clock);
        clock += ms;
        await new Promise((resolve) => setTimeout(resolve, 2));
      },
      now: () => clock,
      pollIntervalMs: 4000,
      startLoopback: () => ((options.loopback ?? true) ? startLoopback() : Promise.resolve(null)),
      codePrompt: () => (options.typed === undefined || options.typed === null ? null : typedPrompt(options.typed, questions)),
    },
  };
  return harness;
}

// A browser (or any page on this computer) requesting url.
export function visit(url: string): Promise<{ status: number; location: string | undefined }> {
  return new Promise((resolve, reject) => {
    const outgoing = request(url, (response) => {
      response.resume();
      response.on("end", () => {
        resolve({ status: response.statusCode ?? 0, location: response.headers.location });
      });
    });
    outgoing.on("error", reject);
    outgoing.end();
  });
}

// A person at the prompt who types these lines, then nothing more.
function typedPrompt(lines: string[], questions: string[]): CodePrompt {
  const remaining = [...lines];
  let release: (value: string | null) => void = () => undefined;
  return {
    ask: (question) => {
      questions.push(question);
      const next = remaining.shift();
      if (next !== undefined) {
        return new Promise((resolve) => {
          setTimeout(() => {
            resolve(next);
          }, 5);
        });
      }
      return new Promise((resolve) => {
        release = resolve;
      });
    },
    close: () => {
      release(null);
    },
  };
}
