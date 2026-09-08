import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { CliError } from "../cli-error.ts";
import { capturedOut } from "../deploy/test-support/deploy-command-harness.ts";
import { assertFitsTerminal } from "../test-support/terminal-width.ts";
import { type DevProbes, readLiveDevState, writeDevState } from "./dev-state.ts";
import { runDevStop } from "./dev-stop.ts";

async function home(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "driggsby-home-"));
}

test("stop with nothing running says so and points at dev", async () => {
  const io = capturedOut();
  const code = await runDevStop(await home(), io, {
    isAlive: () => false, pidServing: () => Promise.resolve(null), terminate: () => undefined, waitMs: 10,
  });

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
    pidServing: () => Promise.resolve(4242),
    terminate: (pid) => {
      terminated.push(pid);
    },
    waitMs: 10,
  });

  assert.equal(code, 0);
  assert.deepEqual(terminated, [4242]);
  assert.ok(io.text().includes("✓ Stopped   driggsby dev for the app in:\n  \"/Users/someone/money-dash\""));
  assert.ok(io.text().includes("npx driggsby@latest dev"));
  assert.equal(await readLiveDevState(homeDirectory, alwaysServed(4242)), null);
  assertFitsTerminal(io.text());
});

test("a record whose port is not served by its pid is never signalled, and is reported as unconfirmed", async () => {
  const homeDirectory = await home();
  await writeDevState(homeDirectory, {
    pid: 4242, folder: "/Users/someone/money-dash", startedAt: "2026-09-08T01:02:03.000Z", hostPort: 4111, appPort: 4112,
  });
  const terminated: number[] = [];

  await assert.rejects(
    runDevStop(homeDirectory, capturedOut(), {
      isAlive: () => true,
      pidServing: () => Promise.resolve(null),
      terminate: (pid) => {
        terminated.push(pid);
      },
      waitMs: 10,
    }),
    (error: unknown) => {
      assert.ok(error instanceof CliError);
      assert.equal(error.exitCode, 1);
      assert.ok(error.message.startsWith("driggsby dev is recorded for the app in:\n"));
      assert.ok(error.message.includes("but didn't answer, so it wasn't stopped."));
      assert.ok(error.message.endsWith("  npx driggsby@latest dev --stop"));
      assert.ok(!error.message.includes("No driggsby dev is running"));
      assert.ok(error.message.split("\n").every((line) => line.length <= 80));
      return true;
    },
  );
  assert.deepEqual(terminated, []);
  // The record stays: the pid is alive, so it may be a dev that was busy.
  assert.notEqual(await readLiveDevState(homeDirectory, alwaysServed(4242)), null);
});

test("a pid that vanished or belongs to someone else reads as nothing running", async () => {
  for (const code of ["ESRCH", "EPERM"]) {
    const homeDirectory = await home();
    await writeDevState(homeDirectory, {
      pid: 4242, folder: "/tmp/gone", startedAt: "2026-09-08T01:02:03.000Z", hostPort: 4111, appPort: 4112,
    });
    const io = capturedOut();
    const exit = await runDevStop(homeDirectory, io, {
      ...alwaysServed(4242),
      terminate: () => {
        throw Object.assign(new Error(code), { code });
      },
      waitMs: 10,
    });
    assert.equal(exit, 0);
    assert.ok(io.text().includes("No driggsby dev is running on this machine."));
    assert.equal(await readLiveDevState(homeDirectory, alwaysServed(4242)), null);
  }
  // Any other signalling failure surfaces and keeps the record: the dev may
  // well still be running.
  const homeDirectory = await home();
  await writeDevState(homeDirectory, {
    pid: 4242, folder: "/tmp/odd", startedAt: "2026-09-08T01:02:03.000Z", hostPort: 4111, appPort: 4112,
  });
  await assert.rejects(
    runDevStop(homeDirectory, capturedOut(), {
      ...alwaysServed(4242),
      terminate: () => {
        throw Object.assign(new Error("EINVAL"), { code: "EINVAL" });
      },
      waitMs: 10,
    }),
    /EINVAL/,
  );
  assert.notEqual(await readLiveDevState(homeDirectory, alwaysServed(4242)), null);
});

test("a dev that ignores the signal is reported, not hidden", async () => {
  const homeDirectory = await home();
  await writeDevState(homeDirectory, {
    pid: 4343, folder: "/tmp/stubborn", startedAt: "2026-09-08T01:02:03.000Z", hostPort: 4111, appPort: 4112,
  });

  await assert.rejects(
    runDevStop(homeDirectory, capturedOut(), {
      ...alwaysServed(4343),
      terminate: () => undefined,
      waitMs: 10,
    }),
    (error: unknown) => error instanceof CliError && error.exitCode === 1 && error.message.includes("Ctrl+C"),
  );
});

function alwaysServed(pid: number): DevProbes {
  return { isAlive: () => true, pidServing: () => Promise.resolve(pid) };
}
