import assert from "node:assert/strict";
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { clearPendingLogin, type PendingLogin, readPendingLogin, savePendingLogin } from "./pending.ts";

const PENDING: PendingLogin = {
  baseUrl: "https://app.driggsby.com",
  claimRequestId: "claim-1",
  claimUrl: "https://app.driggsby.com/connect/claim-1",
  codeVerifier: "v".repeat(43),
  expiresAt: 10_000,
};

test("a waiting sign-in reads back until it expires, then reads as nothing", async () => {
  const home = mkdtempSync(join(tmpdir(), "driggsby-pending-"));
  await savePendingLogin(home, PENDING);

  assert.deepEqual(await readPendingLogin(home, 9_999), PENDING);
  assert.equal(await readPendingLogin(home, 10_000), null);

  await clearPendingLogin(home);
  assert.equal(await readPendingLogin(home, 0), null);
  // Clearing twice is fine.
  await clearPendingLogin(home);
});

test("the waiting sign-in is readable only by its owner", { skip: process.platform === "win32" }, async () => {
  const home = mkdtempSync(join(tmpdir(), "driggsby-pending-"));
  await savePendingLogin(home, PENDING);

  assert.equal(statSync(join(home, ".driggsby", "pending-login.json")).mode & 0o777, 0o600);
});
