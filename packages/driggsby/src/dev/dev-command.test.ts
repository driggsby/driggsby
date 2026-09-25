import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { test } from "node:test";

import { CliError } from "../cli-error.ts";
import {
  capturedOut,
  makeEnvironment,
  makeProject,
} from "../deploy/test-support/deploy-command-harness.ts";
import { startFakeMcp, successEnvelope } from "../test-support/fake-mcp.ts";
import { assertFitsTerminal } from "../test-support/terminal-width.ts";
import { type DevCommandIo, idleWindowWords, runDev } from "./dev-command.ts";
import { DEV_IDENTITY_PATH, type DevState, devStatePath, readLiveDevStates, writeDevState } from "./dev-state.ts";

// The dev loopback base URL keeps the saved-sign-in pin satisfied; nothing
// in these tests ever reaches it.
const LOOPBACK_BASE_URL = "http://127.0.0.1:9";

interface ProbeIo extends DevCommandIo {
  text: () => string;
  openedUrls: string[];
}

// An io whose shutdown waits until `probe` has run against the live servers.
function probingIo(probe: (openedUrl: string) => Promise<void>): ProbeIo {
  const captured = capturedOut();
  const openedUrls: string[] = [];
  let release: () => void = () => undefined;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    out: captured.out,
    text: captured.text,
    openedUrls,
    openUrl: async (url) => {
      openedUrls.push(url);
      // The servers are up once the CLI tries to open the page.
      await probe(url);
      release();
      return true;
    },
    waitForShutdown: () => released,
  };
}

test("dev serves the project and the host page end to end, then shuts down", async () => {
  const directory = await makeProject("money-dash", {
    "index.html": "<h1>the dev app</h1>",
  });
  const environment = await makeEnvironment(LOOPBACK_BASE_URL);

  let probedHostHtml = "";
  let probedAppHtml = "";
  const statesWhileRunning: DevState[] = [];
  const io = probingIo(async (openedUrl) => {
    statesWhileRunning.push(...(await readLiveDevStates(environment.homeDirectory)));
    const hostResponse = await fetch(openedUrl);
    probedHostHtml = await hostResponse.text();
    const appOriginMatch = /src="(http:\/\/127\.0\.0\.1:\d+)\//.exec(probedHostHtml);
    assert.ok(appOriginMatch !== null, "the host page must embed an app origin");
    const appResponse = await fetch(`${appOriginMatch[1] ?? ""}/`);
    probedAppHtml = await appResponse.text();
  });

  const exitCode = await runDev(
    { projectDirectory: directory, hostPort: 0, appPort: 0 },
    environment,
    io,
  );

  assert.equal(exitCode, 0);
  assert.equal(probedAppHtml, "<h1>the dev app</h1>");
  assert.ok(probedHostHtml.includes("money-dash"));
  const text = io.text();
  assert.ok(text.includes("✓ Ready     money-dash is running with your live Driggsby data"));
  // Both addresses are named, and the one to open comes first.
  const hostOrigin = io.openedUrls[0] ?? "";
  const appOrigin = /src="(http:\/\/127\.0\.0\.1:\d+)\//.exec(probedHostHtml)?.[1] ?? "";
  assert.ok(text.indexOf(hostOrigin) < text.indexOf(appOrigin));
  assert.ok(text.includes("no Driggsby data"));
  assert.ok(text.includes("npx driggsby@latest dev --stop"));
  assert.ok(text.includes("npx driggsby@latest deploy"));
  assertFitsTerminal(text);
  // The run recorded itself while alive and cleaned up on the way out.
  const stateWhileRunning = statesWhileRunning[0];
  assert.ok(stateWhileRunning !== undefined);
  assert.equal(stateWhileRunning.pid, process.pid);
  assert.equal(stateWhileRunning.folder, directory);
  assert.equal(stateWhileRunning.hostPort, Number(new URL(hostOrigin).port));
  assert.deepEqual(await readLiveDevStates(environment.homeDirectory), []);
});

