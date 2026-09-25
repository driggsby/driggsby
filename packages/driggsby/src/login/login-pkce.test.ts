import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { CliError } from "../cli-error.ts";
import { readFileToken } from "../credentials/file-store.ts";
import { APP_TOKEN, APPROVAL_CODE, loginHarness, startConsentServer } from "../test-support/fake-consent.ts";
import { assertFitsTerminal } from "../test-support/terminal-width.ts";
import { FINISH_MARK_WAIT_MS, runLogin, runLoginWithCode } from "./login.ts";
import { readPendingLogin } from "./pending.ts";
import { challengeFor } from "./pkce.ts";

function pendingFile(homeDirectory: string): string {
  return join(homeDirectory, ".driggsby", "pending-login.json");
}

test("the claim carries the S256 challenge of the verifier later traded, and this CLI's loopback", async () => {
  const server = await startConsentServer();
  const login = loginHarness(server);

  await runLogin(login.environment, login.io);

  const claim = server.createBodies[0];
  const trade = server.tradeBodies[0];
  assert.ok(claim !== undefined && trade !== undefined);
  assert.equal(claim.code_challenge_method, "S256");
  assert.match(String(claim.redirect_uri), /^http:\/\/127\.0\.0\.1:\d+\/callback$/);
  assert.equal(claim.code_challenge, challengeFor(String(trade.code_verifier)));
  assert.equal(trade.claim_request_id, "claim-1");
  assert.equal(trade.code, APPROVAL_CODE);
  // A finished sign-in leaves nothing waiting behind.
  assert.equal(existsSync(pendingFile(login.environment.homeDirectory)), false);
});

test("a code pasted at the prompt signs in, and a mistyped one asks again", async () => {
  const server = await startConsentServer();
  const login = loginHarness(server, { loopback: false, typed: ["7KQ2M-WRONG-CODE0-00000", APPROVAL_CODE.toLowerCase()] });

  await runLogin(login.environment, login.io);

  assert.equal(await readFileToken(login.environment.homeDirectory), APP_TOKEN);
  // Without a loopback, the page this CLI opens shows the code instead.
  assert.deepEqual(login.openedUrls, [`${server.baseUrl}/connect/claim-1`]);
  assert.equal(server.createBodies[0]?.redirect_uri, undefined);
  assert.equal(login.questions.length, 2);
  assert.ok(login.questions[0]?.includes("paste it here"));
  assert.ok(login.questions[1]?.includes("Check the code and paste it again"));
  assert.ok(!login.output().includes(APP_TOKEN));
  assertFitsTerminal(login.output());
});

test("an agent with no browser and no prompt gets the link and --code, and finishes with it", async () => {
  const server = await startConsentServer();
  const login = loginHarness(server, { browser: "unavailable", typed: null });

  await runLogin(login.environment, login.io);

  const text = login.output();
  assert.ok(text.includes(`  ${server.baseUrl}/connect/claim-1\n`));
  assert.ok(text.includes("npx driggsby@latest login --code <CODE>"));
  assert.ok(!text.includes("Waiting for your approval"));
  assertFitsTerminal(text);
  assert.equal(await readFileToken(login.environment.homeDirectory), null);
  assert.equal(existsSync(pendingFile(login.environment.homeDirectory)), true);

  // A wrong code is refused and the sign-in keeps waiting for the right one.
  await assert.rejects(runLoginWithCode("00000-00000-00000-00000", login.environment, login.io), (error: unknown) => {
    assert.ok(error instanceof CliError);
    assert.ok(error.message.includes("didn't work"));
    assertFitsTerminal(error.message);
    return true;
  });
  assert.equal(existsSync(pendingFile(login.environment.homeDirectory)), true);

  await runLoginWithCode(` ${APPROVAL_CODE} `, login.environment, login.io);

  assert.equal(await readFileToken(login.environment.homeDirectory), APP_TOKEN);
  assert.ok(login.output().includes("Approved."));
  assert.ok(!login.output().includes(APP_TOKEN));
  // The record now says finished, so the code can't be tried again here.
  await assert.rejects(runLoginWithCode(APPROVAL_CODE, login.environment, login.io), (error: unknown) => {
    assert.ok(error instanceof CliError);
    assert.ok(error.message.includes("already finished"));
    return true;
  });
});

test("the trade that spends the claim wins even when a poll reads gone first", async () => {
  const server = await startConsentServer();
  // The claim is spent as the trade lands; its answer arrives a moment
  // after, while polls already read gone.
  server.tradeReplyDelayMs = 60;
  const login = loginHarness(server);

  await runLogin(login.environment, login.io);

  assert.equal(await readFileToken(login.environment.homeDirectory), APP_TOKEN);
  assert.ok(login.output().includes("Approved."));
});

test("a pasted link, or anything too long to be a code, asks again without a trade", async () => {
  const server = await startConsentServer();
  const link = `${server.baseUrl}/connect/11111111-2222-3333-4444-555555555555?handoff=none`;
  const login = loginHarness(server, { loopback: false, typed: [link, APPROVAL_CODE] });

  await runLogin(login.environment, login.io);

  assert.equal(await readFileToken(login.environment.homeDirectory), APP_TOKEN);
  assert.deepEqual(server.tradeBodies.map((trade) => trade.code), [APPROVAL_CODE]);
  assert.ok(login.questions[1]?.includes("doesn't look like a sign-in code"));
});

test("a loopback code keeps being tried while Driggsby can't be reached", async () => {
  const server = await startConsentServer();
  server.tradeFailures = 4;
  const login = loginHarness(server);

  await runLogin(login.environment, login.io);

  assert.equal(await readFileToken(login.environment.homeDirectory), APP_TOKEN);
  assert.equal(server.tradeFailures, 0);
});

