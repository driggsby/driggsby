// driggsby login: sign in with PKCE. The CLI keeps a verifier, listens on
// its loopback when it can, and opens Driggsby's approval page itself.
// Approving there hands the one-time code to this CLI's loopback;
// approving from any other browser shows the code, to paste here or to
// finish with `driggsby login --code <CODE>`. Only the code and the
// verifier together mint the token, which goes straight into the
// credential store and is shown to no one.
import { createInterface } from "node:readline";

import { apiBaseUrl, apiHost, baseUrlMayReceiveSavedSignIn } from "../api/base-url.ts";
import { blockedNetworkError } from "../api/network-error.ts";
import { CliError } from "../cli-error.ts";
import { describeDevice } from "../device.ts";
import {
  type CredentialEnvironment,
  type CredentialSource,
  defaultCredentialEnvironment,
  describeStorageLocation,
  environmentToken,
  saveToken,
} from "../credentials/store.ts";
import { sanitizeForTerminal, wrapProse } from "../terminal-text.ts";
import { awaitToken, CODE_WINDOW_MS, type CodePrompt, LOGIN_RETRY_COMMAND, tradeWithRetries } from "./await-token.ts";
import { type ClaimPkce, type ClaimRequest, createClaimRequest, SIGN_IN_START_FAILURE } from "./claim-client.ts";
import { type Loopback, startLoopback } from "./loopback.ts";
import { tryOpenUrl } from "./open-url.ts";
import { clearPendingLogin, type PendingLogin, readPendingLogin, savePendingLogin } from "./pending.ts";
import { createPkcePair } from "./pkce.ts";

const DEFAULT_POLL_INTERVAL_MS = 4_000;
const CODE_COMMAND = "npx driggsby@latest login --code <CODE>";

// The side-effect surface runLogin talks to, injectable so the whole flow is
// testable against a fake consent server with an instant clock.
export interface LoginIo {
  out: (text: string) => void;
  openUrl: (url: string) => Promise<boolean>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  pollIntervalMs: number;
  startLoopback: () => Promise<Loopback | null>;
  // A prompt for a pasted code, or null when there is no terminal to ask
  // (an agent running the command).
  codePrompt: () => CodePrompt | null;
}

function defaultLoginIo(): LoginIo {
  return {
    out: (text) => {
      process.stdout.write(text);
    },
    openUrl: tryOpenUrl,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => Date.now(),
    pollIntervalMs: DEFAULT_POLL_INTERVAL_MS,
    startLoopback,
    codePrompt: terminalCodePrompt,
  };
}

export async function runLogin(
  environment: CredentialEnvironment = defaultCredentialEnvironment(),
  io: LoginIo = defaultLoginIo(),
): Promise<void> {
  const baseUrl = apiBaseUrl(environment.env);

  io.out("Sign in to Driggsby\n\n");

  const pkce = createPkcePair();
  const loopback = await io.startLoopback();
  let prompt: CodePrompt | null = null;
  try {
    const claim = await createClaim(baseUrl, { challenge: pkce.challenge, redirectUri: loopback?.redirectUri ?? null });
    const claimUrl = approvedClaimUrl(claim.claimUrl, baseUrl);
    const expiresAt = io.now() + claim.expiresInSeconds * 1_000;
    const remembered = await rememberPendingLogin(environment, {
      baseUrl,
      claimRequestId: claim.claimRequestId,
      claimUrl,
      codeVerifier: pkce.verifier,
      expiresAt: expiresAt + CODE_WINDOW_MS,
    });

    // Only a page this CLI opened itself may hand its code to the
    // loopback; the printed link, opened anywhere, shows the code instead.
    const browserOpened = await io.openUrl(loopback === null ? claimUrl : handoffUrl(claimUrl));
    prompt = io.codePrompt();
    const minutes = approximateMinutes(claim.expiresInSeconds);
    const minutesWord = minutes === 1 ? "minute" : "minutes";
    if (!browserOpened && prompt === null) {
      // No browser here and no one at a prompt: an agent. It passes the
      // link on, and finishes with the code the page shows.
      io.out("Open this link in your browser to approve access for this machine:\n\n");
      io.out(`  ${claimUrl}\n\n`);
      io.out(`After you approve, the page shows a code. Finish signing in with:\n  ${CODE_COMMAND}\n\n`);
      io.out(`The link is good for about ${minutes} ${minutesWord}.\n`);
      return;
    }
    io.out(
      browserOpened
        ? "Your browser should open a Driggsby approval page. If it doesn't, open\nthis link:\n\n"
        : "Open this link in your browser to approve access for this machine:\n\n",
    );
    io.out(`  ${claimUrl}\n\n`);
    io.out(`Waiting for your approval (the link is good for about ${minutes} ${minutesWord})...\n`);
    if (prompt === null) {
      io.out(`If the page shows a code instead, finish with:\n  ${CODE_COMMAND}\n`);
    }

    const appToken = await awaitTokenOrElsewhere(
      awaitToken(
        {
          baseUrl,
          claimRequestId: claim.claimRequestId,
          pollSecret: claim.pollSecret,
          codeVerifier: pkce.verifier,
          deadline: expiresAt,
          landingUrl: claimUrl,
          loopback,
          prompt,
          promptQuestion: "If the page shows a code instead, paste it here: ",
        },
        io,
      ),
      remembered,
      environment,
      io,
    );
    if (appToken === null) {
      return;
    }
    prompt?.close();
    prompt = null;
    await finishSignIn(appToken, environment, io);
  } finally {
    prompt?.close();
    loopback?.close();
  }
}

