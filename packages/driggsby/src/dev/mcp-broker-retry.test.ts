import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";

import { startFakeMcp, successEnvelope } from "../test-support/fake-mcp.ts";
import { GENERIC_TOOL_TROUBLE } from "./dev-servers.ts";
import { MAX_IN_FLIGHT_CALLS, McpBroker } from "./mcp-broker.ts";

// The preview's retries (retry-policy.ts), which mirror the production
// dashboard host's: by kind of failure, after the server's hint, giving up
// the call's slot while it waits.

// A synthetic token for the fake server; never a real credential.
const FAKE_TOKEN = "dgb_at_synthetic_test_token";

// A retryable refusal, shaped like the Driggsby endpoint's: isError, the
// plain message in content, and the kind and retry hint beside it.
function refusalEnvelope(
  body: Record<string, unknown>,
  kind: string,
  options: { retryable?: boolean; retryAfterMs?: number } = {},
): { status: number; payload: unknown } {
  const message = `Synthetic ${kind} refusal. Try again in a moment.`;
  return {
    status: 200,
    payload: {
      jsonrpc: "2.0",
      id: body.id,
      result: {
        isError: true,
        content: [{ type: "text", text: message }],
        structuredContent: {
          error: message,
          kind,
          retryable: options.retryable ?? true,
          ...(options.retryAfterMs === undefined ? {} : { retry_after_ms: options.retryAfterMs }),
        },
      },
    },
  };
}

// A broker that retries, with its waits recorded instead of slept.
function retryingBroker(baseUrl: string, waits: number[]): McpBroker {
  return new McpBroker({
    baseUrl,
    token: FAKE_TOKEN,
    retries: true,
    random: () => 0,
    wait: async (milliseconds) => {
      waits.push(milliseconds);
      await Promise.resolve();
    },
  });
}

test("with retries on, a busy refusal is retried after the server's hint, then succeeds", async () => {
  let answered = 0;
  const fake = await startFakeMcp((body) => {
    answered += 1;
    return answered <= 2 ? refusalEnvelope(body, "busy", { retryAfterMs: 1_500 }) : successEnvelope(body, { fine: true });
  });
  try {
    const waits: number[] = [];
    const result = await retryingBroker(fake.baseUrl, waits).runToolCall("get_history", {});

    assert.deepEqual(result, { ok: true, result: { fine: true } });
    assert.equal(fake.requests.length, 3);
    assert.deepEqual(waits, [1_500, 1_500]);
  } finally {
    await fake.close();
  }
});

test("retries stop at each kind's limit, and the last refusal keeps its kind for the app", async () => {
  const cases: [string, number][] = [
    ["busy", 4],
    ["unavailable", 4],
    ["rate_limited", 4],
    ["timeout", 2],
  ];
  for (const [kind, expectedRequests] of cases) {
    const fake = await startFakeMcp((body) => refusalEnvelope(body, kind));
    try {
      const result = await retryingBroker(fake.baseUrl, []).runToolCall("get_history", {});

      assert.deepEqual(
        result,
        { ok: false, error: { message: `Synthetic ${kind} refusal. Try again in a moment.`, kind } },
        kind,
      );
      assert.equal(fake.requests.length, expectedRequests, kind);
    } finally {
      await fake.close();
    }
  }
});

test("a refusal that isn't retryable, a wrong input, or an unknown kind is never retried", async () => {
  const notRetryable = await startFakeMcp((body) => refusalEnvelope(body, "rate_limited", { retryable: false }));
  try {
    const result = await retryingBroker(notRetryable.baseUrl, []).runToolCall("get_history", {});

    assert.ok(!result.ok);
    assert.equal(result.error.kind, "rate_limited", "a known kind still reaches the app");
    assert.equal(notRetryable.requests.length, 1);
  } finally {
    await notRetryable.close();
  }

  const answers = [
    (body: Record<string, unknown>) => refusalEnvelope(body, "melted"),
    (body: Record<string, unknown>) => ({
      status: 200,
      payload: { jsonrpc: "2.0", id: body.id, error: { code: -32602, message: "limit must be at least 1." } },
    }),
  ];
  for (const answer of answers) {
    const fake = await startFakeMcp(answer);
    try {
      const result = await retryingBroker(fake.baseUrl, []).runToolCall("get_history", {});

      assert.ok(!result.ok);
      assert.equal(result.error.kind, undefined, "no kind reaches the app");
      assert.equal(fake.requests.length, 1);
    } finally {
      await fake.close();
    }
  }
});

