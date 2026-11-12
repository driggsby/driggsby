// How driggsby listen prints one newly arrived piece of investment
// activity (a buy, a sell, a dividend). The institution writes the
// description, so it is hostile text: stripped, capped and quoted like a
// merchant name. A date, ticker, activity type, currency or mask in any
// unexpected shape is never printed as given.
import { capForTerminal, terminalSafeJson } from "../terminal-text.ts";
import type { ParsedRow } from "./feed.ts";
import { accountLabel, CURRENCY_CODE, DATE, formatAmount, LAST4, MAX_NAME_CHARS, numberField, quotedName, shaped, textField } from "./format.ts";

interface ArrivedInvestment {
  arrivedAt: string;
  date: string;
  activityType: string;
  direction: "inflow" | "outflow";
  amount: number;
  currency: string | null;
  quantity: number | null;
  ticker: string | null;
  name: string;
  account: string;
  accountLast4: string | null;
}

const ACTIVITY_LABELS: Readonly<Record<string, string>> = {
  buy: "Buy",
  sell: "Sell",
  dividend: "Dividend",
  interest: "Interest",
  fee: "Fee",
  contribution: "Contribution",
  withdrawal: "Withdrawal",
  transfer: "Transfer",
  cancel: "Canceled",
  other: "Other activity",
};
const TICKER = /^[A-Z0-9][A-Z0-9.\-/]{0,11}$/;

function arrivedInvestmentFrom(row: unknown): ArrivedInvestment | null {
  if (typeof row !== "object" || row === null) {
    return null;
  }
  const record = row as Record<string, unknown>;
  const arrivedAt = textField(record, "arrived_at");
  const date = shaped(textField(record, "trade_date"), DATE);
  const amount = numberField(record.cash_amount);
  if (arrivedAt === null || date === null || amount === null) {
    return null;
  }
  const quantity = record.quantity;
  const activityType = textField(record, "activity_type") ?? "other";
  return {
    arrivedAt,
    date,
    activityType: Object.hasOwn(ACTIVITY_LABELS, activityType) ? activityType : "other",
    direction: textField(record, "cash_flow_direction") === "inflow" ? "inflow" : "outflow",
    amount,
    currency: shaped(textField(record, "currency_code"), CURRENCY_CODE),
    quantity: numberField(quantity),
    ticker: shaped(textField(record, "ticker_symbol"), TICKER),
    name: textField(record, "name") ?? "",
    account: textField(record, "account_name") ?? "",
    accountLast4: shaped(textField(record, "account_mask_last4"), LAST4),
  };
}

// Investment activity carries no id, so a row is matched by the facts it
// carries (not the names a person or institution can change); two
// identical rows are counted, so both print.
export function investmentRow(row: unknown, json: boolean): ParsedRow | null {
  const activity = arrivedInvestmentFrom(row);
  if (activity === null) {
    return null;
  }
  const match = JSON.stringify([
    activity.arrivedAt,
    activity.date,
    activity.activityType,
    activity.direction,
    activity.amount,
    activity.currency,
    activity.quantity,
    activity.ticker,
    activity.accountLast4,
  ]);
  return {
    arrivedAt: activity.arrivedAt,
    match,
    id: null,
    line: json ? formatInvestmentJsonLine(activity) : formatInvestmentLine(activity),
  };
}

function formatInvestmentLine(activity: ArrivedInvestment): string {
  const parts = [
    activity.date,
    "Investment",
    ACTIVITY_LABELS[activity.activityType] ?? "Other activity",
    formatAmount(activity.amount, activity.currency),
  ];
  if (activity.ticker !== null) {
    parts.push(activity.ticker);
  }
  if (activity.name !== "") {
    parts.push(quotedName(activity.name));
  }
  parts.push(accountLabel(activity.account, activity.accountLast4));
  return parts.join(" · ");
}

function formatInvestmentJsonLine(activity: ArrivedInvestment): string {
  return terminalSafeJson(
    {
      event: "investment",
      arrived_at: activity.arrivedAt,
      trade_date: activity.date,
      activity_type: activity.activityType,
      cash_flow_direction: activity.direction,
      cash_amount: activity.amount,
      currency_code: activity.currency,
      quantity: activity.quantity,
      ticker_symbol: activity.ticker,
      name: capForTerminal(activity.name, MAX_NAME_CHARS),
      account_name: capForTerminal(activity.account, MAX_NAME_CHARS),
      account_mask_last4: activity.accountLast4,
    },
    0,
  );
}
