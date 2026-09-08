import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import {
  createApp,
  createVersion,
  finalizeVersion,
  deleteApp,
  listVersions,
  setLiveVersion,
  uploadBlob,
} from "./client.ts";
import { DeployApiError, DeployError } from "./errors.ts";
import { startFakeDeployServer } from "./test-support/fake-deploy-server.ts";

const TOKEN = "dgb_at_test_token_1111";

function sha256Hex(contents: string): string {
  return createHash("sha256").update(contents).digest("hex");
}

function api(baseUrl: string): { baseUrl: string; token: string } {
  return { baseUrl, token: TOKEN };
}

test("createApp posts the base name and returns the server-assigned slug", async () => {
  const server = await startFakeDeployServer();
  try {
    const created = await createApp(api(server.baseUrl), "money-dash", "Money Dash");
    assert.match(created.appSlug, /^money-dash-[a-z0-9]{6}$/);
    assert.equal(created.url, `https://${created.appSlug}.driggsby.dev`);

    const request = server.requests[0];
    assert.ok(request !== undefined);
    assert.equal(request.method, "POST");
    assert.equal(request.path, "/deploy/apps");
    assert.equal(request.headers.authorization, `Bearer ${TOKEN}`);
    assert.deepEqual(JSON.parse(request.body.toString("utf8")), {
      base_name: "money-dash",
      app_name: "Money Dash",
    });
  } finally {
    await server.close();
  }
});

test("createVersion sends the exact manifest shape with bearer auth", async () => {
  const server = await startFakeDeployServer();
  try {
    const created = await createVersion(api(server.baseUrl), "money-dash", [
      { path: "index.html", sha256: sha256Hex("<h1>hi</h1>"), byteSize: 11 },
    ]);
    assert.equal(created.appSlug, "money-dash");
    assert.equal(created.versionNumber, 1);
    assert.deepEqual(created.missingBlobSha256s, [sha256Hex("<h1>hi</h1>")]);

    const request = server.requests[0];
    assert.ok(request !== undefined);
    assert.equal(request.method, "POST");
    assert.equal(request.path, "/deploy/apps/money-dash/versions");
    assert.equal(request.headers.authorization, `Bearer ${TOKEN}`);
    assert.equal(request.headers["content-type"], "application/json");
    // The CLI must never present itself as a browser request.
    assert.equal(request.headers.origin, undefined);
    assert.deepEqual(JSON.parse(request.body.toString("utf8")), {
      files: [{ path: "index.html", sha256: sha256Hex("<h1>hi</h1>"), byte_size: 11 }],
    });
  } finally {
    await server.close();
  }
});

test("createVersion includes the declared background when one is passed", async () => {
  const server = await startFakeDeployServer();
  try {
    await createVersion(
      api(server.baseUrl),
      "money-dash",
      [{ path: "index.html", sha256: sha256Hex("<h1>hi</h1>"), byteSize: 11 }],
      undefined,
      "#0b0c0f",
    );
    const request = server.requests[0];
    assert.ok(request !== undefined);
    assert.deepEqual(JSON.parse(request.body.toString("utf8")), {
      files: [{ path: "index.html", sha256: sha256Hex("<h1>hi</h1>"), byte_size: 11 }],
      background: "#0b0c0f",
    });
  } finally {
    await server.close();
  }
});

test("uploadBlob PUTs raw bytes as octet-stream", async () => {
  const server = await startFakeDeployServer();
  try {
    const bytes = Buffer.from("body { color: red }");
    await createVersion(api(server.baseUrl), "money-dash", [
      { path: "styles.css", sha256: sha256Hex(bytes.toString()), byteSize: bytes.byteLength },
    ]);
    await uploadBlob(api(server.baseUrl), sha256Hex(bytes.toString()), bytes);

    const request = server.requests[1];
    assert.ok(request !== undefined);
    assert.equal(request.method, "PUT");
    assert.equal(request.path, `/deploy/blobs/${sha256Hex(bytes.toString())}`);
    assert.equal(request.headers["content-type"], "application/octet-stream");
    assert.ok(request.body.equals(bytes));
  } finally {
    await server.close();
  }
});