// driggsby login --code <CODE>: finish the sign-in waiting on this computer
// with the code its approval page showed.
export async function runLoginWithCode(
  code: string,
  environment: CredentialEnvironment = defaultCredentialEnvironment(),
  io: LoginIo = defaultLoginIo(),
): Promise<void> {
  const baseUrl = apiBaseUrl(environment.env);
  const pending = await readPendingLogin(environment.homeDirectory, io.now());
  if (pending?.baseUrl !== baseUrl) {
    throw new CliError(
      "No sign-in is waiting for a code on this computer. It may have expired.\n\n" +
        `Start a fresh sign-in:\n  ${LOGIN_RETRY_COMMAND}`,
      1,
    );
  }
  const result = await tradeWithRetries(pending, code.trim(), io);
  if (result.kind !== "approved") {
    throw new CliError(
      `${result.message}\n\nCheck the code and run the command again, or start a fresh sign-in:\n  ${LOGIN_RETRY_COMMAND}`,
      1,
    );
  }
  await finishSignIn(result.appToken, environment, io);
}

async function finishSignIn(appToken: string, environment: CredentialEnvironment, io: LoginIo): Promise<void> {
  // Warnings are held back and printed after the "Approved." line — and when
  // one fires, it replaces the all-clear closer: the last thing the user
  // reads must never contradict a warning they were just shown.
  const warnings: string[] = [];
  const storedIn = await storeApprovedToken(appToken, environment, (text) => warnings.push(text));
  await forgetPendingLogin(environment);
  const envTokenWarning = shadowingEnvTokenWarning(environment);
  if (envTokenWarning !== null) {
    warnings.push(envTokenWarning);
  }

  io.out(
    `\n${wrapProse(`Approved. Your Driggsby app token is now saved in ${describeStorageLocation(storedIn)}.`)}\n`,
  );
  if (warnings.length > 0) {
    io.out(`\n${warnings.join("\n")}`);
    return;
  }
  io.out(
    "\nNext:\n  You're all set — driggsby commands will use this saved token\n  automatically. Deploy an app with npx driggsby@latest deploy.\n",
  );
}

// The record `login --code` finishes from. Best effort: without it, the
// loopback and the prompt still work. True once it is saved.
async function rememberPendingLogin(environment: CredentialEnvironment, pending: PendingLogin): Promise<boolean> {
  try {
    await savePendingLogin(environment.homeDirectory, pending);
    return true;
  } catch {
    // The credential save reports an unwritable home directory itself.
    return false;
  }
}

// The wait's token, or null when `login --code` in another command
// finished this very sign-in meanwhile (it removes the record once the
// token is saved, and Driggsby then reads the claim as gone).
async function awaitTokenOrElsewhere(
  wait: Promise<string>,
  remembered: boolean,
  environment: CredentialEnvironment,
  io: LoginIo,
): Promise<string | null> {
  try {
    return await wait;
  } catch (error) {
    if (remembered && error instanceof CliError && (await readPendingLogin(environment.homeDirectory, 0)) === null) {
      io.out("\nSigned in: this sign-in finished with npx driggsby@latest login --code.\n");
      return null;
    }
    throw error;
  }
}

