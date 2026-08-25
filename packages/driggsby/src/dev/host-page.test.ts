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

test("the declared background paints the frame surround; none falls back to white", () => {
  const declared = hostPageHtml("money-dash-x7k2qf", "http://127.0.0.1:4574", "#0b0c0f");
  assert.ok(declared.includes("background: #0b0c0f;"));
  const undeclared = hostPageHtml("money-dash-x7k2qf", "http://127.0.0.1:4574", null);
  assert.ok(undeclared.includes("background: #ffffff;"));
});

// Behavioral coverage for the route sync: HOST_PAGE_JS is browser code in
// a string, so it is executed here under stubbed globals and driven with
// real message events — matching the production host's semantics (strict
// sanitizer, bare-"#" cleared sentinel, hello hand-back, throttled
// fragment-only URL writes). The pattern spelled inside the string is the
// dev host's own copy; cross-repo agreement with the platform is pinned by
// the platform repo's tests, not here.
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
    while (pendingTimers.length > 0) {
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
  const stubbed = {
    window: stubWindow,
    location: stubWindow.location,
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

  // A clean route lands in the URL immediately (leading edge), fragment only.
  deliver({ protocol: "driggsby-sdk/1", type: "route", hash: "#/cash-flow/recurring" });
  assert.equal(writes.at(-1), "http://localhost:4573/#/cash-flow/recurring");

  // A second route inside the open throttle window does not write
  // synchronously; the trailing edge picks it up when the window closes.
  const inWindow = writes.length;
  deliver({ protocol: "driggsby-sdk/1", type: "route", hash: "#/overview" });
  assert.equal(writes.length, inWindow);
  flushTimers();
  assert.equal(writes.at(-1), "http://localhost:4573/#/overview");

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
