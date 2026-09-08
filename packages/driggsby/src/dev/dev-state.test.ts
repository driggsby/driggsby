import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
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
  readLiveDevState,
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

  assert.equal(devStatePath(home), join(home, ".driggsby", "dev.json"));
  assert.deepEqual(await readLiveDevState(home, servedBy(process.pid)), sampleState(process.pid));
  if (process.platform !== "win32") {
    assert.equal((await stat(devStatePath(home))).mode & 0o777, 0o600);
  }
});

test("a state file naming a dead process is stale: read as nothing and removed", async () => {
  const home = await mkdtemp(join(tmpdir(), "driggsby-home-"));
  await writeDevState(home, sampleState(4242));

  assert.equal(await readLiveDevState(home, { isAlive: () => false, pidServing: () => Promise.resolve(4242) }), null);
  await assert.rejects(readFile(devStatePath(home)));
});

test("a live pid whose port is not served by it reads as nothing, and the record survives", async () => {
  const home = await mkdtemp(join(tmpdir(), "driggsby-home-"));
  await writeDevState(home, sampleState(4242));

  // Nothing answering may be a busy dev; something else answering is a
  // recycled pid. Neither is ours to signal, and neither may erase the
  // record of a dev that might still be running.
  const nobodyServing: DevProbes = { isAlive: () => true, pidServing: () => Promise.resolve(null) };
  assert.equal(await readLiveDevState(home, nobodyServing), null);
  const anotherPidServing: DevProbes = { isAlive: () => true, pidServing: () => Promise.resolve(9999) };
  assert.equal(await readLiveDevState(home, anotherPidServing), null);
  assert.deepEqual(await readLiveDevState(home, servedBy(4242)), sampleState(4242));
});

test("a missing, malformed, or non-positive-pid state file reads as nothing", async () => {
  const home = await mkdtemp(join(tmpdir(), "driggsby-home-"));
  assert.equal(await readLiveDevState(home, servedBy(process.pid)), null);

  await writeDevState(home, sampleState(process.pid));
  await writeFile(devStatePath(home), "{not json");
  assert.equal(await readLiveDevState(home, servedBy(process.pid)), null);

  // pid 0 and negatives name process groups to kill(2); never a dev.
  for (const pid of [0, -1]) {
    await writeFile(devStatePath(home), JSON.stringify(sampleState(pid)));
    assert.equal(await readLiveDevState(home, servedBy(pid)), null);
  }
});

test("removal is scoped to the pid that wrote the file", async () => {
  const home = await mkdtemp(join(tmpdir(), "driggsby-home-"));
  await writeDevState(home, sampleState(process.pid));

  await removeDevState(home, process.pid + 1);
  assert.deepEqual(await readLiveDevState(home, servedBy(process.pid)), sampleState(process.pid));

  await removeDevState(home, process.pid);
  assert.equal(await readLiveDevState(home, servedBy(process.pid)), null);
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
