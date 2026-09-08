// driggsby versions: list the deployed app's kept versions, which one is
// live, and the numbers rollback accepts. rollback reuses the fetch and the
// row rendering here so both commands describe versions identically.
import {
  type DeployApi,
  DeployApiError,
  formatBytes,
  listVersions,
  readProjectConfig,
  type VersionList,
} from "@driggsby/deploy";

import { apiBaseUrl } from "../api/base-url.ts";
import { CliError } from "../cli-error.ts";
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

export interface VersionsCommandIo {
  out: (text: string) => void;
}

export interface VersionsCommandOptions {
  projectDirectory?: string;
}

function defaultVersionsIo(): VersionsCommandIo {
  return {
    out: (text) => {
      process.stdout.write(text);
    },
  };
}

export async function runVersions(
  options: VersionsCommandOptions,
  environment: CredentialEnvironment = defaultCredentialEnvironment(),
  io: VersionsCommandIo = defaultVersionsIo(),
): Promise<number> {
  const projectDirectory = options.projectDirectory ?? process.cwd();
  const baseUrl = apiBaseUrl(environment.env);
  try {
    const config = await readProjectConfig(projectDirectory);
    const session = await requireDeploySession(environment);
    const list = await fetchVersionList(
      { baseUrl: session.baseUrl, token: session.token },
      config.slug,
    );

    // The slug and URL are server-supplied strings, sanitized and
    // length-bounded like every other text this CLI did not author — and
    // the slug prints through quotedForTerminal, inside quotes it can't
    // break out of, so it reads as a name, never as the CLI's own sentence.
    const count = list.versions.length;
    io.out(
      `${wrapProse(`${quotedForTerminal(list.appSlug, MAX_SERVER_TEXT_CHARS)} — ${count} ${count === 1 ? "version" : "versions"}`)}\n\n`,
    );
    io.out(`${renderVersionRows(list)}\n`);
    if (list.liveVersionNumber !== null) {
      io.out(`\nYour app:\n\n  ${capForTerminal(list.url, MAX_SERVER_URL_CHARS)}\n`);
    } else {
      io.out("\nNothing is live yet, so your app's address shows nothing.\n");
    }
    io.out(
      "\nNext:\n" +
        '  Make any "ready" version live with npx driggsby@latest rollback --to <VERSION>\n',
    );
    return 0;
  } catch (error) {
    throw deployFailure(error, baseUrl, "npx driggsby@latest versions");
  }
}

// A 404 here means the app isn't on this account. For versions and
// rollback the fix is a deploy; a caller whose right next step differs
// (delete) passes its own notFound shape. The slug is quoted and capped
// either way — delete hands this an argv string, not only config values.
export async function fetchVersionList(
  api: DeployApi,
  slug: string,
  notFound: (slug: string) => CliError = firstDeployCreatesIt,
): Promise<VersionList> {
  try {
    return await listVersions(api, slug);
  } catch (error) {
    if (error instanceof DeployApiError && error.status === 404) {
      throw notFound(slug);
    }
    throw error;
  }
}

function firstDeployCreatesIt(slug: string): CliError {
  return new CliError(
    `${wrapProse(`There's no app named ${quotedForTerminal(slug, MAX_SERVER_TEXT_CHARS)} on your Driggsby account yet. Its first deploy creates it:`)}\n` +
      "  npx driggsby@latest deploy",
    1,
  );
}

export function renderVersionRows(list: VersionList): string {
  const rows = list.versions.map((version) => ({
    label: `v${version.number}`,
    status: version.live ? "live now" : version.status === "ready" ? "ready" : "incomplete",
    files: `${version.fileCount} ${version.fileCount === 1 ? "file" : "files"}`,
    size: formatBytes(version.totalBytes),
    date: formatCreatedAt(version.createdAt),
  }));
  if (rows.length === 0) {
    return "  (no versions yet)";
  }
  const labelWidth = widestLength(rows.map((row) => row.label));
  const statusWidth = widestLength(rows.map((row) => row.status));
  const filesWidth = widestLength(rows.map((row) => row.files));
  const sizeWidth = widestLength(rows.map((row) => row.size));
  return rows
    .map(
      (row) =>
        `  ${row.label.padEnd(labelWidth)}  ${row.status.padEnd(statusWidth)}  ` +
        `${row.files.padStart(filesWidth)}  ${row.size.padStart(sizeWidth)}  ${row.date}`,
    )
    .join("\n");
}

// reduce, not Math.max(...spread): the server controls this array's length,
// and a spread call throws once the argument list gets long enough.
function widestLength(values: string[]): number {
  return values.reduce((widest, value) => Math.max(widest, value.length), 0);
}

// "2026-08-21T17:04:00.000Z" -> "2026-08-21 17:04 UTC". The API always sends
// ISO-8601 UTC; anything unexpected is shown as-is (sanitized and capped)
// rather than guessed at. Real values keep the row inside 80 columns; this
// bound keeps a garbage timestamp from stretching it without limit — a real
// timestamp is at most 24 characters.
const MAX_CREATED_AT_CELL_CHARS = 30;

function formatCreatedAt(createdAt: string): string {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(createdAt);
  if (match === null) {
    return capForTerminal(createdAt, MAX_CREATED_AT_CELL_CHARS);
  }
  const [, date, time] = match;
  return `${date ?? ""} ${time ?? ""} UTC`;
}
