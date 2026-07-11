import assert from "node:assert/strict";
import test from "node:test";

import { evaluateClosedSessionTabCompatibility } from "../dist/zen-compatibility.js";

const identity = {
  version: "1.19.3b",
  buildId: "20260315063056",
  osAbi: "Darwin_aarch64-gcc3"
};

test("runtime tab-mutation acceptance includes only the real-accepted arm64 row", () => {
  const accepted = evaluateClosedSessionTabCompatibility(
    identity,
    "zen-session-v1",
    "darwin-arm64"
  );
  assert.equal(accepted.supported, true);

  const fixtureOnlyX64 = evaluateClosedSessionTabCompatibility(
    { ...identity, osAbi: "Darwin_x86_64-gcc3" },
    "zen-session-v1",
    "darwin-x64"
  );
  assert.equal(fixtureOnlyX64.supported, false);
  assert.match(fixtureOnlyX64.reason, /No closed-session tab-mutation acceptance evidence/iu);
});
