// driggsby dev --stop: end the `driggsby dev` running on this machine from
// any terminal, so an agent that started one in the background can put the
// ports (and the live-data preview) away without hunting for the process.
// The record in ~/.driggsby/dev.json is trusted only after the recorded
// port confirms it is served by the recorded pid (see readDevState).
import { CliError } from "../cli-error.ts";
import { DEV_START_COMMAND, DEV_STOP_COMMAND } from "./dev-commands.ts";
import { type DevProbes, defaultDevProbes, readDevState, removeDevState } from "./dev-state.ts";
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
): Promise<number> {
  const read = await readDevState(homeDirectory, deps);
  if (read.status === "none") {
    io.out(nothingRunning());
    return 0;
  }
  const state = read.state;
  const folder = displayFolder(state.folder);
  if (read.status === "unconfirmed") {
    // The pid is alive but the port did not answer as that dev: it may be
    // busy, or the pid may have been recycled. Never signal a process the
    // port has not vouched for, and never claim nothing is running.
    throw new CliError(
      `driggsby dev is recorded for the app in:\n  ${folder}\n\n` +
        "but didn't answer, so it wasn't stopped. If it's still running, press\n" +
        `Ctrl+C in the terminal where it runs, then try again:\n  ${DEV_STOP_COMMAND}\n\n` +
        `If nothing is running there, the next driggsby dev replaces this record.`,
      1,
    );
  }
  try {
    deps.terminate(state.pid);
  } catch (error) {
    // Gone between the check and the signal, or a pid that is not ours to
    // signal (another user's process): either way there is no dev to stop.
    // Any other failure leaves the record, since the dev may well be running.
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH" || code === "EPERM") {
      await removeDevState(homeDirectory, state.pid);
      io.out(nothingRunning());
      return 0;
    }
    throw error;
  }
  for (let attempt = 0; attempt < STOP_ATTEMPTS; attempt += 1) {
    if (!deps.isAlive(state.pid)) {
      await removeDevState(homeDirectory, state.pid);
      io.out(`✓ Stopped   driggsby dev for the app in:\n  ${folder}\n\nStart it again with:\n  ${DEV_START_COMMAND}\n`);
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

function nothingRunning(): string {
  return `No driggsby dev is running on this machine.\n\nStart one in an app's folder with:\n  ${DEV_START_COMMAND}\n`;
}