test("each tool call the preview makes prints one line in the terminal", async () => {
  const fake = await startFakeMcp((body) => successEnvelope(body, { synthetic: true }));
  try {
    const directory = await makeProject("money-dash", { "index.html": "<h1>the dev app</h1>" });
    const environment = await makeEnvironment(fake.baseUrl);
    const io = probingIo(async (openedUrl) => {
      const response = await fetch(new URL("/tool-calls", openedUrl), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tool: "get_overview", arguments: {} }),
      });
      assert.deepEqual(await response.json(), { ok: true, result: { synthetic: true } });
    });

    assert.equal(await runDev({ projectDirectory: directory, hostPort: 0, appPort: 0 }, environment, io), 0);

    assert.match(io.text(), /^✓ get_overview \d+\.\d{2}s$/m);
  } finally {
    await fake.close();
  }
});

test("dev stops itself after the idle window with no page open", async () => {
  const directory = await makeProject("money-dash");
  const environment = await makeEnvironment(LOOPBACK_BASE_URL);
  const captured = capturedOut();
  const io: DevCommandIo = {
    out: captured.out,
    openUrl: () => Promise.resolve(false),
    // Nobody presses Ctrl+C; only the idle exit can end the run.
    waitForShutdown: () => new Promise<void>(() => undefined),
  };

  const exitCode = await runDev(
    { projectDirectory: directory, hostPort: 0, appPort: 0, idleTimeoutMs: 40, idleCheckMs: 5 },
    environment,
    io,
  );

  assert.equal(exitCode, 0);
  assert.ok(captured.text().includes("✓ Stopped   No page was open"));
  assert.ok(captured.text().includes("npx driggsby@latest dev"));
  assert.deepEqual(await readLiveDevStates(environment.homeDirectory), []);
  assertFitsTerminal(captured.text());
});

test("an open page holds the idle window off", async () => {
  const directory = await makeProject("money-dash");
  const environment = await makeEnvironment(LOOPBACK_BASE_URL);
  let stillUpWhileHeld = false;
  const io = probingIo(async (openedUrl) => {
    // A host page keeps its event stream open the whole time it is shown.
    const controller = new AbortController();
    const stream = fetch(`${openedUrl}/events`, { signal: controller.signal });
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 300);
    });
    stillUpWhileHeld = (await fetch(openedUrl)).ok;
    controller.abort();
    await stream.catch(() => undefined);
  });

  const exitCode = await runDev(
    // The window is long enough for the page's stream to connect on a busy
    // machine, and the page stays open well past it.
    { projectDirectory: directory, hostPort: 0, appPort: 0, idleTimeoutMs: 100, idleCheckMs: 5 },
    environment,
    io,
  );

  assert.equal(exitCode, 0);
  assert.ok(stillUpWhileHeld, "the preview must outlive the idle window while a page is open");
  assert.ok(!io.text().includes("stopped itself"));
});

// A listening loopback server standing in for whatever holds a port. It
// answers the dev identity probe with `pid` when one is given, the way a
// running driggsby dev would.
async function holdPort(port: number, pid: number | null = null): Promise<{ port: number; close: () => Promise<void> }> {
  const server = createServer((request, response) => {
    const identity = pid !== null && request.url === DEV_IDENTITY_PATH;
    response.writeHead(identity ? 200 : 404, { "Content-Type": "application/json" });
    response.end(identity ? JSON.stringify({ pid }) : "{}");
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address !== null && typeof address !== "string");
  return {
    port: address.port,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      }),
  };
}

// A held port whose next three ports are free, so a run based on it has
// somewhere to move to. It is picked below every OS's ephemeral range:
// ephemeral ports are handed out in sequence, so the neighbours of one are
// what other tests running alongside would be given next.
async function heldPortWithRoomAfter(): Promise<{ port: number; close: () => Promise<void> }> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const held = await holdPort(20_000 + Math.floor(Math.random() * 10_000)).catch(() => null);
    if (held === null) {
      continue;
    }
    const neighbours = await Promise.all([1, 2, 3].map((offset) => holdPort(held.port + offset).catch(() => null)));
    const bound = neighbours.filter((neighbour) => neighbour !== null);
    await Promise.all(bound.map((neighbour) => neighbour.close()));
    if (bound.length === neighbours.length) {
      return held;
    }
    await held.close();
  }
  throw new Error("no free run of ports for this test");
}

