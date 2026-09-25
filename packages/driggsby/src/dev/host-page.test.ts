import assert from "node:assert/strict";
import { test } from "node:test";

import { transformSync } from "esbuild";

import { HOST_PAGE_JS, hostPageHtml } from "./host-page.ts";

// HOST_PAGE_JS is browser code stored as a string literal, so tsc, ESLint,
// and the rest of the suite cannot see into it. This parse gate makes a
// broken brace or stray quote a red build instead of a page that dies in
// the browser. (Behavior is covered end to end by dev-servers.test.ts's
// protocol tests, which exercise the endpoints the script drives.)
test("the host page script parses as JavaScript", () => {
  assert.doesNotThrow(() => transformSync(HOST_PAGE_JS, { loader: "js" }));
});

test("the host page pins the app origin and keeps its script external", () => {
  const html = hostPageHtml("money-dash-x7k2qf", "http://127.0.0.1:4574", null);
  assert.ok(html.includes('data-app-origin="http://127.0.0.1:4574"'));
  assert.ok(html.includes('src="/host.js"'));
  assert.ok(!html.includes("<script>"));
});

// The frame's own rule, so the page's own background can't satisfy it.
function frameRule(html: string): string {
  const rule = /iframe \{[^}]*\}/.exec(html);
  assert.ok(rule, "the host page styles its iframe");
  return rule[0];
}

test("the declared background paints the frame surround; none falls back to the console's", () => {
  const declared = hostPageHtml("money-dash-x7k2qf", "http://127.0.0.1:4574", "#0b0c0f");
  assert.ok(frameRule(declared).includes("background: #0b0c0f;"));
  const undeclared = hostPageHtml("money-dash-x7k2qf", "http://127.0.0.1:4574", null);
  // What Driggsby paints under an app that declared no background: its
  // card surface on the black page.
  assert.ok(frameRule(undeclared).includes("background: #0a0a0a;"));
  // The chrome around the frame is the console's: black ground, light ink.
  assert.ok(undeclared.includes("color-scheme: dark;"));
  assert.ok(!undeclared.includes("#ffffff"));
});

