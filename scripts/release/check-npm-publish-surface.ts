// Validates the packed `driggsby` npm package before publish. Fails closed on
// anything that should never ship: install scripts, runtime dependencies,
// test files, or a broken bin. Also behavior-checks the real tarball by
// installing it into a temp prefix and running the linked bin — and validates
// the manifest and shebang from that installed copy, so the checks bind to
// the packed bytes rather than the source tree.
//
// Usage: node scripts/release/check-npm-publish-surface.ts [expected-version]
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

const WORKSPACE = "driggsby";
const ALLOWED_FILE_PATTERN = /^(package\.json|LICENSE|README\.md|bin\/driggsby\.js|dist\/.+\.js)$/;
// Both the consumer-side install hooks AND the publish-side hooks: prepack/
// prepublishOnly run inside the trusted-publishing job, the highest-trust
// step in the repo, so they must not exist at all (publishing also passes
// --ignore-scripts as a second layer).
const FORBIDDEN_SCRIPTS = [
  "preinstall",
  "install",
  "postinstall",
  "prepare",
  "prepublish",
  "prepublishOnly",
  "prepack",
  "postpack",
  "publish",
  "postpublish",
];
// The npm fields that can pull third-party code onto a consumer's machine.
// optionalDependencies is how the ecosystem ships per-platform native
// binaries — exactly what this package must never reintroduce.
const FORBIDDEN_DEPENDENCY_FIELDS = [
  "dependencies",
  "optionalDependencies",
  "peerDependencies",
  "bundledDependencies",
  "bundleDependencies",
];

interface PackedFile {
  path: string;
}

interface PackReport {
  name?: string;
  filename: string;
  files: PackedFile[];
}

// npm's `pack --workspace X --json` output shape differs by npm major: npm 11
// (bundled with current LTS Node) reports the usual ARRAY of pack reports,
// while npm 12 reports an OBJECT keyed by workspace name. Accept both,
// requiring exactly one report and that it is for the requested workspace.
function singlePackReport(packOutput: string, workspace: string): PackReport | undefined {
  const parsed = JSON.parse(packOutput) as PackReport[] | Record<string, PackReport>;
  if (Array.isArray(parsed)) {
    const report = parsed[0];
    if (parsed.length !== 1 || report?.name !== workspace) {
      return undefined;
    }
    return report;
  }
  if (Object.keys(parsed).length !== 1) {
    return undefined;
  }
  return parsed[workspace];
}

// Thrown instead of process.exit so the temp-directory cleanup in the finally
// block below always runs, even on a failing check.
class SurfaceCheckFailure extends Error {}

function fail(message: string): never {
  throw new SurfaceCheckFailure(message);
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
    [
      "pack",
      "--workspace",
      WORKSPACE,
      "--ignore-scripts",
      "--pack-destination",
      workDirectory,
      "--json",
    ],
    { encoding: "utf8" },
  );
  const report = singlePackReport(packOutput, WORKSPACE);
  if (report === undefined) {
    fail(`expected exactly one packed tarball for ${WORKSPACE}`);
  }

  for (const file of report.files) {
    if (!ALLOWED_FILE_PATTERN.test(file.path)) {
      fail(`unexpected file in package: ${file.path}`);
    }
    if (
      file.path.endsWith(".test.js") ||
      file.path.includes("__fixtures__") ||
      file.path.includes("test-support")
    ) {
      fail(`test artifact must not ship: ${file.path}`);
    }
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
      "--ignore-scripts",
      join(workDirectory, report.filename),
    ],
    { encoding: "utf8" },
  );

  const installedPackage = join(installPrefix, "node_modules", "driggsby");
  const manifest = JSON.parse(readFileSync(join(installedPackage, "package.json"), "utf8")) as Record<
    string,
    unknown
  > & {
    name: string;
    version: string;
    bin?: Record<string, string>;
    scripts?: Record<string, string>;
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
  for (const field of FORBIDDEN_DEPENDENCY_FIELDS) {
    const value = manifest[field];
    if (
      value !== undefined &&
      (typeof value !== "object" || value === null || Object.keys(value).length > 0)
    ) {
      fail(`package must have zero runtime dependencies; ${field} is set`);
    }
  }
  if (manifest.engines?.node !== ">=18") {
    fail(`engines.node must stay at >=18, got ${manifest.engines?.node ?? "unset"}`);
  }

  const binSource = readFileSync(join(installedPackage, "bin", "driggsby.js"), "utf8");
  if (!binSource.startsWith("#!/usr/bin/env node\n")) {
    fail("bin/driggsby.js must start with a node shebang");
  }

  const installedCli = join(installedPackage, "bin", "driggsby.js");
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
} catch (error) {
  if (!(error instanceof SurfaceCheckFailure)) {
    throw error;
  }
  console.error(`error: ${error.message}`);
  process.exitCode = 1;
} finally {
  rmSync(workDirectory, { recursive: true, force: true });
}
