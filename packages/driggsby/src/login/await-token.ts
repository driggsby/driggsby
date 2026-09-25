// The wait inside driggsby login, once the approval page is in front of the
// person: the first of the loopback's code, a pasted code, or the claim
// going away (declined or expired) ends it. Every code is traded with the
// verifier; only that trade returns the token.
import { CliError } from "../cli-error.ts";
import { pollClaimRequest, tradeCode } from "./claim-client.ts";
import { type LoopbackCallback } from "./loopback.ts";

export const LOGIN_RETRY_COMMAND = "npx driggsby@latest login";
// A trade that hits a momentary hiccup is tried again this many times.
const TRADE_ATTEMPTS = 3;
const TRADE_RETRY_MS = 2_000;

export interface CodePrompt {
  // The next line typed, or null once the input has ended.
  ask: (question: string) => Promise<string | null>;
  close: () => void;
}

export interface WaitingSignIn {
  baseUrl: string;
  claimRequestId: string;
  pollSecret: string;
  codeVerifier: string;
  deadline: number;
  // The loopback's callback and how to send its browser on, or null when
  // this CLI isn't listening.
  loopback: { callback: Promise<LoopbackCallback>; finish: () => void } | null;
  prompt: CodePrompt | null;
  promptQuestion: string;
}

export interface WaitClock {
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  pollIntervalMs: number;
  out: (text: string) => void;
}

type Outcome = { kind: "token"; appToken: string } | { kind: "error"; error: CliError };

export async function awaitToken(sign: WaitingSignIn, clock: WaitClock): Promise<string> {
  const stop = new AbortController();
  try {
    const outcome = await Promise.race([
      fromLoopback(sign, clock),
      fromPaste(sign, clock, stop.signal),
      fromPoll(sign, clock, stop.signal),
    ]);
    if (outcome.kind === "error") {
      throw outcome.error;
    }
    return outcome.appToken;
  } finally {
    stop.abort();
  }
}

// The browser on this computer handed over the code (or Driggsby's
// denial). The browser waits on the loopback until the trade is done, so it
// lands on a page that already says how it went.
async function fromLoopback(sign: WaitingSignIn, clock: WaitClock): Promise<Outcome> {
  if (sign.loopback === null) {
    return never();
  }
  const callback = await sign.loopback.callback;
  if (callback.kind === "denied") {
    sign.loopback.finish();
    return { kind: "error", error: declined() };
  }
  const result = await tradeWithRetries(sign, callback.code, clock);
  sign.loopback.finish();
  if (result.kind === "approved") {
    return { kind: "token", appToken: result.appToken };
  }
  return { kind: "error", error: new CliError(`${result.message}\n\nStart a fresh sign-in:\n  ${LOGIN_RETRY_COMMAND}`, 1) };
}

// A code pasted at the prompt. A refused code asks again, so a typo costs
// nothing; the claim's own expiry still ends the wait.
async function fromPaste(sign: WaitingSignIn, clock: WaitClock, signal: AbortSignal): Promise<Outcome> {
  if (sign.prompt === null) {
    return never();
  }
  let question = sign.promptQuestion;
  for (;;) {
    const line = await sign.prompt.ask(question);
    if (signal.aborted || line === null) {
      return never();
    }
    if (line.trim() === "") {
      continue;
    }
    const result = await tradeWithRetries(sign, line.trim(), clock);
    if (stopped(signal)) {
      return never();
    }
    if (result.kind === "approved") {
      return { kind: "token", appToken: result.appToken };
    }
    question = `${result.message}\nCheck the code and paste it again: `;
  }
}

// The claim's own state: declined or expired ends the wait. Driggsby never
// hands a PKCE claim's token to the poll; a server that did (one older than
// PKCE) is still handing it to the CLI that made the claim, so it counts.
async function fromPoll(sign: WaitingSignIn, clock: WaitClock, signal: AbortSignal): Promise<Outcome> {
  const credentials = { claimRequestId: sign.claimRequestId, pollSecret: sign.pollSecret };
  while (clock.now() < sign.deadline) {
    await clock.sleep(clock.pollIntervalMs);
    if (signal.aborted) {
      return never();
    }
    const result = await pollClaimRequest(sign.baseUrl, credentials);
    if (stopped(signal)) {
      return never();
    }
    if (result.kind === "approved") {
      return { kind: "token", appToken: result.appToken };
    }
    if (result.kind === "gone") {
      return {
        kind: "error",
        error: new CliError(
          "This sign-in link is no longer active — it may have been declined or timed out.\n\n" +
            `Start a fresh sign-in:\n  ${LOGIN_RETRY_COMMAND}`,
          1,
        ),
      };
    }
  }
  return {
    kind: "error",
    error: new CliError(`The sign-in link expired before it was approved.\n\nStart a fresh sign-in:\n  ${LOGIN_RETRY_COMMAND}`, 1),
  };
}

type TradeOutcome = { kind: "approved"; appToken: string } | { kind: "rejected"; message: string };

export async function tradeWithRetries(
  sign: Pick<WaitingSignIn, "baseUrl" | "claimRequestId" | "codeVerifier">,
  code: string,
  clock: Pick<WaitClock, "sleep">,
): Promise<TradeOutcome> {
  for (let attempt = 1; ; attempt += 1) {
    const result = await tradeCode(sign.baseUrl, {
      claimRequestId: sign.claimRequestId,
      code,
      codeVerifier: sign.codeVerifier,
    });
    if (result.kind !== "transient") {
      return result;
    }
    if (attempt >= TRADE_ATTEMPTS) {
      return {
        kind: "rejected",
        message: "We couldn't reach Driggsby to finish signing in just now.",
      };
    }
    await clock.sleep(TRADE_RETRY_MS);
  }
}

function declined(): CliError {
  return new CliError(`This sign-in was declined.\n\nStart a fresh sign-in:\n  ${LOGIN_RETRY_COMMAND}`, 1);
}

// Read through a call: the signal flips while this code awaits, which a
// property check narrowed before the await would not see.
function stopped(signal: AbortSignal): boolean {
  return signal.aborted;
}

function never(): Promise<Outcome> {
  return new Promise(() => undefined);
}
