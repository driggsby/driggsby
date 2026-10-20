// driggsby import: send a bank or card statement CSV to Driggsby into the
// account the person names, follow it to the end,
// answer its rare question, and undo it; and driggsby accounts list. Built for agents with
// no Driggsby context: the file (or the ID Driggsby gives it) is the only
// handle, repeating any command is safe, `--wait` never outlasts a coding
// agent's command limit, and every output ends with the exact next command
// (import-render.ts holds that contract).
import { apiBaseUrl } from "../api/base-url.ts";
import { CliError } from "../cli-error.ts";
import { type CredentialEnvironment, defaultCredentialEnvironment } from "../credentials/store.ts";
import { deployFailure, type DeploySession, requireDeploySession, SIGN_IN_AGAIN_MESSAGE } from "../deploy/api-session.ts";
import { wrapProse } from "../terminal-text.ts";
import { GENERIC_TOOL_TROUBLE } from "../dev/dev-servers.ts";
import {
  accounts,
  answer,
  type Destination,
  DriggsbyBusy,
  findByFile,
  findByRef,
  IMPORTS_NOT_AVAILABLE_MESSAGE,
  type ImportOutcome,
  list,
  TROUBLE,
  undo,
  upload,
} from "./import-client.ts";
import {
  accountFlags,
  CLI,
  kindWord,
  type Rendered,
  renderAccounts,
  renderList,
  renderNotUndoable,
  renderQuestion,
  renderStarted,
  renderStatus,
  renderUndoPreview,
  undoneLine,
} from "./import-render.ts";
import { resolveTarget, shellWord, tooLargeToImport } from "./import-target.ts";
import { type ImportView, type NewAccount } from "./import-view.ts";

// Under Claude Code's 2-minute limit for one command, counted from the
// command's start (an upload's time included), so a wait is never cut off
// mid-poll; the output says to run the same command again. Every 3 seconds
// keeps an agent waiting on a few imports at once well inside Driggsby's
// per-minute limit on tool calls.
export const WAIT_MS = 90_000;
const POLL_MS = 3_000;
// What running the same command again wouldn't fix; anything else mid-wait
// ends the wait where it stands.
const SIGNED_OUT: ReadonlySet<string> = new Set([SIGN_IN_AGAIN_MESSAGE, IMPORTS_NOT_AVAILABLE_MESSAGE]);
// Refusals about naming the account, whose fix starts from the account list.
const ACCOUNT_REFUSALS: ReadonlySet<string> = new Set(["account_required", "account_invalid", "account_not_found"]);
const NOTHING_TO_UNDO: Rendered = { text: "Nothing to undo: no import of this file is in Driggsby right now.\n", exitCode: 0 };

export type ImportCommandOptions =
  | {
      action: "run";
      target: string;
      wait: boolean;
      account: string | null;
      create: NewAccount | null;
      dates: string | null;
      amounts: string | null;
    }
  | { action: "undo"; target: string; yes: boolean }
  | { action: "list" }
  | { action: "accounts" };

type RunOptions = Extract<ImportCommandOptions, { action: "run" }>;
type Answer = { dates: string } | { amounts: string };

export interface ImportCommandIo {
  out: (text: string) => void;
  now: () => Date;
  sleep: (ms: number) => Promise<void>;
  // A person at a terminal confirms an undo here instead of with --yes.
  ask: ((question: string) => Promise<string>) | null;
  timeZone?: string;
}

