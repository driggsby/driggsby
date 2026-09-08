// The files `driggsby init` scaffolds: a no-build static app plus the
// driggsby.json that names it. The app renders obviously-synthetic sample
// data on its own, and live Driggsby data once a Driggsby host embeds it
// (`driggsby dev` locally, or the Driggsby console after a deploy). The
// sample values below are invented for the template and match the real
// tool result shapes only in structure, so the scaffold's render functions
// work unchanged when live data replaces them. The HTML ships a skeleton
// of the final layout so the first paint — in every context, before any
// script runs — is muted bars that the first render replaces, fading in
// at the exact same size so nothing shifts.

export function indexHtml(slug: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${slug}</title>
  <link rel="stylesheet" href="styles.css">
</head>
<body>
  <main>
    <header>
      <h1>${slug}</h1>
    </header>
    <!-- The bars below are skeleton placeholders. app.js replaces them
         with data on its first render; edit the render functions there,
         and keep the four stat bars in step with what renderOverview
         draws. (The account rows are just a plausible list length —
         the real count comes from the data.) -->
    <section aria-label="Overview">
      <div class="stat-grid" id="overview" aria-busy="true">
        <div class="stat">
          <div class="skeleton skeleton-label"></div>
          <div class="skeleton skeleton-value"></div>
        </div>
        <div class="stat">
          <div class="skeleton skeleton-label"></div>
          <div class="skeleton skeleton-value"></div>
        </div>
        <div class="stat">
          <div class="skeleton skeleton-label"></div>
          <div class="skeleton skeleton-value"></div>
        </div>
        <div class="stat">
          <div class="skeleton skeleton-label"></div>
          <div class="skeleton skeleton-value"></div>
        </div>
      </div>
    </section>
    <section aria-label="Accounts">
      <h2>Accounts</h2>
      <div id="accounts" aria-busy="true">
        <div class="account-row">
          <div class="account-names">
            <div class="skeleton skeleton-name"></div>
            <div class="skeleton skeleton-institution"></div>
          </div>
          <div class="skeleton skeleton-balance"></div>
        </div>
        <div class="account-row">
          <div class="account-names">
            <div class="skeleton skeleton-name"></div>
            <div class="skeleton skeleton-institution"></div>
          </div>
          <div class="skeleton skeleton-balance"></div>
        </div>
        <div class="account-row">
          <div class="account-names">
            <div class="skeleton skeleton-name"></div>
            <div class="skeleton skeleton-institution"></div>
          </div>
          <div class="skeleton skeleton-balance"></div>
        </div>
      </div>
    </section>
  </main>
  <script type="module" src="/-/driggsby-sdk.js"></script>
  <script type="module" src="app.js"></script>
</body>
</html>
`;
}

export const APP_JS = `// Your app's code. Edit anything — driggsby dev reloads the page on save.
//
// Reading data is one call:
//
//   driggsby.watch(tool, params, callback)
//
// Each watch is a live subscription: the callback runs with a fresh result
// whenever your Driggsby data changes. The sample data below matches the
// real result shapes, so the render functions work unchanged either way.
//
// These are the tools an app can watch — read-only, nothing else responds:
//
//   get_overview                 money rollups + every linked account
//   get_history                  balances, holdings, or debts over time
//                                (history_type is required: "account_balances",
//                                "investment_holdings", or "liabilities")
//   list_accounts                current balances per linked account
//   list_assets_and_liabilities  the full balance sheet, incl. manual items
//   list_findings                issues Driggsby has flagged
//   list_investment_holdings     current investment positions
//   list_outstanding_debts       linked debts with balances and rates
//   list_recurring_transactions  subscriptions, bills, and paychecks
//   query_cash_sql               SQL over cash transactions ({ sql: "..." })
//   query_investment_sql         SQL over investment activity ({ sql: "..." })
//   search_cash_transactions     bank and card transaction search
//   search_investment_activity   trades, dividends, and transfers
//
// Params mirror Driggsby's public MCP tools of the same names, with one
// simplification: those tools require a "reason" string, but a watch can
// leave it out — Driggsby fills one in naming the dashboard.
//
// To see a tool's exact result shape before writing render code, run it
// once from the terminal — the JSON it prints is what the callback gets:
//
//   npx driggsby@latest query <tool>

// ---------------------------------------------------------------------------
// Sample data. Every name and number here is invented. It paints only
// when this page is opened on its own, outside Driggsby.
// ---------------------------------------------------------------------------

const SAMPLE_OVERVIEW = {
  summary_rollups: {
    net_worth_estimate: { amount: "52340.00", currency_code: "USD" },
    cash: { amount: "8120.00", currency_code: "USD" },
    total_assets: { amount: "61540.00", currency_code: "USD" },
    total_liabilities: { amount: "9200.00", currency_code: "USD" }
  }
};

const SAMPLE_ACCOUNTS = {
  linked_accounts: [
    {
      institution_name: "Sample Bank",
      account_display_name: "Everyday Checking",
      account_mask_last4: "1111",
      current_balance: { amount: "5120.00", currency_code: "USD" }
    },
    {
      institution_name: "Sample Bank",
      account_display_name: "Rainy Day Savings",
      account_mask_last4: "2222",
      current_balance: { amount: "3000.00", currency_code: "USD" }
    },
    {
      institution_name: "Sample Card",
      account_display_name: "Travel Card",
      account_mask_last4: "1212",
      current_balance: { amount: "9200.00", currency_code: "USD" }
    }
  ]
};

// ---------------------------------------------------------------------------
// Rendering. Data lands via textContent, never innerHTML, so a value can
// only ever read as text.
// ---------------------------------------------------------------------------

function formatMoney(value) {
  if (!value || typeof value.amount !== "string") return "—";
  const number = Number(value.amount);
  if (!Number.isFinite(number)) return "—";
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: value.currency_code || "USD"
  }).format(number);
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

