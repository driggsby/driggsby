import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { CliError } from "../cli-error.ts";
import { readFileToken, writeFileToken } from "../credentials/file-store.ts";
import { type CredentialEnvironment } from "../credentials/store.ts";
import { fakeCredentialToolEnvironment } from "../test-support/fake-credential-tool.ts";
import { assertFitsTerminal } from "../test-support/terminal-width.ts";
import { type LoginIo, runLogin } from "./login.ts";
import { runLogout } from "./logout.ts";

const APP_TOKEN = "dgb_at_test_1111";

interface FakeConsentServer {
  baseUrl: string;
  pollResponses: { status: number; body: unknown }[];
  claimUrlOrigin: string | null;
  claimUrlPath: string | null;
}

const servers: Server[] = [];
after(() => {
  for (const server of servers) {
    server.close();
  }
});

// A fake of the two claim endpoints: create answers with a claim on this
// server's own origin (or an attacker origin when claimUrlOrigin overrides
// it), and each poll shifts the next scripted response.
function startConsentServer(): Promise<FakeConsentServer> {
  const fake: FakeConsentServer = {
    baseUrl: "",
    pollResponses: [],
    claimUrlOrigin: null,
    claimUrlPath: null,
  };
  const server = createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      if (request.url === "/app-tokens/claim-requests") {
        response.writeHead(201, { "Content-Type": "application/json" });
        response.end(
          JSON.stringify({
            claim_request_id: "claim-1",
            claim_url: `${fake.claimUrlOrigin ?? fake.baseUrl}${fake.claimUrlPath ?? "/connect/claim-1"}`,
            poll_secret: "secret-1",
            poll_url: `${fake.baseUrl}/app-tokens/claim-requests/poll`,
            expires_in: 600,
          }),
        );
        return;
      }
      const next = fake.pollResponses.shift() ?? { status: 200, body: { status: "pending" } };
      response.writeHead(next.status, { "Content-Type": "application/json" });
      response.end(JSON.stringify(next.body));
    });
  });
  servers.push(server);
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        throw new Error("no server address");
      }
      fake.baseUrl = `http://127.0.0.1:${address.port}`;
      resolve(fake);
    });
  });
}

interface TestHarness {
  environment: CredentialEnvironment;
  io: LoginIo;
  output: () => string;
  openedUrls: string[];
}

function harness(baseUrl: string, extraEnv: NodeJS.ProcessEnv = {}): TestHarness {
  const written: string[] = [];
  const openedUrls: string[] = [];
  let clock = 0;
  const environment: CredentialEnvironment = {
    // win32 forces the file store, which works on every CI platform.
    platform: "win32",
    env: { DRIGGSBY_BASE_URL: baseUrl, ...extraEnv },
    homeDirectory: mkdtempSync(join(tmpdir(), "driggsby-login-")),
  };
  const io: LoginIo = {
    out: (text) => written.push(text),
    openUrl: (url) => {
      openedUrls.push(url);
      return Promise.resolve(true);
    },
    sleep: (ms) => {
      clock += ms;
      return Promise.resolve();
    },
    now: () => clock,
    pollIntervalMs: 4000,
  };
  return { environment, io, output: () => written.join(""), openedUrls };
}

test("login walks create → poll → approved and stores the token", async () => {
  const server = await startConsentServer();
  server.pollResponses.push(
    { status: 200, body: { status: "pending" } },
    { status: 503, body: { error: "temporarily_unavailable", error_description: "momentary" } },
    { status: 200, body: { status: "approved", app_token: APP_TOKEN, mcp_url: "x" } },
  );
  const { environment, io, output, openedUrls } = harness(server.baseUrl);

  await runLogin(environment, io);

  assert.equal(await readFileToken(environment.homeDirectory), APP_TOKEN);
  assert.deepEqual(openedUrls, [`${server.baseUrl}/connect/claim-1`]);
  const text = output();
  assert.ok(text.includes(`${server.baseUrl}/connect/claim-1`));
  assert.ok(text.includes("Waiting for your approval"));
  assert.ok(text.includes("Approved."));
  assert.ok(text.includes("~/.driggsby/credentials.json"));
  assert.ok(text.includes("Next:"));
  assert.ok(!text.includes(APP_TOKEN), "the token must never be printed");
  assertFitsTerminal(text);
});

test("login fails with a friendly retry when the claim is gone", async () => {
  const server = await startConsentServer();
  server.pollResponses.push({ status: 200, body: { status: "gone", note: "server note" } });
  const { environment, io } = harness(server.baseUrl);

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
  const { environment, io } = harness(server.baseUrl);

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
  server.pollResponses.push({
    status: 200,
    body: { status: "approved", app_token: APP_TOKEN, mcp_url: "x" },
  });
  const { environment, io, output, openedUrls } = harness(server.baseUrl);

  await runLogin(environment, io);

  assert.ok(!output().includes("\u001b"), "no raw escape byte may reach the terminal");
  assert.ok(openedUrls[0]?.includes("%1B"));
});

test("login refuses a claim URL on a foreign origin", async () => {
  const server = await startConsentServer();
  server.claimUrlOrigin = "https://evil.example";
  const { environment, io, openedUrls } = harness(server.baseUrl);

  await assert.rejects(runLogin(environment, io), CliError);
  assert.deepEqual(openedUrls, []);
});

test("login refuses a claim URL that carries userinfo credentials", async () => {
  // URL.origin ignores user:pass@, so this passes an origin-only check while
  // rendering a misleading link; it must be rejected outright.
  const server = await startConsentServer();
  const { environment, io, openedUrls } = harness(server.baseUrl);
  const serverHostPort = server.baseUrl.replace("http://", "");
  server.claimUrlOrigin = `http://user:secret@${serverHostPort}`;

  await assert.rejects(runLogin(environment, io), CliError);
  assert.deepEqual(openedUrls, []);
});

test("a shadowing DRIGGSBY_TOKEN is the last word, not a scrolled-away note", async () => {
  const server = await startConsentServer();
  server.pollResponses.push({
    status: 200,
    body: { status: "approved", app_token: APP_TOKEN, mcp_url: "x" },
  });
  const { environment, io, output } = harness(server.baseUrl, { DRIGGSBY_TOKEN: "dgb_at_env_9999" });

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
  server.pollResponses.push({
    status: 200,
    body: { status: "approved", app_token: APP_TOKEN, mcp_url: "x" },
  });
  const { environment, io } = harness(server.baseUrl);
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
  const { environment } = harness("http://127.0.0.1:1", { DRIGGSBY_TOKEN: "dgb_at_env_9999" });
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
    server.pollResponses.push({
      status: 200,
      body: { status: "approved", app_token: APP_TOKEN, mcp_url: "x" },
    });
    // Every security invocation errors: the save falls back to the file with
    // a warning, and that warning must be the last word — never followed by
    // copy asserting the saved token will be used.
    const fake = fakeCredentialToolEnvironment("security", "fail");
    const { environment, io, output } = harness(server.baseUrl);
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
  server.pollResponses.push({
    status: 200,
    body: { status: "approved", app_token: APP_TOKEN, mcp_url: "x" },
  });
  const { environment, io } = harness(server.baseUrl);
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
