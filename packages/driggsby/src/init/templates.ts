// The files `driggsby init` scaffolds: a no-build static app plus the
// driggsby.json that names it. The app renders obviously-synthetic sample
// data on its own, and live Driggsby data once a Driggsby host embeds it
// (`driggsby dev` locally, or the Driggsby console after a deploy). The
// sample values below are invented for the template and match the real
// tool result shapes only in structure, so the scaffold's render functions
// work unchanged when live data replaces them. The HTML ships a skeleton
// of the final layout so the first paint — in every context, before any
// script runs — is muted bars that the first render replaces at the exact
// same size, dissolving one into the other, so nothing shifts or pops.

export function indexHtml(slug: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${slug}</title>
  <link rel="preload" href="/-/inter.woff2" as="font" type="font/woff2" crossorigin>
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
          <div class="skeleton skeleton-glyph"></div>
          <div class="account-names">
            <div class="skeleton skeleton-name"></div>
            <div class="skeleton skeleton-institution"></div>
          </div>
          <div class="skeleton skeleton-balance"></div>
        </div>
        <div class="account-row">
          <div class="skeleton skeleton-glyph"></div>
          <div class="account-names">
            <div class="skeleton skeleton-name"></div>
            <div class="skeleton skeleton-institution"></div>
          </div>
          <div class="skeleton skeleton-balance"></div>
        </div>
        <div class="account-row">
          <div class="skeleton skeleton-glyph"></div>
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
//   driggsby.watch(tool, params, callback, { onError })
//
// Each watch is a live subscription: the callback runs with a fresh result
// whenever your Driggsby data changes, and onError runs instead when a call
// fails (see "When a call fails" below; watchSection wires one section
// that way, so add yours with it). The sample data below matches the real
// result shapes, so the render functions work unchanged either way.
//
// These are the tools an app can watch — read-only, nothing else responds:
//
//   get_overview                 money rollups + every linked account
//   get_history                  balances, holdings, debts, or manual items
//                                over time (history_type is required:
//                                "account_balances", "investment_holdings",
//                                "liabilities", or "custom_items")
//   list_accounts                current balances per linked account
//   list_assets_and_liabilities  the full balance sheet, incl. manual items
//   list_findings                issues Driggsby has flagged
//   list_investment_holdings     current investment positions
//   list_outstanding_debts       linked debts with balances and rates
//   list_recurring_transactions  subscriptions, bills, and paychecks
//   query_cash_sql               SQL over cash transactions ({ sql: "..." })
//   query_investment_sql         SQL over investment activity ({ sql: "..." })
//   query_item_sql               SQL over the items in itemized charges
//                                ({ sql: "..." })
//   search_cash_transactions     bank and card transaction search
//   search_investment_activity   trades, dividends, and transfers
//
// Params mirror Driggsby's public MCP tools of the same names; a watch
// needs no "reason".
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
  const currency = value.currency_code === undefined ? "USD" : value.currency_code;
  if (typeof currency !== "string") return "—";
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: currency
    }).format(number);
  } catch (error) {
    // An unknown currency code renders as absent, never as a guess in
    // the wrong currency — and never takes the rest of the page down.
    return "—";
  }
}

function asText(value) {
  return typeof value === "string" ? value : "";
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
    const figure = element("div", "stat-value", formatMoney(value));
    // Its length, so a long figure can shrink to fit its card while a
    // short one keeps its full size (see .stat-value in styles.css).
    figure.style.setProperty("--chars", String(figure.textContent.length));
    stat.append(element("div", "stat-label", label), figure);
    container.append(stat);
  }
  // aria-busy ships in the HTML so assistive tech hears "loading" until
  // the first content lands; every render clears it (harmless once gone).
  container.removeAttribute("aria-busy");
}

function renderAccounts(result) {
  const list = result && Array.isArray(result.linked_accounts) ? result.linked_accounts : [];
  const accounts = list.filter((account) => account && typeof account === "object");
  const container = document.getElementById("accounts");
  container.replaceChildren();
  if (accounts.length === 0) {
    container.append(element("div", "empty-row", "No linked accounts yet."));
    container.removeAttribute("aria-busy");
    return;
  }
  for (const account of accounts) {
    const row = element("div", "account-row");
    const names = element("div", "account-names");
    // Only strings paint; a malformed field renders as absent, never as
    // "[object Object]".
    const displayName = asText(account.account_display_name);
    const institution = asText(account.institution_name);
    const mask = asText(account.account_mask_last4);
    // The institution's initial on a round pill. Array.from keeps an
    // emoji-leading name from breaking the render (it splits by whole
    // character, not UTF-16 half).
    const initialSource = (institution || displayName).trim();
    const initial = (Array.from(initialSource)[0] || "?").toUpperCase();
    const institutionLine = [institution, mask ? "····" + mask : ""].filter(Boolean).join(" ");
    names.append(
      element("div", "account-name", displayName || "Account"),
      element("div", "account-institution", institutionLine)
    );
    const glyph = element("div", "account-glyph", initial);
    // Decorative: the institution's name is read out on the next line.
    glyph.setAttribute("aria-hidden", "true");
    row.append(
      glyph,
      names,
      element("div", "account-balance", formatMoney(account.current_balance))
    );
    container.append(row);
  }
  container.removeAttribute("aria-busy");
}

