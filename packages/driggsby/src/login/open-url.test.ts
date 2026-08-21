import assert from "node:assert/strict";
import { test } from "node:test";

import { openUrlSpawnPlan } from "./open-url.ts";

test("each platform opens URLs with its own opener, without a shell on POSIX", () => {
  assert.deepEqual(openUrlSpawnPlan("https://app.driggsby.example/connect/abc", "darwin"), {
    // Absolute, so a PATH-planted "open" can never receive the URL.
    program: "/usr/bin/open",
    args: ["https://app.driggsby.example/connect/abc"],
    windowsVerbatimArguments: false,
  });
  assert.deepEqual(openUrlSpawnPlan("https://app.driggsby.example/connect/abc", "linux"), {
    program: "xdg-open",
    args: ["https://app.driggsby.example/connect/abc"],
    windowsVerbatimArguments: false,
  });
});

test("windows routes through an absolute cmd.exe start with quoting", () => {
  const plan = openUrlSpawnPlan(
    "https://app.driggsby.example/connect/abc",
    "win32",
    "C:\\Windows",
  );
  assert.ok(plan !== null);
  assert.equal(plan.program, "C:\\Windows\\System32\\cmd.exe");
  assert.equal(plan.windowsVerbatimArguments, true);
  assert.deepEqual(plan.args.slice(0, 3), ["/d", "/s", "/c"]);
  assert.ok(plan.args[3]?.includes("start"));
  assert.ok(plan.args[3]?.includes("https://app.driggsby.example/connect/abc"));
});

test("only https URLs (or local http for dev overrides) are openable", () => {
  assert.equal(openUrlSpawnPlan("http://app.driggsby.example/connect/abc", "darwin"), null);
  assert.notEqual(openUrlSpawnPlan("http://127.0.0.1:3100/connect/abc", "darwin"), null);
  assert.notEqual(openUrlSpawnPlan("http://localhost:3100/connect/abc", "darwin"), null);
  assert.equal(openUrlSpawnPlan("javascript:alert(1)", "darwin"), null);
  // `%` and `!` are cmd.exe expansion triggers; URLs carrying either are
  // printed but never handed to any opener, on every platform.
  assert.equal(openUrlSpawnPlan("https://app.driggsby.example/a%41b", "darwin"), null);
  assert.equal(openUrlSpawnPlan("https://app.driggsby.example/a!b", "darwin"), null);
  assert.equal(openUrlSpawnPlan("file:///etc/passwd", "darwin"), null);
  assert.equal(openUrlSpawnPlan("not a url", "darwin"), null);
});

test("URLs containing % or other unexpected characters are never opened", () => {
  // cmd.exe expands %VAR% even inside quotes, so a %-bearing URL could carry
  // environment values to the opened page. Claim URLs never contain them.
  assert.equal(
    openUrlSpawnPlan("https://app.driggsby.example/connect/x?d=%USERPROFILE%", "win32"),
    null,
  );
  assert.equal(openUrlSpawnPlan("https://app.driggsby.example/connect/%41", "darwin"), null);
  assert.equal(openUrlSpawnPlan('https://app.driggsby.example/connect/"quoted"', "win32"), null);
});
