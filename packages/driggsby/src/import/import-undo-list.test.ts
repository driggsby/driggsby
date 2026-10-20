import assert from "node:assert/strict";
import { test } from "node:test";

import { makeEnvironment } from "../deploy/test-support/deploy-command-harness.ts";
import { runImport } from "./import-command.ts";
import { importView, LANDED, startFakeDriggsby } from "./test-support/fake-driggsby.ts";
import { csvFile, io, REF } from "./test-support/import-harness.ts";

test("undo shows what it would remove and changes nothing; --yes undoes and waits for the end", async () => {
  const done = importView({ state: "done", ...LANDED, categorized: true });
  const preview = { undoable: true, transactions: 398, edited: 3, kept_for_later_imports: 0, account_removed: true };
  let state = "done";
  const fake = await startFakeDriggsby({
    tool: (seen) => {
      if (seen.name === "undo_statement_import" && seen.arguments.confirm === true) {
        state = "undoing";
        return { ok: { import: { ...done, state } } };
      }
      if (seen.name === "undo_statement_import") return { ok: { import: done, undo: preview } };
      const view = { ...done, state };
      state = state === "undoing" ? "undone" : state;
      return { ok: { import: view } };
    },
  });
  try {
    const out = io();
    assert.equal(await runImport({ action: "undo", target: REF, yes: false }, await makeEnvironment(fake.baseUrl), out), 0);
    assert.equal(fake.tools.filter((seen) => seen.arguments.confirm === true).length, 0);
    assert.equal(
      out.text(),
      `Not undone yet: undoing "made-up-export.csv" would remove 398 transactions.\n\n` +
        `  They're the transactions it added to "Northwind Pay ••2222", and 3 were\n` +
        "  edited since. Importing the file again brings the transactions back, but\n" +
        "  not those edits. The account it made goes too, since nothing else is in\n" +
        "  it. If you're working for someone, check with them first.\n\n" +
        `Next, to undo it:\n  npx driggsby@latest import undo ${REF} --yes\n`,
    );

    const yes = io();
    assert.equal(await runImport({ action: "undo", target: REF, yes: true }, await makeEnvironment(fake.baseUrl), yes), 0);
    assert.equal(yes.text(), `Undone: "made-up-export.csv": removed 398 transactions from "Northwind Pay ••2222".\n`);
  } finally {
    await fake.close();
  }
});

test("undo on an import still waiting for an answer cancels it and follows the cancel to its end", async () => {
  const waiting = importView({ state: "waiting", question: { kind: "date_order", prompt: "Day first?", choices: [] } });
  let state = "waiting";
  const fake = await startFakeDriggsby({
    tool: (seen) => {
      if (seen.name === "undo_statement_import" && seen.arguments.confirm === true) {
        state = "undoing";
        return { ok: { import: importView({ state }) } };
      }
      if (seen.name === "undo_statement_import") return { ok: { import: waiting, undo: { undoable: true, cancels: true } } };
      const view = state === "undoing" ? importView({ state: "undone", undone_at: "2026-10-19T15:02:00Z" }) : waiting;
      return { ok: { import: view } };
    },
  });
  try {
    const out = io();
    assert.equal(await runImport({ action: "undo", target: REF, yes: true }, await makeEnvironment(fake.baseUrl), out), 0);
    assert.equal(out.text(), `Undone: "made-up-export.csv" was cancelled before anything landed, and its file is deleted.\n`);
  } finally {
    await fake.close();
  }
});

test("list shows recent imports and the command for anything that needs attention", async () => {
  const fake = await startFakeDriggsby({
    tool: () => ({
      ok: {
        imports: [
          importView({ import_ref: "imp_3hd9lpaaaaaa", file: "card-2026.csv", state: "waiting" }),
          importView({ state: "categorizing", progress: { categorized: 310, total: 398, seconds_left: null }, ...LANDED }),
          importView({ import_ref: "imp_q81fzaaaaaaa", state: "undone", started_at: "2026-10-12T10:00:00Z" }),
          { import_ref: "not-a-ref", state: "done" },
        ],
      },
    }),
  });
  try {
    const out = io();
    assert.equal(await runImport({ action: "list" }, await makeEnvironment(fake.baseUrl), out), 0);
    assert.equal(
      out.text(),
      "Your recent imports, newest first:\n\n" +
        `  imp_3hd9lpaaaaaa  waiting for an answer  "card-2026.csv"       Oct 19\n` +
        `  ${REF}  categorizing, 310/398  "made-up-export.csv"  Oct 19\n` +
        `  imp_q81fzaaaaaaa  undone                 "made-up-export.csv"  Oct 12\n\n` +
        "Needs attention:\n  npx driggsby@latest import imp_3hd9lpaaaaaa\n",
    );
  } finally {
    await fake.close();
  }
});

