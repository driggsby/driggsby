import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";

import { planSpawn, quoteForCmd, resolveWindowsProgram, type WindowsLookup } from "./spawn-plan.ts";

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

test("planSpawn runs a shim through an absolute cmd.exe with /d /s /c and quoting", () => {
  const npmDirectory = "C:\\Users\\First Last\\AppData\\Roaming\\npm";
  const shim = join(npmDirectory, "claude.CMD");
  const lookup = lookupWith([npmDirectory], [shim]);

  const plan = planSpawn(
    { program: "claude", args: ["mcp", "get", "driggsby"] },
    "win32",
    lookup,
  );

  assert.ok(plan !== null);
  // Absolute path (SystemRoot fallback): a planted cmd.exe in the current
  // directory must never win.
  assert.ok(/[\\/]System32[\\/]cmd\.exe$/i.test(plan.program));
  assert.ok(plan.program !== "cmd.exe");
  assert.equal(plan.windowsVerbatimArguments, true);
  assert.equal(plan.args.length, 4);
  assert.deepEqual(plan.args.slice(0, 3), ["/d", "/s", "/c"]);
  // The command line is wrapped in one outer quote pair for /s, with the
  // spaced shim path quoted and plain args passed through.
  assert.equal(plan.args[3], `""${shim}" mcp get driggsby"`);
});

test("planSpawn passes POSIX and direct-executable commands through untouched", () => {
  const command = { program: "claude", args: ["mcp", "get", "driggsby"] };
  assert.deepEqual(planSpawn(command, "darwin"), {
    program: "claude",
    args: ["mcp", "get", "driggsby"],
    windowsVerbatimArguments: false,
  });

  const directory = "C:\\Tools";
  const lookup = lookupWith([directory], [join(directory, "claude.EXE")]);
  assert.deepEqual(planSpawn(command, "win32", lookup), {
    program: join(directory, "claude.EXE"),
    args: ["mcp", "get", "driggsby"],
    windowsVerbatimArguments: false,
  });
  assert.equal(planSpawn({ program: "missing", args: [] }, "win32", lookup), null);
});

test("resolveWindowsProgram uses an explicit path as given", () => {
  const explicit = join("C:\\Tools", "claude.cmd");
  const lookup: WindowsLookup = { path: "", pathext: ".CMD", exists: (c) => c === explicit };

  assert.deepEqual(resolveWindowsProgram(explicit, lookup), { kind: "shim", path: explicit });
  assert.equal(resolveWindowsProgram(join("C:\\Tools", "missing.cmd"), lookup), null);
});
