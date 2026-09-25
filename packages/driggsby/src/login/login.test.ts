import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { CliError } from "../cli-error.ts";
import { describeDevice, knownDevice } from "../device.ts";
import { readFileToken, writeFileToken } from "../credentials/file-store.ts";
import { fakeCredentialToolEnvironment } from "../test-support/fake-credential-tool.ts";
import {
  APP_TOKEN,
  type FakeConsentServer,
  type HarnessOptions,
  loginHarness,
  type LoginHarness,
  startConsentServer,
} from "../test-support/fake-consent.ts";
import { assertFitsTerminal } from "../test-support/terminal-width.ts";
import { runLogin } from "./login.ts";
import { runLogout } from "./logout.ts";

// The login tests' one harness: a fake Driggsby and a person who approves
// on the page this CLI opens, unless options say otherwise.
function harness(server: FakeConsentServer | string, options: HarnessOptions = {}): LoginHarness {
  const fake = typeof server === "string" ? offlineServer(server) : server;
  return loginHarness(fake, options);
}

// Logout never reaches a server; its harness only needs a base URL.
function offlineServer(baseUrl: string): FakeConsentServer {
  return { baseUrl, pollResponses: [], claimUrlOrigin: null, claimUrlPath: null, createBodies: [], tradeBodies: [] };
}

test("login hands the code over the loopback, trades it with the verifier, and stores the token", async () => {
  const server = await startConsentServer();
  const login = harness(server);

  await runLogin(login.environment, login.io);

  assert.equal(await readFileToken(login.environment.homeDirectory), APP_TOKEN);
  // The page this CLI opened carries the handoff; the printed link never does.
  assert.deepEqual(login.openedUrls, [`${server.baseUrl}/connect/claim-1?handoff=loopback`]);
  const text = login.output();
  assert.ok(text.includes(`  ${server.baseUrl}/connect/claim-1\n`));
  assert.ok(!text.includes("handoff"));
  assert.ok(text.includes("Waiting for your approval"));
  assert.ok(text.includes("Approved."));
  assert.ok(text.includes("~/.driggsby/credentials.json"));
  assert.ok(text.includes("Next:"));
  assert.ok(!text.includes(APP_TOKEN), "the token must never be printed");
  assertFitsTerminal(text);
  // The browser waited on the loopback, then went back to Driggsby's page,
  // which by then says the sign-in is done.
  assert.deepEqual(await login.browserLanding, { status: 303, location: `${server.baseUrl}/connect/claim-1` });
});

test("login names this computer in its sign-in request, with only what it knows", async () => {
  const server = await startConsentServer();
  const { environment, io } = harness(server);

  await runLogin(environment, io);

  const known = knownDevice(describeDevice());
  const body = server.createBodies[0];
  assert.equal(server.createBodies.length, 1);
  assert.ok(body !== undefined);
  assert.deepEqual(body.device, known ?? undefined);
  assert.equal(body.app_name, "Driggsby CLI");
  assert.equal(body.scope, "driggsby.cli");
});

test("login fails with a friendly retry when the claim is gone", async () => {
  const server = await startConsentServer();
  server.pollResponses.push({ status: 200, body: { status: "gone", note: "server note" } });
  const { environment, io } = harness(server, { browser: "idle" });

  await assert.rejects(runLogin(environment, io), (error: unknown) => {
    assert.ok(error instanceof CliError);
    assert.equal(error.exitCode, 1);
    assert.ok(error.message.includes("npx driggsby@latest login"));
    assertFitsTerminal(error.message);
    return true;
  });
});

test("login gives up politely when the link expires unapproved", async () => {
  const server = await startConsentServer();
  // Every poll stays pending; the injected clock advances 4 s per sleep, so
  // the 600 s expiry passes after ~150 polls.
  const { environment, io } = harness(server, { browser: "idle" });

  await assert.rejects(runLogin(environment, io), (error: unknown) => {
    assert.ok(error instanceof CliError);
    assert.ok(error.message.includes("expired"));
    assert.ok(error.message.includes("npx driggsby@latest login"));
    assertFitsTerminal(error.message);
    return true;
  });
});

test("a claim URL with terminal control bytes is normalized before printing", async () => {
  const server = await startConsentServer();
  // The URL parser percent-encodes the ESC byte; the raw server string is
  // never printed or handed to the opener.
  server.claimUrlPath = "/connect/claim-1\u001b[2K";
  const { environment, io, output, openedUrls } = harness(server);

  await runLogin(environment, io);

  assert.ok(!output().includes("\u001b"), "no raw escape byte may reach the terminal");
  assert.ok(openedUrls[0]?.includes("%1B"));
});

test("login refuses a claim URL on a foreign origin", async () => {
  const server = await startConsentServer();
  server.claimUrlOrigin = "https://evil.example";
  const { environment, io, openedUrls } = harness(server);

  await assert.rejects(runLogin(environment, io), CliError);
  assert.deepEqual(openedUrls, []);
});

test("login refuses a claim URL that carries userinfo credentials", async () => {
  // URL.origin ignores user:pass@, so this passes an origin-only check while
  // rendering a misleading link; it must be rejected outright.
  const server = await startConsentServer();
  const { environment, io, openedUrls } = harness(server);
  const serverHostPort = server.baseUrl.replace("http://", "");
  server.claimUrlOrigin = `http://user:secret@${serverHostPort}`;

  await assert.rejects(runLogin(environment, io), CliError);
  assert.deepEqual(openedUrls, []);
});

