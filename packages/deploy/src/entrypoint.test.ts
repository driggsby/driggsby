import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { type EntrypointIo, runDeployEntrypoint } from "./entrypoint.ts";
import { startFakeDeployServer } from "./test-support/fake-deploy-server.ts";

interface CapturedIo extends EntrypointIo {
  stdout: () => string;
  stderr: () => string;
}

function capturedIo(cwd: string, env: NodeJS.ProcessEnv, argv: string[] = []): CapturedIo {
  let out = "";
  let error = "";
  return {
    argv,
    cwd,
    env,
    out: (text) => {
      out += text;
    },
    error: (text) => {
      error += text;
    },
    stdout: () => out,
    stderr: () => error,
  };
}

test("deploys the current directory live and prints the URL", async () => {
  const server = await startFakeDeployServer();
  try {
    const directory = await mkdtemp(join(tmpdir(), "driggsby-entrypoint-"));
    await writeFile(join(directory, "driggsby.json"), '{ "slug": "money-dash" }');
    await writeFile(join(directory, "index.html"), "<h1>hi</h1>");
    const io = capturedIo(directory, {
      DRIGGSBY_TOKEN: "dgb_at_test_token_3333",
      DRIGGSBY_BASE_URL: server.baseUrl,
    });
    const exitCode = await runDeployEntrypoint(io);
    assert.equal(exitCode, 0);
    assert.ok(io.stdout().includes('Deployed "money-dash" (v1'));
    assert.ok(io.stdout().includes("https://money-dash.driggsby.dev"));
    assert.equal(io.stderr(), "");
  } finally {
    await server.close();
  }
});

test("a first deploy creates the app, saves the assigned slug, and says to commit it", async () => {
  const server = await startFakeDeployServer();
  try {
    const directory = await mkdtemp(join(tmpdir(), "driggsby-entrypoint-"));
    await writeFile(join(directory, "driggsby.json"), '{ "slug": "money-dash" }');
    await writeFile(join(directory, "index.html"), "<h1>hi</h1>");
    server.injectResponse("POST", "/deploy/apps/money-dash/versions", 404, {
      error: "app_not_found",
      error_description: "missing",
    });
    const io = capturedIo(directory, {
      DRIGGSBY_TOKEN: "dgb_at_test_token_3333",
      DRIGGSBY_BASE_URL: server.baseUrl,
    });
    const exitCode = await runDeployEntrypoint(io);
    assert.equal(exitCode, 0);
    const assignedMatch = /"(money-dash-[a-z0-9]{6})"/.exec(io.stdout());
    assert.ok(assignedMatch !== null, "the created line must name the assigned slug");
    const assigned = assignedMatch[1] ?? "";
    assert.ok(io.stdout().includes("Created your app as"));
    // This bin targets ephemeral sandboxes, where a discarded driggsby.json
    // means a new app on every run — the commit reminder is the fix.
    // wrapProse may break the phrase across lines, so match unwrapped text.
    assert.ok(io.stdout().replace(/\n/g, " ").includes("Commit that updated driggsby.json"));
    assert.ok(io.stdout().includes(`Deployed "${assigned}" (v1`));
    for (const line of io.stdout().split("\n")) {
      assert.ok(line.length <= 80, `line exceeds 80 columns: ${line}`);
    }
    const rewritten = JSON.parse(
      await readFile(join(directory, "driggsby.json"), "utf8"),
    ) as { slug?: unknown };
    assert.equal(rewritten.slug, assigned);
  } finally {
    await server.close();
  }
});

test("a missing DRIGGSBY_TOKEN points at the full CLI's login flow", async () => {
  const directory = await mkdtemp(join(tmpdir(), "driggsby-entrypoint-"));
  const io = capturedIo(directory, {});
  const exitCode = await runDeployEntrypoint(io);
  assert.equal(exitCode, 1);
  assert.ok(io.stderr().includes("DRIGGSBY_TOKEN"));
  assert.ok(io.stderr().includes("npx driggsby@latest login"));
});

test("deploy errors print their consumer-grade message and exit 1", async () => {
  const directory = await mkdtemp(join(tmpdir(), "driggsby-entrypoint-"));
  const io = capturedIo(directory, { DRIGGSBY_TOKEN: "dgb_at_test_token_3333" });
  const exitCode = await runDeployEntrypoint(io);
  assert.equal(exitCode, 1);
  assert.ok(io.stderr().includes("driggsby.json"));
});

test("server-supplied strings are sanitized before printing", async () => {
  const server = await startFakeDeployServer();
  try {
    const directory = await mkdtemp(join(tmpdir(), "driggsby-entrypoint-"));
    await writeFile(join(directory, "driggsby.json"), '{ "slug": "money-dash" }');
    await writeFile(join(directory, "index.html"), "<h1>hi</h1>");
    // A hostile finalize response: an escape in the slug, and a carriage
    // return that would visually replace the real URL with a different one.
    server.injectResponse("POST", "/finalize", 200, {
      app_slug: "money-dash\u001b[2K",
      version_number: 1,
      live: true,
      url: "https://money-dash.driggsby.dev\r   https://evil.example",
    });
    const io = capturedIo(directory, {
      DRIGGSBY_TOKEN: "dgb_at_test_token_3333",
      DRIGGSBY_BASE_URL: server.baseUrl,
    });
    const exitCode = await runDeployEntrypoint(io);
    assert.equal(exitCode, 0);
    assert.ok(!io.stdout().includes("\u001b"));
    assert.ok(!io.stdout().includes("\r"));
  } finally {
    await server.close();
  }
});