test("a server error is retried as a failed request; a client error is not", async () => {
  for (const [status, expectedRequests] of [
    [503, 4],
    [404, 1],
  ] as const) {
    const fake = await startFakeMcp(() => ({ status, payload: { error: "synthetic" } }));
    try {
      const result = await retryingBroker(fake.baseUrl, []).runToolCall("get_history", {});

      assert.deepEqual(result, { ok: false, error: { message: GENERIC_TOOL_TROUBLE } });
      assert.equal(fake.requests.length, expectedRequests, String(status));
    } finally {
      await fake.close();
    }
  }
});

test("without retries (a one-off command), a busy refusal answers at once, still naming its kind", async () => {
  const fake = await startFakeMcp((body) => refusalEnvelope(body, "busy"));
  try {
    const broker = new McpBroker({ baseUrl: fake.baseUrl, token: FAKE_TOKEN });
    const result = await broker.runToolCall("get_history", {});

    assert.deepEqual(result, { ok: false, error: { message: "Synthetic busy refusal. Try again in a moment.", kind: "busy" } });
    assert.equal(fake.requests.length, 1);
  } finally {
    await fake.close();
  }
});

test("a call waiting to retry gives up its slot to the next call in line", async () => {
  // get_history is refused busy once. list_accounts answers only once
  // every slot holds one at the same time, so if the waiting call kept its
  // slot, they could never all be in flight and the test would time out.
  let historyCalls = 0;
  let waiting: (() => void)[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
      const name = (body.params as Record<string, unknown>).name;
      const answer = (payload: { status: number; payload: unknown }): void => {
        response.writeHead(payload.status, { "Content-Type": "application/json" });
        response.end(JSON.stringify(payload.payload));
      };
      if (name === "get_history") {
        historyCalls += 1;
        answer(historyCalls === 1 ? refusalEnvelope(body, "busy") : successEnvelope(body, { tool: name }));
        return;
      }
      waiting.push(() => {
        answer(successEnvelope(body, { tool: name }));
      });
      if (waiting.length === MAX_IN_FLIGHT_CALLS) {
        const release = waiting;
        waiting = [];
        release.forEach((respond) => {
          respond();
        });
      }
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address !== null && typeof address !== "string");
  let releaseWait: () => void = () => undefined;
  const waitGate = new Promise<void>((resolve) => {
    releaseWait = resolve;
  });
  try {
    const broker = new McpBroker({
      baseUrl: `http://127.0.0.1:${String(address.port)}`,
      token: FAKE_TOKEN,
      retries: true,
      wait: async () => {
        await waitGate;
      },
    });
    const retrying = broker.runToolCall("get_history", {});
    const others = Promise.all(
      Array.from({ length: MAX_IN_FLIGHT_CALLS }, () => broker.runToolCall("list_accounts", {})),
    );
    let stuckTimer: NodeJS.Timeout | undefined;
    const settled = await Promise.race([
      others,
      new Promise<"stuck">((resolve) => {
        stuckTimer = setTimeout(() => {
          resolve("stuck");
        }, 5_000);
      }),
    ]);
    clearTimeout(stuckTimer);
    assert.notEqual(settled, "stuck", "a waiting retry kept its slot");

    releaseWait();
    assert.deepEqual(await retrying, { ok: true, result: { tool: "get_history" } });
  } finally {
    releaseWait();
    server.closeAllConnections();
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
  }
});

test("closing the broker answers a waiting call and sends nothing after", async () => {
  const fake = await startFakeMcp((body) => refusalEnvelope(body, "busy"));
  let endWait: () => void = () => undefined;
  const waitStarted = new Promise<void>((started) => {
    endWait = started;
  });
  let releaseWait: () => void = () => undefined;
  try {
    const broker = new McpBroker({
      baseUrl: fake.baseUrl,
      token: FAKE_TOKEN,
      retries: true,
      wait: async () => {
        endWait();
        await new Promise<void>((resolve) => {
          releaseWait = resolve;
        });
      },
    });
    const waiting = broker.runToolCall("get_history", {});
    await waitStarted;

    broker.close();
    assert.deepEqual(await waiting, { ok: false, error: { message: GENERIC_TOOL_TROUBLE } });
    releaseWait();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(await broker.runToolCall("list_accounts", {}), { ok: false, error: { message: GENERIC_TOOL_TROUBLE } });

    assert.equal(fake.requests.length, 1, "no request after close");
  } finally {
    releaseWait();
    await fake.close();
  }
});

