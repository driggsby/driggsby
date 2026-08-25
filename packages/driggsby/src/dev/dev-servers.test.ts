import assert from "node:assert/strict";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { startDevServers, type BrokerResult, TOOL_NOT_ALLOWED_MESSAGE } from "./dev-servers.ts";
import { serveStaticFile } from "./static-files.ts";

async function makeServeDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "driggsby-dev-"));
  await writeFile(join(directory, "index.html"), "<h1>the app</h1>");
  await writeFile(join(directory, "app.js"), "console.log(1);");
  await writeFile(join(directory, "driggsby.json"), '{"slug":"money-dash"}');
  await writeFile(join(directory, ".env"), "SECRET=nope");
  await mkdir(join(directory, "nested"));
  await writeFile(join(directory, "nested", "driggsby.json"), '{"ordinary":"file"}');
  await mkdir(join(directory, "node_modules", "left-pad"), { recursive: true });
  await writeFile(join(directory, "node_modules", "left-pad", "index.js"), "module.exports = 1;");
  return directory;
}

interface RecordedCall {
  tool: string;
  argumentsObject: Record<string, unknown>;
}

async function startServers(overrides: {
  runToolCall?: (tool: string, argumentsObject: Record<string, unknown>) => Promise<BrokerResult>;
  serveDirectory?: string;
}) {
  const serveDirectory = overrides.serveDirectory ?? (await makeServeDirectory());
  const calls: RecordedCall[] = [];
  const servers = await startDevServers({
    slug: "money-dash",
    serveDirectory,
    sdkBundle: "// the sdk bundle\n",
    runToolCall:
      overrides.runToolCall ??
      ((tool, argumentsObject) => {
        calls.push({ tool, argumentsObject });
        return Promise.resolve({ ok: true, result: { fake: true } });
      }),
    hostPort: 0,
    appPort: 0,
  });
  return { servers, calls, serveDirectory };
}

test("the app origin serves the app's files and the SDK, never excluded files", async () => {
  const { servers } = await startServers({});
  try {
    const index = await fetch(`${servers.appOrigin}/`);
    assert.equal(index.status, 200);
    assert.match(index.headers.get("content-type") ?? "", /text\/html/);
    assert.equal(await index.text(), "<h1>the app</h1>");
    // Only the real host page may frame the app; content types are final.
    assert.equal(
      index.headers.get("content-security-policy"),
      `frame-ancestors ${servers.hostOrigin};`,
    );
    assert.equal(index.headers.get("x-content-type-options"), "nosniff");

    const sdk = await fetch(`${servers.appOrigin}/-/driggsby-sdk.js`);
    assert.equal(sdk.status, 200);
    assert.equal(await sdk.text(), "// the sdk bundle\n");

    // What a deploy would never publish, dev never serves — in any casing,
    // so a case-insensitive filesystem (macOS, Windows) can't route an
    // uppercase spelling around the exclusion to the real file.
    const excluded = [
      "/driggsby.json",
      "/DRIGGSBY.JSON",
      "/.env",
      "/../outside",
      "/%2e%2e/outside",
      "/NODE_MODULES/left-pad/index.js",
      "/node_modules/left-pad/index.js",
    ];
    for (const path of excluded) {
      const response = await fetch(`${servers.appOrigin}${path}`);
      assert.equal(response.status, 404, path);
    }
    // A nested driggsby.json is an ordinary file, exactly like the deploy walk.
    const nested = await fetch(`${servers.appOrigin}/nested/driggsby.json`);
    assert.equal(nested.status, 200);
  } finally {
    await servers.close();
  }
});

test("a symlink inside the serve folder is never served", async () => {
  const serveDirectory = await makeServeDirectory();
  const outside = await mkdtemp(join(tmpdir(), "driggsby-outside-"));
  await writeFile(join(outside, "secret.txt"), "outside the project");
  try {
    await symlink(join(outside, "secret.txt"), join(serveDirectory, "link.txt"));
  } catch {
    // Windows without symlink rights: nothing to test here.
    return;
  }
  const { servers } = await startServers({ serveDirectory });
  try {
    const response = await fetch(`${servers.appOrigin}/link.txt`);
    assert.equal(response.status, 404);
  } finally {
    await servers.close();
  }
});

