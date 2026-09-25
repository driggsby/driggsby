// driggsby login: sign in with PKCE. The CLI keeps a verifier, listens on
// its loopback when it can, and opens Driggsby's approval page itself.
// Approving there hands the one-time code to this CLI's loopback;
// approving from any other browser shows the code, to paste here or to
// finish with `driggsby login --code <CODE>`. Only the code and the
// verifier together mint the token, which goes straight into the
// credential store and is shown to no one.
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
import {
  awaitToken,
  ClaimGone,
  CODE_COMMAND,
  CODE_WINDOW_MS,
  type CodePrompt,
  LOGIN_RETRY_COMMAND,
  tradeWithRetries,
} from "./await-token.ts";
import { type ClaimPkce, type ClaimRequest, createClaimRequest, SIGN_IN_START_FAILURE } from "./claim-client.ts";
import { type Loopback, startLoopback } from "./loopback.ts";
import { tryOpenUrl } from "./open-url.ts";
import {
  clearPendingLogin,
  markPendingLoginFinished,
  type PendingLogin,
  readPendingLogin,
  savePendingLogin,
} from "./pending.ts";
import { createPkcePair } from "./pkce.ts";
import { abortableSleep } from "./sleep.ts";
import { terminalCodePrompt } from "./terminal-prompt.ts";

const DEFAULT_POLL_INTERVAL_MS = 4_000;
// How long a waiting login gives `login --code` to mark a spent claim.
export const FINISH_MARK_WAIT_MS = 3_000;
// Where a browser opened "here" may really run on another computer (an SSH
// session, a cloud dev box forwarding its opener), so its approval could
// never reach this loopback: the page shows the code to paste instead.
const REMOTE_SESSION_VARIABLES = ["SSH_CONNECTION", "SSH_TTY", "CODESPACES", "GITPOD_WORKSPACE_ID"];

