import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { parseArgv } from "./args.ts";
import { CliError } from "./cli-error.ts";

function fixture(name: string): string {
  return readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url), "utf8");
}

test("a repeated --print matches the Rust CLI error", () => {
  try {
    parseArgv(["mcp", "setup", "--print", "--print", "claude-code"]);
    assert.fail("expected a CliError");
  } catch (error) {
    assert.ok(error instanceof CliError);
    assert.equal(error.exitCode, 2);
    assert.ok(error.message.includes("the argument '--print' cannot be used multiple times"));
  }
});

test("a value attached to a valueless flag matches the Rust CLI error", () => {
  try {
    parseArgv(["mcp", "setup", "--print=true"]);
    assert.fail("expected a CliError");
  } catch (error) {
    assert.ok(error instanceof CliError);
    assert.equal(error.exitCode, 2);
    assert.ok(
      error.message.includes("unexpected value 'true' for '--print' found; no more were expected"),
    );
  }
});

test("a trailing valueless -s reports 'a value is required' even after a prior -s", () => {
  for (const argv of [
    ["mcp", "setup", "-s", "user", "-s"],
    ["mcp", "setup", "-s", "local", "-s", "-h"],
  ]) {
    try {
      parseArgv(argv);
      assert.fail("expected a CliError");
    } catch (error) {
      assert.ok(error instanceof CliError);
      assert.ok(error.message.includes("a value is required for '-s <MCP_SCOPE>'"));
    }
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

test("-s followed by an unrecognized flag reports that flag, like clap", () => {
  const cases: [string[], string][] = [
    [
      ["mcp", "setup", "claude-code", "-s", "--user"],
      "error: unexpected argument '--user' found\n\n" +
        "  tip: to pass '--user' as a value, use '-- --user'\n\n" +
        "Usage: npx driggsby@latest mcp setup <CLIENT>\n\n" +
        "For more information, try '--help'.",
    ],
    [
      ["mcp", "setup", "-s", "-x"],
      "error: unexpected argument '-x' found\n\n" +
        "  tip: to pass '-x' as a value, use '-- -x'\n\n" +
        "Usage: npx driggsby@latest mcp setup [OPTIONS] [CLIENT]\n\n" +
        "For more information, try '--help'.",
    ],
    [
      ["mcp", "setup", "-s", "--print=1"],
      "error: unexpected value '1' for '--print' found; no more were expected\n\n" +
        "Usage: npx driggsby@latest mcp setup --print [CLIENT]\n\n" +
        "For more information, try '--help'.",
    ],
  ];
  for (const [argv, expected] of cases) {
    try {
      parseArgv(argv);
      assert.fail(`expected a CliError for ${argv.join(" ")}`);
    } catch (error) {
      assert.ok(error instanceof CliError);
      assert.equal(error.exitCode, 2);
      assert.equal(error.message, expected);
    }
  }
  // Recognized flag tokens after -s still report the missing value first.
  for (const next of ["--print", "--help", "-hx", "-suser", "--"]) {
    try {
      parseArgv(["mcp", "setup", "-s", next]);
      assert.fail(`expected a CliError for -s ${next}`);
    } catch (error) {
      assert.ok(error instanceof CliError);
      assert.ok(error.message.includes("a value is required for '-s <MCP_SCOPE>'"), next);
    }
  }
});

test("unknown long flags re-render usage from already-seen args, like clap", () => {
  const cases: [string[], string][] = [
    [["mcp", "setup", "claude-code", "--json"], "Usage: npx driggsby@latest mcp setup <CLIENT>"],
    [
      ["mcp", "setup", "--print", "-s", "user", "--bogus"],
      "Usage: npx driggsby@latest mcp setup --print -s <MCP_SCOPE> [CLIENT]",
    ],
    [
      ["mcp", "setup", "claude-code", "-s", "user", "--pront"],
      "Usage: npx driggsby@latest mcp setup -s <MCP_SCOPE> --print <CLIENT>",
    ],
    // The suggestion dedupes against an already-seen --print.
    [["mcp", "setup", "--print", "--pront"], "Usage: npx driggsby@latest mcp setup --print [CLIENT]"],
    [
      ["mcp", "setup", "--print", "--hepl"],
      "Usage: npx driggsby@latest mcp setup --print --help [CLIENT]",
    ],
    [["mcp", "setup", "--json"], "Usage: npx driggsby@latest mcp setup [OPTIONS] [CLIENT]"],
    // Unknown shorts and extra positionals keep the generic usage line.
    [["mcp", "setup", "--print", "-x"], "Usage: npx driggsby@latest mcp setup [OPTIONS] [CLIENT]"],
    [
      ["mcp", "setup", "--print", "claude-code", "extra"],
      "Usage: npx driggsby@latest mcp setup [OPTIONS] [CLIENT]",
    ],
  ];
  for (const [argv, usage] of cases) {
    try {
      parseArgv(argv);
      assert.fail(`expected a CliError for ${argv.join(" ")}`);
    } catch (error) {
      assert.ok(error instanceof CliError);
      assert.equal(error.exitCode, 2);
      assert.ok(error.message.includes(`\n${usage}\n`), `${argv.join(" ")}\n${error.message}`);
    }
  }
});

test("--print=x and --help=x render clap's group usage once an arg committed", () => {
  const group = "<CLIENT|--print|-s <MCP_SCOPE>>";
  const cases: [string[], string][] = [
    // Nothing committed yet: the errored flag itself plus [CLIENT]. A pending
    // slot-form -s value or positional has not committed either.
    [["mcp", "setup", "--print=1"], "Usage: npx driggsby@latest mcp setup --print [CLIENT]"],
    [["mcp", "setup", "-s", "user", "--print=1"], "Usage: npx driggsby@latest mcp setup --print [CLIENT]"],
    [["mcp", "setup", "claude-code", "--help=x"], "Usage: npx driggsby@latest mcp setup --help [CLIENT]"],
    // Committed: --print and attached -s=... react instantly, and a pending
    // arg commits when the next token starts a new argument.
    [["mcp", "setup", "--print", "--help=x"], `Usage: npx driggsby@latest mcp setup --help ${group}`],
    [["mcp", "setup", "-s=user", "--print=1"], `Usage: npx driggsby@latest mcp setup ${group}`],
    [["mcp", "setup", "claude-code", "-s", "--print=1"], `Usage: npx driggsby@latest mcp setup ${group}`],
  ];
  for (const [argv, usage] of cases) {
    try {
      parseArgv(argv);
      assert.fail(`expected a CliError for ${argv.join(" ")}`);
    } catch (error) {
      assert.ok(error instanceof CliError);
      assert.equal(error.exitCode, 2);
      assert.ok(error.message.includes(`\n${usage}\n`), `${argv.join(" ")}\n${error.message}`);
    }
  }
});

test("slot-form -s value errors defer to clap's resolution point", () => {
  // A following error token's own error wins over the pending value's error…
  const deferred: [string[], string][] = [
    [["mcp", "setup", "-s", "bogus", "--pront"], "error: unexpected argument '--pront' found"],
    [["mcp", "setup", "-s", "bogus", "--unknown"], "error: unexpected argument '--unknown' found"],
    [["mcp", "setup", "-s", "", "--unknown"], "error: unexpected argument '--unknown' found"],
    [["mcp", "setup", "-s", "bogus", "-x"], "error: unexpected argument '-x' found"],
    [["mcp", "setup", "-s", "bogus", "--print=x"], "error: unexpected value 'x' for '--print'"],
    [["mcp", "setup", "-s", "local", "-s", "user", "--pront"], "error: unexpected argument '--pront' found"],
    [["mcp", "setup", "-s", "local", "-s", "user", "--help=x"], "error: unexpected value 'x' for '--help'"],
  ];
  // …while recognized argument starts and end-of-argv still propagate it,
  // duplication first, then emptiness, then validity.
  const propagated: [string[], string][] = [
    [["mcp", "setup", "-s", "bogus", "--print"], "invalid value 'bogus'"],
    [["mcp", "setup", "-s", "bogus", "-h"], "invalid value 'bogus'"],
    [["mcp", "setup", "-s", "bogus", "--help"], "invalid value 'bogus'"],
    [["mcp", "setup", "-s", "bogus", "codex"], "invalid value 'bogus'"],
    [["mcp", "setup", "-s", "bogus"], "invalid value 'bogus'"],
    [["mcp", "setup", "-s", "", "--print"], "a value is required for '-s <MCP_SCOPE>'"],
    [["mcp", "setup", "-s", "local", "-s", "user", "--print"], "cannot be used multiple times"],
    [["mcp", "setup", "-s", "local", "-s", "user"], "cannot be used multiple times"],
  ];
  for (const [argv, expected] of [...deferred, ...propagated]) {
    try {
      parseArgv(argv);
      assert.fail(`expected a CliError for ${argv.join(" ")}`);
    } catch (error) {
      assert.ok(error instanceof CliError);
      assert.equal(error.exitCode, 2);
      assert.ok(error.message.includes(expected), `${argv.join(" ")}\n${error.message}`);
    }
  }
  // The attached form still reports eagerly.
  assert.throws(
    () => parseArgv(["mcp", "setup", "-s=bogus", "--pront"]),
    (error: unknown) => error instanceof CliError && error.message.includes("invalid value 'bogus'"),
  );
});

test("-- after a bare -s parks the missing value like clap's trailing mode", () => {
  // While the [CLIENT] slot is free (or argv ends), the parked -s propagates
  // its missing-value error at the next resolution point — even when it is a
  // duplicate occurrence.
  for (const argv of [
    ["mcp", "setup", "-s", "--"],
    ["mcp", "setup", "-s", "--", "x"],
    ["mcp", "setup", "-s", "user", "-s", "--", "x"],
  ]) {
    try {
      parseArgv(argv);
      assert.fail(`expected a CliError for ${argv.join(" ")}`);
    } catch (error) {
      assert.ok(error instanceof CliError);
      assert.equal(error.exitCode, 2);
      assert.ok(
        error.message.includes("a value is required for '-s <MCP_SCOPE>'"),
        `${argv.join(" ")}\n${error.message}`,
      );
    }
  }
  // Once the positional slot is taken, the extra-positional error wins and
  // the parked -s error is discarded: static usage, no tip.
  for (const tail of ["x", "--pront"]) {
    try {
      parseArgv(["mcp", "setup", "codex", "-s", "--", tail]);
      assert.fail(`expected a CliError for tail ${tail}`);
    } catch (error) {
      assert.ok(error instanceof CliError);
      assert.equal(error.exitCode, 2);
      assert.equal(
        error.message,
        `error: unexpected argument '${tail}' found\n\n` +
          "Usage: npx driggsby@latest mcp setup [OPTIONS] [CLIENT]\n\n" +
          "For more information, try '--help'.",
      );
    }
  }
});

test("a second slot-form -s drops the first from the rebuilt usage line", () => {
  const cases: [string[], string][] = [
    // One pending occurrence still renders its matcher entry…
    [
      ["mcp", "setup", "-s", "bogus", "--hepl"],
      "Usage: npx driggsby@latest mcp setup -s <MCP_SCOPE> --help [CLIENT]",
    ],
    // …but a repeat evicts it and never re-adds it.
    [
      ["mcp", "setup", "-s", "local", "-s", "user", "--hepl"],
      "Usage: npx driggsby@latest mcp setup --help [CLIENT]",
    ],
    [
      ["mcp", "setup", "--print", "-s", "local", "-s", "user", "--hepl"],
      "Usage: npx driggsby@latest mcp setup --print --help [CLIENT]",
    ],
  ];
  for (const [argv, usage] of cases) {
    try {
      parseArgv(argv);
      assert.fail(`expected a CliError for ${argv.join(" ")}`);
    } catch (error) {
      assert.ok(error instanceof CliError);
      assert.ok(error.message.includes(`\n${usage}\n`), `${argv.join(" ")}\n${error.message}`);
    }
  }
});
