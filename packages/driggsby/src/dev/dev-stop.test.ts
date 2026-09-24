import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { CliError } from "../cli-error.ts";
import { capturedOut } from "../deploy/test-support/deploy-command-harness.ts";
import { assertFitsTerminal } from "../test-support/terminal-width.ts";
import { type DevProbes, readLiveDevStates, writeDevState } from "./dev-state.ts";
import { runDevStop } from "./dev-stop.ts";

// A folder with no app in it or above it.
const NOT_AN_APP = "/Users/someone/elsewhere";

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

  // Run from a folder that is not the app's: with one dev running, stop
  // still finds it from any terminal.
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
  }, NOT_AN_APP);

  assert.equal(code, 0);
  assert.deepEqual(terminated, [4242]);
  assert.ok(io.text().includes("✓ Stopped   driggsby dev for the app in:\n  \"/Users/someone/money-dash\""));
  assert.ok(io.text().includes("npx driggsby@latest dev"));
  assert.deepEqual(await readLiveDevStates(homeDirectory, alwaysServed(4242)), []);
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
    }, NOT_AN_APP),
    (error: unknown) => {
      assert.ok(error instanceof CliError);
      assert.equal(error.exitCode, 1);
      assert.ok(error.message.startsWith("driggsby dev is recorded for the app in:\n"));
      assert.ok(error.message.includes("but didn't answer, so it wasn't stopped."));
      assert.ok(error.message.includes("then try again:\n  npx driggsby@latest dev --stop\n"));
      assert.ok(error.message.endsWith("the record is a leftover."));
      assert.ok(!error.message.includes("No driggsby dev is running"));
      assert.ok(error.message.split("\n").every((line) => line.length <= 80));
      return true;
    },
  );
  assert.deepEqual(terminated, []);
  // The record stays: the pid is alive, so it may be a dev that was busy.
  assert.equal((await readLiveDevStates(homeDirectory, alwaysServed(4242))).length, 1);
});

test("a pid that vanished before the signal says so and drops its record", async () => {
  const homeDirectory = await home();
  await writeDevState(homeDirectory, {
    pid: 4242, folder: "/tmp/gone", startedAt: "2026-09-08T01:02:03.000Z", hostPort: 4111, appPort: 4112,
  });
  const io = capturedOut();
  const exit = await runDevStop(homeDirectory, io, {
    ...alwaysServed(4242),
    terminate: () => {
      throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
    },
    waitMs: 10,
  }, NOT_AN_APP);
  assert.equal(exit, 0);
  assert.ok(io.text().includes("driggsby dev had already stopped for the app in:\n  \"/tmp/gone\""));
  assert.deepEqual(await readLiveDevStates(homeDirectory, alwaysServed(4242)), []);
});

test("a running dev this process may not signal, or any other failure, keeps its record", async () => {
  // EPERM: the port vouched for it, so it is running (a sandboxed agent may
  // not signal outside its sandbox); the person is told where to stop it.
  for (const code of ["EPERM", "EINVAL"]) {
    const homeDirectory = await home();
    await writeDevState(homeDirectory, {
      pid: 4242, folder: "/tmp/held", startedAt: "2026-09-08T01:02:03.000Z", hostPort: 4111, appPort: 4112,
    });
    await assert.rejects(
      runDevStop(homeDirectory, capturedOut(), {
        ...alwaysServed(4242),
        terminate: () => {
          throw Object.assign(new Error(code), { code });
        },
        waitMs: 10,
      }, NOT_AN_APP),
      (error: unknown) => {
        if (code === "EPERM") {
          assert.ok(error instanceof CliError);
          assert.equal(error.exitCode, 1);
          assert.ok(error.message.includes("isn't allowed to be stopped from here"));
          assert.ok(!error.message.includes("No driggsby dev is running"));
          assertFitsTerminal(error.message);
        } else {
          assert.match(String(error), /EINVAL/);
        }
        return true;
      },
    );
    assert.equal((await readLiveDevStates(homeDirectory, alwaysServed(4242))).length, 1);
  }
});

