import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { canonicalJson, sha256Canonical } from "../dist/domain/digest.js";

test("streamed canonical digest exactly matches canonical JSON bytes", () => {
  const value = {
    z: [true, null, "browser \"data\"", { omitted: undefined, n: -0 }],
    a: { unicode: "é", number: 1.25 }
  };
  const encoded = canonicalJson(value);
  const expected = `sha256:${createHash("sha256").update(encoded, "utf8").digest("hex")}`;

  assert.equal(encoded, '{"a":{"number":1.25,"unicode":"é"},"z":[true,null,"browser \\"data\\"",{"n":0}]}');
  assert.equal(sha256Canonical(value), expected);
});

test("canonical digest rejects unsupported and non-finite values", () => {
  assert.throws(() => sha256Canonical({ value: Number.NaN }), /non-finite/);
  assert.throws(() => sha256Canonical({ value: 1n }), /bigint/);
});
