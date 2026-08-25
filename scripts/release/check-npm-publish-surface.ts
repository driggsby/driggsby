// Validates the packed npm packages before publish. Fails closed on anything
// that should never ship: install scripts, unexpected runtime dependencies,
// test files, or a broken bin. Also behavior-checks the real tarballs by
// installing BOTH into one temp prefix — so `driggsby`'s dependency on
// `@driggsby/deploy` resolves from the local tarball, exactly as the publish
// pair will resolve from the registry — and validates each manifest and
// shebang from that installed copy, binding the checks to the packed bytes
// rather than the source tree.
//
// Usage: node scripts/release/check-npm-publish-surface.ts [expected-version]
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

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
// binaries — exactly what these packages must never reintroduce. `driggsby`
// is allowed exactly one entry in `dependencies` (our own @driggsby/deploy,
// checked separately below); everything else stays empty for both packages.
const FORBIDDEN_DEPENDENCY_FIELDS = [
  "optionalDependencies",
  "peerDependencies",
  "bundledDependencies",
  "bundleDependencies",
];

interface PackageExpectation {
  workspace: string;
  // null for library-only packages that must ship no bin at all.
  bin: { binName: string; binPath: string } | null;
  allowedFilePattern: RegExp;
}

const DEPLOY_EXPECTATION: PackageExpectation = {
  workspace: "@driggsby/deploy",
  bin: { binName: "driggsby-deploy", binPath: "bin/driggsby-deploy.js" },
  // Like the CLI pattern below: no dist file may start with a dot — a stray
  // dot-file in dist must fail this check, not pack silently.
  allowedFilePattern:
    /^(package\.json|LICENSE|README\.md|bin\/driggsby-deploy\.js|dist\/[^/.][^/]*\.(js|d\.ts))$/,
};

const SDK_EXPECTATION: PackageExpectation = {
  workspace: "@driggsby/sdk",
  bin: null,
  // A flat dist: the module build plus the one self-contained browser
  // bundle. No dot-files, no nesting, no bin.
  allowedFilePattern: /^(package\.json|LICENSE|README\.md|dist\/[^/.][^/]*\.(js|d\.ts))$/,
};

const CLI_EXPECTATION: PackageExpectation = {
  workspace: "driggsby",
  bin: { binName: "driggsby", binPath: "bin/driggsby.js" },
  // dist may nest (api/, deploy/, login/), but no path segment may start
  // with a dot — a stray dot-directory in dist must fail this check, not
  // pack silently.
  allowedFilePattern:
    /^(package\.json|LICENSE|README\.md|bin\/driggsby\.js|dist\/(?:[^/.][^/]*\/)*[^/.][^/]*\.js)$/,
};

interface PackedFile {
  path: string;
}

interface PackReport {
  name?: string;
  filename: string;
  files: PackedFile[];
}

