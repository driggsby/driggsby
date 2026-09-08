import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { test } from "node:test";

import { CliError } from "../cli-error.ts";
import {
  capturedOut,
  makeEnvironment,
  makeProject,
} from "../deploy/test-support/deploy-command-harness.ts";
import { assertFitsTerminal } from "../test-support/terminal-width.ts";
import { type DevCommandIo, runDev } from "./dev-command.ts";
import { type DevState, readLiveDevState, writeDevState } from "./dev-state.ts";

// The dev loopback base URL keeps the saved-sign-in pin satisfied; nothing
// in these tests ever reaches it.
const LOOPBACK_BASE_URL = "http://127.0.0.1:9";

interface ProbeIo extends DevCommandIo {
  text: () => string;
  openedUrls: string[];
}

// An io whose shutdown waits until `probe` has run against the live servers.
function probingIo(probe: (openedUrl: string) => Promise<void>): ProbeIo {
  const captured = capturedOut();
  const openedUrls: string[] = [];
  let release: () => void = () => undefined;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    out: captured.out,
    text: captured.text,
    openedUrls,
    openUrl: async (url) => {
      openedUrls.push(url);
      // The servers are up once the CLI tries to open the page.
      await probe(url);
      release();
      return true;
    },
    waitForShutdown: () => released,
  };
}

test("dev serves the project and the host page end to end, then shuts down", async () => {
  const directory = await makeProject("money-dash", {
    "index.html": "<h1>the dev app</h1>",
  });
  const environment = await makeEnvironment(LOOPBACK_BASE_URL);

  let probedHostHtml = "";
  let probedAppHtml = "";
  const statesWhileRunning: DevState[] = [];
  const io = probingIo(async (openedUrl) => {
    const state = await readLiveDevState(environment.homeDirectory);
    if (state !== null) {
      statesWhileRunning.push(state);
    }
    const hostResponse = await fetch(openedUrl);
    probedHostHtml = await hostResponse.text();
    const appOriginMatch = /src="(http:\/\/127\.0\.0\.1:\d+)\//.exec(probedHostHtml);
    assert.ok(appOriginMatch !== null, "the host page must embed an app origin");
    const appResponse = await fetch(`${appOriginMatch[1] ?? ""}/`);
    probedAppHtml = await appResponse.text();
  });

  const exitCode = await runDev(
    { projectDirectory: directory, hostPort: 0, appPort: 0 },
    environment,
    io,
  );

  assert.equal(exitCode, 0);
  assert.equal(probedAppHtml, "<h1>the dev app</h1>");
  assert.ok(probedHostHtml.includes("money-dash"));
  const text = io.text();
  assert.ok(text.includes("✓ Ready     money-dash is running with your live Driggsby data"));
  // Both addresses are named, and the one to open comes first.
  const hostOrigin = io.openedUrls[0] ?? "";
  const appOrigin = /src="(http:\/\/127\.0\.0\.1:\d+)\//.exec(probedHostHtml)?.[1] ?? "";
  assert.ok(text.indexOf(hostOrigin) < text.indexOf(appOrigin));
  assert.ok(text.includes("no Driggsby data"));
  assert.ok(text.includes("npx driggsby@latest dev --stop"));
  assert.ok(text.includes("npx driggsby@latest deploy"));
  assertFitsTerminal(text);
  // The run recorded itself while alive and cleaned up on the way out.
  const stateWhileRunning = statesWhileRunning[0];
  assert.ok(stateWhileRunning !== undefined);
  assert.equal(stateWhileRunning.pid, process.pid);
  assert.equal(stateWhileRunning.folder, directory);
  assert.equal(stateWhileRunning.hostPort, Number(new URL(hostOrigin).port));
  assert.equal(await readLiveDevState(environment.homeDirectory), null);
});

test("dev stops itself after the idle window with no page open", async () => {
  const directory = await makeProject("money-dash");
  const environment = await makeEnvironment(LOOPBACK_BASE_URL);
  const captured = capturedOut();
  const io: DevCommandIo = {
    out: captured.out,
    openUrl: () => Promise.resolve(false),
    // Nobody presses Ctrl+C; only the idle exit can end the run.
    waitForShutdown: () => new Promise<void>(() => undefined),
  };

  const exitCode = await runDev(
    { projectDirectory: directory, hostPort: 0, appPort: 0, idleTimeoutMs: 40, idleCheckMs: 5 },
    environment,
    io,
  );

  assert.equal(exitCode, 0);
  assert.ok(captured.text().includes("✓ Stopped   No page was open"));
  assert.ok(captured.text().includes("npx driggsby@latest dev"));
  assert.equal(await readLiveDevState(environment.homeDirectory), null);
  assertFitsTerminal(captured.text());
});

test("a port held by another driggsby dev names that dev's folder and how to stop it", async () => {
  const directory = await makeProject("money-dash");
  const environment = await makeEnvironment(LOOPBACK_BASE_URL);
  // Another dev on this machine (this very process stands in for it).
  await writeDevState(environment.homeDirectory, {
    pid: process.pid, folder: "/Users/someone/other-app", startedAt: new Date().toISOString(), hostPort: 4111, appPort: 4112,
  });
  const squatter = createServer();
  await new Promise<void>((resolve) => {
    squatter.listen(0, "127.0.0.1", resolve);
  });
  const address = squatter.address();
  assert.ok(address !== null && typeof address !== "string");
  try {
    const error = await runDev(
      { projectDirectory: directory, hostPort: address.port, appPort: 0 },
      environment,
      probingIo(() => Promise.resolve()),
    ).then(
      () => assert.fail("must not start"),
      (thrown: unknown) => thrown,
    );
    assert.ok(error instanceof CliError);
    assert.ok(error.message.includes("\"/Users/someone/other-app\""));
    assert.ok(error.message.includes("npx driggsby@latest dev --stop"));
    assertFitsTerminal(error.message);
    // The other dev's record is untouched by the one that failed to start.
    assert.notEqual(await readLiveDevState(environment.homeDirectory), null);
  } finally {
    await new Promise<void>((resolve) => {
      squatter.close(() => {
        resolve();
      });
    });
  }
});

test("dev without a sign-in points at login before starting anything", async () => {
  const directory = await makeProject("money-dash");
  const environment = await makeEnvironment(LOOPBACK_BASE_URL, { signedIn: false });

  const error = await runDev(
    { projectDirectory: directory, hostPort: 0, appPort: 0 },
    environment,
    probingIo(() => Promise.resolve()),
  ).then(
    () => assert.fail("must not start"),
    (thrown: unknown) => thrown,
  );

  assert.ok(error instanceof CliError);
  assert.ok(error.message.includes("npx driggsby@latest login"));
});

test("dev refuses a driggsby.json with dev_command, naming the alternative", async () => {
  const directory = await makeProject("money-dash");
  await writeFile(
    join(directory, "driggsby.json"),
    JSON.stringify({ slug: "money-dash", serve: ".", dev_command: "npm run dev" }),
  );
  const environment = await makeEnvironment(LOOPBACK_BASE_URL);

  const error = await runDev(
    { projectDirectory: directory, hostPort: 0, appPort: 0 },
    environment,
    probingIo(() => Promise.resolve()),
  ).then(
    () => assert.fail("must not start"),
    (thrown: unknown) => thrown,
  );

  assert.ok(error instanceof CliError);
  assert.ok(error.message.includes("dev_command"));
  assert.ok(error.message.includes("npx driggsby@latest deploy"));
  assertFitsTerminal(error.message);
});
