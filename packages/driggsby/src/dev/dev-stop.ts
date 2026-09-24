// driggsby dev --stop: end a `driggsby dev` without its terminal, so an
// agent that started one in the background can put the ports (and the
// live-data preview) away without hunting for the process. Several previews
// can run at once, one per app folder, often each an agent's: run anywhere
// inside an app (its folder or a subfolder), it stops that app's preview
// and never another's; run outside any app, it stops the only preview
// running, and with several it names them rather than guess. A record is
// trusted only after its recorded port confirms it is served by the
// recorded pid (see readDevStates), and that is confirmed again just before
// the signal.
import { stat } from "node:fs/promises";
import { dirname, join, resolve as resolvePath } from "node:path";

import { CliError } from "../cli-error.ts";
import { DEV_START_COMMAND, DEV_STOP_COMMAND } from "./dev-commands.ts";
import {
  type DevProbes,
  type DevStateRead,
  defaultDevProbes,
  readDevStates,
  removeDevState,
  sameFolder,
} from "./dev-state.ts";
import { displayFolder } from "./display-folder.ts";

// How many waits of `waitMs` a signalled dev gets to go before we report it.
const STOP_ATTEMPTS = 20;

export interface DevStopIo {
  out: (text: string) => void;
}

export interface DevStopDeps extends DevProbes {
  terminate: (pid: number) => void;
  waitMs: number;
}

function defaultDevStopDeps(): DevStopDeps {
  return {
    ...defaultDevProbes(),
    terminate: (pid) => {
      process.kill(pid, "SIGTERM");
    },
    waitMs: 250,
  };
}

function defaultDevStopIo(): DevStopIo {
  return {
    out: (text) => {
      process.stdout.write(text);
    },
  };
}

export async function runDevStop(
  homeDirectory: string,
  io: DevStopIo = defaultDevStopIo(),
  deps: DevStopDeps = defaultDevStopDeps(),
  currentFolder: string = process.cwd(),
): Promise<number> {
  const reads = await readDevStates(homeDirectory, deps);
  if (reads.length === 0) {
    io.out(nothingRunning());
    return 0;
  }
  // The app this runs in, found the way `dev` records it: the nearest folder
  // at or above this one with a driggsby.json. Its live preview comes first:
  // a leftover record for the app must never hide the one running there.
  const appFolder = await appFolderAround(currentFolder);
  const here = reads.filter((each) => sameFolder(each.state.folder, appFolder ?? currentFolder));
  let read = here.find(isLive) ?? here[0];
  if (read === undefined) {
    if (appFolder !== null) {
      io.out(nothingRunningForThisApp(reads));
      return 0;
    }
    const live = reads.filter(isLive);
    read = live.length === 1 ? live[0] : live.length === 0 && folderCount(reads) === 1 ? reads[0] : undefined;
  }
  if (read === undefined) {
    throw severalRunning(reads);
  }
  const state = read.state;
  const folder = displayFolder(state.folder);
  // The pid is alive but the port did not answer as that dev: it may be
  // busy, or the pid may have been recycled. Never signal a process the
  // port has not vouched for, and never claim nothing is running. The port
  // is asked again right before the signal, since reading every record
  // can take a few seconds on a busy machine.
  if (read.status === "unconfirmed" || (await deps.pidServing(state.hostPort)) !== state.pid) {
    throw unconfirmed(folder);
  }
  try {
    deps.terminate(state.pid);
  } catch (error) {
    // Gone between the check and the signal: nothing left to stop. A dev
    // the port vouched for that this process may not signal (a sandboxed
    // agent, another user's process) is still running, so its record stays
    // and the person is told where to stop it. Any other failure leaves the
    // record too.
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") {
      await removeDevState(homeDirectory, state.pid);
      io.out(`driggsby dev had already stopped for the app in:\n  ${folder}\n`);
      return 0;
    }
    if (code === "EPERM") {
      throw new CliError(
        `driggsby dev is running for the app in:\n  ${folder}\n\n` +
          "but isn't allowed to be stopped from here. Press Ctrl+C in the terminal\n" +
          "where it runs.",
        1,
      );
    }
    throw error;
  }
  for (let attempt = 0; attempt < STOP_ATTEMPTS; attempt += 1) {
    if (!deps.isAlive(state.pid)) {
      await removeDevState(homeDirectory, state.pid);
      io.out(`✓ Stopped   driggsby dev for the app in:\n  ${folder}\n\nStart it again in its folder with:\n  ${DEV_START_COMMAND}\n`);
      return 0;
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, deps.waitMs);
    });
  }
  throw new CliError(
    `driggsby dev was asked to stop but is still running for the app in:\n  ${folder}\n\n` +
      "Press Ctrl+C in the terminal where it runs, then check again:\n" +
      `  ${DEV_STOP_COMMAND}`,
    1,
  );
}

function isLive(read: DevStateRead): boolean {
  return read.status === "live";
}

async function appFolderAround(folder: string): Promise<string | null> {
  for (let current = resolvePath(folder); ; current = dirname(current)) {
    if (await hasAppConfig(current)) {
      return current;
    }
    if (dirname(current) === current) {
      return null;
    }
  }
}

async function hasAppConfig(folder: string): Promise<boolean> {
  try {
    return (await stat(join(folder, "driggsby.json"))).isFile();
  } catch {
    return false;
  }
}

function folderCount(reads: DevStateRead[]): number {
  const folders: string[] = [];
  for (const read of reads) {
    if (!folders.some((folder) => sameFolder(folder, read.state.folder))) {
      folders.push(read.state.folder);
    }
  }
  return folders.length;
}

function unconfirmed(folder: string): CliError {
  return new CliError(
    `driggsby dev is recorded for the app in:\n  ${folder}\n\n` +
      "but didn't answer, so it wasn't stopped. If it's still running, press\n" +
      `Ctrl+C in the terminal where it runs, then try again:\n  ${DEV_STOP_COMMAND}\n\n` +
      "If nothing is running there, the record is a leftover.",
    1,
  );
}

// One line per folder, the ones that did not answer marked as such.
function runningFolders(reads: DevStateRead[]): string {
  const lines = reads.map((read) => `  ${displayFolder(read.state.folder)}${read.status === "live" ? "" : " (not answering)"}`);
  return [...new Set(lines)].join("\n");
}

function nothingRunningForThisApp(reads: DevStateRead[]): string {
  return (
    "No driggsby dev is running for this app.\n\n" +
    `Previews running for other apps, each stopped from its own folder:\n${runningFolders(reads)}\n\n` +
    `Start one in this app's folder with:\n  ${DEV_START_COMMAND}\n`
  );
}

function severalRunning(reads: DevStateRead[]): CliError {
  const apps = folderCount(reads) > 1 ? "more than one app" : "one app more than once";
  const head = reads.some(isLive)
    ? `driggsby dev is running for ${apps}, in:`
    : `driggsby dev is recorded for ${apps}, and none answered:`;
  return new CliError(
    `${head}\n${runningFolders(reads)}\n\n` +
      `Nothing was stopped. Run this in the folder of the one to stop:\n  ${DEV_STOP_COMMAND}`,
    1,
  );
}

function nothingRunning(): string {
  return `No driggsby dev is running on this machine.\n\nStart one in an app's folder with:\n  ${DEV_START_COMMAND}\n`;
}