test("a server older than PKCE that hands the poll the token still signs in", async () => {
  const server = await startConsentServer();
  server.pollResponses.push({ status: 200, body: { status: "approved", app_token: APP_TOKEN, mcp_url: "x" } });
  const login = loginHarness(server, { browser: "idle" });

  await runLogin(login.environment, login.io);

  assert.equal(await readFileToken(login.environment.homeDirectory), APP_TOKEN);
});

test("--code with nothing waiting on this computer says how to start", async () => {
  const server = await startConsentServer();
  const login = loginHarness(server);

  await assert.rejects(runLoginWithCode(APPROVAL_CODE, login.environment, login.io), (error: unknown) => {
    assert.ok(error instanceof CliError);
    assert.ok(error.message.includes("No sign-in is waiting"));
    assert.ok(error.message.includes("npx driggsby@latest login"));
    return true;
  });
  assert.equal(server.tradeBodies.length, 0);
});

test("--code never sends a waiting sign-in's verifier to a different Driggsby", async () => {
  const server = await startConsentServer();
  const other = await startConsentServer();
  const login = loginHarness(server, { browser: "unavailable", typed: null });
  await runLogin(login.environment, login.io);

  const elsewhere = loginHarness(other);
  elsewhere.environment.homeDirectory = login.environment.homeDirectory;
  await assert.rejects(runLoginWithCode(APPROVAL_CODE, elsewhere.environment, elsewhere.io), CliError);

  assert.equal(other.tradeBodies.length, 0);
});

test("a denial on the approval page ends the sign-in and sends the browser back", async () => {
  const server = await startConsentServer();
  const login = loginHarness(server, { browser: "denies" });

  // Whichever hears it first, the loopback's confirmed denial or the poll,
  // the sign-in ends with a fresh start to try.
  await assert.rejects(runLogin(login.environment, login.io), (error: unknown) => {
    assert.ok(error instanceof CliError);
    assert.ok(error.message.includes("declined"));
    assert.ok(error.message.includes("npx driggsby@latest login"));
    return true;
  });
  assert.deepEqual(await login.browserLanding, { status: 303, location: `${server.baseUrl}/connect/claim-1` });
  assert.equal(server.tradeBodies.length, 0);
  assert.equal(await readFileToken(login.environment.homeDirectory), null);
});

test("a forged denial or a bogus code at the loopback never ends the sign-in", async () => {
  const server = await startConsentServer();
  // Some other page on this computer knocks first: Driggsby still reads the
  // claim as pending, and the bogus code doesn't trade.
  const login = loginHarness(server, { knocks: ["error=access_denied", "code=BOGUS-00000-00000-00000"] });

  await runLogin(login.environment, login.io);

  assert.equal(await readFileToken(login.environment.homeDirectory), APP_TOKEN);
  assert.deepEqual(
    server.tradeBodies.map((trade) => trade.code),
    ["BOGUS-00000-00000-00000", APPROVAL_CODE],
  );
});

test("a late approval finished by --code in another command is a sign-in, not a failure", async () => {
  const server = await startConsentServer();
  const late = gate();
  const spent = gate();
  const paused = gate();
  const codeDone = gate();
  // Each step waits for the one before it, so the order is fixed:
  // 1. the link's own 600 s pass with the claim still pending (approved,
  //    waiting for its code), and the waiting login's polls hold there;
  // 2. --code's trade spends the claim, and its reply is held;
  // 3. the waiting login's poll reads gone before --code has marked the
  //    record, so it pauses to look again;
  // 4. --code gets its reply, marks the record finished, saves the token;
  // 5. the pause ends and the waiting login reads the mark.
  server.onTradeSpent = async () => {
    spent.open();
    await paused.opened;
  };
  const login = loginHarness(server, {
    loopback: false,
    typed: [],
    beforeSleep: async (ms, now) => {
      if (ms === FINISH_MARK_WAIT_MS) {
        paused.open();
        await codeDone.opened;
      } else if (now >= 620_000) {
        late.open();
        await spent.opened;
      }
    },
  });
  const waiting = runLogin(login.environment, login.io);
  await late.opened;
  const record = await readPendingLogin(login.environment.homeDirectory, login.io.now());
  assert.ok(record !== null, "the waiting sign-in outlives the link by the code window");

  await runLoginWithCode(APPROVAL_CODE, login.environment, login.io);
  codeDone.open();
  await waiting;

  assert.equal(await readFileToken(login.environment.homeDirectory), APP_TOKEN);
  const text = login.output();
  assert.ok(text.includes("This sign-in was finished by npx driggsby@latest login --code"));
  assert.ok(!text.includes("no longer active"));
  assertFitsTerminal(text);
  assert.equal(existsSync(pendingFile(login.environment.homeDirectory)), false);
});

test("over SSH or in a cloud dev box, the page this CLI opens shows the code instead", async () => {
  for (const name of ["SSH_CONNECTION", "SSH_TTY", "CODESPACES", "GITPOD_WORKSPACE_ID"]) {
    const server = await startConsentServer();
    const login = loginHarness(server, { extraEnv: { [name]: "1" }, typed: [APPROVAL_CODE] });

    await runLogin(login.environment, login.io);

    assert.equal(await readFileToken(login.environment.homeDirectory), APP_TOKEN, name);
    assert.equal(server.createBodies[0]?.redirect_uri, undefined, name);
    assert.deepEqual(login.openedUrls, [`${server.baseUrl}/connect/claim-1`], name);
  }
});

// A promise the test opens by hand, to order steps without timers.
function gate(): { opened: Promise<void>; open: () => void } {
  let open: () => void = () => undefined;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { opened, open };
}
