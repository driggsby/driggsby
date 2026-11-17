// What listen and channel both follow: the two streams of newly arrived
// activity (card and bank transactions, and investment activity), read
// with the saved CLI sign-in through the read-only SQL tools.
import { randomBytes } from "node:crypto";

import type { CredentialEnvironment } from "../credentials/store.ts";
import { requireDeploySession, SIGN_IN_AGAIN_MESSAGE } from "../deploy/api-session.ts";
import { McpBroker } from "../dev/mcp-broker.ts";
import { type Feed, FeedCursor, type QueryRows } from "./feed.ts";
import { transactionRow } from "./format.ts";
import { investmentRow } from "./investment-format.ts";

export const CHECK_INTERVAL_MS = 60_000;

const TRANSACTIONS: Feed = {
  tool: "query_cash_sql",
  table: "cash_transactions",
  columns:
    "transaction_ref, arrived_at, posted_date, status, direction, amount, currency_code, " +
    "merchant_name, description, category_primary, account_name, account_mask_last4",
  order: "arrived_at DESC, transaction_ref DESC",
  everyChecks: 1,
  parse: transactionRow,
};

// Investment activity arrives a few times a day at most, so it is read
// every fifth check.
const INVESTMENTS: Feed = {
  tool: "query_investment_sql",
  table: "investment_activity",
  columns:
    "arrived_at, trade_date, activity_type, cash_flow_direction, cash_amount, currency_code, quantity, " +
    "ticker_symbol, name, account_name, account_mask_last4",
  order:
    "arrived_at DESC, trade_date DESC, activity_type, cash_flow_direction, cash_amount, quantity, " +
    "ticker_symbol, name, account_name, account_mask_last4, currency_code",
  everyChecks: 5,
  parse: investmentRow,
};

export interface Watch {
  transactions: FeedCursor;
  investments: FeedCursor;
}

function randomNonce(): string {
  return randomBytes(8).toString("hex");
}

// Both cursors, not yet started. Throws the sign-in CliError when this
// machine has no saved sign-in.
export async function openWatch(environment: CredentialEnvironment, reason: string, json: boolean): Promise<Watch> {
  const session = await requireDeploySession(environment);
  const broker = new McpBroker({
    baseUrl: session.baseUrl,
    token: session.token,
    defaultReason: reason,
    signInAgainMessage: SIGN_IN_AGAIN_MESSAGE,
    transportErrors: "throw",
  });
  const query = async (tool: string, sql: string): Promise<QueryRows> => {
    const outcome = await broker.runToolCall(tool, { sql });
    if (!outcome.ok) {
      // Today's call limit won't lift by trying again in a minute.
      const stop = outcome.error.kind === "rate_limited" && /\btoday\b/i.test(outcome.error.message);
      return { ok: false, message: outcome.error.message, stop };
    }
    const result = outcome.result as Record<string, unknown> | null;
    const rows = result?.rows;
    return { ok: true, rows: Array.isArray(rows) ? (rows as unknown[]) : [], truncated: result?.truncated === true };
  };
  const nonce = randomNonce();
  return {
    transactions: new FeedCursor(TRANSACTIONS, query, json, nonce),
    investments: new FeedCursor(INVESTMENTS, query, json, nonce),
  };
}
