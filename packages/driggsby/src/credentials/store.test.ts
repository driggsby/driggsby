import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { CliError } from "../cli-error.ts";
import { fakeCredentialToolEnvironment } from "../test-support/fake-credential-tool.ts";
import { readFileToken, writeFileToken } from "./file-store.ts";
import {
  clearStoredToken,
  type CredentialEnvironment,
  describeStorageLocation,
  readStoredToken,
  saveToken,
} from "./store.ts";

const onWindows = process.platform === "win32";

// For tests that expect no warning: fail loudly if one fires anyway.
function noWarnings(text: string): never {
  throw new Error(`unexpected warning: ${text}`);
}

function fileOnlyEnvironment(overrides?: Partial<CredentialEnvironment>): CredentialEnvironment {
  return {
    platform: "linux",
    env: {},
    homeDirectory: mkdtempSync(join(tmpdir(), "driggsby-store-")),
    // An empty PATH: no secret-tool, so the file store is the backend.
    spawnEnv: { PATH: mkdtempSync(join(tmpdir(), "driggsby-empty-path-")) },
    ...overrides,
  };
}

// A darwin environment whose `security` is the fake tool, wired through the
// same explicit-program option production uses for /usr/bin/security.
function fakeMacEnvironment(
  behavior: string,
  options: { token?: string; writeBehavior?: string; deleteBehavior?: string } = {},
) {
  const fake = fakeCredentialToolEnvironment("security", behavior, options);
  const environment = fileOnlyEnvironment({
    platform: "darwin",
    spawnEnv: fake.spawnEnv,
    securityProgram: fake.toolPath,
  });
  return { environment, calls: fake.calls };
}

test("DRIGGSBY_TOKEN overrides every stored token", async () => {
  const environment = fileOnlyEnvironment({ env: { DRIGGSBY_TOKEN: "dgb_at_env_1111" } });
  await saveToken("dgb_at_file_2222", environment, noWarnings);

  assert.deepEqual(await readStoredToken(environment), {
    token: "dgb_at_env_1111",
    source: "env",
  });
});

test("a blank DRIGGSBY_TOKEN is ignored", async () => {
  const environment = fileOnlyEnvironment({ env: { DRIGGSBY_TOKEN: "   " } });
  assert.equal(await readStoredToken(environment), null);
});

test("with no platform keyring the token round-trips through the file store", async () => {
  const environment = fileOnlyEnvironment();
  assert.equal(await readStoredToken(environment), null);

  assert.equal(await saveToken("dgb_at_file_2222", environment, noWarnings), "file");
  assert.deepEqual(await readStoredToken(environment), {
    token: "dgb_at_file_2222",
    source: "file",
  });
});

test("windows always uses the file store", async () => {
  const environment = fileOnlyEnvironment({ platform: "win32" });
  assert.equal(await saveToken("dgb_at_file_3333", environment, noWarnings), "file");
  assert.equal(await readFileToken(environment.homeDirectory), "dgb_at_file_3333");
});

test("macos routes through the keychain when security works", { skip: onWindows }, async () => {
  const { environment } = fakeMacEnvironment("found", { token: "dgb_at_keychain_4444" });
  // A stale disk copy from an earlier file-fallback login: a successful
  // keychain write must scrub it, or it lingers readable on disk forever.
  await writeFileToken(environment.homeDirectory, "dgb_at_stale_3333");

  assert.equal(await saveToken("dgb_at_keychain_4444", environment, noWarnings), "keychain");
  assert.deepEqual(await readStoredToken(environment), {
    token: "dgb_at_keychain_4444",
    source: "keychain",
  });
  // The stale disk copy was scrubbed and nothing new leaked into the file.
  assert.equal(await readFileToken(environment.homeDirectory), null);
});

test(
  "linux routes through the keyring and scrubs the stale file copy",
  { skip: onWindows },
  async () => {
    const fake = fakeCredentialToolEnvironment("secret-tool", "found", {
      token: "dgb_at_keyring_4444",
    });
    const environment = fileOnlyEnvironment({ spawnEnv: fake.spawnEnv });
    await writeFileToken(environment.homeDirectory, "dgb_at_stale_3333");

    assert.equal(await saveToken("dgb_at_keyring_4444", environment, noWarnings), "keyring");
    assert.deepEqual(await readStoredToken(environment), {
      token: "dgb_at_keyring_4444",
      source: "keyring",
    });
    assert.equal(await readFileToken(environment.homeDirectory), null);
  },
);

test("macos falls back to the file store when security is unavailable", { skip: onWindows }, async () => {
  const environment = fileOnlyEnvironment({
    platform: "darwin",
    securityProgram: join(mkdtempSync(join(tmpdir(), "driggsby-empty-path-")), "security"),
  });
  assert.equal(await saveToken("dgb_at_file_5555", environment, noWarnings), "file");
  assert.deepEqual(await readStoredToken(environment), {
    token: "dgb_at_file_5555",
    source: "file",
  });
});

test(
  "macos clears the old keychain token before falling back to the file",
  { skip: onWindows },
  async () => {
    // The keychain write fails but the delete works: the old keychain token
    // must be removed so it cannot shadow the file copy on later reads.
    const { environment, calls } = fakeMacEnvironment("found", {
      token: "dgb_at_stale_6666",
      writeBehavior: "fail",
    });

    assert.equal(await saveToken("dgb_at_new_7777", environment, noWarnings), "file");
    assert.equal(await readFileToken(environment.homeDirectory), "dgb_at_new_7777");
    assert.ok(calls().some((call) => call.argv[0] === "delete-generic-password"));
  },
);

