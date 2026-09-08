import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { readProjectConfig } from "@driggsby/deploy";
import { CliError } from "../cli-error.ts";
import { assertFitsTerminal } from "../test-support/terminal-width.ts";
import { type InitCommandIo, runInit } from "./init-command.ts";
import { APP_TOOL_ALLOWLIST } from "../dev/tool-allowlist.ts";

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
  // The template's own page background — kept in driggsby.json so
  // Driggsby paints the same color while the app loads. It is the
  // console's ground, so a fresh dashboard sits inside the dark chrome
  // as one surface, and it must equal the ground styles.css paints.
  assert.equal(config.background, "#000000");
  const scaffoldCss = await readFile(join(appDirectory, "styles.css"), "utf8");
  assert.ok(
    scaffoldCss.includes(`--bg-app: ${config.background};`),
    "driggsby.json's background must be the page ground styles.css paints",
  );
  assert.ok(scaffoldCss.includes("color-scheme: dark;"), "the scaffold is dark by default");

  const html = await readFile(join(appDirectory, "index.html"), "utf8");
  assert.ok(html.includes('src="/-/driggsby-sdk.js"'), "the page must load the Driggsby SDK");
  assert.ok(html.includes('src="app.js"'));
  assert.ok(html.includes("<title>money-dash</title>"));

  const appJs = await readFile(join(appDirectory, "app.js"), "utf8");
  assert.ok(appJs.includes('driggsby.watch("get_overview"'));
  assert.ok(appJs.includes('driggsby.watch("list_accounts"'));
  assert.ok(appJs.includes("Sample Bank"), "sample values must be obviously synthetic");
  assert.ok(
    appJs.includes("startViewTransition"),
    "the first data render must dissolve in via a View Transition",
  );
  // The scaffold is many builders' only documentation, so it must name
  // every tool an app can watch — an agent editing app.js discovers the
  // surface here, not by calling a wrong tool and reading the refusal.
  // Looping over the dev host's own allowlist (not a copied list) means
  // a tool added there without a scaffold mention is a red build.
  for (const tool of APP_TOOL_ALLOWLIST) {
    assert.ok(appJs.includes(tool), `app.js must name the watchable tool ${tool}`);
  }
  assert.ok(appJs.includes("npx driggsby@latest query <tool>"), "app.js must point at query");
  // The skeleton ships in the HTML itself so the first paint in every
  // context — before any script runs — is the final layout as muted bars.
  assert.equal(
    html.split('class="skeleton skeleton-value"').length - 1,
    4,
    "the four overview stats must ship as skeleton bars",
  );
  assert.equal(
    html.split('class="skeleton skeleton-name"').length - 1,
    3,
    "three account rows must ship as skeleton bars",
  );
  assert.equal(
    html.split('aria-busy="true"').length - 1,
    2,
    "both skeleton containers must ship marked busy for assistive tech",
  );
  const css = await readFile(join(appDirectory, "styles.css"), "utf8");
  assert.ok(css.includes(".skeleton"), "styles.css must style the skeleton bars");
  assert.ok(
    css.includes("prefers-reduced-motion"),
    "styles.css must disable the pulse under reduced motion",
  );

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
