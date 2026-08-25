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
  const html = hostPageHtml("money-dash-x7k2qf", "http://127.0.0.1:4574");
  assert.ok(html.includes('data-app-origin="http://127.0.0.1:4574"'));
  assert.ok(html.includes('src="/host.js"'));
  assert.ok(!html.includes("<script>"));
});
