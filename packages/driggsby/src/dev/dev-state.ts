// The record of the one `driggsby dev` running on this machine:
// ~/.driggsby/dev.json, written after both ports bind and removed when the
// run ends. `dev --stop` reads it to find the process, and a second `dev`
// reads it to say which folder already holds the ports. A file whose pid is
// no longer alive (the machine rebooted, the process was killed hard) is
// stale and treated as absent. It holds no credentials.
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface DevState {
  pid: number;
  folder: string;
  startedAt: string;
  hostPort: number;
  appPort: number;
}

export function devStatePath(homeDirectory: string): string {
  return join(homeDirectory, ".driggsby", "dev.json");
}

export async function writeDevState(homeDirectory: string, state: DevState): Promise<void> {
  const directory = join(homeDirectory, ".driggsby");
  // mode applies only when the directory is created; an existing ~/.driggsby
  // keeps whatever permissions the user already gave it.
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporaryPath = join(directory, `dev.json.${randomUUID()}.tmp`);
  try {
    await writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    await rename(temporaryPath, devStatePath(homeDirectory));
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
}

// The state of a dev that is still running, or null. A file naming a dead
// process, or one that doesn't parse, is removed so it can't mislead twice.
export async function readLiveDevState(
  homeDirectory: string,
  isAlive: (pid: number) => boolean = processIsAlive,
): Promise<DevState | null> {
  const state = await readDevStateFile(homeDirectory);
  if (state === null) {
    return null;
  }
  if (state === "malformed" || !isAlive(state.pid)) {
    await rm(devStatePath(homeDirectory), { force: true });
    return null;
  }
  return state;
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
    Number.isInteger(record.pid) &&
    typeof record.folder === "string" &&
    typeof record.startedAt === "string" &&
    Number.isInteger(record.hostPort) &&
    Number.isInteger(record.appPort)
  );
}
