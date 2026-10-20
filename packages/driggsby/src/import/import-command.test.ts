import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import { CliError } from "../cli-error.ts";
import { makeEnvironment } from "../deploy/test-support/deploy-command-harness.ts";
import { IMPORTS_NOT_AVAILABLE_MESSAGE } from "./import-client.ts";
import { type ImportCommandOptions, runImport, WAIT_MS } from "./import-command.ts";
import { shellWord } from "./import-target.ts";
import { importView, LANDED, startFakeDriggsby, type ToolAnswer } from "./test-support/fake-driggsby.ts";
import { CSV, csvFile, io, REF, run, sequence } from "./test-support/import-harness.ts";

// A printed path as a pattern: Windows temp paths carry backslashes, so the
// CLI quotes them, and the pattern takes them literally.
function escaped(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
}

test("a new file: Driggsby is asked for it by its bytes, then it uploads once and says how to wait", async () => {
  const path = await csvFile("Ünïcode activity.csv");
  const fake = await startFakeDriggsby({
    tool: () => ({ refused: "No import of that file is on this account yet.", details: { code: "not_found" } }),
    upload: () => ({ status: 201, payload: { import: importView({ file: "Ünïcode activity.csv" }) } }),
  });
  try {
    const out = io();
    assert.equal(await runImport(run(path, { account: "acct_7kq2" }), await makeEnvironment(fake.baseUrl), out), 0);

    assert.deepEqual(fake.tools[0], {
      name: "get_statement_import",
      arguments: { sha256: createHash("sha256").update(CSV).digest("hex"), account: "acct_7kq2" },
    });
    assert.equal(fake.uploads.length, 1);
    const sent = fake.uploads[0];
    assert.ok(sent);
    assert.equal(sent.bytes.toString("utf8"), CSV);
    assert.equal(sent.headers["driggsby-filename"], encodeURIComponent("Ünïcode activity.csv"));
    assert.equal(sent.headers["driggsby-account"], "acct_7kq2");
    assert.equal(sent.headers.origin, undefined, "never looks like a browser");
    assert.equal(
      out.text(),
      `Started: importing "Ünïcode activity.csv" as ${REF}.\n\n✓ Uploaded    412 lines, 38 KB\n\n` +
        "Driggsby is reading it now, which usually takes under a minute. Nothing\nlands in your accounts until it finishes.\n\n" +
        `Next:\n  npx driggsby@latest import ${REF} --wait\n`,
    );
  } finally {
    await fake.close();
  }
});

// A new account rides the upload as its type and name; with no account
// named, nothing uploads.
test("a new account rides the upload by type and name, and a file with no account named never uploads", async () => {
  const path = await csvFile();
  const fake = await startFakeDriggsby({
    tool: () => ({ refused: "No import of that file is on this account yet.", details: { code: "not_found" } }),
    upload: () => ({ status: 201, payload: { import: importView() } }),
  });
  try {
    await runImport(run(path, { create: { type: "card", name: "Sample's Card" } }), await makeEnvironment(fake.baseUrl), io());
    const sent = fake.uploads[0];
    assert.ok(sent);
    assert.deepEqual([sent.headers["driggsby-new-account-type"], sent.headers["driggsby-new-account-name"], sent.headers["driggsby-account"]], [
      "card",
      encodeURIComponent("Sample's Card"),
      undefined,
    ]);

    await assert.rejects(
      runImport(run(path), await makeEnvironment(fake.baseUrl), io()),
      (error: unknown) =>
        error instanceof CliError && error.exitCode === 2 && error.message.includes("--account <ID>") && error.message.endsWith("npx driggsby@latest accounts list"),
    );
    assert.equal(fake.uploads.length, 1);
  } finally {
    await fake.close();
  }
});

