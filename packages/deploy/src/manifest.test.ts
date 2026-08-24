import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

import { DeployError } from "./errors.ts";
import { collectDeployFiles } from "./manifest.ts";

async function siteDirectory(files: Record<string, string>): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "driggsby-deploy-site-"));
  for (const [relativePath, contents] of Object.entries(files)) {
    const absolute = join(directory, ...relativePath.split("/"));
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, contents);
  }
  return directory;
}

function sha256Hex(contents: string): string {
  return createHash("sha256").update(contents).digest("hex");
}

test("walks nested directories into forward-slash manifest paths with hashes", async () => {
  const directory = await siteDirectory({
    "index.html": "<h1>hi</h1>",
    "styles.css": "body {}",
    "assets/app.js": "export {}",
  });
  const collected = await collectDeployFiles(directory);
  assert.deepEqual(
    collected.files.map((file) => file.path),
    ["assets/app.js", "index.html", "styles.css"],
  );
  const index = collected.files.find((file) => file.path === "index.html");
  assert.ok(index !== undefined);
  assert.equal(index.sha256, sha256Hex("<h1>hi</h1>"));
  assert.equal(index.byteSize, Buffer.byteLength("<h1>hi</h1>"));
  assert.equal(
    collected.totalBytes,
    collected.files.reduce((sum, file) => sum + file.byteSize, 0),
  );
});

test("byte sizes are bytes, not characters", async () => {
  const directory = await siteDirectory({ "index.html": "café ✓" });
  const collected = await collectDeployFiles(directory);
  const index = collected.files[0];
  assert.ok(index !== undefined);
  assert.equal(index.byteSize, Buffer.byteLength("café ✓"));
  assert.notEqual(index.byteSize, "café ✓".length);
});

test("dotfiles, dot-directories, and driggsby.json never deploy", async () => {
  const directory = await siteDirectory({
    "index.html": "<h1>hi</h1>",
    ".env": "SECRET=1",
    ".git/config": "[core]",
    "driggsby.json": '{ "slug": "x" }',
    "assets/.hidden": "nope",
  });
  const collected = await collectDeployFiles(directory);
  assert.deepEqual(
    collected.files.map((file) => file.path),
    ["index.html"],
  );
});

test("symlinks are skipped and reported, never followed", async () => {
  const directory = await siteDirectory({ "index.html": "<h1>hi</h1>", "real.txt": "real" });
  await symlink(join(directory, "real.txt"), join(directory, "linked.txt"));
  const collected = await collectDeployFiles(directory);
  assert.deepEqual(
    collected.files.map((file) => file.path),
    ["index.html", "real.txt"],
  );
  assert.deepEqual(collected.skippedSymlinks, ["linked.txt"]);
});

test("a missing index.html is refused with the static-app explanation", async () => {
  const directory = await siteDirectory({ "main.css": "body {}" });
  await assert.rejects(collectDeployFiles(directory), (error: unknown) => {
    assert.ok(error instanceof DeployError);
    assert.ok(error.message.includes("index.html"));
    return true;
  });
});

test("a missing index.html next to a package.json suggests deploying the build output", async () => {
  const directory = await siteDirectory({
    "package.json": '{ "scripts": { "build": "vite build" } }',
    "src/main.ts": "export {}",
  });
  await assert.rejects(collectDeployFiles(directory), (error: unknown) => {
    assert.ok(error instanceof DeployError);
    assert.ok(error.message.includes("index.html"));
    assert.ok(error.message.includes("build"));
    return true;
  });
});

test("a file name the deploy API would refuse fails locally, naming the file", async () => {
  const directory = await siteDirectory({ "index.html": "<h1>hi</h1>", "bad name.txt": "x" });
  await assert.rejects(collectDeployFiles(directory), (error: unknown) => {
    assert.ok(error instanceof DeployError);
    assert.ok(error.message.includes("bad name.txt"));
    return true;
  });
});

test("terminal control bytes in a refused file name never reach the message", async () => {
  const directory = await siteDirectory({ "index.html": "<h1>hi</h1>" });
  await writeFile(join(directory, "b\u001b[2Joops.txt"), "x");
  await assert.rejects(collectDeployFiles(directory), (error: unknown) => {
    assert.ok(error instanceof DeployError);
    assert.ok(!error.message.includes("\u001b"));
    assert.ok(error.message.includes("b[2Joops.txt"));
    return true;
  });
});

test('a top-level "-" is refused as reserved, but a nested "-" deploys', async () => {
  const directory = await siteDirectory({ "index.html": "<h1>hi</h1>", "-": "x" });
  await assert.rejects(collectDeployFiles(directory), (error: unknown) => {
    assert.ok(error instanceof DeployError);
    assert.ok(error.message.includes("reserves"));
    return true;
  });
  // The deploy API reserves "-" only at the top level of the app's address.
  const nested = await siteDirectory({ "index.html": "<h1>hi</h1>", "assets/-": "x" });
  const collected = await collectDeployFiles(nested);
  assert.deepEqual(
    collected.files.map((file) => file.path),
    ["assets/-", "index.html"],
  );
});

