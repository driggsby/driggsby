// The files `driggsby init` scaffolds: a no-build static app plus the
// driggsby.json that names it. The app renders obviously-synthetic sample
// data on its own, and live Driggsby data once a Driggsby host embeds it
// (`driggsby dev` locally, or the Driggsby console after a deploy). The
// sample values below are invented for the template and match the real
// tool result shapes only in structure, so the scaffold's render functions
// work unchanged when live data replaces them.

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
      <p class="sample-note" id="sample-note">Sample data — your real accounts
      appear when this app runs inside Driggsby.</p>
    </header>
    <section aria-label="Overview">
      <div class="stat-grid" id="overview"></div>
    </section>
    <section aria-label="Accounts">
      <h2>Accounts</h2>
      <div id="accounts"></div>
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

// ---------------------------------------------------------------------------
// Sample data. Every name and number here is invented. It renders only
// until real data arrives from Driggsby.
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
}

// ---------------------------------------------------------------------------
// Live data. window.driggsby exists when the Driggsby SDK loaded — inside
// Driggsby, or under driggsby dev. Standalone, the sample data stays and
// the note above explains why.
// ---------------------------------------------------------------------------

renderOverview(SAMPLE_OVERVIEW);
renderAccounts(SAMPLE_ACCOUNTS);

let overviewIsLive = false;
let accountsAreLive = false;

function removeSampleNoteWhenAllLive() {
  if (!overviewIsLive || !accountsAreLive) return;
  const note = document.getElementById("sample-note");
  if (note) note.remove();
}

if (window.driggsby) {
  driggsby.watch("get_overview", {}, (result) => {
    overviewIsLive = true;
    removeSampleNoteWhenAllLive();
    renderOverview(result);
  });
  driggsby.watch("list_accounts", {}, (result) => {
    accountsAreLive = true;
    removeSampleNoteWhenAllLive();
    renderAccounts(result);
  });
}
`;

export const STYLES_CSS = `:root {
  --background: #ffffff;
  --text: #1f2430;
  --text-muted: #6d7280;
  --hairline: #e6e8ec;
  --note-background: #fdf6e3;
  --note-text: #7a5b1e;
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

.sample-note {
  display: inline-block;
  margin: 12px 0 0;
  padding: 4px 10px;
  border-radius: 6px;
  background: var(--note-background);
  color: var(--note-text);
  font-size: 13px;
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

export function driggsbyJsonText(slug: string): string {
  return `{\n  "slug": ${JSON.stringify(slug)},\n  "serve": "."\n}\n`;
}
