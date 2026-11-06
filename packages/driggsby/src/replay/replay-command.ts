// driggsby replay att: a replay of an agent's call with AT&T about an
// internet bill, in the terminal. On a Mac it plays with sound (recreated
// voices, the call's real words), paced around them; elsewhere, or with
// --quiet, it plays silently and faster. It starts at 1.2x. Space pauses, f
// switches between 1.2x and 2x, r starts over, the arrows move two
// seconds, and q quits; the voice follows each of them in place. Once the
// call has played to the end, j votes to roll the feature out: signed in, the
// vote counts in place; signed out, it signs in first, votes, and the command
// ends.
import { CliError } from "../cli-error.ts";
import { type CredentialEnvironment, defaultCredentialEnvironment, readStoredToken } from "../credentials/store.ts";
import { deployFailure, requireDeploySession } from "../deploy/api-session.ts";
import { runLogin } from "../login/login.ts";
import { CUES, type ReplayTimeline, SILENT, VOICED } from "./att-story.ts";
import { MIN_COLS, MIN_ROWS, nextSpeed, renderFrame, SPEEDS, type VoteState } from "./feed-frame.ts";
import { lineAt, startVoice, type Voice } from "./voice.ts";
import { castVote } from "./vote.ts";

const TICK_MS = 33;
const RETRY_COMMAND = "npx driggsby@latest replay att";

export interface ReplayOptions {
  quiet: boolean;
}

// How the player ended: quit, or left to sign in and vote.
type Ending = "quit" | "sign-in";

export async function runReplay(options: ReplayOptions, environment: CredentialEnvironment = defaultCredentialEnvironment()): Promise<number> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new CliError(`The replay plays in an interactive terminal. Open one and run:\n  ${RETRY_COMMAND}`, 1);
  }
  const voice = options.quiet ? null : await startVoice();
  const ending = await play(voice === null ? SILENT : VOICED, voice, environment);
  if (ending === "quit") return 0;
  // Signing in needs the terminal: the replay has ended, so sign in, vote, done.
  process.stdout.write("To count your vote, sign in to Driggsby first. It takes about a minute.\n\n");
  await runLogin(environment);
  const vote = await voteSignedIn(environment);
  if (vote === "failed") return 1;
  process.stdout.write(vote === "counted" ? "\nThanks. Your vote to roll this out is in.\n" : "\nVoting on this has closed. Thanks for watching.\n");
  return 0;
}

async function voteSignedIn(environment: CredentialEnvironment): Promise<VoteState> {
  const session = await requireDeploySession(environment);
  try {
    return (await castVote(session)) === "voted" ? "counted" : "closed";
  } catch (error) {
    // The reason stays in the terminal's own words (a sign-in to redo, a
    // network to allow); the replay itself only shows that it didn't count.
    process.stdout.write(`${deployFailure(error, session.baseUrl, RETRY_COMMAND).message}\n`);
    return "failed";
  }
}

function play(timeline: ReplayTimeline, voice: Voice | null, environment: CredentialEnvironment): Promise<Ending> {
  const stdin = process.stdin;
  const stdout = process.stdout;

  let pt = 0;
  let paused = false;
  let speed: number = SPEEDS[0];
  let vote: VoteState = "idle";
  let last = Date.now();
  // A full-screen app: the whole terminal, the header at the top and the
  // progress bar and keys anchored to the bottom.
  const draw = (): void => {
    const cols = Math.max(MIN_COLS, stdout.columns - 1);
    const rows = Math.max(MIN_ROWS, stdout.rows);
    const frame = renderFrame({ pt, nowMs: Date.now(), cols, rows, timeline, vote, paused, speed });
    stdout.write(`\u001b[H${frame.join("\r\n")}`);
  };
  // A jump picks up whatever line is being said at the new moment, mid-word.
  const seek = (to: number): void => {
    pt = Math.max(0, Math.min(timeline.total, to));
    if (voice === null) return;
    const line = lineAt(CUES, pt);
    if (line === null) voice.stop();
    else voice.play(line.file, line.offset, speed, paused);
  };

  return new Promise<Ending>((resolve) => {
    stdout.write("\u001b[?1049h\u001b[?25l\u001b[2J");
    stdin.setRawMode(true);
    stdin.resume();
    let done = false;
    const finish = (ending: Ending): void => {
      if (done) return;
      done = true;
      clearInterval(timer);
      voice?.close();
      stdin.off("data", onKey);
      stdin.setRawMode(false);
      stdin.pause();
      stdout.off("resize", onResize);
      stdout.write("\u001b[?25h\u001b[?1049l");
      resolve(ending);
    };
    // j, signed in: the vote counts in place and the bar shows how it went.
    const castInPlace = async (): Promise<void> => {
      if ((await readStoredToken(environment)) === null) {
        finish("sign-in");
        return;
      }
      vote = "counting";
      try {
        const session = await requireDeploySession(environment);
        vote = (await castVote(session)) === "voted" ? "counted" : "closed";
      } catch {
        vote = "failed";
      }
      if (!done) draw();
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
      if (key === "j") {
        // Only once the call has played to the end.
        if (pt >= timeline.endStart && (vote === "idle" || vote === "failed")) void castInPlace();
      } else if (key === " ") {
        paused = !paused;
        if (paused) voice?.pause();
        else voice?.resume();
      } else if (key === "f") {
        speed = nextSpeed(speed);
        voice?.rate(speed);
      } else if (key === "r") {
        paused = false;
        seek(0);
      } else if (key === "\u001b[C") seek(pt + 2);
      else if (key === "\u001b[D") seek(pt - 2);
      draw();
    };
    const timer = setInterval(() => {
      const now = Date.now();
      const dt = (now - last) / 1000;
      last = now;
      if (!paused && pt < timeline.total) {
        const next = Math.min(timeline.total, pt + dt * speed);
        if (voice !== null) for (const cue of CUES) if (cue.at > pt && cue.at <= next) voice.play(cue.file, 0, speed, false);
        pt = next;
      }
      draw();
    }, TICK_MS);
    stdin.on("data", onKey);
    stdout.on("resize", onResize);
    draw();
  });
}
