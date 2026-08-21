import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { test } from "node:test";

import { CliError } from "../cli-error.ts";
import { promptForClient, type PromptStreams } from "./setup.ts";

function interactiveStreams(): { streams: PromptStreams; input: PassThrough; output: PassThrough } {
  const input = new PassThrough();
  const output = new PassThrough();
  output.resume();
  return { streams: { input, output, isInteractive: true }, input, output };
}

test("a typed menu choice resolves the client", async () => {
  const { streams, input } = interactiveStreams();
  const pending = promptForClient(streams);
  input.end("2\n");

  assert.equal(await pending, "codex");
});

test("EOF at the menu is 'Choose 1, 2, or 3.' with exit 1, like the Rust CLI", async () => {
  const { streams, input } = interactiveStreams();
  const pending = promptForClient(streams);
  // Ctrl+D: the input ends without ever delivering a line.
  input.end();

  await assert.rejects(pending, (error: unknown) => {
    assert.ok(error instanceof CliError);
    assert.equal(error.message, "Choose 1, 2, or 3.");
    assert.equal(error.exitCode, 1);
    return true;
  });
});

test("an invalid menu choice is 'Choose 1, 2, or 3.' with exit 1", async () => {
  const { streams, input } = interactiveStreams();
  const pending = promptForClient(streams);
  input.end("7\n");

  await assert.rejects(pending, (error: unknown) => {
    assert.ok(error instanceof CliError);
    assert.equal(error.message, "Choose 1, 2, or 3.");
    return true;
  });
});
