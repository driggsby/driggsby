import assert from "node:assert/strict";
import { test } from "node:test";

import { CliError } from "../cli-error.ts";
import { assertFitsTerminal } from "../test-support/terminal-width.ts";
import { runDeploy } from "./deploy-command.ts";
import { type DeleteCommandIo, runDelete } from "./delete-command.ts";
import {
  type CapturedOut,
  capturedOut,
  makeEnvironment,
  makeProject,
  startFakeDeployServer,
} from "./test-support/deploy-command-harness.ts";

const QUIET_DEPLOY_IO = { out: () => undefined, now: () => 0 };

// A non-interactive delete io (the agent/script case) unless a test says
// otherwise.
function deleteIo(
  captured: CapturedOut,
  overrides: Partial<DeleteCommandIo> = {},
): DeleteCommandIo {
  return {
    out: captured.out,
    ask: () => Promise.reject(new Error("ask must not be called")),
    interactive: false,
    ...overrides,
  };
}

async function deployedApp(serverBaseUrl: string) {
  const directory = await makeProject("money-dash");
  const environment = await makeEnvironment(serverBaseUrl);
  await runDeploy({ preview: false, projectDirectory: directory }, environment, QUIET_DEPLOY_IO);
  return { directory, environment };
}

function deleteRequests(server: { requests: { method: string; path: string }[] }) {
  return server.requests.filter((request) => request.method === "DELETE");
}

test("delete --yes removes the app and says what is gone", async () => {
  const server = await startFakeDeployServer();
  try {
    const { directory, environment } = await deployedApp(server.baseUrl);

    const io = capturedOut();
    const exitCode = await runDelete(
      { slug: null, yes: true, projectDirectory: directory },
      environment,
      deleteIo(io),
    );

    assert.equal(exitCode, 0);
    const text = io.text();
    assert.ok(text.includes("Deleting money-dash removes it forever: 1 deployed version"));
    assert.ok(text.includes("https://money-dash.driggsby.dev"));
    assert.ok(text.includes(`✓ Deleted   "The money-dash app"`));
    assert.ok(text.includes("Deploying the app's folder again would create a new app"));
    assert.ok(text.includes("Next:"), "the close-out must name the next step");
    assertFitsTerminal(text);
    assert.equal(deleteRequests(server).length, 1);
    // The app is gone on the server: a second delete is refused (in the
    // fake, by the DELETE itself — its GET answers an empty list).
    await assert.rejects(
      runDelete({ slug: "money-dash", yes: true }, environment, deleteIo(capturedOut())),
      (error: unknown) => error instanceof CliError,
    );
  } finally {
    await server.close();
  }
});

test("interactive delete asks for the address name and deletes on a match", async () => {
  const server = await startFakeDeployServer();
  try {
    const { directory, environment } = await deployedApp(server.baseUrl);

    const io = capturedOut();
    const questions: string[] = [];
    const exitCode = await runDelete(
      { slug: null, yes: false, projectDirectory: directory },
      environment,
      deleteIo(io, {
        interactive: true,
        ask: (question) => {
          questions.push(question);
          return Promise.resolve("money-dash");
        },
      }),
    );

    assert.equal(exitCode, 0);
    assert.equal(questions.length, 1);
    assert.ok(questions[0]?.includes("address name"));
    assert.equal(deleteRequests(server).length, 1);
  } finally {
    await server.close();
  }
});

test("an answer that doesn't match deletes nothing", async () => {
  const server = await startFakeDeployServer();
  try {
    const { directory, environment } = await deployedApp(server.baseUrl);

    await assert.rejects(
      runDelete(
        { slug: null, yes: false, projectDirectory: directory },
        environment,
        deleteIo(capturedOut(), { interactive: true, ask: () => Promise.resolve("money-dash-oops") }),
      ),
      (error: unknown) =>
        error instanceof CliError &&
        error.exitCode === 1 &&
        error.message.includes("nothing was deleted"),
    );
    assert.equal(deleteRequests(server).length, 0);
  } finally {
    await server.close();
  }
});

