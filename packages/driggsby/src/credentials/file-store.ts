// Fallback credential storage: ~/.driggsby/credentials.json, written
// atomically with owner-only permissions. This is the only backend on
// Windows (no readable credential CLI exists there; the profile directory's
// default user-only ACL is the boundary) and the fallback everywhere else.
import { readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";

import { driggsbyDirectory, writeOwnerOnlyFile } from "../owner-only-file.ts";
import { type ClearOutcome } from "./clear-outcome.ts";

const CREDENTIALS_FILE_NAME = "credentials.json";

export function credentialsFilePath(homeDirectory: string): string {
  return join(driggsbyDirectory(homeDirectory), CREDENTIALS_FILE_NAME);
}

export async function readFileToken(homeDirectory: string): Promise<string | null> {
  let raw: string;
  try {
    raw = await readFile(credentialsFilePath(homeDirectory), "utf8");
  } catch {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) {
      return null;
    }
    const token = (parsed as Record<string, unknown>).app_token;
    return typeof token === "string" && token !== "" ? token : null;
  } catch {
    return null;
  }
}

export async function writeFileToken(homeDirectory: string, token: string): Promise<void> {
  await writeOwnerOnlyFile(homeDirectory, CREDENTIALS_FILE_NAME, `${JSON.stringify({ app_token: token }, null, 2)}\n`);
}

export async function clearFileToken(homeDirectory: string): Promise<ClearOutcome> {
  let outcome: ClearOutcome;
  try {
    await rm(credentialsFilePath(homeDirectory));
    outcome = "cleared";
  } catch (error) {
    outcome = (error as NodeJS.ErrnoException).code === "ENOENT" ? "absent" : "failed";
  }
  // A crash between writeFileToken's temp write and its rename can strand a
  // readable token in a `credentials.json.<uuid>.tmp` file; removal must not
  // leave one behind while reporting the token gone.
  try {
    for (const entry of await readdir(driggsbyDirectory(homeDirectory))) {
      if (entry.startsWith("credentials.json.") && entry.endsWith(".tmp")) {
        try {
          await rm(join(driggsbyDirectory(homeDirectory), entry), { force: true });
        } catch {
          outcome = "failed";
        }
      }
    }
  } catch {
    // No ~/.driggsby directory at all: nothing was ever stored here.
  }
  return outcome;
}