test("the broker's own timeout is retried exactly once, and a refused connection up to three times", async () => {
  let requests = 0;
  const hanging = createServer(() => {
    requests += 1; // never answers
  });
  await new Promise<void>((resolve) => {
    hanging.listen(0, "127.0.0.1", resolve);
  });
  const address = hanging.address();
  assert.ok(address !== null && typeof address !== "string");
  try {
    const timedOut = new McpBroker({
      baseUrl: `http://127.0.0.1:${String(address.port)}`,
      token: FAKE_TOKEN,
      timeoutMs: 250,
      retries: true,
      wait: () => Promise.resolve(),
    });
    assert.deepEqual(await timedOut.runToolCall("get_history", {}), { ok: false, error: { message: GENERIC_TOOL_TROUBLE } });
    assert.equal(requests, 2);
  } finally {
    hanging.closeAllConnections();
    await new Promise<void>((resolve) => {
      hanging.close(() => {
        resolve();
      });
    });
  }

  // A connection that fails outright: fetch rejects with a TypeError.
  let attempts = 0;
  const refused = new McpBroker({
    baseUrl: "http://127.0.0.1:9",
    token: FAKE_TOKEN,
    retries: true,
    wait: () => Promise.resolve(),
    fetchImplementation: () => {
      attempts += 1;
      return Promise.reject(new TypeError("fetch failed"));
    },
  });
  assert.deepEqual(await refused.runToolCall("get_history", {}), { ok: false, error: { message: GENERIC_TOOL_TROUBLE } });
  assert.equal(attempts, 4);
});

test("a file change answers the old page's queued and waiting calls, and the broker keeps working", async () => {
  let historyCalls = 0;
  const fake = await startFakeMcp((body) => {
    const name = (body.params as Record<string, unknown>).name;
    if (name === "get_history") {
      historyCalls += 1;
      return refusalEnvelope(body, "busy");
    }
    return successEnvelope(body, { tool: name });
  });
  let waitStarted: () => void = () => undefined;
  const started = new Promise<void>((resolve) => {
    waitStarted = resolve;
  });
  try {
    const broker = new McpBroker({
      baseUrl: fake.baseUrl,
      token: FAKE_TOKEN,
      retries: true,
      wait: async () => {
        waitStarted();
        await new Promise<void>(() => undefined); // waits until dropped
      },
    });
    const stale = broker.runToolCall("get_history", {});
    await started;
    // Two in flight, one queued behind them.
    const inFlight = [broker.runToolCall("list_accounts", {}), broker.runToolCall("list_accounts", {})];
    const queued = broker.runToolCall("get_history", {});

    broker.dropPending();

    assert.deepEqual(await stale, { ok: false, error: { message: GENERIC_TOOL_TROUBLE } });
    assert.deepEqual(await queued, { ok: false, error: { message: GENERIC_TOOL_TROUBLE } });
    await Promise.all(inFlight);
    assert.equal(historyCalls, 1);
    assert.deepEqual(await broker.runToolCall("list_accounts", {}), { ok: true, result: { tool: "list_accounts" } });
  } finally {
    await fake.close();
  }
});

test("a call in flight when the page reloads gets its answer but is never retried", async () => {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let requests = 0;
  const server = createServer((request, response) => {
    requests += 1;
    request.resume();
    void gate.then(() => {
      response.writeHead(503, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: "synthetic" }));
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address !== null && typeof address !== "string");
  try {
    const broker = retryingBroker(`http://127.0.0.1:${String(address.port)}`, []);
    const call = broker.runToolCall("get_history", {});
    while (requests === 0) {
      await new Promise((resolve) => setImmediate(resolve));
    }

    broker.dropPending();
    release();

    assert.deepEqual(await call, { ok: false, error: { message: GENERIC_TOOL_TROUBLE } });
    assert.equal(requests, 1);
  } finally {
    release();
    server.closeAllConnections();
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
  }
});
