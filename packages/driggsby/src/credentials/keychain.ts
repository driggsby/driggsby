// macOS keychain backend, via the system `security` CLI. The service name
// `driggsby-cli` is distinct from the legacy Rust-era `driggsby.cli` items,
// so old installs are never touched. `security` is invoked by its absolute
// system path, never resolved through PATH, so a lookalike binary earlier on
// PATH can never receive the token; tests override the path to a fake.
import { type ClearOutcome } from "./clear-outcome.ts";
import { runCredentialTool, type ToolRunOptions } from "./tool-runner.ts";

const SECURITY_PROGRAM = "/usr/bin/security";
const SERVICE = "driggsby-cli";
const ACCOUNT = "app-token";
// errSecItemNotFound, the exit code `security` uses for a missing item.
const SECURITY_ITEM_NOT_FOUND = 44;

export interface KeychainToolOptions extends ToolRunOptions {
  securityProgram?: string | undefined;
}

// Every keychain call resolves `security` through this one function, and it
// is exported so a test can pin the absolute-path invariant (no PATH lookup)
// without ever invoking the real binary.
export function resolveSecurityProgram(options: KeychainToolOptions): string {
  return options.securityProgram ?? SECURITY_PROGRAM;
}

export type KeychainReadResult =
  | { kind: "token"; token: string }
  | { kind: "absent" }
  // The tool is missing, timed out, or errored: the caller falls back to the
  // file store rather than failing the whole command.
  | { kind: "unavailable" };

export async function readKeychainToken(
  options: KeychainToolOptions = {},
): Promise<KeychainReadResult> {
  const result = await runCredentialTool(
    resolveSecurityProgram(options),
    ["find-generic-password", "-s", SERVICE, "-a", ACCOUNT, "-w"],
    options,
  );
  if (result.kind !== "output") {
    return { kind: "unavailable" };
  }
  if (result.exitCode === SECURITY_ITEM_NOT_FOUND) {
    return { kind: "absent" };
  }
  if (result.exitCode !== 0) {
    return { kind: "unavailable" };
  }
  const token = result.stdout.replace(/\r?\n$/, "");
  return token === "" ? { kind: "absent" } : { kind: "token", token };
}

// -U updates the existing item in place, so re-login replaces the token.
// The token rides on the argument list here: `security` offers no stdin path
// for -w, and on macOS another user cannot read this process's arguments —
// the same tradeoff every keychain-writing CLI accepts.
export async function writeKeychainToken(
  token: string,
  options: KeychainToolOptions = {},
): Promise<boolean> {
  const result = await runCredentialTool(
    resolveSecurityProgram(options),
    ["add-generic-password", "-U", "-s", SERVICE, "-a", ACCOUNT, "-w", token],
    options,
  );
  return result.kind === "output" && result.exitCode === 0;
}

export async function clearKeychainToken(
  options: KeychainToolOptions = {},
): Promise<ClearOutcome> {
  const result = await runCredentialTool(
    resolveSecurityProgram(options),
    ["delete-generic-password", "-s", SERVICE, "-a", ACCOUNT],
    options,
  );
  if (result.kind === "not-found") {
    // No `security` binary means no keychain this CLI could have written to.
    return "absent";
  }
  if (result.kind !== "output") {
    return "failed";
  }
  if (result.exitCode === 0) {
    return "cleared";
  }
  return result.exitCode === SECURITY_ITEM_NOT_FOUND ? "absent" : "failed";
}
