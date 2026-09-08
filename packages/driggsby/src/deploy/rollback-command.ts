// driggsby rollback: switch which kept version of the app is live. Nothing
// re-uploads — the switch is a pointer change on Driggsby's side. With --to N
// it acts directly; without it, it shows the choices and asks (or, when not
// attached to a person, explains how to re-run with --to).
import { setLiveVersion, readProjectConfig, type VersionList } from "@driggsby/deploy";

import { apiBaseUrl } from "../api/base-url.ts";
import { CliError } from "../cli-error.ts";
import {
  type CredentialEnvironment,
  defaultCredentialEnvironment,
} from "../credentials/store.ts";
import { wrapProse } from "../terminal-text.ts";
import {
  deployFailure,
  requireDeploySession,
} from "./api-session.ts";
import { hasLiveAddress, liveAddressLines } from "./live-addresses.ts";
import { fetchVersionList, renderVersionRows } from "./versions-command.ts";

const ROLLBACK_RETRY_COMMAND = "npx driggsby@latest rollback";

export interface RollbackCommandIo {
  out: (text: string) => void;
  // Asks the user one question and resolves with their answer; only called
  // when `interactive` is true.
  ask: (question: string) => Promise<string>;
  interactive: boolean;
}

export interface RollbackCommandOptions {
  toVersion: number | null;
  projectDirectory?: string;
}

function defaultRollbackIo(): RollbackCommandIo {
  return {
    out: (text) => {
      process.stdout.write(text);
    },
    ask: async (question) => {
      const { createInterface } = await import("node:readline/promises");
      const readline = createInterface({ input: process.stdin, output: process.stdout });
      try {
        return await readline.question(question);
      } finally {
        readline.close();
      }
    },
    interactive: process.stdin.isTTY && process.stdout.isTTY,
  };
}

export async function runRollback(
  options: RollbackCommandOptions,
  environment: CredentialEnvironment = defaultCredentialEnvironment(),
  io: RollbackCommandIo = defaultRollbackIo(),
): Promise<number> {
  const projectDirectory = options.projectDirectory ?? process.cwd();
  const baseUrl = apiBaseUrl(environment.env);
  try {
    const config = await readProjectConfig(projectDirectory);
    const session = await requireDeploySession(environment);
    const api = { baseUrl: session.baseUrl, token: session.token };
    const list = await fetchVersionList(api, config.slug);

    const readyNumbers = list.versions
      .filter((version) => version.status === "ready")
      .map((version) => version.number);
    if (readyNumbers.length === 0) {
      throw new CliError(
        `${wrapProse(`${config.slug} has no completed versions to switch between yet. Deploy one first:`)}\n` +
          "  npx driggsby@latest deploy",
        1,
      );
    }

    const target = options.toVersion ?? (await chooseVersion(list, readyNumbers, io));
    if (target === list.liveVersionNumber) {
      io.out(
        `v${target} is already live — nothing changed.\n\n` +
          "Next:\n  See every version with npx driggsby@latest versions\n",
      );
      return 0;
    }
    if (!readyNumbers.includes(target)) {
      throw new CliError(
        `${wrapProse(`v${target} isn't one of ${config.slug}'s ready versions. Ready: ${readyNumbers.map((number) => `v${number}`).join(", ")}.`)}\n\n` +
          "See the full list with:\n  npx driggsby@latest versions",
        1,
      );
    }

    const previousLive = list.liveVersionNumber;
    const result = await setLiveVersion(api, config.slug, target);
    const was = previousLive === null ? "" : ` (was v${previousLive})`;
    // "at:" only when an address that line promises actually follows.
    const atSuffix = hasLiveAddress(result) ? ", at:" : "";
    io.out(`✓ Live      v${result.versionNumber} is what visitors see now${was}${atSuffix}\n`);
    io.out(liveAddressLines(result));
    io.out(
      `\n${wrapProse(`Nothing re-uploaded — Driggsby already had v${result.versionNumber} in full.`)}\n` +
        "\nNext:\n  See every version with npx driggsby@latest versions\n",
    );
    return 0;
  } catch (error) {
    throw deployFailure(error, baseUrl, ROLLBACK_RETRY_COMMAND);
  }
}

// Without --to: show the same rows `versions` prints, then ask (a person) or
// explain the exact re-run (an agent or script).
async function chooseVersion(
  list: VersionList,
  readyNumbers: number[],
  io: RollbackCommandIo,
): Promise<number> {
  // Only "ready" versions can go live, so only those are offered here — an
  // "incomplete" row under this heading would list a choice that gets
  // refused.
  const rows = renderVersionRows({
    ...list,
    versions: list.versions.filter((version) => version.status === "ready"),
  });
  if (!io.interactive) {
    throw new CliError(
      `These versions can go live:\n\n${rows}\n\n` +
        "This terminal can't prompt for a choice, so name one directly:\n" +
        "  npx driggsby@latest rollback --to <VERSION>",
      2,
    );
  }
  io.out(`${rows}\n\n`);
  const answer = (await io.ask("Make which version live? (a number like 2) ")).trim();
  const normalized = /^[vV]/.test(answer) ? answer.slice(1) : answer;
  const parsed = Number.parseInt(normalized, 10);
  // Same guard as --to: a digit string past Number.MAX_SAFE_INTEGER must be
  // refused here too, not rendered back as "vInfinity isn't one of ...".
  if (!/^[0-9]+$/.test(normalized) || !Number.isSafeInteger(parsed)) {
    throw new CliError(
      `${wrapProse(`That wasn't a version number. Choose one of: ${readyNumbers.map((number) => `v${number}`).join(", ")}, or run:`)}\n` +
        "  npx driggsby@latest rollback --to <VERSION>",
      1,
    );
  }
  return parsed;
}