test("the host origin serves the page, embedding the app origin", async () => {
  const { servers } = await startServers({});
  try {
    const page = await fetch(`${servers.hostOrigin}/`);
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.ok(html.includes(`src="${servers.appOrigin}/"`), "the iframe must point at the app origin");
    assert.ok(html.includes("money-dash"));
    assert.ok(!html.includes("dgb_at_"), "no token material in page HTML");
    assert.ok((page.headers.get("content-security-policy") ?? "").includes("script-src 'self'"));

    const script = await fetch(`${servers.hostOrigin}/host.js`);
    assert.equal(script.status, 200);
    assert.ok((await script.text()).includes("driggsby-sdk/1"));
  } finally {
    await servers.close();
  }
});

test("tool calls pass allowlisted tools to the broker and return its result", async () => {
  const { servers, calls } = await startServers({});
  try {
    const response = await fetch(`${servers.hostOrigin}/tool-calls`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tool: "get_overview", arguments: { period: "month" } }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, result: { fake: true } });
    assert.deepEqual(calls, [{ tool: "get_overview", argumentsObject: { period: "month" } }]);
  } finally {
    await servers.close();
  }
});

test("a tool outside the allowlist is refused without reaching the broker", async () => {
  const { servers, calls } = await startServers({});
  try {
    for (const tool of ["email_me", "save_automation", "delete_automation", "unknown_tool"]) {
      const response = await fetch(`${servers.hostOrigin}/tool-calls`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tool, arguments: {} }),
      });
      assert.equal(response.status, 200);
      const payload = (await response.json()) as { ok: boolean; error?: { message: string } };
      assert.equal(payload.ok, false, tool);
      assert.equal(payload.error?.message, TOOL_NOT_ALLOWED_MESSAGE, tool);
    }
    assert.equal(calls.length, 0);
  } finally {
    await servers.close();
  }
});

test("a cross-site tool call is refused by the Origin guard", async () => {
  const { servers, calls } = await startServers({});
  try {
    const crossSite = await fetch(`${servers.hostOrigin}/tool-calls`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "https://evil.example" },
      body: JSON.stringify({ tool: "get_overview", arguments: {} }),
    });
    assert.equal(crossSite.status, 403);

    // The page's own same-origin fetch (browser sends no Origin, or the
    // host origin itself) still works.
    const sameOrigin = await fetch(`${servers.hostOrigin}/tool-calls`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: servers.hostOrigin },
      body: JSON.stringify({ tool: "get_overview", arguments: {} }),
    });
    assert.equal(sameOrigin.status, 200);
    assert.equal(calls.length, 1);
  } finally {
    await servers.close();
  }
});

test("a request with a foreign Host header is refused (DNS rebinding guard)", async () => {
  // fetch strips a caller-set Host (a forbidden header), so this speaks raw
  // HTTP — exactly what a rebinding attacker's browser would send: a
  // connection to the loopback port carrying a foreign Host.
  const { servers } = await startServers({});
  try {
    const status = await new Promise<number>((resolve, reject) => {
      const request = httpRequest(
        {
          host: "127.0.0.1",
          port: servers.hostPort,
          method: "POST",
          path: "/tool-calls",
          headers: { "Content-Type": "application/json", Host: "evil.example" },
        },
        (response) => {
          response.resume();
          resolve(response.statusCode ?? 0);
        },
      );
      request.on("error", reject);
      request.end(JSON.stringify({ tool: "get_overview", arguments: {} }));
    });
    assert.equal(status, 403);
  } finally {
    await servers.close();
  }
});

test("an app-origin request with a foreign Host header is refused (DNS rebinding guard)", async () => {
  const { servers } = await startServers({});
  try {
    const status = await new Promise<number>((resolve, reject) => {
      const request = httpRequest(
        {
          host: "127.0.0.1",
          port: servers.appPort,
          method: "GET",
          path: "/",
          headers: { Host: "evil.example" },
        },
        (response) => {
          response.resume();
          resolve(response.statusCode ?? 0);
        },
      );
      request.on("error", reject);
      request.end();
    });
    assert.equal(status, 403);
  } finally {
    await servers.close();
  }
});

