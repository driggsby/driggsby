import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { activity, held, S0, S1, S2, S3, txn } from "../listen/test-support/fake-feed-service.ts";
import { channel } from "./test-support/channel-harness.ts";

// The saved place's clock (this computer's) runs two hours ahead of the
// fake service's stamps, so the save's time checks can't lean on the two
// agreeing. One test runs it behind instead.
const NOW = Date.parse("2026-11-11T12:00:00Z");
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

async function pluginData(): Promise<string> {
  return mkdtemp(join(tmpdir(), "driggsby-plugin-data-"));
}

const env = (data: string, project = "/work/budget") => ({ CLAUDE_PLUGIN_DATA: data, CLAUDE_PROJECT_DIR: project });
const amounts = (run: { events: { content: string }[] }): string[] =>
  run.events.flatMap((event) => [...event.content.matchAll(/\$(\d+\.\d\d)/g)].map((match) => match[1] ?? ""));

// The first session sees t1 arrive; t2 arrives while no session runs.
const BEFORE = { transactions: [held(txn("t0", S0)), held(txn("t1", S1, { amount: 11 }), 1)] };
const AFTER = { transactions: [held(txn("t0", S0)), held(txn("t1", S1, { amount: 11 })), held(txn("t2", S2, { amount: 22 }))] };

async function savedFile(data: string): Promise<string> {
  const files = await readdir(data);
  assert.equal(files.length, 1);
  return join(data, files[0] ?? "");
}

test("a restarted session gets what arrived while it was down, and nothing it already had", async () => {
  const data = await pluginData();
  const first = await channel(BEFORE, 1, { env: env(data), now: () => NOW });
  const second = await channel(AFTER, 1, { env: env(data), now: () => NOW + HOUR });

  assert.deepEqual(amounts(first), ["11.00"]);
  assert.deepEqual(amounts(second), ["22.00"]);
});

test("a late row stamped before the last one sent still arrives after a restart", async () => {
  const data = await pluginData();
  await channel({ transactions: [held(txn("t2", S2, { amount: 22 }), 1)] }, 1, { env: env(data), now: () => NOW });
  const second = await channel({ transactions: [held(txn("t2", S2, { amount: 22 })), held(txn("t1", S1, { amount: 11 }))] }, 1, {
    env: env(data),
    now: () => NOW,
  });

  assert.deepEqual(amounts(second), ["11.00"]);
});

test("a pending charge that posts while the session is down isn't sent twice", async () => {
  const data = await pluginData();
  const pending = txn("p", S1, { amount: 30, status: "pending" });
  const posted = txn("q", S1, { amount: 30, status: "posted" });
  const first = await channel({ transactions: [held(txn("t0", S0)), held(pending, 1)] }, 1, { env: env(data), now: () => NOW });
  const second = await channel({ transactions: [held(txn("t0", S0)), held(posted, 1)] }, 1, { env: env(data), now: () => NOW });

  assert.deepEqual(amounts(first), ["30.00"]);
  assert.deepEqual(second.events, []);
});

test("a stream that was empty gets what arrived while the session was down", async () => {
  const data = await pluginData();
  await channel({ investments: [] }, 5, { env: env(data), now: () => NOW });
  const second = await channel({ investments: [held(activity({ arrived_at: S3 }))] }, 5, { env: env(data), now: () => NOW });

  assert.deepEqual(second.events.map((event) => event.meta.investments), ["1"]);
});

test("closing mid-check doesn't save what was read but never sent", async () => {
  const data = await pluginData();
  const dividend = activity({ arrived_at: S2 });
  const first = await channel({ investments: [held(dividend, 5)] }, 5, { env: env(data), now: () => NOW, endDuringCheck: 5 });
  const second = await channel({ investments: [held(dividend)] }, 5, { env: env(data), now: () => NOW });

  assert.deepEqual(first.events, []);
  assert.deepEqual(second.events.map((event) => event.meta.investments), ["1"]);
});

