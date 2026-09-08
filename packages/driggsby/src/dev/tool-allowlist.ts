// The read-only tools a Driggsby app may call. This mirrors the allowlist
// Driggsby enforces server-side for embedded apps; the dev host enforces it
// too so an app that works locally works identically after deploy, and a
// disallowed call never even reaches Driggsby.
export const APP_TOOL_ALLOWLIST: ReadonlySet<string> = new Set([
  "get_history",
  "get_overview",
  "list_accounts",
  "list_assets_and_liabilities",
  "list_findings",
  "list_investment_holdings",
  "list_outstanding_debts",
  "list_recurring_transactions",
  "query_cash_sql",
  "query_investment_sql",
  "search_cash_transactions",
  "search_investment_activity",
]);

// The two tools that take SQL. `--sql` on the query command applies only to
// these, and a retry line names --sql only for them.
export const SQL_TOOLS: ReadonlySet<string> = new Set(["query_cash_sql", "query_investment_sql"]);