test("a dev whose port stops vouching for it before the signal is never signalled", async () => {
  const homeDirectory = await home();
  await writeDevState(homeDirectory, {
    pid: 4242, folder: "/tmp/quick", startedAt: "2026-09-08T01:02:03.000Z", hostPort: 4111, appPort: 4112,
  });
  const terminated: number[] = [];
  let asked = 0;

  await assert.rejects(
    runDevStop(homeDirectory, capturedOut(), {
      isAlive: () => true,
      // Serving when the records are read, gone by the second ask.
      pidServing: () => {
        asked += 1;
        return Promise.resolve(asked === 1 ? 4242 : null);
      },
      terminate: (pid) => {
        terminated.push(pid);
      },
      waitMs: 10,
    }, NOT_AN_APP),
    (error: unknown) => error instanceof CliError && error.message.includes("didn't answer, so it wasn't stopped"),
  );
  assert.equal(asked, 2);
  assert.deepEqual(terminated, []);
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
    }, NOT_AN_APP),
    (error: unknown) => error instanceof CliError && error.exitCode === 1 && error.message.includes("Ctrl+C"),
  );
});

// Two previews at once, each in a real app folder: 4242 for a on 4111,
// 4343 for b on 4113.
async function twoRunning(): Promise<{ homeDirectory: string; a: string; b: string; probes: DevProbes }> {
  const homeDirectory = await home();
  const a = await anApp();
  const b = await anApp();
  await writeDevState(homeDirectory, {
    pid: 4242, folder: a, startedAt: "2026-09-08T01:02:03.000Z", hostPort: 4111, appPort: 4112,
  });
  await writeDevState(homeDirectory, {
    pid: 4343, folder: b, startedAt: "2026-09-08T01:02:04.000Z", hostPort: 4113, appPort: 4114,
  });
  const byPort: Record<number, number> = { 4111: 4242, 4113: 4343 };
  return { homeDirectory, a, b, probes: { isAlive: () => true, pidServing: (port) => Promise.resolve(byPort[port] ?? null) } };
}

test("with two running, stop in one app's folder stops only that one", async () => {
  const { homeDirectory, a, b, probes } = await twoRunning();
  const terminated: number[] = [];
  const io = capturedOut();

  const code = await runDevStop(homeDirectory, io, {
    ...probes,
    isAlive: (pid) => !terminated.includes(pid),
    terminate: (pid) => {
      terminated.push(pid);
    },
    waitMs: 10,
  }, b);

  assert.equal(code, 0);
  assert.deepEqual(terminated, [4343]);
  assert.ok(io.text().includes(`✓ Stopped   driggsby dev for the app in:\n  "${b}"`));
  const left = await readLiveDevStates(homeDirectory, probes);
  assert.deepEqual(left.map((state) => state.folder), [a]);
});

test("with two running and neither here, nothing is stopped and both are named", async () => {
  const { homeDirectory, a, b, probes } = await twoRunning();
  const terminated: number[] = [];

  await assert.rejects(
    runDevStop(homeDirectory, capturedOut(), {
      ...probes,
      terminate: (pid) => {
        terminated.push(pid);
      },
      waitMs: 10,
    }, NOT_AN_APP),
    (error: unknown) => {
      assert.ok(error instanceof CliError);
      assert.equal(error.exitCode, 1);
      assert.ok(error.message.startsWith("driggsby dev is running for more than one app, in:\n"));
      assert.ok(error.message.includes(`"${a}"`));
      assert.ok(error.message.includes(`"${b}"`));
      assert.ok(error.message.includes("npx driggsby@latest dev --stop"));
      assertFitsTerminal(error.message);
      return true;
    },
  );
  assert.deepEqual(terminated, []);
});

