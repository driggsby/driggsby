// How driggsby listen prints one newly arrived transaction: a plain line
// for people and agents reading a terminal, or one line of JSON for
// scripts. Every text field comes from a bank or a merchant, so it is
// treated as hostile: stripped of terminal control and invisible
// characters, length-capped, and (in the plain line) quoted with the
// line's own separator and lookalike quotes taken out, so a merchant name
// reads as one name rather than as the CLI's own words or another field.
// Short fields (dates, codes, masks) print only in their expected shape.
import { capForTerminal, quotedForTerminal, terminalSafeJson } from "../terminal-text.ts";
import type { ParsedRow } from "./feed.ts";

interface ArrivedTransaction {
  ref: string;
  arrivedAt: string;
  date: string;
  status: "pending" | "posted";
  direction: "inflow" | "outflow";
  amount: number;
  currency: string | null;
  merchant: string;
  description: string;
  category: string | null;
  account: string;
  accountLast4: string | null;
}

export const MAX_NAME_CHARS = 60;
const MAX_DESCRIPTION_CHARS = 120;
export const DATE = /^\d{4}-\d{2}-\d{2}$/;
const REF = /^[A-Za-z0-9_-]{1,128}$/;
export const CURRENCY_CODE = /^[A-Z]{3}$/;
const CATEGORY_CODE = /^[A-Z_]{1,64}$/;
// The categories a plain line names in words; any other code is left out
// of it, so a category never reads as a sentence of its own.
const KNOWN_CATEGORIES: ReadonlySet<string> = new Set([
  "BANK_FEES", "ENTERTAINMENT", "FOOD_AND_DRINK", "GENERAL_MERCHANDISE", "GENERAL_SERVICES",
  "GOVERNMENT_AND_NON_PROFIT", "HOME_IMPROVEMENT", "INCOME", "LOAN_PAYMENTS", "MEDICAL", "OTHER",
  "PERSONAL_CARE", "RENT_AND_UTILITIES", "TRANSFER_IN", "TRANSFER_OUT", "TRANSPORTATION", "TRAVEL",
]);
export const LAST4 = /^[0-9A-Za-z]{1,4}$/;
// The plain line's separator and characters that look like it, and
// quotation marks that look like the ones a name is printed inside.
const SEPARATOR_LOOKALIKES = /[\u00b7\u0387\u16eb\u2022\u2027\u2219\u22c5\u2981\u30fb\u318d\uff65\u1427\u2e31\u2e33\ua78f\u0f0b\u2043\u25e6]/g;
const QUOTE_LOOKALIKES = /[\u02dd\u05f4\u201c\u201d\u201e\u201f\u2033\u3003\uff02\u02ba\u02ee\u275d\u275e\u301d\u301e\u301f]/g;

export function textField(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" ? value : null;
}

// A number, or a decimal written as text (some answers carry amounts that way).
export function numberField(value: unknown): number | null {
  const number = typeof value === "string" && /^-?\d+(\.\d+)?$/.test(value) ? Number(value) : value;
  return typeof number === "number" && Number.isFinite(number) ? number : null;
}

export function shaped(value: string | null, pattern: RegExp): string | null {
  return value !== null && pattern.test(value) ? value : null;
}

// One row of the SQL result, checked field by field. A row missing what a
// line needs, or with a date or id in any other shape, is skipped.
function arrivedTransactionFrom(row: unknown): ArrivedTransaction | null {
  if (typeof row !== "object" || row === null) {
    return null;
  }
  const record = row as Record<string, unknown>;
  const ref = shaped(textField(record, "transaction_ref"), REF);
  const arrivedAt = textField(record, "arrived_at");
  const date = shaped(textField(record, "posted_date"), DATE);
  const amount = numberField(record.amount);
  if (ref === null || arrivedAt === null || date === null || amount === null) {
    return null;
  }
  return {
    ref,
    arrivedAt,
    date,
    status: textField(record, "status") === "pending" ? "pending" : "posted",
    direction: textField(record, "direction") === "inflow" ? "inflow" : "outflow",
    amount,
    currency: shaped(textField(record, "currency_code"), CURRENCY_CODE),
    merchant: textField(record, "merchant_name") ?? "Unknown Counterparty",
    description: textField(record, "description") ?? "",
    category: shaped(textField(record, "category_primary"), CATEGORY_CODE),
    account: textField(record, "account_name") ?? "",
    accountLast4: shaped(textField(record, "account_mask_last4"), LAST4),
  };
}

export function transactionRow(row: unknown, json: boolean): ParsedRow | null {
  const transaction = arrivedTransactionFrom(row);
  if (transaction === null) {
    return null;
  }
  // A posted charge that kept its pending version's time and amount is the
  // same charge; a changed amount is news and prints again. Names a person
  // can edit (an account's) stay out, so a rename prints nothing again.
  const match = JSON.stringify([
    transaction.arrivedAt,
    transaction.direction,
    transaction.amount,
    transaction.currency,
    transaction.accountLast4,
  ]);
  return {
    arrivedAt: transaction.arrivedAt,
    match,
    id: transaction.ref,
    line: json ? formatJsonLine(transaction) : formatLine(transaction),
  };
}

function formatLine(transaction: ArrivedTransaction): string {
  const parts = [
    transaction.date,
    transaction.direction === "inflow" ? "Money in" : "Charge",
    formatAmount(transaction.amount, transaction.currency),
    quotedName(transaction.merchant),
    accountLabel(transaction.account, transaction.accountLast4),
  ];
  const category = categoryLabel(transaction.category);
  if (category !== null) {
    parts.push(category);
  }
  if (transaction.status === "pending") {
    parts.push("pending");
  }
  return parts.join(" · ");
}

function formatJsonLine(transaction: ArrivedTransaction): string {
  return terminalSafeJson(
    {
      event: "transaction",
      transaction_ref: transaction.ref,
      arrived_at: transaction.arrivedAt,
      date: transaction.date,
      status: transaction.status,
      direction: transaction.direction,
      amount: transaction.amount,
      currency_code: transaction.currency,
      merchant_name: capForTerminal(transaction.merchant, MAX_NAME_CHARS),
      description: capForTerminal(transaction.description, MAX_DESCRIPTION_CHARS),
      category: transaction.category,
      account_name: capForTerminal(transaction.account, MAX_NAME_CHARS),
      account_mask_last4: transaction.accountLast4,
    },
    0,
  );
}

export function formatAmount(amount: number, currency: string | null): string {
  if (currency !== null) {
    try {
      return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(amount);
    } catch {
      return amount.toFixed(2);
    }
  }
  return amount.toFixed(2);
}

export function quotedName(value: string): string {
  return quotedForTerminal(value.replace(SEPARATOR_LOOKALIKES, "-").replace(QUOTE_LOOKALIKES, "'"), MAX_NAME_CHARS);
}

export function accountLabel(account: string, last4: string | null): string {
  const name = quotedName(account);
  return last4 !== null ? `${name} ••${last4}` : name;
}

// FOOD_AND_DRINK reads as "Food and drink".
function categoryLabel(category: string | null): string | null {
  if (category === null || !KNOWN_CATEGORIES.has(category)) {
    return null;
  }
  const sentence = category.toLowerCase().split("_").filter((word) => word !== "").join(" ");
  return sentence === "" ? null : sentence.charAt(0).toUpperCase() + sentence.slice(1);
}
