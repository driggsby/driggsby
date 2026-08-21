import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { parseArgv } from "./args.ts";
import { CliError } from "./cli-error.ts";
import { MCP_HELP, MCP_SETUP_HELP_LONG, MCP_SETUP_HELP_SHORT, ROOT_HELP } from "./help.ts";

function fixture(name: string): string {
  return readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url), "utf8");
}

test("no arguments prints root help to stderr with exit 2", () => {
  const parsed = parseArgv([]);

  assert.deepEqual(parsed, {
    kind: "print-help",
    text: ROOT_HELP,
    stream: "stderr",
    exitCode: 2,
  });
});

test("root help is byte-identical to the Rust CLI", () => {
  assert.equal(ROOT_HELP, fixture("help.txt"));
});

test("mcp help is byte-identical to the Rust CLI", () => {
  assert.equal(MCP_HELP, fixture("mcp-help.txt"));
});

test("both mcp setup help variants are byte-identical to the Rust CLI", () => {
  assert.equal(MCP_SETUP_HELP_SHORT, fixture("setup-help-short.txt"));
  assert.equal(MCP_SETUP_HELP_LONG, fixture("setup-help-long.txt"));
  assert.deepEqual(parseArgv(["mcp", "setup", "--help"]), {
    kind: "print-help",
    text: MCP_SETUP_HELP_LONG,
    stream: "stdout",
    exitCode: 0,
  });
  assert.deepEqual(parseArgv(["mcp", "setup", "-h"]), {
    kind: "print-help",
    text: MCP_SETUP_HELP_SHORT,
    stream: "stdout",
    exitCode: 0,
  });
  // Short-flag clusters dispatch on their first character, like clap.
  assert.deepEqual(parseArgv(["mcp", "setup", "-hs"]), {
    kind: "print-help",
    text: MCP_SETUP_HELP_SHORT,
    stream: "stdout",
    exitCode: 0,
  });
});

test("typo'd inputs get clap's did-you-mean tips", () => {
  const cases: [string[], string][] = [
    [["mcp", "setp"], "  tip: a similar subcommand exists: 'setup'"],
    [["mcpp"], "  tip: a similar subcommand exists: 'mcp'"],
    [["--versio"], "  tip: a similar argument exists: '--version'"],
    [["mcp", "setup", "--pint"], "  tip: a similar argument exists: '--print'"],
    [["mcp", "setup", "--hel"], "  tip: a similar argument exists: '--help'"],
    [["mcp", "setup", "claude-code", "-s", "usr"], "  tip: a similar value exists: 'user'"],
    [["--", "mcp"], "  tip: subcommand 'mcp' exists; to use it, remove the '--' before it"],
  ];
  for (const [argv, expectedTip] of cases) {
    try {
      parseArgv(argv);
      assert.fail(`expected a CliError for ${argv.join(" ")}`);
    } catch (error) {
      assert.ok(error instanceof CliError);
      assert.equal(error.exitCode, 2);
      assert.ok(error.message.includes(expectedTip), `missing tip for ${argv.join(" ")}`);
    }
  }
  // Below clap's 0.7 Jaro threshold: no tip.
  try {
    parseArgv(["mpc"]);
    assert.fail("expected a CliError");
  } catch (error) {
    assert.ok(error instanceof CliError);
    assert.ok(!error.message.includes("tip:"));
  }
});

test("bare mcp prints mcp help to stderr with exit 2", () => {
  const parsed = parseArgv(["mcp"]);

  assert.deepEqual(parsed, { kind: "print-help", text: MCP_HELP, stream: "stderr", exitCode: 2 });
});

test("--help goes to stdout with exit 0", () => {
  const parsed = parseArgv(["--help"]);

  assert.ok(parsed.kind === "print-help");
  assert.equal(parsed.stream, "stdout");
  assert.equal(parsed.exitCode, 0);
});

test("mcp setup parses client, --print, and -s in any order", () => {
  assert.deepEqual(parseArgv(["mcp", "setup", "claude-code", "--print", "-s", "local"]), {
    kind: "mcp-setup",
    client: "claude-code",
    print: true,
    scope: "local",
  });
  assert.deepEqual(parseArgv(["mcp", "setup", "--print", "codex"]), {
    kind: "mcp-setup",
    client: "codex",
    print: true,
    scope: undefined,
  });
  assert.deepEqual(parseArgv(["mcp", "setup"]), {
    kind: "mcp-setup",
    client: undefined,
    print: false,
    scope: undefined,
  });
  assert.equal(parseArgv(["mcp", "setup", "-s=user", "claude-code"]).kind, "mcp-setup");
});

