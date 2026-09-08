import assert from "node:assert/strict";
import { test } from "node:test";

import { parseArgv } from "./args.ts";
import { CliError } from "./cli-error.ts";
import { QUERY_HELP } from "./help.ts";

function usageError(argv: string[]): CliError {
  try {
    parseArgv(argv);
  } catch (error) {
    assert.ok(error instanceof CliError);
    return error;
  }
  assert.fail("expected a CliError");
}

test("query parses a bare tool, --sql, and --params in either spelling", () => {
  assert.deepEqual(parseArgv(["query", "get_overview"]), {
    kind: "query",
    tool: "get_overview",
    params: {},
  });
  assert.deepEqual(parseArgv(["query", "query_cash_sql", "--sql", "SELECT 1"]), {
    kind: "query",
    tool: "query_cash_sql",
    params: { sql: "SELECT 1" },
  });
  assert.deepEqual(
    parseArgv(["query", "get_history", '--params={"history_type":"liabilities"}', "--sql=SELECT 2"]),
    { kind: "query", tool: "get_history", params: { history_type: "liabilities", sql: "SELECT 2" } },
  );
});

test("query prints its help on -h and --help", () => {
  for (const argv of [["query", "--help"], ["query", "-h"], ["query", "get_overview", "-h"]]) {
    assert.deepEqual(parseArgv(argv), { kind: "print-help", text: QUERY_HELP, stream: "stdout", exitCode: 0 });
  }
});

test("query without a tool, or with a tool apps cannot call, is a usage error naming the twelve", () => {
  const missing = usageError(["query"]);
  assert.equal(missing.exitCode, 2);
  assert.match(missing.message, /required arguments were not provided:\n {2}<TOOL>/);

  const unknown = usageError(["query", "email_me"]);
  assert.equal(unknown.exitCode, 2);
  assert.match(unknown.message, /'email_me' isn't a tool a Driggsby app can call/);
  assert.match(unknown.message, /get_overview/);
  assert.match(unknown.message, /search_investment_activity/);
  // The echoed name is sanitized like every other argv echo.
  assert.ok(!usageError(["query", "get_\u001b[31moverview"]).message.includes("\u001b"));
});

test("query refuses --params that is not a JSON object, and a missing flag value", () => {
  const notJson = usageError(["query", "get_overview", "--params", "{nope"]);
  assert.equal(notJson.exitCode, 2);
  assert.match(notJson.message, /'--params' must be a JSON object/);
  assert.match(usageError(["query", "get_overview", "--params", "[1]"]).message, /'--params' must be a JSON object/);
  assert.match(usageError(["query", "get_overview", "--sql"]).message, /a value is required for '--sql'/);
  assert.match(usageError(["query", "get_overview", "extra"]).message, /unexpected argument 'extra'/);
});