test("finalizeVersion publishes live with an empty JSON object body", async () => {
  const server = await startFakeDeployServer();
  try {
    const bytes = Buffer.from("<h1>hi</h1>");
    server.seedBlob(bytes);
    const created = await createVersion(api(server.baseUrl), "money-dash", [
      { path: "index.html", sha256: sha256Hex(bytes.toString()), byteSize: bytes.byteLength },
    ]);
    const outcome = await finalizeVersion(api(server.baseUrl), created.versionId, true);
    assert.equal(outcome.kind, "finalized");
    assert.equal(outcome.live, true);
    assert.equal(outcome.url, "https://money-dash.driggsby.dev");
    assert.equal(outcome.consoleUrl, server.consoleUrlFor("money-dash"));

    const request = server.requests[1];
    assert.ok(request !== undefined);
    assert.equal(request.path, `/deploy/versions/${created.versionId}/finalize`);
    assert.equal(request.headers["content-type"], "application/json");
    assert.deepEqual(JSON.parse(request.body.toString("utf8")), {});
  } finally {
    await server.close();
  }
});

test("finalizeVersion sends live false for previews and reports no url", async () => {
  const server = await startFakeDeployServer();
  try {
    const bytes = Buffer.from("<h1>hi</h1>");
    server.seedBlob(bytes);
    const created = await createVersion(api(server.baseUrl), "money-dash", [
      { path: "index.html", sha256: sha256Hex(bytes.toString()), byteSize: bytes.byteLength },
    ]);
    const outcome = await finalizeVersion(api(server.baseUrl), created.versionId, false);
    assert.ok(outcome.kind === "finalized");
    assert.equal(outcome.live, false);
    assert.equal(outcome.url, null);

    const request = server.requests[1];
    assert.ok(request !== undefined);
    assert.deepEqual(JSON.parse(request.body.toString("utf8")), { live: false });
  } finally {
    await server.close();
  }
});

test("finalizeVersion surfaces blobs_missing as a typed outcome, not a throw", async () => {
  const server = await startFakeDeployServer();
  try {
    const sha = sha256Hex("never uploaded");
    const created = await createVersion(api(server.baseUrl), "money-dash", [
      { path: "index.html", sha256: sha, byteSize: 5 },
    ]);
    const outcome = await finalizeVersion(api(server.baseUrl), created.versionId, true);
    assert.ok(outcome.kind === "blobs-missing");
    assert.deepEqual(outcome.missingBlobSha256s, [sha]);
  } finally {
    await server.close();
  }
});

test("API refusals throw DeployApiError carrying the server's own description", async () => {
  const server = await startFakeDeployServer();
  try {
    server.injectResponse("POST", "/versions", 409, {
      error: "slug_taken",
      error_description: "That dashboard name is already in use. Pick another slug.",
    });
    await assert.rejects(
      createVersion(api(server.baseUrl), "money-dash", [
        { path: "index.html", sha256: sha256Hex("x"), byteSize: 1 },
      ]),
      (error: unknown) => {
        assert.ok(error instanceof DeployApiError);
        assert.equal(error.status, 409);
        assert.equal(error.code, "slug_taken");
        assert.equal(error.message, "That dashboard name is already in use. Pick another slug.");
        return true;
      },
    );
  } finally {
    await server.close();
  }
});

test("a non-JSON error response still fails with a presentable message", async () => {
  const server = await startFakeDeployServer();
  try {
    server.injectResponse("GET", "/versions", 500, "oops");
    await assert.rejects(listVersions(api(server.baseUrl), "money-dash"), (error: unknown) => {
      assert.ok(error instanceof DeployError);
      assert.ok(!error.message.includes("oops"));
      return true;
    });
  } finally {
    await server.close();
  }
});

