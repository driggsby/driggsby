// A file under ~/.driggsby that only its owner may read, written atomically:
// the directory is created owner-only if it does not exist, the body lands
// in a temp file with mode 0600, and a rename makes it appear whole. Used
// for the saved sign-in and for the record of a running `driggsby dev`.
import { randomUUID } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const DRIGGSBY_DIRECTORY_NAME = ".driggsby";

export function driggsbyDirectory(homeDirectory: string): string {
  return join(homeDirectory, DRIGGSBY_DIRECTORY_NAME);
}

export async function writeOwnerOnlyFile(homeDirectory: string, fileName: string, body: string): Promise<void> {
  const directory = driggsbyDirectory(homeDirectory);
  // mode applies only when the directory is created; an existing ~/.driggsby
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
