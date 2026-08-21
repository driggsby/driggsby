// Fallback credential storage: ~/.driggsby/credentials.json, written
// atomically with owner-only permissions. This is the only backend on
// Windows (no readable credential CLI exists there; the profile directory's
// default user-only ACL is the boundary) and the fallback everywhere else.
import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { type ClearOutcome } from "./clear-outcome.ts";

export function credentialsFilePath(homeDirectory: string): string {
  return join(homeDirectory, ".driggsby", "credentials.json");
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
  const directory = join(homeDirectory, ".driggsby");
  // mode applies only when the directory is created; an existing ~/.driggsby
  // keeps whatever permissions the user already gave it.
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const finalPath = credentialsFilePath(homeDirectory);
  const temporaryPath = join(directory, `credentials.json.${randomUUID()}.tmp`);
  const body = `${JSON.stringify({ app_token: token }, null, 2)}\n`;
  try {
    await writeFile(temporaryPath, body, { mode: 0o600 });
    await rename(temporaryPath, finalPath);
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
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
    for (const entry of await readdir(join(homeDirectory, ".driggsby"))) {
      if (entry.startsWith("credentials.json.") && entry.endsWith(".tmp")) {
        try {
          await rm(join(homeDirectory, ".driggsby", entry), { force: true });
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
