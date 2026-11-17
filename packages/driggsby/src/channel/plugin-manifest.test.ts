// The Driggsby plugin runs an exact CLI version, so a new npm publish only
// reaches plugin users once this repo's plugin names it. The pin has to
// move with every release.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { VERSION } from "../version.ts";

const mcp = JSON.parse(readFileSync(new URL("../../../../plugins/driggsby/.mcp.json", import.meta.url), "utf8")) as {
  mcpServers: Record<string, { command: string; args: string[] }>;
};

// --prefix keeps the open folder's .npmrc and node_modules (a driggsby of
// its own) out of what npx runs.
test("the plugin runs this exact release's channel, never the open folder's npm settings or copy", () => {
  assert.deepEqual(mcp.mcpServers.driggsby, {
    command: "npx",
    args: ["--prefix", "${CLAUDE_PLUGIN_DATA}", "-y", `driggsby@${VERSION}`, "channel"],
  });
});
