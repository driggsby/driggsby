import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { clearFileToken, credentialsFilePath, readFileToken, writeFileToken } from "./file-store.ts";

function temporaryHome(): string {
  return mkdtempSync(join(tmpdir(), "driggsby-file-store-"));
}

test("write then read round-trips the token", async () => {
  const home = temporaryHome();
  await writeFileToken(home, "dgb_at_test_1111");
  assert.equal(await readFileToken(home), "dgb_at_test_1111");
});

test("reading with no credentials file returns null", async () => {
  assert.equal(await readFileToken(temporaryHome()), null);
});

test("a malformed credentials file reads as null instead of crashing", async () => {
  const home = temporaryHome();
  await writeFileToken(home, "dgb_at_test_1111");
  writeFileSync(credentialsFilePath(home), "not json");
  assert.equal(await readFileToken(home), null);

  writeFileSync(credentialsFilePath(home), JSON.stringify({ app_token: 7 }));
  assert.equal(await readFileToken(home), null);
});

test("writing replaces an existing token and leaves no temp files behind", async () => {
  const home = temporaryHome();
  await writeFileToken(home, "dgb_at_test_1111");
  await writeFileToken(home, "dgb_at_test_2222");
  assert.equal(await readFileToken(home), "dgb_at_test_2222");
  assert.deepEqual(readdirSync(join(home, ".driggsby")), ["credentials.json"]);
});

test(
  "the credentials file and its directory are readable only by the owner",
  { skip: process.platform === "win32" },
  async () => {
    const home = temporaryHome();
    await writeFileToken(home, "dgb_at_test_1111");
    assert.equal(statSync(credentialsFilePath(home)).mode & 0o777, 0o600);
    assert.equal(statSync(join(home, ".driggsby")).mode & 0o777, 0o700);
  },
);

test("clear removes the file and reports whether one existed", async () => {
  const home = temporaryHome();
  assert.equal(await clearFileToken(home), "absent");
  await writeFileToken(home, "dgb_at_test_1111");
  assert.equal(await clearFileToken(home), "cleared");
  assert.equal(await readFileToken(home), null);
  assert.equal(await clearFileToken(home), "absent");
});

test("clear also removes a temp file stranded by an interrupted write", async () => {
  // A crash between writeFileToken's temp write and its rename leaves a
  // readable token in credentials.json.<uuid>.tmp; clear must not report the
  // token gone while that copy remains.
  const home = temporaryHome();
  await writeFileToken(home, "dgb_at_test_1111");
  const stranded = join(home, ".driggsby", "credentials.json.11111111-2222.tmp");
  writeFileSync(stranded, JSON.stringify({ app_token: "dgb_at_test_1111" }));

  assert.equal(await clearFileToken(home), "cleared");
  assert.deepEqual(readdirSync(join(home, ".driggsby")), []);
});

test("a removal that fails is reported as failed, never as nothing to remove", async () => {
  // credentials.json as a non-empty directory: rm cannot remove it, and the
  // outcome must say so — "absent" would make logout claim a clean sign-out
  // while something still sits at the credentials path.
  const home = temporaryHome();
  mkdirSync(join(home, ".driggsby", "credentials.json"), { recursive: true });
  writeFileSync(join(home, ".driggsby", "credentials.json", "blocker"), "");

  assert.equal(await clearFileToken(home), "failed");
});
