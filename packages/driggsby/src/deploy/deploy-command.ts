// driggsby deploy: read driggsby.json, hash the serve folder, upload what
// Driggsby doesn't have, and make the new version live (or hold it as a
// ready-but-not-live version with --preview).
import {
  collectDeployFiles,
  type DeployOutcome,
  deployProjectFiles,
  formatBytes,
  readProjectConfig,
} from "@driggsby/deploy";

import { apiBaseUrl } from "../api/base-url.ts";
import {
  type CredentialEnvironment,
  defaultCredentialEnvironment,
} from "../credentials/store.ts";
import { capForTerminal, quotedForTerminal, wrapProse } from "../terminal-text.ts";
import {
  deployFailure,
  MAX_SERVER_TEXT_CHARS,
  MAX_SERVER_URL_CHARS,
  requireDeploySession,
} from "./api-session.ts";

const DEPLOY_RETRY_COMMAND = "npx driggsby@latest deploy";

export interface DeployCommandIo {
  out: (text: string) => void;
  now: () => number;
}

export interface DeployCommandOptions {
  preview: boolean;
  projectDirectory?: string;
}

function defaultDeployIo(): DeployCommandIo {
  return {
    out: (text) => {
      process.stdout.write(text);
    },
    now: () => Date.now(),
  };
}

export async function runDeploy(
  options: DeployCommandOptions,
  environment: CredentialEnvironment = defaultCredentialEnvironment(),
  io: DeployCommandIo = defaultDeployIo(),
): Promise<number> {
  const projectDirectory = options.projectDirectory ?? process.cwd();
  // Resolved before the try so an invalid DRIGGSBY_BASE_URL reports its own
  // message instead of being re-wrapped as a deploy failure.
  const baseUrl = apiBaseUrl(environment.env);
  try {
    const config = await readProjectConfig(projectDirectory);
    const session = await requireDeploySession(environment);
    // The serve value is arbitrary text from driggsby.json (a cloned or
    // agent-generated file), so it prints through quotedForTerminal —
    // sanitized, length-bounded, and inside quotes the value can't break out
    // of, so it reads as a name, never as the CLI's own sentence. The slug
    // needs no quotes: readProjectConfig already validated it against the
    // strict slug rules. The whole line is wrapped because a maximum-length
    // slug pushes it past 80 columns.
    io.out(
      `${wrapProse(`Deploying ${config.slug} from ${quotedForTerminal(config.serve, MAX_SERVER_TEXT_CHARS)}${options.preview ? " (preview)" : ""}`)}\n\n`,
    );

    const collected = await collectDeployFiles(config.serveDirectory);
    io.out(`${hashedLine(collected.files.length)}\n`);

    const startedAt = io.now();
    const { outcome, createdApp } = await deployProjectFiles(
      { baseUrl: session.baseUrl, token: session.token },
      projectDirectory,
      config.slug,
      collected,
      {
        live: !options.preview,
        // The assigned slug is server text, so it prints quoted and
        // length-bounded like every other string this CLI did not author.
        // A validated slug tops out at 63 characters, so the line never
        // passes 80 columns; the closing note explains where it is saved.
        onAppCreated: (created) => {
          io.out(`✓ Created   ${quotedForTerminal(created.appSlug, MAX_SERVER_TEXT_CHARS)}\n`);
        },
      },
    );
    const seconds = (io.now() - startedAt) / 1_000;
    io.out(`${changedNote(outcome)}\n`);
    io.out(`${uploadedLine(outcome, seconds)}\n`);
    io.out(`${resultLine(outcome)}\n`);
    if (outcome.url !== null) {
      io.out(`\n  ${capForTerminal(outcome.url, MAX_SERVER_URL_CHARS)}\n`);
    }
    if (collected.skippedNodeModules.length > 0) {
      io.out(
        `\n${wrapProse("Note: node_modules doesn't deploy — Driggsby serves your app as static files, so it isn't needed.")}\n`,
      );
    }
    if (collected.skippedSymlinks.length > 0) {
      io.out(`\n${symlinkNote(collected.skippedSymlinks)}\n`);
    }
    if (createdApp !== null) {
      io.out(
        `\n${wrapProse(`This deploy created your app. Its address is assigned by Driggsby — the name you picked plus a unique ending — and it's saved in driggsby.json, so every later deploy targets it. If this project lives in git, commit the updated driggsby.json: it's the only record of your app's address, and a fresh checkout without it would create a second app.`)}\n`,
      );
    }
    io.out(`\n${nextSection(outcome)}`);
    return 0;
  } catch (error) {
    throw deployFailure(error, baseUrl, DEPLOY_RETRY_COMMAND);
  }
}

function hashedLine(fileCount: number): string {
  return `✓ Hashed    ${fileCount} ${fileCount === 1 ? "file" : "files"}`;
}

// What the manifest exchange revealed: how much of the app Driggsby already
// had. Printed as its own line right after hashing.
function changedNote(outcome: DeployOutcome): string {
  const changed = outcome.fileCount - outcome.unchangedFileCount;
  if (outcome.unchangedFileCount === 0) {
    return "✓ Compared  all new to Driggsby";
  }
  if (changed === 0) {
    return "✓ Compared  no file changed since the last deploy";
  }
  return `✓ Compared  ${changed} changed · ${outcome.unchangedFileCount} already on Driggsby`;
}

function uploadedLine(outcome: DeployOutcome, seconds: number): string {
  if (outcome.uploadedBlobCount === 0) {
    return "✓ Uploaded  nothing — Driggsby already had every file";
  }
  return `✓ Uploaded  ${formatBytes(outcome.uploadedBytes)} in ${formatSeconds(seconds)}`;
}

function resultLine(outcome: DeployOutcome): string {
  if (outcome.live) {
    // "at:" only when the URL that line promises actually follows.
    return outcome.url === null
      ? `✓ Live      v${outcome.versionNumber}`
      : `✓ Live      v${outcome.versionNumber}, at:`;
  }
  return `✓ Ready     v${outcome.versionNumber} is uploaded but not live — what visitors see is unchanged`;
}

function symlinkNote(skipped: string[]): string {
  // Symlink names come straight off the filesystem and skip the manifest's
  // character validation, so each one prints through quotedForTerminal —
  // sanitized, length-bounded, and inside quotes the name can't break out
  // of, so it reads as a name, not as part of the CLI's own sentence.
  const shown = skipped
    .slice(0, 3)
    .map((name) => quotedForTerminal(name, 40))
    .join(", ");
  const more = skipped.length > 3 ? ` and ${skipped.length - 3} more` : "";
  return wrapProse(`Note: symlinks don't deploy — skipped ${shown}${more}.`);
}

function nextSection(outcome: DeployOutcome): string {
  if (!outcome.live) {
    return (
      "Next:\n" +
      `  Make v${outcome.versionNumber} live with npx driggsby@latest rollback --to ${outcome.versionNumber}\n`
    );
  }
  return (
    "Next:\n" +
    "  Deploy again any time — only changed files upload. Switch back to an\n" +
    "  earlier version with npx driggsby@latest rollback.\n"
  );
}

function formatSeconds(seconds: number): string {
  if (seconds < 0.05) {
    return "under a second";
  }
  return seconds >= 10 ? `${Math.round(seconds)}s` : `${seconds.toFixed(1)}s`;
}
