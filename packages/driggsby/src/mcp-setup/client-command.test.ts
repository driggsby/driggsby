import assert from "node:assert/strict";
import { test } from "node:test";

import { type ClientCommandResult, RemoteSignInHintState, runClientCommand } from "./client-command.ts";
import { type ClientCommandOutput } from "./classify.ts";

// Fake client commands are plain `node -e` invocations so these tests run
// identically on macOS, Linux, and Windows.
function nodeCommand(script: string): { program: string; args: string[] } {
  return { program: process.execPath, args: ["-e", script] };
}

function expectOutput(result: ClientCommandResult): ClientCommandOutput {
  assert.ok(result.kind === "output", `expected an output result, got ${result.kind}`);
  return result.output;
}

test("remote sign-in hint waits for loopback redirect and browser failure", () => {
  const state = new RemoteSignInHintState();

  assert.equal(state.observe("Authorize by opening this URL: "), false);
  assert.equal(
    state.observe(
      "https://app.driggsby.com/authorize?redirect_uri=http%3A%2F%2F127.0.0.1%3A44489%2Fcallback",
    ),
    false,
  );
  assert.equal(
    state.observe("(Browser launch failed; please copy the URL above manually.)"),
    true,
  );
});

test("remote sign-in hint prints once", () => {
  const state = new RemoteSignInHintState();

  assert.equal(
    state.observe("redirect_uri=http%3A%2F%2F127.0.0.1%3A44489%2Fcallback Browser launch failed"),
    true,
  );
  assert.equal(state.observe("Browser launch failed"), false);
});

test("remote sign-in hint does not trigger for non-loopback redirects", () => {
  const state = new RemoteSignInHintState();

  assert.equal(
    state.observe("redirect_uri=https%3A%2F%2Fexample.com%2Fcallback Browser launch failed"),
    false,
  );
});

test("a streaming command still captures output from both streams", async () => {
  const result = await runClientCommand(
    nodeCommand(
      "process.stdout.write('already exists'); process.stderr.write('No MCP server found');",
    ),
    true,
  );

  const output = expectOutput(result);
  assert.equal(output.succeeded, true);
  assert.equal(output.stdout, "already exists");
  assert.equal(output.stderr, "No MCP server found");
});

test("does not wait for output pipes inherited by grandchildren", async () => {
  // The child spawns a detached grandchild that keeps the stdio pipes open
  // for 3 s, then exits immediately itself. The drain grace must cut the
  // wait at ~250 ms after child exit.
  const script =
    "const { spawn } = require('node:child_process');" +
    "process.stdout.write('already exists');" +
    "spawn(process.execPath, ['-e', 'setTimeout(() => {}, 3000)'], { stdio: ['ignore', 'inherit', 'inherit'], detached: true }).unref();";
  const startedAt = Date.now();
  const result = await runClientCommand(nodeCommand(script), true);

  assert.ok(Date.now() - startedAt < 2000, "took too long; drain grace did not apply");
  assert.ok(expectOutput(result).stdout.includes("already exists"));
});

test("a command that never exits times out", async () => {
  const result = await runClientCommand(nodeCommand("setTimeout(() => {}, 60000);"), false, 300);

  assert.equal(result.kind, "timed-out");
});

test("a missing program reports not-found", async () => {
  const result = await runClientCommand(
    { program: "driggsby-test-no-such-program-1212", args: [] },
    false,
  );

  assert.equal(result.kind, "not-found");
});

test("a failing command reports unsuccessful output", async () => {
  const result = await runClientCommand(nodeCommand("process.exit(3);"), false);

  assert.equal(expectOutput(result).succeeded, false);
});
