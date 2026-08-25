import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
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
  const io = probingIo(async (openedUrl) => {
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
  assert.ok(text.includes("Press Ctrl+C to stop."));
  assert.ok(text.includes("npx driggsby@latest deploy"));
  assertFitsTerminal(text);
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
