import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { test } from "node:test";

import { ChannelRpc, MAX_LINE_BYTES } from "./rpc.ts";

interface Harness {
  input: PassThrough;
  sent: () => Record<string, unknown>[];
  rpc: ChannelRpc;
  initialized: () => number;
}

function harness(): Harness {
  const input = new PassThrough();
  const lines: string[] = [];
  let initialized = 0;
  const rpc = new ChannelRpc({
    input,
    write: (line) => lines.push(line),
    version: "9.9.9",
    initializeResult: () => ({ capabilities: { experimental: { "claude/channel": {} } }, instructions: "hello" }),
    onInitialized: () => {
      initialized += 1;
    },
  });
  return {
    input,
    rpc,
    initialized: () => initialized,
    sent: () =>
      lines.map((line) => {
        assert.ok(line.endsWith("\n") && !line.slice(0, -1).includes("\n"), "one message per line");
        return JSON.parse(line) as Record<string, unknown>;
      }),
  };
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

const send = (h: Harness, message: unknown): void => {
  h.input.write(`${JSON.stringify(message)}\n`);
};

test("initialize answers on the revision Claude Code asks for, with the server's capabilities", async () => {
  const h = harness();
  send(h, { jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {} } });
  await settle();

  assert.deepEqual(h.sent(), [
    {
      jsonrpc: "2.0",
      id: 0,
      result: {
        protocolVersion: "2025-11-25",
        capabilities: { experimental: { "claude/channel": {} } },
        serverInfo: { name: "driggsby", version: "9.9.9" },
        instructions: "hello",
      },
    },
  ]);
});

test("a revision it doesn't know gets the newest one it supports, never 2026-07-28", async () => {
  const h = harness();
  send(h, { jsonrpc: "2.0", id: "a", method: "initialize", params: { protocolVersion: "2026-07-28" } });
  send(h, { jsonrpc: "2.0", id: "b", method: "initialize", params: { protocolVersion: "2024-11-05" } });
  await settle();

  const versions = h.sent().map((message) => (message.result as Record<string, unknown>).protocolVersion);
  assert.deepEqual(versions, ["2025-11-25", "2024-11-05"]);
});

test("server/discover is refused, so Claude Code falls back to the handshake that carries channel events", async () => {
  const h = harness();
  send(h, { jsonrpc: "2.0", id: "server-discover-1", method: "server/discover", params: {} });
  send(h, { jsonrpc: "2.0", id: 7, method: "tools/list" });
  await settle();

  assert.deepEqual(h.sent(), [
    { jsonrpc: "2.0", id: "server-discover-1", error: { code: -32601, message: "Method not found" } },
    { jsonrpc: "2.0", id: 7, error: { code: -32601, message: "Method not found" } },
  ]);
});

test("ping answers, initialized fires once, and other notifications and replies are ignored", async () => {
  const h = harness();
  send(h, { jsonrpc: "2.0", id: 3, method: "ping" });
  send(h, { jsonrpc: "2.0", method: "notifications/initialized" });
  send(h, { jsonrpc: "2.0", method: "notifications/initialized" });
  send(h, { jsonrpc: "2.0", method: "notifications/cancelled", params: {} });
  send(h, { jsonrpc: "2.0", id: 9, result: {} });
  await settle();

  assert.deepEqual(h.sent(), [{ jsonrpc: "2.0", id: 3, result: {} }]);
  assert.equal(h.initialized(), 1);
});

test("garbage, odd ids and an oversized line are dropped, and the next message still works", async () => {
  const h = harness();
  h.input.write("not json\n");
  h.input.write("[1,2]\n");
  send(h, { jsonrpc: "2.0", id: { nested: true }, method: "ping" });
  send(h, { jsonrpc: "1.0", id: 1, method: "ping" });
  h.input.write("x".repeat(MAX_LINE_BYTES + 10));
  h.input.write(`${"y".repeat(50)}\n`);
  send(h, { jsonrpc: "2.0", id: 4, method: "ping" });
  await settle();

  assert.deepEqual(h.sent(), [{ jsonrpc: "2.0", id: 4, result: {} }]);
});

test("a message split across chunks, and one ended by CRLF, both parse", async () => {
  const h = harness();
  const text = JSON.stringify({ jsonrpc: "2.0", id: 5, method: "ping" });
  h.input.write(text.slice(0, 10));
  h.input.write(`${text.slice(10)}\r\n`);
  await settle();

  assert.deepEqual(h.sent(), [{ jsonrpc: "2.0", id: 5, result: {} }]);
});

test("notify writes one notification line, and closed resolves when Claude Code closes stdin", async () => {
  const h = harness();
  h.rpc.notify("notifications/claude/channel", { content: "a\nb", meta: { count: "2" } });
  h.input.end();
  await h.rpc.closed;

  assert.deepEqual(h.sent(), [{ jsonrpc: "2.0", method: "notifications/claude/channel", params: { content: "a\nb", meta: { count: "2" } } }]);
});