test("an unrecognized subcommand matches the Rust CLI error byte-for-byte", () => {
  try {
    parseArgv(["bogus"]);
    assert.fail("expected a CliError");
  } catch (error) {
    assert.ok(error instanceof CliError);
    assert.equal(error.exitCode, 2);
    assert.equal(`${error.message}\n`, fixture("badcmd-stderr.txt"));
  }
});

test("-- ends option parsing, like clap", () => {
  assert.deepEqual(parseArgv(["mcp", "setup", "--", "other"]), {
    kind: "mcp-setup",
    client: "other",
    print: false,
    scope: undefined,
  });
  // The escape the CLI's own tip recommends: '--bogus' becomes the client
  // value (rejected later with the normal unsupported-client error, exit 1).
  assert.deepEqual(parseArgv(["mcp", "setup", "--", "--bogus"]), {
    kind: "mcp-setup",
    client: "--bogus",
    print: false,
    scope: undefined,
  });
  assert.deepEqual(parseArgv(["mcp", "setup", "--"]), {
    kind: "mcp-setup",
    client: undefined,
    print: false,
    scope: undefined,
  });
});

test("a bare dash is a positional, like clap", () => {
  assert.deepEqual(parseArgv(["mcp", "setup", "-"]), {
    kind: "mcp-setup",
    client: "-",
    print: false,
    scope: undefined,
  });
});

test("control bytes in echoed argv are stripped before reaching the terminal", () => {
  try {
    parseArgv(["mcp", "setup", "--bo\u001b]0;pwned\u0007gus"]);
    assert.fail("expected a CliError");
  } catch (error) {
    assert.ok(error instanceof CliError);
    assert.ok(error.message.includes("'--bo]0;pwnedgus'"));
    assert.ok(!error.message.includes("\u001b"));
    assert.ok(!error.message.includes("\u0007"));
  }
});

test("clap's cross-level tip points a mistyped mcp flag at setup", () => {
  for (const argv of [
    ["mcp", "--print", "setup"],
    ["mcp", "--prnt", "setup"],
    ["mcp", "--print", "--", "setup"],
  ]) {
    try {
      parseArgv(argv);
      assert.fail("expected a CliError");
    } catch (error) {
      assert.ok(error instanceof CliError);
      assert.ok(error.message.includes("  tip: 'setup --print' exists"), argv.join(" "));
    }
  }
  // Without "setup" later in argv there is no cross-level tip.
  try {
    parseArgv(["mcp", "--print"]);
    assert.fail("expected a CliError");
  } catch (error) {
    assert.ok(error instanceof CliError);
    assert.ok(!error.message.includes("tip:"));
  }
});

test("a value attached to --help or --version errors at every level", () => {
  const cases: [string[], string, string][] = [
    [["--help=x"], "'x' for '--help'", "Usage: npx driggsby@latest --help <COMMAND>"],
    [["--version="], "'' for '--version'", "Usage: npx driggsby@latest --version <COMMAND>"],
    [["mcp", "--help=x"], "'x' for '--help'", "Usage: npx driggsby@latest mcp --help <COMMAND>"],
  ];
  for (const [argv, valuePart, usage] of cases) {
    try {
      parseArgv(argv);
      assert.fail("expected a CliError");
    } catch (error) {
      assert.ok(error instanceof CliError);
      assert.equal(error.exitCode, 2);
      assert.ok(error.message.includes(`unexpected value ${valuePart} found; no more were expected`));
      assert.ok(error.message.includes(usage));
    }
  }
});

test("short clusters split on code points, never mid-surrogate", () => {
  try {
    parseArgv(["mcp", "setup", "-\u{1f600}x"]);
    assert.fail("expected a CliError");
  } catch (error) {
    assert.ok(error instanceof CliError);
    assert.ok(error.message.includes("'-\u{1f600}'"));
    assert.ok(!error.message.includes("�"));
  }
});

test("control bytes cannot reach the terminal through a tip line", () => {
  try {
    parseArgv(["mcp", "setup", "-\u001bx"]);
    assert.fail("expected a CliError");
  } catch (error) {
    assert.ok(error instanceof CliError);
    assert.ok(!error.message.includes("\u001b"));
  }
});
