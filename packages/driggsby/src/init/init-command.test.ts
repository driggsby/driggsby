import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runInNewContext } from "node:vm";

import { readProjectConfig } from "@driggsby/deploy";
import { transformSync } from "esbuild";

import { CliError } from "../cli-error.ts";
import { assertFitsTerminal } from "../test-support/terminal-width.ts";
import { type InitCommandIo, runInit } from "./init-command.ts";
import { APP_TOOL_ALLOWLIST } from "../dev/tool-allowlist.ts";
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
    css.includes("@keyframes fade-in"),
    "styles.css must define the first-data fade",
  );
  assert.ok(
    css.includes("prefers-reduced-motion"),
    "styles.css must disable the pulse and fade under reduced motion",
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

// The scaffold's app code is browser JavaScript stored as a string literal,
// invisible to tsc and ESLint; this parse gate turns a syntax slip in a
// template edit into a red build instead of a broken scaffold.
test("the scaffolded app.js parses as JavaScript", () => {
  assert.doesNotThrow(() => transformSync(APP_JS, { loader: "js" }));
});

// A DOM stub just wide enough to execute the scaffold's app.js and observe
// what it painted, so the no-flash invariant is tested behaviorally: sample
// numbers exist in the DOM only when the page is genuinely standalone.
class StubNode {
  id: string;
  className = "";
  textContent = "";
  hidden: boolean;
  removed = false;
  children: StubNode[] = [];
  classes: string[] = [];
  attributes = new Map<string, string>();
  classList = {
    add: (name: string): void => {
      if (!this.classes.includes(name)) this.classes.push(name);
    },
    contains: (name: string): boolean => this.classes.includes(name),
  };

  constructor(id = "", hidden = false) {
    this.id = id;
    this.hidden = hidden;
  }

  append(...nodes: StubNode[]): void {
    this.children.push(...nodes);
  }

  replaceChildren(...nodes: StubNode[]): void {
    this.children = nodes;
  }

  remove(): void {
    this.removed = true;
  }

  removeAttribute(name: string): void {
    this.attributes.delete(name);
  }
}

interface ScaffoldRun {
  overview: StubNode;
  accounts: StubNode;
  overviewSkeleton: StubNode[];
  accountsSkeleton: StubNode[];
  watches: Map<string, (result: unknown) => void>;
}

// Mirrors the shipped HTML: the containers start marked busy and holding
// their skeleton children (4 stat bars, 3 account rows), so the assertions
// about replacement are about a skeleton that was genuinely there.
function skeletonNodes(count: number): StubNode[] {
  return Array.from({ length: count }, () => {
    const node = new StubNode();
    node.className = "skeleton";
    return node;
  });
}

function runScaffoldAppJs(options: { embedded: boolean; sdkLoaded: boolean }): ScaffoldRun {
  const overview = new StubNode("overview");
  const accounts = new StubNode("accounts");
  const overviewSkeleton = skeletonNodes(4);
  const accountsSkeleton = skeletonNodes(3);
  overview.children = [...overviewSkeleton];
  accounts.children = [...accountsSkeleton];
  overview.attributes.set("aria-busy", "true");
  accounts.attributes.set("aria-busy", "true");
  const byId = new Map<string, StubNode>([
    ["overview", overview],
    ["accounts", accounts],
  ]);
  const watches = new Map<string, (result: unknown) => void>();
  const documentStub = {
    getElementById: (id: string): StubNode | null => byId.get(id) ?? null,
    createElement: (): StubNode => new StubNode(),
  };
  const driggsbyStub = options.sdkLoaded
    ? {
        watch: (
          tool: string,
          _params: Record<string, unknown>,
          callback: (result: unknown) => void,
        ): (() => void) => {
          watches.set(tool, callback);
          return () => undefined;
        },
      }
    : undefined;
  const windowStub: { parent: unknown; driggsby?: typeof driggsbyStub } = { parent: null };
  windowStub.parent = options.embedded ? {} : windowStub;
  if (driggsbyStub) windowStub.driggsby = driggsbyStub;
  runInNewContext(APP_JS, { window: windowStub, document: documentStub, driggsby: driggsbyStub });
  return { overview, accounts, overviewSkeleton, accountsSkeleton, watches };
}

function holdsNoSkeleton(container: StubNode, skeleton: StubNode[]): boolean {
  return container.children.every((child) => !skeleton.includes(child));
}

test("standalone, the scaffold paints sample data", () => {
  const run = runScaffoldAppJs({ embedded: false, sdkLoaded: false });
  assert.equal(run.overview.children.length, 4, "the four sample stats must paint");
  assert.equal(run.accounts.children.length, 3, "the three sample accounts must paint");
  assert.ok(
    holdsNoSkeleton(run.overview, run.overviewSkeleton) &&
      holdsNoSkeleton(run.accounts, run.accountsSkeleton),
    "the sample render must replace the skeleton, not stack under it",
  );
  assert.ok(
    run.overview.classList.contains("fade-in") && run.accounts.classList.contains("fade-in"),
    "the sample render must fade in",
  );
  assert.ok(
    !run.overview.attributes.has("aria-busy") && !run.accounts.attributes.has("aria-busy"),
    "aria-busy must clear once content lands",
  );
});

test("embedded, the shipped skeleton stands untouched until real data replaces it", () => {
  const run = runScaffoldAppJs({ embedded: true, sdkLoaded: true });
  // Before data arrives the script must not touch the containers: the
  // HTML-shipped skeleton stays, still marked busy — no sample values,
  // no loading text.
  assert.deepEqual(run.overview.children, run.overviewSkeleton, "the skeleton must survive");
  assert.deepEqual(run.accounts.children, run.accountsSkeleton, "the skeleton must survive");
  assert.equal(run.overview.attributes.get("aria-busy"), "true", "still busy before data");
  assert.ok(!run.overview.classList.contains("fade-in"), "nothing fades before data");

  // The first real results replace the skeleton and fade in.
  const overviewCallback = run.watches.get("get_overview");
  const accountsCallback = run.watches.get("list_accounts");
  assert.ok(overviewCallback, "the scaffold must watch get_overview");
  assert.ok(accountsCallback, "the scaffold must watch list_accounts");
  overviewCallback({
    summary_rollups: { cash: { amount: "10.00", currency_code: "USD" } },
  });
  accountsCallback({
    linked_accounts: [
      {
        institution_name: "Test Bank",
        account_display_name: "Checking",
        account_mask_last4: "1111",
        current_balance: { amount: "1.00", currency_code: "USD" },
      },
    ],
  });
  assert.equal(run.overview.children.length, 4);
  assert.equal(run.accounts.children.length, 1);
  assert.ok(
    holdsNoSkeleton(run.overview, run.overviewSkeleton) &&
      holdsNoSkeleton(run.accounts, run.accountsSkeleton),
    "real data must replace the skeleton, not stack under it",
  );
  const row = run.accounts.children[0];
  assert.ok(row, "the real account row must render");
  // Row shape: glyph pill (the institution's initial), names, balance.
  assert.equal(row.children[0]?.textContent, "T");
  assert.equal(row.children[1]?.children[0]?.textContent, "Checking");
  assert.ok(
    run.overview.classList.contains("fade-in") && run.accounts.classList.contains("fade-in"),
    "the first real render must fade in",
  );
  assert.ok(
    !run.overview.attributes.has("aria-busy") && !run.accounts.attributes.has("aria-busy"),
    "aria-busy must clear once real content lands",
  );
});

test("an empty accounts result renders the empty state, not a bare box", () => {
  const run = runScaffoldAppJs({ embedded: true, sdkLoaded: true });
  const accountsCallback = run.watches.get("list_accounts");
  assert.ok(accountsCallback, "the scaffold must watch list_accounts");
  accountsCallback({ linked_accounts: [] });
  assert.equal(run.accounts.children.length, 1);
  const emptyRow = run.accounts.children[0];
  assert.ok(emptyRow, "the empty state row must render");
  assert.equal(emptyRow.textContent, "No linked accounts yet.");
  assert.equal(emptyRow.className, "empty-row");
  assert.ok(run.accounts.classList.contains("fade-in"), "the empty state still fades in");
  assert.ok(!run.accounts.attributes.has("aria-busy"), "aria-busy must clear on the empty state");
});
