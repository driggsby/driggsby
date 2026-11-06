import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { parseArgv } from "../args.ts";
import { CliError } from "../cli-error.ts";
import { SIGN_IN_AGAIN_MESSAGE } from "../deploy/api-session.ts";
import { ROOT_HELP } from "../help.ts";
import { CUES, SILENT, VOICED } from "./att-story.ts";
import { renderFrame } from "./feed-frame.ts";
import { setColor } from "./paint.ts";
import { castVote, POLL_SLUG } from "./vote.ts";

setColor(false);

const frameAt = (pt: number, cols: number, rows: number, timeline = SILENT): string[] =>
  renderFrame({ pt, nowMs: pt * 1000, cols, rows, timeline, join: "closed", paused: false, fast: false });

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
