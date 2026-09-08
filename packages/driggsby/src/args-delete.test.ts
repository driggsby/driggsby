import assert from "node:assert/strict";
import { test } from "node:test";

import { parseArgv } from "./args.ts";
import { CliError } from "./cli-error.ts";
import { DELETE_HELP } from "./help.ts";

test("delete parses bare, with a name, and with --yes", () => {
  assert.deepEqual(parseArgv(["delete"]), { kind: "delete", slug: null, yes: false });
  assert.deepEqual(parseArgv(["delete", "money-dash-x7k2qf"]), {
    kind: "delete",
    slug: "money-dash-x7k2qf",
    yes: false,
  });
  assert.deepEqual(parseArgv(["delete", "money-dash-x7k2qf", "--yes"]), {
    kind: "delete",
    slug: "money-dash-x7k2qf",
    yes: true,
  });
  assert.deepEqual(parseArgv(["delete", "--yes"]), { kind: "delete", slug: null, yes: true });
});

test("delete prints its help on -h and --help", () => {
  for (const flag of ["-h", "--help"]) {
    assert.deepEqual(parseArgv(["delete", flag]), {
      kind: "print-help",
      text: DELETE_HELP,
      stream: "stdout",
      exitCode: 0,
    });
  }
});

test("delete refuses a value glued to --yes", () => {
  try {
    parseArgv(["delete", "--yes=true"]);
    assert.fail("expected a CliError");
  } catch (error) {
    assert.ok(error instanceof CliError);
    assert.equal(error.exitCode, 2);
    assert.ok(error.message.includes("--yes"));
  }
});

test("delete takes at most one name and rejects unknown flags", () => {
  try {
    parseArgv(["delete", "one", "two"]);
    assert.fail("expected a CliError");
  } catch (error) {
    assert.ok(error instanceof CliError);
    assert.equal(error.exitCode, 2);
    assert.ok(error.message.includes("'two'"));
  }
  try {
    parseArgv(["delete", "--force"]);
    assert.fail("expected a CliError");
  } catch (error) {
    assert.ok(error instanceof CliError);
    assert.equal(error.exitCode, 2);
  }
});
