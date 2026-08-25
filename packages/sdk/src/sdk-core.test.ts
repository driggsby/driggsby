import assert from "node:assert/strict";
import { test } from "node:test";

import {
  MAX_WATCHES,
  PROTOCOL,
  SdkCore,
  isAllowedHostOrigin,
  isLocalAppHostname,
  sanitizeAppRoute,
} from "./sdk-core.ts";

// The Driggsby console origin — the only host origin a production app ever
// accepts.
const CONSOLE_ORIGIN = "https://app.driggsby.com";

interface PostedMessage {
  message: Record<string, unknown>;
  targetOrigin: string;
}

function coreWithLog(options: { allowLocalHostOrigins?: boolean } = {}): {
  core: SdkCore;
  posted: PostedMessage[];
} {
  const posted: PostedMessage[] = [];
  const core = new SdkCore((message, targetOrigin) => {
    posted.push({ message, targetOrigin });
  }, options);
  return { core, posted };
}

function hello(core: SdkCore, origin = CONSOLE_ORIGIN): void {
  core.handleMessage(origin, true, { protocol: PROTOCOL, type: "hello" });
}

test("the protocol version string is frozen", () => {
  // driggsby-sdk/1 is pinned on both sides of the wire (this SDK and the
  // Driggsby host). Changing it is a breaking protocol revision, never an
  // edit.
  assert.equal(PROTOCOL, "driggsby-sdk/1");
});

test("a watch posts the exact call message, only after a valid hello", () => {
  const { core, posted } = coreWithLog();
  core.watch("get_overview", { period: "month" }, () => undefined);
  assert.equal(posted.length, 0, "no call may leave the page before the host proves itself");

  hello(core);
  assert.equal(posted.length, 1);
  const first = posted[0];
  assert.ok(first !== undefined);
  assert.deepEqual(first.message, {
    protocol: "driggsby-sdk/1",
    type: "call",
    id: "w1",
    tool: "get_overview",
    params: { period: "month" },
  });
  assert.equal(first.targetOrigin, CONSOLE_ORIGIN);
});

test("null or omitted params become an empty object on the wire", () => {
  const { core, posted } = coreWithLog();
  hello(core);
  core.watch("list_accounts", null, () => undefined);
  core.watch("list_findings", undefined, () => undefined);
  assert.deepEqual(posted[0]?.message.params, {});
  assert.deepEqual(posted[1]?.message.params, {});
});

test("host origin allowlist: production pins to the console origin only", () => {
  for (const [origin, allowed] of [
    [CONSOLE_ORIGIN, true],
    ["https://app.driggsby.com.evil.example", false],
    ["http://localhost:4111", false],
    ["http://127.0.0.1:4111", false],
    ["null", false],
    ["", false],
  ] as const) {
    assert.equal(isAllowedHostOrigin(origin, false), allowed, origin);
  }
});

test("host origin allowlist: local runtimes additionally accept loopback http", () => {
  for (const [origin, allowed] of [
    [CONSOLE_ORIGIN, true],
    ["http://localhost:4111", true],
    ["http://localhost", true],
    ["http://127.0.0.1:4111", true],
    ["https://localhost:4111", false],
    ["http://sub.localhost:4111", false],
    ["http://localhost.evil.example", false],
    ["http://192.168.1.20:4111", false],
  ] as const) {
    assert.equal(isAllowedHostOrigin(origin, true), allowed, origin);
  }
});

test("local app hostnames: localhost, 127.0.0.1, and *.localhost only", () => {
  for (const [hostname, local] of [
    ["localhost", true],
    ["127.0.0.1", true],
    ["money-dash.localhost", true],
    ["money-dash.driggsby.dev", false],
    ["localhost.evil.example", false],
    ["", false],
  ] as const) {
    assert.equal(isLocalAppHostname(hostname), local, hostname);
  }
});

test("the first valid hello pins the host; later hellos are ignored", () => {
  const { core, posted } = coreWithLog({ allowLocalHostOrigins: true });
  let readyCount = 0;
  core.onHostReady = () => {
    readyCount += 1;
  };

  hello(core, "https://evil.example");
  assert.equal(core.hostReady, false, "a disallowed hello must not pin");

  hello(core, "http://localhost:4111");
  hello(core, CONSOLE_ORIGIN);
  assert.equal(readyCount, 1, "only the first valid hello fires the ready hook");

  core.watch("get_overview", {}, () => undefined);
  assert.equal(posted[0]?.targetOrigin, "http://localhost:4111");
});

test("messages not from the parent window never pin or deliver", () => {
  const { core, posted } = coreWithLog();
  core.handleMessage(CONSOLE_ORIGIN, false, { protocol: PROTOCOL, type: "hello" });
  assert.equal(core.hostReady, false);
  core.watch("get_overview", {}, () => undefined);
  assert.equal(posted.length, 0);
});

