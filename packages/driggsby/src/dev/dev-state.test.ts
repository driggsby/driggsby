import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

import {
  DEV_IDENTITY_PATH,
  devPidServing,
  type DevProbes,
  devStatePath,
  type DevState,
  processIsAlive,
  pruneDevStatesForPorts,
  readDevStates,
  readLiveDevStates,
  removeDevState,
  writeDevState,
} from "./dev-state.ts";

function sampleState(pid: number): DevState {
  return { pid, folder: "/tmp/money-dash", startedAt: "2026-09-08T01:02:03.000Z", hostPort: 4111, appPort: 4112 };
}

// Probes that say the recorded pid is alive and is the one serving the port.
function servedBy(pid: number): DevProbes {
  return { isAlive: (candidate) => candidate === pid, pidServing: () => Promise.resolve(pid) };
}

test("the state file round-trips, sits under ~/.driggsby, and is owner-only", async () => {
  const home = await mkdtemp(join(tmpdir(), "driggsby-home-"));
  await writeDevState(home, sampleState(process.pid));

  assert.equal(devStatePath(home, process.pid), join(home, ".driggsby", `dev-${String(process.pid)}.json`));
  assert.deepEqual(await readLiveDevStates(home, servedBy(process.pid)), [sampleState(process.pid)]);
  if (process.platform !== "win32") {
    assert.equal((await stat(devStatePath(home, process.pid))).mode & 0o777, 0o600);
  }
});

test("a state file naming a dead process is stale: read as nothing and removed", async () => {
  const home = await mkdtemp(join(tmpdir(), "driggsby-home-"));
  await writeDevState(home, sampleState(4242));

  assert.deepEqual(await readLiveDevStates(home, { isAlive: () => false, pidServing: () => Promise.resolve(4242) }), []);
  await assert.rejects(readFile(devStatePath(home, 4242)));
});

test("two previews keep two records, each read and removed on its own", async () => {
  const home = await mkdtemp(join(tmpdir(), "driggsby-home-"));
  const first = { ...sampleState(4242), folder: "/tmp/first", hostPort: 4111, appPort: 4112 };
  const second = { ...sampleState(4343), folder: "/tmp/second", hostPort: 4113, appPort: 4114 };
  await writeDevState(home, first);
  await writeDevState(home, second);
  const byPort: Record<number, number> = { 4111: 4242, 4113: 4343 };
  const probes: DevProbes = {
    isAlive: (pid) => pid === 4242 || pid === 4343,
    pidServing: (port) => Promise.resolve(byPort[port] ?? null),
  };

  const both = await readLiveDevStates(home, probes);
  assert.deepEqual(both.map((state) => state.folder).sort(), ["/tmp/first", "/tmp/second"]);

  await removeDevState(home, 4242);
  assert.deepEqual(await readLiveDevStates(home, probes), [second]);
});

test("a record whose port answers as a different dev is a leftover: removed", async () => {
  const home = await mkdtemp(join(tmpdir(), "driggsby-home-"));
  await writeDevState(home, sampleState(4242));
  // The pid is alive (the OS reused it), but port 4111 now belongs to
  // another dev, so this record's dev is not there.
  const probes: DevProbes = { isAlive: () => true, pidServing: () => Promise.resolve(4343) };

  assert.deepEqual(await readDevStates(home, probes), []);
  await assert.rejects(readFile(devStatePath(home, 4242)));
});

test("a dev that has bound its ports clears other records naming them", async () => {
  const home = await mkdtemp(join(tmpdir(), "driggsby-home-"));
  await writeDevState(home, { ...sampleState(4242), hostPort: 4111, appPort: 4112 });
  await writeDevState(home, { ...sampleState(4343), hostPort: 4113, appPort: 4114 });
  await writeDevState(home, { ...sampleState(4444), hostPort: 4115, appPort: 4111 });
  await writeFile(join(home, ".driggsby", "dev.json"), JSON.stringify({ ...sampleState(4545), hostPort: 4112, appPort: 4199 }));

  await pruneDevStatesForPorts(home, 5000, 4111, 4112);

  await assert.rejects(readFile(devStatePath(home, 4242)));
  await assert.rejects(readFile(devStatePath(home, 4444)));
  await assert.rejects(readFile(join(home, ".driggsby", "dev.json")));
  assert.ok((await readFile(devStatePath(home, 4343), "utf8")).includes("4343"));
});

