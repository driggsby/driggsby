import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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

async function withDirectory(run: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "driggsby-rules-"));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
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

test("--params-file reads the params from a file, in both spellings", async () => {
  await withDirectory(async (directory) => {
    const path = join(directory, "save.json");
    await writeFile(path, '{"rule_ref":"rule_1","status":"paused"}');
    const expected = { kind: "rules", action: "save", params: { rule_ref: "rule_1", status: "paused" } };
    assert.deepEqual(parseArgv(["rules", "save", "--params-file", path]), expected);
    assert.deepEqual(parseArgv(["rules", "save", `--params-file=${path}`]), expected);
  });
});

test("--params-file reads a file saved with a byte-order mark or as UTF-16", async () => {
  await withDirectory(async (directory) => {
    const json = '{"rule_ref":"rule_1"}';
    const withBom = join(directory, "bom.json");
    await writeFile(withBom, `\uFEFF${json}`, "utf8");
    const utf16 = join(directory, "utf16.json");
    await writeFile(utf16, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(json, "utf16le")]));
    for (const path of [withBom, utf16]) {
      assert.deepEqual(parseArgv(["rules", "list", "--params-file", path]), {
        kind: "rules",
        action: "list",
        params: { rule_ref: "rule_1" },
      });
    }
  });
});

test("--params-file says what is wrong with a missing, special, or oversized file", async () => {
  await withDirectory(async (directory) => {
    const missing = join(directory, "missing.json");
    usageError(["rules", "save", "--params-file", missing], /couldn't read the --params-file: there's no file at that path/);
    const folder = join(directory, "folder");
    await mkdir(folder);
    usageError(["rules", "save", "--params-file", folder], /the path isn't a regular file/);
    const big = join(directory, "big.json");
    await writeFile(big, `{"pad":"${"x".repeat(MAX_PARAMS_FILE_BYTES)}"}`);
    usageError(["rules", "save", "--params-file", big], /it's over 1 MB/);
    for (const path of [missing, folder, big]) {
      assert.throws(
        () => parseArgv(["rules", "save", "--params-file", path]),
        (error: unknown) => error instanceof CliError && !error.message.includes(directory),
      );
    }
  });
});

test("params must be one JSON object from one source", () => {
  usageError(["rules", "save", "--params", "[1]"], /must be a JSON object/);
  usageError(["rules", "save", "--params", "not json"], /must be a JSON object[\s\S]*\n--params-file <PATH> instead\./);
  usageError(["rules", "save", "--params", "{}", "--params-file", "x.json"], /give the params once/);
  usageError(["rules", "save", "--params", "{}", "--params={}"], /give the params once/);
  usageError(["rules", "save", "--params"], /a value is required for '--params'/);
  usageError(["rules", "save", "--params="], /a value is required for '--params'/);
  usageError(["rules", "save", "--params-file="], /a value is required for '--params-file'/);
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

test("describe takes no params, and no file is read to say so", () => {
  usageError(["rules", "describe", "--params", "{}"], /describe takes no params/);
  usageError(["rules", "describe", "--params-file", "/no/such/file.json"], /describe takes no params/);
});

test("a missing or unknown action is a usage error with a suggestion", () => {
  usageError(["rules"], /required arguments were not provided:\n {2}<ACTION>/);
  usageError(["rules", "lsit"], /tip: a similar action exists: 'list'/);
  usageError(["rules", "list", "extra"], /unexpected argument 'extra'/);
  assert.throws(
    () => parseArgv(["rules", "\u001b]0;x\u0007list"]),
    (error: unknown) => error instanceof CliError && !/\p{Cc}/u.test(error.message.split("\n")[0] ?? ""),
  );
});

test("help wins wherever it appears", () => {
  const help = { kind: "print-help", text: RULES_HELP, stream: "stdout", exitCode: 0 };
  assert.deepEqual(parseArgv(["rules", "-h"]), help);
  assert.deepEqual(parseArgv(["rules", "list", "-h"]), help);
  assert.deepEqual(parseArgv(["rules", "lsit", "--help"]), help);
  assert.deepEqual(parseArgv(["rules", "save", "--params-file", "/no/such/file.json", "--help"]), help);
});
