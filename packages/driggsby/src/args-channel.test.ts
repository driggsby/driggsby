import assert from "node:assert/strict";
import { test } from "node:test";

import { parseArgv } from "./args.ts";
import { CliError } from "./cli-error.ts";
import { CHANNEL_HELP } from "./help.ts";

test("channel takes no arguments", () => {
  assert.deepEqual(parseArgv(["channel"]), { kind: "channel" });
  assert.deepEqual(parseArgv(["channel", "--"]), { kind: "channel" });
});

test("channel --help prints its help on stdout", () => {
  assert.deepEqual(parseArgv(["channel", "--help"]), { kind: "print-help", text: CHANNEL_HELP, stream: "stdout", exitCode: 0 });
  assert.deepEqual(parseArgv(["channel", "-h"]), { kind: "print-help", text: CHANNEL_HELP, stream: "stdout", exitCode: 0 });
});

test("channel refuses any argument, with exit code 2", () => {
  for (const argv of [["channel", "--json"], ["channel", "extra"], ["channel", "--", "x"]]) {
    assert.throws(
      () => parseArgv(argv),
      (error: unknown) => error instanceof CliError && error.exitCode === 2 && error.message.includes("Usage: npx driggsby@latest channel"),
    );
  }
});

test("channel's help names the switch and the plugin", () => {
  assert.match(CHANNEL_HELP, /DRIGGSBY_CHANNEL=on/);
  assert.match(CHANNEL_HELP, /plugin:driggsby@driggsby/);
});
