import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { parseArgv } from "../args.ts";
import { CliError } from "../cli-error.ts";
import { SIGN_IN_AGAIN_MESSAGE } from "../deploy/api-session.ts";
import { ROOT_HELP } from "../help.ts";
import { CUES, SILENT, VOICED } from "./att-story.ts";
import { nextSpeed, renderFrame, SPEEDS } from "./feed-frame.ts";
import { setColor } from "./paint.ts";
import { castVote, POLL_SLUG } from "./vote.ts";

setColor(false);

const frameAt = (pt: number, cols: number, rows: number, timeline = SILENT): string[] =>
  renderFrame({ pt, nowMs: pt * 1000, cols, rows, timeline, paused: false, speed: 1.2 });

test("every frame fills the window exactly, at email and terminal widths", () => {
  for (const timeline of [SILENT, VOICED]) {
    for (const [cols, rows] of [[60, 24], [100, 32], [52, 20]] as const) {
      for (let pt = 0; pt <= timeline.total; pt += 0.5) {
        const lines = frameAt(pt, cols, rows, timeline);
        assert.equal(lines.length, rows, `rows at ${pt}s, ${cols}x${rows}`);
        for (const l of lines) assert.equal(Array.from(l).length, cols, `width at ${pt}s, ${cols}x${rows}: ${l}`);
      }
    }
  }
});

test("inline, the replay spans the terminal and is only as tall as what's on it", () => {
  for (const [cols, rows] of [[238, 61], [120, 40], [79, 24]] as const) {
    for (let pt = 0; pt <= SILENT.total; pt += 0.5) {
      const lines = renderFrame({ pt, nowMs: pt * 1000, cols, rows, timeline: SILENT, paused: false, speed: 1.2, fit: true });
      assert.ok(lines.length <= rows, `fits ${cols}x${rows} at ${pt}s`);
      for (const l of lines) assert.equal(Array.from(l).length, cols, `full width ${cols} at ${pt}s`);
      const bar = lines.at(-1) ?? "";
      assert.match(bar, /q quit/, `the bar ends the block at ${pt}s`);
      if (pt >= SILENT.endStart) assert.match(bar, /vote to roll this out/, `j's hint at the end, ${pt}s`);
      else assert.doesNotMatch(bar, /vote/, `no j hint while the call plays, ${pt}s`);
    }
  }
  const early = renderFrame({ pt: 3, nowMs: 3000, cols: 238, rows: 61, timeline: SILENT, paused: false, speed: 1.2, fit: true });
  assert.ok(early.length < 30, "no empty middle in a tall terminal");
});

test("j belongs to the ending, and the bar and the ending say how the vote went", () => {
  const at = (pt: number, vote: "idle" | "counting" | "counted" | "closed" | "failed"): string[] =>
    renderFrame({ pt, nowMs: pt * 1000, cols: 100, rows: 32, timeline: SILENT, paused: false, speed: 1.2, vote });
  const done = SILENT.endStart + 3;
  assert.doesNotMatch(at(5, "idle").join("\n"), /vote/);
  assert.match(at(done, "idle").at(-1) ?? "", /j {2}vote to roll this out/);
  assert.match(at(done, "counting").at(-1) ?? "", /counting your vote…/);
  assert.match(at(done, "counted").at(-1) ?? "", /✓ your vote is in/);
  assert.match(at(done, "closed").at(-1) ?? "", /voting has closed/);
  assert.match(at(done, "failed").at(-1) ?? "", /couldn’t count it .* try again/);
  const end = at(done, "counted").join("\n");
  assert.match(end, /Your vote is in\. Thanks\./);
  assert.doesNotMatch(end, /Vote to roll this out/);
});

test("the replay ends on the deal and the vote", () => {
  for (const timeline of [SILENT, VOICED]) {
    const end = frameAt(timeline.endStart + 3, 100, 32, timeline).join("\n");
    assert.match(end, /Deal closed\./);
    assert.match(end, /\$40\.00 a month, for 2 years/);
    assert.match(end, /Vote to roll this out/);
  }
  const start = frameAt(0.05, 100, 32).join("\n");
  assert.match(start, /Call AT&T/);
  assert.match(start, /\$80\.69 \/mo/);
});

test("replay att parses, quietly too, and stays out of help and suggestions", () => {
  assert.deepEqual(parseArgv(["replay", "att"]), { kind: "replay", quiet: false });
  assert.deepEqual(parseArgv(["replay", "att", "--quiet"]), { kind: "replay", quiet: true });
  for (const argv of [["replay"], ["replay", "verizon"], ["replay", "att", "--loud"]]) {
    assert.throws(() => parseArgv(argv), (error: unknown) => error instanceof CliError && error.exitCode === 2, argv.join(" "));
  }
  assert.doesNotMatch(ROOT_HELP, /replay/);
});

test("every sound the replay cues ships with the package", () => {
  assert.ok(CUES.length > 0);
  for (const cue of CUES) {
    assert.match(cue.file, /^att-\d{2}\.m4a$/);
    assert.ok(existsSync(fileURLToPath(new URL(`../../assets/replay/${cue.file}`, import.meta.url))), cue.file);
  }
});

test("a vote posts one choice to Driggsby, with the sign-in and no redirects", async () => {
  const session = { baseUrl: "https://app.driggsby.com", token: "dgb_at_test" };
  let seenUrl = "";
  let seenInit: RequestInit = {};
  const answer = (status: number) => (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    seenUrl = input instanceof Request ? input.url : input.toString();
    seenInit = init ?? {};
    return Promise.resolve(new Response(JSON.stringify({}), { status }));
  };

  assert.equal(await castVote(session, answer(200)), "voted");
  assert.equal(seenUrl, `https://app.driggsby.com/cli/polls/${POLL_SLUG}/vote`);
  assert.equal(seenInit.method, "POST");
  assert.equal(seenInit.redirect, "error");
  assert.equal(seenInit.body, JSON.stringify({ choice: "yes" }));
  assert.deepEqual(seenInit.headers, { "Content-Type": "application/json", Authorization: "Bearer dgb_at_test" });

  assert.equal(await castVote(session, answer(409)), "closed");
  await assert.rejects(castVote(session, answer(401)), (error: unknown) => error instanceof CliError && error.message === SIGN_IN_AGAIN_MESSAGE);
  await assert.rejects(castVote(session, answer(500)), (error: unknown) => error instanceof CliError && !error.message.includes("dgb_at_"));
});

test("the replay starts at 1.2x, and f switches between it and 2x, with the bar naming the other speed", () => {
  assert.equal(SPEEDS[0], 1.2);
  assert.deepEqual([nextSpeed(1.2), nextSpeed(2)], [2, 1.2]);
  const bar = (speed: number): string =>
    renderFrame({ pt: 5, nowMs: 5000, cols: 100, rows: 32, timeline: SILENT, paused: false, speed }).at(-1) ?? "";
  assert.match(bar(1.2), /f 2×/);
  assert.match(bar(2), /f 1\.2×/);
});

test("the replay never shows what the call cost to run", () => {
  for (const timeline of [SILENT, VOICED]) {
    for (let pt = 0; pt <= timeline.total; pt += 0.5) {
      const screen = renderFrame({ pt, nowMs: pt * 1000, cols: 160, rows: 48, timeline, paused: false, speed: 1.2 }).join("\n");
      assert.doesNotMatch(screen, /\bcost\b|to run|\$0\.\d\d/, `no cost at ${pt}s`);
    }
  }
});