test("post-handshake messages from any other origin are ignored", () => {
  const { core } = coreWithLog();
  const seen: unknown[] = [];
  hello(core);
  core.watch("get_overview", {}, (result) => seen.push(result));
  core.handleMessage("https://evil.example", true, {
    protocol: PROTOCOL,
    type: "result",
    id: "w1",
    result: { net_worth: 1 },
  });
  assert.equal(seen.length, 0);
});

test("a hello carrying a route restores it exactly once, before held watches fire", () => {
  const { core, posted } = coreWithLog();
  const events: string[] = [];
  core.onRestoreRoute = (route) => {
    events.push(`restore:${route}`);
  };
  core.watch("list_accounts", {}, () => undefined);

  core.handleMessage(CONSOLE_ORIGIN, true, {
    protocol: PROTOCOL,
    type: "hello",
    route: "#/cash-flow/recurring",
  });

  assert.deepEqual(events, ["restore:#/cash-flow/recurring"]);
  assert.equal(posted.length, 1, "the held watch fires after the restore");

  // A second hello (already pinned) restores nothing.
  core.handleMessage(CONSOLE_ORIGIN, true, { protocol: PROTOCOL, type: "hello", route: "#/debts" });
  assert.deepEqual(events, ["restore:#/cash-flow/recurring"]);
});

test("a hello with a malformed or missing route restores nothing", () => {
  const { core } = coreWithLog();
  const events: string[] = [];
  core.onRestoreRoute = (route) => {
    events.push(route);
  };

  core.handleMessage(CONSOLE_ORIGIN, true, {
    protocol: PROTOCOL,
    type: "hello",
    route: "javascript:alert(1)",
  });
  assert.deepEqual(events, []);
  assert.equal(core.hostReady, true, "a bad route never blocks the handshake itself");

  const second = coreWithLog();
  const secondEvents: string[] = [];
  second.core.onRestoreRoute = (route) => {
    secondEvents.push(route);
  };
  hello(second.core);
  assert.deepEqual(secondEvents, []);
});

test("reportRoute posts only after the host pins, and only clean hashes", () => {
  const { core, posted } = coreWithLog();

  core.reportRoute("#/overview"); // nobody to tell yet
  assert.equal(posted.length, 0);

  hello(core);
  core.reportRoute("#/overview");
  assert.deepEqual(posted.at(-1), {
    message: { protocol: PROTOCOL, type: "route", hash: "#/overview" },
    targetOrigin: CONSOLE_ORIGIN,
  });

  // Anything unmirrorable — a no-hash location OR a hash outside the
  // strict shape — reports the bare-"#" cleared sentinel: the host must
  // forget rather than keep claiming a location the app already left.
  core.reportRoute("");
  assert.deepEqual(posted.at(-1)?.message, { protocol: PROTOCOL, type: "route", hash: "#" });
  core.reportRoute("#");
  assert.deepEqual(posted.at(-1)?.message, { protocol: PROTOCOL, type: "route", hash: "#" });
  core.reportRoute("#/txns?cat=dining");
  assert.deepEqual(posted.at(-1)?.message, { protocol: PROTOCOL, type: "route", hash: "#" });
  core.reportRoute("#bad hash");
  assert.deepEqual(posted.at(-1)?.message, { protocol: PROTOCOL, type: "route", hash: "#" });
});

test("sanitizeAppRoute keeps only the short, boring hash shape", () => {
  assert.equal(sanitizeAppRoute("#/cash-flow/recurring"), "#/cash-flow/recurring");
  assert.equal(sanitizeAppRoute("#/overview"), "#/overview");
  assert.equal(sanitizeAppRoute("#"), "");
  assert.equal(sanitizeAppRoute(""), "");
  assert.equal(sanitizeAppRoute("no-hash-prefix"), "");
  assert.equal(sanitizeAppRoute("#has space"), "");
  assert.equal(sanitizeAppRoute("#/a?q=1"), "");
  assert.equal(sanitizeAppRoute(`#${"a".repeat(257)}`), "");
  assert.equal(sanitizeAppRoute(42), "");
  assert.equal(sanitizeAppRoute(undefined), "");
});

test("a result reaches its watch callback and dedupes by JSON identity", () => {
  const { core } = coreWithLog();
  const seen: unknown[] = [];
  hello(core);
  core.watch("get_overview", {}, (result) => seen.push(result));

  const result = { protocol: PROTOCOL, type: "result", id: "w1", result: { net_worth: 5 } };
  core.handleMessage(CONSOLE_ORIGIN, true, result);
  core.handleMessage(CONSOLE_ORIGIN, true, result);
  assert.equal(seen.length, 1, "identical data must not re-render");

  core.handleMessage(CONSOLE_ORIGIN, true, {
    protocol: PROTOCOL,
    type: "result",
    id: "w1",
    result: { net_worth: 6 },
  });
  assert.deepEqual(seen, [{ net_worth: 5 }, { net_worth: 6 }]);
});