test("without the plugin's data folder, a restart starts fresh as before", async () => {
  await channel(BEFORE, 1, { now: () => NOW });
  const second = await channel(AFTER, 1, { now: () => NOW });

  assert.deepEqual(second.events, []);
});

test("the saved place holds no names, amounts or ids, in a file only its owner can read", async () => {
  const data = await pluginData();
  await channel(BEFORE, 1, { env: env(data), now: () => NOW });

  const path = await savedFile(data);
  const body = await readFile(path, "utf8");
  assert.deepEqual(Object.keys(JSON.parse(body) as Record<string, unknown>).sort(), ["investments", "savedAt", "transactions", "version"]);
  assert.doesNotMatch(body, /Corner|Cafe|Everyday|1111|11\.0|"t1"|USD|FOOD/);
  if (process.platform !== "win32") {
    assert.equal((await stat(path)).mode & 0o777, 0o600);
  }
});

test("a place saved six days ago still resumes; eight days ago starts fresh", async () => {
  const recent = await pluginData();
  await channel(BEFORE, 1, { env: env(recent), now: () => NOW });
  const resumed = await channel(AFTER, 1, { env: env(recent), now: () => NOW + 6 * DAY });
  const stale = await pluginData();
  await channel(BEFORE, 1, { env: env(stale), now: () => NOW });
  const fresh = await channel(AFTER, 1, { env: env(stale), now: () => NOW + 8 * DAY });

  assert.deepEqual(amounts(resumed), ["22.00"]);
  assert.deepEqual(fresh.events, []);
});

test("each project folder keeps its own place", async () => {
  const data = await pluginData();
  await channel(BEFORE, 1, { env: env(data, "/work/budget"), now: () => NOW });
  const other = await channel(AFTER, 1, { env: env(data, "/work/taxes"), now: () => NOW });

  assert.deepEqual(other.events, []);
});

test("a session without the switch saves nothing", async () => {
  const data = await pluginData();
  await channel(BEFORE, 1, { switch: null, env: env(data), now: () => NOW });

  assert.deepEqual(await readdir(data), []);
});

async function tampered(edit: (saved: Record<string, unknown>) => void) {
  const data = await pluginData();
  await channel(BEFORE, 1, { env: env(data), now: () => NOW });
  const path = await savedFile(data);
  const saved = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  edit(saved);
  await writeFile(path, JSON.stringify(saved));
  return channel(AFTER, 1, { env: env(data), now: () => NOW });
}

const transactionsOf = (saved: Record<string, unknown>) => saved.transactions as Record<string, unknown>;

test("a saved place that isn't the channel's own starts fresh: a bad time, a future place, a newest past the save", async () => {
  const runs = [
    await tampered((saved) => (transactionsOf(saved).newest = "1970-01-01T00:00:00Z' OR 1=1")),
    await tampered((saved) => (saved.savedAt = "2026-11-12T12:00:00Z")),
    await tampered((saved) => (transactionsOf(saved).newest = "2026-11-13T12:00:00Z")),
    await tampered((saved) => (transactionsOf(saved).printed = [["not a digest", 1, S1]])),
    await tampered((saved) => (transactionsOf(saved).printed = [[{ toString: 1 }, 1, S1]])),
    await tampered((saved) => (saved.transactions = { newest: null, printed: [[1, 2]], ids: [] })),
  ];

  assert.deepEqual(
    runs.map((run) => run.events),
    [[], [], [], [], [], []],
  );
  assert.ok(runs.every((run) => !run.log.includes("stopped unexpectedly")));
});

test("a far-future saved newest is foreign, so the stream doesn't go quiet", async () => {
  const data = await pluginData();
  await channel(BEFORE, 1, { env: env(data), now: () => NOW });
  const path = await savedFile(data);
  const saved = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  transactionsOf(saved).newest = "2026-11-13T12:00:00Z";
  await writeFile(path, JSON.stringify(saved));
  const next = await channel({ transactions: [...AFTER.transactions, held(txn("t3", S3, { amount: 33 }), 1)] }, 1, { env: env(data), now: () => NOW });

  assert.deepEqual(amounts(next), ["33.00"]);
});

