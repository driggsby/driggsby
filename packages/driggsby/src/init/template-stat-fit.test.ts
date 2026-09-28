import assert from "node:assert/strict";
import { test } from "node:test";

import { STYLES_CSS } from "./template-styles.ts";
import { runScaffoldAppJs } from "./test-support/scaffold-harness.ts";

function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|\\n)${escaped} \\{([^}]*)\\}`).exec(STYLES_CSS)?.[1] ?? "";
}

function px(block: string, property: string): number[] {
  const value = new RegExp(`(?:^|\\s)${property}: ([^;]+);`).exec(block)?.[1] ?? "";
  return value.split(/\s+/).map((part) => Number.parseFloat(part));
}

// A stat's figure keeps 20px unless its own length won't fit its card, so
// a seven- or eight-figure balance reads as one number instead of breaking
// mid-digit, and a short one never shrinks. That needs each figure to carry
// its length, and the card to be the container its units measure.
test("each figure carries its length, and sizes by it against its own card", () => {
  const run = runScaffoldAppJs({ embedded: false, sdkLoaded: false });
  const figures = run.overview.children.map((stat) => stat.children.find((child) => child.className === "stat-value"));
  assert.equal(figures.length, 4);
  for (const figure of figures) {
    assert.ok(figure);
    assert.equal(figure.styles.get("--chars"), String(figure.textContent.length), figure.textContent);
  }
  assert.match(rule(".stat"), /container-type: inline-size;/);
  const value = rule(".stat-value");
  assert.match(value, /font-size: 20px;/);
  // The scaled size lives only behind @supports: a var() in the plain
  // rule would override 20px and then fail where cqi isn't known.
  assert.doesNotMatch(value, /cqi/, "the plain rule never mentions container units");
  assert.match(STYLES_CSS,
    /@supports \(width: 1cqi\) \{\s*\.stat-value \{\s*font-size: clamp\(12px, calc\(100cqi \/ \(var\(--chars, 1\) \* [\d.]+\)\), 20px\);\s*\}\s*\}/,
    "where container units are known, a figure never draws above 20px");
});

// Whatever size the figure draws at, its line holds the height of the
// skeleton bar it replaces, so nothing shifts when data lands.
test("a stat's figure line measures the same as its skeleton bar", () => {
  const value = rule(".stat-value");
  const bar = rule(".skeleton-value");
  const [barTop = Number.NaN, , barBottom = Number.NaN] = px(bar, "margin");
  const [barHeight = Number.NaN] = px(bar, "height");
  const [valueTop = Number.NaN] = px(value, "margin-top");
  const [lineHeight = Number.NaN] = px(value, "line-height");
  assert.equal(valueTop + lineHeight, barTop + barHeight + barBottom);
});
