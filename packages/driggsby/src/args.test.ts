import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { parseArgv } from "./args.ts";
import { CliError } from "./cli-error.ts";
import { MCP_HELP, MCP_SETUP_HELP, ROOT_HELP } from "./help.ts";

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

test("mcp setup help keeps every line of the original content", () => {
  // A deliberate simplification serves both -h and --help; this pins the
  // content so it can't silently drift further.
  for (const line of [
    "Set up Driggsby for an AI client.",
    "Run once per client.",
    "Supported clients: claude-code, codex, other.",
    "Usage: npx driggsby@latest mcp setup [OPTIONS] [CLIENT]",
    "Client ID: claude-code, codex, or other.",
    "Print the native setup command instead of running it.",
    "Claude Code only. Values: local, user (default).",
    "[possible values: local, user]",
  ]) {
    assert.ok(MCP_SETUP_HELP.includes(line), `missing help line: ${line}`);
  }
  assert.deepEqual(parseArgv(["mcp", "setup", "--help"]), {
    kind: "print-help",
    text: MCP_SETUP_HELP,
    stream: "stdout",
    exitCode: 0,
  });
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

test("an invalid -s value matches the Rust CLI error byte-for-byte", () => {
  try {
    parseArgv(["mcp", "setup", "claude-code", "-s", "bogus"]);
    assert.fail("expected a CliError");
  } catch (error) {
    assert.ok(error instanceof CliError);
    assert.equal(error.exitCode, 2);
    assert.equal(`${error.message}\n`, fixture("badscope-stderr.txt"));
  }
});

test("an unexpected setup flag matches the Rust CLI error byte-for-byte", () => {
  try {
    parseArgv(["mcp", "setup", "--bogus"]);
    assert.fail("expected a CliError");
  } catch (error) {
    assert.ok(error instanceof CliError);
    assert.equal(error.exitCode, 2);
    assert.equal(`${error.message}\n`, fixture("badflag-stderr.txt"));
  }
});

test("a missing -s value names the possible values", () => {
  try {
    parseArgv(["mcp", "setup", "claude-code", "-s"]);
    assert.fail("expected a CliError");
  } catch (error) {
    assert.ok(error instanceof CliError);
    assert.equal(error.exitCode, 2);
    assert.ok(error.message.includes("a value is required for '-s <MCP_SCOPE>'"));
    assert.ok(error.message.includes("[possible values: local, user]"));
  }
});

test("a second positional is a usage error", () => {
  assert.throws(
    () => parseArgv(["mcp", "setup", "codex", "extra"]),
    (error: unknown) => error instanceof CliError && error.exitCode === 2,
  );
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

test("a repeated -s matches the Rust CLI error byte-for-byte", () => {
  for (const argv of [
    ["mcp", "setup", "-s", "local", "-s", "user", "claude-code"],
    // clap reports duplication even when the second value is empty/invalid.
    ["mcp", "setup", "claude-code", "-s", "local", "-s="],
  ]) {
    try {
      parseArgv(argv);
      assert.fail("expected a CliError");
    } catch (error) {
      assert.ok(error instanceof CliError);
      assert.equal(error.exitCode, 2);
      assert.equal(
        error.message,
        "error: the argument '-s <MCP_SCOPE>' cannot be used multiple times\n\n" +
          "Usage: npx driggsby@latest mcp setup [OPTIONS] [CLIENT]\n\n" +
          "For more information, try '--help'.",
      );
    }
  }
});

test("an empty or dash-leading -s value is 'a value is required', like clap", () => {
  for (const argv of [
    ["mcp", "setup", "-s=", "claude-code"],
    ["mcp", "setup", "claude-code", "-s", ""],
    ["mcp", "setup", "claude-code", "-s", "-h"],
  ]) {
    try {
      parseArgv(argv);
      assert.fail("expected a CliError");
    } catch (error) {
      assert.ok(error instanceof CliError);
      assert.equal(error.exitCode, 2);
      assert.ok(error.message.includes("a value is required for '-s <MCP_SCOPE>'"));
    }
  }
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