test("the same file again: nothing uploads, and a finished import says there's nothing to do", async () => {
  const path = await csvFile();
  const done = importView({ state: "done", finished_at: "2026-10-19T15:25:00Z", categorized: true, ...LANDED });
  const fake = await startFakeDriggsby({ tool: () => ({ ok: { import: done } }) });
  try {
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

test("--wait polls until the transactions are in, then shows what landed and how far categories are", async () => {
  const landed = importView({ state: "categorizing", ...LANDED, new_account: true, progress: { categorized: 40, total: 398, seconds_left: 360 } });
  const fake = await startFakeDriggsby({ tool: sequence([importView(), importView(), landed]) });
  try {
    const out = io();
    assert.equal(await runImport(run(REF, { wait: true }), await makeEnvironment(fake.baseUrl), out), 0);
    assert.equal(fake.tools.length, 3);
    assert.equal(out.slept(), 6_000, "two polls, three seconds apart");
    assert.equal(
      out.text(),
      `Imported: 398 transactions from "made-up-export.csv" are in "Northwind Pay ••2222".\n\n` +
        "✓ Read        412 lines, Jun 1 – Oct 15, 2026\n" +
        `✓ Account     "Northwind Pay ••2222" (a new account)\n` +
        "✓ Imported    398 new · 14 already in Driggsby, skipped\n" +
        "● Categories  40 of 398 so far, about 6 minutes left\n" +
        "· Left out    1 pending charge · 1 balance line\n\n" +
        `Next time, for this account:\n  npx driggsby@latest import <FILE> --account acct_made_up\n\n` +
        "The transactions are usable now, and categories fill in on their own.\n" +
        "Nothing else to do unless you need the categories (for a spending summary,\nsay). To wait for them:\n" +
        `  npx driggsby@latest import ${REF} --wait\n\n` +
        `If it went into the wrong account, undo it once categories finish:\n  npx driggsby@latest import undo ${REF}\n`,
    );
  } finally {
    await fake.close();
  }
});

test("--wait never runs past 90 seconds: a slow read says so and names the same command", async () => {
  const fake = await startFakeDriggsby({ tool: () => ({ ok: { import: importView() } }) });
  try {
    const out = io();
    assert.equal(await runImport(run(REF, { wait: true }), await makeEnvironment(fake.baseUrl), out), 0);
    assert.ok(out.slept() <= WAIT_MS, `waited ${String(out.slept())}ms`);
    assert.match(out.text(), /^Still reading: "made-up-export\.csv", started \dm \d+s ago\.\n/);
    assert.match(out.text(), new RegExp(`Next:\\n  npx driggsby@latest import ${REF} --wait\\n$`));
  } finally {
    await fake.close();
  }
});

test("a question tells the agent to ask, and prints one complete command per answer", async () => {
  const waiting = importView({
    state: "waiting",
    question: {
      kind: "date_order",
      prompt: "Are the dates in this file day first (31/12) or month first (12/31)?",
      choices: [
        { label: "Day first (31/12/2026)", answer: { dates: "day-first" } },
        { label: "Month first (12/31/2026)", answer: { dates: "month-first" } },
        { label: "Broken", answer: { dates: "x; rm -rf /" } },
        { label: "An account", answer: { account: "acct_7kq2" } },
      ],
    },
  });
  const fake = await startFakeDriggsby({ tool: () => ({ ok: { import: waiting } }) });
  try {
    const out = io();
    assert.equal(await runImport(run(REF, { wait: true }), await makeEnvironment(fake.baseUrl), out), 0);
    assert.equal(out.slept(), 0, "a waiting import answers at once");
    assert.match(out.text(), /^Waiting for an answer about "made-up-export\.csv": Are the dates in this file day first \(31\/12\) or month first \(12\/31\)\?\n\n\? Every date/);
    assert.ok(
      out.text().endsWith(
        "Next, run the command for the answer:\n" +
          `  "Day first (31/12/2026)"\n    npx driggsby@latest import ${REF} --dates day-first --wait\n` +
          `  "Month first (12/31/2026)"\n    npx driggsby@latest import ${REF} --dates month-first --wait\n`,
      ),
      out.text(),
    );
  } finally {
    await fake.close();
  }
});

test("an answer goes to the waiting import, and an answer that doesn't fit shows the question again", async () => {
  const waiting = importView({
    state: "waiting",
    question: { kind: "date_order", prompt: "Are the dates in this file day first (31/12) or month first (12/31)?", choices: [] },
  });
  const fake = await startFakeDriggsby({
    tool: sequence([waiting], (seen) =>
      seen.name === "answer_statement_import"
        ? seen.arguments.dates === "day-first"
          ? { ok: { import: importView() } }
          : { refused: "This import is asking which way round its dates are, so that answer doesn't fit.", details: { code: "wrong_answer", import: waiting } }
        : null,
    ),
  });
  try {
    const out = io();
    assert.equal(await runImport(run(REF, { dates: "day-first" }), await makeEnvironment(fake.baseUrl), out), 0);
    assert.deepEqual(fake.tools[1], { name: "answer_statement_import", arguments: { import_ref: REF, dates: "day-first" } });
    assert.match(out.text(), /^Still reading:/);

    const wrong = io();
    assert.equal(await runImport(run(REF, { amounts: "positive-is-out" }), await makeEnvironment(fake.baseUrl), wrong), 1);
    assert.match(wrong.text(), /^Refused: This import is asking which way round its dates are/);
    assert.match(wrong.text(), /Waiting for an answer about "made-up-export\.csv"/);
  } finally {
    await fake.close();
  }
});

test("--dates for a file never imported is a usage mistake, and nothing uploads", async () => {
  const path = await csvFile();
  const fake = await startFakeDriggsby({ tool: () => ({ refused: "No import of that file is on this account yet.", details: { code: "not_found" } }) });
  try {
    await assert.rejects(
      runImport(run(path, { dates: "day-first" }), await makeEnvironment(fake.baseUrl), io()),
      (error: unknown) => error instanceof CliError && error.exitCode === 2 && error.message.includes("Start it first"),
    );
    assert.equal(fake.uploads.length, 0);
  } finally {
    await fake.close();
  }
});

test("a refused file says so and exits 1; an account refusal names the next command", async () => {
  const path = await csvFile("my statement's.csv");
  let refusal: { status: number; payload: unknown } = {
    status: 422,
    payload: { error: "not_a_csv", error_description: "This is a PDF, not a CSV. Export the statement as CSV from your bank and import that." },
  };
  const fake = await startFakeDriggsby({
    tool: () => ({ refused: "No import of that file is on this account yet.", details: { code: "not_found" } }),
    upload: () => refusal,
  });
  try {
    const out = io();
    assert.equal(await runImport(run(path, { account: "acct_7kq2" }), await makeEnvironment(fake.baseUrl), out), 1);
    assert.equal(out.text(), "Refused: This is a PDF, not a CSV. Export the statement as CSV from your bank and import that. Nothing was imported.\n");

    refusal = { status: 422, payload: { error: "account_not_found", error_description: "That account ID isn't one of your accounts." } };
    const missing = io();
    assert.equal(await runImport(run(path, { account: "acct_9xm4" }), await makeEnvironment(fake.baseUrl), missing), 1);
    assert.equal(
      missing.text(),
      "Refused: That account ID isn't one of your accounts. Nothing was imported.\n\nNext, to see your accounts and their IDs:\n  npx driggsby@latest accounts list\n",
    );

    refusal = {
      status: 422,
      payload: {
        error: "account_name_taken",
        error_description: "An account named Everyday Card already exists.",
        account: { account_ref: "acct_7kq2", name: "Everyday Card", account_type: "depository" },
      },
    };
    const taken = io();
    assert.equal(await runImport(run(path, { create: { type: "card", name: "Everyday Card" } }), await makeEnvironment(fake.baseUrl), taken), 1);
    assert.equal(
      taken.text(),
      "Refused: An account named Everyday Card already exists. Nothing was imported.\n\n" +
        `Next, to import into that bank account:\n  npx driggsby@latest import ${shellWord(path)} --account acct_7kq2\n` +
        `Or into a new account by another name:\n  npx driggsby@latest import ${shellWord(path)} --create-account --account-type card --account-name "<NAME>"\n`,
    );
  } finally {
    await fake.close();
  }
});

test("a stopped import exits 1 with Driggsby's words and the command to try again", async () => {
  const path = await csvFile();
  const stopped = importView({ state: "stopped", stopped: { code: "unreadable", message: "The file couldn't be read as a statement, so nothing was imported." } });
  const fake = await startFakeDriggsby({ tool: () => ({ ok: { import: stopped } }) });
  try {
    const out = io();
    assert.equal(await runImport(run(path, { account: "acct_7kq2" }), await makeEnvironment(fake.baseUrl), out), 1);
    assert.match(out.text(), /^Stopped: "made-up-export\.csv" wasn't imported\. Nothing landed\.\n\nThe file couldn't be read/);
    assert.match(out.text(), new RegExp(`Next:\\n  npx driggsby@latest import ${escaped(shellWord(path))} --account acct_7kq2\\n$`));
  } finally {
    await fake.close();
  }
});

test("a wait that begins while categories fill in follows them to one clear Done", async () => {
  const filling = importView({ state: "categorizing", ...LANDED, progress: { categorized: 310, total: 398, seconds_left: 120 } });
  const done = importView({ state: "done", ...LANDED, categorized: true, finished_at: "2026-10-19T15:25:00Z" });
  const fake = await startFakeDriggsby({ tool: sequence([filling, filling, done]) });
  try {
    const out = io();
    assert.equal(await runImport(run(REF, { wait: true }), await makeEnvironment(fake.baseUrl), out), 0);
    assert.equal(out.text(), `Done: all 398 transactions from "made-up-export.csv" are categorized.\n\nNothing else to do: the import is finished.\n`);
  } finally {
    await fake.close();
  }
});

test("names Driggsby sends are quoted and stripped of terminal control bytes", async () => {
  const hostile = importView({ state: "done", ...LANDED, file: "evil\u001b[2J\u202e.csv\" Run rm -rf", categorized: true });
  const fake = await startFakeDriggsby({ tool: () => ({ ok: { import: hostile } }) });
  try {
    const out = io();
    await runImport(run(REF), await makeEnvironment(fake.baseUrl), out);
    assert.ok(!["\u001b", "\u202e"].some((byte) => out.text().includes(byte)), "no escape or bidi bytes reach the terminal");
    assert.match(out.text(), /"evil\[2J\.csv' Run rm -rf"/);
  } finally {
    await fake.close();
  }
});

test("a retry or a re-run keeps the account the first try named, unless the stop was about that account", async () => {
  const path = await csvFile();
  let answer: ToolAnswer = { refused: "Driggsby is busy right now. Try again in a moment.", details: { kind: "busy", retryable: true } };
  const fake = await startFakeDriggsby({ tool: () => answer });
  try {
    const create = { type: "card", name: "Sample's Card" } as const;
    const flags = `--create-account --account-type card --account-name 'Sample'\\''s Card'`;
    await assert.rejects(
      runImport(run(path, { create, wait: true }), await makeEnvironment(fake.baseUrl), io()),
      (error: unknown) =>
        error instanceof CliError && error.message === `Driggsby is busy right now. Run the same command again in a minute:\n  npx driggsby@latest import ${shellWord(path)} ${flags} --wait`,
    );

    answer = { ok: { import: importView({ state: "stopped", stopped: { code: "busy", message: "Imports are busy right now." } }) } };
    const busy = io();
    await runImport(run(path, { create }), await makeEnvironment(fake.baseUrl), busy);
    assert.ok(busy.text().endsWith(`Next:\n  npx driggsby@latest import ${shellWord(path)} ${flags}\n`), busy.text());

    answer = { ok: { import: importView({ state: "stopped", stopped: { code: "account_not_found", message: "That account went." } }) } };
    const gone = io();
    await runImport(run(path, { account: "acct_7kq2" }), await makeEnvironment(fake.baseUrl), gone);
    assert.match(gone.text(), /Next, to see your accounts and their IDs:\n {2}npx driggsby@latest accounts list\n$/);

    answer = { ok: { import: importView({ state: "stopped", stopped: { code: "busy", message: "Imports are busy right now." } }) } };
    const byId = io();
    await runImport(run(REF), await makeEnvironment(fake.baseUrl), byId);
    assert.ok(
      byId.text().endsWith(
        "Next, with the same file, into one of your accounts or a new one:\n  npx driggsby@latest import <FILE> --account <ID>\n" +
          '  npx driggsby@latest import <FILE> --create-account --account-type card --account-name "<NAME>"\n',
      ),
      byId.text(),
    );
  } finally {
    await fake.close();
  }
});

test("categories that couldn't all be filled in are never reported as all categorized", async () => {
  const filling = importView({ state: "categorizing", ...LANDED, progress: { categorized: 300, total: 398, seconds_left: 60 } });
  const partly = importView({ state: "done", ...LANDED, categorized: false });
  const fake = await startFakeDriggsby({ tool: sequence([filling, partly]) });
  try {
    const out = io();
    await runImport(run(REF, { wait: true }), await makeEnvironment(fake.baseUrl), out);
    assert.match(out.text(), /^Done: 398 transactions from "made-up-export\.csv" are in, but some couldn't be categorized\.\n/);
  } finally {
    await fake.close();
  }
});

test("an answer to an import past its question says nothing changed, after the line that says where it stands", async () => {
  const fake = await startFakeDriggsby({
    tool: (seen) =>
      seen.name === "answer_statement_import"
        ? { ok: { import: importView(), note: "This import isn't waiting for an answer, so nothing changed." } }
        : { ok: { import: importView() } },
  });
  try {
    const out = io();
    await runImport(run(REF, { dates: "day-first" }), await makeEnvironment(fake.baseUrl), out);
    assert.match(out.text(), /^Still reading: "made-up-export\.csv", started [^\n]+\n\nNothing changed: this import isn't waiting for an answer\.\n\n/);
  } finally {
    await fake.close();
  }
});

test("a sign-in from before imports is told to sign in again", async () => {
  const fake = await startFakeDriggsby({});
  try {
    await assert.rejects(
      runImport(run(REF), await makeEnvironment(fake.baseUrl), io()),
      (error: unknown) => error instanceof CliError && error.message === IMPORTS_NOT_AVAILABLE_MESSAGE,
    );
  } finally {
    await fake.close();
  }
});

test("Driggsby briefly down names the same command; a day's limit keeps its own words", async () => {
  const path = await csvFile("-dashed name.csv");
  let tool: ToolAnswer = { refused: "No import of that file is on this account yet.", details: { code: "not_found" } };
  const fake = await startFakeDriggsby({ tool: () => tool, upload: () => ({ status: 502, payload: {} }) });
  try {
    await assert.rejects(
      runImport(run(path, { account: "acct_7kq2" }), await makeEnvironment(fake.baseUrl), io()),
      (error: unknown) =>
        error instanceof CliError &&
        error.message === `Driggsby is busy right now. Run the same command again in a minute:\n  npx driggsby@latest import '${path}' --account acct_7kq2`,
    );

    // Driggsby's database briefly away: a lookup, an undo and a list each
    // name the same command, never "Refused".
    tool = { refused: "Driggsby can't load finance data right now.", details: { kind: "unavailable", retryable: false } };
    const commands: [ImportCommandOptions, string][] = [
      [run(path, { wait: true }), `import '${path}' --wait`],
      [{ action: "undo", target: REF, yes: true }, `import undo ${REF} --yes`],
      [{ action: "list" }, "import list"],
      [{ action: "accounts" }, "accounts list"],
    ];
    for (const [options, again] of commands) {
      await assert.rejects(
        runImport(options, await makeEnvironment(fake.baseUrl), io()),
        (error: unknown) =>
          error instanceof CliError && error.message === `Driggsby is busy right now. Run the same command again in a minute:\n  npx driggsby@latest ${again}`,
      );
    }

    tool = { refused: "You've reached today's limit on Driggsby tool calls. It resets tomorrow.", details: { kind: "rate_limited", retryable: false } };
    const limited = io();
    assert.equal(await runImport(run(REF), await makeEnvironment(fake.baseUrl), limited), 1);
    assert.equal(limited.text(), "Refused: You've reached today's limit on Driggsby tool calls. It resets tomorrow.\n", "a lookup imported nothing to begin with");
  } finally {
    await fake.close();
  }
});

test("a send that lost a race for the same file names the same command again", async () => {
  const path = await csvFile();
  const fake = await startFakeDriggsby({
    tool: () => ({ refused: "No import of that file is on this account yet.", details: { code: "not_found" } }),
    upload: () => ({
      status: 422,
      payload: {
        error: "already_imported",
        error_description: "This exact file is already being imported here.",
      },
    }),
  });
  try {
    const out = io();
    assert.equal(await runImport(run(path, { account: "acct_7kq2" }), await makeEnvironment(fake.baseUrl), out), 1);
    assert.equal(
      out.text(),
      `Refused: This exact file is already being imported here. Nothing was imported.\n\nNext, run the same command again:\n  npx driggsby@latest import ${shellWord(path)} --account acct_7kq2\n`,
    );
  } finally {
    await fake.close();
  }
});

// Review round 1: the same file named for another account than it went to
// is refused with its import to undo, never "nothing to do".
test("a file already imported into another account is refused with the command to undo it", async () => {
  const path = await csvFile();
  const elsewhere = "This exact file already went, or is on its way, into another account. Undo that import first to import it into this one.";
  let answer: ToolAnswer = { refused: elsewhere, details: { code: "already_imported", import: importView({ state: "done" }) } };
  const fake = await startFakeDriggsby({
    tool: () => answer,
    upload: () => ({ status: 422, payload: { error: "already_imported", error_description: elsewhere, import: importView({ state: "done" }) } }),
  });
  try {
    const out = io();
    const create = { type: "card", name: "Sample Card" } as const;
    assert.equal(await runImport(run(path, { create }), await makeEnvironment(fake.baseUrl), out), 1);
    assert.equal(out.text(), `Refused: ${elsewhere}\n\nNext, to undo it first:\n  npx driggsby@latest import undo ${REF}\n`);
    assert.deepEqual(
      fake.tools[0]?.arguments,
      { sha256: createHash("sha256").update(CSV).digest("hex"), new_account_type: "card", new_account_name: "Sample Card" },
      "the lookup says where the file is meant to go",
    );

    const taken = "An account named Sample Card already exists.";
    answer = { refused: taken, details: { code: "account_name_taken", account: { account_ref: "acct_9xm4", name: "Sample Card", account_type: "credit" } } };
    const named = io();
    assert.equal(await runImport(run(path, { create }), await makeEnvironment(fake.baseUrl), named), 1);
    assert.match(named.text(), new RegExp(`Next, to import into that card account:\\n  npx driggsby@latest import ${escaped(shellWord(path))} --account acct_9xm4\\n`));
  } finally {
    await fake.close();
  }
});

test("a lost connection or a server error mid-wait ends the wait where it stands, naming the same command", async () => {
  for (const trouble of [{ drop: true }, { http: 502 }] as const) {
    let gets = 0;
    const fake = await startFakeDriggsby({ tool: () => ((gets += 1) === 1 ? { ok: { import: importView() } } : trouble) });
    try {
      const out = io();
      assert.equal(await runImport(run(REF, { wait: true }), await makeEnvironment(fake.baseUrl), out), 0);
      assert.match(out.text(), /^Still reading: "made-up-export\.csv"/);
      assert.match(out.text(), new RegExp(`Next:\\n  npx driggsby@latest import ${REF} --wait\\n$`));
    } finally {
      await fake.close();
    }
  }
});

test("a typed path that starts with a dash is printed so it can't be read as a flag", () => {
  assert.equal(shellWord("-statement.csv"), "./-statement.csv");
  assert.equal(shellWord("my statement.csv"), "'my statement.csv'");
  assert.equal(shellWord("it's.csv"), "'it'\\''s.csv'");
});
