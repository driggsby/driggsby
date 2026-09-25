import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { after, test } from "node:test";

import { CliError } from "../cli-error.ts";
import { assertFitsTerminal } from "../test-support/terminal-width.ts";
import { type ClaimPkce, createClaimRequest, pollClaimRequest, tradeCode } from "./claim-client.ts";

interface RecordedRequest {
  method: string;
  url: string;
  contentType: string;
  body: unknown;
}

interface FakeServer {
  baseUrl: string;
  requests: RecordedRequest[];
  respondWith: (status: number, body: unknown, headers?: Record<string, string>) => void;
}

const servers: Server[] = [];
after(() => {
  for (const server of servers) {
    server.close();
  }
});

function startFakeServer(): Promise<FakeServer> {
  const requests: RecordedRequest[] = [];
  let nextResponse: { status: number; body: unknown; headers?: Record<string, string> } = {
    status: 500,
    body: {},
  };
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      requests.push({
        method: request.method ?? "",
        url: request.url ?? "",
        contentType: request.headers["content-type"] ?? "",
        body: raw === "" ? null : JSON.parse(raw),
      });
      response.writeHead(nextResponse.status, {
        "Content-Type": "application/json",
        ...(nextResponse.headers ?? {}),
      });
      response.end(JSON.stringify(nextResponse.body));
    });
  });
  servers.push(server);
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        throw new Error("no server address");
      }
      resolve({
        baseUrl: `http://127.0.0.1:${address.port}`,
        requests,
        respondWith: (status, body, headers) => {
          nextResponse = { status, body, ...(headers === undefined ? {} : { headers }) };
        },
      });
    });
  });
}

