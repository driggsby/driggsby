import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { readProjectConfig } from "@driggsby/deploy";
import { transformSync } from "esbuild";

import { CliError } from "../cli-error.ts";
import { assertFitsTerminal } from "../test-support/terminal-width.ts";
import { type InitCommandIo, runInit } from "./init-command.ts";
import { APP_JS } from "./templates.ts";

function makeIo(overrides: Partial<InitCommandIo> = {}): InitCommandIo & { text: () => string } {
  let buffer = "";
  return {
    out: (text) => {
      buffer += text;
    },
    ask: () => Promise.reject(new Error("ask must not be called")),
    interactive: false,
    text: () => buffer,
    ...overrides,
  };
}

async function makeParent(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "driggsby-init-"));
}

test("init scaffolds a working app that deploy's own config reader accepts", async () => {
  const parent = await makeParent();
  const io = makeIo();

  const exitCode = await runInit({ slug: "money-dash", parentDirectory: parent }, io);

  assert.equal(exitCode, 0);
  const appDirectory = join(parent, "money-dash");
  assert.deepEqual((await readdir(appDirectory)).sort(), [
    "app.js",
    "driggsby.json",
    "index.html",
    "styles.css",
  ]);

  // The scaffolded driggsby.json must be exactly what deploy reads.
  const config = await readProjectConfig(appDirectory);
  assert.equal(config.slug, "money-dash");
  assert.equal(config.serve, ".");

  const html = await readFile(join(appDirectory, "index.html"), "utf8");
  assert.ok(html.includes('src="/-/driggsby-sdk.js"'), "the page must load the Driggsby SDK");
  assert.ok(html.includes('src="app.js"'));
  assert.ok(html.includes("<title>money-dash</title>"));
  assert.ok(html.includes("Sample data"), "the page must label its data as sample data");

  const appJs = await readFile(join(appDirectory, "app.js"), "utf8");
  assert.ok(appJs.includes('driggsby.watch("get_overview"'));
  assert.ok(appJs.includes('driggsby.watch("list_accounts"'));
  assert.ok(appJs.includes("Sample Bank"), "sample values must be obviously synthetic");

  const text = io.text();
  assert.ok(text.includes("✓ Created   money-dash/"));
  assert.ok(text.includes("cd money-dash"));
  assert.ok(text.includes("npx driggsby@latest dev"));
  assert.ok(text.includes("npx driggsby@latest deploy"));
  assertFitsTerminal(text);
});

test("init without a name asks for one when a person is attached", async () => {
  const parent = await makeParent();
  const questions: string[] = [];
  const io = makeIo({
    interactive: true,
    ask: (question) => {
      questions.push(question);
      return Promise.resolve("  money-dash  ");
    },
  });

  const exitCode = await runInit({ slug: null, parentDirectory: parent }, io);

  assert.equal(exitCode, 0);
  assert.equal(questions.length, 1);
  assert.ok(
    io.text().includes("<NAME>-x7k2qf.driggsby.dev"),
    "the prompt explains that the deployed address gets a unique ending",
  );
  assert.deepEqual((await readdir(join(parent, "money-dash"))).length, 4);
});

test("init without a name in a non-interactive terminal explains the exact re-run", async () => {
  const parent = await makeParent();
  const io = makeIo();

  const error = await runInit({ slug: null, parentDirectory: parent }, io).then(
    () => assert.fail("must not scaffold"),
    (thrown: unknown) => thrown,
  );

  assert.ok(error instanceof CliError);
  assert.equal(error.exitCode, 2);
  assert.ok(error.message.includes("npx driggsby@latest init <NAME>"));
  assertFitsTerminal(error.message);
});

test("an invalid name from argv is a usage error with the slug rules", async () => {
  const parent = await makeParent();
  const io = makeIo();

  const error = await runInit({ slug: "Bad Name!", parentDirectory: parent }, io).then(
    () => assert.fail("must not scaffold"),
    (thrown: unknown) => thrown,
  );

  assert.ok(error instanceof CliError);
  assert.equal(error.exitCode, 2);
  assert.ok(error.message.includes('"Bad Name!"'), "the refused name echoes inside quotes");
  assert.ok(error.message.includes("lowercase letters"));
  assert.ok(error.message.includes("npx driggsby@latest init <NAME>"));
  assertFitsTerminal(error.message);
});

test("a hostile prompted name echoes sanitized, quoted, and exits 1", async () => {
  const parent = await makeParent();
  const io = makeIo({
    interactive: true,
    ask: () => Promise.resolve("evil\u001B[2Jname"),
  });

  const error = await runInit({ slug: null, parentDirectory: parent }, io).then(
    () => assert.fail("must not scaffold"),
    (thrown: unknown) => thrown,
  );

  assert.ok(error instanceof CliError);
  assert.equal(error.exitCode, 1);
  assert.ok(!error.message.includes("\u001B"), "control bytes must never reach the terminal");
  assert.ok(error.message.includes('"evil[2Jname"'));
});

test("names that used to be reserved scaffold fine — the server assigns a suffixed address", async () => {
  const parent = await makeParent();

  const exitCode = await runInit({ slug: "dashboard", parentDirectory: parent }, makeIo());

  assert.equal(exitCode, 0);
  const config = await readProjectConfig(join(parent, "dashboard"));
  assert.equal(config.slug, "dashboard");
});

test("init refuses a non-empty existing folder and touches nothing in it", async () => {
  const parent = await makeParent();
  await mkdir(join(parent, "money-dash"));
  await writeFile(join(parent, "money-dash", "notes.txt"), "keep me");

  const error = await runInit({ slug: "money-dash", parentDirectory: parent }, makeIo()).then(
    () => assert.fail("must not scaffold"),
    (thrown: unknown) => thrown,
  );

  assert.ok(error instanceof CliError);
  assert.equal(error.exitCode, 1);
  assert.ok(error.message.includes("already exists"));
  assert.deepEqual(await readdir(join(parent, "money-dash")), ["notes.txt"]);
  assert.equal(await readFile(join(parent, "money-dash", "notes.txt"), "utf8"), "keep me");
});

test("init refuses when a file (not a folder) already has the name", async () => {
  const parent = await makeParent();
  await writeFile(join(parent, "money-dash"), "a file");

  const error = await runInit({ slug: "money-dash", parentDirectory: parent }, makeIo()).then(
    () => assert.fail("must not scaffold"),
    (thrown: unknown) => thrown,
  );

  assert.ok(error instanceof CliError);
  assert.equal(await readFile(join(parent, "money-dash"), "utf8"), "a file");
});

test("init fills an existing empty folder", async () => {
  const parent = await makeParent();
  await mkdir(join(parent, "money-dash"));

  const exitCode = await runInit({ slug: "money-dash", parentDirectory: parent }, makeIo());

  assert.equal(exitCode, 0);
  assert.equal((await readdir(join(parent, "money-dash"))).length, 4);
});

// The scaffold's app code is browser JavaScript stored as a string literal,
// invisible to tsc and ESLint; this parse gate turns a syntax slip in a
// template edit into a red build instead of a broken scaffold.
test("the scaffolded app.js parses as JavaScript", () => {
  assert.doesNotThrow(() => transformSync(APP_JS, { loader: "js" }));
});
