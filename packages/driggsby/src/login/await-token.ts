// The wait inside driggsby login, once the approval page is in front of the
// person: the first of the loopback's code, a pasted code, or the claim
// going away (declined or expired) ends it. Every code is traded with the
// verifier; only that trade returns the token.
import { CliError } from "../cli-error.ts";
import { pollClaimRequest, tradeCode } from "./claim-client.ts";
import { type LoopbackCallback } from "./loopback.ts";

export const LOGIN_RETRY_COMMAND = "npx driggsby@latest login";
export const CODE_COMMAND = "npx driggsby@latest login --code <CODE>";
// Approving leaves at least this long to trade the code, even past the
// link's own lifetime, so a late approval can still finish.
export const CODE_WINDOW_MS = 300_000;
// Driggsby's codes are four groups of five; a paste longer than this is
// not one (the approval link, say), and is refused here without a trade.
const MAX_CODE_CHARS = 64;
// A trade that hits a momentary hiccup is tried again this many times.
const TRADE_ATTEMPTS = 3;
const TRADE_RETRY_MS = 2_000;
// A code from the loopback is the only copy there is: when Driggsby can't
// be reached, the wait keeps trying it this often until the wait ends.
const LOOPBACK_RETRY_MS = 5_000;
const CODE_SHAPE_REFUSED =
  "That doesn't look like a sign-in code. Copy the code the approval page\nshows.";
const UNREACHABLE =
  "We couldn't reach Driggsby to finish signing in just now.";

// The claim went away: declined, expired, or already spent. Distinct, so
// login can tell it from other failures (another command may have spent it).
export class ClaimGone extends CliError {}

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
  // Where a browser goes back to once its callback is answered: the
  // approval page, which by then says how the sign-in went.
  landingUrl: string;
  // The loopback's callbacks, or null when this CLI isn't listening.
  loopback: { next: () => Promise<LoopbackCallback> } | null;
  prompt: CodePrompt | null;
  promptQuestion: string;
}

export interface WaitClock {
  // Resolves early, and quietly, once signal aborts.
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  now: () => number;
  pollIntervalMs: number;
}

type Outcome = { kind: "token"; appToken: string } | { kind: "error"; error: CliError };

// The trades in flight. The trade that spends the claim makes the poll
// read gone before the trade's own answer arrives; the poll waits for any
// trade in flight so that answer speaks first.
class Trades {
  #inFlight = 0;
  #started = 0;
  #idle: (() => void)[] = [];

  get started(): number {
    return this.#started;
  }

  busy(): boolean {
    return this.#inFlight > 0;
  }

  async run<T>(work: () => Promise<T>): Promise<T> {
    this.#inFlight += 1;
    this.#started += 1;
    try {
      return await work();
    } finally {
      this.#inFlight -= 1;
      if (this.#inFlight === 0) {
        for (const resolve of this.#idle.splice(0)) {
          resolve();
        }
      }
    }
  }

  idle(): Promise<void> {
    return this.#inFlight === 0 ? Promise.resolve() : new Promise((resolve) => this.#idle.push(resolve));
  }
}

export async function awaitToken(sign: WaitingSignIn, clock: WaitClock): Promise<string> {
  const stop = new AbortController();
  const trades = new Trades();
  try {
    const outcome = await Promise.race([
      fromLoopback(sign, clock, trades, stop.signal),
      fromPaste(sign, clock, trades, stop.signal),
      fromPoll(sign, clock, trades, stop.signal),
    ]);
    if (outcome.kind === "error") {
      throw outcome.error;
    }
    return outcome.appToken;
  } finally {
    stop.abort();
  }
}