// The page ships with a skeleton of this exact layout in its HTML — muted
// bars where the numbers will be — so the very first paint is already the
// final shape. The first render into a container replaces its skeleton and
// fades in, so data arriving reads as the page settling, never as content
// popping. classList.add is idempotent and re-adding a class never restarts
// its animation, so later live updates repaint in place without re-fading.
// aria-busy ships in the HTML so assistive tech hears "loading" until the
// first real content lands.
function revealOnce(container) {
  container.classList.add("fade-in");
  container.removeAttribute("aria-busy");
}

function renderOverview(result) {
  const rollups = (result && result.summary_rollups) || {};
  const container = document.getElementById("overview");
  container.replaceChildren();
  const stats = [
    ["Net worth", rollups.net_worth_estimate],
    ["Cash", rollups.cash],
    ["Assets", rollups.total_assets],
    ["Liabilities", rollups.total_liabilities]
  ];
  for (const [label, value] of stats) {
    const stat = element("div", "stat");
    stat.append(
      element("div", "stat-label", label),
      element("div", "stat-value", formatMoney(value))
    );
    container.append(stat);
  }
  revealOnce(container);
}

function renderAccounts(result) {
  const accounts = (result && result.linked_accounts) || [];
  const container = document.getElementById("accounts");
  container.replaceChildren();
  for (const account of accounts) {
    const row = element("div", "account-row");
    const names = element("div", "account-names");
    const mask = account.account_mask_last4;
    names.append(
      element("div", "account-name", account.account_display_name || "Account"),
      element(
        "div",
        "account-institution",
        (account.institution_name || "") + (mask ? " ····" + mask : "")
      )
    );
    row.append(names, element("div", "account-balance", formatMoney(account.current_balance)));
    container.append(row);
  }
  revealOnce(container);
}

// ---------------------------------------------------------------------------
// Live data. window.driggsby exists when the Driggsby SDK loaded — inside
// Driggsby, or under driggsby dev. Whether anything embeds this page is
// knowable synchronously: opened directly in a tab, no host will ever
// answer, so the sample data replaces the skeleton right away, and the SDK
// shows its own notice explaining that the page runs with real data only
// inside Driggsby. Embedded, sample numbers never paint at all — the
// shipped skeleton holds the layout until the first real results replace
// it and fade in.
// ---------------------------------------------------------------------------

const standalone = window.parent === window;

if (standalone) {
  renderOverview(SAMPLE_OVERVIEW);
  renderAccounts(SAMPLE_ACCOUNTS);
}

if (window.driggsby) {
  driggsby.watch("get_overview", {}, (result) => {
    renderOverview(result);
  });
  driggsby.watch("list_accounts", {}, (result) => {
    renderAccounts(result);
  });
}
`;

export const STYLES_CSS = `:root {
  --background: #ffffff;
  --text: #1f2430;
  --text-muted: #6d7280;
  --hairline: #e6e8ec;
}

* {
  box-sizing: border-box;
}

body {
  margin: 0;
  background: var(--background);
  color: var(--text);
  font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
  font-size: 15px;
  line-height: 1.5;
}

main {
  max-width: 720px;
  margin: 0 auto;
  padding: 48px 24px 64px;
}

h1 {
  margin: 0;
  font-size: 22px;
  font-weight: 600;
}

h2 {
  margin: 40px 0 4px;
  font-size: 15px;
  font-weight: 600;
}

/* The skeleton ships in the HTML so the first paint is the final layout as
   muted bars; the first render replaces it and fades in (see app.js). The
   bar margins make each skeleton block exactly the height of the text it
   stands in for, so nothing shifts when data lands. */
.skeleton {
  border-radius: 4px;
  background: var(--hairline);
  animation: skeleton-pulse 1.6s ease-in-out infinite;
}

.skeleton-label {
  width: 64px;
  height: 12px;
  margin: 3.75px 0 0;
}

.skeleton-value {
  width: 96px;
  height: 20px;
  margin: 8.75px 0 5px;
}

.skeleton-name {
  width: 150px;
  height: 14px;
  margin: 4px 0 8px;
}

.skeleton-institution {
  width: 110px;
  height: 12px;
  margin: 4px 0;
}

.skeleton-balance {
  width: 72px;
  height: 14px;
}

@keyframes skeleton-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.55; }
}

.fade-in {
  animation: fade-in 200ms ease-out;
}

@keyframes fade-in {
  from { opacity: 0; }
  to { opacity: 1; }
}

@media (prefers-reduced-motion: reduce) {
  .skeleton,
  .fade-in {
    animation: none;
  }
}

.stat-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
  gap: 20px;
  margin-top: 32px;
}

.stat-label {
  font-size: 13px;
  color: var(--text-muted);
}

.stat-value {
  font-size: 20px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}

.account-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 12px 0;
  border-top: 1px solid var(--hairline);
}

.account-row:first-child {
  border-top: none;
}

.account-institution {
  font-size: 13px;
  color: var(--text-muted);
}

.account-balance {
  font-variant-numeric: tabular-nums;
}
`;

// "background" is the template's own page background (styles.css
// --background): Driggsby paints it while the app loads, so the loading
// surface matches the app from the first frame. An agent that re-themes
// the app should keep this equal to the page's real background color.
export function driggsbyJsonText(slug: string): string {
  return `{\n  "slug": ${JSON.stringify(slug)},\n  "serve": ".",\n  "background": "#ffffff"\n}\n`;
}
