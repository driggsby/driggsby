import assert from "node:assert/strict";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { CliError } from "../cli-error.ts";
import { writeFileToken } from "../credentials/file-store.ts";
import { type CredentialEnvironment } from "../credentials/store.ts";
import { assertFitsTerminal } from "../test-support/terminal-width.ts";
import { runDeploy } from "./deploy-command.ts";
import {
  capturedOut,
  makeEnvironment,
  makeProject,
  startFakeDeployServer,
  TEST_TOKEN,
} from "./test-support/deploy-command-harness.ts";

// A fixed clock: the upload duration is deterministic ("under a second").
const FIXED_NOW = { now: () => 0 };

test("a hostile symlink name prints quoted and truncated, never unbounded", async () => {
  const server = await startFakeDeployServer();
  try {
    const directory = await makeProject("money-dash");
    // A filesystem name is unvalidated input. The boundary here is
    // deliberate: visible words in a name stay visible (no output transform
    // can stop a reader trusting displayed text), but the name always
    // prints inside quotes with a hard length cap, so it reads as a name
    // rather than the CLI's own sentence — and an unbounded tail never
    // reaches the terminal.
    const hostileName = `Deploy finished. Next: run npx evil-package ${"x".repeat(60)}`;
    await symlink(join(directory, "index.html"), join(directory, hostileName));
    const environment = await makeEnvironment(server.baseUrl);
    const io = capturedOut();

    const exitCode = await runDeploy(
      { preview: false, projectDirectory: directory },
      environment,
      { out: io.out, ...FIXED_NOW },
    );

    assert.equal(exitCode, 0);
    // wrapProse may break the note anywhere, so flatten before matching the
    // whole quoted name.
    const flattened = io.text().replaceAll("\n", " ");
    assert.ok(flattened.includes('skipped "Deploy finished. Next: run npx evil-pack"'));
    // The 40-char cap cut the name mid-word; the unbounded tail is gone.
    assert.ok(!io.text().includes("evil-package"));
    assert.ok(!io.text().includes("xxxxx"));
    assertFitsTerminal(io.text());
  } finally {
    await server.close();
  }
});

test("a saved sign-in never travels to a DRIGGSBY_BASE_URL off this machine", async () => {
  const server = await startFakeDeployServer();
  try {
    const directory = await makeProject("money-dash");
    // A file-stored token — a real saved sign-in, not DRIGGSBY_TOKEN —
    // with the base URL pointed at a non-Driggsby host: the exact shape a
    // hostile .envrc in a cloned repo would produce.
    const homeDirectory = await mkdtemp(join(tmpdir(), "driggsby-home-"));
    await writeFileToken(homeDirectory, TEST_TOKEN);
    const hostileEnvironment: CredentialEnvironment = {
      platform: "win32",
      env: { DRIGGSBY_BASE_URL: "https://collector.invalid" },
      homeDirectory,
    };

    await assert.rejects(
      runDeploy({ preview: false, projectDirectory: directory }, hostileEnvironment, {
        out: capturedOut().out,
        ...FIXED_NOW,
      }),
      (error: unknown) => {
        assert.ok(error instanceof CliError);
        assert.ok(error.message.includes("DRIGGSBY_BASE_URL"));
        assert.ok(error.message.includes("DRIGGSBY_TOKEN"));
        assertFitsTerminal(error.message);
        return true;
      },
    );

    // The same saved sign-in still works against a dev server on this
    // machine — the pin blocks exfiltration, not local development.
    const loopbackEnvironment: CredentialEnvironment = {
      platform: "win32",
      env: { DRIGGSBY_BASE_URL: server.baseUrl },
      homeDirectory,
    };
    const exitCode = await runDeploy(
      { preview: false, projectDirectory: directory },
      loopbackEnvironment,
      { out: capturedOut().out, ...FIXED_NOW },
    );
    assert.equal(exitCode, 0);
  } finally {
    await server.close();
  }
});