// ---------------------------------------------------------------------------
// Settling in. The first data a section shows replaces its skeleton in a
// dissolve: the browser snapshots the page, the paint lands, and old
// crossfades into new (a View Transition — pixels that did not change
// don't visibly change, so what reads as animating is the bars becoming
// numbers). The skeleton and the data measure identical (see styles.css),
// so the dissolve reads as the page coming into focus — never a blink, a
// shift, or a pop. Where the browser has no View Transitions, or the
// person prefers reduced motion, the swap is simply instant.
//
// The beat below covers sections whose data lands together (the common
// case). A section whose first data trails in later gets its own beat and
// its own dissolve; starting it skips whatever remained of the first one's
// animation — the paints always land, only the crossfade is cut short.
// ---------------------------------------------------------------------------

// How long a section's first paint may wait so sections whose data lands
// in the same beat dissolve in together instead of one by one.
const SETTLE_TOGETHER_MS = 50;

let pendingFirstPaints = [];
let settleFlushScheduled = false;

function settle(paint) {
  const reducedMotion =
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (typeof document.startViewTransition !== "function" || reducedMotion) {
    paint();
    return;
  }
  pendingFirstPaints.push(paint);
  if (settleFlushScheduled) return; // this paint rides the beat already in flight
  settleFlushScheduled = true;
  setTimeout(() => {
    // Collected inside the flush, which runs inside the transition
    // callback, so a first result that lands between the beat ending and
    // the snapshot being taken joins this dissolve instead of cutting it
    // short with a second one.
    const flush = () => {
      const paints = pendingFirstPaints;
      pendingFirstPaints = [];
      settleFlushScheduled = false;
      for (const apply of paints) {
        // One section's render must never stop another's: the scaffold
        // is meant to be edited, and a throw mid-edit stays that
        // section's problem — it heals on its own next result.
        try {
          apply();
        } catch (error) {
          console.error(error);
        }
      }
    };
    try {
      const transition = document.startViewTransition(flush);
      // A skipped transition (a hidden tab, a second dissolve starting)
      // still runs flush; only the animation is dropped. Without this,
      // the skip surfaces as an uncaught rejection in the console.
      transition.ready.catch(() => {});
    } catch (error) {
      // If starting the transition itself threw, nothing will call
      // flush; run it plain so the paints land and the beat resets.
      console.error(error);
      flush();
    }
  }, SETTLE_TOGETHER_MS);
}

// Wraps a render function for its watch: the first result goes through
// settle() above, and only the latest result paints if more arrive while
// that dissolve is still pending. Every later result repaints in place
// with no animation at all.
function settledRenderer(render) {
  let hasSettled = false;
  let firstPaintQueued = false;
  let latestResult;
  return (result) => {
    if (hasSettled) {
      render(result);
      return;
    }
    latestResult = result;
    if (firstPaintQueued) return;
    firstPaintQueued = true;
    settle(() => {
      hasSettled = true;
      render(latestResult);
    });
  };
}

// ---------------------------------------------------------------------------
// When a call fails. A watch whose call fails never runs its callback; it
// runs onError instead, with { message, kind }, once for each new failure.
// The section says why where its data would be: in place of its
// skeleton, so a failure never looks like a page still loading, or under
// the data it already shows, which stays. The watch asks again on its own
// the next time your data changes, and the next good result repaints the
// section, reason and all. A section counts as still loading while its
// container is aria-busy="true": the HTML ships every container that way,
// and every render clears it and replaces everything in its container,
// so keep all three true for a section you add.
// ---------------------------------------------------------------------------

function showProblem(containerId, error) {
  const container = document.getElementById(containerId);
  const message =
    error && typeof error.message === "string" && error.message
      ? error.message
      : "This didn't load. It tries again when your data next changes.";
  const note = element("div", "problem", message);
  note.setAttribute("role", "status");
  if (container.getAttribute("aria-busy") === "true") {
    container.replaceChildren(note);
    container.removeAttribute("aria-busy");
    return;
  }
  const earlier = container.querySelector(".problem");
  if (earlier) earlier.remove();
  container.append(note);
}

// One section's live data: its watch, its render, and its failures. A
// failure that lands while the section's first result waits for its
// dissolve still shows once that result paints, under it. It returns the
// watch's stop function: call it before watching the same section again
// with new params.
function watchSection(tool, params, containerId, render) {
  let problem = null;
  const paint = settledRenderer((result) => {
    render(result);
    if (problem) showProblem(containerId, problem);
  });
  return driggsby.watch(tool, params, (result) => {
    problem = null;
    paint(result);
  }, {
    onError: (error) => {
      problem = error;
      showProblem(containerId, error);
    }
  });
}

// ---------------------------------------------------------------------------
// Live data. window.driggsby exists when the Driggsby SDK loaded — inside
// Driggsby, or under driggsby dev. Whether anything embeds this page is
// knowable synchronously: opened directly in a tab, no host will ever
// answer, so the sample data replaces the skeleton right away, and the SDK
// shows its own notice explaining that the page runs with real data only
// inside Driggsby. Embedded, sample numbers never paint at all — the
// shipped skeleton holds the layout until the first real results replace
// it in a dissolve (see "Settling in" above).
// ---------------------------------------------------------------------------

const standalone = window.parent === window;

if (standalone) {
  renderOverview(SAMPLE_OVERVIEW);
  renderAccounts(SAMPLE_ACCOUNTS);
}

if (window.driggsby) {
  watchSection("get_overview", {}, "overview", renderOverview);
  watchSection("list_accounts", {}, "accounts", renderAccounts);
}
`;


// "background" is the template's own page background (styles.css
// --bg-app): Driggsby paints it while the app loads, so the loading
// surface matches the app from the first frame. An agent that re-themes
// the app should keep this equal to the page's real background color.
export function driggsbyJsonText(slug: string): string {
  return `{\n  "slug": ${JSON.stringify(slug)},\n  "serve": ".",\n  "background": "#000000"\n}\n`;
}
