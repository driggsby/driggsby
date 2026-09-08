import assert from "node:assert/strict";
import { sep } from "node:path";
import { test } from "node:test";

import { displayFolder } from "./display-folder.ts";

test("a folder under the home prints home-relative; anything else prints as is", () => {
  const home = ["", "Users", "someone"].join(sep);
  assert.equal(displayFolder(`${home}${sep}dev${sep}money-dash`, home), `"~${sep}dev${sep}money-dash"`);
  assert.equal(displayFolder(home, home), '"~"');
  // A sibling that merely starts with the home string is not inside it.
  assert.equal(displayFolder(`${home}-old${sep}app`, home), `"${home}-old${sep}app"`);
  assert.equal(displayFolder(`${sep}srv${sep}app`, home), `"${sep}srv${sep}app"`);
  assert.equal(displayFolder(`${sep}srv${sep}app`, ""), `"${sep}srv${sep}app"`);
});

test("a recorded folder prints sanitized, quote-balanced, and capped", () => {
  const shown = displayFolder(`/srv/\u001b[31mapp"\u202e${"x".repeat(400)}`, "/Users/someone");
  assert.ok(!shown.includes("\u001b") && !shown.includes("\u202e"));
  assert.ok(shown.startsWith('"/srv/[31mapp\'') && shown.endsWith('"'));
  assert.ok(shown.length <= 205);
});