test("listVersions returns the parsed list with live and status flags", async () => {
  const server = await startFakeDeployServer();
  try {
    const bytes = Buffer.from("<h1>hi</h1>");
    server.seedBlob(bytes);
    const files = [{ path: "index.html", sha256: sha256Hex(bytes.toString()), byteSize: bytes.byteLength }];
    const first = await createVersion(api(server.baseUrl), "money-dash", files);
    await finalizeVersion(api(server.baseUrl), first.versionId, true);
    const second = await createVersion(api(server.baseUrl), "money-dash", files);
    void second;

    const list = await listVersions(api(server.baseUrl), "money-dash");
    assert.equal(list.appSlug, "money-dash");
    assert.equal(list.liveVersionNumber, 1);
    assert.equal(list.versions.length, 2);
    const newest = list.versions[0];
    assert.ok(newest !== undefined);
    assert.equal(newest.number, 2);
    assert.equal(newest.status, "uploading");
    assert.equal(newest.live, false);
    const ready = list.versions[1];
    assert.ok(ready !== undefined);
    assert.equal(ready.status, "ready");
    assert.equal(ready.live, true);
    assert.equal(ready.createdAt, "2026-08-21T17:04:00.000Z");
  } finally {
    await server.close();
  }
});

test("setLiveVersion posts the version number and returns the live result", async () => {
  const server = await startFakeDeployServer();
  try {
    const bytes = Buffer.from("<h1>hi</h1>");
    server.seedBlob(bytes);
    const files = [{ path: "index.html", sha256: sha256Hex(bytes.toString()), byteSize: bytes.byteLength }];
    const first = await createVersion(api(server.baseUrl), "money-dash", files);
    await finalizeVersion(api(server.baseUrl), first.versionId, true);
    const second = await createVersion(api(server.baseUrl), "money-dash", files);
    await finalizeVersion(api(server.baseUrl), second.versionId, true);

    const result = await setLiveVersion(api(server.baseUrl), "money-dash", 1);
    assert.equal(result.versionNumber, 1);
    assert.equal(result.live, true);
    assert.equal(result.url, "https://money-dash.driggsby.dev");
    assert.equal(result.consoleUrl, server.consoleUrlFor("money-dash"));
    assert.equal(server.liveVersionNumber("money-dash"), 1);

    const request = server.requests.at(-1);
    assert.ok(request !== undefined);
    assert.equal(request.path, "/deploy/apps/money-dash/live-version");
    assert.deepEqual(JSON.parse(request.body.toString("utf8")), { version_number: 1 });
  } finally {
    await server.close();
  }
});

test("deleteApp sends the DELETE and parses the deleted names", async () => {
  const server = await startFakeDeployServer();
  try {
    const bytes = Buffer.from("<h1>hi</h1>");
    server.seedBlob(bytes);
    const files = [{ path: "index.html", sha256: sha256Hex(bytes.toString()), byteSize: bytes.byteLength }];
    const created = await createVersion(api(server.baseUrl), "money-dash", files);
    await finalizeVersion(api(server.baseUrl), created.versionId, true);

    const deleted = await deleteApp(api(server.baseUrl), "money-dash");
    assert.equal(deleted.appName, "The money-dash app");

    const request = server.requests.at(-1);
    assert.ok(request !== undefined);
    assert.equal(request.method, "DELETE");
    assert.equal(request.path, "/deploy/apps/money-dash");
    assert.equal(request.headers.authorization, `Bearer ${TOKEN}`);
  } finally {
    await server.close();
  }
});

test("deleteApp falls back to the requested slug when display fields are absent", async () => {
  const server = await startFakeDeployServer();
  try {
    // The delete already happened on the server; a sparse response must
    // not turn the completed operation into an error — nor may a bare
    // 204 with no body at all.
    server.injectResponse("DELETE", "/deploy/apps/money-dash", 200, {});
    const sparse = await deleteApp(api(server.baseUrl), "money-dash");
    assert.equal(sparse.appName, "money-dash");

    server.injectResponse("DELETE", "/deploy/apps/money-dash", 204, null);
    const bodyless = await deleteApp(api(server.baseUrl), "money-dash");
    assert.equal(bodyless.appName, "money-dash");
  } finally {
    await server.close();
  }
});

