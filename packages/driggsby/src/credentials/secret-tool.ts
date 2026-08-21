// Linux keyring backend, via `secret-tool` (libsecret) when it is on PATH.
// The token is written over stdin, never on the argument list, because Linux
// exposes every process's arguments to every local user via /proc.
import { type ClearOutcome } from "./clear-outcome.ts";
import { runCredentialTool, type ToolRunOptions } from "./tool-runner.ts";

const SERVICE_ATTRIBUTE: readonly string[] = ["service", "driggsby-cli"];

export type KeyringReadResult =
  | { kind: "token"; token: string }
  | { kind: "absent" }
  | { kind: "unavailable" };

export async function readKeyringToken(options: ToolRunOptions = {}): Promise<KeyringReadResult> {
  const result = await runCredentialTool("secret-tool", ["lookup", ...SERVICE_ATTRIBUTE], options);
  if (result.kind !== "output") {
    return { kind: "unavailable" };
  }
  if (result.exitCode !== 0) {
    // secret-tool exits 1 both for "no such secret" and for real errors; the
    // stderr text is not a stable contract, so treat every non-zero lookup as
    // absent and let the caller fall back to the file store on read.
    return { kind: "absent" };
  }
  const token = result.stdout.replace(/\r?\n$/, "");
  return token === "" ? { kind: "absent" } : { kind: "token", token };
}

export async function writeKeyringToken(
  token: string,
  options: ToolRunOptions = {},
): Promise<boolean> {
  const result = await runCredentialTool(
    "secret-tool",
    ["store", "--label", "Driggsby CLI", ...SERVICE_ATTRIBUTE],
    { ...options, stdinText: token },
  );
  return result.kind === "output" && result.exitCode === 0;
}

// `secret-tool clear` exits 0 whether or not anything matched, so existence
// is checked first: without that, "removed" and "there was never anything to
// remove" would be indistinguishable. A lookup that cannot answer (no
// session bus, locked keyring, timeout) must NOT collapse into "absent":
// that would tell the user a token is gone while it keeps working. The
// clear's own exit status is the tiebreaker — it exits 0 whenever the
// keyring is reachable (match or no match) and non-zero when it is not.
export async function clearKeyringToken(options: ToolRunOptions = {}): Promise<ClearOutcome> {
  const lookup = await runCredentialTool("secret-tool", ["lookup", ...SERVICE_ATTRIBUTE], options);
  if (lookup.kind === "not-found") {
    // No secret-tool binary means no keyring this CLI could have written to.
    return "absent";
  }
  if (lookup.kind !== "output") {
    // The tool crashed or hung; the keyring may still hold a live token.
    return "failed";
  }
  const hadToken = lookup.exitCode === 0 && lookup.stdout.replace(/\r?\n$/, "") !== "";
  const result = await runCredentialTool("secret-tool", ["clear", ...SERVICE_ATTRIBUTE], options);
  if (result.kind !== "output" || result.exitCode !== 0) {
    return "failed";
  }
  return hadToken ? "cleared" : "absent";
}