test("a taken port moves the preview to the next free pair and says where", async () => {
  const directory = await makeProject("money-dash");
  const environment = await makeEnvironment(LOOPBACK_BASE_URL);
  const held = await heldPortWithRoomAfter();
  const states: DevState[] = [];
  const io = probingIo(async () => {
    states.push(...(await readLiveDevStates(environment.homeDirectory)));
  });
  try {
    const exitCode = await runDev(
      { projectDirectory: directory, hostPort: held.port, appPort: held.port + 1 },
      environment,
      io,
    );

    assert.equal(exitCode, 0);
    assert.equal(io.openedUrls[0], `http://127.0.0.1:${String(held.port + 2)}`);
    assert.ok(io.text().includes(`http://127.0.0.1:${String(held.port + 2)}`));
    assert.ok(io.text().includes(`http://127.0.0.1:${String(held.port + 3)}`));
    const recorded = states[0];
    assert.ok(recorded !== undefined);
    assert.equal(recorded.hostPort, held.port + 2);
    assert.equal(recorded.appPort, held.port + 3);
  } finally {
    await held.close();
  }
});

test("with both pairs taken, the error names the whole range, and a failed pair's app port is released", async () => {
  const directory = await makeProject("money-dash");
  const environment = await makeEnvironment(LOOPBACK_BASE_URL);
  const base = await heldPortWithRoomAfter();
  const second = await holdPort(base.port + 2);
  try {
    const error = await runDev(
      { projectDirectory: directory, hostPort: base.port, appPort: base.port + 1, portPairs: 2 },
      environment,
      probingIo(() => Promise.resolve()),
    ).then(
      () => assert.fail("must not start"),
      (thrown: unknown) => thrown,
    );
    assert.ok(error instanceof CliError);
    assert.ok(error.message.includes(`${String(base.port)} to ${String(base.port + 3)}`));
    // Each pair's app port bound before its host port failed; both are free again.
    const appPorts = await Promise.all([holdPort(base.port + 1), holdPort(base.port + 3)]);
    await Promise.all(appPorts.map((held) => held.close()));
  } finally {
    await second.close();
    await base.close();
  }
});

test("a taken app port moves the pair too", async () => {
  const directory = await makeProject("money-dash");
  const environment = await makeEnvironment(LOOPBACK_BASE_URL);
  const room = await heldPortWithRoomAfter();
  const base = room.port - 1;
  const io = probingIo(() => Promise.resolve());
  try {
    // The app port of pair 0 (room.port) is held; its host port (base) is free.
    const exitCode = await runDev({ projectDirectory: directory, hostPort: base, appPort: room.port }, environment, io);
    assert.equal(exitCode, 0);
    assert.equal(io.openedUrls[0], `http://127.0.0.1:${String(base + 2)}`);
  } finally {
    await room.close();
  }
});

test("a dev that binds its ports clears a leftover record naming them", async () => {
  const directory = await makeProject("money-dash");
  const environment = await makeEnvironment(LOOPBACK_BASE_URL);
  const room = await heldPortWithRoomAfter();
  const hostPort = room.port + 1;
  await room.close();
  // A dev for another folder died without cleanup on these very ports, and
  // its pid now belongs to a live process (this test's parent stands in).
  await writeDevState(environment.homeDirectory, {
    pid: process.ppid, folder: "/Users/someone/gone", startedAt: new Date().toISOString(), hostPort, appPort: hostPort + 1,
  });
  let leftoverGone = false;
  const io = probingIo(async () => {
    leftoverGone = await readFile(devStatePath(environment.homeDirectory, process.ppid)).then(() => false, () => true);
  });

  const exitCode = await runDev({ projectDirectory: directory, hostPort, appPort: hostPort + 1 }, environment, io);

  assert.equal(exitCode, 0);
  assert.ok(leftoverGone, "the leftover record is cleared once the ports are ours");
});

