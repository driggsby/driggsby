import assert from "node:assert/strict";
import { test } from "node:test";

import { parseArgv } from "./args.ts";
import { CliError } from "./cli-error.ts";
import { LOGIN_HELP, LOGOUT_HELP, ROOT_HELP } from "./help.ts";

test("login and logout parse as bare commands", () => {
  assert.deepEqual(parseArgv(["login"]), { kind: "login", code: null });
  assert.deepEqual(parseArgv(["logout"]), { kind: "logout" });
});

test("login and logout print their help on -h and --help", () => {
  for (const [argv, text] of [
    [["login", "--help"], LOGIN_HELP],
    [["login", "-h"], LOGIN_HELP],
    [["logout", "--help"], LOGOUT_HELP],
    [["logout", "-h"], LOGOUT_HELP],
  ] as const) {
    assert.deepEqual(parseArgv([...argv]), {
      kind: "print-help",
      text,
      stream: "stdout",
      exitCode: 0,
    });
  }
});

test("login rejects unexpected arguments with exit 2", () => {
  for (const argv of [
    ["login", "extra"],
    ["login", "--force"],
    ["login", "-x"],
    ["logout", "now"],
  ]) {
    try {
      parseArgv(argv);
      assert.fail(`expected a CliError for ${argv.join(" ")}`);
    } catch (error) {
      assert.ok(error instanceof CliError);
      assert.equal(error.exitCode, 2);
      assert.ok(error.message.includes("unexpected argument"), argv.join(" "));
      assert.ok(error.message.includes("For more information, try '--help'."));
    }
  }
});

test("-- ends option parsing for login, and a token after it still errors", () => {
  assert.deepEqual(parseArgv(["login", "--"]), { kind: "login", code: null });
  try {
    parseArgv(["login", "--", "extra"]);
    assert.fail("expected a CliError");
  } catch (error) {
    assert.ok(error instanceof CliError);
    assert.equal(error.exitCode, 2);
  }
});

test("argv echoed by login errors is sanitized for the terminal", () => {
  try {
    parseArgv(["login", "--bo\u001b]0;pwned\u0007gus"]);
    assert.fail("expected a CliError");
  } catch (error) {
    assert.ok(error instanceof CliError);
    assert.ok(error.message.includes("'--bo]0;pwnedgus'"));
    assert.ok(!error.message.includes("\u001b"));
    assert.ok(!error.message.includes("\u0007"));
  }
});

test("root help lists login and logout", () => {
  assert.ok(ROOT_HELP.includes("login"));
  assert.ok(ROOT_HELP.includes("logout"));
  assert.ok(ROOT_HELP.includes("npx driggsby@latest login"));
});

test("a typo'd login gets a did-you-mean tip", () => {
  try {
    parseArgv(["logn"]);
    assert.fail("expected a CliError");
  } catch (error) {
    assert.ok(error instanceof CliError);
    assert.ok(error.message.includes("  tip: a similar subcommand exists: 'login'"));
  }
});

test("login --code takes the code the approval page showed, spaced or with =", () => {
  assert.deepEqual(parseArgv(["login", "--code", "7KQ2M-9XH4T-A0B1C-DEFGH"]), { kind: "login", code: "7KQ2M-9XH4T-A0B1C-DEFGH" });
  assert.deepEqual(parseArgv(["login", "--code=7kq2m 9xh4t"]), { kind: "login", code: "7kq2m 9xh4t" });
});

test("login --code without a code, or twice, is a usage error", () => {
  for (const argv of [
    ["login", "--code"],
    ["login", "--code="],
    ["login", "--code", "--help"],
    ["login", "--code", "A", "--code", "B"],
    ["login", "--code", "A", "extra"],
  ]) {
    try {
      parseArgv(argv);
      assert.fail(`expected a CliError for ${argv.join(" ")}`);
    } catch (error) {
      assert.ok(error instanceof CliError);
      assert.equal(error.exitCode, 2, argv.join(" "));
    }
  }
});