// Behavioral coverage for the route sync: HOST_PAGE_JS is browser code in
// a string, so it is executed here under stubbed globals and driven with
// real message events — matching the production host's semantics (strict
// sanitizer, bare-"#" cleared sentinel, hello hand-back, bucket-paced
// fragment-only URL writes). The route pattern and bucket constants
// spelled inside the string are the dev host's own copies of the
// platform host's; nothing pins them across the two codebases, so a
// change on either side must be mirrored by hand.
test("the host page script syncs routes: sanitize, mirror, clear, and hand back", () => {
  const writes: string[] = [];
  const posted: Record<string, unknown>[] = [];
  const frameWindow = {
    postMessage: (message: Record<string, unknown>) => {
      posted.push(message);
    },
  };
  type Listener = (event: Record<string, unknown>) => void;
  const listeners = new Map<string, Listener>();
  const pendingTimers: (() => void)[] = [];
  const flushTimers = (): void => {
    // A timer callback may re-arm itself; a regression in the token
    // arithmetic must fail loudly here, not spin forever.
    let fired = 0;
    while (pendingTimers.length > 0) {
      fired += 1;
      assert.ok(fired <= 100, "timer flush did not converge");
      pendingTimers.shift()?.();
    }
  };
  const stubWindow = {
    location: {
      hash: "#/seeded",
      href: "http://localhost:4573/#/seeded",
      pathname: "/",
      search: "",
    },
    addEventListener: (name: string, listener: Listener) => {
      listeners.set(name, listener);
    },
  };
  let nowMs = 0;
  const stubbed = {
    window: stubWindow,
    location: stubWindow.location,
    Date: { now: () => nowMs },
    history: {
      state: null,
      replaceState: (_state: unknown, _title: string, url: string) => {
        writes.push(url);
        const hashIndex = url.indexOf("#");
        stubWindow.location.href = url;
        stubWindow.location.hash = hashIndex === -1 ? "" : url.slice(hashIndex);
      },
    },
    document: {
      documentElement: { dataset: { appOrigin: "http://127.0.0.1:4574" } },
      getElementById: () => ({ contentWindow: frameWindow }),
    },
    setTimeout: (callback: () => void) => {
      pendingTimers.push(callback);
      return pendingTimers.length;
    },
    fetch: () => Promise.reject(new Error("no tool calls in this test")),
    EventSource: class {
      addEventListener(): void {
        return undefined; // the change stream is inert in this test
      }
    },
  };
  // The served script only exists as a string, so executing it requires the
  // Function constructor; its content is this repo's own reviewed source.
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const run = new Function(...Object.keys(stubbed), HOST_PAGE_JS);
  // eslint-disable-next-line @typescript-eslint/no-unsafe-call
  run(...Object.values(stubbed));
  const deliver = (data: Record<string, unknown>): void => {
    listeners.get("message")?.({
      origin: "http://127.0.0.1:4574",
      source: frameWindow,
      data,
    });
  };

  // ready -> hello carries the page's seeded fragment.
  deliver({ protocol: "driggsby-sdk/1", type: "ready" });
  assert.deepEqual(posted.at(-1), { protocol: "driggsby-sdk/1", type: "hello", route: "#/seeded" });

  // Human-speed navigation writes instantly, back to back — the token
  // bucket only paces sustained spam, never ordinary clicking.
  deliver({ protocol: "driggsby-sdk/1", type: "route", hash: "#/cash-flow/recurring" });
  assert.equal(writes.at(-1), "http://localhost:4573/#/cash-flow/recurring");
  deliver({ protocol: "driggsby-sdk/1", type: "route", hash: "#/overview" });
  assert.equal(writes.at(-1), "http://localhost:4573/#/overview");

  // A spam burst drains the bucket (15 instant writes total, 2 spent
  // above), then defers; the trailing write lands the FINAL state once a
  // token accrues, and the skipped intermediates never write.
  for (let i = 0; i < 13; i += 1) {
    deliver({ protocol: "driggsby-sdk/1", type: "route", hash: `#/burst-${String(i)}` });
  }
  assert.equal(writes.at(-1), "http://localhost:4573/#/burst-12");
  const drained = writes.length;
  deliver({ protocol: "driggsby-sdk/1", type: "route", hash: "#/deferred-a" });
  deliver({ protocol: "driggsby-sdk/1", type: "route", hash: "#/deferred-b" });
  assert.equal(writes.length, drained);
  nowMs += 600; // one refill period: exactly one token accrues
  flushTimers();
  assert.equal(writes.length, drained + 1);
  assert.equal(writes.at(-1), "http://localhost:4573/#/deferred-b");

  // Re-reporting the route already in the URL is a no-op: no write, and
  // no token spent (the bucket is empty here, so a spend would defer).
  deliver({ protocol: "driggsby-sdk/1", type: "route", hash: "#/deferred-b" });
  assert.equal(writes.length, drained + 1);
  assert.equal(pendingTimers.length, 0);

  // Idle time refills the bucket for the assertions below.
  nowMs += 600 * 15;

  // Hostile shapes never write.
  const before = writes.length;
  deliver({ protocol: "driggsby-sdk/1", type: "route", hash: "#has space" });
  deliver({ protocol: "driggsby-sdk/1", type: "route", hash: "javascript:alert(1)" });
  deliver({ protocol: "driggsby-sdk/1", type: "route", hash: 42 });
  flushTimers();
  assert.equal(writes.length, before);

  // A foreign origin is ignored entirely, and so is the right origin from
  // a window that is not the app frame.
  listeners.get("message")?.({
    origin: "https://evil.example",
    source: frameWindow,
    data: { protocol: "driggsby-sdk/1", type: "route", hash: "#/evil" },
  });
  listeners.get("message")?.({
    origin: "http://127.0.0.1:4574",
    source: { postMessage: () => undefined },
    data: { protocol: "driggsby-sdk/1", type: "route", hash: "#/evil" },
  });
  flushTimers();
  assert.equal(writes.length, before);

  // The bare-"#" sentinel drops the fragment, and the next hello omits route.
  deliver({ protocol: "driggsby-sdk/1", type: "route", hash: "#" });
  assert.equal(writes.at(-1), "http://localhost:4573/");
  flushTimers();
  deliver({ protocol: "driggsby-sdk/1", type: "ready" });
  assert.deepEqual(posted.at(-1), { protocol: "driggsby-sdk/1", type: "hello" });
});

