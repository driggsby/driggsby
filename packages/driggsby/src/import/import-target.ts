// What `import <FILE or ID>` names: a file on this machine (read once,
// size-checked, and hashed, so Driggsby can say whether it already has it
// before any upload), or an import's ID. A file wins over an ID-shaped
// name, so a file that happens to be called imp_... still imports.
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { basename } from "node:path";

import { CliError } from "../cli-error.ts";
import { quotedForTerminal, sanitizeForTerminal, wrapProse } from "../terminal-text.ts";
import { type ImportFile } from "./import-client.ts";
import { isImportRef } from "./import-view.ts";

export const MAX_FILE_BYTES = 10 * 1024 * 1024;

export type ImportTarget = { kind: "ref"; ref: string } | { kind: "file"; file: ImportFile; sha256: string; typed: string };

export async function resolveTarget(typed: string): Promise<ImportTarget> {
  const info = await stat(typed).catch(() => null);
  if (info === null) {
    if (isImportRef(typed)) {
      return { kind: "ref", ref: typed };
    }
    throw new CliError(wrapProse(`There's no file at ${quotedForTerminal(typed, 200)}. Check the path and run the command again.`), 1);
  }
  if (!info.isFile()) {
    throw new CliError(wrapProse(`${quotedForTerminal(typed, 200)} is a folder, not a file. Name the statement's CSV file itself.`), 1);
  }
  if (info.size > MAX_FILE_BYTES) {
    const megabytes = (info.size / 1024 / 1024).toFixed(1);
    throw new CliError(
      `Refused: the file is ${megabytes} MB, and statement imports take files up to 10 MB.\n` +
        "Nothing was imported.\n\nNext:\n  Export a shorter date range from the bank and import each part.",
      1,
    );
  }
  const bytes = new Uint8Array(await readFile(typed));
  return {
    kind: "file",
    file: { name: basename(typed), bytes },
    sha256: createHash("sha256").update(bytes).digest("hex"),
    typed,
  };
}

// A file over the limit was never imported, so there's nothing of it to undo.
export async function tooLargeToImport(typed: string): Promise<boolean> {
  const info = await stat(typed).catch(() => null);
  return info !== null && info.isFile() && info.size > MAX_FILE_BYTES;
}

// A typed path as a copy-paste-safe shell word: stripped of terminal
// control bytes, never read as a flag (a leading "-" gets "./"), bare when
// it's plain, otherwise single-quoted with any single quote spelled out.
export function shellWord(value: string): string {
  const cleaned = sanitizeForTerminal(value);
  const shown = cleaned.startsWith("-") ? `./${cleaned}` : cleaned;
  return /^[A-Za-z0-9_./@%+=:,-]+$/.test(shown) ? shown : `'${shown.replaceAll("'", "'\\''")}'`;
}
