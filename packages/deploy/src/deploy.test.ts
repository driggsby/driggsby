import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { deployCollectedFiles, retryDelayMs, runWithConcurrencyLimit } from "./deploy.ts";
import { DeployApiError, DeployError } from "./errors.ts";
import { collectDeployFiles } from "./manifest.ts";
import { startFakeDeployServer } from "./test-support/fake-deploy-server.ts";

const TOKEN = "dgb_at_test_token_2222";

function sha256Hex(contents: string): string {
  return createHash("sha256").update(contents).digest("hex");
}

async function siteDirectory(files: Record<string, string>): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "driggsby-deploy-run-"));
  for (const [name, contents] of Object.entries(files)) {
    await writeFile(join(directory, name), contents);
  }
  return directory;
}

test("a first deploy uploads every blob and goes live", async () => {
  const server = await startFakeDeployServer();
  try {
    const directory = await siteDirectory({ "index.html": "<h1>hi</h1>", "app.js": "export {}" });
    const collected = await collectDeployFiles(directory);
    const outcome = await deployCollectedFiles(
      { baseUrl: server.baseUrl, token: TOKEN },
      "money-dash",
      collected,
      { live: true },
    );
    assert.equal(outcome.appSlug, "money-dash");
    assert.equal(outcome.versionNumber, 1);
    assert.equal(outcome.live, true);
    assert.equal(outcome.url, "https://money-dash.driggsby.dev");
    assert.equal(outcome.consoleUrl, "https://app.driggsby.test/dashboards/money-dash");
    assert.equal(outcome.fileCount, 2);
    assert.equal(outcome.uploadedBlobCount, 2);
    assert.equal(outcome.unchangedFileCount, 0);
    assert.equal(outcome.uploadedBytes, collected.totalBytes);

    const methods = server.requests.map((request) => `${request.method} ${request.path}`);
    assert.equal(methods.filter((entry) => entry.startsWith("PUT /deploy/blobs/")).length, 2);
    assert.ok(methods.at(-1)?.includes("/finalize"));
  } finally {
    await server.close();
  }
});

test("a redeploy uploads only blobs the server says are missing", async () => {
  const server = await startFakeDeployServer();
  try {
    server.seedBlob(Buffer.from("<h1>hi</h1>"));
    const directory = await siteDirectory({ "index.html": "<h1>hi</h1>", "app.js": "export {}" });
    const collected = await collectDeployFiles(directory);
    const outcome = await deployCollectedFiles(
      { baseUrl: server.baseUrl, token: TOKEN },
      "money-dash",
      collected,
      { live: true },
    );
    assert.equal(outcome.uploadedBlobCount, 1);
    assert.equal(outcome.unchangedFileCount, 1);
    assert.equal(outcome.uploadedBytes, Buffer.byteLength("export {}"));

    const puts = server.requests.filter((request) => request.method === "PUT");
    assert.equal(puts.length, 1);
    assert.ok(puts[0]?.path.includes(sha256Hex("export {}")));
  } finally {
    await server.close();
  }
});

test("a file that changed after hashing is refused, never uploaded under the old hash", async () => {
  const server = await startFakeDeployServer();
  try {
    const directory = await siteDirectory({ "index.html": "<h1>hi</h1>" });
    const collected = await collectDeployFiles(directory);
    // A build still writing into the serve folder between the hash walk and
    // the upload: the bytes on disk no longer match the offered manifest.
    await writeFile(join(directory, "index.html"), "<h1>changed</h1>");
    await assert.rejects(
      deployCollectedFiles({ baseUrl: server.baseUrl, token: TOKEN }, "money-dash", collected, {
        live: true,
      }),
      (error: unknown) => {
        assert.ok(error instanceof DeployError);
        assert.ok(error.message.includes("changed while this deploy was running"));
        return true;
      },
    );
    // The stale bytes never reached the wire.
    assert.equal(server.requests.filter((request) => request.method === "PUT").length, 0);
  } finally {
    await server.close();
  }
});

test("two files with identical content upload one blob", async () => {
  const server = await startFakeDeployServer();
  try {
    const directory = await siteDirectory({ "index.html": "same", "copy.html": "same" });
    const collected = await collectDeployFiles(directory);
    const outcome = await deployCollectedFiles(
      { baseUrl: server.baseUrl, token: TOKEN },
      "money-dash",
      collected,
      { live: true },
    );
    assert.equal(outcome.fileCount, 2);
    assert.equal(outcome.uploadedBlobCount, 1);
    assert.equal(server.requests.filter((request) => request.method === "PUT").length, 1);
  } finally {
    await server.close();
  }
});