function defaultImportIo(): ImportCommandIo {
  const interactive = process.stdin.isTTY && process.stdout.isTTY;
  return {
    out: (text) => {
      process.stdout.write(text);
    },
    now: () => new Date(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    ask: interactive
      ? async (question) => {
          const { createInterface } = await import("node:readline/promises");
          const readline = createInterface({ input: process.stdin, output: process.stdout });
          try {
            return await readline.question(question);
          } finally {
            readline.close();
          }
        }
      : null,
  };
}

export async function runImport(
  options: ImportCommandOptions,
  environment: CredentialEnvironment = defaultCredentialEnvironment(),
  io: ImportCommandIo = defaultImportIo(),
): Promise<number> {
  const baseUrl = apiBaseUrl(environment.env);
  try {
    const session = await requireDeploySession(environment);
    const rendered =
      options.action === "list"
        ? renderList(await list(session), context(io))
        : options.action === "accounts"
          ? renderAccounts(await accounts(session))
          : options.action === "undo"
            ? await runUndo(session, options, io)
            : await runStart(session, options, io);
    io.out(rendered.text);
    return rendered.exitCode;
  } catch (error) {
    if (error instanceof DriggsbyBusy) {
      throw new CliError(`Driggsby is busy right now. Run the same command again in a minute:\n  ${retryCommand(options)}`, 1);
    }
    // An answer the CLI couldn't read ends, like every output, on the command
    // to run.
    if (error instanceof CliError && (error.message === TROUBLE || error.message === GENERIC_TOOL_TROUBLE)) {
      throw new CliError(`${error.message} Then run the same command again:\n  ${retryCommand(options)}`, 1);
    }
    throw deployFailure(error, baseUrl, retryCommand(options));
  }
}

async function runStart(session: DeploySession, options: RunOptions, io: ImportCommandIo): Promise<Rendered> {
  const startedAt = io.now().getTime();
  const target = await resolveTarget(options.target);
  const given = answerGiven(options);
  const typedFile = target.kind === "file" ? shellWord(target.typed) : null;
  let outcome: ImportOutcome;
  let created = false;
  let uploaded = false;
  if (target.kind === "ref") {
    if (options.account !== null || options.create !== null) {
      throw new CliError(
        `${wrapProse("--account and --create-account name the account a file goes in; an import's ID already has one. To see where it stands:")}\n` +
          `  ${CLI} import ${target.ref}`,
        2,
      );
    }
    outcome = await findByRef(session, target.ref);
  } else {
    outcome = await findByFile(session, target.sha256, named(options));
    if (outcome.kind === "refused" && outcome.code === "not_found") {
      const file = typedFile ?? "<FILE>";
      if (given !== null) {
        throw new CliError(
          `${wrapProse("--dates and --amounts answer a question an import asked, and this file hasn't been imported yet. Start it first:")}\n` +
            `  ${CLI} import ${file} --account <ID>`,
          2,
        );
      }
      outcome = await upload(session, target.file, destination(options, file));
      uploaded = true;
      created = outcome.kind === "import" && outcome.created;
    }
  }
  if (outcome.kind === "import" && !created && given !== null) {
    outcome = await answer(session, outcome.view.ref, given);
  }
  if (outcome.kind === "refused") {
    return renderRefusal(outcome, { typedFile, retry: retryCommand(options), uploaded, create: options.create });
  }
  const startedIn = outcome.view.state;
  const view = options.wait ? await waitFor(session, outcome.view, io, startedAt) : outcome.view;
  if (created && !options.wait) {
    return renderStarted(view);
  }
  return renderStatus(
    view,
    {
      compact: options.wait && startedIn === "categorizing",
      repeated: target.kind === "file" && !created && given === null,
      unchanged: outcome.note !== null,
      rerun: { file: typedFile, account: options.account, create: options.create },
    },
    context(io),
  );
}

async function runUndo(session: DeploySession, options: Extract<ImportCommandOptions, { action: "undo" }>, io: ImportCommandIo): Promise<Rendered> {
  let startedAt = io.now().getTime();
  // A file over the import limit was never imported.
  if (await tooLargeToImport(options.target)) {
    return NOTHING_TO_UNDO;
  }
  const target = await resolveTarget(options.target);
  const found = target.kind === "ref" ? await findByRef(session, target.ref) : await findByFile(session, target.sha256, null);
  if (found.kind === "refused") {
    if (found.code === "not_found" && target.kind === "file") {
      // Never imported, or already undone: either way nothing of it is left.
      return NOTHING_TO_UNDO;
    }
    return renderRefusal(found, { typedFile: null, retry: retryCommand(options), uploaded: false });
  }
  const previewed = await undo(session, found.view.ref, false);
  if (previewed.kind === "refused") {
    return renderRefusal(previewed, { typedFile: null, retry: retryCommand(options), uploaded: false });
  }
  const preview = previewed.undo;
  if (preview === null) {
    throw new CliError("Driggsby couldn't say what undo would remove just now. Please try again in a minute.", 1);
  }
  if (!preview.undoable) {
    return renderNotUndoable(previewed.view, preview);
  }
  if (!options.yes) {
    const shown = renderUndoPreview(previewed.view, preview);
    if (io.ask === null) {
      return shown;
    }
    // A person at a terminal answers here instead of re-running with --yes.
    io.out(`${shown.text}\n`);
    const reply = await io.ask(`${preview.cancels ? "Cancel" : "Undo"} it now? [y/N] `);
    if (!/^y(es)?$/i.test(reply.trim())) {
      return { text: "Not undone: nothing changed.\n", exitCode: 0 };
    }
    // The person's time to answer isn't the wait's.
    startedAt = io.now().getTime();
  }
  const result = await undo(session, previewed.view.ref, true);
  if (result.kind === "refused") {
    return renderRefusal(result, { typedFile: null, retry: retryCommand(options), uploaded: false });
  }
  const view = result.view.state === "undoing" ? await waitFor(session, result.view, io, startedAt) : result.view;
  if (view.state === "undone") {
    return { text: `${undoneLine(view, preview.cancels ? null : preview.transactions)}\n`, exitCode: 0 };
  }
  // Back where it started: Driggsby couldn't finish the undo, and removed
  // nothing.
  if (view.state === "done" || view.state === "waiting") {
    return refused(`Not undone: Driggsby couldn't finish undoing it just now, and nothing was removed.\n\nNext:\n  ${retryCommand(options)}\n`);
  }
  return renderStatus(view, { compact: false, repeated: false, unchanged: false, rerun: { file: null, account: null, create: null } }, context(io));
}

// Polls until something an agent acts on: the transactions are in, a
// question, a stop, the end of an undo, or (for a wait that began while
// categories filled in) the end of categorizing. Never past WAIT_MS from
// startedAt.
export async function waitFor(session: DeploySession, view: ImportView, io: ImportCommandIo, startedAt: number): Promise<ImportView> {
  const startedIn = view.state;
  const deadline = startedAt + WAIT_MS;
  let current = view;
  while (!settled(current, startedIn) && io.now().getTime() + POLL_MS <= deadline) {
    await io.sleep(POLL_MS);
    // A busy moment, a server error or a lost connection mid-wait ends the
    // wait where it stands; its output names the same command to run again.
    const outcome = await findByRef(session, current.ref).catch((error: unknown) => {
      if (error instanceof CliError && SIGNED_OUT.has(error.message)) throw error;
      return null;
    });
    if (outcome?.kind !== "import") {
      break;
    }
    current = outcome.view;
  }
  return current;
}

function settled(view: ImportView, startedIn: ImportView["state"]): boolean {
  switch (view.state) {
    case "waiting":
    case "done":
    case "stopped":
    case "undone":
      return true;
    case "categorizing":
      return startedIn !== "categorizing";
    default:
      return false;
  }
}

function renderRefusal(
  outcome: Extract<ImportOutcome, { kind: "refused" }>,
  where: { typedFile: string | null; retry: string; uploaded: boolean; create?: NewAccount | null },
): Rendered {
  const ref = outcome.view?.ref ?? null;
  const message = outcome.message;
  if (outcome.code === "not_found") {
    return refused(`Refused: there's no import with that ID on your account.\n\nNext, to see your imports:\n  ${CLI} import list\n`);
  }
  // A new account's name another account has: import into that one by its
  // ID (its kind said, since it may not be the kind asked for), or name the
  // new one differently.
  if (outcome.code === "account_name_taken") {
    if (outcome.account === null) {
      return refused(`Refused: ${message} Nothing was imported.\n\nNext, to see where that import stands:\n  ${CLI} import list\n`);
    }
    const file = where.typedFile ?? "<FILE>";
    const kind = kindWord(outcome.account.type);
    return refused(
      `Refused: ${message} Nothing was imported.\n\n` +
        `Next, to import into ${kind === "" ? "it" : `that ${kind} account`}:\n  ${CLI} import ${file} --account ${outcome.account.ref}\n` +
        `Or into a new account by another name:\n  ${CLI} import ${file} --create-account --account-type ${where.create?.type ?? "card"} --account-name "<NAME>"\n`,
    );
  }
  if (ACCOUNT_REFUSALS.has(outcome.code)) {
    return refused(`Refused: ${message} Nothing was imported.\n\nNext, to see your accounts and their IDs:\n  ${CLI} accounts list\n`);
  }
  if (outcome.code === "already_imported" && ref !== null) {
    return refused(`Refused: ${message}\n\nNext, to undo it first:\n  ${CLI} import undo ${ref}\n`);
  }
  // Another send of this file was in flight; the same command again finds
  // where it stands, or starts it afresh.
  if (outcome.code === "already_imported") {
    return refused(`Refused: ${message} Nothing was imported.\n\nNext, run the same command again:\n  ${where.retry}\n`);
  }
  if (outcome.code === "wrong_answer" && outcome.view !== null) {
    return refused(`Refused: ${message}\n\n${renderQuestion(outcome.view)}`);
  }
  if (outcome.code === "busy" || outcome.code === "account_still_importing") {
    return refused(`Refused: ${message}\n\nNext, once that's done:\n  ${where.retry}\n`);
  }
  // An undo another change beat: where the import stands now says what's next.
  if (outcome.code === "not_undoable" && ref !== null) {
    return refused(`Refused: ${message}\n\nNext, to see where it stands:\n  ${CLI} import ${ref}\n`);
  }
  return refused(`Refused: ${message}${where.uploaded ? " Nothing was imported." : ""}\n`);
}

function refused(text: string): Rendered {
  return { text, exitCode: 1 };
}

function answerGiven(options: RunOptions): Answer | null {
  if (options.dates !== null) return { dates: options.dates };
  if (options.amounts !== null) return { amounts: options.amounts };
  return null;
}

// The account the command names, if it names one.
function named(options: RunOptions): Destination | null {
  if (options.account !== null) return { account: options.account };
  if (options.create !== null) return { create: options.create };
  return null;
}

// The account a new file goes in, or the commands that name one: an import
// always names its account, and Driggsby never picks one.
function destination(options: RunOptions, file: string): Destination {
  const chosen = named(options);
  if (chosen !== null) return chosen;
  throw new CliError(
    `error: name the account this statement goes in, one you have or a new one:\n` +
      `  ${CLI} import ${file} --account <ID>\n` +
      `  ${CLI} import ${file} --create-account --account-type card --account-name "<NAME>"\n\n` +
      `Your accounts and their IDs:\n  ${CLI} accounts list`,
    2,
  );
}

function context(io: ImportCommandIo): { now: Date; timeZone?: string } {
  return io.timeZone === undefined ? { now: io.now() } : { now: io.now(), timeZone: io.timeZone };
}

// The command as given, so a retry lands exactly where the first try aimed:
// an account named on the first try is named again.
function retryCommand(options: ImportCommandOptions): string {
  if (options.action === "list") return `${CLI} import list`;
  if (options.action === "accounts") return `${CLI} accounts list`;
  if (options.action === "undo") return `${CLI} import undo ${shellWord(options.target)}${options.yes ? " --yes" : ""}`;
  const flags = [
    accountFlags(options.account, options.create),
    options.dates === null ? "" : ` --dates ${options.dates}`,
    options.amounts === null ? "" : ` --amounts ${options.amounts}`,
    options.wait ? " --wait" : "",
  ].join("");
  return `${CLI} import ${shellWord(options.target)}${flags}`;
}
