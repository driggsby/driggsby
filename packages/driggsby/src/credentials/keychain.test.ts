import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { fakeCredentialToolEnvironment } from "../test-support/fake-credential-tool.ts";
import {
  clearKeychainToken,
  readKeychainToken,
  resolveSecurityProgram,
  writeKeychainToken,
} from "./keychain.ts";

const onWindows = process.platform === "win32";

test("security resolves to its absolute system path, never through PATH", () => {
  // Every keychain call goes through this resolution; a bare "security"
  // here would let a lookalike binary earlier on PATH receive the token.
  assert.equal(resolveSecurityProgram({}), "/usr/bin/security");
  assert.equal(resolveSecurityProgram({ securityProgram: "/tmp/fake" }), "/tmp/fake");
});

function fakeSecurity(behavior: string, options: { token?: string; deleteBehavior?: string } = {}) {
  const fake = fakeCredentialToolEnvironment("security", behavior, options);
  return { ...fake, toolOptions: { spawnEnv: fake.spawnEnv, securityProgram: fake.toolPath } };
}

test("read returns the stored token with the exact security arguments", { skip: onWindows }, async () => {
  const { toolOptions, calls } = fakeSecurity("found", { token: "dgb_at_test_1111" });

  const result = await readKeychainToken(toolOptions);

  assert.deepEqual(result, { kind: "token", token: "dgb_at_test_1111" });
  assert.deepEqual(calls()[0]?.argv, [
    "find-generic-password",
    "-s",
    "driggsby-cli",
    "-a",
    "app-token",
    "-w",
  ]);
});

test("read reports absent when the keychain item does not exist", { skip: onWindows }, async () => {
  const { toolOptions } = fakeSecurity("missing");
  assert.deepEqual(await readKeychainToken(toolOptions), { kind: "absent" });
});

test("read reports unavailable when security is missing or errors", { skip: onWindows }, async () => {
  const missingProgram = join(mkdtempSync(join(tmpdir(), "driggsby-empty-path-")), "security");
  assert.deepEqual(await readKeychainToken({ securityProgram: missingProgram }), {
    kind: "unavailable",
  });

  const { toolOptions } = fakeSecurity("fail");
  assert.deepEqual(await readKeychainToken(toolOptions), { kind: "unavailable" });
});

test("write upserts the token with -U and returns success", { skip: onWindows }, async () => {
  const { toolOptions, calls } = fakeSecurity("found");

  assert.equal(await writeKeychainToken("dgb_at_test_2222", toolOptions), true);
  assert.deepEqual(calls()[0]?.argv, [
    "add-generic-password",
    "-U",
    "-s",
    "driggsby-cli",
    "-a",
    "app-token",
    "-w",
    "dgb_at_test_2222",
  ]);
});

test("write reports failure when security errors", { skip: onWindows }, async () => {
  const { toolOptions } = fakeSecurity("fail");
  assert.equal(await writeKeychainToken("dgb_at_test_2222", toolOptions), false);
});

test("clear distinguishes deleted, absent, and failed", { skip: onWindows }, async () => {
  const found = fakeSecurity("found");
  assert.equal(await clearKeychainToken(found.toolOptions), "cleared");
  assert.deepEqual(found.calls()[0]?.argv, [
    "delete-generic-password",
    "-s",
    "driggsby-cli",
    "-a",
    "app-token",
  ]);

  const missing = fakeSecurity("missing");
  assert.equal(await clearKeychainToken(missing.toolOptions), "absent");

  // A delete that errors (locked keychain, denied prompt) is a failure the
  // caller must surface, never "there was nothing to remove".
  const failing = fakeSecurity("found", { deleteBehavior: "fail" });
  assert.equal(await clearKeychainToken(failing.toolOptions), "failed");
});
