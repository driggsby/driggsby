import assert from "node:assert/strict";
import { test } from "node:test";

import { parseArgv } from "./args.ts";
import { CliError } from "./cli-error.ts";
import { DEV_HELP } from "./help.ts";

test("dev parses bare and with --stop", () => {
  assert.deepEqual(parseArgv(["dev"]), { kind: "dev", stop: false });
  assert.deepEqual(parseArgv(["dev", "--stop"]), { kind: "dev", stop: true });
});

test("dev prints its help and refuses a value on --stop or a stray argument", () => {
  assert.deepEqual(parseArgv(["dev", "-h"]), { kind: "print-help", text: DEV_HELP, stream: "stdout", exitCode: 0 });
  for (const argv of [["dev", "--stop=now"], ["dev", "extra"]]) {
    try {
      parseArgv(argv);
      assert.fail("expected a CliError");
    } catch (error) {
      assert.ok(error instanceof CliError);
      assert.equal(error.exitCode, 2);
      assert.ok(error.message.includes("Usage: npx driggsby@latest dev [--stop]"));
    }
  }
});