const PKCE: ClaimPkce = { challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM", redirectUri: null };
const PKCE_FIELDS = { code_challenge: PKCE.challenge, code_challenge_method: "S256" };

const CREATED_BODY = {
  claim_request_id: "11111111-2222-3333-4444-555555555555",
  claim_url: "https://app.driggsby.example/connect/11111111-2222-3333-4444-555555555555",
  poll_secret: "fake-poll-secret",
  poll_url: "https://app.driggsby.example/app-tokens/claim-requests/poll",
  expires_in: 600,
};

test("createClaimRequest sends the CLI-scope claim with its challenge and parses the response", async () => {
  const server = await startFakeServer();
  server.respondWith(201, CREATED_BODY);

  const claim = await createClaimRequest(server.baseUrl, PKCE);

  assert.deepEqual(claim, {
    claimRequestId: "11111111-2222-3333-4444-555555555555",
    claimUrl: "https://app.driggsby.example/connect/11111111-2222-3333-4444-555555555555",
    pollSecret: "fake-poll-secret",
    expiresInSeconds: 600,
  });
  const request = server.requests[0];
  assert.ok(request !== undefined);
  assert.equal(request.method, "POST");
  assert.equal(request.url, "/app-tokens/claim-requests");
  assert.ok(request.contentType.startsWith("application/json"));
  assert.deepEqual(request.body, { app_name: "Driggsby CLI", scope: "driggsby.cli", ...PKCE_FIELDS });
});

test("createClaimRequest names the loopback it listens on, when it has one", async () => {
  const server = await startFakeServer();
  server.respondWith(201, CREATED_BODY);

  await createClaimRequest(server.baseUrl, { ...PKCE, redirectUri: "http://127.0.0.1:43110/callback" });

  assert.deepEqual(server.requests[0]?.body, {
    app_name: "Driggsby CLI",
    scope: "driggsby.cli",
    ...PKCE_FIELDS,
    redirect_uri: "http://127.0.0.1:43110/callback",
  });
});

test("createClaimRequest names this computer when it knows it, and only what it knows", async () => {
  const server = await startFakeServer();
  server.respondWith(201, CREATED_BODY);

  await createClaimRequest(server.baseUrl, PKCE, { name: "devbox-02", system: "Ubuntu 24.04" });
  await createClaimRequest(server.baseUrl, PKCE, { name: null, system: "Windows 11" });

  assert.deepEqual(server.requests[0]?.body, {
    app_name: "Driggsby CLI",
    scope: "driggsby.cli",
    ...PKCE_FIELDS,
    device: { name: "devbox-02", system: "Ubuntu 24.04" },
  });
  assert.deepEqual(server.requests[1]?.body, {
    app_name: "Driggsby CLI",
    scope: "driggsby.cli",
    ...PKCE_FIELDS,
    device: { system: "Windows 11" },
  });
});

test("createClaimRequest surfaces the server's error_description verbatim", async () => {
  const server = await startFakeServer();
  server.respondWith(429, {
    error: "too_many_requests",
    error_description: "This app already has several pending connection requests.",
  });

  await assert.rejects(createClaimRequest(server.baseUrl, PKCE), (error: unknown) => {
    assert.ok(error instanceof CliError);
    assert.equal(error.exitCode, 1);
    assert.ok(error.message.includes("This app already has several pending connection requests."));
    return true;
  });
});

test("createClaimRequest rejects a malformed success response", async () => {
  const server = await startFakeServer();
  server.respondWith(201, { claim_request_id: "x" });
  await assert.rejects(createClaimRequest(server.baseUrl, PKCE), (error: unknown) => {
    assert.ok(error instanceof CliError);
    assertFitsTerminal(error.message);
    return true;
  });
});

test("a poll failure without server text still reads cleanly", async () => {
  // No error_description, so the CLI's own finish-stage fallback renders —
  // and like every other message, it must fit an 80-column terminal.
  const server = await startFakeServer();
  server.respondWith(400, { error: "bad_request" });
  await assert.rejects(
    pollClaimRequest(server.baseUrl, { claimRequestId: "a", pollSecret: "b" }),
    (error: unknown) => {
      assert.ok(error instanceof CliError);
      assert.ok(error.message.includes("finish"));
      assertFitsTerminal(error.message);
      return true;
    },
  );
});

test("pollClaimRequest passes through pending, approved, and gone", async () => {
  const server = await startFakeServer();
  const credentials = { claimRequestId: "id-1", pollSecret: "secret-1" };

  server.respondWith(200, { status: "pending" });
  assert.deepEqual(await pollClaimRequest(server.baseUrl, credentials), { kind: "pending" });
  const request = server.requests[0];
  assert.ok(request !== undefined);
  assert.deepEqual(request.body, { claim_request_id: "id-1", poll_secret: "secret-1" });
  assert.equal(request.url, "/app-tokens/claim-requests/poll");

  server.respondWith(200, { status: "approved", app_token: "dgb_at_test_1111", mcp_url: "x" });
  assert.deepEqual(await pollClaimRequest(server.baseUrl, credentials), {
    kind: "approved",
    appToken: "dgb_at_test_1111",
  });

  server.respondWith(200, { status: "gone", note: "no longer active" });
  assert.deepEqual(await pollClaimRequest(server.baseUrl, credentials), { kind: "gone" });
});

test("pollClaimRequest fails fast on invalid_poll_request instead of retrying", async () => {
  const server = await startFakeServer();
  server.respondWith(422, {
    error: "invalid_poll_request",
    error_description: "Send a JSON object body.",
  });
  await assert.rejects(pollClaimRequest(server.baseUrl, { claimRequestId: "a", pollSecret: "b" }), CliError);
});

test("pollClaimRequest reports transient trouble for 5xx responses", async () => {
  const server = await startFakeServer();
  server.respondWith(503, { error: "temporarily_unavailable", error_description: "momentary" });
  assert.deepEqual(await pollClaimRequest(server.baseUrl, { claimRequestId: "a", pollSecret: "b" }), {
    kind: "transient",
  });
});

test("pollClaimRequest treats a vanished claim as gone, not worth retrying", async () => {
  const server = await startFakeServer();
  server.respondWith(404, { error: "not_found" });
  assert.deepEqual(await pollClaimRequest(server.baseUrl, { claimRequestId: "a", pollSecret: "b" }), {
    kind: "gone",
  });
});

test("server error text is stripped of terminal control bytes", async () => {
  const server = await startFakeServer();
  server.respondWith(429, {
    error: "too_many_requests",
    error_description: "Too many\u001b[2K\u0007 requests.",
  });
  await assert.rejects(createClaimRequest(server.baseUrl, PKCE), (error: unknown) => {
    assert.ok(error instanceof CliError);
    assert.equal(error.message, "Too many[2K requests.");
    return true;
  });
});

test("pollClaimRequest treats rate limiting as transient, not fatal", async () => {
  const server = await startFakeServer();
  server.respondWith(429, { error: "too_many_requests", error_description: "Slow down." });
  assert.deepEqual(await pollClaimRequest(server.baseUrl, { claimRequestId: "a", pollSecret: "b" }), {
    kind: "transient",
  });
});

test("an oversized error_description is truncated, not dumped to the terminal", async () => {
  const server = await startFakeServer();
  server.respondWith(400, { error: "bad_request", error_description: "x".repeat(10_000) });
  await assert.rejects(createClaimRequest(server.baseUrl, PKCE), (error: unknown) => {
    assert.ok(error instanceof CliError);
    assert.equal(error.message.length, 300);
    return true;
  });
});

test("neither claim call ever follows a redirect", async () => {
  // A 307 would replay the request — poll secret included — to whatever
  // origin the Location header names, and hand back that origin's "token".
  // The redirect target here is a real, reachable server answering with a
  // perfectly valid claim body: if either fetch ever followed the redirect,
  // the create below would succeed and the target would record the hit.
  const redirectTarget = await startFakeServer();
  redirectTarget.respondWith(201, CREATED_BODY);
  const server = await startFakeServer();
  server.respondWith(307, {}, { Location: `${redirectTarget.baseUrl}/steal` });

  await assert.rejects(createClaimRequest(server.baseUrl, PKCE));
  assert.deepEqual(await pollClaimRequest(server.baseUrl, { claimRequestId: "a", pollSecret: "b" }), {
    kind: "transient",
  });
  // The redirect target never saw a request — neither the claim create nor
  // the poll secret was replayed to the Location origin.
  assert.deepEqual(redirectTarget.requests, []);
  // Both requests reached only the origin the CLI was pointed at.
  assert.equal(server.requests.length, 2);
});

test("an absurd expires_in is capped so the CLI never waits forever", async () => {
  const server = await startFakeServer();
  server.respondWith(201, { ...CREATED_BODY, expires_in: 1_000_000_000 });
  const claim = await createClaimRequest(server.baseUrl, PKCE);
  assert.equal(claim.expiresInSeconds, 1_800);
});

const TRADE = { claimRequestId: "claim-1", code: "7KQ2M-9XH4T-A0B1C-DEFGH", codeVerifier: "v".repeat(43) };

test("tradeCode sends the claim, code and verifier, and returns the token", async () => {
  const server = await startFakeServer();
  server.respondWith(200, { app_token: "dgb_at_test_1111", mcp_url: "x" });

  assert.deepEqual(await tradeCode(server.baseUrl, TRADE), { kind: "approved", appToken: "dgb_at_test_1111" });
  const request = server.requests[0];
  assert.equal(request?.url, "/app-tokens/claim-requests/token");
  assert.deepEqual(request.body, {
    claim_request_id: "claim-1",
    code: "7KQ2M-9XH4T-A0B1C-DEFGH",
    code_verifier: "v".repeat(43),
  });
});

test("tradeCode reads a refused code as rejected, in the CLI's own words", async () => {
  const server = await startFakeServer();
  server.respondWith(400, { error: "invalid_grant", error_description: "Start a fresh sign-in.\u001b[2J" });

  const result = await tradeCode(server.baseUrl, TRADE);

  assert.ok(result.kind === "rejected");
  assert.ok(result.message.startsWith("That sign-in code didn't work."));
  assert.ok(!result.message.includes("Start a fresh"));
  assert.ok(!result.message.includes("\u001b"));
});

test("tradeCode treats a busy or unreachable server as momentary and a malformed reply as a bug", async () => {
  const server = await startFakeServer();
  for (const status of [429, 500, 503]) {
    server.respondWith(status, {});
    assert.deepEqual(await tradeCode(server.baseUrl, TRADE), { kind: "transient" });
  }
  assert.deepEqual(await tradeCode("http://127.0.0.1:1", TRADE), { kind: "transient" });

  // A trade Driggsby reads as blank is a wrong code, and the prompt asks again.
  server.respondWith(422, { error: "invalid_token_request", error_description: "Send a JSON object body." });
  assert.equal((await tradeCode(server.baseUrl, TRADE)).kind, "rejected");
  server.respondWith(200, { status: "approved" });
  await assert.rejects(tradeCode(server.baseUrl, TRADE), CliError);
});

test("tradeCode never follows a redirect with the code and verifier", async () => {
  const server = await startFakeServer();
  server.respondWith(307, {}, { Location: "https://evil.example/token" });

  assert.deepEqual(await tradeCode(server.baseUrl, TRADE), { kind: "transient" });
  assert.equal(server.requests.length, 1);
});