test("a 503 on upload is retried exactly once and succeeds", async () => {
  const server = await startFakeDeployServer();
  try {
    // Retry-After: 0 keeps the retry pause out of the test's wall clock; the
    // pause length itself is covered by the retryDelayMs tests below.
    server.injectResponse(
      "PUT",
      "/deploy/blobs/",
      503,
      {
        error: "storage_unavailable",
        error_description: "Retry the same PUT in a few seconds.",
      },
      { "retry-after": "0" },
    );
    const directory = await siteDirectory({ "index.html": "<h1>hi</h1>" });
    const collected = await collectDeployFiles(directory);
    const outcome = await deployCollectedFiles(
      { baseUrl: server.baseUrl, token: TOKEN },
      "money-dash",
      collected,
      { live: true },
    );
    assert.equal(outcome.live, true);
    assert.equal(server.requests.filter((request) => request.method === "PUT").length, 2);
  } finally {
    await server.close();
  }
});

test("a second consecutive 503 on the same blob gives up with the server's message", async () => {
  const server = await startFakeDeployServer();
  try {
    const unavailable = {
      error: "storage_unavailable",
      error_description: "Uploads are briefly unavailable. Try again in a few minutes.",
    };
    server.injectResponse("PUT", "/deploy/blobs/", 503, unavailable, { "retry-after": "0" });
    server.injectResponse("PUT", "/deploy/blobs/", 503, unavailable, { "retry-after": "0" });
    const directory = await siteDirectory({ "index.html": "<h1>hi</h1>" });
    const collected = await collectDeployFiles(directory);
    await assert.rejects(
      deployCollectedFiles({ baseUrl: server.baseUrl, token: TOKEN }, "money-dash", collected, {
        live: true,
      }),
      (error: unknown) => {
        assert.ok(error instanceof DeployApiError);
        assert.equal(error.status, 503);
        assert.ok(error.message.includes("briefly unavailable"));
        return true;
      },
    );
    assert.equal(server.requests.filter((request) => request.method === "PUT").length, 2);
  } finally {
    await server.close();
  }
});

test("a hard failure cuts short a sibling's retry pause instead of waiting it out", async () => {
  const server = await startFakeDeployServer();
  try {
    // One blob draws a 503 with a long Retry-After while its sibling fails
    // hard. The retry pause must end at the abort — if it slept the full
    // three seconds, the process would sit silent long after the error
    // printed, which is the exact hang the abort path exists to prevent.
    server.injectResponse(
      "PUT",
      "/deploy/blobs/",
      503,
      { error: "storage_unavailable", error_description: "Retry the same PUT in a few seconds." },
      { "retry-after": "3" },
    );
    server.injectResponse("PUT", "/deploy/blobs/", 400, {
      error: "invalid_request",
      error_description: "That upload wasn't valid.",
    });
    const directory = await siteDirectory({
      "index.html": "<h1>hi</h1>",
      "app.css": "body { margin: 0 }",
    });
    const collected = await collectDeployFiles(directory);
    const startedAt = Date.now();
    await assert.rejects(
      deployCollectedFiles({ baseUrl: server.baseUrl, token: TOKEN }, "money-dash", collected, {
        live: true,
      }),
      (error: unknown) => {
        assert.ok(error instanceof DeployApiError);
        assert.equal(error.status, 400);
        return true;
      },
    );
    assert.ok(Date.now() - startedAt < 2_000, "the retry pause must end at the abort");
    // The aborted retry never reaches the wire: one PUT per blob, no third.
    assert.equal(server.requests.filter((request) => request.method === "PUT").length, 2);
  } finally {
    await server.close();
  }
});

test("retryDelayMs honors Retry-After when present and caps it, with a default otherwise", () => {
  const withHeader = (seconds: number | null) =>
    new DeployApiError(503, "storage_unavailable", "unavailable", seconds);
  assert.equal(retryDelayMs(withHeader(null)), 1_000);
  assert.equal(retryDelayMs(withHeader(0)), 0);
  assert.equal(retryDelayMs(withHeader(2)), 2_000);
  assert.equal(retryDelayMs(withHeader(3_600)), 5_000);
});

test("blobs_missing at finalize re-uploads the listed blobs and finalizes once more", async () => {
  const server = await startFakeDeployServer();
  try {
    // Both blobs are already on the server (a no-change redeploy), then the
    // server claims one went missing at finalize — the eviction case the
    // recovery round exists for.
    server.seedBlob(Buffer.from("<h1>hi</h1>"));
    server.seedBlob(Buffer.from("export {}"));
    const missingSha = sha256Hex("<h1>hi</h1>");
    server.injectResponse("POST", "/finalize", 409, {
      error: "blobs_missing",
      error_description: "1 file(s) haven't been uploaded yet.",
      missing_blob_sha256s: [missingSha],
    });
    const directory = await siteDirectory({ "index.html": "<h1>hi</h1>", "app.js": "export {}" });
    const collected = await collectDeployFiles(directory);
    const outcome = await deployCollectedFiles(
      { baseUrl: server.baseUrl, token: TOKEN },
      "money-dash",
      collected,
      { live: true },
    );
    assert.equal(outcome.live, true);
    const puts = server.requests.filter((request) => request.method === "PUT");
    // No initial uploads (both seeded) + 1 recovery re-upload.
    assert.equal(puts.length, 1);
    const finalizes = server.requests.filter((request) => request.path.includes("/finalize"));
    assert.equal(finalizes.length, 2);
    // The recovery re-upload counts as uploaded, not "already on Driggsby".
    assert.equal(outcome.uploadedBlobCount, 1);
    assert.equal(outcome.uploadedBytes, Buffer.byteLength("<h1>hi</h1>"));
    assert.equal(outcome.unchangedFileCount, 1);
  } finally {
    await server.close();
  }
});

