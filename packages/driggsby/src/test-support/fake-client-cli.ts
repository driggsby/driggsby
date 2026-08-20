// Builds a temp directory containing a fake `claude` (or `codex`) command for
// end-to-end tests: a Node script plus the platform launcher (a shell shim on
// POSIX, a .cmd shim on Windows, matching how npm installs real client CLIs).
// The fake's behavior is driven by environment variables so one shim covers
// every scenario:
//   FAKE_GET_BEHAVIOR: missing | matches | differs | fail   (mcp get)
//   FAKE_ADD_BEHAVIOR: ok | already-exists | fail           (mcp add)
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

const FAKE_SCRIPT = `
const args = process.argv.slice(2);
if (args[0] === "mcp" && args[1] === "get") {
  const behavior = process.env.FAKE_GET_BEHAVIOR ?? "missing";
  if (behavior === "matches") {
    if (process.env.FAKE_CLIENT === "codex") {
      process.stdout.write('{"enabled": true, "type": "streamable_http", "url": "https://app.driggsby.com/mcp"}');
    } else {
      process.stdout.write("driggsby:\\n  Scope: User config\\n  Type: http\\n  URL: https://app.driggsby.com/mcp\\n");
    }
    process.exit(0);
  }
  if (behavior === "differs") {
    process.stdout.write("driggsby:\\n  Scope: User config\\n  Type: http\\n  URL: https://example.com/mcp\\n");
    process.exit(0);
  }
  if (behavior === "fail") {
    process.stderr.write("transient failure");
    process.exit(1);
  }
  process.stderr.write("No MCP server named 'driggsby' found.");
  process.exit(1);
}
if (args[0] === "mcp" && args[1] === "add") {
  const behavior = process.env.FAKE_ADD_BEHAVIOR ?? "ok";
  if (behavior === "already-exists") {
    process.stderr.write("driggsby already exists");
    process.exit(1);
  }
  if (behavior === "fail") {
    process.stderr.write("boom");
    process.exit(1);
  }
  process.stdout.write("Added HTTP MCP server driggsby");
  process.exit(0);
}
process.exit(1);
`;

export function installFakeClientCli(name: "claude" | "codex"): { pathPrefix: string } {
  const directory = mkdtempSync(join(tmpdir(), "driggsby-fake-cli-"));
  const scriptPath = join(directory, `${name}-impl.js`);
  writeFileSync(scriptPath, FAKE_SCRIPT);

  if (process.platform === "win32") {
    writeFileSync(join(directory, `${name}.cmd`), `@node "%~dp0${name}-impl.js" %*\r\n`);
  } else {
    const shimPath = join(directory, name);
    writeFileSync(shimPath, `#!/bin/sh\nexec node "$(dirname "$0")/${name}-impl.js" "$@"\n`);
    chmodSync(shimPath, 0o755);
  }
  return { pathPrefix: directory };
}

export function pathWithFake(pathPrefix: string): string {
  return `${pathPrefix}${delimiter}${process.env.PATH ?? ""}`;
}