// The side-effect surface runLogin talks to, injectable so the whole flow is
// testable against a fake consent server with an instant clock.
export interface LoginIo {
  out: (text: string) => void;
  openUrl: (url: string) => Promise<boolean>;
  // Resolves early, and quietly, once signal aborts, so a finished wait
  // never holds the process open.
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
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
    sleep: abortableSleep,
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
  const remoteSession = REMOTE_SESSION_VARIABLES.some((name) => (environment.env[name] ?? "") !== "");
  const loopback = remoteSession ? null : await io.startLoopback();
  let prompt: CodePrompt | null = null;
  try {
    const claim = await createClaim(baseUrl, { challenge: pkce.challenge, redirectUri: loopback?.redirectUri ?? null });
    const claimUrl = approvedClaimUrl(claim.claimUrl, baseUrl);
    const expiresAt = io.now() + claim.expiresInSeconds * 1_000;
    const pending: PendingLogin = {
      baseUrl,
      claimRequestId: claim.claimRequestId,
      codeVerifier: pkce.verifier,
      expiresAt: expiresAt + CODE_WINDOW_MS,
      finished: false,
    };
    const remembered = await rememberPendingLogin(environment, pending);

    // Only a page this CLI opened itself may hand its code to the
    // loopback; the printed link, opened anywhere, shows the code instead.
    const browserOpened = await io.openUrl(loopback === null ? claimUrl : handoffUrl(claimUrl));
    prompt = io.codePrompt();
    const minutes = approximateMinutes(claim.expiresInSeconds);
    const minutesWord = minutes === 1 ? "minute" : "minutes";
    if (prompt === null && (loopback === null || !browserOpened)) {
      // No one at a prompt, and no page this CLI opened can hand the code
      // to the loopback: an agent, or a remote session. Nothing in this
      // process could ever receive the code, so it doesn't wait: the page
      // shows the code, and `login --code` finishes with the record.
      if (!remembered) {
        throw new CliError(
          "We couldn't save this sign-in on this machine to finish it later, so it\n" +
            `can't finish here. Run it in a terminal instead:\n  ${LOGIN_RETRY_COMMAND}`,
          1,
        );
      }
      io.out(
        browserOpened
          ? "Your browser should open a Driggsby approval page. If it doesn't, open\nthis link:\n\n"
          : "Open this link in your browser to approve access for this machine:\n\n",
      );
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
    if (prompt === null && remembered) {
      io.out(`If the page shows a code instead, finish with:\n  ${CODE_COMMAND}\n`);
    }

    const finish = await awaitTokenOrElsewhere(
      pending,
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
    prompt?.close();
    prompt = null;
    // The claim is spent either way; only this sign-in's own record goes.
    await forgetPendingLogin(environment, pending, io);
    if (finish.kind === "elsewhere") {
      io.out(
        "\nThis sign-in was finished by npx driggsby@latest login --code in\n" +
          "another command; its output says where the token was saved.\n",
      );
      return;
    }
    await finishSignIn(finish.appToken, environment, io);
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
  if (pending.finished) {
    throw new CliError(`This sign-in already finished.\n\nTo sign in again:\n  ${LOGIN_RETRY_COMMAND}`, 1);
  }
  const result = await tradeWithRetries(pending, code.trim(), io);
  if (result.kind === "unreachable") {
    throw new CliError(
      `${result.message}\n\nYour code may still work: run the same command again in a minute.\n` +
        `Or start a fresh sign-in:\n  ${LOGIN_RETRY_COMMAND}`,
      1,
    );
  }
  if (result.kind === "rejected") {
    // One record per computer: a newer `login` replaced an older one's.
    throw new CliError(
      `${result.message}\n\nCheck the code and run the command again. Only the code from the latest\n` +
        `sign-in started on this computer works here. Or start a fresh sign-in:\n  ${LOGIN_RETRY_COMMAND}`,
      1,
    );
  }
  // Marked once the claim is spent, before the token is saved: a login
  // still waiting on this claim sees it finished here, not failed.
  await markFinished(environment, pending, io);
  await finishSignIn(result.appToken, environment, io);
}

async function finishSignIn(appToken: string, environment: CredentialEnvironment, io: LoginIo): Promise<void> {
  // Warnings are held back and printed after the "Approved." line — and when
  // one fires, it replaces the all-clear closer: the last thing the user
  // reads must never contradict a warning they were just shown.
  const warnings: string[] = [];
  const storedIn = await storeApprovedToken(appToken, environment, (text) => warnings.push(text));
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

// The wait's token, or "elsewhere" when `login --code` in another command
// finished this very sign-in meanwhile: the claim reads gone, and this
// claim's record says finished. Any other failure also ends this sign-in
// for good, so its record goes with it.
async function awaitTokenOrElsewhere(
  pending: PendingLogin,
  wait: Promise<string>,
  remembered: boolean,
  environment: CredentialEnvironment,
  io: LoginIo,
): Promise<{ kind: "token"; appToken: string } | { kind: "elsewhere" }> {
  try {
    return { kind: "token", appToken: await wait };
  } catch (error) {
    if (remembered && error instanceof ClaimGone && (await finishedElsewhere(environment, pending, io))) {
      return { kind: "elsewhere" };
    }
    await forgetPendingLogin(environment, pending, io);
    throw error;
  }
}

// `login --code` marks the record just after its trade spends the claim,
// so a poll can read gone a moment before the mark lands: a record still
// this claim's but not yet finished is read once more after a pause.
async function finishedElsewhere(environment: CredentialEnvironment, pending: PendingLogin, io: LoginIo): Promise<boolean> {
  for (let look = 1; ; look += 1) {
    let current: PendingLogin | null;
    try {
      current = await readPendingLogin(environment.homeDirectory, io.now());
    } catch {
      return false;
    }
    if (current?.claimRequestId !== pending.claimRequestId) {
      return false;
    }
    if (current.finished || look >= 2) {
      return current.finished;
    }
    await io.sleep(FINISH_MARK_WAIT_MS);
  }
}

async function forgetPendingLogin(environment: CredentialEnvironment, pending: PendingLogin, io: LoginIo): Promise<void> {
  try {
    await clearPendingLogin(environment.homeDirectory, pending.claimRequestId, io.now());
  } catch {
    // It expires on its own.
  }
}

async function markFinished(environment: CredentialEnvironment, pending: PendingLogin, io: LoginIo): Promise<void> {
  try {
    await markPendingLoginFinished(environment.homeDirectory, pending.claimRequestId, io.now());
  } catch {
    // Only a login still waiting on this claim reads it, and it then
    // reports the claim gone: the token below is saved all the same.
  }
}

function handoffUrl(claimUrl: string): string {
  const url = new URL(claimUrl);
  url.searchParams.set("handoff", "loopback");
  return url.href;
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
