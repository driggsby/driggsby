import assert from "node:assert/strict";
import { test } from "node:test";

import { CliError } from "../cli-error.ts";
import { SIGN_IN_AGAIN_MESSAGE } from "../deploy/api-session.ts";
import { capturedOut, makeEnvironment } from "../deploy/test-support/deploy-command-harness.ts";
import { startFakeMcp, successEnvelope } from "../test-support/fake-mcp.ts";
import { RULES_REASON, runRules } from "./rules-command.ts";
import { RULES_NOT_AVAILABLE_MESSAGE } from "./rules-rpc.ts";

function sentArguments(fake: { requests: { body: unknown }[] }): Record<string, unknown> {
  const body = fake.requests[0]?.body as Record<string, unknown>;
  const params = body.params as Record<string, unknown>;
  return params.arguments as Record<string, unknown>;
}

test("rules list calls list_transaction_rules and prints its result as JSON", async () => {
  const structured = { rules: [{ rule_ref: "rule_1", name: "Rent" }] };
  const fake = await startFakeMcp((body) => successEnvelope(body, structured));
  try {
    const io = capturedOut();
    const code = await runRules({ action: "list", params: {} }, await makeEnvironment(fake.baseUrl), io);
    assert.equal(code, 0);
    assert.deepEqual(JSON.parse(io.text()), structured);
    const body = fake.requests[0]?.body as Record<string, unknown>;
    assert.equal((body.params as Record<string, unknown>).name, "list_transaction_rules");
    assert.equal(sentArguments(fake).reason, RULES_REASON);
  } finally {
    await fake.close();
  }
});

test("a caller's own reason is kept, and params pass through verbatim", async () => {
  const fake = await startFakeMcp((body) => successEnvelope(body, { created: true }));
  try {
    const params = { reason: "Fixing rent.", rule: { version: 1 }, confirm_token: "rcfm_x", decisions: { wide_match: "all_history" } };
    await runRules({ action: "save", params }, await makeEnvironment(fake.baseUrl), capturedOut());
    assert.deepEqual(sentArguments(fake), params);
  } finally {
    await fake.close();
  }
});

test("a refusal prints its details on stdout and exits 1 with its message", async () => {
  const details = { error: "Answer the overlap first.", suggestions: [{ id: "overlaps:rule_2", options: ["replace_on_overlap", "keep_existing"] }] };
  const fake = await startFakeMcp((body) => ({
    status: 200,
    payload: { jsonrpc: "2.0", id: body.id, result: { isError: true, structuredContent: details, content: [] } },
  }));
  try {
    const io = capturedOut();
    await assert.rejects(
      runRules({ action: "save", params: { rule: {} } }, await makeEnvironment(fake.baseUrl), io),
      (error: unknown) => error instanceof CliError && error.exitCode === 1 && error.message.includes("Answer the overlap first."),
    );
    assert.deepEqual(JSON.parse(io.text()), details);
  } finally {
    await fake.close();
  }
});

test("an older sign-in's refusal names the fix", async () => {
  const message = "Only a Driggsby CLI sign-in can use this tool, and this one wasn't approved for it. If you're using the Driggsby CLI, sign in again: npx driggsby@latest login";
  const fake = await startFakeMcp((body) => ({
    status: 200,
    payload: { jsonrpc: "2.0", id: body.id, error: { code: -32602, message } },
  }));
  try {
    const io = capturedOut();
    await assert.rejects(
      runRules({ action: "tags", params: {} }, await makeEnvironment(fake.baseUrl), io),
      (error: unknown) => error instanceof CliError && error.message.includes("npx driggsby@latest login"),
    );
    assert.equal(io.text(), "");
  } finally {
    await fake.close();
  }
});

test("describe prints only the rule tools, with the command that runs each", async () => {
  const fake = await startFakeMcp((body) => ({
    status: 200,
    payload: {
      jsonrpc: "2.0",
      id: body.id,
      result: {
        tools: [
          { name: "get_overview", description: "Overview.", inputSchema: {} },
          { name: "preview_transaction_rule", title: "Preview", description: "The rule format.", inputSchema: { type: "object" }, annotations: { x: 1 } },
          { name: "save_transaction_rule", description: "Saves.", inputSchema: { type: "object" } },
        ],
      },
    },
  }));
  try {
    const io = capturedOut();
    const code = await runRules({ action: "describe", params: {} }, await makeEnvironment(fake.baseUrl), io);
    assert.equal(code, 0);
    const printed = JSON.parse(io.text()) as { tools: { name: string }[]; how_to_run: Record<string, string> };
    assert.deepEqual(printed.tools.map((tool) => tool.name), ["preview_transaction_rule", "save_transaction_rule"]);
    assert.deepEqual(Object.keys(printed.tools[0] ?? {}).sort(), ["description", "inputSchema", "name", "title"]);
    assert.equal(printed.how_to_run.preview_transaction_rule, "npx driggsby@latest rules preview --params <JSON>");
    assert.equal((fake.requests[0]?.body as Record<string, unknown>).method, "tools/list");
  } finally {
    await fake.close();
  }
});

test("describe with no rule tools listed says how to get them", async () => {
  const fake = await startFakeMcp((body) => ({
    status: 200,
    payload: { jsonrpc: "2.0", id: body.id, result: { tools: [{ name: "get_overview", description: "Overview." }] } },
  }));
  try {
    await assert.rejects(
      runRules({ action: "describe", params: {} }, await makeEnvironment(fake.baseUrl), capturedOut()),
      (error: unknown) => error instanceof CliError && error.message === RULES_NOT_AVAILABLE_MESSAGE,
    );
  } finally {
    await fake.close();
  }
});

test("a rejected sign-in says to sign in again", async () => {
  const fake = await startFakeMcp(() => ({ status: 401, payload: {} }));
  try {
    await assert.rejects(
      runRules({ action: "list", params: {} }, await makeEnvironment(fake.baseUrl), capturedOut()),
      (error: unknown) => error instanceof CliError && error.message === SIGN_IN_AGAIN_MESSAGE,
    );
  } finally {
    await fake.close();
  }
});

test("without a sign-in nothing is sent", async () => {
  const fake = await startFakeMcp((body) => successEnvelope(body, {}));
  try {
    await assert.rejects(
      runRules({ action: "list", params: {} }, await makeEnvironment(fake.baseUrl, { signedIn: false }), capturedOut()),
      (error: unknown) => error instanceof CliError && error.message.includes("npx driggsby@latest login"),
    );
    assert.equal(fake.requests.length, 0);
  } finally {
    await fake.close();
  }
});
