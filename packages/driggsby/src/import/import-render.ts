// What the import command prints. Every output follows one contract, so an
// agent with no Driggsby context never has to guess: the first line says
// where things stand ("Started:", "Waiting for an answer:", "Done:", ...)
// and is never wrapped, and the last lines give the exact command to run
// next, complete, with one command per answer when the person must choose.
// Names Driggsby sends (a file, an account) print quoted and capped, so they
// read as names and never as the CLI's own sentence.
import { formatBytes } from "@driggsby/deploy";

import { capForTerminal, quotedForTerminal, wrapProse } from "../terminal-text.ts";
import { type AccountRow } from "./import-client.ts";
import { type ImportChoice, type ImportView, type NewAccount, type UndoPreview } from "./import-view.ts";

export const CLI = "npx driggsby@latest";
const NAME_CHARS = 120;
const MESSAGE_CHARS = 1_000;
export const ASK = "If you're working for someone, ask them; don't guess. Nothing lands until it's answered.";
// A stop whose fix is another account, not the same command again.
const ACCOUNT_STOPS: ReadonlySet<string> = new Set(["account_not_found", "account_mismatch"]);
const TYPE_WORDS: Record<string, string> = { credit: "card", depository: "bank" };
const EXPLAIN: Record<string, string> = {
  date_order: "Every date in it reads either way, like 03/04/2026.",
  amount_direction: "It doesn't say which way its amounts go.",
};
const NOTHING_NEW: Record<string, string> = {
  all_duplicates: "all of its transactions were already in Driggsby",
  all_covered_by_link: "the bank link already brought in all of its transactions",
  all_pending: "all of its transactions are still pending; import it again once they post",
};

export interface RenderContext {
  now: Date;
  // For tests; the person's own time zone otherwise.
  timeZone?: string;
}

export interface Rendered {
  text: string;
  exitCode: 0 | 1;
}

const name = (value: string): string => quotedForTerminal(value, NAME_CHARS);
const said = (value: string): string => capForTerminal(value, MESSAGE_CHARS).trim();
const next = (...commands: string[]): string => `Next:\n${commands.map((command) => `  ${command}`).join("\n")}\n`;
const waitCommand = (ref: string): string => `${CLI} import ${ref} --wait`;
const indented = (text: string): string =>
  wrapProse(text, 74)
    .split("\n")
    .map((line) => `  ${line}`)
    .join("\n");

export function renderStarted(view: ImportView): Rendered {
  const size = view.lines === null ? "" : `${plural(view.lines, "line")}${view.bytes === null ? "" : `, ${formatBytes(view.bytes)}`}`;
  return ok(
    `Started: importing ${name(view.file)} as ${view.ref}.\n\n` +
      (size === "" ? "" : `✓ Uploaded    ${size}\n\n`) +
      `${wrapProse("Driggsby is reading it now, which usually takes under a minute. Nothing lands in your accounts until it finishes.")}\n\n` +
      next(waitCommand(view.ref)),
  );
}

export interface StatusOptions {
  // A --wait that began while categories were already filling in.
  compact: boolean;
  // The same file sent again, finding its import already there.
  repeated: boolean;
  // An answer sent to an import that wasn't waiting for one.
  unchanged: boolean;
  // What a stopped import's re-run names: the file as typed (unknown when
  // the import was named by its ID) and the account the first try named.
  rerun: { file: string | null; account: string | null; create: NewAccount | null };
}

export function renderStatus(view: ImportView, options: StatusOptions, context: RenderContext): Rendered {
  const body = statusBody(view, options, context);
  if (!options.unchanged) {
    return body;
  }
  // The first line still says where things stand; the note comes after it.
  const [first = "", ...rest] = body.text.split("\n\n");
  return { text: [first, "Nothing changed: this import isn't waiting for an answer.", ...rest].join("\n\n"), exitCode: body.exitCode };
}

