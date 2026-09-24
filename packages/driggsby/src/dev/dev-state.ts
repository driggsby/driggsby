// The records of the `driggsby dev` previews running on this machine, one
// per run: ~/.driggsby/dev-<pid>.json, written after both ports bind and
// removed when the run ends. `dev --stop` reads them to find the process
// for a folder, and `dev` reads them to say where a folder's preview is
// already running. A file whose pid is no longer alive (the machine
// rebooted, the process was killed hard) is stale and treated as absent.
// Earlier versions kept one machine-wide record in ~/.driggsby/dev.json;
// it is still read, so a preview started by one of them can be stopped.
// They hold no credentials.
import { constants } from "node:fs";
import { open, readdir, rm } from "node:fs/promises";
import { Agent, request as httpRequest } from "node:http";
import { isAbsolute, join, resolve } from "node:path";

import { driggsbyDirectory, writeOwnerOnlyFile } from "../owner-only-file.ts";

export interface DevState {
  pid: number;
  folder: string;
  startedAt: string;
  hostPort: number;
  appPort: number;
}

const STATE_FILE_PATTERN = /^dev-([1-9]\d{0,9})\.json$/;
const LEGACY_STATE_FILE_NAME = "dev.json";
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

export function devStatePath(homeDirectory: string, pid: number): string {
  return join(driggsbyDirectory(homeDirectory), stateFileName(pid));
}

function stateFileName(pid: number): string {
  return `dev-${String(pid)}.json`;
}