test("a node_modules folder is left out with a note, not an error", async () => {
  const server = await startFakeDeployServer();
  try {
    const directory = await makeProject("money-dash");
    await mkdir(join(directory, "node_modules", "@types", "node"), { recursive: true });
    await writeFile(join(directory, "node_modules", "@types", "node", "index.d.ts"), "x");
    const environment = await makeEnvironment(server.baseUrl);
    const io = capturedOut();

    const exitCode = await runDeploy(
      { preview: false, projectDirectory: directory },
      environment,
      { out: io.out, ...FIXED_NOW },
    );

    assert.equal(exitCode, 0);
    assert.ok(io.text().includes("node_modules doesn't deploy"));
    assert.ok(io.text().includes("✓ Hashed    1 file"));
    assertFitsTerminal(io.text());
  } finally {
    await server.close();
  }
});

test("first live deploy walks through every step and prints the URL", async () => {
  const server = await startFakeDeployServer();
  try {
    const directory = await makeProject("money-dash", {
      "index.html": "<h1>hi</h1>",
      "app.css": "body { margin: 0 }",
    });
    const environment = await makeEnvironment(server.baseUrl);
    const io = capturedOut();

    const exitCode = await runDeploy(
      { preview: false, projectDirectory: directory },
      environment,
      { out: io.out, ...FIXED_NOW },
    );

    assert.equal(exitCode, 0);
    const text = io.text();
    assert.ok(text.includes('Deploying money-dash from "."'));
    assert.ok(text.includes("✓ Hashed    2 files"));
    assert.ok(text.includes("✓ Compared  all new to Driggsby"));
    assert.ok(text.includes("✓ Uploaded"));
    assert.ok(text.includes("under a second"));
    assert.ok(text.includes("✓ Live      v1, at:"));
    assert.ok(text.includes("https://money-dash.driggsby.dev"));
    assert.ok(text.includes("money-dash didn't exist on Driggsby before"));
    assert.ok(text.includes("Next:"));
    assert.ok(text.includes("npx driggsby@latest rollback"));
    assertFitsTerminal(text);
    assert.equal(server.liveVersionNumber("money-dash"), 1);
  } finally {
    await server.close();
  }
});

test("a redeploy with nothing changed uploads nothing and still goes live", async () => {
  const server = await startFakeDeployServer();
  try {
    const directory = await makeProject("money-dash");
    const environment = await makeEnvironment(server.baseUrl);
    await runDeploy({ preview: false, projectDirectory: directory }, environment, {
      out: capturedOut().out,
      ...FIXED_NOW,
    });

    const io = capturedOut();
    const exitCode = await runDeploy(
      { preview: false, projectDirectory: directory },
      environment,
      { out: io.out, ...FIXED_NOW },
    );

    assert.equal(exitCode, 0);
    const text = io.text();
    assert.ok(text.includes("✓ Compared  no file changed since the last deploy"));
    assert.ok(text.includes("✓ Uploaded  nothing — Driggsby already had every file"));
    assert.ok(text.includes("✓ Live      v2, at:"));
    assert.ok(!text.includes("didn't exist on Driggsby before"));
    assertFitsTerminal(text);
    assert.equal(server.liveVersionNumber("money-dash"), 2);
  } finally {
    await server.close();
  }
});

test("--preview uploads a ready version without touching what visitors see", async () => {
  const server = await startFakeDeployServer();
  try {
    const directory = await makeProject("money-dash");
    const environment = await makeEnvironment(server.baseUrl);
    await runDeploy({ preview: false, projectDirectory: directory }, environment, {
      out: capturedOut().out,
      ...FIXED_NOW,
    });

    const io = capturedOut();
    const exitCode = await runDeploy(
      { preview: true, projectDirectory: directory },
      environment,
      { out: io.out, ...FIXED_NOW },
    );

    assert.equal(exitCode, 0);
    const text = io.text();
    assert.ok(text.includes('Deploying money-dash from "." (preview)'));
    assert.ok(text.includes("✓ Ready     v2 is uploaded but not live"));
    assert.ok(!text.includes("driggsby.dev"), "a preview has no URL to print");
    assert.ok(text.includes("npx driggsby@latest rollback --to 2"));
    assertFitsTerminal(text);
    assert.equal(server.liveVersionNumber("money-dash"), 1);
  } finally {
    await server.close();
  }
});