test("a leftover record for this folder never hides the folder's live preview", async () => {
  const homeDirectory = await home();
  const appFolder = await anApp();
  // 1111 died without cleanup and its pid was reused; its port is held by
  // something that is not a dev. 2222 is the preview running now.
  await writeDevState(homeDirectory, {
    pid: 1111, folder: appFolder, startedAt: "2026-09-08T01:00:00.000Z", hostPort: 4111, appPort: 4112,
  });
  await writeDevState(homeDirectory, {
    pid: 2222, folder: appFolder, startedAt: "2026-09-08T02:00:00.000Z", hostPort: 4113, appPort: 4114,
  });
  const terminated: number[] = [];

  const code = await runDevStop(homeDirectory, capturedOut(), {
    isAlive: (pid) => !terminated.includes(pid),
    pidServing: (port) => Promise.resolve(port === 4113 ? 2222 : null),
    terminate: (pid) => {
      terminated.push(pid);
    },
    waitMs: 10,
  }, appFolder);

  assert.equal(code, 0);
  assert.deepEqual(terminated, [2222]);
});

test("in an app folder with no preview of its own, stop stops nothing and says so", async () => {
  const homeDirectory = await home();
  const appFolder = await anApp();
  await writeDevState(homeDirectory, {
    pid: 4343, folder: "/Users/someone/b", startedAt: "2026-09-08T01:02:04.000Z", hostPort: 4113, appPort: 4114,
  });
  const terminated: number[] = [];
  const io = capturedOut();

  // Another agent's preview is the only one running: an agent tidying up
  // in its own app's folder must not stop it.
  const code = await runDevStop(homeDirectory, io, {
    ...alwaysServed(4343),
    terminate: (pid) => {
      terminated.push(pid);
    },
    waitMs: 10,
  }, appFolder);

  assert.equal(code, 0);
  assert.deepEqual(terminated, []);
  assert.ok(io.text().includes("No driggsby dev is running for this app."));
  assert.ok(io.text().includes("\"/Users/someone/b\""));
  assertFitsTerminal(io.text());
});

test("in an app whose own preview doesn't answer, nothing is signalled and another app's is left running", async () => {
  const { homeDirectory, a } = await twoRunning();
  const terminated: number[] = [];

  await assert.rejects(
    runDevStop(homeDirectory, capturedOut(), {
      // a's port has stopped answering; b's still answers.
      isAlive: () => true,
      pidServing: (port) => Promise.resolve(port === 4113 ? 4343 : null),
      terminate: (pid) => {
        terminated.push(pid);
      },
      waitMs: 10,
    }, a),
    (error: unknown) => error instanceof CliError && error.message.includes("didn't answer, so it wasn't stopped"),
  );
  assert.deepEqual(terminated, []);
});

test("in a subfolder of an app, stop finds that app's preview", async () => {
  const homeDirectory = await home();
  const appFolder = await anApp();
  await mkdir(join(appFolder, "src", "charts"), { recursive: true });
  await writeDevState(homeDirectory, {
    pid: 4242, folder: appFolder, startedAt: "2026-09-08T01:02:03.000Z", hostPort: 4111, appPort: 4112,
  });
  const terminated: number[] = [];

  const code = await runDevStop(homeDirectory, capturedOut(), {
    ...alwaysServed(4242),
    isAlive: (pid) => !terminated.includes(pid),
    terminate: (pid) => {
      terminated.push(pid);
    },
    waitMs: 10,
  }, join(appFolder, "src", "charts"));

  assert.equal(code, 0);
  assert.deepEqual(terminated, [4242]);
});

