// driggsby replay att: a replay of an agent's call with AT&T about an
// internet bill, in the terminal. On a Mac it plays with sound (recreated
// voices, the call's real words), paced around them; elsewhere, or with
// --quiet, it plays silently and faster. Space pauses, f plays at 2x, r
// starts over, the arrows move two seconds, q quits, and j votes to roll the
// feature out, signing in first if this machine isn't signed in.
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { CliError } from "../cli-error.ts";
import { type CredentialEnvironment, defaultCredentialEnvironment, readStoredToken } from "../credentials/store.ts";
import { deployFailure, requireDeploySession } from "../deploy/api-session.ts";
import { runLogin } from "../login/login.ts";
import { CUES, type ReplayTimeline, SILENT, VOICED } from "./att-story.ts";
import { MIN_COLS, MIN_ROWS, renderFrame } from "./feed-frame.ts";
import { castVote } from "./vote.ts";

const PLAYER = "/usr/bin/afplay";
const TICK_MS = 33;
const RETRY_COMMAND = "npx driggsby@latest replay att";

export interface ReplayOptions {
  quiet: boolean;
}

type Ending = "quit" | "vote";

export async function runReplay(options: ReplayOptions, environment: CredentialEnvironment = defaultCredentialEnvironment()): Promise<number> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new CliError(`The replay plays in an interactive terminal. Open one and run:\n  ${RETRY_COMMAND}`, 1);
  }
  const sound = !options.quiet && process.platform === "darwin" && existsSync(PLAYER);
  const ending = await play(sound ? VOICED : SILENT, sound);
  if (ending === "quit") return 0;
  return await vote(environment);
}

function play(timeline: ReplayTimeline, sound: boolean): Promise<Ending> {
  const stdin = process.stdin;
  const stdout = process.stdout;
  const playing = new Set<ChildProcess>();
  const hush = (): void => {
    for (const child of playing) child.kill();
    playing.clear();
  };
  const playCue = (file: string, fast: boolean): void => {
    const path = fileURLToPath(new URL(`../../assets/replay/${file}`, import.meta.url));
    const child = spawn(PLAYER, fast ? ["-r", "2", path] : [path], { stdio: "ignore" });
    child.on("error", () => playing.delete(child));
    child.on("exit", () => playing.delete(child));
    playing.add(child);
  };

  let pt = 0;
  let paused = false;
  let fast = false;
  let last = Date.now();
  // A full-screen app: the whole terminal, the header at the top and the
  // progress bar and keys anchored to the bottom.
  const draw = (): void => {
    const cols = Math.max(MIN_COLS, stdout.columns - 1);
    const rows = Math.max(MIN_ROWS, stdout.rows);
    const frame = renderFrame({ pt, nowMs: Date.now(), cols, rows, timeline, join: "closed", paused, fast });
    stdout.write(`\u001b[H${frame.join("\r\n")}`);
  };
  const seek = (to: number): void => {
    hush();
    pt = Math.max(0, Math.min(timeline.total, to));
  };

  return new Promise<Ending>((resolve) => {
    stdout.write("\u001b[?1049h\u001b[?25l\u001b[2J");
    stdin.setRawMode(true);
    stdin.resume();
    const finish = (ending: Ending): void => {
      clearInterval(timer);
      hush();
      stdin.off("data", onKey);
      stdin.setRawMode(false);
      stdin.pause();
      stdout.off("resize", onResize);
      stdout.write("\u001b[?25h\u001b[?1049l");
      resolve(ending);
    };
    const onResize = (): void => {
      stdout.write("\u001b[2J");
      draw();
    };
    const onKey = (data: Buffer): void => {
      const key = data.toString("utf8");
      if (key === "\u0003" || key === "q") {
        finish("quit");
        return;
      }
      // j votes right away: no prompt to confirm.
      if (key === "j") {
        finish("vote");
        return;
      }
      if (key === " ") {
        hush();
        paused = !paused;
      } else if (key === "f") {
        hush();
        fast = !fast;
      } else if (key === "r") {
        seek(0);
        paused = false;
      } else if (key === "\u001b[C") seek(pt + 2);
      else if (key === "\u001b[D") seek(pt - 2);
      draw();
    };
    const timer = setInterval(() => {
      const now = Date.now();
      const dt = (now - last) / 1000;
      last = now;
      if (!paused && pt < timeline.total) {
        const next = Math.min(timeline.total, pt + dt * (fast ? 2 : 1));
        if (sound) for (const cue of CUES) if (cue.at > pt && cue.at <= next) playCue(cue.file, fast);
        pt = next;
      }
      draw();
    }, TICK_MS);
    stdin.on("data", onKey);
    stdout.on("resize", onResize);
    draw();
  });
}

async function vote(environment: CredentialEnvironment): Promise<number> {
  const out = (text: string): void => {
    process.stdout.write(text);
  };
  if ((await readStoredToken(environment)) === null) {
    out("To count your vote, sign in to Driggsby first. It takes about a minute.\n\n");
    await runLogin(environment);
    out("\n");
  }
  const session = await requireDeploySession(environment);
  try {
    const outcome = await castVote(session);
    out(outcome === "voted" ? "Thanks. Your vote to roll this out is in.\n" : "Voting on this has closed. Thanks for watching.\n");
    return 0;
  } catch (error) {
    throw deployFailure(error, session.baseUrl, RETRY_COMMAND);
  }
}
