// One stream driggsby listen follows (card and bank transactions, or
// investment activity). A row can show up a little after rows stamped
// later than it, a pending charge can be replaced by its posted version,
// and a changed amount arrives again. So each check reads the rows stamped
// within LOOK_BACK of the newest one seen and prints only rows it hasn't
// printed: rows are matched by facts that don't change (not by names a
// person can edit), and counted, so two identical rows both print and a
// pending charge that posts unchanged doesn't print twice.
import { SIGN_IN_AGAIN_MESSAGE } from "../deploy/api-session.ts";

// stop: a refusal that trying again soon won't change (today's call limit).
export type QueryRows = { ok: true; rows: unknown[]; truncated: boolean } | { ok: false; message: string; stop?: boolean };

export interface ParsedRow {
  arrivedAt: string;
  // What makes this row the same row on a later check.
  match: string;
  // When a match has more rows than were printed, prefer printing a row
  // whose id hasn't been printed (null: the stream has no ids).
  id: string | null;
  line: string;
}

export interface Feed {
  tool: string;
  table: string;
  columns: string;
  // Newest first, so a long window still reaches the newest rows.
  order: string;
  // Read on every nth check.
  everyChecks: number;
  parse: (row: unknown, json: boolean) => ParsedRow | null;
}

type CheckResult =
  | { kind: "lines"; lines: string[] }
  | { kind: "trouble"; connection: boolean }
  | { kind: "signed-out" }
  | { kind: "stop"; message: string };
type Window = { ok: true; rows: ParsedRow[] } | { ok: false; message: string; stop?: boolean };

const PAGE_SIZE = 250;
// How far behind the newest row a late one is still looked for.
const LOOK_BACK_MS = 60 * 60 * 1000;
// Pages one check reads, newest first; older rows beyond them are left.
const PAGES_PER_CHECK = 8;
// A stamp further ahead of this machine's clock than this is refused.
const FUTURE_SLACK_MS = 24 * 60 * 60 * 1000;
// The only shape an arrival time may have before it is written into SQL
// text: what the service publishes, or what this file builds from it.
const ARRIVAL_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const BEGINNING = "1970-01-01T00:00:00Z";

interface Printed {
  count: number;
  arrivedAt: string;
}

// A real UTC time in the service's format, not ahead of this machine by
// more than FUTURE_SLACK_MS.
export function validArrival(value: unknown, now: number): value is string {
  if (typeof value !== "string" || !ARRIVAL_TIME.test(value)) {
    return false;
  }
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString().replace(/\.\d{3}Z$/, "Z") === value && time <= now + FUTURE_SLACK_MS;
}

export class FeedCursor {
  private readonly feed: Feed;
  private readonly query: (tool: string, sql: string) => Promise<QueryRows>;
  private readonly json: boolean;
  private readonly nonce: string;
  private readonly now: () => number;
  private newest: string | null = null;
  private printed = new Map<string, Printed>();
  private printedIds = new Set<string>();
  private checks = 0;
  private reads = 0;

  constructor(feed: Feed, query: (tool: string, sql: string) => Promise<QueryRows>, json: boolean, nonce: string, now: () => number = Date.now) {
    this.feed = feed;
    this.query = query;
    this.json = json;
    // Hex digits only: with a read counter, it makes each query's text unique.
    this.nonce = /^[0-9a-f]{1,32}$/.test(nonce) ? nonce : "0";
    this.now = now;
  }

  // Everything already in Driggsby counts as printed, so only what arrives
  // from now on prints: the newest arrival, in the service's own time, and
  // the rows within LOOK_BACK of it (a late row is looked for among them).
  async start(): Promise<{ ok: true } | { ok: false; message: string }> {
    this.reads += 1;
    const latest = await this.query(
      this.feed.tool,
      `SELECT MAX(arrived_at) AS latest FROM ${this.feed.table} WHERE '${this.nonce}${String(this.reads)}' <> ''`,
    );
    if (!latest.ok) {
      return latest;
    }
    const value = (latest.rows[0] as Record<string, unknown> | null | undefined)?.latest;
    if (value === null || value === undefined) {
      return { ok: true };
    }
    if (!validArrival(value, this.now())) {
      return { ok: false, message: "Driggsby's newest activity is dated more than a day ahead of this computer's clock. Check the clock, then run listen again." };
    }
    this.newest = value;
    const window = await this.readWindow();
    if (!window.ok) {
      return window;
    }
    this.take(window.rows, false);
    return { ok: true };
  }