interface PackageManifest {
  name: string;
  version: string;
  bin?: Record<string, string>;
  scripts?: Record<string, string>;
  engines?: Record<string, string>;
  dependencies?: Record<string, string>;
  [field: string]: unknown;
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

function packWorkspace(expectation: PackageExpectation, destination: string): PackReport {
  note(`Packing workspace ${expectation.workspace}...`);
  const packOutput = execFileSync(
    "npm",
    [
      "pack",
      "--workspace",
      expectation.workspace,
      "--ignore-scripts",
      "--pack-destination",
      destination,
      "--json",
    ],
    { encoding: "utf8" },
  );
  const report = singlePackReport(packOutput, expectation.workspace);
  if (report === undefined) {
    fail(`expected exactly one packed tarball for ${expectation.workspace}`);
  }
  for (const file of report.files) {
    if (!expectation.allowedFilePattern.test(file.path)) {
      fail(`unexpected file in ${expectation.workspace}: ${file.path}`);
    }
    if (
      file.path.endsWith(".test.js") ||
      file.path.includes("__fixtures__") ||
      file.path.includes("test-support")
    ) {
      fail(`test artifact must not ship in ${expectation.workspace}: ${file.path}`);
    }
  }
  return report;
}

function checkManifest(
  expectation: PackageExpectation,
  manifest: PackageManifest,
  expectedVersion: string | undefined,
): void {
  const name = expectation.workspace;
  if (manifest.name !== name) {
    fail(`package name must be ${name}, got ${manifest.name}`);
  }
  if (expectedVersion !== undefined && manifest.version !== expectedVersion) {
    fail(`${name} version ${manifest.version} does not match expected ${expectedVersion}`);
  }
  if (expectation.bin === null) {
    if (manifest.bin !== undefined) {
      fail(`${name} must ship no bin`);
    }
  } else if (manifest.bin?.[expectation.bin.binName] !== expectation.bin.binPath) {
    fail(`${name} bin must map ${expectation.bin.binName} to ${expectation.bin.binPath}`);
  }
  for (const script of FORBIDDEN_SCRIPTS) {
    if (manifest.scripts?.[script] !== undefined) {
      fail(`${name} must not have a ${script} script`);
    }
  }
  for (const field of FORBIDDEN_DEPENDENCY_FIELDS) {
    const value = manifest[field];
    if (
      value !== undefined &&
      (typeof value !== "object" || value === null || Object.keys(value).length > 0)
    ) {
      fail(`${name} must not set ${field}`);
    }
  }
  if (manifest.engines?.node !== ">=18") {
    fail(`${name} engines.node must stay at >=18, got ${manifest.engines?.node ?? "unset"}`);
  }
}

// `driggsby` may depend on exactly two packages: our own @driggsby/deploy
// and @driggsby/sdk, at the same lockstep version, pinned exactly (no range
// operators) so the trio that shipped together is the trio that installs
// together. The libraries themselves stay dependency-free.
function checkDependencyContract(
  deploy: PackageManifest,
  sdk: PackageManifest,
  cli: PackageManifest,
): void {
  for (const library of [deploy, sdk]) {
    if (Object.keys(library.dependencies ?? {}).length > 0) {
      fail(`${library.name} must have zero runtime dependencies`);
    }
  }
  const cliDependencies = cli.dependencies ?? {};
  const dependencyNames = Object.keys(cliDependencies).sort();
  if (dependencyNames.join(",") !== "@driggsby/deploy,@driggsby/sdk") {
    fail(
      `driggsby dependencies must be exactly {"@driggsby/deploy", "@driggsby/sdk"}, got ${JSON.stringify(dependencyNames)}`,
    );
  }
  for (const library of [deploy, sdk]) {
    const pinned = cliDependencies[library.name];
    if (pinned !== library.version) {
      fail(
        `driggsby must pin ${library.name} to the exact lockstep version ${library.version}, got ${pinned ?? "unset"}`,
      );
    }
    if (cli.version !== library.version) {
      fail(`lockstep versions differ: driggsby ${cli.version}, ${library.name} ${library.version}`);
    }
  }
}

function readInstalledManifest(installedPackage: string): PackageManifest {
  return JSON.parse(readFileSync(join(installedPackage, "package.json"), "utf8")) as PackageManifest;
}

function checkShebang(installedPackage: string, binPath: string): void {
  const binSource = readFileSync(join(installedPackage, binPath), "utf8");
  if (!binSource.startsWith("#!/usr/bin/env node\n")) {
    fail(`${binPath} must start with a node shebang`);
  }
}

const expectedVersion = process.argv[2];
const workDirectory = mkdtempSync(join(tmpdir(), "driggsby-npm-surface-"));

try {
  const reports = [DEPLOY_EXPECTATION, SDK_EXPECTATION, CLI_EXPECTATION].map((expectation) =>
    packWorkspace(expectation, workDirectory),
  );

  // One install of all three tarballs: npm resolves driggsby's library
  // dependencies against the sibling tarballs' versions, with no registry
  // involved for any package.
  note("Installing all packed tarballs into a temp prefix...");
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
      ...reports.map((report) => join(workDirectory, report.filename)),
    ],
    { encoding: "utf8" },
  );

  const installedDeploy = join(installPrefix, "node_modules", "@driggsby", "deploy");
  const installedSdk = join(installPrefix, "node_modules", "@driggsby", "sdk");
  const installedCliPackage = join(installPrefix, "node_modules", "driggsby");
  const deployManifest = readInstalledManifest(installedDeploy);
  const sdkManifest = readInstalledManifest(installedSdk);
  const cliManifest = readInstalledManifest(installedCliPackage);

  checkManifest(DEPLOY_EXPECTATION, deployManifest, expectedVersion);
  checkManifest(SDK_EXPECTATION, sdkManifest, expectedVersion);
  checkManifest(CLI_EXPECTATION, cliManifest, expectedVersion);
  checkDependencyContract(deployManifest, sdkManifest, cliManifest);
  checkShebang(installedDeploy, "bin/driggsby-deploy.js");
  checkShebang(installedCliPackage, "bin/driggsby.js");

  // The SDK bundle the CLI serves during `driggsby dev` must resolve from
  // the installed CLI (a runtime require.resolve, not a static import, so
  // --version alone would not catch a broken edge), and must be the one
  // self-contained browser file.
  const sdkBundlePath = execFileSync(
    process.execPath,
    [
      "-e",
      "const { createRequire } = require('node:module');" +
        "console.log(createRequire(process.argv[1] + '/').resolve('@driggsby/sdk/driggsby-sdk.js'));",
      installedCliPackage,
    ],
    { encoding: "utf8" },
  ).trim();
  const sdkBundle = readFileSync(sdkBundlePath, "utf8");
  if (!sdkBundle.includes("driggsby-sdk/1") || /^\s*import\b/m.test(sdkBundle)) {
    fail("the installed SDK bundle must carry the protocol marker and import nothing at runtime");
  }

  // Behavior checks against the installed bytes. `driggsby --version` walks
  // the full static import graph, including the @driggsby/deploy resolution,
  // so a broken dependency edge fails here rather than on a user's machine.
  const installedCli = join(installedCliPackage, "bin", "driggsby.js");
  const version = execFileSync(process.execPath, [installedCli, "--version"], {
    encoding: "utf8",
  });
  if (version !== `driggsby ${cliManifest.version}\n`) {
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

  // The standalone deploy bin, with no token and no network: it must exit 1
  // with the message pointing at the full CLI's login flow.
  const deployBin = join(installedDeploy, "bin", "driggsby-deploy.js");
  const deployRun = spawnSync(process.execPath, [deployBin], {
    encoding: "utf8",
    cwd: workDirectory,
    env: { PATH: process.env.PATH ?? "" },
  });
  if (deployRun.status !== 1 || !deployRun.stderr.includes("DRIGGSBY_TOKEN")) {
    fail(
      `installed driggsby-deploy without a token must exit 1 naming DRIGGSBY_TOKEN; got exit ${deployRun.status ?? "null"}`,
    );
  }

  note(
    `npm publish surface OK: @driggsby/deploy@${deployManifest.version} + @driggsby/sdk@${sdkManifest.version} + driggsby@${cliManifest.version}`,
  );
} catch (error) {
  if (!(error instanceof SurfaceCheckFailure)) {
    throw error;
  }
  console.error(`error: ${error.message}`);
  process.exitCode = 1;
} finally {
  rmSync(workDirectory, { recursive: true, force: true });
}