async function forgetPendingLogin(environment: CredentialEnvironment): Promise<void> {
  try {
    await clearPendingLogin(environment.homeDirectory);
  } catch {
    // It expires on its own.
  }
}

function handoffUrl(claimUrl: string): string {
  const url = new URL(claimUrl);
  url.searchParams.set("handoff", "loopback");
  return url.href;
}

// A readline prompt on a real terminal; null when stdin isn't one. Ctrl-C
// at the prompt ends the command, as it does everywhere else.
function terminalCodePrompt(): CodePrompt | null {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    return null;
  }
  const lines = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  let closed = false;
  lines.on("close", () => {
    closed = true;
  });
  lines.on("SIGINT", () => {
    lines.close();
    process.kill(process.pid, "SIGINT");
  });
  return {
    ask: (question) =>
      closed
        ? Promise.resolve(null)
        : new Promise((resolve) => {
            lines.once("close", () => {
              resolve(null);
            });
            lines.question(question, resolve);
          }),
    close: () => {
      lines.close();
    },
  };
}

// The one-time token is already consumed by the time saving starts, so a
// storage failure must say clearly that a fresh sign-in is needed — never
// the generic "something went wrong".
async function storeApprovedToken(
  appToken: string,
  environment: CredentialEnvironment,
  warn: (text: string) => void,
): Promise<CredentialSource> {
  try {
    return await saveToken(appToken, environment, warn);
  } catch (error) {
    if (error instanceof CliError) {
      throw error;
    }
    throw new CliError(
      "Your sign-in was approved, but we couldn't save the Driggsby app token\n" +
        `on this machine. Please sign in again:\n  ${LOGIN_RETRY_COMMAND}`,
      1,
    );
  }
}

async function createClaim(baseUrl: string, pkce: ClaimPkce): Promise<ClaimRequest> {
  try {
    // This computer's name goes only to Driggsby (or a local run), never
    // to another host a base-URL override names.
    const device = baseUrlMayReceiveSavedSignIn(baseUrl) ? describeDevice() : { name: null, system: null };
    return await createClaimRequest(baseUrl, pkce, device);
  } catch (error) {
    const blocked = blockedNetworkError(error, {
      host: apiHost(baseUrl),
      retryCommand: LOGIN_RETRY_COMMAND,
    });
    if (blocked !== null) {
      throw blocked;
    }
    if (error instanceof CliError) {
      throw error;
    }
    throw new CliError(SIGN_IN_START_FAILURE, 1);
  }
}

// The approval page must live on the origin the CLI is talking to. Anything
// else means a broken or untrustworthy response, and the CLI refuses to
// print or open it. What comes back is the PARSER'S normalized href with
// terminal control bytes stripped — the raw server string is never printed
// or handed to the browser opener.
function approvedClaimUrl(rawClaimUrl: string, baseUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(rawClaimUrl);
  } catch {
    throw new CliError(SIGN_IN_START_FAILURE, 1);
  }
  if (parsed.origin !== new URL(baseUrl).origin) {
    throw new CliError(SIGN_IN_START_FAILURE, 1);
  }
  // URL.origin ignores userinfo, so user:pass@ would pass the origin check
  // while confusing the printed link. Claim URLs never carry credentials.
  if (parsed.username !== "" || parsed.password !== "") {
    throw new CliError(SIGN_IN_START_FAILURE, 1);
  }
  return sanitizeForTerminal(parsed.href);
}

// DRIGGSBY_TOKEN outranks every saved token, so a login that saved one has
// not actually changed which token commands use. The warning joins the same
// held-back channel as storage warnings: after the "Approved." line, in
// place of the all-clear closer.
function shadowingEnvTokenWarning(environment: CredentialEnvironment): string | null {
  if (environmentToken(environment) === null) {
    return null;
  }
  return (
    "Note: DRIGGSBY_TOKEN is set in this environment, and driggsby commands\n" +
    "use it instead of the token saved just now. Unset DRIGGSBY_TOKEN to\n" +
    "switch to the saved token.\n"
  );
}

function approximateMinutes(seconds: number): number {
  return Math.max(1, Math.round(seconds / 60));
}