export async function writeDevState(homeDirectory: string, state: DevState): Promise<void> {
  await writeOwnerOnlyFile(homeDirectory, stateFileName(state.pid), `${JSON.stringify(state, null, 2)}\n`);
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
// signalled. A record is removed when it is unparseable, names a pid other
// than its file's, names a dead pid, or names a port that answers as a
// different dev (its own dev cannot be there). A port that fails to answer
// may be a live dev on a busy machine (reported as "unconfirmed" so a
// caller can say so), and deleting its record would leave that dev with no
// way to be stopped from another terminal.
export type DevStateRead =
  | { status: "live"; state: DevState }
  | { status: "unconfirmed"; state: DevState };

// Every record on this machine that may still be a running dev, oldest
// first; stale and malformed records are removed on the way. With
// `onlyFolder`, only that folder's records are read and probed.
export async function readDevStates(
  homeDirectory: string,
  probes: DevProbes = defaultDevProbes(),
  onlyFolder?: string,
): Promise<DevStateRead[]> {
  const reads: DevStateRead[] = [];
  for (const record of await recordFiles(homeDirectory)) {
    const state = await readDevStateFile(record.path);
    if (state === null || state === "skip") {
      continue;
    }
    // A record must name the pid its file is named for, so no one run's
    // file can speak for another's.
    if (state === "malformed" || (record.pid !== null && state.pid !== record.pid)) {
      await removeQuietly(record.path);
      continue;
    }
    if (onlyFolder !== undefined && !sameFolder(state.folder, onlyFolder)) {
      continue;
    }
    if (!probes.isAlive(state.pid)) {
      await removeQuietly(record.path);
      continue;
    }
    const servingPid = await probes.pidServing(state.hostPort);
    if (servingPid !== null && servingPid !== state.pid) {
      await removeQuietly(record.path);
      continue;
    }
    reads.push(servingPid === state.pid ? { status: "live", state } : { status: "unconfirmed", state });
  }
  return reads.sort((a, b) => (a.state.startedAt < b.state.startedAt ? -1 : a.state.startedAt > b.state.startedAt ? 1 : 0));
}

// A dev that has just bound its ports clears every other record naming one
// of them: those ports are held exclusively on 127.0.0.1, so no dev such a
// record names can still be serving there.
export async function pruneDevStatesForPorts(
  homeDirectory: string,
  ownPid: number,
  hostPort: number,
  appPort: number,
): Promise<void> {
  const ours = [hostPort, appPort];
  for (const record of await recordFiles(homeDirectory)) {
    const state = await readDevStateFile(record.path);
    if (state === null || state === "skip" || state === "malformed" || state.pid === ownPid) {
      continue;
    }
    if (ours.includes(state.hostPort) || ours.includes(state.appPort)) {
      await removeQuietly(record.path);
    }
  }
}

// Windows has neither flag; there a symlink is followed and still checked
// as a regular file through the one handle.
function readFlags(): number {
  return process.platform === "win32" ? constants.O_RDONLY : constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
}

// Two records name the same folder when their resolved paths match; paths
// on Windows compare without regard to case, as its filesystems do.
export function sameFolder(a: string, b: string): boolean {
  const left = resolve(a);
  const right = resolve(b);
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

// Removal is best-effort: an entry that cannot be removed (a directory, a
// file another program holds open on Windows) must never stop a dev from
// starting or stopping.
async function removeQuietly(path: string): Promise<void> {
  await rm(path, { force: true }).catch(() => undefined);
}

// The states of the devs confirmed running, oldest first.
export async function readLiveDevStates(
  homeDirectory: string,
  probes: DevProbes = defaultDevProbes(),
): Promise<DevState[]> {
  const reads = await readDevStates(homeDirectory, probes);
  return reads.filter((read) => read.status === "live").map((read) => read.state);
}

interface RecordFile {
  path: string;
  // The pid the file is named for; null for the legacy machine-wide record.
  pid: number | null;
}

async function recordFiles(homeDirectory: string): Promise<RecordFile[]> {
  const directory = driggsbyDirectory(homeDirectory);
  let names: string[];
  try {
    names = await readdir(directory);
  } catch {
    return [];
  }
  const files: RecordFile[] = [];
  for (const name of names) {
    if (name === LEGACY_STATE_FILE_NAME) {
      files.push({ path: join(directory, name), pid: null });
      continue;
    }
    const match = STATE_FILE_PATTERN.exec(name);
    if (match !== null) {
      files.push({ path: join(directory, name), pid: Number(match[1]) });
    }
  }
  return files;
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

// Removes the run's own record, and the legacy machine-wide record only if
// it still names `pid`: a dev that ends must never erase another's record.
export async function removeDevState(homeDirectory: string, pid: number): Promise<void> {
  await removeQuietly(devStatePath(homeDirectory, pid));
  const legacyPath = join(driggsbyDirectory(homeDirectory), LEGACY_STATE_FILE_NAME);
  const legacy = await readDevStateFile(legacyPath);
  if (legacy !== null && legacy !== "skip" && legacy !== "malformed" && legacy.pid === pid) {
    await removeQuietly(legacyPath);
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

// Only a small regular file is read. The file is opened without following
// a symlink (a symlink reads as malformed, and removing it unlinks only the
// link) and without blocking (a FIFO never hangs the read), then checked
// and read through that one handle, so nothing swapped in after a check is
// ever read. Anything else at the path (a directory, a device) is skipped.
async function readDevStateFile(path: string): Promise<DevState | "malformed" | "skip" | null> {
  let handle;
  try {
    handle = await open(path, readFlags());
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "ELOOP" || code === "EMLINK" ? "malformed" : code === "ENOENT" ? null : "skip";
  }
  let raw: string;
  try {
    const info = await handle.stat();
    if (!info.isFile()) {
      return "skip";
    }
    if (info.size > STATE_MAX_BYTES) {
      return "malformed";
    }
    const buffer = Buffer.alloc(STATE_MAX_BYTES + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > STATE_MAX_BYTES) {
      return "malformed";
    }
    raw = buffer.subarray(0, bytesRead).toString("utf8");
  } catch {
    return "skip";
  } finally {
    await handle.close();
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
    // Always absolute as dev writes it; a relative one would match any
    // folder it is read from.
    typeof record.folder === "string" &&
    isAbsolute(record.folder) &&
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
