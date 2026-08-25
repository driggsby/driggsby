import assert from "node:assert/strict";
import { mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { DeployError } from "./errors.ts";
import { readProjectConfig, writeAssignedSlug } from "./project-config.ts";

async function projectDirectory(driggsbyJson?: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "driggsby-deploy-config-"));
  if (driggsbyJson !== undefined) {
    await writeFile(join(directory, "driggsby.json"), driggsbyJson);
  }
  return directory;
}

test("reads slug and serve, resolving serve against the project directory", async () => {
  const directory = await projectDirectory('{ "slug": "money-dash", "serve": "site" }');
  const config = await readProjectConfig(directory);
  assert.equal(config.slug, "money-dash");
  assert.equal(config.serveDirectory, join(directory, "site"));
  assert.equal(config.devCommand, null);
});

test("serve defaults to the project directory itself", async () => {
  const directory = await projectDirectory('{ "slug": "money-dash" }');
  const config = await readProjectConfig(directory);
  assert.equal(config.serveDirectory, directory);
});

test('an explicit "serve": null is refused, not defaulted', async () => {
  // `?? "."` would let null silently publish the whole project root; only a
  // genuinely absent "serve" gets the default.
  const directory = await projectDirectory('{ "slug": "money-dash", "serve": null }');
  await assert.rejects(readProjectConfig(directory), (error: unknown) => {
    assert.ok(error instanceof DeployError);
    assert.ok(error.message.includes('"serve"'));
    return true;
  });
});

test("a missing driggsby.json explains how to create one", async () => {
  const directory = await projectDirectory();
  await assert.rejects(readProjectConfig(directory), (error: unknown) => {
    assert.ok(error instanceof DeployError);
    assert.ok(error.message.includes("driggsby.json"));
    assert.ok(error.message.includes('"slug"'));
    return true;
  });
});

test("invalid JSON is reported as the file's problem, not a crash", async () => {
  const directory = await projectDirectory("{ not json");
  await assert.rejects(readProjectConfig(directory), (error: unknown) => {
    assert.ok(error instanceof DeployError);
    assert.ok(error.message.includes("driggsby.json"));
    return true;
  });
});

test("a bad slug is refused locally with the slug rules", async () => {
  const directory = await projectDirectory('{ "slug": "Bad Slug!" }');
  await assert.rejects(readProjectConfig(directory), (error: unknown) => {
    assert.ok(error instanceof DeployError);
    assert.ok(error.message.includes("lowercase"));
    return true;
  });
});

test("writeAssignedSlug rewrites only the slug, keeping every other field", async () => {
  const directory = await projectDirectory(
    '{ "slug": "money-dash", "serve": "site", "dev_command": "npm run dev" }',
  );
  await writeAssignedSlug(directory, "money-dash-x7k2qf");

  const raw = await readFile(join(directory, "driggsby.json"), "utf8");
  assert.ok(raw.endsWith("\n"));
  assert.deepEqual(JSON.parse(raw), {
    slug: "money-dash-x7k2qf",
    serve: "site",
    dev_command: "npm run dev",
  });
  const config = await readProjectConfig(directory);
  assert.equal(config.slug, "money-dash-x7k2qf");
});

test("writeAssignedSlug on an unreadable config fails with the manual fix", async () => {
  const directory = await projectDirectory("{ not json");
  await assert.rejects(writeAssignedSlug(directory, "money-dash-x7k2qf"), (error: unknown) => {
    assert.ok(error instanceof DeployError);
    assert.ok(error.message.includes("money-dash-x7k2qf"));
    assert.ok(error.message.includes('"slug"'));
    return true;
  });
});

test("a missing slug field is refused with the expected shape", async () => {
  const directory = await projectDirectory('{ "serve": "." }');
  await assert.rejects(readProjectConfig(directory), (error: unknown) => {
    assert.ok(error instanceof DeployError);
    assert.ok(error.message.includes('"slug"'));
    return true;
  });
});

test("a serve path escaping the project directory is refused", async () => {
  const directory = await projectDirectory('{ "slug": "money-dash", "serve": "../elsewhere" }');
  await assert.rejects(readProjectConfig(directory), (error: unknown) => {
    assert.ok(error instanceof DeployError);
    assert.ok(error.message.includes("serve"));
    return true;
  });
});

test("a serve folder that is a symlink to outside the project is refused", async () => {
  // The written value ("dist") looks in-project; only resolving the symlink
  // reveals the escape. Without the realpath check, every file in the
  // outside folder would upload and be served publicly.
  const outside = await mkdtemp(join(tmpdir(), "driggsby-deploy-outside-"));
  await writeFile(join(outside, "index.html"), "<h1>outside</h1>");
  const directory = await projectDirectory('{ "slug": "money-dash", "serve": "dist" }');
  await symlink(outside, join(directory, "dist"), "dir");
  await assert.rejects(readProjectConfig(directory), (error: unknown) => {
    assert.ok(error instanceof DeployError);
    assert.ok(error.message.includes("must stay inside the project"));
    return true;
  });
});

test("a serve folder reached through an in-project symlink is allowed", async () => {
  const directory = await projectDirectory('{ "slug": "money-dash", "serve": "dist" }');
  await writeFile(join(directory, "keep.txt"), "in-project");
  await symlink(join(directory, "."), join(directory, "dist"), "dir");
  const config = await readProjectConfig(directory);
  assert.equal(config.serveDirectory, join(directory, "dist"));
});

test("dev_command is surfaced when present", async () => {
  const directory = await projectDirectory(
    '{ "slug": "money-dash", "serve": ".", "dev_command": "npm run dev" }',
  );
  const config = await readProjectConfig(directory);
  assert.equal(config.devCommand, "npm run dev");
});
