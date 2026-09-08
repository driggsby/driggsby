import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  devStatePath,
  type DevState,
  processIsAlive,
  readLiveDevState,
  removeDevState,
  writeDevState,
} from "./dev-state.ts";

function sampleState(pid: number): DevState {
  return { pid, folder: "/tmp/money-dash", startedAt: "2026-09-08T01:02:03.000Z", hostPort: 4111, appPort: 4112 };
}

test("the state file round-trips, sits under ~/.driggsby, and is owner-only", async () => {
  const home = await mkdtemp(join(tmpdir(), "driggsby-home-"));
  await writeDevState(home, sampleState(process.pid));

  assert.equal(devStatePath(home), join(home, ".driggsby", "dev.json"));
  assert.deepEqual(await readLiveDevState(home), sampleState(process.pid));
  if (process.platform !== "win32") {
    assert.equal((await stat(devStatePath(home))).mode & 0o777, 0o600);
  }
});

test("a state file naming a dead process is stale: read as nothing and removed", async () => {
  const home = await mkdtemp(join(tmpdir(), "driggsby-home-"));
  // A pid no process can hold for long; the liveness probe is what matters.
  await writeDevState(home, sampleState(2_147_483_646));

  assert.equal(await readLiveDevState(home), null);
  await assert.rejects(readFile(devStatePath(home)));
});

test("a missing or malformed state file reads as nothing", async () => {
  const home = await mkdtemp(join(tmpdir(), "driggsby-home-"));
  assert.equal(await readLiveDevState(home), null);

  await writeDevState(home, sampleState(process.pid));
  await writeFile(devStatePath(home), "{not json");
  assert.equal(await readLiveDevState(home), null);
});

test("removal is scoped to the pid that wrote the file", async () => {
  const home = await mkdtemp(join(tmpdir(), "driggsby-home-"));
  await writeDevState(home, sampleState(process.pid));

  await removeDevState(home, process.pid + 1);
  assert.deepEqual(await readLiveDevState(home), sampleState(process.pid));

  await removeDevState(home, process.pid);
  assert.equal(await readLiveDevState(home), null);
});

test("liveness: this process is alive, an absurd pid is not", () => {
  assert.equal(processIsAlive(process.pid), true);
  assert.equal(processIsAlive(2_147_483_646), false);
});
