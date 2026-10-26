// Runs Node.js on the given arguments with both compromised roots added to
// its default CA list at startup, and returns how many of them were still in
// the list at the process's first write to stdout or stderr (or at exit, if
// it never writes). Both bins' tests use it to show that the bin removes them
// before it runs a command; a script that doesn't remove them reports 2.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import process from "node:process";
import tls from "node:tls";
import { fileURLToPath } from "node:url";

const FIXTURE = fileURLToPath(new URL("distrusted-roots.pem", import.meta.url));
const MATCHER = new URL("../distrusted-roots.ts", import.meta.url).href;

export const DISTRUSTED_ROOT_PEMS: string[] =
  readFileSync(FIXTURE, "utf8").match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----\n?/g) ?? [];

// Where Node.js can change the list, a bin should leave none of the roots on
// an official build, and both on a build that may verify against OpenSSL's
// own store (Homebrew's, say). Worked out here independently of the code
// under test.
export const CAN_SET_THE_LIST = typeof tls.setDefaultCACertificates === "function";
export const ROOTS_LEFT_AFTER_A_BIN =
  !process.config.variables.node_shared_openssl &&
  !process.config.target_defaults.defines.includes("NODE_OPENSSL_CERT_STORE")
    ? 0
    : 2;

// Settings from the developer's own environment that change the default list.
const CA_SETTINGS = ["NODE_EXTRA_CA_CERTS", "NODE_OPTIONS", "NODE_USE_SYSTEM_CA", "SSL_CERT_FILE", "SSL_CERT_DIR"];

const PRELOAD = [
  'import tls from "node:tls";',
  `import { isDistrustedRoot } from ${JSON.stringify(MATCHER)};`,
  `tls.setDefaultCACertificates([...tls.getCACertificates("default"), ...${JSON.stringify(DISTRUSTED_ROOT_PEMS)}]);`,
  "let left;",
  'const count = () => tls.getCACertificates("default").filter(isDistrustedRoot).length;',
  "const report = process.stderr.write.bind(process.stderr);",
  "for (const stream of [process.stdout, process.stderr]) {",
  "  const write = stream.write.bind(stream);",
  "  stream.write = (...args) => { left ??= count(); return write(...args); };",
  "}",
  'process.on("exit", () => report(`distrusted-roots-left=${String(left ?? count())}\\n`));',
].join("\n");

export interface ProbeResult {
  left: number | null;
  stderr: string;
}

export function distrustedRootsLeftAfter(args: string[]): ProbeResult {
  const preload = `data:text/javascript,${encodeURIComponent(PRELOAD)}`;
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !CA_SETTINGS.includes(name)));
  const run = spawnSync(process.execPath, ["--import", preload, ...args], { encoding: "utf8", env, timeout: 30_000 });
  const left = /distrusted-roots-left=(\d+)/.exec(run.stderr)?.[1];
  return { left: left === undefined ? null : Number(left), stderr: run.stderr };
}