test("in a subfolder of an app with no preview of its own, another app's preview is left running", async () => {
  const homeDirectory = await home();
  const appFolder = await anApp();
  await mkdir(join(appFolder, "src"));
  await writeDevState(homeDirectory, {
    pid: 4343, folder: "/Users/someone/b", startedAt: "2026-09-08T01:02:04.000Z", hostPort: 4113, appPort: 4114,
  });
  const terminated: number[] = [];
  const io = capturedOut();

  const code = await runDevStop(homeDirectory, io, {
    ...alwaysServed(4343),
    terminate: (pid) => {
      terminated.push(pid);
    },
    waitMs: 10,
  }, join(appFolder, "src"));

  assert.equal(code, 0);
  assert.deepEqual(terminated, []);
  assert.ok(io.text().includes("No driggsby dev is running for this app."));
});

test("outside any app, the one live preview is stopped past a leftover that doesn't answer", async () => {
  const homeDirectory = await home();
  await writeDevState(homeDirectory, {
    pid: 1111, folder: "/Users/someone/a", startedAt: "2026-09-08T01:00:00.000Z", hostPort: 4111, appPort: 4112,
  });
  await writeDevState(homeDirectory, {
    pid: 2222, folder: "/Users/someone/b", startedAt: "2026-09-08T02:00:00.000Z", hostPort: 4113, appPort: 4114,
  });
  const terminated: number[] = [];

  const code = await runDevStop(homeDirectory, capturedOut(), {
    isAlive: (pid) => !terminated.includes(pid),
    pidServing: (port) => Promise.resolve(port === 4113 ? 2222 : null),
    terminate: (pid) => {
      terminated.push(pid);
    },
    waitMs: 10,
  }, NOT_AN_APP);

  assert.equal(code, 0);
  assert.deepEqual(terminated, [2222]);
});

test("outside any app with only records that don't answer, one folder's is reported and several are named", async () => {
  const quiet: DevProbes = { isAlive: () => true, pidServing: () => Promise.resolve(null) };
  const stop = { ...quiet, terminate: () => undefined, waitMs: 10 };

  // Two leftovers for one folder read as that folder's, not "more than one app".
  const oneFolder = await home();
  await writeDevState(oneFolder, {
    pid: 1111, folder: "/Users/someone/a", startedAt: "2026-09-08T01:00:00.000Z", hostPort: 4111, appPort: 4112,
  });
  await writeDevState(oneFolder, {
    pid: 2222, folder: "/Users/someone/a", startedAt: "2026-09-08T02:00:00.000Z", hostPort: 4113, appPort: 4114,
  });
  await assert.rejects(
    runDevStop(oneFolder, capturedOut(), stop, NOT_AN_APP),
    (error: unknown) => error instanceof CliError && error.message.startsWith("driggsby dev is recorded for the app in:\n"),
  );

  const twoFolders = await home();
  await writeDevState(twoFolders, {
    pid: 1111, folder: "/Users/someone/a", startedAt: "2026-09-08T01:00:00.000Z", hostPort: 4111, appPort: 4112,
  });
  await writeDevState(twoFolders, {
    pid: 2222, folder: "/Users/someone/b", startedAt: "2026-09-08T02:00:00.000Z", hostPort: 4113, appPort: 4114,
  });
  await assert.rejects(
    runDevStop(twoFolders, capturedOut(), stop, NOT_AN_APP),
    (error: unknown) => {
      assert.ok(error instanceof CliError);
      assert.ok(error.message.startsWith("driggsby dev is recorded for more than one app, and none answered:\n"));
      assert.ok(error.message.includes("\"/Users/someone/a\" (not answering)"));
      assert.ok(error.message.includes("\"/Users/someone/b\" (not answering)"));
      assertFitsTerminal(error.message);
      return true;
    },
  );
});

async function anApp(): Promise<string> {
  const folder = await mkdtemp(join(tmpdir(), "driggsby-app-"));
  await writeFile(join(folder, "driggsby.json"), "{}");
  return folder;
}

function alwaysServed(pid: number): DevProbes {
  return { isAlive: () => true, pidServing: () => Promise.resolve(pid) };
}
