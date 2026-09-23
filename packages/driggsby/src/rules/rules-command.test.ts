import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { test } from "node:test";

import { CliError } from "../cli-error.ts";
import { SIGN_IN_AGAIN_MESSAGE } from "../deploy/api-session.ts";
import { capturedOut, makeEnvironment } from "../deploy/test-support/deploy-command-harness.ts";
import { startFakeMcp, successEnvelope } from "../test-support/fake-mcp.ts";
import { RULES_REASON, runRules } from "./rules-command.ts";
import { RULES_NOT_AVAILABLE_MESSAGE } from "./rules-rpc.ts";
import { GENERIC_TOOL_TROUBLE } from "../dev/dev-servers.ts";
import { APP_TOOL_ALLOWLIST } from "../dev/tool-allowlist.ts";
import { RULE_ACTION_TOOLS } from "./rule-actions.ts";

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

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address !== null && typeof address !== "string");
  return `http://127.0.0.1:${String(address.port)}`;
}

async function closeServer(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });
}

test("a redirecting /mcp response is refused; the sign-in never follows it", async () => {
  let targetHits = 0;
  const target = createServer((_request, response) => {
    targetHits += 1;
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { structuredContent: {}, isError: false } }));
  });
  const targetUrl = await listen(target);
  const redirecting = createServer((_request, response) => {
    response.writeHead(307, { Location: `${targetUrl}/mcp` });
    response.end();
  });
  const redirectingUrl = await listen(redirecting);
  try {
    const io = capturedOut();
    await assert.rejects(
      runRules({ action: "list", params: {} }, await makeEnvironment(redirectingUrl), io),
      (error: unknown) => error instanceof CliError && error.exitCode === 1,
    );
    assert.equal(targetHits, 0, "the redirect target must never be contacted");
    assert.equal(io.text(), "");
  } finally {
    await closeServer(redirecting);
    await closeServer(target);
  }
});

test("a server error or a non-JSON answer is the generic trouble message, with nothing on stdout", async () => {
  for (const answer of [
    { status: 500, contentType: "application/json", body: "{}" },
    { status: 200, contentType: "text/html", body: "<html>oops</html>" },
  ]) {
    const server = createServer((_request, response) => {
      response.writeHead(answer.status, { "Content-Type": answer.contentType });
      response.end(answer.body);
    });
    const url = await listen(server);
    try {
      const io = capturedOut();
      await assert.rejects(
        runRules({ action: "tags", params: {} }, await makeEnvironment(url), io),
        (error: unknown) => error instanceof CliError && error.message === GENERIC_TOOL_TROUBLE,
      );
      assert.equal(io.text(), "");
    } finally {
      await closeServer(server);
    }
  }
});

test("a refusal without an error string falls back to its text content", async () => {
  const fake = await startFakeMcp((body) => ({
    status: 200,
    payload: { jsonrpc: "2.0", id: body.id, result: { isError: true, content: [{ type: "text", text: "Not now." }] } },
  }));
  try {
    const io = capturedOut();
    await assert.rejects(
      runRules({ action: "list", params: {} }, await makeEnvironment(fake.baseUrl), io),
      (error: unknown) => error instanceof CliError && error.message === "Not now.",
    );
    assert.equal(io.text(), "null\n");
  } finally {
    await fake.close();
  }
});

test("a refused connection names the command to repeat, never the params", async () => {
  const closed = createServer();
  const url = await listen(closed);
  await closeServer(closed);
  const unreachable = await makeEnvironment(url);
  await assert.rejects(
    runRules({ action: "delete", params: { rule_ref: "rule_secret_1" }, yes: true }, unreachable, capturedOut()),
    (error: unknown) => {
      assert.ok(error instanceof CliError);
      assert.ok(error.message.includes("  npx driggsby@latest rules delete --yes\n  with the same params as before"));
      assert.ok(!error.message.includes("rule_secret_1"));
      return true;
    },
  );
  await assert.rejects(
    runRules({ action: "tags", params: {} }, unreachable, capturedOut()),
    (error: unknown) => error instanceof CliError && error.message.endsWith("  npx driggsby@latest rules tags"),
  );
});

test("a delete without --yes is refused before anything is sent, whoever calls runRules", async () => {
  const fake = await startFakeMcp((body) => successEnvelope(body, { deleted: true }));
  try {
    await assert.rejects(
      runRules({ action: "delete", params: { rule_ref: "rule_1" } }, await makeEnvironment(fake.baseUrl), capturedOut()),
      (error: unknown) => error instanceof CliError && error.exitCode === 2 && error.message.includes("--yes"),
    );
    assert.equal(fake.requests.length, 0);
  } finally {
    await fake.close();
  }
});

test("the dev preview's allowlist never includes a rule tool", () => {
  // A CLI sign-in can call the rule tools; the local preview runs untrusted
  // app code on the same sign-in, so its read-only allowlist must stay the
  // only list it serves.
  for (const tool of Object.values(RULE_ACTION_TOOLS)) {
    assert.ok(!APP_TOOL_ALLOWLIST.has(tool), tool);
  }
});
