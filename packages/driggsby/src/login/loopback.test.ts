import assert from "node:assert/strict";
import { request } from "node:http";
import { test } from "node:test";

import { type Loopback, startLoopback } from "./loopback.ts";

interface Reply {
  status: number;
  location: string | undefined;
}

// A raw request, so the Host header is whatever the test says.
function get(loopback: Loopback, path: string, host?: string): Promise<Reply> {
  const target = new URL(loopback.redirectUri);
  return new Promise((resolve, reject) => {
    const outgoing = request(
      { host: target.hostname, port: target.port, path, method: "GET", headers: host === undefined ? {} : { Host: host } },
      (response) => {
        response.resume();
        response.on("end", () => {
          resolve({ status: response.statusCode ?? 0, location: response.headers.location });
        });
      },
    );
    outgoing.on("error", reject);
    outgoing.end();
  });
}

async function listening(): Promise<Loopback> {
  const loopback = await startLoopback();
  assert.ok(loopback !== null);
  return loopback;
}

const LANDING = "https://app.driggsby.com/connect/claim-1";

test("the listener names its own loopback callback on the IP literal", async () => {
  const loopback = await listening();
  try {
    assert.match(loopback.redirectUri, /^http:\/\/127\.0\.0\.1:\d+\/callback$/);
  } finally {
    loopback.close();
  }
});

test("a code callback's browser waits until it is answered, then goes to the landing page", async () => {
  const loopback = await listening();
  try {
    const reply = get(loopback, "/callback?code=7KQ2M-9XH4T-A0B1C-DEFGH");

    const callback = await loopback.next();
    assert.ok(callback.kind === "code");
    assert.equal(callback.code, "7KQ2M-9XH4T-A0B1C-DEFGH");
    callback.answer(LANDING);

    assert.deepEqual(await reply, { status: 303, location: LANDING });
  } finally {
    loopback.close();
  }
});

test("a denial arrives as a denial, and every callback is heard in order", async () => {
  const loopback = await listening();
  try {
    const denied = get(loopback, "/callback?error=access_denied");
    const first = await loopback.next();
    const coded = get(loopback, "/callback?code=GOOD1");
    const second = await loopback.next();

    assert.equal(first.kind, "denied");
    assert.equal(second.kind, "code");
    first.answer(LANDING);
    second.answer(LANDING);
    assert.equal((await denied).status, 303);
    assert.equal((await coded).status, 303);
  } finally {
    loopback.close();
  }
});

test("stray requests are refused and never count as a callback", async () => {
  const loopback = await listening();
  try {
    const port = new URL(loopback.redirectUri).port;
    for (const [path, host] of [
      ["/", undefined],
      ["/callback", undefined],
      ["/callback?code=has%20space", undefined],
      ["/callback?error=server_error", undefined],
      ["/other?code=7KQ2M", undefined],
      ["/callback?code=7KQ2M", `rebind.example:${port}`],
      ["/callback?code=7KQ2M", "localhost"],
    ] as const) {
      assert.equal((await get(loopback, path, host)).status, 404, `${path} ${host ?? ""}`);
    }

    const reply = get(loopback, "/callback?code=GOOD1");
    const callback = await loopback.next();
    assert.ok(callback.kind === "code");
    assert.equal(callback.code, "GOOD1");
    callback.answer(LANDING);
    await reply;
  } finally {
    loopback.close();
  }
});

test("a refused callback learns nothing, not even where the approval page is", async () => {
  const loopback = await listening();
  try {
    const reply = get(loopback, "/callback?code=BOGUS");
    const callback = await loopback.next();
    callback.refuse();

    assert.deepEqual(await reply, { status: 400, location: undefined });
  } finally {
    loopback.close();
  }
});

test("closing answers any browser still waiting", async () => {
  const loopback = await listening();
  const reply = get(loopback, "/callback?code=GOOD1");
  await loopback.next();

  loopback.close();

  assert.equal((await reply).status, 200);
});
