import assert from "node:assert/strict";
import { test } from "node:test";

import { makeEnvironment } from "../deploy/test-support/deploy-command-harness.ts";
import { runImport } from "./import-command.ts";
import { importView, LANDED, startFakeDriggsby } from "./test-support/fake-driggsby.ts";
import { csvFile, io, REF, run, sequence } from "./test-support/import-harness.ts";

// The same file sent again: nothing uploads, and nothing reads as a second
// import or a second account.

test("the same file again: nothing uploads, and it says the file is already in, never a second import", async () => {
  const path = await csvFile();
  let found = importView({ state: "categorizing", ...LANDED, new_account: true, progress: { categorized: 40, total: 398, seconds_left: 360 } });
  const fake = await startFakeDriggsby({ tool: () => ({ ok: { import: found } }) });
  try {
    const sorting = io();
    assert.equal(await runImport(run(path, { create: { type: "card", name: "Sample Card" } }), await makeEnvironment(fake.baseUrl), sorting), 0);
    assert.equal(
      sorting.text(),
      `Already imported: this file's 398 transactions are in "Northwind Pay ••2222" (${REF}). Categories: 40 of 398 so far, about 6 minutes left.\n\n` +
        `Nothing else to do unless you need the categories. To wait for them:\n  npx driggsby@latest import ${REF} --wait\n`,
    );

    found = importView({ state: "done", finished_at: "2026-10-19T15:25:00Z", categorized: true, ...LANDED });
    const out = io();
    assert.equal(await runImport(run(path), await makeEnvironment(fake.baseUrl), out), 0);
    assert.equal(fake.uploads.length, 0);
    assert.equal(
      out.text(),
      `Already done: this file's 398 transactions went into "Northwind Pay ••2222" on Oct 19 (${REF}). Nothing to do.\n`,
    );
  } finally {
    await fake.close();
  }
});

test("a file sent again that this run watched land shows what landed in full", async () => {
  const path = await csvFile();
  const landed = importView({ state: "categorizing", ...LANDED, new_account: true });
  const fake = await startFakeDriggsby({ tool: sequence([importView(), landed]) });
  try {
    const out = io();
    assert.equal(await runImport(run(path, { account: "acct_7kq2", wait: true }), await makeEnvironment(fake.baseUrl), out), 0);
    assert.equal(fake.uploads.length, 0);
    assert.match(out.text(), /^Imported: 398 transactions from "made-up-export\.csv" are in "Northwind Pay ••2222"\.\n/);
    assert.match(out.text(), /Next time, for this account:\n {2}npx driggsby@latest import <FILE> --account acct_made_up\n/);
  } finally {
    await fake.close();
  }
  const done = importView({ state: "done", finished_at: "2026-10-19T15:25:00Z", categorized: true, ...LANDED });
  const straight = await startFakeDriggsby({ tool: sequence([importView(), done]) });
  try {
    const out = io();
    assert.equal(await runImport(run(path, { account: "acct_7kq2", wait: true }), await makeEnvironment(straight.baseUrl), out), 0);
    assert.match(out.text(), /^Done: 398 transactions from "made-up-export\.csv" are in "Northwind Pay ••2222"\.\n/, "straight to done");
  } finally {
    await straight.close();
  }
});

test("one transaction is in its account", async () => {
  const path = await csvFile();
  const one = importView({ state: "categorizing", ...LANDED, counts: { new: 1, already_in_driggsby: 0, pending: 0 } });
  const fake = await startFakeDriggsby({ tool: () => ({ ok: { import: one } }) });
  try {
    const out = io();
    assert.equal(await runImport(run(path), await makeEnvironment(fake.baseUrl), out), 0);
    assert.match(out.text(), /^Already imported: this file's 1 transaction is in "Northwind Pay ••2222"/);
    const byId = io();
    assert.equal(await runImport(run(REF), await makeEnvironment(fake.baseUrl), byId), 0);
    assert.match(byId.text(), /^Imported: 1 transaction from "made-up-export\.csv" is in "Northwind Pay ••2222"\./);
  } finally {
    await fake.close();
  }
});