test("a terminal that can't ask requires --yes and deletes nothing", async () => {
  const server = await startFakeDeployServer();
  try {
    const { directory, environment } = await deployedApp(server.baseUrl);

    await assert.rejects(
      runDelete(
        { slug: null, yes: false, projectDirectory: directory },
        environment,
        deleteIo(capturedOut()),
      ),
      (error: unknown) =>
        error instanceof CliError &&
        error.exitCode === 2 &&
        error.message.includes("npx driggsby@latest delete money-dash --yes"),
    );
    assert.equal(deleteRequests(server).length, 0);
  } finally {
    await server.close();
  }
});

test("a named app deletes without a project folder", async () => {
  const server = await startFakeDeployServer();
  try {
    const { environment } = await deployedApp(server.baseUrl);

    const io = capturedOut();
    const exitCode = await runDelete(
      // projectDirectory points at nothing app-like; the name carries it.
      { slug: "money-dash", yes: true, projectDirectory: "/" },
      environment,
      deleteIo(io),
    );

    assert.equal(exitCode, 0);
    assert.equal(deleteRequests(server).length, 1);
  } finally {
    await server.close();
  }
});

test("no name and no driggsby.json explains how to name the app", async () => {
  const server = await startFakeDeployServer();
  try {
    const environment = await makeEnvironment(server.baseUrl);

    await assert.rejects(
      runDelete({ slug: null, yes: true, projectDirectory: "/" }, environment, deleteIo(capturedOut())),
      (error: unknown) =>
        error instanceof CliError &&
        error.message.includes("npx driggsby@latest delete <APP-ADDRESS-NAME>"),
    );
    assert.equal(deleteRequests(server).length, 0);
  } finally {
    await server.close();
  }
});

test("a long assigned slug and name still fit the terminal", async () => {
  const server = await startFakeDeployServer();
  try {
    // The realistic worst case: a base capped at 56 characters plus the
    // assigned suffix makes a 63-character slug, and the fake's name
    // ("The <slug> app") rides along.
    const longSlug = `${"a".repeat(56)}-2b4c6d`;
    const directory = await makeProject(longSlug);
    const environment = await makeEnvironment(server.baseUrl);
    await runDeploy({ preview: false, projectDirectory: directory }, environment, QUIET_DEPLOY_IO);

    const io = capturedOut();
    const exitCode = await runDelete(
      { slug: null, yes: true, projectDirectory: directory },
      environment,
      deleteIo(io),
    );

    assert.equal(exitCode, 0);
    assertFitsTerminal(io.text());
  } finally {
    await server.close();
  }
});

test("a name that isn't slug-shaped is refused before any request", async () => {
  const server = await startFakeDeployServer();
  try {
    const environment = await makeEnvironment(server.baseUrl);

    await assert.rejects(
      runDelete({ slug: "NOT a slug!", yes: true }, environment, deleteIo(capturedOut())),
      (error: unknown) =>
        error instanceof CliError &&
        error.exitCode === 2 &&
        error.message.includes("doesn't look like an app's address name"),
    );
    assert.equal(server.requests.length, 0, "a bad name must never reach the network");
  } finally {
    await server.close();
  }
});

test("the app vanishing between the preflight and the delete surfaces the server's answer", async () => {
  const server = await startFakeDeployServer();
  try {
    const { environment } = await deployedApp(server.baseUrl);
    server.injectResponse("DELETE", "/deploy/apps/money-dash", 404, {
      error: "app_not_found",
      error_description: "There's no app with that name in your account.",
    });

    await assert.rejects(
      runDelete({ slug: "money-dash", yes: true }, environment, deleteIo(capturedOut())),
      (error: unknown) => error instanceof CliError && error.exitCode === 1,
    );
  } finally {
    await server.close();
  }
});

test("an unknown app stops at the look-before-you-leap read", async () => {
  const server = await startFakeDeployServer();
  try {
    const environment = await makeEnvironment(server.baseUrl);
    server.injectResponse("GET", "/deploy/apps/nobody-here/versions", 404, {
      error: "app_not_found",
      error_description: "There's no app with that name in your account.",
    });

    await assert.rejects(
      runDelete({ slug: "nobody-here", yes: true }, environment, deleteIo(capturedOut())),
      (error: unknown) =>
        error instanceof CliError &&
        error.message.includes("already deleted") &&
        !error.message.includes("deploy"),
    );
    assert.equal(deleteRequests(server).length, 0);
  } finally {
    await server.close();
  }
});
