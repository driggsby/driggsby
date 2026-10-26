// Roots over the eMudhra intermediate CAs that turned out, in October 2026,
// to have trivially weak private keys. The intermediates chain to emSign ECC
// Root CA - G3, and through Sectigo cross-signs to AAA Certificate Services,
// so anyone can issue a certificate for any host under either root. Current
// Node.js releases trust neither; older ones trust one or both. Both bins
// remove them from the process's default CA list before making any request,
// where Node.js lets them.
import { createHash } from "node:crypto";
import process from "node:process";
import tls from "node:tls";

// SHA-256 fingerprints of the two roots' DER encodings.
const DISTRUSTED_ROOT_FINGERPRINTS: ReadonlySet<string> = new Set([
  // emSign ECC Root CA - G3
  "86a1ecba089c4a8d3bbe2734c612ba341d813e043cf9e8a862cd5c57a36bbe6b",
  // AAA Certificate Services
  "d7a7a0fb5d7e2731d771e9484ebcdef71d5f0c3e0a2948782bc83ee0ea699ef4",
]);

const PEM_BODY = /-----BEGIN CERTIFICATE-----([\s\S]*?)-----END CERTIFICATE-----/;

// The SHA-256 of a PEM certificate's DER. Node.js re-serializes the list
// once it has been set, so certificates compare by content, not by text.
function fingerprint(pem: string): string | undefined {
  const body = PEM_BODY.exec(pem)?.[1];
  if (body === undefined) {
    return undefined;
  }
  const der = Buffer.from(body.replace(/\s+/g, ""), "base64");
  return createHash("sha256").update(der).digest("hex");
}

export function isDistrustedRoot(pem: string): boolean {
  const print = fingerprint(pem);
  return print !== undefined && DISTRUSTED_ROOT_FINGERPRINTS.has(print);
}

// The CA-list API, declared here rather than taken from the Node.js typings:
// typings for Node.js before 24.5.0 (22.19.0 on the 22 line) don't have it,
// and this package supports those versions.
export interface CaListApi {
  getCACertificates?: (type: "default" | "bundled" | "extra") => string[];
  setDefaultCACertificates?: (certs: string[]) => void;
}

// The parts of the build configuration this reads.
export interface BuildConfig {
  variables: { node_shared_openssl?: unknown };
  target_defaults: { defines?: unknown };
}

// Builds made to verify against OpenSSL's own store (the build flag that
// defines NODE_OPENSSL_CERT_STORE, as Homebrew's and many Linux
// distributions' builds do) still report Node.js's bundled list, so
// replacing that list would swap their real store, company CAs included,
// for the bundled roots; their fix comes from that store's own update.
// Builds linked against a shared OpenSSL are skipped too, to stay on the
// safe side, as is any runtime whose build configuration doesn't say.
// Exported for tests.
export function mayUseOpenSslStore(config: BuildConfig = process.config): boolean {
  const defines = config.target_defaults.defines;
  return (
    config.variables.node_shared_openssl !== false ||
    !Array.isArray(defines) ||
    defines.includes("NODE_OPENSSL_CERT_STORE")
  );
}

// Removes the distrusted roots from the default CA list, where that list is
// the one Node.js verifies against: it holds every bundled root, and is at
// least as long as the bundled roots plus the extra CAs, as it is unless
// --use-openssl-ca is set. It never sets an empty list, and it does nothing
// where Node.js can't change the list or the list doesn't hold the roots.
// Exported for tests; callers use distrustCompromisedRoots.
export function removeDistrustedRoots(api: CaListApi, opensslStore: () => boolean): void {
  if (api.getCACertificates === undefined || api.setDefaultCACertificates === undefined) {
    return;
  }
  try {
    if (opensslStore()) {
      return;
    }
    const roots = api.getCACertificates("default");
    const bundled = api.getCACertificates("bundled");
    const listed = new Set(roots.map(fingerprint));
    const holdsBundled = bundled.every((pem) => listed.has(fingerprint(pem)));
    if (!holdsBundled || roots.length < bundled.length + api.getCACertificates("extra").length) {
      return;
    }
    const kept = roots.filter((pem) => !isDistrustedRoot(pem));
    if (kept.length !== roots.length && kept.length > 0) {
      api.setDefaultCACertificates(kept);
    }
  } catch {
    // Hardening only: if Node.js can't read or replace its list, the CLI
    // carries on with the list Node.js already uses.
  }
}

// Silently removes the distrusted roots from this process's default CA list,
// where Node.js lets it. Call it once at startup, before the first HTTPS
// request: the list applies to TLS connections made after it is set.
export function distrustCompromisedRoots(): void {
  removeDistrustedRoots(tls, () => mayUseOpenSslStore());
}