test("an entry named like a record that is not a regular file is skipped, never fatal", async () => {
  const home = await mkdtemp(join(tmpdir(), "driggsby-home-"));
  await writeDevState(home, sampleState(4343));
  await mkdir(devStatePath(home, 4242));

  assert.deepEqual(await readLiveDevStates(home, servedBy(4343)), [sampleState(4343)]);
  assert.ok((await stat(devStatePath(home, 4242))).isDirectory());
});

test("a folder filter probes only that folder's records", async () => {
  const home = await mkdtemp(join(tmpdir(), "driggsby-home-"));
  await writeDevState(home, { ...sampleState(4242), folder: "/tmp/first", hostPort: 4111 });
  await writeDevState(home, { ...sampleState(4343), folder: "/tmp/second", hostPort: 4113 });
  const probed: number[] = [];
  const probes: DevProbes = {
    isAlive: () => true,
    pidServing: (port) => {
      probed.push(port);
      return Promise.resolve(port === 4111 ? 4242 : 4343);
    },
  };

  const reads = await readDevStates(home, probes, "/tmp/first");
  assert.deepEqual(reads.map((read) => read.state.folder), ["/tmp/first"]);
  assert.deepEqual(probed, [4111]);
});

test("a record an earlier version wrote to dev.json is still read and removed", async () => {
  const home = await mkdtemp(join(tmpdir(), "driggsby-home-"));
  await writeDevState(home, sampleState(4242));
  const legacy = join(home, ".driggsby", "dev.json");
  await writeFile(legacy, JSON.stringify(sampleState(4545)));
  const probes: DevProbes = { isAlive: () => true, pidServing: (port) => Promise.resolve(port === 4111 ? 4545 : null) };

  // Both records name port 4111 here, and it answers as the legacy pid, so
  // the other record is a leftover and is removed.
  assert.deepEqual(await readLiveDevStates(home, probes), [sampleState(4545)]);
  await removeDevState(home, 4545);
  await assert.rejects(readFile(legacy));
});

test("a record whose file name and pid disagree is not ours: read as nothing and removed", async () => {
  const home = await mkdtemp(join(tmpdir(), "driggsby-home-"));
  const mislabeled = devStatePath(home, 4242);
  await writeDevState(home, sampleState(4343));
  await writeFile(mislabeled, JSON.stringify(sampleState(4343)));

  assert.deepEqual(await readLiveDevStates(home, servedBy(4343)), [sampleState(4343)]);
  await assert.rejects(readFile(mislabeled));
});

test("a live pid whose port does not answer reads as not live, and the record survives", async () => {
  const home = await mkdtemp(join(tmpdir(), "driggsby-home-"));
  await writeDevState(home, sampleState(4242));

  // Nothing answering may be a busy dev: not ours to signal, and its record
  // must survive so it can still be stopped once it answers. (A port that
  // answers as another dev is a leftover; see below.)
  const nobodyServing: DevProbes = { isAlive: () => true, pidServing: () => Promise.resolve(null) };
  assert.deepEqual(await readLiveDevStates(home, nobodyServing), []);
  assert.deepEqual(await readLiveDevStates(home, servedBy(4242)), [sampleState(4242)]);
});

test("a missing, malformed, or non-positive-pid state file reads as nothing", async () => {
  const home = await mkdtemp(join(tmpdir(), "driggsby-home-"));
  assert.deepEqual(await readLiveDevStates(home, servedBy(process.pid)), []);

  await writeDevState(home, sampleState(process.pid));
  await writeFile(devStatePath(home, process.pid), "{not json");
  assert.deepEqual(await readLiveDevStates(home, servedBy(process.pid)), []);
  await assert.rejects(readFile(devStatePath(home, process.pid)));

  // pid 0 and negatives name process groups to kill(2); never a dev.
  for (const pid of [0, -1]) {
    await writeFile(devStatePath(home, process.pid), JSON.stringify(sampleState(pid)));
    assert.deepEqual(await readLiveDevStates(home, servedBy(pid)), []);
  }
});

