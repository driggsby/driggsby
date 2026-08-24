import assert from "node:assert/strict";
import { test } from "node:test";

import { CliError } from "../cli-error.ts";
import { assertFitsTerminal } from "../test-support/terminal-width.ts";
import { runDeploy } from "./deploy-command.ts";
import { runVersions } from "./versions-command.ts";
import {
  capturedOut,
  makeEnvironment,
  makeProject,
  startFakeDeployServer,
} from "./test-support/deploy-command-harness.ts";

const QUIET_DEPLOY_IO = { out: () => undefined, now: () => 0 };

test("versions lists every version, marks the live one, and prints the URL", async () => {
  const server = await startFakeDeployServer();
  try {
    const directory = await makeProject("money-dash");
    const environment = await makeEnvironment(server.baseUrl);
    await runDeploy({ preview: false, projectDirectory: directory }, environment, QUIET_DEPLOY_IO);
    await runDeploy({ preview: false, projectDirectory: directory }, environment, QUIET_DEPLOY_IO);

    const io = capturedOut();
    const exitCode = await runVersions({ projectDirectory: directory }, environment, io);

    assert.equal(exitCode, 0);
    const text = io.text();
    assert.ok(text.includes('"money-dash" — 2 versions'));
    assert.ok(text.includes("v2"));
    assert.ok(text.includes("live now"));
    assert.ok(text.includes("v1"));
    assert.ok(text.includes("ready"));
    assert.ok(text.includes("2026-08-21 17:04 UTC"));
    assert.ok(text.includes("Your app:"));
    assert.ok(text.includes("https://money-dash.driggsby.dev"));
    assert.ok(text.includes("npx driggsby@latest rollback --to <VERSION>"));
    assertFitsTerminal(text);
  } finally {
    await server.close();
  }
});

test("versions says plainly when nothing is live yet", async () => {
  const server = await startFakeDeployServer();
  try {
    const directory = await makeProject("money-dash");
    const environment = await makeEnvironment(server.baseUrl);
    await runDeploy({ preview: true, projectDirectory: directory }, environment, QUIET_DEPLOY_IO);

    const io = capturedOut();
    const exitCode = await runVersions({ projectDirectory: directory }, environment, io);

    assert.equal(exitCode, 0);
    const text = io.text();
    assert.ok(text.includes('"money-dash" — 1 version'));
    assert.ok(text.includes("Nothing is live yet"));
    assert.ok(!text.includes("Your app:"));
    assertFitsTerminal(text);
  } finally {
    await server.close();
  }
});

test("a 503 gets neutral unavailable copy, not upload-specific wording", async () => {
  const server = await startFakeDeployServer();
  try {
    // versions uploads nothing, so the 503 copy must not claim a file
    // failed to store.
    server.injectResponse("GET", "/versions", 503, {
      error: "service_unavailable",
      error_description: "Retry the same PUT in a few seconds.",
    });
    const directory = await makeProject("money-dash");
    const environment = await makeEnvironment(server.baseUrl);

    await assert.rejects(
      runVersions({ projectDirectory: directory }, environment, capturedOut()),
      (error: unknown) => {
        assert.ok(error instanceof CliError);
        assert.ok(error.message.includes("briefly unavailable"));
        assert.ok(error.message.includes("npx driggsby@latest versions"));
        assert.ok(!error.message.includes("store"));
        assert.ok(!error.message.includes("PUT"));
        assertFitsTerminal(error.message);
        return true;
      },
    );
  } finally {
    await server.close();
  }
});

