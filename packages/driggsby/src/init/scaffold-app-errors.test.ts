// The scaffolded app.js when a call fails. A watch whose call fails never
// runs its callback; the SDK hands the failure to the watch's onError
// instead. Without one, the section's skeleton pulses on forever and the
// page looks like it is still loading, so every watch the scaffold starts
// passes one, and these tests hold the section to saying why.
import assert from "node:assert/strict";
import { test } from "node:test";

import { holdsNoSkeleton, runScaffoldAppJs, type StubNode } from "./test-support/scaffold-harness.ts";

const BUSY = { message: "Driggsby is busy right now. Try again in a minute.", kind: "busy" };

function problems(container: StubNode): StubNode[] {
  return container.children.filter((child) => child.className.split(" ").includes("problem"));
}

test("every watch the scaffold starts hands its failures to onError", () => {
  const run = runScaffoldAppJs({ embedded: true, sdkLoaded: true });
  assert.deepEqual([...run.watches.keys()].sort(), [...run.errorHandlers.keys()].sort());
  assert.ok(run.watches.size > 0, "the scaffold watches something");
});

test("a call that fails first replaces its section's skeleton with the reason", () => {
  const run = runScaffoldAppJs({ embedded: true, sdkLoaded: true });
  const failAccounts = run.errorHandlers.get("list_accounts");
  assert.ok(failAccounts, "the accounts watch passes onError");

  failAccounts(BUSY);
  assert.ok(holdsNoSkeleton(run.accounts, run.accountsSkeleton), "no pulsing bars left behind");
  const [note] = problems(run.accounts);
  assert.ok(note, "the section says why");
  assert.equal(run.accounts.children.length, 1, "the reason stands alone in the section");
  assert.equal(note.textContent, BUSY.message, "the SDK's own words, as text");
  assert.equal(note.attributes.get("role"), "status", "marked as a status for assistive tech");
  assert.equal(run.accounts.attributes.has("aria-busy"), false, "no longer announced as loading");
  assert.deepEqual(run.overview.children, run.overviewSkeleton, "the other section is untouched");
});

test("a section already showing data keeps it, says why under it, and heals on its next result", () => {
  const run = runScaffoldAppJs({ embedded: true, sdkLoaded: true });
  const showAccounts = run.watches.get("list_accounts");
  const failAccounts = run.errorHandlers.get("list_accounts");
  assert.ok(showAccounts && failAccounts);
  const result = {
    linked_accounts: [
      { institution_name: "Sample Bank", account_display_name: "Checking", current_balance: { amount: "1.00", currency_code: "USD" } },
      { institution_name: "Sample Bank", account_display_name: "Savings", current_balance: { amount: "2.00", currency_code: "USD" } }
    ]
  };

  showAccounts(result);
  failAccounts(BUSY);
  failAccounts({ message: "That call took too long.", kind: "timeout" });
  assert.equal(run.accounts.children.length, 3, "both rows stay, with one reason under them");
  assert.deepEqual(problems(run.accounts).map((note) => note.textContent), [ "That call took too long." ]);
  assert.equal(run.accounts.children.at(-1)?.className, "problem", "the reason sits under the rows");

  showAccounts(result);
  assert.equal(problems(run.accounts).length, 0, "a good result clears the reason");
  assert.equal(run.accounts.children.length, 2);
});

const ACCOUNTS = {
  linked_accounts: [
    { institution_name: "Sample Bank", account_display_name: "Checking", current_balance: { amount: "1.00", currency_code: "USD" } }
  ]
};

test("a section that failed first is healed by its next result, through the dissolve", () => {
  const run = runScaffoldAppJs({ embedded: true, sdkLoaded: true, viewTransitions: true });
  const showAccounts = run.watches.get("list_accounts");
  const failAccounts = run.errorHandlers.get("list_accounts");
  assert.ok(showAccounts && failAccounts);

  failAccounts(BUSY);
  showAccounts(ACCOUNTS);
  assert.equal(problems(run.accounts).length, 1, "the reason holds until the result paints");
  run.timers.shift()?.();
  run.transitions.shift()?.();
  assert.equal(problems(run.accounts).length, 0, "the result replaces the reason");
  assert.equal(run.accounts.children.length, 1, "and paints its row");
});

test("a failure that lands while the first result waits for its dissolve still shows, under that result", () => {
  const run = runScaffoldAppJs({ embedded: true, sdkLoaded: true, viewTransitions: true });
  const showAccounts = run.watches.get("list_accounts");
  const failAccounts = run.errorHandlers.get("list_accounts");
  assert.ok(showAccounts && failAccounts);

  showAccounts(ACCOUNTS);
  failAccounts(BUSY);
  run.timers.shift()?.();
  run.transitions.shift()?.();
  assert.equal(run.accounts.children.length, 2, "the row, and the reason under it");
  assert.equal(run.accounts.children.at(-1)?.textContent, BUSY.message);
});

test("a failure with no usable message still says the section didn't load", () => {
  const run = runScaffoldAppJs({ embedded: true, sdkLoaded: true });
  const failOverview = run.errorHandlers.get("get_overview");
  assert.ok(failOverview);

  failOverview({ message: { html: "<b>not text</b>" }, kind: null });
  const [note] = problems(run.overview);
  assert.ok(note);
  assert.equal(note.textContent, "This didn't load. It tries again when your data next changes.");
});
