// Shared setup for the import command's tests: a made-up CSV on disk, an io
// whose clock moves only when the command sleeps, and option builders.
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { type ImportCommandIo, type ImportCommandOptions } from "../import-command.ts";
import { type ToolAnswer, type ToolSeen } from "./fake-driggsby.ts";

export const CSV = "Date,Description,Amount\n06/01/2026,MADE-UP COFFEE,-4.50\n06/02/2026,MADE-UP TEA,-3.00\n";
export const REF = "imp_7kq2mxa9p4bz";

export interface Captured extends ImportCommandIo {
  text: () => string;
  slept: () => number;
}

export function io(): Captured {
  let buffer = "";
  let clock = Date.parse("2026-10-19T15:01:31Z");
  let slept = 0;
  return {
    out: (text) => {
      buffer += text;
    },
    now: () => new Date(clock),
    sleep: (ms) => {
      clock += ms;
      slept += ms;
      return Promise.resolve();
    },
    ask: null,
    timeZone: "UTC",
    text: () => buffer,
    slept: () => slept,
  };
}

export async function csvFile(name = "made-up-export.csv", contents = CSV): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "driggsby-import-"));
  const path = join(directory, name);
  await writeFile(path, contents);
  return path;
}

export function run(target: string, extra: Partial<Extract<ImportCommandOptions, { action: "run" }>> = {}): ImportCommandOptions {
  return { action: "run", target, wait: false, account: null, create: null, dates: null, amounts: null, ...extra };
}

// The tool handler for a scripted sequence of get_statement_import answers.
export function sequence(
  views: Record<string, unknown>[],
  others: (seen: ToolSeen) => ToolAnswer | null = () => null,
): (seen: ToolSeen) => ToolAnswer {
  let index = 0;
  return (seen) => {
    const other = others(seen);
    if (other !== null) return other;
    const view = views[Math.min(index, views.length - 1)];
    index += 1;
    return { ok: { import: view } };
  };
}