test("same-second look-alikes: after a restart the late one is sent, not the one already sent", async () => {
  const data = await pluginData();
  const x = txn("x", S1, { amount: 40, merchant_name: "Harbor Books" });
  const y = txn("y", S1, { amount: 40, merchant_name: "Lantern Cinema" });
  await channel({ transactions: [held(txn("t0", S0)), held(x, 1)] }, 1, { env: env(data), now: () => NOW });
  const second = await channel({ transactions: [held(txn("t0", S0)), held(x), held(y)] }, 1, { env: env(data), now: () => NOW });

  assert.equal(second.events.length, 1);
  assert.match(second.events[0]?.content ?? "", /Lantern Cinema/);
  assert.doesNotMatch(second.events[0]?.content ?? "", /Harbor Books/);
});

test("a session that stops before its first check still leaves its place", async () => {
  const data = await pluginData();
  await channel(BEFORE, 0, { env: env(data), now: () => NOW });
  const second = await channel(AFTER, 1, { env: env(data), now: () => NOW });

  assert.deepEqual(amounts(second), ["11.00", "22.00"]);
});

test("a stream saved empty is held to a week too, so another account's history isn't sent", async () => {
  const data = await pluginData();
  await channel({ transactions: [] }, 1, { env: env(data), now: () => NOW });
  const old = held(txn("old", "2026-11-01T10:00:00Z", { amount: 99 }));
  const second = await channel({ transactions: [old, held(txn("t2", S2, { amount: 22 }))] }, 1, { env: env(data), now: () => NOW });

  assert.deepEqual(amounts(second), ["22.00"]);
});

test("a restart nearly a week after the save still reaches back no more than a week", async () => {
  const data = await pluginData();
  await channel({ transactions: [] }, 1, { env: env(data), now: () => NOW });
  const old = held(txn("old", "2026-11-05T12:00:00Z", { amount: 99 }));
  const later = NOW + 6.9 * DAY;
  const second = await channel({ transactions: [old, held(txn("t2", S2, { amount: 22 }))] }, 1, { env: env(data), now: () => later });

  assert.deepEqual(amounts(second), ["22.00"]);
});

test("the week is exact: a row from just past it isn't sent, one just inside it is", async () => {
  const data = await pluginData();
  await channel({ transactions: [] }, 1, { env: env(data), now: () => NOW });
  const restart = NOW + HOUR;
  const at = (offset: number) => new Date(restart - 7 * DAY + offset).toISOString().replace(/\.\d{3}Z$/, "Z");
  const second = await channel(
    { transactions: [held(txn("past", at(-30 * 60 * 1000), { amount: 1 })), held(txn("inside", at(30 * 60 * 1000), { amount: 2 }))] },
    1,
    { env: env(data), now: () => restart },
  );

  assert.deepEqual(amounts(second), ["2.00"]);
});

test("a computer clock running hours behind the service still resumes", async () => {
  const data = await pluginData();
  const behind = Date.parse(S0) - 3 * HOUR;
  await channel(BEFORE, 1, { env: env(data), now: () => behind });
  const second = await channel(AFTER, 1, { env: env(data), now: () => behind + HOUR });

  assert.deepEqual(amounts(second), ["22.00"]);
});

test("a saved newest far in the past is held to the longest downtime, so older history isn't resent", async () => {
  const data = await pluginData();
  const old = held(txn("old", "2026-11-01T10:00:00Z", { amount: 99 }));
  await channel({ transactions: [old, ...BEFORE.transactions] }, 1, { env: env(data), now: () => NOW });
  const path = await savedFile(data);
  const saved = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  transactionsOf(saved).newest = "2020-01-01T00:00:00Z";
  await writeFile(path, JSON.stringify(saved));
  const run = await channel({ transactions: [old, ...AFTER.transactions] }, 1, { env: env(data), now: () => NOW });

  assert.deepEqual(amounts(run), ["22.00"]);
});
