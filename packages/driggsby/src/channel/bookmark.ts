// Where the channel left off, so a restarted session gets what arrived while
// it was down, exactly as if it had never stopped. It holds when it was
// saved and what each stream's cursor remembers: the newest arrival seen and
// one-way digests of what was sent in the last hour. No names, amounts or
// ids in the clear. It lives in the plugin's own data folder, one file per
// project folder, readable only by its owner. Without that folder (the
// command run outside the plugin) there is no place, and every start is
// fresh.
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";

import { ARRIVAL_TIME, arrivalTime, type CursorState, FUTURE_SLACK_MS, LOOK_BACK_MS } from "../listen/feed.ts";
import { writeOwnerOnlyFileIn } from "../owner-only-file.ts";

const VERSION = 2;
// A session down for longer than this starts fresh rather than sending
// everything since.
export const MAX_DOWNTIME_MS = 7 * 24 * 60 * 60 * 1000;
// A stream's newest arrival (service time) further past when the place was
// saved (this machine's time) than the service may run ahead means the file
// isn't the channel's own.
const SAVE_SLACK_MS = FUTURE_SLACK_MS;
// More rows remembered than a very busy hour holds, or a bigger file than
// that needs, means the file isn't the channel's own.
const MAX_REMEMBERED = 50_000;
const MAX_FILE_BYTES = 16 * 1024 * 1024;
// Opening a pipe without this would wait for a writer before anything
// could check what the file is. Windows has no such flag, and no such pipes.
const OPEN_FLAGS = constants.O_RDONLY | ((constants as { O_NONBLOCK?: number }).O_NONBLOCK ?? 0);

export interface Bookmark {
  savedAt: string;
  transactions: CursorState;
  investments: CursorState;
}

export function bookmarkPath(env: NodeJS.ProcessEnv): string | null {
  const data = env.CLAUDE_PLUGIN_DATA;
  if (data === undefined || data === "" || !isAbsolute(data)) {
    return null;
  }
  const project = createHash("sha256")
    .update(env.CLAUDE_PROJECT_DIR ?? "")
    .digest("hex")
    .slice(0, 16);
  return join(data, `channel-${project}.json`);
}

const shaped = (value: unknown): string | null => (typeof value === "string" && ARRIVAL_TIME.test(value) ? value : null);

function pairsOf(value: unknown, width: 2 | 3): unknown[][] | null {
  if (!Array.isArray(value) || value.length > MAX_REMEMBERED) {
    return null;
  }
  const rows = value as unknown[];
  return rows.every((row) => Array.isArray(row) && row.length === width) ? (rows as unknown[][]) : null;
}

// One stream's saved cursor, in its expected shape, with a newest arrival
// no later than the service may run past the save, and no earlier than the
// longest downtime before now. The cursor checks every value again when it
// restores.
function streamState(value: unknown, savedAt: number, now: number): CursorState | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const printed = pairsOf(record.printed, 3);
  const ids = pairsOf(record.ids, 2);
  if (printed === null || ids === null) {
    return null;
  }
  // An empty stream (no newest) is held to the same floor as an old one, so
  // a restart never reaches further back than the longest downtime. A
  // cursor reads from an hour before its newest, so the floor sits an hour
  // later.
  const floor = arrivalTime(now - MAX_DOWNTIME_MS + LOOK_BACK_MS);
  let newest = floor;
  if (record.newest !== null) {
    const saved = shaped(record.newest);
    if (saved === null || Date.parse(saved) > savedAt + SAVE_SLACK_MS) {
      return null;
    }
    newest = saved < floor ? floor : saved;
  }
  const remembered: CursorState = { newest, printed: [], ids: [] };
  for (const [key, count, arrivedAt] of printed) {
    if (typeof key !== "string" || typeof count !== "number" || typeof arrivedAt !== "string") {
      return null;
    }
    remembered.printed.push([key, count, arrivedAt]);
  }
  for (const [key, arrivedAt] of ids) {
    if (typeof key !== "string" || typeof arrivedAt !== "string") {
      return null;
    }
    remembered.ids.push([key, arrivedAt]);
  }
  return remembered;
}

// The saved place, or null when there is none, it isn't the channel's own,
// or it was saved too long ago (or in this machine's future).
export async function readBookmark(path: string, now: number): Promise<Bookmark | null> {
  let parsed: unknown;
  try {
    // Only a regular file of a sane size is parsed: never a pipe that would
    // hang the start, or something huge.
    const file = await open(path, OPEN_FLAGS);
    try {
      const info = await file.stat();
      if (!info.isFile() || info.size > MAX_FILE_BYTES) {
        return null;
      }
      parsed = JSON.parse(await file.readFile("utf8"));
    } finally {
      await file.close();
    }
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return null;
  }
  const record = parsed as Record<string, unknown>;
  const savedAt = shaped(record.savedAt);
  if (record.version !== VERSION || savedAt === null) {
    return null;
  }
  const savedTime = Date.parse(savedAt);
  const age = now - savedTime;
  if (!Number.isFinite(age) || age < 0 || age > MAX_DOWNTIME_MS) {
    return null;
  }
  const transactions = streamState(record.transactions, savedTime, now);
  const investments = streamState(record.investments, savedTime, now);
  return transactions === null || investments === null ? null : { savedAt, transactions, investments };
}

export async function writeBookmark(path: string, bookmark: Bookmark): Promise<void> {
  const body = JSON.stringify({ version: VERSION, savedAt: bookmark.savedAt, transactions: bookmark.transactions, investments: bookmark.investments });
  await writeOwnerOnlyFileIn(dirname(path), basename(path), `${body}\n`);
}
