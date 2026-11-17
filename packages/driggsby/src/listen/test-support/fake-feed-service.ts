// A fake of the read-only SQL tools that listen and channel read: each
// stream's rows, visible by check, answered the way the service answers.
import assert from "node:assert/strict";

import { successEnvelope } from "../../test-support/fake-mcp.ts";

export const S0 = "2026-11-11T10:00:00Z";
export const S1 = "2026-11-11T10:05:00Z";
export const S2 = "2026-11-11T10:06:00Z";
export const S3 = "2026-11-11T10:07:00Z";

export function txn(ref: string, arrivedAt: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    transaction_ref: ref,
    arrived_at: arrivedAt,
    posted_date: "2026-11-11",
    status: "posted",
    direction: "outflow",
    amount: 12.5,
    currency_code: "USD",
    merchant_name: "Corner Cafe",
    description: "CORNER CAFE 1111",
    category_primary: "FOOD_AND_DRINK",
    account_name: "Everyday Card",
    account_mask_last4: "1111",
    ...overrides,
  };
}

export function activity(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    arrived_at: S1,
    trade_date: "2026-11-10",
    activity_type: "dividend",
    cash_flow_direction: "inflow",
    cash_amount: 42.18,
    currency_code: "USD",
    quantity: null,
    ticker_symbol: "ABCD",
    name: "Example Index Fund",
    account_name: "Brokerage",
    account_mask_last4: "2222",
    ...overrides,
  };
}

// A row the fake service holds from check `from` (0: before listen starts)
// until just before check `until`.
export interface Timed {
  row: Record<string, unknown>;
  from: number;
  until?: number;
}

export const held = (row: Record<string, unknown>, from = 0, until?: number): Timed => (until === undefined ? { row, from } : { row, from, until });

export interface Script {
  transactions?: Timed[];
  investments?: Timed[];
  failingChecks?: number[];
  signedOutCheck?: number;
  // Each page holds at most this many rows and says it was cut to size.
  cutTo?: number;
  // From this check on, every transaction query is refused: today's limit.
  dailyLimitCheck?: number;
  // ...until this check, when the limit lifts.
  dailyLimitUntil?: number;
}

export function sqlOf(body: Record<string, unknown>): string {
  const params = body.params as Record<string, unknown>;
  return String((params.arguments as Record<string, unknown>).sql);
}

const PAGE_QUERY = /WHERE arrived_at >= '([^']*)' AND '[0-9a-f]+\d*' <> '' ORDER BY .* LIMIT (\d+) OFFSET (\d+)$/;

function sortKey(row: Record<string, unknown>): string {
  return `${String(row.arrived_at)}|${typeof row.transaction_ref === "string" ? row.transaction_ref : JSON.stringify(row)}`;
}

// A fake of the read-only SQL tools: each stream's rows, visible by check,
// answered the way the service answers: newest first, paged, and cut to
// size (with truncated set) when asked.
export function fakeService(script: Script, phase: () => number) {
  return (body: Record<string, unknown>) => {
    const sql = sqlOf(body);
    const stream = sql.includes("FROM investment_activity") ? "investments" : "transactions";
    const check = phase();
    const visible = (script[stream] ?? [])
      .filter((item) => item.from <= check && (item.until === undefined || check < item.until))
      .map((item) => item.row);
    if (stream === "transactions" && script.failingChecks?.includes(check) === true) {
      return { status: 500, payload: { error: "down" } };
    }
    const limited = script.dailyLimitCheck !== undefined && check >= script.dailyLimitCheck && (script.dailyLimitUntil === undefined || check < script.dailyLimitUntil);
    if (stream === "transactions" && limited) {
      const message = "You've reached today's tool-call limit. Try again tomorrow.";
      return {
        status: 200,
        payload: {
          jsonrpc: "2.0",
          id: body.id,
          result: { isError: true, structuredContent: { error: message, kind: "rate_limited", retryable: false }, content: [{ type: "text", text: message }] },
        },
      };
    }
    if (sql.startsWith("SELECT MAX(arrived_at)")) {
      const times = visible.map((row) => String(row.arrived_at)).sort();
      return successEnvelope(body, { rows: [{ latest: times.at(-1) ?? null }] });
    }
    if (stream === "transactions" && script.signedOutCheck === check) {
      return { status: 401, payload: { error: "unauthorized" } };
    }
    const match = PAGE_QUERY.exec(sql);
    assert.ok(match !== null, `unexpected query: ${sql}`);
    const [, lower = "", limit = "0", offset = "0"] = match;
    const page = Math.min(Number(limit), script.cutTo ?? Number(limit));
    const matching = visible
      .filter((row) => String(row.arrived_at) >= lower)
      .sort((left, right) => sortKey(right).localeCompare(sortKey(left)));
    const rows = matching.slice(Number(offset), Number(offset) + page);
    return successEnvelope(body, { rows, truncated: page < Number(limit) && Number(offset) + page < matching.length });
  };
}
