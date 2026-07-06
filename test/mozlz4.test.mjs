import assert from "node:assert/strict";
import test from "node:test";
import { Buffer } from "node:buffer";
import {
  DEFAULT_MAX_DECOMPRESSED_BYTES,
  decodeJsonLz4Buffer,
  encodeLiteralJsonLz4ForFixture
} from "../dist/mozlz4.js";

test("decodes synthetic Mozilla JSONLZ4 buffers", () => {
  const value = { spaces: [{ uuid: "w1", name: "Inbox" }], tabs: [] };
  const encoded = encodeLiteralJsonLz4ForFixture(value);

  assert.equal(encoded.subarray(0, 8).toString("binary"), "mozLz40\u0000");
  assert.deepEqual(decodeJsonLz4Buffer(encoded), value);
});

test("rejects invalid JSONLZ4 magic", () => {
  assert.throws(
    () => decodeJsonLz4Buffer(Buffer.from("not-jsonlz4")),
    /too short|invalid mozLz40/
  );
});

test("rejects decompressed length mismatches", () => {
  const encoded = encodeLiteralJsonLz4ForFixture({ ok: true });
  encoded.writeUInt32LE(999, 8);

  assert.throws(() => decodeJsonLz4Buffer(encoded), /decompressed length mismatch/);
});

test("rejects advertised decompressed sizes above the safety cap before allocation", () => {
  const encoded = encodeLiteralJsonLz4ForFixture({ ok: true });
  encoded.writeUInt32LE(DEFAULT_MAX_DECOMPRESSED_BYTES + 1, 8);

  assert.throws(() => decodeJsonLz4Buffer(encoded), /exceeds safety cap/);
});
