// One frame of the AT&T replay as terminal lines: the steps as a list
// (finished ones collapse to a check and their real time, the one under way
// opens up with what's being said), and a slim bar at the bottom with
// progress and the bill. A pure function of the replay second, so tests can
// render any moment.
import { CALL, LINES, OFFER_AT, type ReplayCheck, type ReplayStep, type ReplayTimeline, STEPS } from "./att-story.ts";
import { type Line, type Seg, line, padTo, seg, width } from "./paint.ts";
import { toPlay, toReal } from "./timeline.ts";

// Where the person's vote stands: not cast, being counted, counted, closed
// (the poll ended), or failed (j tries again).
export type VoteState = "idle" | "counting" | "counted" | "closed" | "failed";

export interface FrameInput {
  pt: number;
  nowMs: number;
  cols: number;
  rows: number;
  timeline: ReplayTimeline;
  vote?: VoteState;
  paused: boolean;
  // How fast it plays: one of SPEEDS.
  speed: number;
  // Inline (the terminal): only as tall as what's on it, at most `rows`, so
  // the bar sits right under the steps. Otherwise exactly `rows` tall (the
  // GIF's fixed window).
  fit?: boolean;
}

// The replay starts at 1.5x; f steps to 2x, then 1x, then back to 1.5x.
export const SPEEDS = [1.5, 2, 1] as const;

export function nextSpeed(speed: number): number {
  const at = SPEEDS.findIndex((s) => s === speed);
  return SPEEDS[(at + 1) % SPEEDS.length] ?? SPEEDS[0];
}

const C = {
  text: "#EDEDED", soft: "#C9CDD3", mute: "#8B9099", faint: "#5A5F68", ghost: "#30343B", agent: "#7DB4FF",
  music: "#A99BFB", money: "#4ADE80", live: "#F87171", liveDim: "#7A2E2E", keys: "#F5C451", ink: "#0B0C0E",
};
const SPIN = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏";
export const MIN_COLS = 52;
export const MIN_ROWS = 20;

