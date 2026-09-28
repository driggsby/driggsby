// The scaffolded app.js, executed. The templates are string literals —
// invisible to tsc and ESLint — so these tests parse the code and run it
// against a DOM stub just wide enough to observe what it painted: the
// no-flash invariant (sample numbers only when genuinely standalone),
// the skeleton-to-data settle, and the render functions' hostile-input
// posture.
import assert from "node:assert/strict";
import { test } from "node:test";

import { transformSync } from "esbuild";

import { APP_JS } from "./templates.ts";
import { holdsNoSkeleton, runScaffoldAppJs } from "./test-support/scaffold-harness.ts";

// The scaffold's app code is browser JavaScript stored as a string literal,
// invisible to tsc and ESLint; this parse gate turns a syntax slip in a
// template edit into a red build instead of a broken scaffold.
test("the scaffolded app.js parses as JavaScript", () => {
  assert.doesNotThrow(() => transformSync(APP_JS, { loader: "js" }));
});

test("standalone, the scaffold paints sample data", () => {
  const run = runScaffoldAppJs({ embedded: false, sdkLoaded: false });
  assert.equal(run.overview.children.length, 4, "the four sample stats must paint");
  assert.equal(run.accounts.children.length, 3, "the three sample accounts must paint");
  assert.ok(
    holdsNoSkeleton(run.overview, run.overviewSkeleton) &&
      holdsNoSkeleton(run.accounts, run.accountsSkeleton),
    "the sample render must replace the skeleton, not stack under it",
  );
  assert.ok(
    !run.overview.attributes.has("aria-busy") && !run.accounts.attributes.has("aria-busy"),
    "aria-busy must clear once content lands",
  );
});

test("embedded, the shipped skeleton stands untouched until real data replaces it", () => {
  const run = runScaffoldAppJs({ embedded: true, sdkLoaded: true });
  // Before data arrives the script must not touch the containers: the
  // HTML-shipped skeleton stays, still marked busy — no sample values,
  // no loading text.
  assert.deepEqual(run.overview.children, run.overviewSkeleton, "the skeleton must survive");
  assert.deepEqual(run.accounts.children, run.accountsSkeleton, "the skeleton must survive");
  assert.equal(run.overview.attributes.get("aria-busy"), "true", "still busy before data");

  // The first real results replace the skeleton (this run has no
  // startViewTransition stub, so it exercises the instant fallback path).
  const overviewCallback = run.watches.get("get_overview");
  const accountsCallback = run.watches.get("list_accounts");
  assert.ok(overviewCallback, "the scaffold must watch get_overview");
  assert.ok(accountsCallback, "the scaffold must watch list_accounts");
  overviewCallback({
    summary_rollups: { cash: { amount: "10.00", currency_code: "USD" } },
  });
  accountsCallback({
    linked_accounts: [
      {
        institution_name: "Test Bank",
        account_display_name: "Checking",
        account_mask_last4: "1111",
        current_balance: { amount: "1.00", currency_code: "USD" },
      },
    ],
  });
  assert.equal(run.overview.children.length, 4);
  assert.equal(run.accounts.children.length, 1);
  assert.ok(
    holdsNoSkeleton(run.overview, run.overviewSkeleton) &&
      holdsNoSkeleton(run.accounts, run.accountsSkeleton),
    "real data must replace the skeleton, not stack under it",
  );
  const row = run.accounts.children[0];
  assert.ok(row, "the real account row must render");
  // Row shape: glyph pill (the institution's initial), names, balance.
  const glyph = row.children[0];
  assert.ok(glyph, "the glyph pill must render");
  assert.equal(glyph.textContent, "T");
  assert.equal(
    glyph.attributes.get("aria-hidden"),
    "true",
    "the glyph is decorative; the institution is read out on the next line",
  );
  assert.equal(row.children[1]?.children[0]?.textContent, "Checking");
  assert.equal(row.children[2]?.textContent, "$1.00", "the balance cell must render last");
  assert.ok(
    !run.overview.attributes.has("aria-busy") && !run.accounts.attributes.has("aria-busy"),
    "aria-busy must clear once real content lands",
  );
});

test("malformed account data renders as absent, and never breaks the page", () => {
  const run = runScaffoldAppJs({ embedded: true, sdkLoaded: true });
  const accountsCallback = run.watches.get("list_accounts");
  assert.ok(accountsCallback, "the scaffold must watch list_accounts");
  // A null entry is skipped; an entry with non-string fields and a bad
  // currency renders with fallbacks, never "[object Object]" or a throw.
  accountsCallback({
    linked_accounts: [
      null,
      {
        institution_name: 123,
        account_display_name: {},
        account_mask_last4: ["1111"],
        current_balance: { amount: "1.00", currency_code: "NOT_A_CODE" },
      },
    ],
  });
  assert.equal(run.accounts.children.length, 1, "only the object entry renders");
  const row = run.accounts.children[0];
  assert.ok(row, "the surviving row must render");
  assert.equal(row.children[0]?.textContent, "?", "no name means the glyph falls back");
  const names = row.children[1];
  assert.ok(names, "the names column must render");
  assert.equal(names.children[0]?.textContent, "Account");
  assert.equal(names.children[1]?.textContent, "", "non-strings never paint");
  assert.equal(row.children[2]?.textContent, "—", "a bad currency renders as absent");

  // A result whose list is not an array paints the empty state, not a crash.
  accountsCallback({ linked_accounts: "garbage" });
  const emptyRow = run.accounts.children[0];
  assert.ok(emptyRow, "the empty state must render for a non-array result");
  assert.equal(emptyRow.className, "empty-row");
});

