import assert from "node:assert/strict";
import { test } from "node:test";

import { challengeFor, createPkcePair } from "./pkce.ts";

test("the challenge is the base64url SHA-256 of the verifier (RFC 7636 appendix B)", () => {
  assert.equal(
    challengeFor("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
    "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
  );
});

test("each sign-in gets a fresh 43-character verifier and its challenge", () => {
  const first = createPkcePair();
  const second = createPkcePair();

  assert.match(first.verifier, /^[A-Za-z0-9_-]{43}$/);
  assert.match(first.challenge, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(first.challenge, challengeFor(first.verifier));
  assert.notEqual(first.verifier, second.verifier);
});
