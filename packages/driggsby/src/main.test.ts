import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  CAN_SET_THE_LIST,
  distrustedRootsLeftAfter,
  ROOTS_LEFT_AFTER_A_BIN,
} from "../../deploy/src/test-support/distrusted-roots-probe.ts";

const BIN = fileURLToPath(new URL("../bin/driggsby.js", import.meta.url));

test(
  "driggsby removes the compromised eMudhra roots before it runs any command, where it should",
  { skip: !CAN_SET_THE_LIST },
  () => {
    // The control: a script that doesn't remove them keeps both.
    const control = distrustedRootsLeftAfter(["-e", "0"]);
    assert.equal(control.left, 2, control.stderr);
    const driggsby = distrustedRootsLeftAfter([BIN, "--version"]);
    assert.equal(driggsby.left, ROOTS_LEFT_AFTER_A_BIN, driggsby.stderr);
  },
);
