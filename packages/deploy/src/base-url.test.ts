import assert from "node:assert/strict";
import { test } from "node:test";

import { consoleUrlOnOrigin, isLoopbackBaseUrl, PUBLIC_BASE_URL, resolveBaseUrl } from "./base-url.ts";
import { DeployError } from "./errors.ts";

test("resolveBaseUrl defaults to the public Driggsby origin", () => {
  assert.equal(resolveBaseUrl({}), PUBLIC_BASE_URL);
  assert.equal(resolveBaseUrl({ DRIGGSBY_BASE_URL: "" }), PUBLIC_BASE_URL);
  assert.equal(resolveBaseUrl({ DRIGGSBY_BASE_URL: "   " }), PUBLIC_BASE_URL);
});

test("resolveBaseUrl trims trailing slashes and allows http only on this machine", () => {
  assert.equal(
    resolveBaseUrl({ DRIGGSBY_BASE_URL: "http://127.0.0.1:3100/" }),
    "http://127.0.0.1:3100",
  );
  assert.equal(resolveBaseUrl({ DRIGGSBY_BASE_URL: "http://localhost:3100" }), "http://localhost:3100");
  assert.equal(
    resolveBaseUrl({ DRIGGSBY_BASE_URL: "https://staging.driggsby.example" }),
    "https://staging.driggsby.example",
  );
  assert.throws(() => resolveBaseUrl({ DRIGGSBY_BASE_URL: "http://insecure.example.com" }), DeployError);
  assert.throws(() => resolveBaseUrl({ DRIGGSBY_BASE_URL: "not a url" }), DeployError);
  assert.throws(() => resolveBaseUrl({ DRIGGSBY_BASE_URL: "ftp://127.0.0.1" }), DeployError);
});

test("resolveBaseUrl can't carry a query or fragment", () => {
  // API paths append directly, so a query or fragment would corrupt every
  // request path. A bare trailing "?" or "#" parses to an empty search/hash
  // but corrupts the path just the same.
  assert.throws(() => resolveBaseUrl({ DRIGGSBY_BASE_URL: "http://127.0.0.1:3100/?x=1" }), DeployError);
  assert.throws(() => resolveBaseUrl({ DRIGGSBY_BASE_URL: "https://app.driggsby.com#f" }), DeployError);
  assert.throws(() => resolveBaseUrl({ DRIGGSBY_BASE_URL: "http://127.0.0.1:3100/?" }), DeployError);
  assert.throws(() => resolveBaseUrl({ DRIGGSBY_BASE_URL: "https://app.driggsby.com#" }), DeployError);
});

test("isLoopbackBaseUrl is true only for this machine", () => {
  assert.equal(isLoopbackBaseUrl("http://127.0.0.1:3100"), true);
  assert.equal(isLoopbackBaseUrl("http://localhost:3100"), true);
  assert.equal(isLoopbackBaseUrl("https://app.driggsby.com"), false);
  // A hostname that merely contains a loopback address is not loopback.
  assert.equal(isLoopbackBaseUrl("https://127.0.0.1.nip.io"), false);
});

test("consoleUrlOnOrigin keeps a Driggsby page address only on the signed-in origin", () => {
  const base = "https://app.driggsby.com";
  assert.equal(consoleUrlOnOrigin(`${base}/dashboards/money-dash`, base), `${base}/dashboards/money-dash`);
  assert.equal(consoleUrlOnOrigin("https://app.driggsby.com.evil.test/dashboards/money-dash", base), null);
  assert.equal(consoleUrlOnOrigin("http://app.driggsby.com/dashboards/money-dash", base), null);
  assert.equal(consoleUrlOnOrigin("/dashboards/money-dash", base), null);
  assert.equal(consoleUrlOnOrigin(null, base), null);
  assert.equal(consoleUrlOnOrigin("http://127.0.0.1:4111/dashboards/x", "http://127.0.0.1:4111"), "http://127.0.0.1:4111/dashboards/x");
});
