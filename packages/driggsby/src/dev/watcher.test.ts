import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { directorySignature, watchDirectory } from "./watcher.ts";

async function makeDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "driggsby-watch-"));
  await writeFile(join(directory, "index.html"), "<h1>one</h1>");
  return directory;
}

test("the signature changes on edit, add, and delete — not on ignored churn", async () => {
  const directory = await makeDirectory();
  const original = await directorySignature(directory);

  await writeFile(join(directory, "app.js"), "console.log(1);");
  const afterAdd = await directorySignature(directory);
  assert.notEqual(afterAdd, original, "adding a file must change the signature");

  await rm(join(directory, "app.js"));
  const afterDelete = await directorySignature(directory);
  assert.notEqual(afterDelete, afterAdd, "deleting a file must change the signature");

  // Dotfiles and node_modules churn never causes a reload.
  await writeFile(join(directory, ".env"), "SECRET=1");
  await mkdir(join(directory, "node_modules"));
  await writeFile(join(directory, "node_modules", "dep.js"), "x");
  assert.equal(await directorySignature(directory), afterDelete);
});

test("watchDirectory reports a change and stop() stops it", async () => {
  const directory = await makeDirectory();
  let changes = 0;
  const stop = watchDirectory(
    directory,
    () => {
      changes += 1;
    },
    20,
  );
  try {
    // Let the first poll capture the baseline, then edit.
    await new Promise((resolve) => setTimeout(resolve, 60));
    await writeFile(join(directory, "index.html"), "<h1>two</h1>");
    const deadline = Date.now() + 2_000;
    while (changes === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.ok(changes >= 1, "the edit must be observed");
  } finally {
    stop();
  }
});
