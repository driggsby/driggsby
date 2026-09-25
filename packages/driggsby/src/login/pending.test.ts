import assert from "node:assert/strict";
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  clearPendingLogin,
  markPendingLoginFinished,
  type PendingLogin,
  readPendingLogin,
  savePendingLogin,
} from "./pending.ts";

const PENDING: PendingLogin = {
  baseUrl: "https://app.driggsby.com",
  claimRequestId: "claim-1",
  codeVerifier: "v".repeat(43),
  expiresAt: 10_000,
  finished: false,
};

function home(): string {
  return mkdtempSync(join(tmpdir(), "driggsby-pending-"));
}

test("a waiting sign-in reads back until it expires, then reads as nothing", async () => {
  const directory = home();
  await savePendingLogin(directory, PENDING);

  assert.deepEqual(await readPendingLogin(directory, 9_999), PENDING);
  assert.equal(await readPendingLogin(directory, 10_000), null);
});

test("a record is cleared only by its own claim, and a finished one says so", async () => {
  const directory = home();
  await savePendingLogin(directory, PENDING);

  await clearPendingLogin(directory, "claim-other", 0);
  assert.ok(await readPendingLogin(directory, 0));

  await markPendingLoginFinished(directory, PENDING);
  assert.equal((await readPendingLogin(directory, 0))?.finished, true);

  await clearPendingLogin(directory, "claim-1", 0);
  assert.equal(await readPendingLogin(directory, 0), null);
  // Clearing twice is fine.
  await clearPendingLogin(directory, "claim-1", 0);
});

test("the waiting sign-in is readable only by its owner", { skip: process.platform === "win32" }, async () => {
  const directory = home();
  await savePendingLogin(directory, PENDING);

  assert.equal(statSync(join(directory, ".driggsby", "pending-login.json")).mode & 0o777, 0o600);
});
