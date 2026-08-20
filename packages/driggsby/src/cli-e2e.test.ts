// End-to-end tests against the BUILT CLI (dist/main.js, the exact code npm
// ships) — pretest builds it. Output parity is asserted byte-for-byte against
// fixtures captured from the final Rust CLI (driggsby 0.1.42).
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { installFakeClientCli, pathWithFake } from "./test-support/fake-client-cli.ts";
import { VERSION } from "./version.ts";

const run = promisify(execFile);
const CLI = fileURLToPath(new URL("../dist/main.js", import.meta.url));

function fixture(name: string): string {
  return readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url), "utf8");
}

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function cli(args: string[], env?: Record<string, string>): Promise<CliResult> {
  try {
    const { stdout, stderr } = await run(process.execPath, [CLI, ...args], {
      env: { ...process.env, ...env },
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return { code: failure.code ?? 1, stdout: failure.stdout ?? "", stderr: failure.stderr ?? "" };
  }
}

test("no arguments prints help to stderr and exits 2", async () => {
  const result = await cli([]);

  assert.equal(result.code, 2);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, fixture("help.txt"));
});

test("--help prints help to stdout and exits 0", async () => {
  const result = await cli(["--help"]);

  assert.equal(result.code, 0);
  assert.equal(result.stdout, fixture("help.txt"));
});

test("--version prints the package version", async () => {
  const result = await cli(["--version"]);

  assert.equal(result.code, 0);
  assert.equal(result.stdout, `driggsby ${VERSION}\n`);
});

test("mcp setup --print matches the Rust CLI byte-for-byte", async () => {
  for (const [args, name] of [
    [["mcp", "setup", "claude-code", "--print"], "print-claude.txt"],
    [["mcp", "setup", "claude-code", "--print", "-s", "local"], "print-claude-local.txt"],
    [["mcp", "setup", "codex", "--print"], "print-codex.txt"],
  ] as const) {
    const result = await cli([...args]);
    assert.equal(result.code, 0);
    assert.equal(result.stdout, fixture(name));
  }
});

test("mcp setup other prints OAuth instructions", async () => {
  const result = await cli(["mcp", "setup", "other"]);

  assert.equal(result.code, 0);
  assert.equal(result.stdout, fixture("other.txt"));
});

test("an unsupported client errors on stderr with exit 1", async () => {
  const result = await cli(["mcp", "setup", "raycast"]);

  assert.equal(result.code, 1);
  assert.equal(result.stderr, fixture("unsupported-stderr.txt"));
});

test("a non-TTY run without a client asks for one and exits 1", async () => {
  const result = await cli(["mcp", "setup"]);

  assert.equal(result.code, 1);
  assert.equal(result.stderr, fixture("nontty.txt"));
});

test("-s outside Claude Code errors with exit 1", async () => {
  const result = await cli(["mcp", "setup", "codex", "-s", "user"]);

  assert.equal(result.code, 1);
  assert.equal(result.stderr, fixture("scope-error.txt"));
});

test("setup installs through the client CLI and reports success", async () => {
  const fake = installFakeClientCli("claude");
  const result = await cli(["mcp", "setup", "claude-code"], {
    PATH: pathWithFake(fake.pathPrefix),
    FAKE_GET_BEHAVIOR: "missing",
    FAKE_ADD_BEHAVIOR: "ok",
  });

  assert.equal(result.code, 0);
  assert.ok(result.stdout.includes("Checking for Driggsby in Claude Code MCP config..."));
  assert.ok(result.stdout.includes("Adding Driggsby to Claude Code MCP config..."));
  assert.ok(result.stdout.includes("Claude Code is set up."));
  assert.ok(
    result.stdout.includes("Open Claude Code, run /mcp, and authenticate Driggsby to get started."),
  );
});

test("setup is idempotent when the config already matches", async () => {
  const fake = installFakeClientCli("claude");
  const result = await cli(["mcp", "setup", "claude-code"], {
    PATH: pathWithFake(fake.pathPrefix),
    FAKE_GET_BEHAVIOR: "matches",
  });

  assert.equal(result.code, 0);
  assert.ok(result.stdout.includes("Driggsby is already set up in Claude Code MCP config."));
  assert.ok(!result.stdout.includes("Adding Driggsby"));
});

test("a different existing entry prints remove+add remediation", async () => {
  const fake = installFakeClientCli("claude");
  const result = await cli(["mcp", "setup", "claude-code"], {
    PATH: pathWithFake(fake.pathPrefix),
    FAKE_GET_BEHAVIOR: "differs",
  });

  assert.equal(result.code, 0);
  assert.ok(result.stdout.includes("does not match the expected Driggsby setup."));
  assert.ok(result.stdout.includes("claude mcp remove driggsby -s user"));
  assert.ok(
    result.stdout.includes("claude mcp add --transport http -s user driggsby 'https://app.driggsby.com/mcp'"),
  );
});

test("a client that is not installed still hands the user the manual command", async () => {
  const result = await cli(["mcp", "setup", "claude-code"], {
    PATH: installFakeClientCli("codex").pathPrefix,
  });

  assert.equal(result.code, 0);
  assert.ok(result.stdout.includes("Claude Code is not installed or not on PATH."));
  assert.ok(result.stdout.includes("Run this command to add Driggsby to Claude Code:"));
});
