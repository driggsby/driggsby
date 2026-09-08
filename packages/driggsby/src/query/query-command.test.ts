import assert from "node:assert/strict";
import { test } from "node:test";

import { CliError } from "../cli-error.ts";
import { capturedOut, makeEnvironment, TEST_TOKEN } from "../deploy/test-support/deploy-command-harness.ts";
import { startFakeMcp, successEnvelope } from "../test-support/fake-mcp.ts";
import { runQuery } from "./query-command.ts";

test("query prints the tool's result as JSON, exactly what a watch callback receives", async () => {
  const structured = { returned_row_count: 1, rows: [{ total: "12.50" }], truncated: false, notes: [] };
  const fake = await startFakeMcp((body) => successEnvelope(body, structured));
  try {
    const io = capturedOut();
    const code = await runQuery(
      { tool: "query_cash_sql", params: { sql: "SELECT SUM(amount) AS total FROM cash_transactions" } },
      await makeEnvironment(fake.baseUrl),
      io,
    );

    assert.equal(code, 0);
    assert.deepEqual(JSON.parse(io.text()), structured);
    assert.ok(io.text().endsWith("\n"));
    const request = fake.requests[0];
    assert.ok(request !== undefined);
    assert.equal(request.headers.authorization, `Bearer ${TEST_TOKEN}`);
    const params = (request.body as Record<string, unknown>).params as Record<string, unknown>;
    assert.equal(params.name, "query_cash_sql");
    const args = params.arguments as Record<string, unknown>;
    assert.equal(args.sql, "SELECT SUM(amount) AS total FROM cash_transactions");
    // The CLI names itself as the reason, never the dev preview.
    assert.match(String(args.reason), /driggsby CLI/);
  } finally {
    await fake.close();
  }
});

test("a tool refusal prints the tool's own message and exits 1", async () => {
  const fake = await startFakeMcp((body) => ({
    status: 200,
    payload: {
      jsonrpc: "2.0",
      id: body.id,
      result: { isError: true, content: [{ type: "text", text: "sql: unknown column 'nope'" }] },
    },
  }));
  try {
    const io = capturedOut();
    await assert.rejects(
      runQuery({ tool: "query_cash_sql", params: { sql: "SELECT nope" } }, await makeEnvironment(fake.baseUrl), io),
      (error: unknown) =>
        error instanceof CliError && error.exitCode === 1 && error.message.includes("unknown column 'nope'"),
    );
    assert.equal(io.text(), "");
  } finally {
    await fake.close();
  }
});

test("a refusal's text is stripped of terminal control and bidi bytes and wrapped", async () => {
  const hostile = `sql error\u001b[2K\rALL GOOD \u202e${"x".repeat(120)}`;
  const fake = await startFakeMcp((body) => ({
    status: 200,
    payload: { jsonrpc: "2.0", id: body.id, result: { isError: true, content: [{ type: "text", text: hostile }] } },
  }));
  try {
    await assert.rejects(
      runQuery({ tool: "query_cash_sql", params: { sql: "SELECT 1" } }, await makeEnvironment(fake.baseUrl), capturedOut()),
      (error: unknown) => {
        assert.ok(error instanceof CliError);
        assert.ok(!error.message.includes("\u001b"));
        assert.ok(!error.message.includes("\r"));
        assert.ok(!error.message.includes("\u202e"));
        assert.ok(error.message.startsWith("sql error[2K ALL GOOD"));
        assert.ok(error.message.split("\n").every((line) => line.length <= 80));
        return true;
      },
    );
  } finally {
    await fake.close();
  }
});

test("a stale sign-in and no sign-in each name the login command", async () => {
  const fake = await startFakeMcp(() => ({ status: 401, payload: { error: "invalid_token" } }));
  try {
    await assert.rejects(
      runQuery({ tool: "get_overview", params: {} }, await makeEnvironment(fake.baseUrl), capturedOut()),
      (error: unknown) =>
        error instanceof CliError &&
        error.message.includes("npx driggsby@latest login") &&
        !error.message.includes("reload"),
    );
    await assert.rejects(
      runQuery(
        { tool: "get_overview", params: {} },
        await makeEnvironment(fake.baseUrl, { signedIn: false }),
        capturedOut(),
      ),
      (error: unknown) => error instanceof CliError && error.message.includes("not signed in on this machine"),
    );
    assert.equal(fake.requests.length, 1);
  } finally {
    await fake.close();
  }
});
