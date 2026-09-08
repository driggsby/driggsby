// The record of the one `driggsby dev` running on this machine:
// ~/.driggsby/dev.json, written after both ports bind and removed when the
// run ends. `dev --stop` reads it to find the process, and a second `dev`
// reads it to say which folder already holds the ports. A file whose pid is
// no longer alive (the machine rebooted, the process was killed hard) is
// stale and treated as absent. It holds no credentials.
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";

import { driggsbyDirectory, writeOwnerOnlyFile } from "../owner-only-file.ts";

export interface DevState {
  pid: number;
  folder: string;
  startedAt: string;
  hostPort: number;
  appPort: number;
}

const STATE_FILE_NAME = "dev.json";
// The host origin answers this with the pid of the dev serving it, so a
// record can be checked against the process actually holding the port.
export const DEV_IDENTITY_PATH = "/-/dev-identity";
const IDENTITY_TIMEOUT_MS = 1_000;
const IDENTITY_ATTEMPTS = 2;
const IDENTITY_MAX_BYTES = 4_096;

export function devStatePath(homeDirectory: string): string {
  return join(driggsbyDirectory(homeDirectory), STATE_FILE_NAME);
}

export async function writeDevState(homeDirectory: string, state: DevState): Promise<void> {
  await writeOwnerOnlyFile(homeDirectory, STATE_FILE_NAME, `${JSON.stringify(state, null, 2)}\n`);
}

// How a record is checked against the machine. Tests stub both; the real
// probes ask the OS whether the pid exists and ask the recorded host port
// which pid is serving it.
export interface DevProbes {
  isAlive: (pid: number) => boolean;
  pidServing: (hostPort: number) => Promise<number | null>;
}

export function defaultDevProbes(): DevProbes {
  return { isAlive: processIsAlive, pidServing: devPidServing };
}

// The state of a dev that is still running, or null. A record is live only
// when its pid exists AND the recorded host port is served by that very
// pid: a leftover file after a crash, a reboot, or a closed terminal can
// name a pid the OS has since handed to something unrelated, and that
// process must never be signalled. Only a dead pid or an unparseable file
// gets the record removed: a port that fails to answer may be a live dev
// on a busy machine, and deleting its record would leave that dev with
// no way to be stopped from another terminal.
export async function readLiveDevState(
  homeDirectory: string,
  probes: DevProbes = defaultDevProbes(),
): Promise<DevState | null> {
  const state = await readDevStateFile(homeDirectory);
  if (state === null) {
    return null;
  }
  if (state === "malformed") {
    await rm(devStatePath(homeDirectory), { force: true });
    return null;
  }
  if (!probes.isAlive(state.pid)) {
    await removeDevState(homeDirectory, state.pid);
    return null;
  }
  return (await probes.pidServing(state.hostPort)) === state.pid ? state : null;
}

// Asks the host origin on `hostPort` which pid serves it; null when nothing
// answers, or whatever answers is not a driggsby dev. One retry covers a
// dev that was busy for the first attempt.
export async function devPidServing(hostPort: number): Promise<number | null> {
  for (let attempt = 0; attempt < IDENTITY_ATTEMPTS; attempt += 1) {
    const pid = await askIdentity(hostPort);
    if (pid !== null) {
      return pid;
    }
  }
  return null;
}

async function askIdentity(hostPort: number): Promise<number | null> {
  try {
    const response = await fetch(`http://127.0.0.1:${String(hostPort)}${DEV_IDENTITY_PATH}`, {
      signal: AbortSignal.timeout(IDENTITY_TIMEOUT_MS),
      redirect: "error",
    });
    if (!response.ok) {
      return null;
    }
    // Whatever holds that port is untrusted: read a bounded body, never
    // buffer what it chooses to send.
    const body = await readBounded(response, IDENTITY_MAX_BYTES);
    if (body === null) {
      return null;
    }
    const payload: unknown = JSON.parse(body);
    const pid = typeof payload === "object" && payload !== null ? (payload as Record<string, unknown>).pid : null;
    return isPid(pid) ? pid : null;
  } catch {
    return null;
  }
}

async function readBounded(response: Response, maxBytes: number): Promise<string | null> {
  if (response.body === null) {
    return null;
  }
  const reader: ReadableStreamDefaultReader<Uint8Array> = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

// Removes the file only if it still names `pid`: a dev that ends must never
// erase the record of a newer dev that took the ports after it.
export async function removeDevState(homeDirectory: string, pid: number): Promise<void> {
  const state = await readDevStateFile(homeDirectory);
  if (state === null) {
    return;
  }
  if (state === "malformed" || state.pid === pid) {
    await rm(devStatePath(homeDirectory), { force: true });
  }
}

export function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function readDevStateFile(homeDirectory: string): Promise<DevState | "malformed" | null> {
  let raw: string;
  try {
    raw = await readFile(devStatePath(homeDirectory), "utf8");
  } catch {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    return isDevState(parsed) ? parsed : "malformed";
  } catch {
    return "malformed";
  }
}

function isDevState(value: unknown): value is DevState {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    isPid(record.pid) &&
    typeof record.folder === "string" &&
    typeof record.startedAt === "string" &&
    isPort(record.hostPort) &&
    isPort(record.appPort)
  );
}

// Only a real, positive pid: 0 and negatives are process groups to kill(2),
// and a record must never turn into a broadcast signal.
function isPid(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function isPort(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 65_535;
}