// A browser on this computer handed over a code, or Driggsby's denial. Its
// request waits on the loopback until the trade is done, so it lands on a
// page that already says how it went. Any page on this computer can reach
// the loopback, so a callback proves nothing by itself: a code that doesn't
// trade is refused without saying where the approval page is, and a denial
// counts only once Driggsby confirms the claim is gone.
async function fromLoopback(sign: WaitingSignIn, clock: WaitClock, trades: Trades, signal: AbortSignal): Promise<Outcome> {
  if (sign.loopback === null) {
    return never();
  }
  for (;;) {
    const callback = await sign.loopback.next();
    if (stopped(signal)) {
      // The sign-in already ended; the page says how.
      callback.answer(sign.landingUrl);
      return never();
    }
    if (callback.kind === "denied") {
      const poll = await pollClaimRequest(sign.baseUrl, { claimRequestId: sign.claimRequestId, pollSecret: sign.pollSecret });
      if (poll.kind === "gone") {
        callback.answer(sign.landingUrl);
        return { kind: "error", error: declined() };
      }
      callback.refuse();
      continue;
    }
    for (;;) {
      const result = await trades.run(() => tradeWithRetries(sign, callback.code, clock, signal));
      if (stopped(signal)) {
        callback.refuse();
        return never();
      }
      if (result.kind === "approved") {
        callback.answer(sign.landingUrl);
        return { kind: "token", appToken: result.appToken };
      }
      if (result.kind === "rejected") {
        callback.refuse();
        break;
      }
      // Unreachable: the code may still work, and it's the only copy.
      await clock.sleep(LOOPBACK_RETRY_MS, signal);
      if (stopped(signal)) {
        return never();
      }
    }
  }
}

// A code pasted at the prompt. A refused code asks again, so a typo costs
// nothing; the claim's own expiry still ends the wait.
async function fromPaste(sign: WaitingSignIn, clock: WaitClock, trades: Trades, signal: AbortSignal): Promise<Outcome> {
  if (sign.prompt === null) {
    return never();
  }
  let question = sign.promptQuestion;
  for (;;) {
    const line = await sign.prompt.ask(question);
    if (stopped(signal) || line === null) {
      return never();
    }
    const code = line.trim();
    if (code === "") {
      continue;
    }
    const result = await trades.run(() => tradeWithRetries(sign, code, clock, signal));
    if (stopped(signal)) {
      return never();
    }
    if (result.kind === "approved") {
      return { kind: "token", appToken: result.appToken };
    }
    question = `${result.message}\nCheck the code and paste it again: `;
  }
}

// The claim's own state: declined or expired ends the wait. An approval
// waiting for its code still polls as pending, so the wait runs past the
// link's lifetime by up to the code window, until Driggsby says it's gone.
// Driggsby never hands a PKCE claim's token to the poll; a server that did
// (one older than PKCE) is still handing it to the CLI that made the claim,
// so it counts.
async function fromPoll(sign: WaitingSignIn, clock: WaitClock, trades: Trades, signal: AbortSignal): Promise<Outcome> {
  const credentials = { claimRequestId: sign.claimRequestId, pollSecret: sign.pollSecret };
  const ceiling = sign.deadline + CODE_WINDOW_MS;
  while (clock.now() < ceiling) {
    await clock.sleep(clock.pollIntervalMs, signal);
    if (stopped(signal)) {
      return never();
    }
    const mark = trades.started;
    const result = await pollClaimRequest(sign.baseUrl, credentials);
    if (stopped(signal)) {
      return never();
    }
    if (result.kind === "approved") {
      return { kind: "token", appToken: result.appToken };
    }
    if (result.kind === "gone") {
      if (trades.busy() || trades.started !== mark) {
        await trades.idle();
        // One more turn, so a trade that won settles the race first.
        await new Promise((resolve) => setTimeout(resolve, 0));
        if (stopped(signal)) {
          return never();
        }
      }
      return {
        kind: "error",
        error: new ClaimGone(
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

// rejected: Driggsby refused the code, or it isn't shaped like one.
// unreachable: the trade never got an answer, so the code may still work.
type TradeOutcome =
  | { kind: "approved"; appToken: string }
  | { kind: "rejected"; message: string }
  | { kind: "unreachable"; message: string };

export async function tradeWithRetries(
  sign: Pick<WaitingSignIn, "baseUrl" | "claimRequestId" | "codeVerifier">,
  code: string,
  clock: Pick<WaitClock, "sleep">,
  signal?: AbortSignal,
): Promise<TradeOutcome> {
  if (code === "" || code.length > MAX_CODE_CHARS) {
    return { kind: "rejected", message: CODE_SHAPE_REFUSED };
  }
  for (let attempt = 1; ; attempt += 1) {
    const result = await tradeCode(sign.baseUrl, {
      claimRequestId: sign.claimRequestId,
      code,
      codeVerifier: sign.codeVerifier,
    });
    if (result.kind !== "transient") {
      return result;
    }
    if (attempt >= TRADE_ATTEMPTS || (signal !== undefined && stopped(signal))) {
      return { kind: "unreachable", message: UNREACHABLE };
    }
    await clock.sleep(TRADE_RETRY_MS, signal);
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