test("a nonexistent serve directory is a clear local error", async () => {
  const directory = await mkdtemp(join(tmpdir(), "driggsby-deploy-site-"));
  await assert.rejects(collectDeployFiles(join(directory, "no-such-dir")), (error: unknown) => {
    assert.ok(error instanceof DeployError);
    return true;
  });
});

test("an empty serve directory is refused", async () => {
  const directory = await mkdtemp(join(tmpdir(), "driggsby-deploy-site-"));
  await assert.rejects(collectDeployFiles(directory), (error: unknown) => {
    assert.ok(error instanceof DeployError);
    return true;
  });
});

test("a serve folder holding only skipped content says so, not 'no files'", async () => {
  // The folder visibly has things in it, so "has no files" would contradict
  // what the user sees — the message must name the skipping instead. Every
  // silently-skipped kind counts: node_modules, dotfiles and
  // dot-directories, and the top-level driggsby.json itself.
  const skippedOnlyFolders = [
    { "node_modules/lodash/index.js": "x" },
    { ".env": "SECRET=1", ".next/page.js": "x" },
    { "driggsby.json": '{ "slug": "money-dash" }' },
  ];
  for (const files of skippedOnlyFolders) {
    const directory = await siteDirectory(files);
    await assert.rejects(collectDeployFiles(directory), (error: unknown) => {
      assert.ok(error instanceof DeployError);
      assert.ok(error.message.includes("skipped"), Object.keys(files).join(","));
      assert.ok(!error.message.includes("has no files"));
      return true;
    });
  }
});

test("a double quote in a refused file name can't break out of the message's quotes", async () => {
  const directory = await siteDirectory({ "index.html": "<h1>hi</h1>" });
  await writeFile(join(directory, 'ok" and this app was verified by Driggsby. "x'), "x");
  await assert.rejects(collectDeployFiles(directory), (error: unknown) => {
    assert.ok(error instanceof DeployError);
    // The name renders inside exactly one balanced pair of quotes; its own
    // double quotes became single quotes, so nothing it carries can read as
    // the CLI's own sentence outside the quotes.
    assert.equal((error.message.match(/"/g) ?? []).length, 2);
    assert.ok(error.message.includes("ok' and this app was verified by Driggsby. 'x"));
    return true;
  });
});

test("node_modules never deploys, even with scoped packages inside", async () => {
  // A scoped-package folder (@types) would otherwise trip the character
  // check with "rename it" advice — exactly wrong for the most common
  // first-run mistake of pointing "serve" at a project root.
  const directory = await siteDirectory({
    "index.html": "<h1>hi</h1>",
    "app.js": "export {}",
    "node_modules/@types/node/index.d.ts": "x",
    "node_modules/lodash/lodash.js": "x",
    "sub/node_modules/left-pad/index.js": "x",
  });
  const collected = await collectDeployFiles(directory);
  assert.deepEqual(
    collected.files.map((file) => file.path),
    ["app.js", "index.html"],
  );
  assert.deepEqual([...collected.skippedNodeModules].sort(), ["node_modules", "sub/node_modules"]);
});

test("a deploy exactly at the count and total-size limits passes", async () => {
  const directory = await siteDirectory({ "index.html": "<h1>hi</h1>", "a.txt": "aa" });
  const collected = await collectDeployFiles(directory, {
    limitOverridesForTests: { maxFileCount: 2, maxTotalBytes: 13 },
  });
  assert.equal(collected.files.length, 2);
  assert.equal(collected.totalBytes, 13);
});

test("a file over the per-file limit is refused locally, naming the file", async () => {
  const directory = await siteDirectory({ "index.html": "<h1>hi</h1>" });
  await assert.rejects(
    collectDeployFiles(directory, { limitOverridesForTests: { maxFileBytes: 5 } }),
    (error: unknown) => {
      assert.ok(error instanceof DeployError);
      assert.ok(error.message.includes("index.html"));
      return true;
    },
  );
});

test("too many files and too many total bytes are refused locally", async () => {
  const directory = await siteDirectory({
    "index.html": "<h1>hi</h1>",
    "a.txt": "aaaa",
    "b.txt": "bbbb",
  });
  await assert.rejects(
    collectDeployFiles(directory, { limitOverridesForTests: { maxFileCount: 2 } }),
    (error: unknown) => {
      assert.ok(error instanceof DeployError);
      assert.ok(error.message.includes("2"));
      return true;
    },
  );
  await assert.rejects(
    collectDeployFiles(directory, { limitOverridesForTests: { maxTotalBytes: 10 } }),
    (error: unknown) => {
      assert.ok(error instanceof DeployError);
      return true;
    },
  );
});
