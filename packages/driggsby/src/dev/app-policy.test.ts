import assert from "node:assert/strict";
import { test } from "node:test";

import { appResponseHeaders, FRAME_POLICY } from "./app-policy.ts";

const HOST = "http://127.0.0.1:4111";

// The exact policy Driggsby's serving host sends with a deployed app's
// files. Spelled out whole so any change to the preview's copy is a
// deliberate one.
const DEPLOYED_POLICY =
  "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; frame-src 'none'; " +
  "object-src 'none'; form-action 'none'; base-uri 'none'";

test("a page, an SVG, or a script gets the deployed policy and Connection-Allowlist", () => {
  for (const contentType of [
    "text/html; charset=utf-8",
    "image/svg+xml; charset=utf-8",
    "text/javascript; charset=utf-8",
    "application/javascript; charset=utf-8",
  ]) {
    const headers = appResponseHeaders(HOST, contentType);
    assert.equal(
      headers["Content-Security-Policy"],
      `sandbox allow-scripts allow-same-origin; ${DEPLOYED_POLICY}; frame-ancestors ${HOST}`,
      contentType,
    );
    assert.equal(headers["Connection-Allowlist"], "(response-origin)", contentType);
    assert.equal(headers["X-Content-Type-Options"], "nosniff", contentType);
  }
});

test("any other file opens sealed, without Connection-Allowlist", () => {
  for (const contentType of [
    "image/png",
    "application/json; charset=utf-8",
    "text/plain; charset=utf-8",
    "text/css; charset=utf-8",
    "font/woff2",
    "application/octet-stream",
  ]) {
    const headers = appResponseHeaders(HOST, contentType);
    assert.equal(
      headers["Content-Security-Policy"],
      `sandbox; ${DEPLOYED_POLICY}; frame-ancestors ${HOST}`,
      contentType,
    );
    assert.equal(headers["Connection-Allowlist"], undefined, contentType);
    assert.equal(headers["X-Content-Type-Options"], "nosniff", contentType);
  }
});

test("every response carries the rest of the deployed headers, and accepts the host page's frame policy", () => {
  for (const contentType of ["text/html; charset=utf-8", "image/png"]) {
    const headers = appResponseHeaders(HOST, contentType);
    assert.equal(headers["Referrer-Policy"], "no-referrer", contentType);
    assert.equal(headers["Cross-Origin-Resource-Policy"], "same-origin", contentType);
    assert.equal(headers["Cross-Origin-Opener-Policy"], "same-origin", contentType);
    assert.equal(
      headers["Permissions-Policy"],
      "camera=(), microphone=(), geolocation=(), payment=()",
      contentType,
    );
    assert.equal(headers["Allow-CSP-From"], HOST, contentType);
  }
  // The host page requires exactly the deployed policy of its frame.
  assert.equal(FRAME_POLICY, DEPLOYED_POLICY);
});

test("before the host page has an origin, nothing may frame the app", () => {
  const headers = appResponseHeaders("", "text/html; charset=utf-8");
  assert.match(headers["Content-Security-Policy"] ?? "", /; frame-ancestors 'none'$/);
  assert.equal(headers["Allow-CSP-From"], undefined);
});
