import assert from "node:assert/strict";
import { test } from "node:test";

import { hasLiveAddress, liveAddresses, liveAddressLines } from "./live-addresses.ts";

const BASE = "https://app.driggsby.com";

test("the Driggsby page prints first, then the app's own address, each sanitized and trimmed", () => {
  const addresses = liveAddresses("  https://money-dash.driggsby.dev\u001b[2K ", `${BASE}/dashboards/money-dash`, BASE);
  assert.equal(addresses.url, "https://money-dash.driggsby.dev[2K");
  assert.equal(addresses.consoleUrl, `${BASE}/dashboards/money-dash`);
  assert.ok(hasLiveAddress(addresses));
  assert.equal(
    liveAddressLines(addresses),
    `\n  ${BASE}/dashboards/money-dash\n\nThe app's own address, which shows no Driggsby data when opened directly:\n\n` +
      "  https://money-dash.driggsby.dev[2K\n",
  );
});

test("a page off the signed-in origin or made of invisible bytes is no address", () => {
  const ownOnly = liveAddresses("https://money-dash.driggsby.dev", "https://app.driggsby.com.evil.test/x", BASE);
  assert.equal(ownOnly.consoleUrl, null);
  assert.equal(liveAddressLines(ownOnly), "\n  https://money-dash.driggsby.dev\n");
  const nothing = liveAddresses("\u200b", null, BASE);
  assert.ok(!hasLiveAddress(nothing));
  assert.equal(liveAddressLines(nothing), "");
});
