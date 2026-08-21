import assert from "node:assert/strict";
import { test } from "node:test";

import { didYouMean, jaroSimilarity } from "./clap-suggestions.ts";

// clap_builder 4.6.0's own did_you_mean test vectors.
test("didYouMean matches clap's suggestion test vectors", () => {
  assert.equal(didYouMean("tst", ["test", "possible", "values"]), "test");
  // Tie: the later candidate wins, exactly as clap's insert-after-and-pop does.
  assert.equal(didYouMean("te", ["test", "temp", "possible", "values"]), "temp");
  assert.equal(didYouMean("hahaahahah", ["test", "possible", "values"]), undefined);
  assert.equal(
    didYouMean("alignmentScorr", ["test", "possible", "values", "alignmentStart", "alignmentScore"]),
    "alignmentScore",
  );
});

test("jaro similarity keeps 'mpc' below clap's threshold for 'mcp'", () => {
  // Length 3 means a zero search range: only position-exact matches count,
  // so the m is the sole match and the score lands at 5/9 — the reason the
  // real Rust CLI shows no tip for 'mpc'.
  assert.ok(jaroSimilarity("mpc", "mcp") < 0.7);
  assert.equal(jaroSimilarity("same", "same"), 1);
  assert.equal(jaroSimilarity("", "x"), 0);
});
