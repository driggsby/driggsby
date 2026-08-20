// Validates the packed `driggsby` npm package before publish. Fails closed on
// anything that should never ship: install scripts, runtime dependencies,
// test files, or a broken bin. Also behavior-checks the real tarball by
// installing it into a temp prefix and running the linked bin.
//
// Usage: node scripts/release/check-npm-publish-surface.ts [expected-version]
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

const WORKSPACE = "driggsby";
const ALLOWED_FILE_PATTERN = /^(package\.json|LICENSE|README\.md|bin\/driggsby\.js|dist\/.+\.js)$/;
const FORBIDDEN_SCRIPTS = ["preinstall", "install", "postinstall", "prepare", "prepublish"];

interface PackedFile {
  path: string;
}

interface PackReport {
  filename: string;
  files: PackedFile[];
}

function fail(message: string): never {
  console.error(`error: ${message}`);
  process.exit(1);
}

function note(message: string): void {
  console.error(message);
}

const expectedVersion = process.argv[2];
const workDirectory = mkdtempSync(join(tmpdir(), "driggsby-npm-surface-"));

try {
  note(`Packing workspace ${WORKSPACE}...`);
  const packOutput = execFileSync(
    "npm",
    ["pack", "--workspace", WORKSPACE, "--pack-destination", workDirectory, "--json"],
    { encoding: "utf8" },
  );
  // With --workspace, npm pack --json reports an object keyed by workspace
  // name rather than the usual array.
  const reports = JSON.parse(packOutput) as Record<string, PackReport>;
  const report = reports[WORKSPACE];
  if (report === undefined || Object.keys(reports).length !== 1) {
    fail(`expected exactly one packed tarball for ${WORKSPACE}`);
  }

  const manifest = JSON.parse(
    readFileSync(new URL("../../packages/driggsby/package.json", import.meta.url), "utf8"),
  ) as {
    name: string;
    version: string;
    bin?: Record<string, string>;
    scripts?: Record<string, string>;
    dependencies?: Record<string, string>;
    engines?: Record<string, string>;
  };

  if (manifest.name !== "driggsby") {
    fail(`package name must be driggsby, got ${manifest.name}`);
  }
  if (expectedVersion !== undefined && manifest.version !== expectedVersion) {
    fail(`package version ${manifest.version} does not match expected ${expectedVersion}`);
  }
  if (manifest.bin?.driggsby !== "bin/driggsby.js") {
    fail("bin must map driggsby to bin/driggsby.js");
  }
  for (const script of FORBIDDEN_SCRIPTS) {
    if (manifest.scripts?.[script] !== undefined) {
      fail(`package must not have a ${script} script`);
    }
  }
  if (manifest.dependencies !== undefined && Object.keys(manifest.dependencies).length > 0) {
    fail("package must have zero runtime dependencies");
  }
  if (manifest.engines?.node !== ">=18") {
    fail(`engines.node must stay at >=18, got ${manifest.engines?.node ?? "unset"}`);
  }

  for (const file of report.files) {
    if (!ALLOWED_FILE_PATTERN.test(file.path)) {
      fail(`unexpected file in package: ${file.path}`);
    }
    if (file.path.endsWith(".test.js") || file.path.includes("__fixtures__")) {
      fail(`test artifact must not ship: ${file.path}`);
    }
  }

  const binSource = readFileSync(
    new URL("../../packages/driggsby/bin/driggsby.js", import.meta.url),
    "utf8",
  );
  if (!binSource.startsWith("#!/usr/bin/env node\n")) {
    fail("bin/driggsby.js must start with a node shebang");
  }

  note("Installing the packed tarball into a temp prefix...");
  const installPrefix = join(workDirectory, "install");
  execFileSync(
    "npm",
    [
      "install",
      "--prefix",
      installPrefix,
      "--no-save",
      "--no-audit",
      "--no-fund",
      join(workDirectory, report.filename),
    ],
    { encoding: "utf8" },
  );

  const installedCli = join(installPrefix, "node_modules", "driggsby", "bin", "driggsby.js");
  const version = execFileSync(process.execPath, [installedCli, "--version"], {
    encoding: "utf8",
  });
  if (version !== `driggsby ${manifest.version}\n`) {
    fail(`installed CLI reported ${JSON.stringify(version)}`);
  }
  const printOutput = execFileSync(
    process.execPath,
    [installedCli, "mcp", "setup", "claude-code", "--print"],
    { encoding: "utf8" },
  );
  if (!printOutput.includes("claude mcp add --transport http -s user driggsby")) {
    fail("installed CLI --print output missing the expected claude command");
  }

  note(`npm publish surface OK: driggsby@${manifest.version} (${report.files.length} files)`);
} finally {
  rmSync(workDirectory, { recursive: true, force: true });
}
