// driggsby dev --stop: end the `driggsby dev` running on this machine from
// any terminal, so an agent that started one in the background can put the
// ports (and the live-data preview) away without hunting for the process.
import { CliError } from "../cli-error.ts";
import { quotedForTerminal } from "../terminal-text.ts";
import { processIsAlive, readLiveDevState, removeDevState } from "./dev-state.ts";

const START_COMMAND = "npx driggsby@latest dev";
const MAX_FOLDER_CHARS = 200;
// How long a signalled dev gets to close its servers before we report it.
const STOP_ATTEMPTS = 20;

export interface DevStopIo {
  out: (text: string) => void;
}

export interface DevStopDeps {
  isAlive: (pid: number) => boolean;
  terminate: (pid: number) => void;
  waitMs: number;
}

function defaultDevStopDeps(): DevStopDeps {
  return {
    isAlive: processIsAlive,
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
  const state = await readLiveDevState(homeDirectory, deps.isAlive);
  if (state === null) {
    io.out(`No driggsby dev is running on this machine.\n\nStart one in an app's folder with:\n  ${START_COMMAND}\n`);
    return 0;
  }
  const folder = quotedForTerminal(state.folder, MAX_FOLDER_CHARS);
  deps.terminate(state.pid);
  for (let attempt = 0; attempt < STOP_ATTEMPTS; attempt += 1) {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, deps.waitMs);
    });
    if (!deps.isAlive(state.pid)) {
      await removeDevState(homeDirectory, state.pid);
      io.out(`✓ Stopped   driggsby dev for the app in:\n  ${folder}\n\nStart it again with:\n  ${START_COMMAND}\n`);
      return 0;
    }
  }
  throw new CliError(
    `driggsby dev was asked to stop but is still running for the app in:\n  ${folder}\n\n` +
      "Press Ctrl+C in the terminal where it runs, then check again:\n" +
      `  ${START_COMMAND} --stop`,
    1,
  );
}