test("with every pair taken, the error names the ports and how to free one", async () => {
  const directory = await makeProject("money-dash");
  const environment = await makeEnvironment(LOOPBACK_BASE_URL);
  const held = await holdPort(0);
  try {
    const error = await runDev(
      { projectDirectory: directory, hostPort: held.port, appPort: held.port + 1, portPairs: 1 },
      environment,
      probingIo(() => Promise.resolve()),
    ).then(
      () => assert.fail("must not start"),
      (thrown: unknown) => thrown,
    );
    assert.ok(error instanceof CliError);
    assert.ok(error.message.includes(`${String(held.port)} to ${String(held.port + 1)}`));
    assert.ok(error.message.includes("npx driggsby@latest dev --stop"));
    assert.ok(error.message.includes("npx driggsby@latest dev\n") || error.message.endsWith("npx driggsby@latest dev"));
    assertFitsTerminal(error.message);
  } finally {
    await held.close();
  }
});

test("dev in a folder already previewing names that preview instead of starting a second", async () => {
  const directory = await makeProject("money-dash");
  const environment = await makeEnvironment(LOOPBACK_BASE_URL);
  // This very process stands in for the dev already running here.
  const running = await holdPort(0, process.pid);
  await writeDevState(environment.homeDirectory, {
    pid: process.pid,
    folder: directory,
    startedAt: new Date().toISOString(),
    hostPort: running.port,
    appPort: running.port + 1,
  });
  try {
    const error = await runDev(
      { projectDirectory: directory, hostPort: 0, appPort: 0 },
      environment,
      probingIo(() => Promise.resolve()),
    ).then(
      () => assert.fail("must not start"),
      (thrown: unknown) => thrown,
    );
    assert.ok(error instanceof CliError);
    assert.ok(error.message.includes(`http://127.0.0.1:${String(running.port)}`));
    assert.ok(error.message.includes("npx driggsby@latest dev --stop"));
    assertFitsTerminal(error.message);
    // The running preview's record is untouched.
    assert.equal((await readLiveDevStates(environment.homeDirectory)).length, 1);
  } finally {
    await running.close();
  }
});

test("dev without a sign-in points at login before starting anything", async () => {
  const directory = await makeProject("money-dash");
  const environment = await makeEnvironment(LOOPBACK_BASE_URL, { signedIn: false });

  const error = await runDev(
    { projectDirectory: directory, hostPort: 0, appPort: 0 },
    environment,
    probingIo(() => Promise.resolve()),
  ).then(
    () => assert.fail("must not start"),
    (thrown: unknown) => thrown,
  );

  assert.ok(error instanceof CliError);
  assert.ok(error.message.includes("npx driggsby@latest login"));
});

test("dev refuses a driggsby.json with dev_command, naming the alternative", async () => {
  const directory = await makeProject("money-dash");
  await writeFile(
    join(directory, "driggsby.json"),
    JSON.stringify({ slug: "money-dash", serve: ".", dev_command: "npm run dev" }),
  );
  const environment = await makeEnvironment(LOOPBACK_BASE_URL);

  const error = await runDev(
    { projectDirectory: directory, hostPort: 0, appPort: 0 },
    environment,
    probingIo(() => Promise.resolve()),
  ).then(
    () => assert.fail("must not start"),
    (thrown: unknown) => thrown,
  );

  assert.ok(error instanceof CliError);
  assert.ok(error.message.includes("dev_command"));
  assert.ok(error.message.includes("npx driggsby@latest deploy"));
  assertFitsTerminal(error.message);
});

test("the idle window reads as minutes, singular at one, and a moment below that", () => {
  assert.equal(idleWindowWords(30 * 60 * 1000), "30 minutes");
  assert.equal(idleWindowWords(60 * 1000), "1 minute");
  assert.equal(idleWindowWords(40), "a moment");
});
