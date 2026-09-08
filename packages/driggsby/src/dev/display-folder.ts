// A project folder as printed in `dev` messages: the person's home shortens
// to "~" so the common case fits a terminal line, and the result goes
// through quotedForTerminal because a path is text this CLI did not author.
import { homedir } from "node:os";

import { quotedForTerminal } from "../terminal-text.ts";

const MAX_FOLDER_CHARS = 200;

export function displayFolder(folder: string, home: string = homedir()): string {
  const shortened = home !== "" && (folder === home || folder.startsWith(`${home}/`)) ? `~${folder.slice(home.length)}` : folder;
  return quotedForTerminal(shortened, MAX_FOLDER_CHARS);
}