test("a tool call without a JSON content type is refused without reaching the broker", async () => {
  // A cross-site "simple" POST (text/plain or form-encoded) carries no
  // preflight; requiring JSON means any caller that could reach the broker
  // either is the host page or already passed a preflight this server never
  // grants.
  const { servers, calls } = await startServers({});
  try {
    for (const contentType of ["text/plain", "application/x-www-form-urlencoded", ""]) {
      const response = await fetch(`${servers.hostOrigin}/tool-calls`, {
        method: "POST",
        headers: contentType === "" ? {} : { "Content-Type": contentType },
        body: JSON.stringify({ tool: "get_overview", arguments: {} }),
      });
      assert.equal(response.status, 415, contentType);
    }
    assert.equal(calls.length, 0);
  } finally {
    await servers.close();
  }
});

test("malformed tool-call bodies are refused without reaching the broker", async () => {
  const { servers, calls } = await startServers({});
  try {
    for (const body of ["not json", "[]", JSON.stringify({ tool: "" }), JSON.stringify({})]) {
      const response = await fetch(`${servers.hostOrigin}/tool-calls`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      });
      assert.equal(response.status, 400, body);
    }
    assert.equal(calls.length, 0);
  } finally {
    await servers.close();
  }
});

test("notifyChange reaches a connected events stream", async () => {
  const { servers } = await startServers({});
  try {
    const response = await fetch(`${servers.hostOrigin}/events`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/);
    assert.ok(response.body !== null);
    const reader = response.body.getReader();

    // The stream greets on connect; then a change event must arrive.
    const decoder = new TextDecoder();
    let received = "";
    const firstChunk: { done: boolean; value?: Uint8Array } = await reader.read();
    received += decoder.decode(firstChunk.value);
    servers.notifyChange();
    while (!received.includes("event: change")) {
      const chunk: { done: boolean; value?: Uint8Array } = await reader.read();
      if (chunk.done) {
        break;
      }
      received += decoder.decode(chunk.value);
    }
    assert.ok(received.includes("event: change"));
    await reader.cancel();
  } finally {
    await servers.close();
  }
});

test("static path safety refuses traversal, dotfiles, and absolute paths directly", async () => {
  const serveDirectory = await makeServeDirectory();
  for (const path of [
    "/..%2f..%2fetc%2fpasswd",
    "/%00",
    "/.git/config",
    "/nested/../../outside",
    "/C:/Windows/win.ini",
  ]) {
    assert.equal(await serveStaticFile(serveDirectory, path), null, path);
  }
  const ok = await serveStaticFile(serveDirectory, "/app.js");
  assert.ok(ok !== null);
  assert.match(ok.contentType, /javascript/);
});

test("a failed host bind closes the already-bound app server instead of squatting its port", async () => {
  const { createServer } = await import("node:http");
  const listenOn = (server: ReturnType<typeof createServer>, port: number) =>
    new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, "127.0.0.1", () => {
        server.removeListener("error", reject);
        resolve();
      });
    });
  const closeOf = (server: ReturnType<typeof createServer>) =>
    new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
  const portOf = (server: ReturnType<typeof createServer>): number => {
    const address = server.address();
    assert.ok(address !== null && typeof address === "object");
    return address.port;
  };

  // Occupy the host port; find a free app port and release it for the run.
  const squatter = createServer();
  await listenOn(squatter, 0);
  const takenHostPort = portOf(squatter);
  const probe = createServer();
  await listenOn(probe, 0);
  const freeAppPort = portOf(probe);
  await closeOf(probe);

  const serveDirectory = await makeServeDirectory();
  try {
    await assert.rejects(
      startDevServers({
        slug: "money-dash",
        serveDirectory,
        sdkBundle: "// the sdk bundle\n",
        runToolCall: () => Promise.resolve({ ok: true, result: null }),
        hostPort: takenHostPort,
        appPort: freeAppPort,
      }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal((error as NodeJS.ErrnoException).code, "EADDRINUSE");
        return true;
      },
    );
    // The app server released its port: binding it again succeeds.
    const rebind = createServer();
    await listenOn(rebind, freeAppPort);
    await closeOf(rebind);
  } finally {
    await closeOf(squatter);
  }
});
