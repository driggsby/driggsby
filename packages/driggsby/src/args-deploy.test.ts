import assert from "node:assert/strict";
import { test } from "node:test";

import { parseArgv } from "./args.ts";
import { CliError } from "./cli-error.ts";
import { DEPLOY_HELP, ROLLBACK_HELP, ROOT_HELP, VERSIONS_HELP } from "./help.ts";

test("deploy parses bare and with --preview", () => {
  assert.deepEqual(parseArgv(["deploy"]), { kind: "deploy", preview: false });
  assert.deepEqual(parseArgv(["deploy", "--preview"]), { kind: "deploy", preview: true });
});

test("rollback parses bare and with --to", () => {
  assert.deepEqual(parseArgv(["rollback"]), { kind: "rollback", toVersion: null });
  assert.deepEqual(parseArgv(["rollback", "--to", "3"]), { kind: "rollback", toVersion: 3 });
  assert.deepEqual(parseArgv(["rollback", "--to=12"]), { kind: "rollback", toVersion: 12 });
});

test("versions parses as a bare command", () => {
  assert.deepEqual(parseArgv(["versions"]), { kind: "versions" });
});

test("the new commands print their help on -h and --help", () => {
  for (const [argv, text] of [
    [["deploy", "--help"], DEPLOY_HELP],
    [["deploy", "-h"], DEPLOY_HELP],
    [["rollback", "--help"], ROLLBACK_HELP],
    [["versions", "-h"], VERSIONS_HELP],
  ] as const) {
    assert.deepEqual(parseArgv([...argv]), {
      kind: "print-help",
      text,
      stream: "stdout",
      exitCode: 0,
    });
  }
});

test("a --to value that isn't a positive whole number is a usage error", () => {
  // The digit string past Number.MAX_SAFE_INTEGER would otherwise serialize
  // in scientific notation and reach the server as 1e+23.
  for (const value of ["0", "-2", "abc", "1.5", "", "07x", "99999999999999999999999"]) {
    try {
      parseArgv(["rollback", "--to", value]);
      assert.fail(`expected a CliError for --to ${value}`);
    } catch (error) {
      assert.ok(error instanceof CliError, value);
      assert.equal(error.exitCode, 2);
      assert.ok(error.message.includes("--to"), value);
    }
  }
});

test("a missing --to value is a usage error", () => {
  try {
    parseArgv(["rollback", "--to"]);
    assert.fail("expected a CliError");
  } catch (error) {
    assert.ok(error instanceof CliError);
    assert.equal(error.exitCode, 2);
  }
});

test("unexpected arguments are refused with exit 2", () => {
  for (const argv of [
    ["deploy", "extra"],
    ["deploy", "--force"],
    ["deploy", "--preview=x"],
    ["rollback", "--to", "3", "extra"],
    ["versions", "--to", "3"],
  ]) {
    try {
      parseArgv(argv);
      assert.fail(`expected a CliError for ${argv.join(" ")}`);
    } catch (error) {
      assert.ok(error instanceof CliError, argv.join(" "));
      assert.equal(error.exitCode, 2);
    }
  }
});

test("root help lists the deploy commands", () => {
  assert.ok(ROOT_HELP.includes("deploy"));
  assert.ok(ROOT_HELP.includes("rollback"));
  assert.ok(ROOT_HELP.includes("versions"));
});

test("a typo'd deploy gets a did-you-mean tip", () => {
  try {
    parseArgv(["depoy"]);
    assert.fail("expected a CliError");
  } catch (error) {
    assert.ok(error instanceof CliError);
    assert.ok(error.message.includes("  tip: a similar subcommand exists: 'deploy'"));
  }
});