test("a second blobs_missing gives up instead of looping", async () => {
  const server = await startFakeDeployServer();
  try {
    const missingSha = sha256Hex("<h1>hi</h1>");
    const missingBody = {
      error: "blobs_missing",
      error_description: "1 file(s) haven't been uploaded yet.",
      missing_blob_sha256s: [missingSha],
    };
    server.injectResponse("POST", "/finalize", 409, missingBody);
    server.injectResponse("POST", "/finalize", 409, missingBody);
    const directory = await siteDirectory({ "index.html": "<h1>hi</h1>" });
    const collected = await collectDeployFiles(directory);
    await assert.rejects(
      deployCollectedFiles({ baseUrl: server.baseUrl, token: TOKEN }, "money-dash", collected, {
        live: true,
      }),
      (error: unknown) => {
        assert.ok(error instanceof DeployError);
        return true;
      },
    );
    const finalizes = server.requests.filter((request) => request.path.includes("/finalize"));
    assert.equal(finalizes.length, 2);
  } finally {
    await server.close();
  }
});

test("a blobs_missing sha we never offered fails clearly instead of uploading nothing", async () => {
  const server = await startFakeDeployServer();
  try {
    server.injectResponse("POST", "/finalize", 409, {
      error: "blobs_missing",
      error_description: "1 file(s) haven't been uploaded yet.",
      missing_blob_sha256s: [sha256Hex("something else entirely")],
    });
    const directory = await siteDirectory({ "index.html": "<h1>hi</h1>" });
    const collected = await collectDeployFiles(directory);
    await assert.rejects(
      deployCollectedFiles({ baseUrl: server.baseUrl, token: TOKEN }, "money-dash", collected, {
        live: true,
      }),
      (error: unknown) => {
        assert.ok(error instanceof DeployError);
        return true;
      },
    );
  } finally {
    await server.close();
  }
});

test("a preview deploy finalizes with live false and reports no url", async () => {
  const server = await startFakeDeployServer();
  try {
    const directory = await siteDirectory({ "index.html": "<h1>hi</h1>" });
    const collected = await collectDeployFiles(directory);
    const outcome = await deployCollectedFiles(
      { baseUrl: server.baseUrl, token: TOKEN },
      "money-dash",
      collected,
      { live: false },
    );
    assert.equal(outcome.live, false);
    assert.equal(outcome.url, null);
    assert.equal(server.liveVersionNumber("money-dash"), null);
  } finally {
    await server.close();
  }
});

test("uploads never run more than the concurrency limit at once", async () => {
  let inFlight = 0;
  let peak = 0;
  const items = Array.from({ length: 20 }, (_, index) => index);
  const results = await runWithConcurrencyLimit(items, 4, async (item) => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 5));
    inFlight -= 1;
    return item * 2;
  });
  assert.equal(peak <= 4, true);
  assert.ok(peak >= 2, "the pool must actually run work concurrently");
  assert.deepEqual(results, items.map((item) => item * 2));
});

test("a failing upload stops the deploy with the first error", async () => {
  const items = [1, 2, 3];
  await assert.rejects(
    runWithConcurrencyLimit(items, 2, (item) => {
      if (item === 2) {
        return Promise.reject(new Error("boom"));
      }
      return Promise.resolve(item);
    }),
    /boom/,
  );
});

test("a failing upload aborts its in-flight siblings instead of letting them run on", async () => {
  // Without the abort, the failure's message would print while the
  // surviving uploads keep running for minutes — a "deploy failed" line
  // followed by a silent hang.
  const abortedItems: number[] = [];
  await assert.rejects(
    runWithConcurrencyLimit([1, 2, 3, 4], 4, (item, signal) => {
      if (item === 1) {
        return Promise.reject(new Error("boom"));
      }
      // Simulates an in-flight PUT: it settles only when the pool cancels it.
      return new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => {
          abortedItems.push(item);
          reject(new Error("aborted"));
        });
      });
    }),
    /boom/,
  );
  assert.deepEqual(abortedItems.sort(), [2, 3, 4]);
});
