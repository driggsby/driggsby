import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { CliError } from "../cli-error.ts";
import { capturedOut } from "../deploy/test-support/deploy-command-harness.ts";
import { assertFitsTerminal } from "../test-support/terminal-width.ts";
import { readLiveDevState, writeDevState } from "./dev-state.ts";
import { runDevStop } from "./dev-stop.ts";

async function home(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "driggsby-home-"));
}

test("stop with nothing running says so and points at dev", async () => {
  const io = capturedOut();
  const code = await runDevStop(await home(), io, { isAlive: () => false, terminate: () => undefined, waitMs: 10 });

  assert.equal(code, 0);
  assert.ok(io.text().includes("No driggsby dev is running on this machine."));
  assert.ok(io.text().includes("npx driggsby@latest dev"));
  assertFitsTerminal(io.text());
});

test("stop terminates the running dev, waits for it to go, and removes its state", async () => {
  const homeDirectory = await home();
  await writeDevState(homeDirectory, {
    pid: 4242, folder: "/Users/someone/money-dash", startedAt: "2026-09-08T01:02:03.000Z", hostPort: 4111, appPort: 4112,
  });
  const terminated: number[] = [];
  let probes = 0;
  const io = capturedOut();

  const code = await runDevStop(homeDirectory, io, {
    // Alive until the signal has been sent and two probes have passed.
    isAlive: () => {
      probes += 1;
      return terminated.length === 0 || probes < 3;
    },
    terminate: (pid) => {
      terminated.push(pid);
    },
    waitMs: 10,
  });

  assert.equal(code, 0);
  assert.deepEqual(terminated, [4242]);
  assert.ok(io.text().includes("✓ Stopped   driggsby dev for the app in:\n  \"/Users/someone/money-dash\""));
  assert.ok(io.text().includes("npx driggsby@latest dev"));
  assert.equal(await readLiveDevState(homeDirectory), null);
  assertFitsTerminal(io.text());
});

test("a dev that ignores the signal is reported, not hidden", async () => {
  const homeDirectory = await home();
  await writeDevState(homeDirectory, {
    pid: 4343, folder: "/tmp/stubborn", startedAt: "2026-09-08T01:02:03.000Z", hostPort: 4111, appPort: 4112,
  });

  await assert.rejects(
    runDevStop(await Promise.resolve(homeDirectory), capturedOut(), {
      isAlive: () => true,
      terminate: () => undefined,
      waitMs: 10,
    }),
    (error: unknown) => error instanceof CliError && error.exitCode === 1 && error.message.includes("Ctrl+C"),
  );
});
