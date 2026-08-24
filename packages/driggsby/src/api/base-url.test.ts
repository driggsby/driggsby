import assert from "node:assert/strict";
import { test } from "node:test";

import { apiBaseUrl, apiHost, baseUrlMayReceiveSavedSignIn } from "./base-url.ts";
import { CliError } from "../cli-error.ts";
import { assertFitsTerminal } from "../test-support/terminal-width.ts";

// The base-URL policy itself — what DRIGGSBY_BASE_URL may be set to — lives
// in @driggsby/deploy and is tested there (base-url.test.ts). These tests
// cover this CLI's side: the CliError mapping and the saved-sign-in pin.

test("apiBaseUrl defaults to the public origin and honors the override", () => {
  assert.equal(apiBaseUrl({}), "https://app.driggsby.com");
  assert.equal(apiBaseUrl({ DRIGGSBY_BASE_URL: "http://127.0.0.1:3100/" }), "http://127.0.0.1:3100");
});

test("an invalid DRIGGSBY_BASE_URL surfaces as a CliError that fits the terminal", () => {
  const invalidValues = ["not a url", "http://driggsby.example", "http://127.0.0.1:3100/?x=1"];
  for (const value of invalidValues) {
    assert.throws(
      () => apiBaseUrl({ DRIGGSBY_BASE_URL: value }),
      (error: unknown) => {
        assert.ok(error instanceof CliError, value);
        assert.equal(error.exitCode, 1);
        assertFitsTerminal(error.message);
        return true;
      },
      value,
    );
  }
});

test("apiHost names the host the CLI talks to", () => {
  assert.equal(apiHost("https://app.driggsby.com"), "app.driggsby.com");
  assert.equal(apiHost("http://127.0.0.1:3100"), "127.0.0.1:3100");
});

test("the saved sign-in may only travel to Driggsby or loopback", () => {
  assert.equal(baseUrlMayReceiveSavedSignIn("https://app.driggsby.com"), true);
  assert.equal(baseUrlMayReceiveSavedSignIn("http://127.0.0.1:3100"), true);
  assert.equal(baseUrlMayReceiveSavedSignIn("http://localhost:3100"), true);
  // Any other host — even a plausible-looking https one — must bring its
  // own DRIGGSBY_TOKEN instead of receiving the saved credential.
  assert.equal(baseUrlMayReceiveSavedSignIn("https://staging.driggsby.example"), false);
  assert.equal(baseUrlMayReceiveSavedSignIn("https://collector.invalid"), false);
});
