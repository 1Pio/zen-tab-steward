import assert from "node:assert/strict";
import test from "node:test";
import { Buffer } from "node:buffer";
import { link, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_MAX_DECOMPRESSED_BYTES,
  decodeJsonLz4Buffer,
  encodeLiteralJsonLz4ForFixture,
  readJsonLz4,
  readJsonLz4State,
  writeJsonLz4Durable,
  writeJsonLz4
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

test("writes JSONLZ4 files that round-trip through the decoder", async () => {
  const temp = await mkdtemp(join(tmpdir(), "zts-jsonlz4-"));
  const path = join(temp, "zen-sessions.jsonlz4");
  const value = {
    spaces: [{ uuid: "w1", name: "Space" }],
    tabs: [{ zenWorkspace: "w1", entries: [{ url: "https://example.com", title: "Example" }] }],
    unknown: { preserved: true }
  };

  await writeJsonLz4(path, value);

  assert.deepEqual(await readJsonLz4(path), value);
});

test("rejects hardlinked JSONLZ4 sources before decoding", async () => {
  const temp = await mkdtemp(join(tmpdir(), "zts-jsonlz4-"));
  const path = join(temp, "zen-sessions.jsonlz4");
  const hardlinkPath = join(temp, "hardlink.jsonlz4");
  await writeJsonLz4(path, { ok: true });
  await link(path, hardlinkPath);

  await assert.rejects(() => readJsonLz4State(path), /unexpected hardlink count/);

  await rm(hardlinkPath);
  assert.deepEqual(await readJsonLz4(path), { ok: true });
});

test("durable JSONLZ4 write removes temp files when pre-commit validation fails", async () => {
  const temp = await mkdtemp(join(tmpdir(), "zts-jsonlz4-"));
  const path = join(temp, "zen-sessions.jsonlz4");
  const original = { version: 1 };
  await writeJsonLz4(path, original);
  const before = await readFile(path);
  const beforeMode = (await stat(path)).mode & 0o777;

  await assert.rejects(
    () => writeJsonLz4Durable(path, { version: 2 }, { beforeCommit: async () => { throw new Error("preflight failed"); } }),
    /preflight failed/
  );

  assert.deepEqual(await readFile(path), before);
  assert.equal((await stat(path)).mode & 0o777, beforeMode);
  assert.deepEqual(await readJsonLz4(path), original);
});
