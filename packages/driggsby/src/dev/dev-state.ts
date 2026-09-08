// The record of the one `driggsby dev` running on this machine:
// ~/.driggsby/dev.json, written after both ports bind and removed when the
// run ends. `dev --stop` reads it to find the process, and a second `dev`
// reads it to say which folder already holds the ports. A file whose pid is
// no longer alive (the machine rebooted, the process was killed hard) is
// stale and treated as absent. It holds no credentials.
import { lstat, readFile, rm } from "node:fs/promises";
import { Agent, request as httpRequest } from "node:http";
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
// Whole-probe deadline: the socket timeout above resets on every byte, so a
// port that dribbles bytes would otherwise hold the probe open for ever;
// the abort surfaces as a request error, which reads as no answer.
const IDENTITY_DEADLINE_MS = 2_000;
const IDENTITY_ATTEMPTS = 2;
const IDENTITY_RETRY_PAUSE_MS = 100;
const IDENTITY_MAX_BYTES = 4_096;
// The record is a few short fields; anything larger is not ours.
const STATE_MAX_BYTES = 4_096;
// Node routes fetch AND the default http agent through a proxy named in the
// environment (NODE_USE_ENV_PROXY with HTTP_PROXY); an agent built here
// carries no such configuration, so the identity probe below can never
// leave the loopback interface.
const LOOPBACK_AGENT = new Agent({ keepAlive: false });

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

// What a read of the record found. A record is live only when its pid
// exists AND the recorded host port is served by that very pid: a leftover
// file after a crash, a reboot, or a closed terminal can name a pid the OS
// has since handed to something unrelated, and that process must never be
// signalled. Only a dead pid or an unparseable file gets the record
// removed: a port that fails to answer may be a live dev on a busy machine
// (reported as "unconfirmed" so a caller can say so), and deleting its
// record would leave that dev with no way to be stopped from another
// terminal.
export type DevStateRead =
  | { status: "none"; state: null }
  | { status: "live"; state: DevState }
  | { status: "unconfirmed"; state: DevState };

export async function readDevState(homeDirectory: string, probes: DevProbes = defaultDevProbes()): Promise<DevStateRead> {
  const state = await readDevStateFile(homeDirectory);
  if (state === null) {
    return { status: "none", state: null };
  }
  if (state === "malformed") {
    await rm(devStatePath(homeDirectory), { force: true });
    return { status: "none", state: null };
  }
  if (!probes.isAlive(state.pid)) {
    await removeDevState(homeDirectory, state.pid);
    return { status: "none", state: null };
  }
  return (await probes.pidServing(state.hostPort)) === state.pid
    ? { status: "live", state }
    : { status: "unconfirmed", state };
}

// The state of a dev that is confirmed running, or null.
export async function readLiveDevState(
  homeDirectory: string,
  probes: DevProbes = defaultDevProbes(),
): Promise<DevState | null> {
  const read = await readDevState(homeDirectory, probes);
  return read.status === "live" ? read.state : null;
}

// Asks the host origin on `hostPort` which pid serves it; null when nothing
// answers, or whatever answers is not a driggsby dev. A short pause and one
// retry cover a transient socket failure.
export async function devPidServing(hostPort: number): Promise<number | null> {
  for (let attempt = 0; attempt < IDENTITY_ATTEMPTS; attempt += 1) {
    if (attempt > 0) {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, IDENTITY_RETRY_PAUSE_MS);
      });
    }
    const pid = await askIdentity(hostPort);
    if (pid !== null) {
      return pid;
    }
  }
  return null;
}

// Loopback only, on LOOPBACK_AGENT. No redirect is followed (anything but
// 200 is no answer), and the body is read bounded, because whatever holds
// that port is untrusted.
function askIdentity(hostPort: number): Promise<number | null> {
  return new Promise((settle) => {
    const request = httpRequest(
      {
        host: "127.0.0.1",
        port: hostPort,
        path: DEV_IDENTITY_PATH,
        method: "GET",
        timeout: IDENTITY_TIMEOUT_MS,
        signal: AbortSignal.timeout(IDENTITY_DEADLINE_MS),
        agent: LOOPBACK_AGENT,
      },
      (response) => {
        if (response.statusCode !== 200) {
          response.resume();
          settle(null);
          return;
        }
        const chunks: Buffer[] = [];
        let total = 0;
        response.on("data", (chunk: Buffer) => {
          total += chunk.byteLength;
          if (total > IDENTITY_MAX_BYTES) {
            request.destroy();
            settle(null);
            return;
          }
          chunks.push(chunk);
        });
        response.on("end", () => {
          settle(pidFromIdentityBody(Buffer.concat(chunks).toString("utf8")));
        });
        response.on("error", () => {
          settle(null);
        });
      },
    );
    request.on("timeout", () => {
      request.destroy();
    });
    request.on("error", () => {
      settle(null);
    });
    request.end();
  });
}

function pidFromIdentityBody(body: string): number | null {
  try {
    const payload: unknown = JSON.parse(body);
    const pid = typeof payload === "object" && payload !== null ? (payload as Record<string, unknown>).pid : null;
    return isPid(pid) ? pid : null;
  } catch {
    return null;
  }
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

// Only a small regular file is read: a symlink, a device, or anything
// oversized at that path is not our record.
async function readDevStateFile(homeDirectory: string): Promise<DevState | "malformed" | null> {
  const path = devStatePath(homeDirectory);
  let raw: string;
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.size > STATE_MAX_BYTES) {
      return "malformed";
    }
    raw = await readFile(path, "utf8");
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
