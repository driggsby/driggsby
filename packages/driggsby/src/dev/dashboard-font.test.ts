import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import { loadDashboardFont } from "./dashboard-font.ts";

// The trimmed Inter 4.1 that Driggsby's serving host serves at
// /-/inter.woff2; the service pins the same digest, so the preview draws
// exactly the letters a deployed page does.
const PINNED_SHA256 = "52827645dde31ba8788d8a6100f2415298e52655783c7eff5fcb5d9200cbbbca";

test("the packaged dashboard font is the pinned Inter, the bytes Driggsby serves", async () => {
  const font = await loadDashboardFont();
  assert.equal(createHash("sha256").update(font).digest("hex"), PINNED_SHA256);
  assert.equal(font.subarray(0, 4).toString("latin1"), "wOF2");
});

test("the font ships beside its license", async () => {
  const license = await readFile(new URL("../../assets/Inter-LICENSE.txt", import.meta.url), "utf8");
  assert.ok(license.includes("Copyright (c) 2016 The Inter Project Authors"));
  assert.ok(license.includes("SIL OPEN FONT LICENSE Version 1.1"));
});
