import assert from "node:assert/strict";
import { test } from "node:test";

import { parseArgv } from "../args.ts";
import { CliError } from "../cli-error.ts";
import { capturedOut, makeEnvironment } from "../deploy/test-support/deploy-command-harness.ts";
import { APP_TOOL_ALLOWLIST } from "../dev/tool-allowlist.ts";
import { ITEMS_HELP } from "../help.ts";
import { startFakeMcp, successEnvelope } from "../test-support/fake-mcp.ts";
import { ITEM_ACTION_TOOLS } from "./item-actions.ts";
import { describePayload, ITEMS_NOT_AVAILABLE_MESSAGE, ITEMS_REASON, runItems } from "./items-command.ts";

function sentArguments(fake: { requests: { body: unknown }[] }): Record<string, unknown> {
  const body = fake.requests[0]?.body as Record<string, unknown>;
  const params = body.params as Record<string, unknown>;
  return params.arguments as Record<string, unknown>;
}

function usageError(argv: string[], pattern: RegExp): void {
  assert.throws(
    () => parseArgv(argv),
    (error: unknown) => error instanceof CliError && error.exitCode === 2 && pattern.test(error.message),
  );
}

test("items save parses its params, and delete needs --yes", () => {
  assert.deepEqual(parseArgv(["items", "save", "--params", '{"charges":[]}']), {
    kind: "items",
    action: "save",
    params: { charges: [] },
    yes: false,
  });
  assert.deepEqual(parseArgv(["items", "delete", "--params", '{"transaction_refs":["txn_1"]}', "--yes"]), {
    kind: "items",
    action: "delete",
    params: { transaction_refs: ["txn_1"] },
    yes: true,
  });
  usageError(["items", "delete", "--params", '{"transaction_refs":["txn_1"]}'], /run the same command again with --yes/);
  usageError(["items", "save", "--yes"], /'--yes' only applies to items delete/);
  usageError(["items", "describe", "--params", "{}"], /items describe takes no params/);
  usageError(["items", "sav"], /isn't an items action[\s\S]*tip: a similar action exists: 'save'/);
  usageError(["items", "save", "--params", "[1]"], /must be a JSON object, like '\{"transaction_refs":\["txn_\.\.\."\]\}'/);
  assert.deepEqual(parseArgv(["items", "--help"]), { kind: "print-help", text: ITEMS_HELP, stream: "stdout", exitCode: 0 });
});

test("items save calls save_transaction_items with the params and the CLI's reason", async () => {
  const structured = { results: [{ transaction_ref: "txn_1", status: "saved" }] };
  const fake = await startFakeMcp((body) => successEnvelope(body, structured));
  try {
    const io = capturedOut();
    const params = { charges: [{ transaction_ref: "txn_1", source: "receipt", store: "Corner Store", items: [] }] };
    const code = await runItems({ action: "save", params }, await makeEnvironment(fake.baseUrl), io);
    assert.equal(code, 0);
    assert.deepEqual(JSON.parse(io.text()), structured);
    const body = fake.requests[0]?.body as Record<string, unknown>;
    assert.equal((body.params as Record<string, unknown>).name, "save_transaction_items");
    assert.deepEqual(sentArguments(fake), { ...params, reason: ITEMS_REASON });
  } finally {
    await fake.close();
  }
});

test("items delete without --yes never reaches Driggsby", async () => {
  const fake = await startFakeMcp((body) => successEnvelope(body, {}));
  try {
    await assert.rejects(
      runItems({ action: "delete", params: { transaction_refs: ["txn_1"] } }, await makeEnvironment(fake.baseUrl), capturedOut()),
      (error: unknown) => error instanceof CliError && error.exitCode === 2,
    );
    assert.equal(fake.requests.length, 0);
  } finally {
    await fake.close();
  }
});

test("a per-charge refusal is part of the result: printed as JSON, exit 0", async () => {
  const structured = { results: [{ transaction_ref: "txn_1", status: "refused", reason: "The items don't add up to the charge." }] };
  const fake = await startFakeMcp((body) => successEnvelope(body, structured));
  try {
    const io = capturedOut();
    const code = await runItems({ action: "save", params: { charges: [] } }, await makeEnvironment(fake.baseUrl), io);
    assert.equal(code, 0);
    assert.deepEqual(JSON.parse(io.text()), structured);
  } finally {
    await fake.close();
  }
});

test("a whole-call refusal prints its details on stdout and exits 1 with its message", async () => {
  const details = { error: "Saving items isn't available right now." };
  const fake = await startFakeMcp((body) => ({
    status: 200,
    payload: { jsonrpc: "2.0", id: body.id, result: { isError: true, structuredContent: details, content: [] } },
  }));
  try {
    const io = capturedOut();
    await assert.rejects(
      runItems({ action: "save", params: { charges: [] } }, await makeEnvironment(fake.baseUrl), io),
      (error: unknown) => error instanceof CliError && error.exitCode === 1 && error.message.includes("isn't available right now"),
    );
    assert.deepEqual(JSON.parse(io.text()), details);
  } finally {
    await fake.close();
  }
});

test("items describe prints the item tools' own descriptions, or names the fix when none are listed", async () => {
  const tools = [
    { name: "save_transaction_items", title: "Save items", description: "Save the items.", inputSchema: { type: "object" } },
    { name: "query_cash_sql", description: "Not an item tool." },
  ];
  const fake = await startFakeMcp((body) => ({ status: 200, payload: { jsonrpc: "2.0", id: body.id, result: { tools } } }));
  try {
    const io = capturedOut();
    await runItems({ action: "describe", params: {} }, await makeEnvironment(fake.baseUrl), io);
    const printed = JSON.parse(io.text()) as Record<string, unknown>;
    assert.deepEqual((printed.tools as { name: string }[]).map((tool) => tool.name), ["save_transaction_items"]);
  } finally {
    await fake.close();
  }
  const empty = await startFakeMcp((body) => ({ status: 200, payload: { jsonrpc: "2.0", id: body.id, result: { tools: [] } } }));
  try {
    await assert.rejects(
      runItems({ action: "describe", params: {} }, await makeEnvironment(empty.baseUrl), capturedOut()),
      (error: unknown) => error instanceof CliError && error.message === ITEMS_NOT_AVAILABLE_MESSAGE,
    );
  } finally {
    await empty.close();
  }
});

test("describe names a CLI command for each item tool, and the reader runs through query", () => {
  const howToRun = describePayload([]).how_to_run as Record<string, string>;
  for (const tool of Object.values(ITEM_ACTION_TOOLS)) {
    assert.match(howToRun[tool] ?? "", /^npx driggsby@latest items /);
  }
  assert.ok(APP_TOOL_ALLOWLIST.has("query_item_sql"));
  assert.equal(howToRun.query_item_sql, "npx driggsby@latest query query_item_sql --sql <SQL>");
});
