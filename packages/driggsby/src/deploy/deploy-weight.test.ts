import assert from "node:assert/strict";
import { test } from "node:test";

import { assertFitsTerminal } from "../test-support/terminal-width.ts";
import { runDeploy } from "./deploy-command.ts";
import {
  capturedOut,
  makeEnvironment,
  makeProject,
  startFakeDeployServer,
} from "./test-support/deploy-command-harness.ts";

// A fixed clock: the upload duration is deterministic ("under a second").
const FIXED_NOW = { now: () => 0 };

// Driggsby's Dashboards page runs every dashboard live in its tile, so a
// heavy page opens slowly there; the deploy says so past 1 MB. A source
// map never loads with the page, so it doesn't count.
test("an app past 1 MB deploys with a note on its weight; source maps don't count", async () => {
  const server = await startFakeDeployServer();
  try {
    const heavy = await makeProject("money-dash", {
      "index.html": "<h1>hi</h1>",
      "app.js": "x".repeat(1_200_000),
    });
    const environment = await makeEnvironment(server.baseUrl);
    const io = capturedOut();

    const exitCode = await runDeploy({ preview: false, projectDirectory: heavy }, environment, { out: io.out, ...FIXED_NOW });

    assert.equal(exitCode, 0);
    const text = io.text();
    // Wrapped at the terminal's width: read as one line.
    const prose = text.replace(/\s+/g, " ");
    assert.match(prose, /Note: this app is 1\.2 MB\./);
    assert.ok(prose.includes("past 1 MB it opens there slowly. Keep what the page loads under 1 MB."));
    assert.ok(text.indexOf("Note: this app is") < text.indexOf("Next:"));
    assertFitsTerminal(text);

    const deployed = async (files: Record<string, string>): Promise<string> => {
      const directory = await makeProject("money-dash", files);
      const out = capturedOut();
      assert.equal(await runDeploy({ preview: false, projectDirectory: directory }, environment, { out: out.out, ...FIXED_NOW }), 0);
      return out.text().replace(/\s+/g, " ");
    };
    // index.html is 11 bytes.
    const page = "<h1>hi</h1>";
    assert.ok(!(await deployed({ "index.html": page, "app.js": "x".repeat(900_000), "app.js.map": "x".repeat(900_000) })).includes("Note: this app is"),
      "900 KB with its map is under the budget");
    assert.ok(!(await deployed({ "index.html": page, "app.js": "x".repeat(900_000), "APP.JS.MAP": "x".repeat(900_000) })).includes("Note: this app is"),
      "a map named in capitals doesn't count either");
    assert.ok(!(await deployed({ "index.html": page, "app.js": "x".repeat(999_989) })).includes("Note: this app is"),
      "exactly 1 MB is within the budget");
    assert.ok((await deployed({ "index.html": page, "app.js": "x".repeat(999_990) })).includes("Note: this app is just over 1 MB."),
      "a byte past it reads as just over, never as 1 MB past 1 MB");
  } finally {
    await server.close();
  }
});
