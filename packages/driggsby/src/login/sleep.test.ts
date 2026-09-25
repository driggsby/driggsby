import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { test } from "node:test";

import { abortableSleep } from "./sleep.ts";

test("a finished sleep leaves no listener on its signal", async () => {
  const controller = new AbortController();
  for (let index = 0; index < 12; index += 1) {
    await abortableSleep(1, controller.signal);
  }

  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
});

test("an abort ends a sleep at once", async () => {
  const controller = new AbortController();
  const started = Date.now();
  const sleeping = abortableSleep(60_000, controller.signal);
  controller.abort();
  await sleeping;

  assert.ok(Date.now() - started < 1_000);
  // An already-aborted signal doesn't sleep at all.
  await abortableSleep(60_000, controller.signal);
});
