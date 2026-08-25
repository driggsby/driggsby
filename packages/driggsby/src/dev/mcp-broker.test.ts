import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { test } from "node:test";

import { GENERIC_TOOL_TROUBLE } from "./dev-servers.ts";
import { MAX_ERROR_MESSAGE_CHARS, McpBroker, SIGN_IN_AGAIN_MESSAGE } from "./mcp-broker.ts";

// A synthetic token for the fake server; never a real credential.
const FAKE_TOKEN = "dgb_at_synthetic_test_token";

interface RecordedRequest {
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
}

interface FakeMcp {
  baseUrl: string;
  requests: RecordedRequest[];
  close: () => Promise<void>;
}

// A loopback fake of the Driggsby MCP endpoint. `respond` decides each
// answer from the parsed JSON-RPC body.
async function startFakeMcp(
  respond: (body: Record<string, unknown>) => { status: number; payload: unknown },
): Promise<FakeMcp> {
  const requests: RecordedRequest[] = [];
  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
      requests.push({ headers: { ...request.headers }, body });
      const answer = respond(body);
      response.writeHead(answer.status, { "Content-Type": "application/json" });
      response.end(JSON.stringify(answer.payload));
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("no port");
  }
  return {
    baseUrl: `http://127.0.0.1:${String(address.port)}`,
    requests,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
    },
  };
}

function successEnvelope(body: Record<string, unknown>, structuredContent: unknown) {
  return {
    status: 200,
    payload: {
      jsonrpc: "2.0",
      id: body.id,
      result: {
        structuredContent,
        isError: false,
        content: [{ type: "text", text: JSON.stringify(structuredContent) }],
      },
    },
  };
}

test("a tool call sends the exact JSON-RPC shape and returns structuredContent", async () => {
  const fake = await startFakeMcp((body) => successEnvelope(body, { net_worth: "synthetic" }));
  try {
    const broker = new McpBroker({ baseUrl: fake.baseUrl, token: FAKE_TOKEN });
    const result = await broker.runToolCall("get_overview", { reason: "App asked for it." });

    assert.deepEqual(result, { ok: true, result: { net_worth: "synthetic" } });
    assert.equal(fake.requests.length, 1);
    const request = fake.requests[0];
    assert.ok(request !== undefined);
    assert.deepEqual(request.body, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "get_overview", arguments: { reason: "App asked for it." } },
    });
    assert.equal(request.headers.authorization, `Bearer ${FAKE_TOKEN}`);
    assert.match(String(request.headers["content-type"]), /application\/json/);
    // The Driggsby endpoint refuses browser-looking requests; the broker
    // must never look like one.
    assert.equal(request.headers.origin, undefined);
    assert.equal(request.headers["sec-fetch-site"], undefined);
  } finally {
    await fake.close();
  }
});

test("a missing reason is filled in; an app-provided reason is kept", async () => {
  const fake = await startFakeMcp((body) => successEnvelope(body, {}));
  try {
    const broker = new McpBroker({ baseUrl: fake.baseUrl, token: FAKE_TOKEN });
    await broker.runToolCall("get_history", {});
    await broker.runToolCall("get_history", { reason: "  " });
    await broker.runToolCall("get_history", { reason: "Charting spend." });

    const reasons = fake.requests.map((request) => {
      const params = (request.body as Record<string, unknown>).params as Record<string, unknown>;
      return (params.arguments as Record<string, unknown>).reason;
    });
    assert.equal(typeof reasons[0], "string");
    assert.notEqual(reasons[0], "");
    assert.equal(reasons[1], reasons[0], "a blank reason gets the same default");
    assert.equal(reasons[2], "Charting spend.");
  } finally {
    await fake.close();
  }
});

test("request ids increase across calls", async () => {
  const fake = await startFakeMcp((body) => successEnvelope(body, {}));
  try {
    const broker = new McpBroker({ baseUrl: fake.baseUrl, token: FAKE_TOKEN });
    await broker.runToolCall("get_overview", {});
    await broker.runToolCall("list_accounts", {});
    const ids = fake.requests.map((request) => (request.body as Record<string, unknown>).id);
    assert.deepEqual(ids, [1, 2]);
  } finally {
    await fake.close();
  }
});

test("an HTTP 401 becomes the sign-in-again message", async () => {
  const fake = await startFakeMcp(() => ({
    status: 401,
    payload: {
      jsonrpc: "2.0",
      id: 1,
      result: {
        isError: true,
        content: [{ type: "text", text: "Reconnect Driggsby to use this tool." }],
      },
    },
  }));
  try {
    const broker = new McpBroker({ baseUrl: fake.baseUrl, token: FAKE_TOKEN });
    const result = await broker.runToolCall("get_overview", {});
    assert.deepEqual(result, { ok: false, error: { message: SIGN_IN_AGAIN_MESSAGE } });
  } finally {
    await fake.close();
  }
});

