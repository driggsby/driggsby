// A file that only its owner may read (under ~/.driggsby unless a directory
// is named), written atomically:
// the directory is created owner-only if it does not exist, the body lands
// in a temp file with mode 0600, and a rename makes it appear whole. Used
// for the saved sign-in, the record of a running `driggsby dev`, and the
// channel's place.
import { randomUUID } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const DRIGGSBY_DIRECTORY_NAME = ".driggsby";

export function driggsbyDirectory(homeDirectory: string): string {
  return join(homeDirectory, DRIGGSBY_DIRECTORY_NAME);
}

export async function writeOwnerOnlyFile(homeDirectory: string, fileName: string, body: string): Promise<void> {
  await writeOwnerOnlyFileIn(driggsbyDirectory(homeDirectory), fileName, body);
}

// The same, in any directory (the channel's place in the plugin's data folder).
export async function writeOwnerOnlyFileIn(directory: string, fileName: string, body: string): Promise<void> {
  // mode applies only when the directory is created; an existing directory
  // keeps whatever permissions the user already gave it.
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporaryPath = join(directory, `${fileName}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporaryPath, body, { mode: 0o600 });
    await rename(temporaryPath, join(directory, fileName));
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
}
