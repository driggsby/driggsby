import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { parseArgv } from "./args.ts";
import { CliError } from "./cli-error.ts";
import { MCP_HELP, ROOT_HELP } from "./help.ts";

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

test("an unexpected flag and a second positional are usage errors", () => {
  for (const argv of [["mcp", "setup", "--bogus"], ["mcp", "setup", "codex", "extra"]]) {
    assert.throws(
      () => parseArgv(argv),
      (error: unknown) => error instanceof CliError && error.exitCode === 2,
    );
  }
});
