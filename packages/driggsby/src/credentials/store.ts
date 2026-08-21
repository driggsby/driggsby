// The credential store facade: one read/save/clear surface over the
// platform backends. Precedence on read: the DRIGGSBY_TOKEN environment
// variable (the CI/sandbox path), then the platform keyring (macOS keychain
// or Linux secret-tool), then the ~/.driggsby/credentials.json file. Token
// values never appear in output or errors; callers describe locations, not
// contents.
import { homedir } from "node:os";

import { CliError } from "../cli-error.ts";
import { wrapProse } from "../terminal-text.ts";
import { type ClearOutcome } from "./clear-outcome.ts";
import { clearFileToken, readFileToken, writeFileToken } from "./file-store.ts";
import {
  clearKeychainToken,
  type KeychainToolOptions,
  readKeychainToken,
  writeKeychainToken,
} from "./keychain.ts";
import { clearKeyringToken, readKeyringToken, writeKeyringToken } from "./secret-tool.ts";

export type CredentialSource = "env" | "keychain" | "keyring" | "file";

export interface CredentialEnvironment {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  homeDirectory: string;
  // Environment for spawned credential tools; tests point its PATH at fakes.
  spawnEnv?: NodeJS.ProcessEnv;
  // Overrides the absolute path to macOS `security`; tests point it at a fake.
  securityProgram?: string | undefined;
}

export function defaultCredentialEnvironment(): CredentialEnvironment {
  return { platform: process.platform, env: process.env, homeDirectory: homedir() };
}

function keychainOptions(environment: CredentialEnvironment): KeychainToolOptions {
  return { spawnEnv: environment.spawnEnv, securityProgram: environment.securityProgram };
}

function keyringOptions(environment: CredentialEnvironment): {
  spawnEnv?: NodeJS.ProcessEnv | undefined;
} {
  return { spawnEnv: environment.spawnEnv };
}

export interface StoredToken {
  token: string;
  source: CredentialSource;
}

// The DRIGGSBY_TOKEN override, or null when unset or blank. One definition,
// so "a blank env token is ignored" holds everywhere it is consulted.
export function environmentToken(environment: CredentialEnvironment): string | null {
  const token = environment.env.DRIGGSBY_TOKEN?.trim();
  return token === undefined || token === "" ? null : token;
}

export async function readStoredToken(
  environment: CredentialEnvironment = defaultCredentialEnvironment(),
): Promise<StoredToken | null> {
  const envToken = environmentToken(environment);
  if (envToken !== null) {
    return { token: envToken, source: "env" };
  }

  if (environment.platform === "darwin") {
    const result = await readKeychainToken(keychainOptions(environment));
    if (result.kind === "token") {
      return { token: result.token, source: "keychain" };
    }
  } else if (environment.platform === "linux") {
    const result = await readKeyringToken(keyringOptions(environment));
    if (result.kind === "token") {
      return { token: result.token, source: "keyring" };
    }
  }

  const fileToken = await readFileToken(environment.homeDirectory);
  return fileToken === null ? null : { token: fileToken, source: "file" };
}