test("a non-integer numeric field is refused as an unrecognized response", async () => {
  const server = await startFakeDeployServer();
  try {
    // Every numeric field in the protocol is a count or version number; a
    // float or overflow value must fail closed, never reach a rendered
    // table as 1.79e+308.
    server.injectResponse("GET", "/versions", 200, {
      app_slug: "money-dash",
      url: "https://money-dash.driggsby.dev",
      live_version_number: null,
      versions: [
        {
          version_id: "v-1",
          number: 1,
          status: "ready",
          live: false,
          file_count: 1.79e308,
          total_bytes: 5,
          created_at: "2026-08-21T17:04:00.000Z",
        },
      ],
    });
    await assert.rejects(listVersions(api(server.baseUrl), "money-dash"), (error: unknown) => {
      assert.ok(error instanceof DeployError);
      assert.ok(error.message.includes("didn't recognize"));
      return true;
    });
  } finally {
    await server.close();
  }
});

test("a redirecting response is refused, never followed with the token", async () => {
  const server = await startFakeDeployServer();
  try {
    server.injectResponse("GET", "/versions", 307, {}, { location: "https://evil.example/steal" });
    await assert.rejects(listVersions(api(server.baseUrl), "money-dash"), (error: unknown) => {
      assert.ok(error instanceof Error);
      return true;
    });
    assert.equal(server.requests.length, 1);
  } finally {
    await server.close();
  }
});

test("a stalled connection fails as a TimeoutError instead of hanging", async () => {
  // A server that accepts the connection and never replies — the shape a
  // stalling egress proxy produces.
  const { createServer } = await import("node:http");
  const server = createServer(() => {
    // Deliberately never respond.
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address !== null && typeof address !== "string");
  try {
    await assert.rejects(
      listVersions(
        { baseUrl: `http://127.0.0.1:${address.port}`, token: TOKEN, requestTimeoutMs: 50 },
        "money-dash",
      ),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(error.name, "TimeoutError");
        return true;
      },
    );
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
  }
});

test("uploadBlob cancels its in-flight request when the caller's signal aborts", async () => {
  // The upload pool aborts surviving uploads after a sibling fails; the
  // caller's signal must reach the request itself so the PUT stops instead
  // of running to its own five-minute timeout.
  const { createServer } = await import("node:http");
  const server = createServer(() => {
    // Deliberately never respond, like a PUT mid-transfer.
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address !== null && typeof address !== "string");
  try {
    const controller = new AbortController();
    const pending = uploadBlob(
      { baseUrl: `http://127.0.0.1:${address.port}`, token: TOKEN },
      sha256Hex("x"),
      Buffer.from("x"),
      controller.signal,
    );
    controller.abort();
    await assert.rejects(pending, (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.name, "AbortError");
      return true;
    });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
  }
});

test("the timeout still fires when a caller signal is also attached", async () => {
  // The pool path: every real upload carries BOTH the shared pool signal
  // and the per-request timeout. A stall must still surface as the
  // TimeoutError the network guidance maps, not get lost in the combining.
  const { createServer } = await import("node:http");
  const server = createServer(() => {
    // Deliberately never respond.
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address !== null && typeof address !== "string");
  try {
    const controller = new AbortController();
    await assert.rejects(
      uploadBlob(
        { baseUrl: `http://127.0.0.1:${address.port}`, token: TOKEN, requestTimeoutMs: 50 },
        sha256Hex("y"),
        Buffer.from("y"),
        controller.signal,
      ),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(error.name, "TimeoutError");
        return true;
      },
    );
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
  }
});

test("a body that never finishes also fails as a TimeoutError", async () => {
  // Headers arrive, the body never completes — a half-dead proxy. The
  // timeout fires inside body parsing and must propagate as the stalled
  // connection it is, not read as an unrecognized response.
  const { createServer } = await import("node:http");
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.write('{"versions":');
    // Deliberately never end the body.
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address !== null && typeof address !== "string");
  try {
    await assert.rejects(
      listVersions(
        { baseUrl: `http://127.0.0.1:${address.port}`, token: TOKEN, requestTimeoutMs: 50 },
        "money-dash",
      ),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(error.name, "TimeoutError");
        return true;
      },
    );
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
  }
});
