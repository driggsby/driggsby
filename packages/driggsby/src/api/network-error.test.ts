import assert from "node:assert/strict";
import { test } from "node:test";

import { assertFitsTerminal } from "../test-support/terminal-width.ts";
import { blockedNetworkError } from "./network-error.ts";

function fetchFailure(code: string): Error {
  const cause = new Error(`getaddrinfo ${code} app.driggsby.com`) as NodeJS.ErrnoException;
  cause.code = code;
  return new TypeError("fetch failed", { cause });
}

test("connection-level fetch failures map to the exact-fix message", () => {
  for (const code of ["ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "ETIMEDOUT", "EHOSTUNREACH"]) {
    const error = blockedNetworkError(fetchFailure(code), {
      host: "app.driggsby.com",
      retryCommand: "npx driggsby@latest login",
    });
    assert.ok(error !== null, code);
    assert.equal(error.exitCode, 1);
    assert.ok(error.message.includes("app.driggsby.com"));
    assert.ok(error.message.includes("npx driggsby@latest login"));
    assert.ok(!error.message.includes("fetch failed"));
    // An agent building an egress allowlist from this message must never see
    // the hostname split by terminal soft-wrapping.
    assertFitsTerminal(error.message);
  }
});

test("a very long API host wraps without ever splitting the hostname", () => {
  // Long enough that the unwrapped sentence would pass 80 columns: the wrap
  // must break before the hostname, never inside it.
  const host = "a-very-long-subdomain-for-a-self-hosted-driggsby.example.com";
  const error = blockedNetworkError(fetchFailure("ENOTFOUND"), {
    host,
    retryCommand: "npx driggsby@latest login",
  });
  assert.ok(error !== null);
  assert.ok(error.message.includes(host), "the hostname must stay whole");
  assertFitsTerminal(error.message);
});

test("an AggregateError cause (happy-eyeballs connects) is recognized", () => {
  const refused = new Error("connect ECONNREFUSED 127.0.0.1:443") as NodeJS.ErrnoException;
  refused.code = "ECONNREFUSED";
  const error = blockedNetworkError(
    new TypeError("fetch failed", { cause: new AggregateError([refused]) }),
    { host: "app.driggsby.com", retryCommand: "npx driggsby@latest login" },
  );
  assert.ok(error !== null);
});

test("non-network errors are left for the caller", () => {
  assert.equal(
    blockedNetworkError(new Error("boom"), {
      host: "app.driggsby.com",
      retryCommand: "npx driggsby@latest login",
    }),
    null,
  );
  assert.equal(
    blockedNetworkError("not even an error", {
      host: "app.driggsby.com",
      retryCommand: "npx driggsby@latest login",
    }),
    null,
  );
});