function statusBody(view: ImportView, options: StatusOptions, context: RenderContext): Rendered {
  switch (view.state) {
    case "reading":
    case "importing": {
      const doing = view.state === "reading" ? "Still reading" : "Still importing";
      return ok(
        `${doing}: ${name(view.file)}, started ${ago(view.startedAt, context.now)}.\n\n` +
          `${wrapProse("Some files take a few minutes. Nothing lands until it finishes.")}\n\n${next(waitCommand(view.ref))}`,
      );
    }
    case "waiting":
      return ok(renderQuestion(view));
    case "categorizing":
      return ok(options.compact ? categorizingLine(view) : landed(view, "Imported"));
    case "done":
      return ok(done(view, options, context));
    case "stopped":
      return { text: `Stopped: ${name(view.file)} wasn't imported. Nothing landed.\n\n${wrapProse(said(view.stopped?.message ?? ""))}\n\n${rerun(view, options)}`, exitCode: 1 };
    case "undoing":
      return ok(`${undoingLine(view)}\n\n${next(waitCommand(view.ref))}`);
    case "undone":
      return ok(`${undoneLine(view, null)}\n`);
  }
}

// A cancel landed nothing, so it removes nothing either.
function undoingLine(view: ImportView): string {
  return view.counts === null
    ? `Undoing: cancelling ${name(view.file)}; nothing of it had landed.`
    : `Undoing: removing the transactions ${name(view.file)} added.`;
}

// Importing the file again, aimed where the first try was; a stop about the
// account starts from the account list instead.
function rerun(view: ImportView, options: StatusOptions): string {
  if (ACCOUNT_STOPS.has(view.stopped?.code ?? "")) {
    return `Next, to see your accounts and their IDs:\n  ${CLI} accounts list\n`;
  }
  const flags = accountFlags(options.rerun.account, options.rerun.create);
  if (options.rerun.file !== null && flags !== "") {
    return next(`${CLI} import ${options.rerun.file}${flags}`);
  }
  // Looked up by ID: the account it was for may be one it was making.
  const file = options.rerun.file ?? "<FILE>";
  return (
    `Next, with the same file, into one of your accounts or a new one:\n  ${CLI} import ${file} --account <ID>\n` +
    `  ${CLI} import ${file} --create-account --account-type card --account-name "<NAME>"\n`
  );
}

// The account flags as typed: an ID, or the new account's type and name
// (always quoted for a POSIX shell).
export function accountFlags(account: string | null, create: NewAccount | null): string {
  if (account !== null) return ` --account ${account}`;
  if (create !== null) return ` --create-account --account-type ${create.type} --account-name ${quotedName(create.name)}`;
  return "";
}