const money = (n: number): string => `$${n.toFixed(2)}`;
const mmss = (sec: number): string => {
  const s = Math.max(0, Math.floor(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};
const clock = (sec: number): string => {
  const s = Math.max(0, Math.floor(sec));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
};
const ease = (x: number): number => 1 - Math.pow(1 - Math.min(1, Math.max(0, x)), 3);

export function wrapWords(text: string, max: number): string[] {
  const out: string[] = [];
  let current = "";
  for (const word of text.split(" ")) {
    if (current === "") current = word;
    else if (current.length + 1 + word.length <= max) current += ` ${word}`;
    else {
      out.push(current);
      current = word;
    }
  }
  if (current !== "") out.push(current);
  return out;
}

// A left part and a right part on one line, the gap between them filled.
function spread(left: Seg[], right: Seg[], w: number): Line {
  const gap = Math.max(1, w - width(left) - width(right));
  return line(...left, seg(" ".repeat(gap)), ...right);
}

export function renderFrame(input: FrameInput): string[] {
  const cols = Math.max(MIN_COLS, input.cols);
  const rows = Math.max(MIN_ROWS, input.rows);
  const { timeline } = input;
  const ended = input.pt >= timeline.endStart;
  const real = ended ? CALL.ends : toReal(timeline.keys, input.pt);
  const w = cols - 4;
  const narrow = w < 76;
  const pulse = Math.sin(input.nowMs / 260) > -0.2;

  const head = spread(
    [seg("driggsby", C.text, { bold: true }), seg(narrow ? "   " : "   calls / ", C.faint), seg(`${CALL.company} ${narrow ? "internet" : CALL.product}`, C.soft)],
    [seg("● ", ended ? C.money : pulse ? C.live : C.liveDim), seg(ended ? "ended  " : "live  ", ended ? C.money : C.mute), seg(clock(real), C.text, { bold: true })],
    w,
  );

  const stepRow = (title: string, time: string, icon: Seg, titleColor: string, timeColor: string, bold: boolean): Line =>
    line(icon, seg("  "), seg(padTo(title, w - 3 - time.length), titleColor, { bold }), seg(time, timeColor));
  const doneCount = STEPS.filter((s) => ended || real >= s.to).length;
  // The feed with the `open` most recent finished steps still showing what
  // was said in them (dimmed), and the earlier ones as one line each.
  const build = (open: number): { feed: Line[]; doneAt: number[] } => {
    const feed: Line[] = [];
    const doneAt: number[] = [];
    STEPS.forEach((step, i) => {
      const done = ended || real >= step.to;
      const active = !done && real >= step.from;
      if (done && i >= doneCount - open) {
        feed.push(stepRow(step.title, mmss(step.to - step.from), seg("✓", C.money), C.soft, C.faint, false));
        feed.push(...activeStep(step, real, input.pt, w, narrow, timeline, true));
        feed.push(line());
      } else if (done) {
        doneAt.push(feed.length);
        feed.push(stepRow(step.title, mmss(step.to - step.from), seg("✓", C.money), C.soft, C.faint, false));
      } else if (!active) {
        feed.push(stepRow(step.title, "", seg("·", C.ghost), C.faint, C.faint, false));
      } else {
        const spinner = SPIN[Math.floor(input.nowMs / 80) % SPIN.length] ?? "·";
        if (feed.at(-1)?.segs.length !== 0) feed.push(line());
        feed.push(stepRow(step.title, mmss(real - step.from), seg(spinner, C.agent), C.text, C.agent, true));
        feed.push(...activeStep(step, real, input.pt, w, narrow, timeline, false));
        feed.push(line());
      }
    });
    if (ended) feed.push(...result(input.pt - timeline.endStart, w, narrow, input.vote ?? "idle"));
    return { feed, doneAt };
  };

  const room = rows - 6;
  let open = doneCount;
  let built = build(open);
  while (built.feed.length > room && open > 0) built = build(--open);
  const { feed, doneAt } = built;
  const shown = fold(feed, doneAt, room, w).slice(-room);
  while (input.fit !== true && shown.length < room) shown.push(line());
  if (shown.at(-1)?.segs.length === 0 && input.fit === true) shown.pop();

  const frame: Line[] = [
    head, line(), ...shown, line(),
    bottomBar(real, input.pt, ended, w, narrow, timeline), line(seg("─".repeat(w), C.ghost)), help(input, w, narrow),
  ];
  return frame.map((l) => line(seg("  "), ...l.segs).render(cols));
}

// What happened in a step: its note, the keys pressed, the lines said (the
// last one typing out while the step is under way), the hold bar, the terms
// checked. Dimmed throughout once the step is finished.
function activeStep(step: ReplayStep, real: number, pt: number, w: number, narrow: boolean, timeline: ReplayTimeline, finished: boolean): Line[] {
  const out: Line[] = [];
  const guide = (): Seg => seg("  │ ", C.ghost);
  const inner = w - 4;
  if (step.id !== "hold" && step.detail !== "") out.push(line(guide(), seg(step.detail.slice(0, inner), C.faint)));
  const keys = LINES.find((l) => l.who === "keys" && l.at >= step.from && l.at < step.to && real >= l.at);
  if (keys !== undefined) out.push(line(guide(), seg(padTo("keys", 7), C.faint), seg(keys.text, C.keys)));
  const said = LINES.filter((l) => l.at >= step.from && l.at < step.to && real >= l.at && l.who !== "keys");
  said.forEach((l, k) => {
    const last = !finished && k === said.length - 1;
    const typing = timeline.speak.get(l.at) ?? Math.max(0.3, l.text.length / 80);
    const typed = last ? Math.min(1, (pt - toPlay(timeline.keys, l.at)) / typing) : 1;
    const text = l.text.slice(0, Math.max(1, Math.round(l.text.length * typed)));
    const who = l.who === "agent" ? "agent" : "AT&T";
    wrapWords(text, inner - 7).forEach((part, j) => {
      out.push(line(guide(), seg(padTo(j === 0 ? who : "", 7), l.who === "agent" ? C.agent : C.mute), seg(part, last ? C.text : C.faint)));
    });
  });
  if (step.id === "hold") {
    const f = Math.min(1, (real - step.from) / (step.to - step.from));
    const bw = Math.min(inner - 12, 48);
    const n = Math.round(bw * f);
    out.push(line(guide(), seg("♪  ", finished ? C.faint : C.music), seg("━".repeat(n), finished ? C.ghost : C.music), seg("━".repeat(bw - n), C.ghost), seg(`  of ${mmss(step.to - step.from)}`, C.faint)));
    out.push(line(guide(), seg("hold music. the agent waits so you don’t.", C.faint)));
  }
  if (step.checks !== undefined) out.push(...checkRows(step.checks, real, inner, narrow, guide));
  return out;
}

function checkRows(checks: readonly ReplayCheck[], real: number, inner: number, narrow: boolean, guide: () => Seg): Line[] {
  const check = (c: ReplayCheck, cw: number): Seg[] => {
    const got = real >= c.at;
    return [seg(got ? "✓ " : "○ ", got ? C.money : C.ghost), seg(padTo(c.label, cw - 2), got ? C.soft : C.faint)];
  };
  if (!narrow) return [line(guide(), ...checks.flatMap((c) => [...check(c, c.label.length + 2), seg("  ")]))];
  const out: Line[] = [];
  const cw = Math.floor(inner / 2);
  for (let r = 0; r < checks.length; r += 2) out.push(line(guide(), ...checks.slice(r, r + 2).flatMap((c) => check(c, cw))));
  return out;
}

function result(t: number, w: number, narrow: boolean, vote: VoteState): Line[] {
  const after = CALL.before + (CALL.after - CALL.before) * ease(t / 0.9);
  const saved = `${money((CALL.before - CALL.after) * CALL.months)} saved`;
  const at = (n: number): boolean => t >= 0.15 * n;
  const out: Line[] = [line(), line(seg("─".repeat(w), C.ghost)), line()];
  const price = [seg(money(CALL.before), C.faint, { strike: true }), seg("  →  ", C.mute), seg(money(after), C.money, { bold: true }), seg(" a month, for 2 years", C.mute)];
  if (narrow) out.push(line(seg("Deal closed.", C.text, { bold: true })), line(...price));
  else out.push(line(seg("Deal closed.  ", C.text, { bold: true }), ...price));
  const terms = narrow ? "  ·  no contract  ·  no fee to leave" : "  ·  same speed  ·  no contract  ·  no fee to leave";
  if (at(1)) out.push(line(seg(saved, C.money), seg(terms, C.mute)));
  if (at(2)) out.push(line(seg(`${mmss(CALL.ends)} on the phone  ·  $${CALL.costUsd.toFixed(2)} to run`, C.mute)));
  if (at(2)) out.push(line(seg("Verizon, same week:  ", C.mute), seg("$95.71", C.faint, { strike: true }), seg(" → ", C.mute), seg("$74.01", C.money)));
  if (at(3)) out.push(line(), vote === "counted"
    ? line(seg("✓", C.money, { bold: true }), seg("  Your vote is in. Thanks.", C.text, { bold: true }))
    : line(seg(" j ", C.ink, { bg: C.money, bold: true }), seg("  Vote to roll this out", C.text, { bold: true })));
  return out;
}

// Too tall for the window: fold the earliest finished steps into one line
// before anything scrolls away.
function fold(feed: Line[], doneAt: number[], room: number, w: number): Line[] {
  if (feed.length <= room || doneAt.length <= 2) return feed;
  const count = Math.min(doneAt.length - 1, feed.length - room + 1);
  const folded = new Set(doneAt.slice(0, count));
  const time = mmss(STEPS.slice(0, count).reduce((sum, s) => sum + (s.to - s.from), 0));
  const summary = line(seg("✓", C.money), seg("  "), seg(padTo(`${count} steps done`, w - 3 - time.length), C.soft), seg(time, C.faint));
  return [summary, ...feed.filter((_, i) => !folded.has(i))];
}

function bottomBar(real: number, pt: number, ended: boolean, w: number, narrow: boolean, timeline: ReplayTimeline): Line {
  const offered = real >= OFFER_AT;
  const k = ease((pt - toPlay(timeline.keys, OFFER_AT)) / 1.4);
  const price = offered ? CALL.before + (CALL.after - CALL.before) * k : CALL.before;
  const doneCount = STEPS.filter((s) => ended || real >= s.to).length;
  const left = [seg("▰".repeat(doneCount), C.agent), seg("▰".repeat(STEPS.length - doneCount), C.ghost), seg(`  ${doneCount} of ${STEPS.length}`, C.mute)];
  const right: Seg[] = offered
    ? [seg(money(CALL.before), C.faint, { strike: true }), seg(" → ", C.mute), seg(money(price), C.money, { bold: true })]
    : [seg(money(CALL.before), C.text, { bold: true })];
  right.push(seg(" /mo", C.mute));
  if (!narrow) right.push(seg("   │   ", C.ghost), seg("cost ", C.mute), seg(`$${(CALL.costUsd * Math.min(1, real / CALL.ends)).toFixed(2)}`, C.text));
  return spread(left, right, w);
}

function help(input: FrameInput, w: number, narrow: boolean): Line {
  const keys: [string, string][] = narrow
    ? [["space", input.paused ? "play" : "pause"], ["q", "quit"]]
    : [["space", input.paused ? "play" : "pause"], ["f", `${String(nextSpeed(input.speed))}×`], ["r", "replay"], ["q", "quit"]];
  const left = keys.flatMap(([key, what], i) => [seg((i > 0 ? (narrow ? "  " : "  ·  ") : "") + key, C.mute), seg(` ${what}`, C.faint)]);
  // j belongs to the ending: nothing about it shows while the call plays.
  if (input.pt < input.timeline.endStart) return line(...left);
  // Once pressed, this spot says how the vote went.
  const state = input.vote ?? "idle";
  const vote: Seg[] = state === "counting" ? [seg("counting your vote…", C.mute)]
    : state === "counted" ? [seg("✓ ", C.money, { bold: true }), seg("your vote is in", C.money)]
      : state === "closed" ? [seg("voting has closed", C.faint)]
        : state === "failed" ? [seg("couldn’t count it · ", C.faint), seg(" j ", C.ink, { bg: C.money, bold: true }), seg(" try again", C.money)]
          : [seg(" j ", C.ink, { bg: C.money, bold: true }), seg(" vote to roll this out", C.money)];
  return spread(left, vote, w);
}