test("a record with a relative folder is malformed: read as nothing and removed", async () => {
  const home = await mkdtemp(join(tmpdir(), "driggsby-home-"));
  await mkdir(join(home, ".driggsby"));
  await writeFile(devStatePath(home, 4242), JSON.stringify({ ...sampleState(4242), folder: "." }), { mode: 0o600 });

  assert.deepEqual(await readDevStates(home, servedBy(4242), process.cwd()), []);
  await assert.rejects(readFile(devStatePath(home, 4242)));
});

test("removal is scoped to the pid that wrote the file", async () => {
  const home = await mkdtemp(join(tmpdir(), "driggsby-home-"));
  await writeDevState(home, sampleState(process.pid));

  await removeDevState(home, process.pid + 1);
  assert.deepEqual(await readLiveDevStates(home, servedBy(process.pid)), [sampleState(process.pid)]);

  await removeDevState(home, process.pid);
  assert.deepEqual(await readLiveDevStates(home, servedBy(process.pid)), []);
});

test("the identity probe reads the pid a dev host answers with, and nothing else", async () => {
  const server = createServer((request, response) => {
    if (request.url === DEV_IDENTITY_PATH) {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ pid: 4242 }));
      return;
    }
    response.writeHead(404);
    response.end();
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address !== null && typeof address !== "string");
  try {
    assert.equal(await devPidServing(address.port), 4242);
  } finally {
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
  }
  // A closed port answers nothing.
  assert.equal(await devPidServing(address.port), null);
});

test("the identity probe refuses an oversized body from whatever holds the port", async () => {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(`{"pid":4242,"padding":"${"x".repeat(10_000)}"}`);
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address !== null && typeof address !== "string");
  try {
    assert.equal(await devPidServing(address.port), null);
  } finally {
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
  }
});

test("the identity probe gives up on a port that dribbles bytes without ever finishing", async () => {
  const timers: NodeJS.Timeout[] = [];
  const server = createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "application/json" });
    // Each write lands inside the socket's inactivity timeout, so only a
    // whole-probe deadline can end this.
    timers.push(
      setInterval(() => {
        response.write(" ");
      }, 500),
    );
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address !== null && typeof address !== "string");
  try {
    const startedAt = Date.now();
    assert.equal(await devPidServing(address.port), null);
    assert.ok(Date.now() - startedAt < 10_000);
  } finally {
    for (const timer of timers) clearInterval(timer);
    server.closeAllConnections();
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
  }
});

test("liveness: this process is alive, an absurd pid is not", () => {
  assert.equal(processIsAlive(process.pid), true);
  assert.equal(processIsAlive(2_147_483_646), false);
});

// Node reads NODE_USE_ENV_PROXY at startup, so the proxy case runs in a
// child: with a proxy named in the environment, the probe must still reach
// the loopback dev and never the proxy.
test("the identity probe ignores a proxy named in the environment", async () => {
  // A file URL, not a path: on Windows an absolute path is not importable.
  const devStateUrl = new URL("./dev-state.ts", import.meta.url).href;
  const script = `
    import { createServer } from "node:http";
    import { DEV_IDENTITY_PATH, devPidServing } from ${JSON.stringify(devStateUrl)};
    const server = createServer((request, response) => {
      response.writeHead(request.url === DEV_IDENTITY_PATH ? 200 : 404, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ pid: 4242 }));
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    process.stdout.write(String(await devPidServing(server.address().port)));
    server.close();
  `;
  const { stdout } = await promisify(execFile)(
    process.execPath,
    ["--no-warnings", "--input-type=module", "-e", script],
    {
      env: { ...process.env, NODE_USE_ENV_PROXY: "1", HTTP_PROXY: "http://127.0.0.1:1", http_proxy: "http://127.0.0.1:1" },
      // A probe that never resolves must fail the build, not hang it.
      timeout: 15_000,
    },
  );
  assert.equal(stdout, "4242");
});