test("a server error's description is sanitized and capped before printing", async () => {
  const server = await startFakeDeployServer();
  try {
    const directory = await mkdtemp(join(tmpdir(), "driggsby-entrypoint-"));
    await writeFile(join(directory, "driggsby.json"), '{ "slug": "money-dash" }');
    await writeFile(join(directory, "index.html"), "<h1>hi</h1>");
    server.injectResponse("POST", "/versions", 409, {
      error: "slug_taken",
      error_description: `That name is taken\u001b[31m.${"x".repeat(4_000)}`,
    });
    const io = capturedIo(directory, {
      DRIGGSBY_TOKEN: "dgb_at_test_token_3333",
      DRIGGSBY_BASE_URL: server.baseUrl,
    });
    const exitCode = await runDeployEntrypoint(io);
    assert.equal(exitCode, 1);
    // wrapProse may break the sentence across lines, so match a fragment
    // that fits on one.
    assert.ok(io.stderr().includes("That name is"));
    assert.ok(!io.stderr().includes("\u001b"));
    // The 300-char cap, plus only the newlines wrapping inserts — and no
    // wrapped line may overflow the terminal.
    assert.ok(io.stderr().length <= 306);
    for (const line of io.stderr().split("\n")) {
      assert.ok(line.length <= 76, `line exceeds 76 columns: ${line}`);
    }
  } finally {
    await server.close();
  }
});

test("a 503 gets copy for the person running the bin, not protocol vocabulary", async () => {
  const server = await startFakeDeployServer();
  try {
    const directory = await mkdtemp(join(tmpdir(), "driggsby-entrypoint-"));
    await writeFile(join(directory, "driggsby.json"), '{ "slug": "money-dash" }');
    await writeFile(join(directory, "index.html"), "<h1>hi</h1>");
    server.injectResponse("POST", "/versions", 503, {
      error: "service_unavailable",
      error_description: "Retry the same PUT in a few seconds.",
    });
    const io = capturedIo(directory, {
      DRIGGSBY_TOKEN: "dgb_at_test_token_3333",
      DRIGGSBY_BASE_URL: server.baseUrl,
    });
    const exitCode = await runDeployEntrypoint(io);
    assert.equal(exitCode, 1);
    assert.ok(io.stderr().includes("briefly unavailable"));
    assert.ok(!io.stderr().includes("PUT"));
  } finally {
    await server.close();
  }
});

test("--help prints usage and deploys nothing", async () => {
  // No token and no fake server: if this invocation tried to deploy, it
  // would fail loudly instead of exiting 0.
  const directory = await mkdtemp(join(tmpdir(), "driggsby-entrypoint-"));
  await writeFile(join(directory, "driggsby.json"), '{ "slug": "money-dash" }');
  await writeFile(join(directory, "index.html"), "<h1>hi</h1>");
  for (const flag of ["--help", "-h"]) {
    const io = capturedIo(directory, {}, [flag]);
    const exitCode = await runDeployEntrypoint(io);
    assert.equal(exitCode, 0, flag);
    assert.ok(io.stdout().includes("Usage:"));
    assert.ok(io.stdout().includes("npx @driggsby/deploy"));
    // The pointer at the full CLI must name a command that actually exists:
    // `driggsby help` is not a subcommand, `--help` is.
    assert.ok(io.stdout().includes("npx driggsby@latest --help"));
    assert.ok(!io.stdout().includes("driggsby@latest help"));
    assert.equal(io.stderr(), "");
  }
});

test("--version prints the package version and deploys nothing", async () => {
  const directory = await mkdtemp(join(tmpdir(), "driggsby-entrypoint-"));
  const io = capturedIo(directory, {}, ["--version"]);
  const exitCode = await runDeployEntrypoint(io);
  assert.equal(exitCode, 0);
  assert.match(io.stdout(), /^\d+\.\d+\.\d+\n$/);
});

test("an unexpected argument refuses to deploy and exits 2", async () => {
  // An agent guessing at flags (--preview, --dry-run, a typo) must never
  // trigger a live publish.
  const directory = await mkdtemp(join(tmpdir(), "driggsby-entrypoint-"));
  await writeFile(join(directory, "driggsby.json"), '{ "slug": "money-dash" }');
  await writeFile(join(directory, "index.html"), "<h1>hi</h1>");
  const io = capturedIo(directory, { DRIGGSBY_TOKEN: "dgb_at_test_token_3333" }, ["--preview"]);
  const exitCode = await runDeployEntrypoint(io);
  assert.equal(exitCode, 2);
  assert.ok(io.stderr().includes("--preview"));
  assert.ok(io.stderr().includes("Nothing was deployed."));
  assert.ok(io.stderr().includes("Usage:"));
  assert.equal(io.stdout(), "");
});

test("a 5xx body without an error code renders the fallback message readably", async () => {
  const server = await startFakeDeployServer();
  try {
    const directory = await mkdtemp(join(tmpdir(), "driggsby-entrypoint-"));
    await writeFile(join(directory, "driggsby.json"), '{ "slug": "money-dash" }');
    await writeFile(join(directory, "index.html"), "<h1>hi</h1>");
    // A load balancer's error page: JSON, but not the API's error shape.
    server.injectResponse("POST", "/versions", 502, { oops: true });
    const io = capturedIo(directory, {
      DRIGGSBY_TOKEN: "dgb_at_test_token_3333",
      DRIGGSBY_BASE_URL: server.baseUrl,
    });
    const exitCode = await runDeployEntrypoint(io);
    assert.equal(exitCode, 1);
    assert.ok(io.stderr().includes("didn't recognize"));
    // The fallback message has its own newline; sanitizing must turn it into
    // a space, never delete it and glue the words together.
    assert.ok(!io.stderr().includes("tryagain"));
  } finally {
    await server.close();
  }
});