test("an error result goes to onToolError, never the data callback", () => {
  const { core } = coreWithLog();
  const data: unknown[] = [];
  const errors: string[] = [];
  core.onToolError = (_tool, message) => errors.push(message);
  hello(core);
  core.watch("get_overview", {}, (result) => data.push(result));

  const error = {
    protocol: PROTOCOL,
    type: "result",
    id: "w1",
    error: { message: "That tool isn't available to dashboards." },
  };
  core.handleMessage(CONSOLE_ORIGIN, true, error);
  core.handleMessage(CONSOLE_ORIGIN, true, error);

  assert.equal(data.length, 0);
  assert.deepEqual(errors, ["That tool isn't available to dashboards."]);
});

test("an error object without a string message gets the generic wording", () => {
  const { core } = coreWithLog();
  const errors: string[] = [];
  core.onToolError = (_tool, message) => errors.push(message);
  hello(core);
  core.watch("get_overview", {}, () => undefined);
  core.handleMessage(CONSOLE_ORIGIN, true, {
    protocol: PROTOCOL,
    type: "result",
    id: "w1",
    error: { message: 42 },
  });
  assert.deepEqual(errors, ["Something went wrong running this tool."]);
});

test("data-changed re-runs every live watch, not unsubscribed ones", () => {
  const { core, posted } = coreWithLog();
  hello(core);
  core.watch("get_overview", {}, () => undefined);
  const unsubscribe = core.watch("list_accounts", {}, () => undefined);
  unsubscribe();
  posted.length = 0;

  core.handleMessage(CONSOLE_ORIGIN, true, { protocol: PROTOCOL, type: "data-changed" });
  assert.deepEqual(
    posted.map((entry) => entry.message.id),
    ["w1"],
  );
});

test("a late result after unsubscribe is dropped", () => {
  const { core } = coreWithLog();
  const seen: unknown[] = [];
  hello(core);
  const unsubscribe = core.watch("get_overview", {}, (result) => seen.push(result));
  unsubscribe();
  core.handleMessage(CONSOLE_ORIGIN, true, {
    protocol: PROTOCOL,
    type: "result",
    id: "w1",
    result: {},
  });
  assert.equal(seen.length, 0);
});

test("new-version fires the reload hook, only from the pinned origin", () => {
  const { core } = coreWithLog();
  let reloads = 0;
  core.onNewVersion = () => {
    reloads += 1;
  };
  core.handleMessage(CONSOLE_ORIGIN, true, { protocol: PROTOCOL, type: "new-version" });
  assert.equal(reloads, 0, "no reload before the handshake");

  hello(core);
  core.handleMessage("https://evil.example", true, { protocol: PROTOCOL, type: "new-version" });
  assert.equal(reloads, 0);
  core.handleMessage(CONSOLE_ORIGIN, true, { protocol: PROTOCOL, type: "new-version" });
  assert.equal(reloads, 1);
});

test("malformed and foreign messages are ignored without effect", () => {
  const { core, posted } = coreWithLog();
  hello(core);
  core.watch("get_overview", {}, () => undefined);
  posted.length = 0;
  for (const data of [
    null,
    "a string",
    { protocol: "other/1", type: "data-changed" },
    { protocol: PROTOCOL, type: 42 },
    { protocol: PROTOCOL, type: "result", id: "unknown", result: {} },
    { protocol: PROTOCOL },
  ]) {
    core.handleMessage(CONSOLE_ORIGIN, true, data);
  }
  assert.equal(posted.length, 0);
});

test("the watch cap reports, hands back a no-op, and burns no slot", () => {
  const { core, posted } = coreWithLog();
  const errors: string[] = [];
  core.onToolError = (tool, message) => errors.push(`${tool}: ${message}`);
  hello(core);

  for (let index = 0; index < MAX_WATCHES; index += 1) {
    core.watch("get_overview", {}, () => undefined);
  }
  const unsubscribe = core.watch("list_accounts", {}, () => undefined);
  assert.equal(errors.length, 1);
  assert.match(errors[0] ?? "", /^list_accounts: Watch limit reached \(32\)/);

  // The refused watch's unsubscribe must not free a real slot.
  unsubscribe();
  posted.length = 0;
  core.handleMessage(CONSOLE_ORIGIN, true, { protocol: PROTOCOL, type: "data-changed" });
  assert.equal(posted.length, MAX_WATCHES);
});
