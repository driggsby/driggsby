// driggsby delete: permanently remove a deployed app — the app itself and
// every version Driggsby kept for it. There is no undo, so this command
// owns the "are you sure": interactively the person types the app's
// address name back; in a script or agent run, --yes is required.
import { access } from "node:fs/promises";
import { join } from "node:path";

import { deleteApp, readProjectConfig, slugProblem } from "@driggsby/deploy";

import { apiBaseUrl } from "../api/base-url.ts";
import { CliError } from "../cli-error.ts";
import {
  type CredentialEnvironment,
  defaultCredentialEnvironment,
} from "../credentials/store.ts";
import { capForTerminal, quotedForTerminal, wrapProse } from "../terminal-text.ts";
import {
  MAX_SERVER_TEXT_CHARS,
  MAX_SERVER_URL_CHARS,
  deployFailure,
  requireDeploySession,
} from "./api-session.ts";
import { fetchVersionList } from "./versions-command.ts";

const DELETE_RETRY_COMMAND = "npx driggsby@latest delete";

// The success line is `✓ Deleted   ` (12 columns) plus the quoted name;
// 12 + 2 quotes + 64 = 78 keeps it inside 80 whatever the server sends.
const DELETED_LINE_NAME_CHARS = 64;

// Once the name is known (and validated), the retry names it too, so a
// retry from the wrong folder can't quietly target a different app.
function retryCommandFor(slug: string | null): string {
  return slug === null ? DELETE_RETRY_COMMAND : `${DELETE_RETRY_COMMAND} ${slug}`;
}

export interface DeleteCommandIo {
  out: (text: string) => void;
  // Asks the user one question and resolves with their answer; only called
  // when `interactive` is true.
  ask: (question: string) => Promise<string>;
  interactive: boolean;
}

export interface DeleteCommandOptions {
  // The app's address name. Null means "the app this folder deploys",
  // read from driggsby.json in the project directory.
  slug: string | null;
  yes: boolean;
  projectDirectory?: string;
}

function defaultDeleteIo(): DeleteCommandIo {
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

export async function runDelete(
  options: DeleteCommandOptions,
  environment: CredentialEnvironment = defaultCredentialEnvironment(),
  io: DeleteCommandIo = defaultDeleteIo(),
): Promise<number> {
  const projectDirectory = options.projectDirectory ?? process.cwd();
  const baseUrl = apiBaseUrl(environment.env);
  let resolvedSlug: string | null = null;
  try {
    const slug =
      options.slug === null
        ? await slugFromProjectFolder(projectDirectory)
        : validatedArgvSlug(options.slug);
    resolvedSlug = slug;
    const session = await requireDeploySession(environment);
    const api = { baseUrl: session.baseUrl, token: session.token };

    // The look-before-you-leap read: it shows exactly what is about to
    // go, and an unknown name stops here — with delete's own not-found,
    // never the version list's "deploy it first" suggestion — before the
    // DELETE is ever sent.
    const list = await fetchVersionList(api, slug, appAlreadyGone);
    const versionCount = list.versions.length;
    const versionsLine =
      versionCount === 1 ? "1 deployed version" : `${versionCount} deployed versions`;
    // The slug passed the strict pattern above (argv) or came from the
    // validated project config, so it prints bare here.
    io.out(
      `${wrapProse(`Deleting ${slug} removes it forever: ${versionsLine}, its page in Driggsby, and its address:`)}\n` +
        `  ${capForTerminal(list.url, MAX_SERVER_URL_CHARS)}\n\n`,
    );

    if (!options.yes) {
      await confirmOrStop(slug, io);
    }

    const deleted = await deleteApp(api, slug);
    // The name is server text: quoted so it reads as a name, never as the
    // CLI's own sentence, and capped tighter than usual (64) so the line
    // stays inside 80 columns whatever the server sends. The preflight
    // above already named the address, so the slug isn't repeated here.
    io.out(`✓ Deleted   ${quotedForTerminal(deleted.appName, DELETED_LINE_NAME_CHARS)}\n\n`);
    io.out(
      `${wrapProse("The app and its versions are gone, and its address now shows nothing. Deploying the app's folder again would create a new app at a new address.")}\n` +
        "\nNext:\n" +
        "  Start a new app with npx driggsby@latest init\n",
    );
    return 0;
  } catch (error) {
    throw deployFailure(error, baseUrl, retryCommandFor(resolvedSlug));
  }
}

// A name typed on the command line is shape-gated before it goes anywhere:
// a typo gets the naming rules instead of a network round trip, nothing
// unvalidated is ever echoed, and the empty string can't slip through to
// match an empty confirmation answer.
function validatedArgvSlug(slug: string): string {
  const problem = slugProblem(slug);
  if (problem === null) return slug;
  const flatProblem = problem.replaceAll("\n", " ");
  throw new CliError(
    wrapProse(
      `${quotedForTerminal(slug, MAX_SERVER_TEXT_CHARS)} doesn't look like an app's address name: ${flatProblem}. Copy the name from the app's driggsby.json ("slug"), or from npx driggsby@latest versions run in its folder.`,
    ),
    2,
  );
}

// The app already isn't there — for a delete that is closer to done than
// to broken, and the one wrong suggestion would be "deploy it first".
function appAlreadyGone(slug: string): CliError {
  return new CliError(
    wrapProse(
      `There's no app named ${quotedForTerminal(slug, MAX_SERVER_TEXT_CHARS)} on your Driggsby account — maybe it was already deleted. Nothing was changed.`,
    ),
    1,
  );
}

// With no name given, the app is the one this folder deploys. Only a
// genuinely missing driggsby.json gets the "name it directly" guidance;
// a present-but-broken config surfaces its own precise error, the same
// one deploy and versions would show.
async function slugFromProjectFolder(projectDirectory: string): Promise<string> {
  try {
    await access(join(projectDirectory, "driggsby.json"));
  } catch {
    throw new CliError(
      `${wrapProse("This folder doesn't have a driggsby.json, so there's no app here to delete. Name the app directly — the \"slug\" in its driggsby.json:")}\n` +
        "  npx driggsby@latest delete <APP-ADDRESS-NAME>",
      1,
    );
  }
  const config = await readProjectConfig(projectDirectory);
  return config.slug;
}

// The person types the address name back. Anything else — including an
// empty answer — deletes nothing and says so. Scripts and agents have no
// one to ask, so they must say --yes explicitly.
async function confirmOrStop(slug: string, io: DeleteCommandIo): Promise<void> {
  if (!io.interactive) {
    // Already shape-validated, so echoing it into a command line is safe.
    throw new CliError(
      `${wrapProse("Deleting can't be undone, and this terminal can't ask you to confirm. Say it explicitly:")}\n` +
        `  npx driggsby@latest delete ${slug} --yes`,
      2,
    );
  }
  const answer = (await io.ask("Type the app's address name to confirm: ")).trim();
  if (answer !== slug) {
    throw new CliError("That didn't match, so nothing was deleted.", 1);
  }
}
