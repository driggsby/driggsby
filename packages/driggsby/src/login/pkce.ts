// PKCE for driggsby login (RFC 7636, S256). The verifier never leaves this
// process except to trade the one-time code the approval page produced;
// Driggsby mints the token only for the code and the verifier together, so
// whoever else holds the approval link gets nothing from someone's approval.
import { createHash, randomBytes } from "node:crypto";

export interface PkcePair {
  verifier: string;
  challenge: string;
}

export function createPkcePair(): PkcePair {
  // 32 random bytes are 43 base64url characters: the RFC's minimum length
  // and 256 bits of entropy.
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: challengeFor(verifier) };
}

export function challengeFor(verifier: string): string {
  return createHash("sha256").update(verifier, "ascii").digest("base64url");
}
