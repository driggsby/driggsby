// driggsby dev --stop: end the `driggsby dev` running on this machine from
// any terminal, so an agent that started one in the background can put the
// ports (and the live-data preview) away without hunting for the process.
// The record in ~/.driggsby/dev.json is trusted only after the recorded
// port confirms it is served by the recorded pid (see readLiveDevState).
import { CliError } from "../cli-error.ts";
import { type DevProbes, defaultDevProbes, readLiveDevState, removeDevState } from "./dev-state.ts";
import { displayFolder } from "./display-folder.ts";

const START_COMMAND = "npx driggsby@latest dev";
// How long a signalled dev gets to close its servers before we report it.
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
  const state = await readLiveDevState(homeDirectory, deps);
  if (state === null) {
    io.out(nothingRunning());
    return 0;
  }
  const folder = displayFolder(state.folder);
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
      io.out(`✓ Stopped   driggsby dev for the app in:\n  ${folder}\n\nStart it again with:\n  ${START_COMMAND}\n`);
      return 0;
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, deps.waitMs);
    });
  }
  throw new CliError(
    `driggsby dev was asked to stop but is still running for the app in:\n  ${folder}\n\n` +
      "Press Ctrl+C in the terminal where it runs, then check again:\n" +
      `  ${START_COMMAND} --stop`,
    1,
  );
}

function nothingRunning(): string {
  return `No driggsby dev is running on this machine.\n\nStart one in an app's folder with:\n  ${START_COMMAND}\n`;
}
