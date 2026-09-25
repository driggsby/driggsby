// The sign-in waiting for its code, kept at ~/.driggsby/pending-login.json
// (owner-only, like the saved token) so `driggsby login --code <CODE>` can
// finish it from another command: an agent without a terminal prompt runs
// login, the person approves in a browser elsewhere, and the agent finishes
// with the code the page showed. The verifier alone mints nothing; the file
// is removed once the sign-in finishes and ignored once it expires.
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";

import { driggsbyDirectory, writeOwnerOnlyFile } from "../owner-only-file.ts";

const PENDING_FILE_NAME = "pending-login.json";

export interface PendingLogin {
  baseUrl: string;
  claimRequestId: string;
  claimUrl: string;
  codeVerifier: string;
  // Milliseconds since the epoch.
  expiresAt: number;
}

export async function savePendingLogin(homeDirectory: string, pending: PendingLogin): Promise<void> {
  const body = {
    base_url: pending.baseUrl,
    claim_request_id: pending.claimRequestId,
    claim_url: pending.claimUrl,
    code_verifier: pending.codeVerifier,
    expires_at: pending.expiresAt,
  };
  await writeOwnerOnlyFile(homeDirectory, PENDING_FILE_NAME, `${JSON.stringify(body, null, 2)}\n`);
}

// null when nothing is waiting, the record is unreadable, or it expired.
export async function readPendingLogin(homeDirectory: string, now: number): Promise<PendingLogin | null> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(join(driggsbyDirectory(homeDirectory), PENDING_FILE_NAME), "utf8"));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return null;
  }
  const record = parsed as Record<string, unknown>;
  const { base_url: baseUrl, claim_request_id: claimRequestId, claim_url: claimUrl, code_verifier: codeVerifier } = record;
  const expiresAt = record.expires_at;
  if (
    typeof baseUrl !== "string" ||
    typeof claimRequestId !== "string" ||
    typeof claimUrl !== "string" ||
    typeof codeVerifier !== "string" ||
    typeof expiresAt !== "number" ||
    expiresAt <= now
  ) {
    return null;
  }
  return { baseUrl, claimRequestId, claimUrl, codeVerifier, expiresAt };
}

export async function clearPendingLogin(homeDirectory: string): Promise<void> {
  await rm(join(driggsbyDirectory(homeDirectory), PENDING_FILE_NAME), { force: true });
}