// The host page's tool-call relay, run under stubbed globals: the kinds it
// hands the app, and the results it drops after a reload.
test("the host page relays only the service's failure kinds, and drops a result from before a reload", async () => {
  const posted: Record<string, unknown>[] = [];
  const frameWindow = {
    postMessage: (message: Record<string, unknown>) => {
      posted.push(message);
    },
  };
  type Listener = (event: Record<string, unknown>) => void;
  const listeners = new Map<string, Listener>();
  const answers: ((payload: unknown) => void)[] = [];
  let changeListener: () => void = () => undefined;
  const stubWindow = {
    location: { hash: "", href: "http://localhost:4573/", pathname: "/", search: "" },
    addEventListener: (name: string, listener: Listener) => {
      listeners.set(name, listener);
    },
  };
  const stubbed = {
    window: stubWindow,
    location: stubWindow.location,
    Date: { now: () => 0 },
    history: { state: null, replaceState: () => undefined },
    document: {
      documentElement: { dataset: { appOrigin: "http://127.0.0.1:4574" } },
      getElementById: () => ({ contentWindow: frameWindow }),
    },
    setTimeout: () => 0,
    // Each tool call's answer is released by the test, in any order.
    fetch: () =>
      new Promise((resolve) => {
        answers.push((payload) => {
          resolve({ json: () => Promise.resolve(payload) });
        });
      }),
    EventSource: class {
      addEventListener(_name: string, listener: () => void): void {
        changeListener = listener;
      }
    },
  };
  // The served script only exists as a string, so executing it requires the
  // Function constructor; its content is this repo's own reviewed source.
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const run = new Function(...Object.keys(stubbed), HOST_PAGE_JS);
  // eslint-disable-next-line @typescript-eslint/no-unsafe-call
  run(...Object.values(stubbed));
  const deliver = (data: Record<string, unknown>): void => {
    listeners.get("message")?.({ origin: "http://127.0.0.1:4574", source: frameWindow, data });
  };
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  const call = (id: string): void => {
    deliver({ protocol: "driggsby-sdk/1", type: "call", id, tool: "get_history", params: {} });
  };
  const results = () => posted.filter((message) => message.type === "result");

  deliver({ protocol: "driggsby-sdk/1", type: "ready" });
  call("w1");
  call("w2");
  answers[0]?.({ ok: false, error: { message: "Synthetic refusal.", kind: "busy" } });
  answers[1]?.({ ok: false, error: { message: "Synthetic refusal.", kind: "melted" } });
  await settle();
  assert.deepEqual(results(), [
    { protocol: "driggsby-sdk/1", type: "result", id: "w1", error: { message: "Synthetic refusal.", kind: "busy" } },
    { protocol: "driggsby-sdk/1", type: "result", id: "w2", error: { message: "Synthetic refusal." } },
  ]);

  // A call from before a file change, answered after it: dropped.
  call("w1");
  changeListener();
  answers[2]?.({ ok: true, result: { stale: true } });
  await settle();
  assert.equal(results().length, 2);

  // And one from before the reloaded app's ready.
  call("w1");
  deliver({ protocol: "driggsby-sdk/1", type: "ready" });
  answers[3]?.({ ok: true, result: { stale: true } });
  await settle();
  assert.equal(results().length, 2);
});
