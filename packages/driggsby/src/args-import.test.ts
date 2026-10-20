import assert from "node:assert/strict";
import { test } from "node:test";

import { parseArgv } from "./args.ts";
import { CliError } from "./cli-error.ts";
import { ACCOUNTS_HELP, IMPORT_HELP } from "./help.ts";

function usageError(argv: string[], pattern: RegExp): void {
  assert.throws(
    () => parseArgv(argv),
    (error: unknown) => error instanceof CliError && error.exitCode === 2 && pattern.test(error.message),
  );
}

const RUN = { action: "run", wait: false, account: null, create: null, dates: null, amounts: null } as const;

test("import takes a file with its account, an ID with --wait or one answer", () => {
  assert.deepEqual(parseArgv(["import", "statement.csv", "--account", "acct_7kq2"]), {
    kind: "import",
    options: { ...RUN, target: "statement.csv", account: "acct_7kq2" },
  });
  assert.deepEqual(parseArgv(["import", "statement.csv", "--create-account", "--account-type=card", "--account-name", " Everyday Card "]), {
    kind: "import",
    options: { ...RUN, target: "statement.csv", create: { type: "card", name: "Everyday Card" } },
  });
  assert.deepEqual(parseArgv(["import", "imp_7kq2mxa9p4bz", "--wait"]), { kind: "import", options: { ...RUN, target: "imp_7kq2mxa9p4bz", wait: true } });
  assert.deepEqual(parseArgv(["import", "--dates=day-first", "imp_7kq2mxa9p4bz"]), {
    kind: "import",
    options: { ...RUN, target: "imp_7kq2mxa9p4bz", dates: "day-first" },
  });
  assert.deepEqual(parseArgv(["import", "--", "-statement.csv"]), { kind: "import", options: { ...RUN, target: "-statement.csv" } });
});

test("accounts list lists the accounts an import names", () => {
  assert.deepEqual(parseArgv(["accounts", "list"]), { kind: "import", options: { action: "accounts" } });
  assert.deepEqual(parseArgv(["accounts", "--help"]), { kind: "print-help", text: ACCOUNTS_HELP, stream: "stdout", exitCode: 0 });
  usageError(["accounts", "show"], /unexpected argument 'show'/);
  usageError(["accounts", "list", "extra"], /unexpected argument 'extra'/);
});

test("undo takes a file or an ID and --yes; list takes nothing", () => {
  assert.deepEqual(parseArgv(["import", "undo", "imp_7kq2mxa9p4bz", "--yes"]), {
    kind: "import",
    options: { action: "undo", target: "imp_7kq2mxa9p4bz", yes: true },
  });
  assert.deepEqual(parseArgv(["import", "list"]), { kind: "import", options: { action: "list" } });
  usageError(["import", "list", "extra"], /unexpected argument 'extra'/);
  usageError(["import", "undo"], /required arguments were not provided:\n {2}<FILE or ID>/);
});

test("help comes from every import form", () => {
  for (const argv of [["import", "--help"], ["import", "-h"], ["import", "undo", "--help"], ["import", "list", "-h"]]) {
    assert.deepEqual(parseArgv(argv), { kind: "print-help", text: IMPORT_HELP, stream: "stdout", exitCode: 0 });
  }
});

test("mistakes are usage errors that say what to type", () => {
  usageError(["import"], /required arguments were not provided:\n {2}<FILE or ID>/);
  usageError(["import", "a.csv", "--account"], /a value is required for '--account'/);
  usageError(["import", "a.csv", "--account", "--wait"], /a value is required for '--account'/);
  usageError(["import", "a.csv", "--account", "1111"], /name the account by its ID, like acct_7kq2/);
  usageError(["import", "a.csv", "--account", "new"], /name the account by its ID/);
  usageError(["import", "a.csv", "--account", "acct_1\u001b[2J"], /invalid value 'acct_1\[2J'/);
  usageError(["import", "a.csv", "--create-account"], /--create-account needs --account-type <card\|bank> and --account-name <NAME>/);
  usageError(["import", "a.csv", "--create-account", "--account-type", "loan", "--account-name", "Loan"], /possible values: card, bank/);
  usageError(["import", "a.csv", "--account-type", "card"], /--account-type and --account-name go with --create-account/);
  usageError(["import", "a.csv", "--account", "acct_7kq2", "--create-account", "--account-type", "card", "--account-name", "X"], /not both/);
  usageError(["import", "a.csv", "--create-account", "--account-type", "card", "--account-name", "x".repeat(101)], /invalid value for '--account-name'/);
  usageError(["import", "a.csv", "--create-account", "--account-type", "card", "--account-name", "Sample\u0600Card"], /invalid value for '--account-name'/);
  usageError(["import", "a.csv", "--create-account", "--account-type", "card", "--account-name", " --yes"], /a value is required for '--account-name'/);
  usageError(["import", "a.csv", "--account", "acct_7kq2", "--account", "acct_9xm4"], /'--account' was given more than once/);
  usageError(["import", "a.csv", "--dates", "ymd"], /possible values: day-first, month-first/);
  usageError(["import", "a.csv", "--amounts", "out"], /possible values: positive-is-out, positive-is-in/);
  usageError(["import", "a.csv", "--dates", "day-first", "--amounts", "positive-is-in"], /give one answer at a time/);
  usageError(["import", "a.csv", "--account", "acct_7kq2", "--dates", "day-first"], /Give one or the other/);
  usageError(["import", "a.csv", "b.csv"], /unexpected argument 'b\.csv'/);
  usageError(["import", "a.csv", "--yes"], /unexpected argument '--yes'/);
});

test("the root help names import", () => {
  const help = parseArgv(["--help"]);
  assert.ok(help.kind === "print-help" && help.text.includes("  import    Import a bank or card statement (a CSV file) into your accounts."));
});
