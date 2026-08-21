// Builds a temp directory containing a fake POSIX credential tool (`security`
// or `secret-tool`) for tests: a shell shim that delegates to a Node script.
// The fake's behavior is driven by environment variables:
//   FAKE_TOOL_BEHAVIOR: found | missing | fail    (reads/lookups)
//   FAKE_TOOL_TOKEN: the token value a "found" read prints
//   FAKE_TOOL_WRITE_BEHAVIOR: ok | fail           (writes; defaults from BEHAVIOR)
//   FAKE_TOOL_DELETE_BEHAVIOR: ok | missing | fail (deletes; defaults from BEHAVIOR)
// Every invocation appends one JSON line {argv, stdin} to FAKE_TOOL_LOG so
// tests can assert the exact arguments and stdin the CLI sent. Windows never
// runs these tools (the file store is the Windows backend), so there is no
// .cmd variant; tests that use this helper skip on win32.
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

const FAKE_SCRIPT = `
const { appendFileSync } = require("node:fs");
const chunks = [];
process.stdin.on("data", (chunk) => chunks.push(chunk));
process.stdin.on("end", () => {
  const stdin = Buffer.concat(chunks).toString("utf8");
  const argv = process.argv.slice(2);
  if (process.env.FAKE_TOOL_LOG) {
    appendFileSync(process.env.FAKE_TOOL_LOG, JSON.stringify({ argv, stdin }) + "\\n");
  }
  const behavior = process.env.FAKE_TOOL_BEHAVIOR ?? "found";
  const isRead = argv.includes("find-generic-password") || argv[0] === "lookup";
  const isDelete = argv.includes("delete-generic-password") || argv[0] === "clear";
  if (isRead) {
    if (behavior === "missing") {
      // security exits 44 for errSecItemNotFound; secret-tool lookup exits 1
      // with no output. The backends accept either.
      process.exit(argv[0] === "lookup" ? 1 : 44);
    }
    if (behavior === "fail") {
      process.stderr.write("fake tool failure");
      process.exit(70);
    }
    const token = process.env.FAKE_TOOL_TOKEN ?? "";
    process.stdout.write(argv[0] === "lookup" ? token : token + "\\n");
    process.exit(0);
  }
  if (isDelete) {
    const deleteBehavior =
      process.env.FAKE_TOOL_DELETE_BEHAVIOR ??
      (behavior === "fail" ? "fail" : behavior === "missing" ? "missing" : "ok");
    if (deleteBehavior === "fail") {
      process.stderr.write("fake tool failure");
      process.exit(51);
    }
    if (deleteBehavior === "missing") {
      // Real secret-tool clear exits 0 whether or not anything matched;
      // security delete-generic-password exits 44 for a missing item.
      process.exit(argv[0] === "clear" ? 0 : 44);
    }
    process.exit(0);
  }
  const writeBehavior =
    process.env.FAKE_TOOL_WRITE_BEHAVIOR ?? (behavior === "fail" ? "fail" : "ok");
  if (writeBehavior === "fail") {
    process.stderr.write("fake tool failure");
    process.exit(70);
  }
  process.exit(0);
});
`;

function installFakeCredentialTool(name: "security" | "secret-tool"): {
  pathPrefix: string;
  toolPath: string;
} {
  const directory = mkdtempSync(join(tmpdir(), "driggsby-fake-tool-"));
  const scriptPath = join(directory, `${name}-impl.cjs`);
  writeFileSync(scriptPath, FAKE_SCRIPT);
  const shimPath = join(directory, name);
  writeFileSync(shimPath, `#!/bin/sh\nexec node "$(dirname "$0")/${name}-impl.cjs" "$@"\n`);
  chmodSync(shimPath, 0o755);
  return { pathPrefix: directory, toolPath: shimPath };
}

function pathWithFakeTool(pathPrefix: string): string {
  return `${pathPrefix}${delimiter}${process.env.PATH ?? ""}`;
}

export interface FakeToolEnvironment {
  spawnEnv: NodeJS.ProcessEnv;
  // The fake binary's absolute path, for backends that take an explicit
  // program path instead of resolving through PATH.
  toolPath: string;
  calls: () => { argv: string[]; stdin: string }[];
}

// One fake-tool test environment: the fake on PATH, its behavior variables
// set, and a calls() reader over the JSONL invocation log.
export function fakeCredentialToolEnvironment(
  name: "security" | "secret-tool",
  behavior: string,
  options: { token?: string; writeBehavior?: string; deleteBehavior?: string } = {},
): FakeToolEnvironment {
  const { pathPrefix, toolPath } = installFakeCredentialTool(name);
  const logPath = join(mkdtempSync(join(tmpdir(), "driggsby-tool-log-")), "calls.jsonl");
  const spawnEnv: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: pathWithFakeTool(pathPrefix),
    FAKE_TOOL_BEHAVIOR: behavior,
    FAKE_TOOL_LOG: logPath,
    ...(options.token === undefined ? {} : { FAKE_TOOL_TOKEN: options.token }),
    ...(options.writeBehavior === undefined
      ? {}
      : { FAKE_TOOL_WRITE_BEHAVIOR: options.writeBehavior }),
    ...(options.deleteBehavior === undefined
      ? {}
      : { FAKE_TOOL_DELETE_BEHAVIOR: options.deleteBehavior }),
  };
  const calls = (): { argv: string[]; stdin: string }[] => {
    let raw: string;
    try {
      raw = readFileSync(logPath, "utf8");
    } catch {
      return [];
    }
    return raw
      .trim()
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => JSON.parse(line) as { argv: string[]; stdin: string });
  };
  return { spawnEnv, toolPath, calls };
}
