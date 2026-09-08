import assert from "node:assert/strict";
import { test } from "node:test";

import { CliError } from "../cli-error.ts";
import { assertFitsTerminal } from "../test-support/terminal-width.ts";
import { runDeploy } from "./deploy-command.ts";
import { type RollbackCommandIo, runRollback } from "./rollback-command.ts";
import {
  type CapturedOut,
  capturedOut,
  makeEnvironment,
  makeProject,
  startFakeDeployServer,
} from "./test-support/deploy-command-harness.ts";

const QUIET_DEPLOY_IO = { out: () => undefined, now: () => 0 };

// A non-interactive rollback io (the agent/script case) unless a test says
// otherwise.
function rollbackIo(
  captured: CapturedOut,
  overrides: Partial<RollbackCommandIo> = {},
): RollbackCommandIo {
  return {
    out: captured.out,
    ask: () => Promise.reject(new Error("ask must not be called")),
    interactive: false,
    ...overrides,
  };
}

// Two live deploys of the same app, so v2 is live and v1 is ready.
async function appWithTwoVersions(serverBaseUrl: string) {
  const directory = await makeProject("money-dash");
  const environment = await makeEnvironment(serverBaseUrl);
  await runDeploy({ preview: false, projectDirectory: directory }, environment, QUIET_DEPLOY_IO);
  await runDeploy({ preview: false, projectDirectory: directory }, environment, QUIET_DEPLOY_IO);
  return { directory, environment };
}

test("rollback --to switches the live version without re-uploading", async () => {
  const server = await startFakeDeployServer();
  try {
    const { directory, environment } = await appWithTwoVersions(server.baseUrl);
    const uploadsBefore = server.requests.filter((request) => request.method === "PUT").length;

    const io = capturedOut();
    const exitCode = await runRollback(
      { toVersion: 1, projectDirectory: directory },
      environment,
      rollbackIo(io),
    );

    assert.equal(exitCode, 0);
    const text = io.text();
    assert.ok(text.includes("✓ Live      v1 is what visitors see now (was v2), at:"));
    const consoleAt = text.indexOf(server.consoleUrlFor("money-dash"));
    const ownAt = text.indexOf("https://money-dash.driggsby.dev");
    assert.ok(consoleAt !== -1 && ownAt !== -1 && consoleAt < ownAt);
    assert.ok(text.includes("Nothing re-uploaded — Driggsby already had v1 in full."));
    assert.ok(text.includes("npx driggsby@latest versions"));
    assertFitsTerminal(text);
    assert.equal(server.liveVersionNumber("money-dash"), 1);
    const uploadsAfter = server.requests.filter((request) => request.method === "PUT").length;
    assert.equal(uploadsAfter, uploadsBefore, "rollback must upload no bytes");
  } finally {
    await server.close();
  }
});

test("rollback without --to asks interactively and accepts a v-prefixed answer", async () => {
  const server = await startFakeDeployServer();
  try {
    const { directory, environment } = await appWithTwoVersions(server.baseUrl);

    const io = capturedOut();
    const questions: string[] = [];
    const exitCode = await runRollback(
      { toVersion: null, projectDirectory: directory },
      environment,
      rollbackIo(io, {
        interactive: true,
        ask: (question) => {
          questions.push(question);
          // "V1" pins that the v-prefix strip is case-insensitive.
          return Promise.resolve("V1");
        },
      }),
    );

    assert.equal(exitCode, 0);
    assert.equal(questions.length, 1);
    assert.ok(questions[0]?.includes("Make which version live?"));
    const text = io.text();
    assert.ok(text.includes("v2"), "the choices are shown before asking");
    assert.ok(text.includes("✓ Live      v1 is what visitors see now (was v2), at:"));
    assertFitsTerminal(text);
    assert.equal(server.liveVersionNumber("money-dash"), 1);
  } finally {
    await server.close();
  }
});

test("rollback without --to in a non-interactive terminal explains the re-run", async () => {
  const server = await startFakeDeployServer();
  try {
    const { directory, environment } = await appWithTwoVersions(server.baseUrl);

    await assert.rejects(
      runRollback(
        { toVersion: null, projectDirectory: directory },
        environment,
        rollbackIo(capturedOut()),
      ),
      (error: unknown) => {
        assert.ok(error instanceof CliError);
        assert.equal(error.exitCode, 2);
        assert.ok(error.message.includes("These versions can go live:"));
        assert.ok(error.message.includes("v1"));
        assert.ok(error.message.includes("npx driggsby@latest rollback --to <VERSION>"));
        assertFitsTerminal(error.message);
        return true;
      },
    );
    assert.equal(server.liveVersionNumber("money-dash"), 2, "nothing changed");
  } finally {
    await server.close();
  }
});

test("rolling back to the already-live version changes nothing and says so", async () => {
  const server = await startFakeDeployServer();
  try {
    const { directory, environment } = await appWithTwoVersions(server.baseUrl);

    const io = capturedOut();
    const exitCode = await runRollback(
      { toVersion: 2, projectDirectory: directory },
      environment,
      rollbackIo(io),
    );

    assert.equal(exitCode, 0);
    assert.ok(io.text().includes("v2 is already live — nothing changed."));
    assertFitsTerminal(io.text());
    assert.equal(server.liveVersionNumber("money-dash"), 2);
  } finally {
    await server.close();
  }
});

test("rollback to a version that doesn't exist names the ready ones", async () => {
  const server = await startFakeDeployServer();
  try {
    const { directory, environment } = await appWithTwoVersions(server.baseUrl);

    await assert.rejects(
      runRollback(
        { toVersion: 9, projectDirectory: directory },
        environment,
        rollbackIo(capturedOut()),
      ),
      (error: unknown) => {
        assert.ok(error instanceof CliError);
        assert.ok(error.message.includes("v9 isn't one of money-dash's ready versions"));
        assert.ok(error.message.includes("v2, v1"), "ready versions are listed newest-first");
        assert.ok(error.message.includes("npx driggsby@latest versions"));
        assertFitsTerminal(error.message);
        return true;
      },
    );
    assert.equal(server.liveVersionNumber("money-dash"), 2, "nothing changed");
  } finally {
    await server.close();
  }
});

test("rollback for a never-deployed app points at the first deploy", async () => {
  const server = await startFakeDeployServer();
  try {
    server.injectResponse("GET", "/versions", 404, {
      error: "not_found",
      error_description: "No app with that name.",
    });
    const directory = await makeProject("money-dash");
    const environment = await makeEnvironment(server.baseUrl);

    await assert.rejects(
      runRollback(
        { toVersion: 1, projectDirectory: directory },
        environment,
        rollbackIo(capturedOut()),
      ),
      (error: unknown) => {
        assert.ok(error instanceof CliError);
        assert.ok(error.message.includes(`There's no app named "money-dash"`));
        assert.ok(error.message.includes("npx driggsby@latest deploy"));
        return true;
      },
    );
  } finally {
    await server.close();
  }
});
