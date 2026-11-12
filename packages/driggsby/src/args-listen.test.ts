import assert from "node:assert/strict";
import { test } from "node:test";

import { parseArgv } from "./args.ts";
import { CliError } from "./cli-error.ts";
import { LISTEN_HELP } from "./help.ts";

test("listen takes --json, and nothing else", () => {
  assert.deepEqual(parseArgv(["listen"]), { kind: "listen", json: false });
  assert.deepEqual(parseArgv(["listen", "--json"]), { kind: "listen", json: true });
  assert.deepEqual(parseArgv(["listen", "--json", "--"]), { kind: "listen", json: true });
});

test("listen --help prints its help on stdout", () => {
  assert.deepEqual(parseArgv(["listen", "--help"]), { kind: "print-help", text: LISTEN_HELP, stream: "stdout", exitCode: 0 });
  assert.deepEqual(parseArgv(["listen", "-h"]), { kind: "print-help", text: LISTEN_HELP, stream: "stdout", exitCode: 0 });
});

test("listen refuses a value on --json and any other argument, with exit code 2", () => {
  for (const argv of [["listen", "--json=yes"], ["listen", "--follow"], ["listen", "extra"], ["listen", "--", "--json"]]) {
    assert.throws(
      () => parseArgv(argv),
      (error: unknown) => error instanceof CliError && error.exitCode === 2 && error.message.includes("Usage: npx driggsby@latest listen [--json]"),
    );
  }
});
