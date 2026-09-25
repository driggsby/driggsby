import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { CliError } from "../cli-error.ts";
import { readFileToken } from "../credentials/file-store.ts";
import { APP_TOKEN, APPROVAL_CODE, loginHarness, startConsentServer } from "../test-support/fake-consent.ts";
import { assertFitsTerminal } from "../test-support/terminal-width.ts";
import { runLogin, runLoginWithCode } from "./login.ts";
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
  assert.equal(existsSync(pendingFile(login.environment.homeDirectory)), false);
  assert.ok(login.output().includes("Approved."));
  assert.ok(!login.output().includes(APP_TOKEN));
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

test("a code Driggsby refuses at the loopback ends the sign-in, and the browser still goes back", async () => {
  const server = await startConsentServer();
  // The approval's one code was already spent.
  server.tradeBodies.push({ code: APPROVAL_CODE });
  const login = loginHarness(server);

  await assert.rejects(runLogin(login.environment, login.io), (error: unknown) => {
    assert.ok(error instanceof CliError);
    assert.ok(error.message.includes("didn't work"));
    return true;
  });
  assert.deepEqual(await login.browserLanding, { status: 303, location: `${server.baseUrl}/connect/claim-1` });
  assert.equal(await readFileToken(login.environment.homeDirectory), null);
});
