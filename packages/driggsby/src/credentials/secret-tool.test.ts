import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { fakeCredentialToolEnvironment } from "../test-support/fake-credential-tool.ts";
import { clearKeyringToken, readKeyringToken, writeKeyringToken } from "./secret-tool.ts";

const onWindows = process.platform === "win32";

test("lookup returns the stored token with the exact arguments", { skip: onWindows }, async () => {
  const { spawnEnv, calls } = fakeCredentialToolEnvironment("secret-tool", "found", {
    token: "dgb_at_test_1111",
  });

  assert.deepEqual(await readKeyringToken({ spawnEnv }), {
    kind: "token",
    token: "dgb_at_test_1111",
  });
  assert.deepEqual(calls()[0]?.argv, ["lookup", "service", "driggsby-cli"]);
});

test("lookup reports absent when no secret is stored", { skip: onWindows }, async () => {
  const { spawnEnv } = fakeCredentialToolEnvironment("secret-tool", "missing");
  assert.deepEqual(await readKeyringToken({ spawnEnv }), { kind: "absent" });
});

test("lookup reports unavailable when secret-tool is not on PATH", { skip: onWindows }, async () => {
  const emptyPath = mkdtempSync(join(tmpdir(), "driggsby-empty-path-"));
  assert.deepEqual(await readKeyringToken({ spawnEnv: { ...process.env, PATH: emptyPath } }), {
    kind: "unavailable",
  });
});

test("store sends the token on stdin, never on argv", { skip: onWindows }, async () => {
  const { spawnEnv, calls } = fakeCredentialToolEnvironment("secret-tool", "found");

  assert.equal(await writeKeyringToken("dgb_at_test_2222", { spawnEnv }), true);
  const call = calls()[0];
  assert.ok(call !== undefined);
  assert.deepEqual(call.argv, ["store", "--label", "Driggsby CLI", "service", "driggsby-cli"]);
  assert.equal(call.stdin, "dgb_at_test_2222");
});

test("store reports failure when secret-tool errors", { skip: onWindows }, async () => {
  const { spawnEnv } = fakeCredentialToolEnvironment("secret-tool", "found", {
    writeBehavior: "fail",
  });
  assert.equal(await writeKeyringToken("dgb_at_test_2222", { spawnEnv }), false);
});

test("clear distinguishes deleted, absent, and failed", { skip: onWindows }, async () => {
  // secret-tool clear exits 0 with or without a match, so the backend checks
  // existence with a lookup first, then trusts the clear's own exit status.
  const found = fakeCredentialToolEnvironment("secret-tool", "found", { token: "dgb_at_test_3333" });
  assert.equal(await clearKeyringToken({ spawnEnv: found.spawnEnv }), "cleared");
  assert.deepEqual(
    found.calls().map((call) => call.argv[0]),
    ["lookup", "clear"],
  );

  const missing = fakeCredentialToolEnvironment("secret-tool", "missing");
  assert.equal(await clearKeyringToken({ spawnEnv: missing.spawnEnv }), "absent");
  assert.deepEqual(
    missing.calls().map((call) => call.argv[0]),
    ["lookup", "clear"],
  );

  const failing = fakeCredentialToolEnvironment("secret-tool", "found", {
    token: "dgb_at_test_3333",
    deleteBehavior: "fail",
  });
  assert.equal(await clearKeyringToken({ spawnEnv: failing.spawnEnv }), "failed");
});

test("clear never reports absent when the keyring is unreachable", { skip: onWindows }, async () => {
  // A lookup that errors (no session bus, locked keyring) must not read as
  // "nothing was stored" — that would falsely assure the user a live token
  // was removed. The clear's exit status is the tiebreaker.
  const broken = fakeCredentialToolEnvironment("secret-tool", "fail");
  assert.equal(await clearKeyringToken({ spawnEnv: broken.spawnEnv }), "failed");
  assert.deepEqual(
    broken.calls().map((call) => call.argv[0]),
    ["lookup", "clear"],
  );

  // If the lookup erred transiently but the clear itself succeeds, the
  // keyring was reachable and holds nothing now — absent is honest.
  const transient = fakeCredentialToolEnvironment("secret-tool", "fail", {
    deleteBehavior: "missing",
  });
  assert.equal(await clearKeyringToken({ spawnEnv: transient.spawnEnv }), "absent");

  // No secret-tool binary at all: there is no keyring this CLI wrote to.
  const emptyPath = mkdtempSync(join(tmpdir(), "driggsby-empty-path-"));
  assert.equal(await clearKeyringToken({ spawnEnv: { ...process.env, PATH: emptyPath } }), "absent");
});
