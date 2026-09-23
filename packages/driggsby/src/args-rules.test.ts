import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { parseArgv } from "./args.ts";
import { MAX_PARAMS_FILE_BYTES } from "./args-rules.ts";
import { CliError } from "./cli-error.ts";
import { RULES_HELP } from "./help.ts";

function usageError(argv: string[], pattern: RegExp): void {
  assert.throws(
    () => parseArgv(argv),
    (error: unknown) => error instanceof CliError && error.exitCode === 2 && pattern.test(error.message),
  );
}

test("rules list parses with empty params", () => {
  assert.deepEqual(parseArgv(["rules", "list"]), { kind: "rules", action: "list", params: {} });
});

test("--params is the tool's arguments object, in both spellings", () => {
  assert.deepEqual(parseArgv(["rules", "preview", "--params", '{"rule":{"version":1}}']), {
    kind: "rules",
    action: "preview",
    params: { rule: { version: 1 } },
  });
  assert.deepEqual(parseArgv(["rules", "list", '--params={"rule_ref":"rule_1"}']), {
    kind: "rules",
    action: "list",
    params: { rule_ref: "rule_1" },
  });
});

test("--params-file reads the params from a file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "driggsby-rules-"));
  const path = join(directory, "save.json");
  await writeFile(path, '{"rule_ref":"rule_1","status":"paused"}');
  assert.deepEqual(parseArgv(["rules", "save", "--params-file", path]), {
    kind: "rules",
    action: "save",
    params: { rule_ref: "rule_1", status: "paused" },
  });
});

test("--params-file refuses a missing file and one past the size cap", async () => {
  const directory = await mkdtemp(join(tmpdir(), "driggsby-rules-"));
  usageError(["rules", "save", "--params-file", join(directory, "missing.json")], /couldn't read/);
  const big = join(directory, "big.json");
  await writeFile(big, `{"pad":"${"x".repeat(MAX_PARAMS_FILE_BYTES)}"}`);
  usageError(["rules", "save", "--params-file", big], /couldn't read/);
});

test("params must be one JSON object from one source", () => {
  usageError(["rules", "save", "--params", "[1]"], /must be a JSON object/);
  usageError(["rules", "save", "--params", "not json"], /must be a JSON object/);
  usageError(["rules", "save", "--params", "{}", "--params-file", "x.json"], /give the params once/);
  usageError(["rules", "save", "--params", "{}", "--params={}"], /give the params once/);
  usageError(["rules", "save", "--params"], /a value is required for '--params'/);
});

test("delete needs --yes, and --yes belongs to delete alone", () => {
  usageError(["rules", "delete", "--params", '{"rule_ref":"rule_1"}'], /can't be undone.*--yes/s);
  assert.deepEqual(parseArgv(["rules", "delete", "--params", '{"rule_ref":"rule_1"}', "--yes"]), {
    kind: "rules",
    action: "delete",
    params: { rule_ref: "rule_1" },
  });
  usageError(["rules", "list", "--yes"], /only applies to rules delete/);
});

test("describe takes no params", () => {
  usageError(["rules", "describe", "--params", "{}"], /describe takes no params/);
});

test("a missing or unknown action is a usage error with a suggestion", () => {
  usageError(["rules"], /required arguments were not provided:\n {2}<ACTION>/);
  usageError(["rules", "lsit"], /tip: a similar action exists: 'list'/);
  usageError(["rules", "list", "extra"], /unexpected argument 'extra'/);
});

test("rules -h prints the rules help", () => {
  assert.deepEqual(parseArgv(["rules", "-h"]), { kind: "print-help", text: RULES_HELP, stream: "stdout", exitCode: 0 });
});
