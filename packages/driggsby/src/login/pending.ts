// The sign-in waiting for its code, kept at ~/.driggsby/pending-login.json
// (owner-only, like the saved token) so `driggsby login --code <CODE>` can
// finish it from another command: an agent without a terminal prompt runs
// login, the person approves in a browser elsewhere, and the agent finishes
// with the code the page showed. The verifier alone mints nothing, and a
// record is ignored once it expires.
//
// Only the command that started a sign-in removes its record. `login
// --code` marks it finished instead, so a login still waiting on the same
// claim can tell the sign-in finished there rather than failed.
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";

import { driggsbyDirectory, writeOwnerOnlyFile } from "../owner-only-file.ts";

const PENDING_FILE_NAME = "pending-login.json";

export interface PendingLogin {
  baseUrl: string;
  claimRequestId: string;
  codeVerifier: string;
  // Milliseconds since the epoch.
  expiresAt: number;
  finished: boolean;
}

export async function savePendingLogin(homeDirectory: string, pending: PendingLogin): Promise<void> {
  const body = {
    base_url: pending.baseUrl,
    claim_request_id: pending.claimRequestId,
    code_verifier: pending.codeVerifier,
    expires_at: pending.expiresAt,
    finished: pending.finished,
  };
  await writeOwnerOnlyFile(homeDirectory, PENDING_FILE_NAME, `${JSON.stringify(body, null, 2)}\n`);
}

// null when nothing is waiting, the record is unreadable, or it expired.
export async function readPendingLogin(homeDirectory: string, now: number): Promise<PendingLogin | null> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(pendingPath(homeDirectory), "utf8"));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return null;
  }
  const record = parsed as Record<string, unknown>;
  const { base_url: baseUrl, claim_request_id: claimRequestId, code_verifier: codeVerifier } = record;
  const expiresAt = record.expires_at;
  if (
    typeof baseUrl !== "string" ||
    typeof claimRequestId !== "string" ||
    typeof codeVerifier !== "string" ||
    typeof expiresAt !== "number" ||
    expiresAt <= now
  ) {
    return null;
  }
  return { baseUrl, claimRequestId, codeVerifier, expiresAt, finished: record.finished === true };
}

// Removes the record only while it is still this claim's: a newer sign-in
// may have replaced it.
export async function clearPendingLogin(homeDirectory: string, claimRequestId: string, now: number): Promise<void> {
  const current = await readPendingLogin(homeDirectory, now);
  if (current === null || current.claimRequestId === claimRequestId) {
    await rm(pendingPath(homeDirectory), { force: true });
  }
}

export async function markPendingLoginFinished(homeDirectory: string, pending: PendingLogin): Promise<void> {
  await savePendingLogin(homeDirectory, { ...pending, finished: true });
}

function pendingPath(homeDirectory: string): string {
  return join(driggsbyDirectory(homeDirectory), PENDING_FILE_NAME);
}
