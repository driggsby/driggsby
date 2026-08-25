import assert from "node:assert/strict";
import { test } from "node:test";

import { parseArgv } from "./args.ts";
import { CliError } from "./cli-error.ts";
import { INIT_HELP } from "./help.ts";

test("init parses bare and with a name", () => {
  assert.deepEqual(parseArgv(["init"]), { kind: "init", slug: null });
  assert.deepEqual(parseArgv(["init", "money-dash"]), { kind: "init", slug: "money-dash" });
});

test("init prints its help on -h and --help", () => {
  for (const flag of ["-h", "--help"]) {
    assert.deepEqual(parseArgv(["init", flag]), {
      kind: "print-help",
      text: INIT_HELP,
      stream: "stdout",
      exitCode: 0,
    });
  }
});

test("init takes at most one name", () => {
  try {
    parseArgv(["init", "one", "two"]);
    assert.fail("expected a CliError");
  } catch (error) {
    assert.ok(error instanceof CliError);
    assert.equal(error.exitCode, 2);
    assert.ok(error.message.includes("'two'"));
    assert.ok(error.message.includes("init [NAME]"));
  }
});

test("init rejects unknown flags but lets -- pass a dashed name through", () => {
  try {
    parseArgv(["init", "--force"]);
    assert.fail("expected a CliError");
  } catch (error) {
    assert.ok(error instanceof CliError);
    assert.equal(error.exitCode, 2);
  }
  // After --, even a flag-looking token is a name; slug validation refuses
  // it later with the naming rules instead of a flag error.
  assert.deepEqual(parseArgv(["init", "--", "--weird"]), { kind: "init", slug: "--weird" });
});