  async check(): Promise<CheckResult> {
    this.checks += 1;
    if (this.checks % this.feed.everyChecks !== 0) {
      return { kind: "lines", lines: [] };
    }
    let window: Window;
    try {
      window = await this.readWindow();
    } catch {
      return { kind: "trouble", connection: true };
    }
    if (!window.ok) {
      if (window.message === SIGN_IN_AGAIN_MESSAGE) {
        return { kind: "signed-out" };
      }
      return window.stop === true ? { kind: "stop", message: window.message } : { kind: "trouble", connection: false };
    }
    return { kind: "lines", lines: this.take(window.rows, true) };
  }

  // Counts each match in the window and prints the rows beyond those
  // already printed, oldest first, then forgets matches that fell out of
  // the window.
  private take(rows: ParsedRow[], print: boolean): string[] {
    const groups = new Map<string, ParsedRow[]>();
    for (const row of [...rows].reverse()) {
      const group = groups.get(row.match);
      if (group === undefined) {
        groups.set(row.match, [row]);
      } else {
        group.push(row);
      }
      if (this.newest === null || row.arrivedAt > this.newest) {
        this.newest = row.arrivedAt;
      }
    }
    const lines: string[] = [];
    for (const [match, group] of groups) {
      const already = this.printed.get(match)?.count ?? 0;
      if (group.length > already) {
        // Rows whose id was printed go last, so the extra lines are the new
        // rows, even when a printed row with the same match was skipped.
        const unprinted = group.filter((row) => !this.wasPrinted(row));
        const printedBefore = group.filter((row) => this.wasPrinted(row));
        for (const row of [...unprinted, ...printedBefore].slice(0, group.length - already)) {
          if (print) {
            lines.push(row.line);
          }
        }
        this.printed.set(match, { count: group.length, arrivedAt: group[0]?.arrivedAt ?? BEGINNING });
      }
      for (const row of group) {
        if (row.id !== null) {
          this.printedIds.add(row.id);
        }
      }
    }
    const lower = this.lowerBound();
    for (const [match, entry] of this.printed) {
      if (entry.arrivedAt < lower) {
        this.printed.delete(match);
      }
    }
    if (this.printedIds.size > 10_000) {
      this.printedIds = new Set([...this.printedIds].slice(-5_000));
    }
    return lines;
  }

  private wasPrinted(row: ParsedRow): boolean {
    return row.id !== null && this.printedIds.has(row.id);
  }

  // The rows stamped within LOOK_BACK of the newest, newest first. A row
  // repeated across a page boundary (one shifted in between two pages) is
  // read once when the stream has ids.
  private async readWindow(): Promise<Window> {
    const lower = this.lowerBound();
    const rows: ParsedRow[] = [];
    const ids = new Set<string>();
    let offset = 0;
    for (let page = 0; page < PAGES_PER_CHECK; page += 1) {
      this.reads += 1;
      const result = await this.query(this.feed.tool, this.pageSql(lower, offset));
      if (!result.ok) {
        return result;
      }
      for (const row of result.rows) {
        const parsed = this.feed.parse(row, this.json);
        if (parsed === null || !validArrival(parsed.arrivedAt, this.now()) || parsed.arrivedAt < lower) {
          continue;
        }
        if (parsed.id !== null) {
          if (ids.has(parsed.id)) {
            continue;
          }
          ids.add(parsed.id);
        }
        rows.push(parsed);
      }
      offset += result.rows.length;
      // A short page is the last one, unless the service cut it to size.
      if (result.rows.length === 0 || (result.rows.length < PAGE_SIZE && !result.truncated)) {
        break;
      }
    }
    return { ok: true, rows };
  }

  private pageSql(lower: string, offset: number): string {
    return (
      `SELECT ${this.feed.columns} FROM ${this.feed.table} ` +
      `WHERE arrived_at >= '${lower}' AND '${this.nonce}${String(this.reads)}' <> '' ` +
      `ORDER BY ${this.feed.order} LIMIT ${String(PAGE_SIZE)} OFFSET ${String(offset)}`
    );
  }

  private lowerBound(): string {
    if (this.newest === null) {
      return BEGINNING;
    }
    const lower = new Date(Date.parse(this.newest) - LOOK_BACK_MS).toISOString().replace(/\.\d{3}Z$/, "Z");
    return ARRIVAL_TIME.test(lower) ? lower : BEGINNING;
  }
}
