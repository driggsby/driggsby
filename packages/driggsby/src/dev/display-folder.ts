// A project folder as printed in `dev` messages: the person's home shortens
// to "~" so the common case fits a terminal line, and the result goes
// through quotedForTerminal because a path is text this CLI did not author.
import { homedir } from "node:os";
import { isAbsolute, relative, sep } from "node:path";

import { quotedForTerminal } from "../terminal-text.ts";

const MAX_FOLDER_CHARS = 200;

export function displayFolder(folder: string, home: string = homedir()): string {
  return quotedForTerminal(homeRelative(folder, home), MAX_FOLDER_CHARS);
}

function homeRelative(folder: string, home: string): string {
  if (home === "" || !isAbsolute(folder)) {
    return folder;
  }
  const inside = relative(home, folder);
  if (inside === "") {
    return "~";
  }
  if (inside.startsWith("..") || isAbsolute(inside)) {
    return folder;
  }
  return `~${sep}${inside}`;
}
