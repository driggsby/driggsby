// deployProjectFiles: the create-on-first-deploy orchestration (server-
// assigned slugs). The plain upload protocol lives in deploy.test.ts.
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { deployProjectFiles } from "./deploy.ts";
import { DeployApiError, DeployError } from "./errors.ts";
import { collectDeployFiles } from "./manifest.ts";
import { readProjectConfig } from "./project-config.ts";
import { startFakeDeployServer } from "./test-support/fake-deploy-server.ts";

const TOKEN = "dgb_at_test_token_2222";

async function siteDirectory(files: Record<string, string>): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "driggsby-deploy-project-"));
  for (const [name, contents] of Object.entries(files)) {
    await writeFile(join(directory, name), contents);
  }
  return directory;
}

test("deployProjectFiles deploys straight to an existing app without creating anything", async () => {
  const server = await startFakeDeployServer();
  try {
    const directory = await siteDirectory({
      "index.html": "<h1>hi</h1>",
      "driggsby.json": '{ "slug": "money-dash-x7k2qf", "serve": "." }',
    });
    const collected = await collectDeployFiles(directory);
    const { outcome, createdApp } = await deployProjectFiles(
      { baseUrl: server.baseUrl, token: TOKEN },
      directory,
      "money-dash-x7k2qf",
      collected,
      { live: true },
    );
    assert.equal(createdApp, null);
    assert.equal(outcome.appSlug, "money-dash-x7k2qf");
    assert.ok(!server.requests.some((request) => request.path === "/deploy/apps"));
    // driggsby.json stays byte-for-byte untouched when nothing was created.
    const config = await readProjectConfig(directory);
    assert.equal(config.slug, "money-dash-x7k2qf");
  } finally {
    await server.close();
  }
});

test("deployProjectFiles creates the app, saves the assigned slug before uploading, then deploys", async () => {
  const server = await startFakeDeployServer();
  try {
    const directory = await siteDirectory({
      "index.html": "<h1>hi</h1>",
      "driggsby.json": '{ "slug": "money-dash", "serve": "." }',
    });
    const collected = await collectDeployFiles(directory);
    server.injectResponse("POST", "/deploy/apps/money-dash/versions", 404, {
      error: "app_not_found",
      error_description: "We couldn't find an app with that slug under this account.",
    });

    const notified: string[] = [];
    const { outcome, createdApp } = await deployProjectFiles(
      { baseUrl: server.baseUrl, token: TOKEN },
      directory,
      "money-dash",
      collected,
      {
        live: true,
        onAppCreated: (created) => {
          notified.push(created.appSlug);
        },
      },
    );

    assert.ok(createdApp !== null);
    assert.match(createdApp.appSlug, /^money-dash-[a-z0-9]{6}$/);
    assert.equal(outcome.appSlug, createdApp.appSlug);
    assert.deepEqual(notified, [createdApp.appSlug]);

    // The assigned slug is persisted in driggsby.json...
    const config = await readProjectConfig(directory);
    assert.equal(config.slug, createdApp.appSlug);

    // ...and was persisted BEFORE any bytes uploaded: the create request
    // lands strictly ahead of every blob PUT.
    const paths = server.requests.map((request) => `${request.method} ${request.path}`);
    const createIndex = paths.indexOf("POST /deploy/apps");
    const firstUploadIndex = paths.findIndex((entry) => entry.startsWith("PUT /deploy/blobs/"));
    assert.ok(createIndex !== -1);
    assert.ok(firstUploadIndex !== -1);
    assert.ok(createIndex < firstUploadIndex);
  } finally {
    await server.close();
  }
});

test("the assigned slug is already saved when the first blob upload fails mid-deploy", async () => {
  // The invariant the create flow exists for: a deploy that dies mid-upload
  // must never strand an app the project forgot. Failing the first blob PUT
  // and finding the assigned slug already in driggsby.json proves the write
  // happened before any bytes moved, not merely before the deploy finished.
  const server = await startFakeDeployServer();
  try {
    const directory = await siteDirectory({
      "index.html": "<h1>hi</h1>",
      "driggsby.json": '{ "slug": "money-dash", "serve": "." }',
    });
    const collected = await collectDeployFiles(directory);
    server.injectResponse("POST", "/deploy/apps/money-dash/versions", 404, {
      error: "app_not_found",
      error_description: "missing",
    });
    server.injectResponse("PUT", "/deploy/blobs/", 422, {
      error: "content_mismatch",
      error_description: "The uploaded bytes don't match the expected hash.",
    });

    await assert.rejects(
      deployProjectFiles(
        { baseUrl: server.baseUrl, token: TOKEN },
        directory,
        "money-dash",
        collected,
        { live: true },
      ),
      (error: unknown) => {
        assert.ok(error instanceof DeployApiError);
        assert.equal(error.status, 422);
        return true;
      },
    );
    const config = await readProjectConfig(directory);
    assert.match(config.slug, /^money-dash-[a-z0-9]{6}$/);
  } finally {
    await server.close();
  }
});

test("deployProjectFiles propagates a second app_not_found instead of looping", async () => {
  const server = await startFakeDeployServer();
  try {
    const directory = await siteDirectory({
      "index.html": "<h1>hi</h1>",
      "driggsby.json": '{ "slug": "money-dash", "serve": "." }',
    });
    const collected = await collectDeployFiles(directory);
    server.injectResponse("POST", "/versions", 404, {
      error: "app_not_found",
      error_description: "missing",
    });
    server.injectResponse("POST", "/versions", 404, {
      error: "app_not_found",
      error_description: "missing",
    });

    await assert.rejects(
      deployProjectFiles(
        { baseUrl: server.baseUrl, token: TOKEN },
        directory,
        "money-dash",
        collected,
        { live: true },
      ),
      (error: unknown) => {
        assert.ok(error instanceof DeployApiError);
        assert.equal(error.code, "app_not_found");
        return true;
      },
    );
    // The one creation attempt happened; nothing looped.
    assert.equal(server.requests.filter((request) => request.path === "/deploy/apps").length, 1);
  } finally {
    await server.close();
  }
});

test("a malformed assigned slug from the server fails cleanly and never lands in driggsby.json", async () => {
  const server = await startFakeDeployServer();
  try {
    const directory = await siteDirectory({
      "index.html": "<h1>hi</h1>",
      "driggsby.json": '{ "slug": "money-dash", "serve": "." }',
    });
    const collected = await collectDeployFiles(directory);
    server.injectResponse("POST", "/deploy/apps/money-dash/versions", 404, {
      error: "app_not_found",
      error_description: "missing",
    });
    server.injectResponse("POST", "/deploy/apps", 201, {
      app_slug: "../../escape",
      url: "https://example.test",
    });

    await assert.rejects(
      deployProjectFiles(
        { baseUrl: server.baseUrl, token: TOKEN },
        directory,
        "money-dash",
        collected,
        { live: true },
      ),
      (error: unknown) => {
        assert.ok(error instanceof DeployError);
        assert.ok(!(error instanceof DeployApiError));
        assert.ok(!error.message.includes("escape"));
        return true;
      },
    );
    // The hostile value never reached disk.
    const config = await readProjectConfig(directory);
    assert.equal(config.slug, "money-dash");
  } finally {
    await server.close();
  }
});