test(
  "macos refuses to save when an unremovable keychain token would shadow the file copy",
  { skip: onWindows },
  async () => {
    const { environment } = fakeMacEnvironment("found", {
      token: "dgb_at_stale_6666",
      writeBehavior: "fail",
      deleteBehavior: "fail",
    });

    await assert.rejects(saveToken("dgb_at_new_7777", environment, noWarnings), (error: unknown) => {
      assert.ok(error instanceof CliError);
      assert.ok(error.message.includes("keychain"));
      assert.ok(error.message.includes("npx driggsby@latest login"));
      return true;
    });
    // The token that would never be read was not written to the file either.
    assert.equal(await readFileToken(environment.homeDirectory), null);
  },
);

test(
  "linux refuses to save when an unremovable keyring token would shadow the file copy",
  { skip: onWindows },
  async () => {
    const fake = fakeCredentialToolEnvironment("secret-tool", "found", {
      token: "dgb_at_stale_6666",
      writeBehavior: "fail",
      deleteBehavior: "fail",
    });
    const environment = fileOnlyEnvironment({ spawnEnv: fake.spawnEnv });

    await assert.rejects(saveToken("dgb_at_new_7777", environment, noWarnings), (error: unknown) => {
      assert.ok(error instanceof CliError);
      assert.ok(error.message.includes("keyring"));
      assert.ok(error.message.includes("npx driggsby@latest login"));
      return true;
    });
    assert.equal(await readFileToken(environment.homeDirectory), null);
  },
);

test(
  "macos falls back silently when the keychain provably holds no older token",
  { skip: onWindows },
  async () => {
    // Write and delete fail, but the read answers definitively: exit 44,
    // no such item. Nothing can shadow the file copy, so no warning.
    const { environment } = fakeMacEnvironment("missing", {
      writeBehavior: "fail",
      deleteBehavior: "fail",
    });
    const warnings: string[] = [];

    assert.equal(
      await saveToken("dgb_at_new_7777", environment, (text) => warnings.push(text)),
      "file",
    );
    assert.equal(await readFileToken(environment.homeDirectory), "dgb_at_new_7777");
    assert.deepEqual(warnings, []);
  },
);

test(
  "macos warns when a broken keychain leaves an older token unverifiable",
  { skip: onWindows },
  async () => {
    // Every security invocation errors (a locked keychain over SSH): the
    // save must still land in the file store, but never silently — an older
    // keychain token could shadow the file copy once the keychain works.
    const { environment } = fakeMacEnvironment("fail");
    const warnings: string[] = [];

    assert.equal(
      await saveToken("dgb_at_new_7777", environment, (text) => warnings.push(text)),
      "file",
    );
    assert.equal(await readFileToken(environment.homeDirectory), "dgb_at_new_7777");
    const warning = warnings.join("");
    assert.ok(warning.includes("macOS keychain"));
    assert.ok(warning.includes("npx driggsby@latest logout"));
  },
);

test(
  "linux warns when an unreachable keyring leaves an older token unverifiable",
  { skip: onWindows },
  async () => {
    const fake = fakeCredentialToolEnvironment("secret-tool", "fail");
    const environment = fileOnlyEnvironment({ spawnEnv: fake.spawnEnv });
    const warnings: string[] = [];

    assert.equal(
      await saveToken("dgb_at_new_7777", environment, (text) => warnings.push(text)),
      "file",
    );
    const warning = warnings.join("");
    assert.ok(warning.includes("system keyring"));
    assert.ok(warning.includes("npx driggsby@latest logout"));
  },
);

test("clear removes every stored copy and reports what it cleared", async () => {
  const environment = fileOnlyEnvironment();
  await saveToken("dgb_at_file_6666", environment, noWarnings);

  assert.deepEqual(await clearStoredToken(environment), {
    clearedSources: ["file"],
    failedSources: [],
    envTokenStillSet: false,
  });
  assert.equal(await readStoredToken(environment), null);

  assert.deepEqual(await clearStoredToken(environment), {
    clearedSources: [],
    failedSources: [],
    envTokenStillSet: false,
  });
});

test("clear reports a keychain removal on macos", { skip: onWindows }, async () => {
  const { environment } = fakeMacEnvironment("found", { token: "dgb_at_keychain_8888" });
  const result = await clearStoredToken(environment);
  assert.deepEqual(result.clearedSources, ["keychain"]);
  assert.deepEqual(result.failedSources, []);
});

test("clear reports a keychain delete that failed", { skip: onWindows }, async () => {
  const { environment } = fakeMacEnvironment("found", {
    token: "dgb_at_keychain_8888",
    deleteBehavior: "fail",
  });
  const result = await clearStoredToken(environment);
  assert.deepEqual(result.clearedSources, []);
  assert.deepEqual(result.failedSources, ["keychain"]);
});

test("clear flags a DRIGGSBY_TOKEN it cannot remove", async () => {
  const environment = fileOnlyEnvironment({ env: { DRIGGSBY_TOKEN: "dgb_at_env_7777" } });
  const result = await clearStoredToken(environment);
  assert.equal(result.envTokenStillSet, true);
});

test("storage locations are described in plain language", () => {
  assert.equal(describeStorageLocation("keychain"), "your macOS keychain");
  assert.equal(describeStorageLocation("keyring"), "your system keyring");
  assert.equal(describeStorageLocation("file"), "the ~/.driggsby/credentials.json file");
});
