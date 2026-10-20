// What Driggsby says about one statement import, read defensively: every
// field is checked for its type, and anything else is dropped, so a server
// change can never crash a render or slip an unexpected shape through.
// Strings are still untrusted text; the renderer sanitizes and quotes them.

export type ImportState =
  | "reading"
  | "waiting"
  | "importing"
  | "categorizing"
  | "done"
  | "stopped"
  | "undoing"
  | "undone";

const STATES: ReadonlySet<string> = new Set([
  "reading",
  "waiting",
  "importing",
  "categorizing",
  "done",
  "stopped",
  "undoing",
  "undone",
]);

// One choice of a question: what it's called, and the answer (a --dates or
// --amounts value) that picks it.
export interface ImportChoice {
  label: string;
  flag: "--dates" | "--amounts";
  value: string;
}

// A new account an import asks for: its type and its name.
export interface NewAccount {
  type: "card" | "bank";
  name: string;
}

export const ACCOUNT_REF = /^acct_[A-Za-z0-9_-]{1,64}$/;

export interface ImportView {
  ref: string;
  file: string;
  state: ImportState;
  lines: number | null;
  bytes: number | null;
  startedAt: string | null;
  finishedAt: string | null;
  account: string | null;
  // The account's ID, which a later import of the same account names.
  accountRef: string | null;
  newAccount: boolean;
  counts: { new: number; alreadyInDriggsby: number; pending: number } | null;
  dates: { from: string; to: string } | null;
  leftOut: { notPosted: number; unreadable: number; balance: number };
  nothingNew: string | null;
  categorized: boolean | null;
  question: { kind: string; prompt: string; choices: ImportChoice[] } | null;
  progress: { categorized: number; total: number; secondsLeft: number | null } | null;
  stopped: { code: string; message: string } | null;
}

export interface UndoPreview {
  undoable: boolean;
  cancels: boolean;
  transactions: number;
  edited: number;
  keptForLaterImports: number;
  accountRemoved: boolean;
  message: string | null;
}

const IMPORT_REF = /^imp_[A-Za-z0-9_-]{12}$/;

export function isImportRef(value: string): boolean {
  return IMPORT_REF.test(value);
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

function optionalCount(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : null;
}

// null when the payload isn't an import Driggsby described.
export function readImportView(value: unknown): ImportView | null {
  const record = asRecord(value);
  const ref = text(record?.import_ref);
  const state = text(record?.state);
  if (record === null || ref === null || !isImportRef(ref) || state === null || !STATES.has(state)) {
    return null;
  }
  const counts = asRecord(record.counts);
  const dates = asRecord(record.dates);
  const leftOut = asRecord(record.left_out);
  const progress = asRecord(record.progress);
  const stopped = asRecord(record.stopped);
  const from = text(dates?.from);
  const to = text(dates?.to);
  return {
    ref,
    file: text(record.file) ?? "statement.csv",
    state: state as ImportState,
    lines: optionalCount(record.lines),
    bytes: optionalCount(record.bytes),
    startedAt: text(record.started_at),
    finishedAt: text(record.finished_at),
    account: text(asRecord(record.account)?.label),
    accountRef: refText(asRecord(record.account)?.ref),
    newAccount: record.new_account === true,
    counts:
      counts === null
        ? null
        : { new: count(counts.new), alreadyInDriggsby: count(counts.already_in_driggsby), pending: count(counts.pending) },
    dates: from !== null && to !== null ? { from, to } : null,
    leftOut: { notPosted: count(leftOut?.not_posted), unreadable: count(leftOut?.unreadable), balance: count(leftOut?.balance) },
    nothingNew: text(record.nothing_new),
    categorized: typeof record.categorized === "boolean" ? record.categorized : null,
    question: readQuestion(record.question),
    progress:
      progress === null
        ? null
        : {
            categorized: count(progress.categorized),
            total: count(progress.total),
            secondsLeft: optionalCount(progress.seconds_left),
          },
    stopped: stopped === null ? null : { code: text(stopped.code) ?? "stopped", message: text(stopped.message) ?? "" },
  };
}

function readQuestion(value: unknown): ImportView["question"] {
  const record = asRecord(value);
  const kind = text(record?.kind);
  const prompt = text(record?.prompt);
  if (record === null || kind === null || prompt === null) {
    return null;
  }
  return { kind, prompt, choices: readChoices(record.choices) };
}

// Each choice keeps exactly one answer the CLI knows how to send.
export function readChoices(value: unknown): ImportChoice[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const entries: unknown[] = value;
  return entries.flatMap((entry): ImportChoice[] => {
    const record = asRecord(entry);
    const label = text(record?.label);
    const answer = asRecord(record?.answer);
    if (label === null || answer === null) {
      return [];
    }
    const flags: [ImportChoice["flag"], unknown][] = [
      ["--dates", answer.dates],
      ["--amounts", answer.amounts],
    ];
    const found = flags.filter(([, answerValue]) => typeof answerValue === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(answerValue));
    const [chosen] = found;
    return found.length === 1 && chosen !== undefined ? [{ label, flag: chosen[0], value: chosen[1] as string }] : [];
  });
}

export function refText(value: unknown): string | null {
  return typeof value === "string" && ACCOUNT_REF.test(value) ? value : null;
}

export function readUndoPreview(value: unknown): UndoPreview | null {
  const record = asRecord(value);
  if (record === null || typeof record.undoable !== "boolean") {
    return null;
  }
  return {
    undoable: record.undoable,
    cancels: record.cancels === true,
    transactions: count(record.transactions),
    edited: count(record.edited),
    keptForLaterImports: count(record.kept_for_later_imports),
    accountRemoved: record.account_removed === true,
    message: text(record.message),
  };
}
