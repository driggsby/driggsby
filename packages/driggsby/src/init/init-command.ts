// driggsby init: scaffold a new Driggsby app in a new folder. The result is
// a no-build static app (index.html + app.js + styles.css) that renders
// sample data on its own and live data inside Driggsby, plus the
// driggsby.json that names it. With a slug argument it acts directly;
// without one, it asks (a person) or explains the exact re-run (an agent or
// script).
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { slugProblem } from "@driggsby/deploy";

import { CliError } from "../cli-error.ts";
import { quotedForTerminal, wrapProse } from "../terminal-text.ts";
import { APP_JS, STYLES_CSS, driggsbyJsonText, indexHtml } from "./templates.ts";

// Argv and prompt answers echo back inside quotes with this cap; a slug can
// never be longer than 63 characters, so the cap only trims hostile input.
const MAX_SLUG_ECHO_CHARS = 80;

const INIT_RETRY_LINES =
  "Pick another name and re-run:\n  npx driggsby@latest init <NAME>";

export interface InitCommandIo {
  out: (text: string) => void;
  // Asks the user one question and resolves with their answer; only called
  // when `interactive` is true.
  ask: (question: string) => Promise<string>;
  interactive: boolean;
}

export interface InitCommandOptions {
  slug: string | null;
  parentDirectory?: string;
}

function defaultInitIo(): InitCommandIo {
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

export async function runInit(
  options: InitCommandOptions,
  io: InitCommandIo = defaultInitIo(),
): Promise<number> {
  const parentDirectory = options.parentDirectory ?? process.cwd();
  const slug = options.slug ?? (await askForSlug(io));

  const problem = slugProblem(slug);
  if (problem !== null) {
    // slugProblem's wording spans lines; re-flow it as one paragraph. A bad
    // argv slug is a usage error (exit 2); a bad prompt answer is the same
    // conversational exit 1 the other interactive commands use.
    const flatProblem = problem.replaceAll("\n", " ");
    throw new CliError(
      `${wrapProse(`${quotedForTerminal(slug, MAX_SLUG_ECHO_CHARS)} won't work as an app name: ${flatProblem}.`)}\n\n${INIT_RETRY_LINES}`,
      options.slug === null ? 1 : 2,
    );
  }

  // The slug passed the strict pattern above, so from here it is safe to
  // print bare and to interpolate into the scaffolded index.html.
  const appDirectory = join(parentDirectory, slug);
  await ensureNewOrEmptyDirectory(appDirectory, slug);
  await writeScaffold(appDirectory, slug);

  io.out(
    `✓ Created   ${slug}/\n\n` +
      "  index.html     the page\n" +
      "  app.js         fetches and renders your data — start editing here\n" +
      "  styles.css     the look\n" +
      "  driggsby.json  the app's name and which folder deploys\n\n" +
      `${wrapProse("The app shows sample data on its own; dev and deploy both give it your real accounts.")}\n\n` +
      "Next:\n" +
      `  cd ${slug}\n` +
      "  npx driggsby@latest dev      preview with your real data\n" +
      "  npx driggsby@latest deploy   put it live on driggsby.dev\n",
  );
  return 0;
}

async function askForSlug(io: InitCommandIo): Promise<string> {
  if (!io.interactive) {
    throw new CliError(
      "This terminal can't prompt for a name, so pass one directly:\n" +
        "  npx driggsby@latest init <NAME>\n\n" +
        wrapProse(
          "Any readable name works (3-63 lowercase letters, digits, and dashes) — Driggsby adds a unique ending at first deploy (<NAME>-x7k2qf.driggsby.dev), so names never collide.",
        ),
      2,
    );
  }
  io.out(
    "The name starts your app's address — a unique ending is added at first\n" +
      "deploy: <NAME>-x7k2qf.driggsby.dev\n\n",
  );
  const answer = await io.ask("Name your app (like money-dash): ");
  return answer.trim();
}

// The scaffold only ever writes into a folder it created or one that exists
// empty — never into files someone already has.
async function ensureNewOrEmptyDirectory(appDirectory: string, slug: string): Promise<void> {
  try {
    await mkdir(appDirectory);
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      throw new CliError(
        wrapProse(`We couldn't create a ${slug} folder here. Check that this directory is writable and try again.`),
        1,
      );
    }
  }
  let entries: string[];
  try {
    entries = await readdir(appDirectory);
  } catch {
    // The existing path isn't a readable directory (it's a file, or
    // unreadable) — either way it isn't a safe scaffold target.
    throw new CliError(existsMessage(slug), 1);
  }
  if (entries.length > 0) {
    throw new CliError(existsMessage(slug), 1);
  }
}

function existsMessage(slug: string): string {
  return `${wrapProse(`Something named ${slug} already exists here and isn't an empty folder. Pick another name, or move it first.`)}\n\n${INIT_RETRY_LINES}`;
}

async function writeScaffold(appDirectory: string, slug: string): Promise<void> {
  // "wx" refuses to overwrite: even a file that appears between the
  // emptiness check and this write stays untouched.
  const writes: [string, string][] = [
    ["index.html", indexHtml(slug)],
    ["app.js", APP_JS],
    ["styles.css", STYLES_CSS],
    ["driggsby.json", driggsbyJsonText(slug)],
  ];
  for (const [name, content] of writes) {
    await writeFile(join(appDirectory, name), content, { flag: "wx" });
  }
}
