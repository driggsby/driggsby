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

test("the listener names its own loopback callback on the IP literal", async () => {
  const loopback = await listening();
  try {
    assert.match(loopback.redirectUri, /^http:\/\/127\.0\.0\.1:\d+\/callback$/);
  } finally {
    loopback.close();
  }
});

test("a code callback is held until the sign-in finishes, then sent to the landing page", async () => {
  const loopback = await listening();
  const reply = get(loopback, "/callback?code=7KQ2M-9XH4T-A0B1C-DEFGH");

  assert.deepEqual(await loopback.callback, { kind: "code", code: "7KQ2M-9XH4T-A0B1C-DEFGH" });
  loopback.finish("https://app.driggsby.com/connect/claim-1");

  assert.deepEqual(await reply, { status: 303, location: "https://app.driggsby.com/connect/claim-1" });
});

test("Driggsby's denial arrives as a denial", async () => {
  const loopback = await listening();
  const reply = get(loopback, "/callback?error=access_denied");

  assert.deepEqual(await loopback.callback, { kind: "denied" });
  loopback.finish("https://app.driggsby.com/connect/claim-1");
  assert.equal((await reply).status, 303);
});

test("stray requests are refused and never count as the callback", async () => {
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
    assert.deepEqual(await loopback.callback, { kind: "code", code: "GOOD1" });
    // After the one callback, nothing else is accepted.
    assert.equal((await get(loopback, "/callback?code=LATER")).status, 404);
    loopback.finish("https://app.driggsby.com/connect/claim-1");
    await reply;
  } finally {
    loopback.close();
  }
});