test("a JSON-RPC error surfaces its message to the app", async () => {
  const fake = await startFakeMcp((body) => ({
    status: 200,
    payload: {
      jsonrpc: "2.0",
      id: body.id,
      error: { code: -32602, message: "reason is required. Provide one short sentence." },
    },
  }));
  try {
    const broker = new McpBroker({ baseUrl: fake.baseUrl, token: FAKE_TOKEN });
    const result = await broker.runToolCall("get_overview", {});
    assert.deepEqual(result, {
      ok: false,
      error: { message: "reason is required. Provide one short sentence." },
    });
  } finally {
    await fake.close();
  }
});

test("a tool-level refusal (isError) surfaces content text as the message", async () => {
  const fake = await startFakeMcp((body) => ({
    status: 200,
    payload: {
      jsonrpc: "2.0",
      id: body.id,
      result: {
        structuredContent: { refused: true },
        isError: true,
        content: [{ type: "text", text: "That data isn't available right now." }],
      },
    },
  }));
  try {
    const broker = new McpBroker({ baseUrl: fake.baseUrl, token: FAKE_TOKEN });
    const result = await broker.runToolCall("get_overview", {});
    assert.deepEqual(result, {
      ok: false,
      error: { message: "That data isn't available right now." },
    });
  } finally {
    await fake.close();
  }
});

test("an oversized server error message is capped before reaching the app", async () => {
  const fake = await startFakeMcp((body) => ({
    status: 200,
    payload: {
      jsonrpc: "2.0",
      id: body.id,
      error: { code: -32000, message: "x".repeat(10_000) },
    },
  }));
  try {
    const broker = new McpBroker({ baseUrl: fake.baseUrl, token: FAKE_TOKEN });
    const result = await broker.runToolCall("get_overview", {});
    assert.equal(result.ok, false);
    assert.ok(!result.ok);
    assert.equal(result.error.message.length, MAX_ERROR_MESSAGE_CHARS + 1);
    assert.ok(result.error.message.endsWith("…"));
  } finally {
    await fake.close();
  }
});

test("a redirecting /mcp response is refused; the token never follows the redirect", async () => {
  // The redirect target: a server that would answer success — it must never
  // be contacted at all.
  let targetHits = 0;
  const target = createServer((request, response) => {
    targetHits += 1;
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(
      JSON.stringify({ jsonrpc: "2.0", id: 1, result: { structuredContent: {}, isError: false } }),
    );
  });
  await new Promise<void>((resolve) => {
    target.listen(0, "127.0.0.1", resolve);
  });
  const targetAddress = target.address();
  assert.ok(targetAddress !== null && typeof targetAddress !== "string");

  const redirecting = createServer((request, response) => {
    response.writeHead(307, {
      Location: `http://127.0.0.1:${String(targetAddress.port)}/mcp`,
    });
    response.end();
  });
  await new Promise<void>((resolve) => {
    redirecting.listen(0, "127.0.0.1", resolve);
  });
  const redirectingAddress = redirecting.address();
  assert.ok(redirectingAddress !== null && typeof redirectingAddress !== "string");

  const closeOf = (server: Server) =>
    new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => {
        resolve();
      });
    });
  try {
    const broker = new McpBroker({
      baseUrl: `http://127.0.0.1:${String(redirectingAddress.port)}`,
      token: FAKE_TOKEN,
    });
    const result = await broker.runToolCall("get_overview", {});
    assert.deepEqual(result, { ok: false, error: { message: GENERIC_TOOL_TROUBLE } });
    assert.equal(targetHits, 0, "the redirect target must never be contacted");
  } finally {
    await closeOf(redirecting);
    await closeOf(target);
  }
});

test("an unreachable server becomes the generic trouble message, never a rejection", async () => {
  const broker = new McpBroker({
    baseUrl: "http://127.0.0.1:1",
    token: FAKE_TOKEN,
    timeoutMs: 2_000,
  });
  const result = await broker.runToolCall("get_overview", {});
  assert.deepEqual(result, { ok: false, error: { message: GENERIC_TOOL_TROUBLE } });
});

test("the queue cap refuses overflow instead of piling up calls", async () => {
  // A server that never answers until released, so calls stack up.
  let releaseAll: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    releaseAll = resolve;
  });
  const server = createServer((request, response) => {
    void gate.then(() => {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(
        JSON.stringify({ jsonrpc: "2.0", id: 1, result: { structuredContent: {}, isError: false } }),
      );
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address !== null && typeof address !== "string");

  try {
    const broker = new McpBroker({
      baseUrl: `http://127.0.0.1:${String(address.port)}`,
      token: FAKE_TOKEN,
    });
    // Fill the in-flight slots plus the whole queue, then one more.
    const pending = Array.from({ length: 4 + 64 }, () => broker.runToolCall("get_overview", {}));
    const overflow = await broker.runToolCall("list_accounts", {});
    assert.deepEqual(overflow, { ok: false, error: { message: GENERIC_TOOL_TROUBLE } });

    releaseAll();
    const settled = await Promise.all(pending);
    assert.ok(settled.every((result) => result.ok));
  } finally {
    releaseAll();
    server.closeAllConnections();
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
  }
});
