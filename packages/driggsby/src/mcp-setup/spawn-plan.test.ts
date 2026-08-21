import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";

import { quoteForCmd, resolveWindowsProgram, type WindowsLookup } from "./spawn-plan.ts";

function lookupWith(directories: string[], existing: string[]): WindowsLookup {
  const files = new Set(existing);
  return {
    // Windows PATHs always join with ";".
    path: directories.join(";"),
    pathext: ".COM;.EXE;.BAT;.CMD",
    exists: (candidate) => files.has(candidate),
  };
}

test("quoteForCmd passes plain constants (including the MCP URL) through unquoted", () => {
  assert.equal(quoteForCmd("driggsby"), "driggsby");
  assert.equal(quoteForCmd("https://app.driggsby.com/mcp"), "https://app.driggsby.com/mcp");
  assert.equal(quoteForCmd("--transport"), "--transport");
});

test("quoteForCmd wraps paths with spaces and doubles embedded quotes", () => {
  assert.equal(quoteForCmd("C:\\Program Files\\nodejs\\claude.cmd"), '"C:\\Program Files\\nodejs\\claude.cmd"');
  assert.equal(quoteForCmd('say "hi"'), '"say ""hi"""');
});

test("quoteForCmd doubles trailing backslashes so they cannot escape the closing quote", () => {
  assert.equal(quoteForCmd("C:\\dir name\\"), '"C:\\dir name\\\\"');
});

test("resolveWindowsProgram walks PATH with PATHEXT and classifies shims", () => {
  const npmDirectory = "C:\\Users\\First Last\\AppData\\Roaming\\npm";
  const lookup = lookupWith(
    ["C:\\Windows\\System32", npmDirectory],
    [join(npmDirectory, "claude.CMD")],
  );

  const resolved = resolveWindowsProgram("claude", lookup);
  assert.deepEqual(resolved, { kind: "shim", path: join(npmDirectory, "claude.CMD") });
});

test("resolveWindowsProgram classifies .exe as direct and misses as null", () => {
  const directory = "C:\\Tools";
  const lookup = lookupWith([directory], [join(directory, "codex.EXE")]);

  assert.deepEqual(resolveWindowsProgram("codex", lookup), {
    kind: "direct",
    path: join(directory, "codex.EXE"),
  });
  assert.equal(resolveWindowsProgram("claude", lookup), null);
});

test("resolveWindowsProgram strips quotes from quoted PATH segments", () => {
  const directory = "C:\\Quoted Dir";
  const lookup = lookupWith([`"${directory}"`], [join(directory, "claude.CMD")]);

  assert.deepEqual(resolveWindowsProgram("claude", lookup), {
    kind: "shim",
    path: join(directory, "claude.CMD"),
  });
});

test("resolveWindowsProgram uses an explicit path as given", () => {
  const explicit = join("C:\\Tools", "claude.cmd");
  const lookup: WindowsLookup = { path: "", pathext: ".CMD", exists: (c) => c === explicit };

  assert.deepEqual(resolveWindowsProgram(explicit, lookup), { kind: "shim", path: explicit });
  assert.equal(resolveWindowsProgram(join("C:\\Tools", "missing.cmd"), lookup), null);
});