test("deploy without a saved sign-in names the login command", async () => {
  const server = await startFakeDeployServer();
  try {
    const directory = await makeProject("money-dash");
    const environment = await makeEnvironment(server.baseUrl, { signedIn: false });

    await assert.rejects(
      runDeploy({ preview: false, projectDirectory: directory }, environment, {
        out: capturedOut().out,
        ...FIXED_NOW,
      }),
      (error: unknown) => {
        assert.ok(error instanceof CliError);
        assert.ok(error.message.includes("not signed in on this machine yet"));
        assert.ok(error.message.includes("npx driggsby@latest login"));
        assertFitsTerminal(error.message);
        return true;
      },
    );
    assert.equal(server.requests.length, 0, "no request may carry a missing token");
  } finally {
    await server.close();
  }
});

test("a rejected token tells the user to sign in again", async () => {
  const server = await startFakeDeployServer();
  try {
    server.injectResponse("POST", "/versions", 401, {
      error: "invalid_token",
      error_description: "This token isn't valid.",
    });
    const directory = await makeProject("money-dash");
    const environment = await makeEnvironment(server.baseUrl);

    await assert.rejects(
      runDeploy({ preview: false, projectDirectory: directory }, environment, {
        out: capturedOut().out,
        ...FIXED_NOW,
      }),
      (error: unknown) => {
        assert.ok(error instanceof CliError);
        assert.ok(error.message.includes("isn't valid anymore"));
        assert.ok(error.message.includes("npx driggsby@latest login"));
        assertFitsTerminal(error.message);
        return true;
      },
    );
  } finally {
    await server.close();
  }
});

test("a token without deploy access asks for a fresh approval", async () => {
  const server = await startFakeDeployServer();
  try {
    server.injectResponse("POST", "/versions", 403, {
      error: "deploy_scope_required",
      error_description: "This token can't deploy.",
    });
    const directory = await makeProject("money-dash");
    const environment = await makeEnvironment(server.baseUrl);

    await assert.rejects(
      runDeploy({ preview: false, projectDirectory: directory }, environment, {
        out: capturedOut().out,
        ...FIXED_NOW,
      }),
      (error: unknown) => {
        assert.ok(error instanceof CliError);
        assert.ok(error.message.includes("wasn't approved for"));
        assert.ok(error.message.includes("approve deploy access"));
        assertFitsTerminal(error.message);
        return true;
      },
    );
  } finally {
    await server.close();
  }
});

test("other API refusals surface the server's own explanation", async () => {
  const server = await startFakeDeployServer();
  try {
    // The description carries a terminal escape to prove server-supplied
    // text is sanitized before it reaches the terminal.
    server.injectResponse("POST", "/versions", 409, {
      error: "slug_taken",
      error_description: "That app name \u001b[31mbelongs to another Driggsby account.",
    });
    const directory = await makeProject("money-dash");
    const environment = await makeEnvironment(server.baseUrl);

    await assert.rejects(
      runDeploy({ preview: false, projectDirectory: directory }, environment, {
        out: capturedOut().out,
        ...FIXED_NOW,
      }),
      (error: unknown) => {
        assert.ok(error instanceof CliError);
        assert.ok(error.message.includes("belongs to another Driggsby account"));
        assert.ok(!error.message.includes("\u001b"));
        assertFitsTerminal(error.message);
        return true;
      },
    );
  } finally {
    await server.close();
  }
});