test("a 5xx body without an error code renders the fallback message readably", async () => {
  const server = await startFakeDeployServer();
  try {
    // A load balancer's error page: JSON, but not the API's error shape.
    server.injectResponse("GET", "/versions", 502, { oops: true });
    const directory = await makeProject("money-dash");
    const environment = await makeEnvironment(server.baseUrl);

    await assert.rejects(
      runVersions({ projectDirectory: directory }, environment, capturedOut()),
      (error: unknown) => {
        assert.ok(error instanceof CliError);
        assert.ok(error.message.includes("didn't recognize"));
        // The fallback message has its own newline; sanitizing must turn it
        // into a space, never delete it and glue the words together.
        assert.ok(!error.message.includes("tryagain"));
        assertFitsTerminal(error.message);
        return true;
      },
    );
  } finally {
    await server.close();
  }
});

test("a server error code that collides with an errno name is not read as a network failure", async () => {
  const server = await startFakeDeployServer();
  try {
    server.injectResponse("GET", "/versions", 400, {
      error: "ECONNRESET",
      error_description: "That request wasn't valid.",
    });
    const directory = await makeProject("money-dash");
    const environment = await makeEnvironment(server.baseUrl);

    await assert.rejects(
      runVersions({ projectDirectory: directory }, environment, capturedOut()),
      (error: unknown) => {
        assert.ok(error instanceof CliError);
        // The server answered, so the real refusal must render — not
        // firewall advice about allowing HTTPS egress.
        assert.ok(error.message.includes("That request wasn't valid."));
        assert.ok(!error.message.includes("allow HTTPS"));
        return true;
      },
    );
  } finally {
    await server.close();
  }
});

test("a maximum-length app URL prints in full, never truncated", async () => {
  const server = await startFakeDeployServer();
  try {
    // A 63-char slug (the server's maximum) yields an 84-char URL — the
    // display cap must never cut a legitimate address.
    const longSlug = "a".repeat(63);
    const fullUrl = `https://${longSlug}.driggsby.dev`;
    server.injectResponse("GET", "/versions", 200, {
      app_slug: longSlug,
      url: fullUrl,
      live_version_number: 1,
      versions: [
        {
          version_id: "v-1",
          number: 1,
          status: "ready",
          live: true,
          file_count: 1,
          total_bytes: 5,
          created_at: "2026-08-21T17:04:00.000Z",
        },
      ],
    });
    const directory = await makeProject("money-dash");
    const environment = await makeEnvironment(server.baseUrl);
    const io = capturedOut();
    const exitCode = await runVersions({ projectDirectory: directory }, environment, io);
    assert.equal(exitCode, 0);
    assert.ok(io.text().includes(fullUrl));
  } finally {
    await server.close();
  }
});

test("a garbage created_at is capped so the table stays within the terminal", async () => {
  const server = await startFakeDeployServer();
  try {
    server.injectResponse("GET", "/versions", 200, {
      app_slug: "money-dash",
      url: "https://money-dash.driggsby.dev",
      live_version_number: null,
      versions: [
        {
          version_id: "v-1",
          number: 1,
          status: "ready",
          live: false,
          file_count: 1,
          total_bytes: 5,
          created_at: "x".repeat(500),
        },
      ],
    });
    const directory = await makeProject("money-dash");
    const environment = await makeEnvironment(server.baseUrl);
    const io = capturedOut();
    const exitCode = await runVersions({ projectDirectory: directory }, environment, io);
    assert.equal(exitCode, 0);
    assertFitsTerminal(io.text());
  } finally {
    await server.close();
  }
});

test("versions for a never-deployed app points at the first deploy", async () => {
  const server = await startFakeDeployServer();
  try {
    server.injectResponse("GET", "/versions", 404, {
      error: "not_found",
      error_description: "No app with that name.",
    });
    const directory = await makeProject("money-dash");
    const environment = await makeEnvironment(server.baseUrl);

    await assert.rejects(
      runVersions({ projectDirectory: directory }, environment, capturedOut()),
      (error: unknown) => {
        assert.ok(error instanceof CliError);
        assert.ok(error.message.includes("There's no app named money-dash"));
        assert.ok(error.message.includes("npx driggsby@latest deploy"));
        assertFitsTerminal(error.message);
        return true;
      },
    );
  } finally {
    await server.close();
  }
});