test("undo while categories fill in says when it works; a repeated undo is never a failure", async () => {
  const states: Record<string, unknown> = {
    categorizing: { undoable: false, message: "This import is still running. Undo it once it has finished." },
    undoing: { undoable: false, message: "This import is already being undone." },
    undone: { undoable: false, message: "This import was already undone." },
  };
  let state = "categorizing";
  const fake = await startFakeDriggsby({
    tool: (seen) =>
      seen.name === "undo_statement_import"
        ? { ok: { import: importView({ state, ...LANDED }), undo: states[state] } }
        : seen.arguments.sha256 !== undefined
          ? { refused: "No import of that file is on this account yet.", details: { code: "not_found" } }
          : { ok: { import: importView({ state, ...LANDED }) } },
  });
  try {
    const running = io();
    assert.equal(await runImport({ action: "undo", target: REF, yes: true }, await makeEnvironment(fake.baseUrl), running), 0);
    assert.equal(
      running.text(),
      `Not undone yet: "made-up-export.csv" is still categorizing, and undo works once that finishes.\n\n` +
        `Next, run the first until it says Done or asks a question, then the second:\n  npx driggsby@latest import ${REF} --wait\n  npx driggsby@latest import undo ${REF}\n`,
    );
    assert.equal(fake.tools.filter((seen) => seen.arguments.confirm === true).length, 0);

    state = "undoing";
    const undoing = io();
    assert.equal(await runImport({ action: "undo", target: REF, yes: true }, await makeEnvironment(fake.baseUrl), undoing), 0);
    assert.match(undoing.text(), /^Undoing: removing the transactions "made-up-export\.csv" added\.\n/);

    state = "undone";
    const undone = io();
    assert.equal(await runImport({ action: "undo", target: REF, yes: true }, await makeEnvironment(fake.baseUrl), undone), 0);
    assert.equal(undone.text(), `Already undone: nothing "made-up-export.csv" added is left.\n`);

    const byFile = io();
    assert.equal(await runImport({ action: "undo", target: await csvFile(), yes: true }, await makeEnvironment(fake.baseUrl), byFile), 0);
    assert.equal(byFile.text(), "Nothing to undo: no import of this file is in Driggsby right now.\n");
  } finally {
    await fake.close();
  }
});

test("undo of a file too big to have been imported says there's nothing to undo", async () => {
  const fake = await startFakeDriggsby({});
  try {
    const big = await csvFile("big.csv", "x".repeat(10 * 1024 * 1024 + 1));
    const out = io();
    assert.equal(await runImport({ action: "undo", target: big, yes: true }, await makeEnvironment(fake.baseUrl), out), 0);
    assert.equal(out.text(), "Nothing to undo: no import of this file is in Driggsby right now.\n");
    assert.equal(fake.tools.length, 0);
  } finally {
    await fake.close();
  }
});

test("an undo Driggsby couldn't finish says so, removed nothing, and names the same command", async () => {
  const done = importView({ state: "done", ...LANDED, categorized: true });
  const fake = await startFakeDriggsby({
    tool: (seen) => {
      if (seen.name === "undo_statement_import" && seen.arguments.confirm === true) {
        return { ok: { import: { ...done, state: "undoing" } } };
      }
      if (seen.name === "undo_statement_import") {
        return { ok: { import: done, undo: { undoable: true, transactions: 398, edited: 0, kept_for_later_imports: 0, account_removed: false } } };
      }
      return { ok: { import: done } };
    },
  });
  try {
    const out = io();
    assert.equal(await runImport({ action: "undo", target: REF, yes: true }, await makeEnvironment(fake.baseUrl), out), 1);
    assert.equal(
      out.text(),
      `Not undone: Driggsby couldn't finish undoing it just now, and nothing was removed.\n\nNext:\n  npx driggsby@latest import undo ${REF} --yes\n`,
    );
  } finally {
    await fake.close();
  }
});

test("a cancel still under way says nothing of it had landed", async () => {
  const fake = await startFakeDriggsby({ tool: () => ({ ok: { import: importView({ state: "undoing" }) } }) });
  try {
    const out = io();
    await runImport({ action: "run", target: REF, wait: false, account: null, create: null, dates: null, amounts: null }, await makeEnvironment(fake.baseUrl), out);
    assert.match(out.text(), /^Undoing: cancelling "made-up-export\.csv"; nothing of it had landed\.\n/);
  } finally {
    await fake.close();
  }
});

// The accounts an import names, every page, each with its kind and ID; an
// entry with no usable ID is left out.
test("accounts list shows every account's kind and ID across pages, then how to import", async () => {
  const pages: Record<string, unknown>[] = [
    {
      linked_accounts: [
        { account_ref: "acct_7kq2", account_display_name: "Everyday Card", account_type: "credit", account_mask_last4: null },
        { account_ref: "not-a-ref", account_display_name: "Broken", account_type: "credit" },
      ],
      next_page_token: "page-2",
    },
    { linked_accounts: [{ account_ref: "acct_9xm4", account_display_name: "Everyday Checking", account_type: "depository", account_mask_last4: "1111" }] },
  ];
  const fake = await startFakeDriggsby({ tool: (seen) => ({ ok: seen.arguments.page_token === "page-2" ? pages[1] : pages[0] }) });
  try {
    const out = io();
    assert.equal(await runImport({ action: "accounts" }, await makeEnvironment(fake.baseUrl), out), 0);
    assert.deepEqual(
      fake.tools.map((seen) => [seen.name, seen.arguments]),
      [
        ["list_accounts", {}],
        ["list_accounts", { page_token: "page-2" }],
      ],
    );
    assert.equal(
      out.text(),
      `Your accounts (2):\n  "Everyday Card"\n    card · acct_7kq2\n  "Everyday Checking ····1111"\n    bank · acct_9xm4\n\n` +
        "Next, to import a statement into one:\n  npx driggsby@latest import <FILE> --account <ID>\n" +
        `Or into a new account:\n  npx driggsby@latest import <FILE> --create-account --account-type card --account-name "<NAME>"\n`,
    );
  } finally {
    await fake.close();
  }
});