test("an empty accounts result renders the empty state, not a bare box", () => {
  const run = runScaffoldAppJs({ embedded: true, sdkLoaded: true });
  const accountsCallback = run.watches.get("list_accounts");
  assert.ok(accountsCallback, "the scaffold must watch list_accounts");
  accountsCallback({ linked_accounts: [] });
  assert.equal(run.accounts.children.length, 1);
  const emptyRow = run.accounts.children[0];
  assert.ok(emptyRow, "the empty state row must render");
  assert.equal(emptyRow.textContent, "No linked accounts yet.");
  assert.equal(emptyRow.className, "empty-row");
  assert.ok(!run.accounts.attributes.has("aria-busy"), "aria-busy must clear on the empty state");
});

// The dissolve, driven step by step. With View Transitions available, a
// section's first paint waits one short beat so results landing together
// settle in a single dissolve; the newest result wins while the beat is
// pending; later results repaint in place with no transition at all.
test("first results settle together in one dissolve, later results repaint directly", () => {
  const run = runScaffoldAppJs({ embedded: true, sdkLoaded: true, viewTransitions: true });
  const overviewCallback = run.watches.get("get_overview");
  const accountsCallback = run.watches.get("list_accounts");
  assert.ok(overviewCallback, "the scaffold must watch get_overview");
  assert.ok(accountsCallback, "the scaffold must watch list_accounts");

  overviewCallback({ summary_rollups: { cash: { amount: "1.00", currency_code: "USD" } } });
  accountsCallback({ linked_accounts: [] });
  overviewCallback({ summary_rollups: { cash: { amount: "2.00", currency_code: "USD" } } });

  assert.deepEqual(run.overview.children, run.overviewSkeleton, "nothing paints before the beat");
  assert.equal(run.timers.length, 1, "one beat covers both sections' first results");
  assert.equal(run.transitions.length, 0, "no dissolve starts before the beat ends");

  run.timers[0]?.();
  assert.equal(run.transitions.length, 1, "both first paints share one dissolve");
  assert.deepEqual(run.overview.children, run.overviewSkeleton, "the paint waits for the dissolve");

  run.transitions[0]?.();
  assert.equal(run.overview.children.length, 4, "the overview painted inside the dissolve");
  assert.equal(
    run.overview.children[1]?.children[1]?.textContent,
    "$2.00",
    "the newest result before the beat is the one that paints",
  );
  assert.equal(
    run.accounts.children[0]?.className,
    "empty-row",
    "the accounts painted inside the same dissolve",
  );
  assert.ok(!run.overview.attributes.has("aria-busy"), "aria-busy clears with the dissolve");

  overviewCallback({ summary_rollups: { cash: { amount: "3.00", currency_code: "USD" } } });
  const cashStat = run.overview.children[1];
  assert.ok(cashStat, "the cash stat must still be on the page");
  assert.equal(cashStat.children[1]?.textContent, "$3.00", "a later result repaints in place");
  assert.equal(run.timers.length, 1, "no new beat for later results");
  assert.equal(run.transitions.length, 1, "no new dissolve for later results");
});

// The scaffold is meant to be edited; a bug someone introduces into one
// section's render must stay that section's problem. The throw is
// reported via console.error and the other section still paints inside
// the same dissolve.
test("one section's render throwing never blocks the other section's paint", () => {
  const run = runScaffoldAppJs({ embedded: true, sdkLoaded: true, viewTransitions: true });
  const overviewCallback = run.watches.get("get_overview");
  const accountsCallback = run.watches.get("list_accounts");
  assert.ok(overviewCallback, "the scaffold must watch get_overview");
  assert.ok(accountsCallback, "the scaffold must watch list_accounts");

  // Sabotage the overview container the way a mid-edit render bug would
  // land: its first DOM touch throws.
  run.overview.replaceChildren = (): void => {
    throw new Error("render bug");
  };
  overviewCallback({ summary_rollups: { cash: { amount: "1.00", currency_code: "USD" } } });
  accountsCallback({ linked_accounts: [] });
  run.timers[0]?.();
  run.transitions[0]?.();

  assert.equal(
    run.accounts.children[0]?.className,
    "empty-row",
    "the healthy section painted inside the same dissolve",
  );
  assert.equal(run.errors.length, 1, "the throw was reported, not swallowed silently");
  assert.deepEqual(
    run.overview.children,
    run.overviewSkeleton,
    "the broken section keeps its skeleton until its next result",
  );
});

// The half of the reduced-motion story that carries the weight:
// styles.css only stills the skeleton pulse, and it is this branch that
// keeps the dissolve itself out of a reduced-motion viewer's way.
test("reduced motion paints the first results instantly, with no dissolve", () => {
  const run = runScaffoldAppJs({
    embedded: true,
    sdkLoaded: true,
    viewTransitions: true,
    reducedMotion: true,
  });
  const overviewCallback = run.watches.get("get_overview");
  assert.ok(overviewCallback, "the scaffold must watch get_overview");

  overviewCallback({ summary_rollups: { cash: { amount: "1.00", currency_code: "USD" } } });
  assert.equal(run.overview.children.length, 4, "the first result paints synchronously");
  assert.equal(run.timers.length, 0, "no beat is scheduled");
  assert.equal(run.transitions.length, 0, "no dissolve runs");
});