export function quotedName(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

// An account's kind in the words the flags use (card, bank), or as Driggsby
// names it.
export function kindWord(type: string): string {
  return TYPE_WORDS[type] ?? capForTerminal(type, 20);
}

// Each account with its kind and the ID an import names, then how to import.
export function renderAccounts(rows: AccountRow[]): Rendered {
  const create = `${CLI} import <FILE> --create-account --account-type card --account-name "<NAME>"`;
  if (rows.length === 0) {
    return ok(`No accounts yet.\n\nNext, to import a statement into a new account:\n  ${create}\n`);
  }
  const lines = rows.map((row) => {
    const label = name(row.last4 === null ? row.name : `${row.name} ····${row.last4}`);
    return `  ${label}\n    ${kindWord(row.type)} · ${row.ref}`;
  });
  return ok(
    `Your accounts (${String(rows.length)}):\n${lines.join("\n")}\n\n` +
      `Next, to import a statement into one:\n  ${CLI} import <FILE> --account <ID>\nOr into a new account:\n  ${create}\n`,
  );
}

export function renderQuestion(view: ImportView): string {
  const question = view.question;
  const prompt = question === null ? "What does Driggsby need to know?" : said(question.prompt);
  const explain = question === null ? "" : (EXPLAIN[question.kind] ?? "");
  const asked = indented(`${explain === "" ? "" : `${explain} `}${ASK}`).replace(/^ {2}/, "? ");
  const choices = question?.choices ?? [];
  const answers =
    choices.length === 0
      ? next(`${CLI} import ${view.ref}`)
      : `Next, run the command for the answer:\n${choiceLines(choices, (choice) => `${CLI} import ${view.ref} ${choice.flag} ${choice.value} --wait`)}`;
  return `Waiting for an answer about ${name(view.file)}: ${prompt}\n\n${asked}\n\n${answers}`;
}

export function choiceLines(choices: ImportChoice[], command: (choice: ImportChoice) => string): string {
  return `${choices.map((choice) => `  ${name(choice.label)}\n    ${command(choice)}`).join("\n")}\n`;
}

// The transactions are in: what landed, then what's left to do.
function landed(view: ImportView, headline: "Imported" | "Done"): string {
  const where = view.account === null ? " landed" : ` are in ${name(view.account)}`;
  const top = `${headline}: ${plural(view.counts?.new ?? 0, "transaction")} from ${name(view.file)}${where}.`;
  const undoCommand = `  ${CLI} import undo ${view.ref}\n`;
  // A new account is the person's to name by its ID from here on.
  const again = view.newAccount && view.accountRef !== null ? `Next time, for this account:\n  ${CLI} import <FILE> --account ${view.accountRef}\n\n` : "";
  const tail =
    again +
    (headline === "Imported"
      ? `${wrapProse("The transactions are usable now, and categories fill in on their own. Nothing else to do unless you need the categories (for a spending summary, say). To wait for them:")}\n` +
        `  ${waitCommand(view.ref)}\n\nIf it went into the wrong account, undo it once categories finish:\n${undoCommand}`
      : `${wrapProse("Nothing else to do: the import is finished. If it went into the wrong account, undo it with:")}\n${undoCommand}`);
  return `${top}\n\n${details(view, headline)}\n${tail}`;
}

function details(view: ImportView, headline: "Imported" | "Done"): string {
  const rows: string[] = [];
  if (view.lines !== null) {
    rows.push(`✓ Read        ${plural(view.lines, "line")}${view.dates === null ? "" : `, ${dateRange(view.dates.from, view.dates.to)}`}`);
  }
  if (view.account !== null) {
    rows.push(`✓ Account     ${name(view.account)}${view.newAccount ? " (a new account)" : ""}`);
  }
  if (view.counts !== null) {
    const already = view.counts.alreadyInDriggsby;
    rows.push(`✓ Imported    ${view.counts.new.toLocaleString("en-US")} new${already > 0 ? ` · ${already.toLocaleString("en-US")} already in Driggsby, skipped` : ""}`);
  }
  rows.push(headline === "Imported" ? `● Categories  ${progressText(view)}` : categoriesDone(view));
  const leftOut = leftOutText(view);
  if (leftOut !== "") {
    rows.push(`· Left out    ${leftOut}`);
  }
  return `${rows.join("\n")}\n`;
}

function categoriesDone(view: ImportView): string {
  return view.categorized === false
    ? "· Categories  some couldn't be filled in; those show as uncategorized"
    : `✓ Categories  all ${(view.counts?.new ?? 0).toLocaleString("en-US")} categorized`;
}

function progressText(view: ImportView): string {
  const progress = view.progress;
  if (progress === null || progress.categorized === 0) {
    return "starting now";
  }
  const left = progress.secondsLeft === null ? "" : `, ${timeLeft(progress.secondsLeft)}`;
  return `${progress.categorized.toLocaleString("en-US")} of ${progress.total.toLocaleString("en-US")} so far${left}`;
}

function categorizingLine(view: ImportView): string {
  const progress = view.progress;
  const where =
    progress === null || progress.categorized === 0
      ? "categorizing has started"
      : `${progress.categorized.toLocaleString("en-US")} of ${plural(progress.total, "transaction")} so far${progress.secondsLeft === null ? "" : `, ${timeLeft(progress.secondsLeft)}`}`;
  return `Categorizing: ${where}.\n\nThe transactions are usable while this runs.\n\n${next(waitCommand(view.ref))}`;
}

function done(view: ImportView, options: StatusOptions, context: RenderContext): string {
  if (view.nothingNew !== null) {
    const why = NOTHING_NEW[view.nothingNew] ?? "none of its transactions were new";
    return `Done: nothing new in ${name(view.file)}: ${why}.\n\nNothing else to do.\n`;
  }
  // A wait that followed categorizing ends on how it went, even for a file
  // sent again.
  if (options.compact && view.categorized === false) {
    return (
      `Done: ${plural(view.counts?.new ?? 0, "transaction")} from ${name(view.file)} are in, but some couldn't be categorized.\n\n` +
      `${wrapProse("Those show as uncategorized. Nothing else to do: the import is finished.")}\n`
    );
  }
  if (options.compact) {
    return `Done: all ${plural(view.counts?.new ?? 0, "transaction")} from ${name(view.file)} are categorized.\n\nNothing else to do: the import is finished.\n`;
  }
  if (options.repeated) {
    const on = view.finishedAt === null ? "" : ` on ${shortDate(view.finishedAt, context)}`;
    const into = view.account === null ? " landed" : ` went into ${name(view.account)}`;
    return `Already done: this file's ${plural(view.counts?.new ?? 0, "transaction")}${into}${on} (${view.ref}). Nothing to do.\n`;
  }
  return landed(view, "Done");
}

export function undoneLine(view: ImportView, removed: number | null): string {
  if (view.counts === null) {
    return `Undone: ${name(view.file)} was cancelled before anything landed, and its file is deleted.`;
  }
  const what = removed === null ? "the transactions it added are gone" : `removed ${plural(removed, "transaction")}`;
  return `Undone: ${name(view.file)}: ${what}${view.account === null ? "" : ` from ${name(view.account)}`}.`;
}

// Undo asked for while it can't run yet, or after it already has: where
// things stand and, when there's a wait, the commands in order. Not a
// failure: repeating an undo is safe.
export function renderNotUndoable(view: ImportView, preview: UndoPreview): Rendered {
  switch (view.state) {
    case "undone":
      return ok(`Already undone: nothing ${name(view.file)} added is left.\n`);
    case "undoing":
      return ok(`${undoingLine(view)}\n\n${next(waitCommand(view.ref))}`);
    case "stopped":
      return ok(`Nothing to undo: ${name(view.file)} stopped before anything landed.\n`);
    case "reading":
    case "importing":
    case "categorizing":
      return ok(
        `Not undone yet: ${name(view.file)} is still ${view.state}, and undo works once that finishes.\n\n` +
          `Next, run the first until it says Done or asks a question, then the second:\n  ${waitCommand(view.ref)}\n  ${CLI} import undo ${view.ref}\n`,
      );
    default:
      return { text: `Refused: ${said(preview.message ?? "This import can't be undone right now.")}\n`, exitCode: 1 };
  }
}

export function renderUndoPreview(view: ImportView, preview: UndoPreview): Rendered {
  const yes = `${CLI} import undo ${view.ref} --yes`;
  if (preview.cancels) {
    return ok(
      `Not undone yet: ${name(view.file)} is still waiting for an answer, so nothing has landed.\n\n` +
        `${indented("Undoing cancels it and deletes its uploaded file.")}\n\nNext, to cancel it:\n  ${yes}\n`,
    );
  }
  const edited = preview.edited > 0 ? `, and ${preview.edited} ${preview.edited === 1 ? "was" : "were"} edited since` : "";
  const parts = [
    `They're the transactions it added${view.account === null ? "" : ` to ${name(view.account)}`}${edited}.`,
    preview.edited > 0 ? "Importing the file again brings the transactions back, but not those edits." : "Importing the file again brings them back.",
    preview.accountRemoved ? "The account it made goes too, since nothing else is in it." : "",
    preview.keptForLaterImports > 0 ? `${plural(preview.keptForLaterImports, "transaction")} stay, since a later import found them too.` : "",
    "If you're working for someone, check with them first.",
  ].filter((part) => part !== "");
  return ok(
    `Not undone yet: undoing ${name(view.file)} would remove ${plural(preview.transactions, "transaction")}.\n\n${indented(parts.join(" "))}\n\n` +
      `Next, to undo it:\n  ${yes}\n`,
  );
}

export function renderList(views: ImportView[], context: RenderContext): Rendered {
  if (views.length === 0) {
    return ok(`You haven't imported any statements yet.\n\n${next(`${CLI} import <FILE>`)}`);
  }
  const rows = views.map((view) => ({ ref: view.ref, state: listState(view), file: quotedForTerminal(view.file, 40), date: shortDate(view.startedAt, context) }));
  const stateWidth = Math.max(...rows.map((row) => row.state.length));
  const fileWidth = Math.max(...rows.map((row) => row.file.length));
  const table = rows.map((row) => `  ${row.ref}  ${row.state.padEnd(stateWidth)}  ${row.file.padEnd(fileWidth)}  ${row.date}`.trimEnd()).join("\n");
  const waiting = views.filter((view) => view.state === "waiting");
  const attention = waiting.length === 0 ? "" : `\nNeeds attention:\n${waiting.map((view) => `  ${CLI} import ${view.ref}`).join("\n")}\n`;
  return ok(`Your recent imports, newest first:\n\n${table}\n${attention}`);
}

function listState(view: ImportView): string {
  switch (view.state) {
    case "waiting":
      return "waiting for an answer";
    case "categorizing":
      return view.progress === null ? "categorizing" : `categorizing, ${view.progress.categorized}/${view.progress.total}`;
    case "done":
      return view.nothingNew !== null ? "done, nothing new" : `done, ${view.counts?.new ?? 0} new`;
    default:
      return view.state;
  }
}

function leftOutText(view: ImportView): string {
  const pending = (view.counts?.pending ?? 0) + view.leftOut.notPosted;
  return [
    pending > 0 ? plural(pending, "pending charge") : "",
    view.leftOut.balance > 0 ? plural(view.leftOut.balance, "balance line") : "",
    view.leftOut.unreadable > 0 ? plural(view.leftOut.unreadable, "unreadable line") : "",
  ]
    .filter((part) => part !== "")
    .join(" · ");
}

export function plural(count: number, noun: string): string {
  return `${count.toLocaleString("en-US")} ${noun}${count === 1 ? "" : "s"}`;
}

function ok(text: string): Rendered {
  return { text, exitCode: 0 };
}

function timeLeft(seconds: number): string {
  if (seconds < 60) return "under a minute left";
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `about ${minutes} ${minutes === 1 ? "minute" : "minutes"} left`;
  return `about ${Math.round(minutes / 60)} hours left`;
}

function ago(iso: string | null, now: Date): string {
  const started = iso === null ? Number.NaN : Date.parse(iso);
  if (Number.isNaN(started)) return "a moment ago";
  const seconds = Math.max(0, Math.round((now.getTime() - started) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s ago`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m ago`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// Statement dates are calendar dates (YYYY-MM-DD), read without a zone.
function dateRange(from: string, to: string): string {
  const [fromYear, fromMonth, fromDay] = from.split("-").map(Number);
  const [toYear, toMonth, toDay] = to.split("-").map(Number);
  if ([fromYear, fromMonth, fromDay, toYear, toMonth, toDay].some((part) => part === undefined || Number.isNaN(part))) return "";
  const day = (month: number | undefined, dayOfMonth: number | undefined): string => `${MONTHS[(month ?? 1) - 1] ?? ""} ${String(dayOfMonth)}`;
  return fromYear === toYear
    ? `${day(fromMonth, fromDay)} – ${day(toMonth, toDay)}, ${String(toYear)}`
    : `${day(fromMonth, fromDay)}, ${String(fromYear)} – ${day(toMonth, toDay)}, ${String(toYear)}`;
}

function shortDate(iso: string | null, context: RenderContext): string {
  const at = iso === null ? Number.NaN : Date.parse(iso);
  if (Number.isNaN(at)) return "";
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: context.timeZone }).format(new Date(at));
}
