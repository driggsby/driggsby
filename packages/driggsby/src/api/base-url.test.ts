import assert from "node:assert/strict";
import { test } from "node:test";

import { apiBaseUrl, apiHost } from "./base-url.ts";
import { CliError } from "../cli-error.ts";
import { assertFitsTerminal } from "../test-support/terminal-width.ts";

test("defaults to the public Driggsby origin", () => {
  assert.equal(apiBaseUrl({}), "https://app.driggsby.com");
  assert.equal(apiBaseUrl({ DRIGGSBY_BASE_URL: "" }), "https://app.driggsby.com");
  assert.equal(apiBaseUrl({ DRIGGSBY_BASE_URL: "   " }), "https://app.driggsby.com");
});

test("DRIGGSBY_BASE_URL overrides the origin, minus any trailing slash", () => {
  assert.equal(apiBaseUrl({ DRIGGSBY_BASE_URL: "http://127.0.0.1:3100" }), "http://127.0.0.1:3100");
  assert.equal(apiBaseUrl({ DRIGGSBY_BASE_URL: "http://127.0.0.1:3100/" }), "http://127.0.0.1:3100");
});

test("a malformed DRIGGSBY_BASE_URL fails with a clear error", () => {
  assert.throws(
    () => apiBaseUrl({ DRIGGSBY_BASE_URL: "not a url" }),
    (error: unknown) => {
      assert.ok(error instanceof CliError);
      assertFitsTerminal(error.message);
      return true;
    },
  );
});

test("DRIGGSBY_BASE_URL must be https, or http only on localhost", () => {
  assert.equal(apiBaseUrl({ DRIGGSBY_BASE_URL: "https://staging.driggsby.example" }), "https://staging.driggsby.example");
  assert.equal(apiBaseUrl({ DRIGGSBY_BASE_URL: "http://localhost:3100" }), "http://localhost:3100");
  assert.throws(
    () => apiBaseUrl({ DRIGGSBY_BASE_URL: "http://driggsby.example" }),
    (error: unknown) => {
      assert.ok(error instanceof CliError);
      assertFitsTerminal(error.message);
      return true;
    },
  );
  assert.throws(() => apiBaseUrl({ DRIGGSBY_BASE_URL: "ftp://127.0.0.1" }), CliError);
});

test("apiHost names the host the CLI talks to", () => {
  assert.equal(apiHost("https://app.driggsby.com"), "app.driggsby.com");
  assert.equal(apiHost("http://127.0.0.1:3100"), "127.0.0.1:3100");
});