test("a shadowing DRIGGSBY_TOKEN is the last word, not a scrolled-away note", async () => {
  const server = await startConsentServer();
  const { environment, io, output } = harness(server, { extraEnv: { DRIGGSBY_TOKEN: "dgb_at_env_9999" } });

  await runLogin(environment, io);

  // The note lands after the approval line and replaces the closer — the
  // closer's "will use this saved token" would be false while the env token
  // outranks the saved one.
  const text = output();
  const approvedAt = text.indexOf("Approved.");
  const noteAt = text.indexOf("Note: DRIGGSBY_TOKEN");
  assert.ok(approvedAt !== -1);
  assert.ok(noteAt > approvedAt, "the note must come after the approval line");
  assert.ok(!text.includes("You're all set"));
});

test("logout removes the saved token and reports where it was", async () => {
  const server = await startConsentServer();
  const { environment, io } = harness(server);
  await runLogin(environment, io);

  const written: string[] = [];
  assert.equal(await runLogout(environment, (text) => written.push(text)), 0);

  assert.equal(await readFileToken(environment.homeDirectory), null);
  const text = written.join("");
  assert.ok(text.includes("Signed out."));
  assert.ok(text.includes("~/.driggsby/credentials.json"));
  assertFitsTerminal(text);
});

test("logout with nothing saved says so instead of failing", async () => {
  const { environment } = harness("http://127.0.0.1:1");
  const written: string[] = [];
  assert.equal(await runLogout(environment, (text) => written.push(text)), 0);
  assert.ok(written.join("").includes("nothing to remove"));
});

test("logout points out a DRIGGSBY_TOKEN it cannot unset itself", async () => {
  // Without this note a user would read "nothing to remove", see the prompt
  // return 0, and stay authenticated through the env var with no signal.
  const { environment } = harness("http://127.0.0.1:1", { extraEnv: { DRIGGSBY_TOKEN: "dgb_at_env_9999" } });
  const written: string[] = [];
  assert.equal(await runLogout(environment, (text) => written.push(text)), 0);
  const text = written.join("");
  assert.ok(text.includes("Note: DRIGGSBY_TOKEN is set in this environment and still works"));
  assert.ok(text.includes("Unset it"));
});

test(
  "logout says so and exits nonzero when a keychain delete fails",
  { skip: process.platform === "win32" },
  async () => {
    const fake = fakeCredentialToolEnvironment("security", "found", {
      token: APP_TOKEN,
      deleteBehavior: "fail",
    });
    const { environment } = harness("http://127.0.0.1:1");
    environment.platform = "darwin";
    environment.spawnEnv = fake.spawnEnv;
    environment.securityProgram = fake.toolPath;
    // A file copy alongside the stuck keychain item: the partial outcome must
    // report the successful removal AND the failure, never just one of them.
    await writeFileToken(environment.homeDirectory, APP_TOKEN);

    const written: string[] = [];
    assert.equal(await runLogout(environment, (text) => written.push(text)), 1);
    const text = written.join("");
    assert.ok(text.includes("was removed from"));
    assert.ok(text.includes("~/.driggsby/credentials.json"));
    assert.ok(text.includes("may still be saved"));
    assert.ok(text.includes("your macOS keychain"));
    assert.ok(!text.includes("nothing to remove"));
    assertFitsTerminal(text);
  },
);

test(
  "logout never claims a clean no-op when the linux keyring is unreachable",
  { skip: process.platform === "win32" },
  async () => {
    // The lookup errors (no session bus, locked keyring): a live token may
    // still be in the keyring, so "nothing to remove" would be false.
    const fake = fakeCredentialToolEnvironment("secret-tool", "fail");
    const { environment } = harness("http://127.0.0.1:1");
    environment.platform = "linux";
    environment.spawnEnv = fake.spawnEnv;

    const written: string[] = [];
    assert.equal(await runLogout(environment, (text) => written.push(text)), 1);
    const text = written.join("");
    assert.ok(text.includes("may still be saved"));
    assert.ok(text.includes("your system keyring"));
    assert.ok(!text.includes("nothing to remove"));
  },
);

test(
  "a keychain warning lands after the approval line and replaces the all-set closer",
  { skip: process.platform === "win32" },
  async () => {
    const server = await startConsentServer();
    // Every security invocation errors: the save falls back to the file with
    // a warning, and that warning must be the last word — never followed by
    // copy asserting the saved token will be used.
    const fake = fakeCredentialToolEnvironment("security", "fail");
    const { environment, io, output } = harness(server);
    environment.platform = "darwin";
    environment.spawnEnv = fake.spawnEnv;
    environment.securityProgram = fake.toolPath;

    await runLogin(environment, io);

    const text = output();
    const approvedAt = text.indexOf("Approved.");
    const noteAt = text.indexOf("Note: we couldn't check your macOS keychain");
    assert.ok(approvedAt !== -1);
    assert.ok(noteAt > approvedAt, "the warning must come after the approval line");
    assert.ok(!text.includes("You're all set"));
    assert.equal(await readFileToken(environment.homeDirectory), APP_TOKEN);
  },
);

test("login reports a token that could not be saved instead of a generic error", async () => {
  const server = await startConsentServer();
  const { environment, io } = harness(server);
  // A home directory path under a regular file: the credential write fails.
  const blockingFile = join(mkdtempSync(join(tmpdir(), "driggsby-login-")), "not-a-directory");
  writeFileSync(blockingFile, "");
  environment.homeDirectory = join(blockingFile, "home");

  await assert.rejects(runLogin(environment, io), (error: unknown) => {
    assert.ok(error instanceof CliError);
    assert.ok(error.message.includes("couldn't save"));
    assert.ok(error.message.includes("npx driggsby@latest login"));
    assert.ok(!error.message.includes(APP_TOKEN), "the token must never be printed");
    return true;
  });
});