// Saves the token to the preferred backend for this platform and returns
// where it landed. A failed platform keyring falls back to the file store —
// but never silently: the keyring outranks the file on read, so an old
// keyring token that cannot be removed would shadow the token being saved.
// A readable shadowing token is a hard failure; an unverifiable keyring
// (locked, unreachable) falls back with a loud warning through `warn`.
export async function saveToken(
  token: string,
  environment: CredentialEnvironment,
  warn: (text: string) => void,
): Promise<CredentialSource> {
  if (environment.platform === "darwin") {
    if (await writeKeychainToken(token, keychainOptions(environment))) {
      // A stale file copy must not shadow or outlive the keychain token.
      await clearFileToken(environment.homeDirectory);
      return "keychain";
    }
    await guardAgainstShadowingToken({
      clearOutcome: await clearKeychainToken(keychainOptions(environment)),
      presence: async () => {
        const read = await readKeychainToken(keychainOptions(environment));
        if (read.kind === "token") {
          return "present";
        }
        // `security` answers a definitive "no such item" (exit 44) distinctly
        // from errors, so an absent answer here is trustworthy.
        return read.kind === "absent" ? "absent" : "unknown";
      },
      problem:
        "an older token is stored in your macOS keychain and couldn't be replaced or removed. If your keychain is locked, unlock it, then sign in again",
      unverifiedWarning:
        "Note: we couldn't check your macOS keychain for an older Driggsby app token.\n" +
        "If one is still there, driggsby commands will use it instead of the token\n" +
        "saved just now. To fix that, unlock your keychain, then sign out and back in:\n" +
        "  npx driggsby@latest logout\n" +
        "  npx driggsby@latest login\n",
      warn,
    });
  } else if (environment.platform === "linux") {
    if (await writeKeyringToken(token, keyringOptions(environment))) {
      await clearFileToken(environment.homeDirectory);
      return "keyring";
    }
    await guardAgainstShadowingToken({
      clearOutcome: await clearKeyringToken(keyringOptions(environment)),
      presence: async () => {
        const read = await readKeyringToken(keyringOptions(environment));
        // secret-tool's non-zero lookup exit is ambiguous (no match, or the
        // keyring is unreachable), so a non-token answer never counts as a
        // definitive absence here.
        return read.kind === "token" ? "present" : "unknown";
      },
      problem:
        "an older token is stored in your system keyring and couldn't be replaced or removed. Check that your keyring is unlocked, then sign in again",
      unverifiedWarning:
        "Note: we couldn't check your system keyring for an older Driggsby app token.\n" +
        "If one is still there, driggsby commands will use it instead of the token\n" +
        "saved just now. To fix that, make sure your keyring is unlocked, then sign\n" +
        "out and back in:\n" +
        "  npx driggsby@latest logout\n" +
        "  npx driggsby@latest login\n",
      warn,
    });
  }
  await writeFileToken(environment.homeDirectory, token);
  return "file";
}

// Whether an older keyring token remains after a failed clear: "present" and
// "absent" are definitive answers from the keyring; "unknown" means it could
// not be asked.
type TokenPresence = "present" | "absent" | "unknown";

// Called when a keyring write failed and the save is about to fall back to
// the file store. If an older keyring token exists and cannot be cleared, it
// would win over the file copy on every future read, so the save fails
// loudly instead of storing a token that will never be used. When the
// keyring cannot even be read — the same brokenness that failed the write —
// the fallback proceeds, but with a warning: silence here would let a stale
// token quietly win once the keyring becomes readable again. A definitive
// "absent" answer needs neither: there is nothing to shadow.
async function guardAgainstShadowingToken(check: {
  clearOutcome: ClearOutcome;
  presence: () => Promise<TokenPresence>;
  problem: string;
  unverifiedWarning: string;
  warn: (text: string) => void;
}): Promise<void> {
  if (check.clearOutcome !== "failed") {
    return;
  }
  const presence = await check.presence();
  if (presence === "present") {
    throw new CliError(
      `${wrapProse(`We couldn't save your Driggsby app token: ${check.problem}:`)}\n  npx driggsby@latest login`,
      1,
    );
  }
  if (presence === "unknown") {
    check.warn(check.unverifiedWarning);
  }
}

export interface ClearResult {
  clearedSources: CredentialSource[];
  // Sources where a removal was attempted and failed — the token may still
  // be stored there, and logout must say so rather than claim success.
  failedSources: CredentialSource[];
  // DRIGGSBY_TOKEN is set in the environment; the CLI cannot unset it for
  // the user, so logout reports it instead of silently leaving it active.
  envTokenStillSet: boolean;
}

export async function clearStoredToken(
  environment: CredentialEnvironment = defaultCredentialEnvironment(),
): Promise<ClearResult> {
  const clearedSources: CredentialSource[] = [];
  const failedSources: CredentialSource[] = [];
  const record = (source: CredentialSource, outcome: ClearOutcome): void => {
    if (outcome === "cleared") {
      clearedSources.push(source);
    } else if (outcome === "failed") {
      failedSources.push(source);
    }
  };

  if (environment.platform === "darwin") {
    record("keychain", await clearKeychainToken(keychainOptions(environment)));
  } else if (environment.platform === "linux") {
    record("keyring", await clearKeyringToken(keyringOptions(environment)));
  }
  record("file", await clearFileToken(environment.homeDirectory));

  return {
    clearedSources,
    failedSources,
    envTokenStillSet: environmentToken(environment) !== null,
  };
}

export function describeStorageLocation(source: CredentialSource): string {
  switch (source) {
    case "env":
      return "the DRIGGSBY_TOKEN environment variable";
    case "keychain":
      return "your macOS keychain";
    case "keyring":
      return "your system keyring";
    case "file":
      return "the ~/.driggsby/credentials.json file";
  }
}
