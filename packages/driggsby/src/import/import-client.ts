// The import command's channel to Driggsby: one upload for a new file's
// bytes (POST /statement-imports), and the CLI-only statement-import tools
// on /mcp for everything else. The file never rides a tool call. Every
// request carries the saved sign-in, which requireDeploySession has already
// pinned to Driggsby itself, and never follows a redirect.
import { CliError } from "../cli-error.ts";
import { type DeploySession, SIGN_IN_AGAIN_MESSAGE } from "../deploy/api-session.ts";
import { callRuleTool } from "../rules/rules-rpc.ts";
import { capForTerminal } from "../terminal-text.ts";
import { asRecord, type ImportView, type NewAccount, readImportView, readUndoPreview, refText, type UndoPreview } from "./import-view.ts";

// With a lookup ahead of it, inside a coding agent's 2-minute limit on one
// command; a 10 MB file needs about 1 Mbit/s of upload to finish.
const UPLOAD_TIMEOUT_MS = 90_000;
// Each tool call answers in well under a second; this only bounds a hung one.
const TOOL_TIMEOUT_MS = 15_000;
const MAX_SERVER_MESSAGE_CHARS = 1_000;
// Far past anyone's accounts; only bounds a server that never stops paging.
const ACCOUNT_PAGES = 20;

export const IMPORTS_NOT_AVAILABLE_MESSAGE =
  "This sign-in can't import statements. Sign in again and approve the request:\n" + "  npx driggsby@latest login";
// An answer the CLI can't read; the command adds the same command to run again.
export const TROUBLE = "Driggsby couldn't take that just now. Please try again in a minute.";

// Driggsby said it was busy, timed out, or was briefly unavailable: the same
// command again is the fix, which the command names, whatever `retryable`
// says (every import command is safe to repeat). A limit that lasts longer
// (a day's) is rate_limited with retryable: false and keeps its own words.
export class DriggsbyBusy extends Error {}
const TEMPORARY_KINDS: ReadonlySet<string> = new Set(["busy", "timeout", "unavailable"]);

function temporary(details: Record<string, unknown> | null): boolean {
  if (details === null) return false;
  if (details.kind === "rate_limited") return details.retryable === true;
  return details.retryable === true || (typeof details.kind === "string" && TEMPORARY_KINDS.has(details.kind));
}

// What a tool call or an upload came back with.
export type ImportOutcome =
  | { kind: "import"; view: ImportView; created: boolean; note: string | null; undo: UndoPreview | null }
  | { kind: "refused"; code: string; message: string; account: AccountRow | null; view: ImportView | null };

// One of the person's accounts: its ID, its name as they see it, its kind,
// and its last four digits.
export interface AccountRow {
  ref: string;
  name: string;
  type: string;
  last4: string | null;
}

// Where an import goes: an account by its ID, or a new one.
export type Destination = { account: string } | { create: NewAccount };

export interface ImportFile {
  name: string;
  bytes: Uint8Array;
}

// Where the file is meant to go rides along, so an import of it that went
// to another account comes back refused, with that import.
export async function findByFile(session: DeploySession, sha256: string, destination: Destination | null): Promise<ImportOutcome> {
  return tool(session, "get_statement_import", { sha256, ...destinationArguments(destination) });
}

function destinationArguments(destination: Destination | null): Record<string, string> {
  if (destination === null) return {};
  return "account" in destination
    ? { account: destination.account }
    : { new_account_type: destination.create.type, new_account_name: destination.create.name };
}

export async function findByRef(session: DeploySession, importRef: string): Promise<ImportOutcome> {
  return tool(session, "get_statement_import", { import_ref: importRef });
}

export async function answer(session: DeploySession, importRef: string, given: { dates?: string; amounts?: string }): Promise<ImportOutcome> {
  return tool(session, "answer_statement_import", { import_ref: importRef, ...given });
}

export async function undo(session: DeploySession, importRef: string, confirm: boolean): Promise<ImportOutcome> {
  return tool(session, "undo_statement_import", confirm ? { import_ref: importRef, confirm: true } : { import_ref: importRef });
}

export async function list(session: DeploySession): Promise<ImportView[]> {
  const outcome = await callRuleTool(session, "list_statement_imports", {}, TOOL_TIMEOUT_MS);
  if (outcome.kind === "refused" && temporary(asRecord(outcome.details))) {
    throw new DriggsbyBusy();
  }
  if (outcome.kind !== "ok") {
    throw new CliError(outcome.kind === "error" ? notAvailable(outcome.message) : outcome.message, 1);
  }
  const imports = asRecord(outcome.result)?.imports;
  if (!Array.isArray(imports)) {
    throw new CliError(TROUBLE, 1);
  }
  const entries: unknown[] = imports;
  return entries.flatMap((entry) => {
    const view = readImportView(entry);
    return view === null ? [] : [view];
  });
}

// The person's accounts, every page of them.
export async function accounts(session: DeploySession): Promise<AccountRow[]> {
  const rows: AccountRow[] = [];
  let pageToken: string | null = null;
  for (let page = 0; page < ACCOUNT_PAGES; page += 1) {
    const outcome = await callRuleTool(session, "list_accounts", pageToken === null ? {} : { page_token: pageToken }, TOOL_TIMEOUT_MS);
    if (outcome.kind === "refused" && temporary(asRecord(outcome.details))) {
      throw new DriggsbyBusy();
    }
    if (outcome.kind !== "ok") {
      throw new CliError(outcome.kind === "error" ? notAvailable(outcome.message) : outcome.message, 1);
    }
    const result = asRecord(outcome.result);
    const listed: unknown = result?.linked_accounts;
    if (!Array.isArray(listed)) {
      throw new CliError(TROUBLE, 1);
    }
    const entries: unknown[] = listed;
    rows.push(...entries.flatMap((entry) => accountRow(entry)));
    pageToken = typeof result?.next_page_token === "string" && result.next_page_token !== "" ? result.next_page_token : null;
    if (pageToken === null) break;
  }
  return rows;
}

function accountRow(value: unknown): AccountRow[] {
  const record = asRecord(value);
  const ref = refText(record?.account_ref);
  const name = typeof record?.account_display_name === "string" ? record.account_display_name : null;
  if (ref === null || name === null) {
    return [];
  }
  const last4 = typeof record?.account_mask_last4 === "string" && /^\d{4}$/.test(record.account_mask_last4) ? record.account_mask_last4 : null;
  return [{ ref, name, type: typeof record?.account_type === "string" ? record.account_type : "", last4 }];
}

export async function upload(session: DeploySession, file: ImportFile, destination: Destination): Promise<ImportOutcome> {
  // Bare headers on purpose, as for /mcp: Driggsby refuses anything that
  // looks like a browser call, and Node's fetch adds no Origin of its own.
  const headers: Record<string, string> = {
    "Content-Type": "application/octet-stream",
    Authorization: `Bearer ${session.token}`,
    "Driggsby-Filename": encodeURIComponent(file.name),
  };
  if ("account" in destination) {
    headers["Driggsby-Account"] = destination.account;
  } else {
    headers["Driggsby-New-Account-Type"] = destination.create.type;
    headers["Driggsby-New-Account-Name"] = encodeURIComponent(destination.create.name);
  }
  const response = await fetch(new URL("/statement-imports", session.baseUrl), {
    method: "POST",
    headers,
    body: file.bytes,
    redirect: "error",
    signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
  });
  if (response.status === 401) {
    throw new CliError(SIGN_IN_AGAIN_MESSAGE, 1);
  }
  // A minute's limit, or Driggsby (or the way to it) briefly down.
  if (response.status === 429 || response.status >= 500) {
    throw new DriggsbyBusy();
  }
  const payload = await jsonBody(response);
  const record = asRecord(payload);
  if (response.status === 403 && record?.error === "cli_sign_in_required") {
    throw new CliError(IMPORTS_NOT_AVAILABLE_MESSAGE, 1);
  }
  if (response.ok) {
    const view = readImportView(record?.import);
    if (view === null) {
      throw new CliError(TROUBLE, 1);
    }
    return { kind: "import", view, created: response.status === 201, note: null, undo: null };
  }
  if ((response.status === 422 || response.status === 413) && typeof record?.error === "string") {
    return {
      kind: "refused",
      code: record.error,
      message: serverMessage(record.error_description),
      account: takenAccount(record.account),
      view: readImportView(record.import),
    };
  }
  throw new CliError(TROUBLE, 1);
}

async function tool(session: DeploySession, name: string, toolArguments: Record<string, unknown>): Promise<ImportOutcome> {
  const outcome = await callRuleTool(session, name, toolArguments, TOOL_TIMEOUT_MS);
  if (outcome.kind === "error") {
    throw new CliError(notAvailable(outcome.message), 1);
  }
  const details = asRecord(outcome.kind === "ok" ? outcome.result : outcome.details);
  if (outcome.kind === "refused" && temporary(details)) {
    throw new DriggsbyBusy();
  }
  if (outcome.kind === "refused") {
    return {
      kind: "refused",
      code: typeof details?.code === "string" ? details.code : "refused",
      message: outcome.message,
      account: takenAccount(details?.account),
      view: readImportView(details?.import),
    };
  }
  const view = readImportView(details?.import);
  if (view === null) {
    throw new CliError(TROUBLE, 1);
  }
  return {
    kind: "import",
    view,
    created: false,
    note: typeof details?.note === "string" ? serverMessage(details.note) : null,
    undo: readUndoPreview(details?.undo),
  };
}

// The account a new account's name already belongs to, when Driggsby says.
function takenAccount(value: unknown): AccountRow | null {
  const record = asRecord(value);
  const ref = refText(record?.account_ref);
  const type = typeof record?.account_type === "string" ? record.account_type : "";
  return ref === null ? null : { ref, name: serverMessage(record?.name), type, last4: null };
}

// A sign-in from before imports (or an app's token) is told how to get them;
// any other protocol error keeps its own words.
function notAvailable(message: string): string {
  return /isn't available from the Driggsby CLI|Only a Driggsby CLI sign-in|Unknown tool/.test(message) ? IMPORTS_NOT_AVAILABLE_MESSAGE : message;
}

async function jsonBody(response: Response): Promise<unknown> {
  try {
    const parsed: unknown = await response.json();
    return parsed;
  } catch {
    return null;
  }
}

function serverMessage(value: unknown): string {
  return typeof value === "string" ? capForTerminal(value, MAX_SERVER_MESSAGE_CHARS).trim() : "";
}
