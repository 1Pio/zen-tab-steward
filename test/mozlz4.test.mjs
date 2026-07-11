import assert from "node:assert/strict";
import test from "node:test";
import { Buffer } from "node:buffer";
import { link, mkdtemp, readFile, readdir, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_MAX_COMPRESSED_BYTES,
  DEFAULT_MAX_DECOMPRESSED_BYTES,
  decodeJsonLz4Buffer,
  encodeJsonLz4Buffer,
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

test("callers cannot raise the absolute compressed input cap", async () => {
  const oversized = Buffer.alloc(DEFAULT_MAX_COMPRESSED_BYTES + 1);
  Buffer.from("mozLz40\0", "binary").copy(oversized, 0);
  assert.throws(() => decodeJsonLz4Buffer(oversized), /compressed size .* exceeds safety cap/);

  await assert.rejects(
    () => readJsonLz4State("/path/is-not-opened.jsonlz4", DEFAULT_MAX_COMPRESSED_BYTES + 1),
    /cannot exceed the absolute safety cap/
  );
});

test("rejects malformed UTF-8 instead of normalizing browser state", () => {
  const malformedJson = Buffer.from([
    ...Buffer.from('{"title":"', "utf8"),
    0x80,
    ...Buffer.from('"}', "utf8")
  ]);
  const encoded = Buffer.alloc(13 + malformedJson.length);
  Buffer.from("mozLz40\0", "binary").copy(encoded, 0);
  encoded.writeUInt32LE(malformedJson.length, 8);
  encoded[12] = malformedJson.length << 4;
  malformedJson.copy(encoded, 13);

  assert.throws(() => decodeJsonLz4Buffer(encoded), /valid UTF-8/);
});

test("maximum accepted payload encodes inside the read envelope and cannot be raised by environment", () => {
  const wrapperBytes = Buffer.byteLength(JSON.stringify({ value: "" }), "utf8");
  const value = { value: "x".repeat(DEFAULT_MAX_DECOMPRESSED_BYTES - wrapperBytes) };
  const encoded = encodeJsonLz4Buffer(value);
  assert.ok(encoded.byteLength <= DEFAULT_MAX_COMPRESSED_BYTES);
  assert.equal(decodeJsonLz4Buffer(encoded).value.length, value.value.length);

  const previous = process.env.ZTS_MAX_JSONLZ4_DECOMPRESSED_BYTES;
  process.env.ZTS_MAX_JSONLZ4_DECOMPRESSED_BYTES = String(4 * 1024 * 1024 * 1024);
  try {
    assert.throws(
      () => encodeJsonLz4Buffer({ value: `${value.value}x` }),
      /encoded length .* exceeds safety cap/
    );
  } finally {
    if (previous === undefined) delete process.env.ZTS_MAX_JSONLZ4_DECOMPRESSED_BYTES;
    else process.env.ZTS_MAX_JSONLZ4_DECOMPRESSED_BYTES = previous;
  }
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

test("accepted CAS is not committed until target durability and displaced-source cleanup are complete", {
  skip: process.platform !== "darwin"
}, async (t) => {
  await t.test("pre-durability failure retains the exact displaced source", async () => {
    const temp = await mkdtemp(join(tmpdir(), "zts-jsonlz4-durability-"));
    const path = join(temp, "zen-sessions.jsonlz4");
    const original = { version: 1, marker: "source" };
    const planned = { version: 2, marker: "planned" };
    await writeJsonLz4(path, original);
    const expected = await readJsonLz4State(path);
    let boundaryCrossed = false;
    let committed = false;

    await assert.rejects(
      () => writeJsonLz4Durable(path, planned, {
        expectedSourceFingerprint: expected.fingerprint,
        onCommitBoundaryCrossed: () => { boundaryCrossed = true; },
        onCommitted: () => { committed = true; },
        afterRename: () => { throw new Error("fixture failure before target durability"); }
      }),
      /failure before target durability/iu
    );

    assert.equal(boundaryCrossed, true);
    assert.equal(committed, false);
    assert.deepEqual(await readJsonLz4(path), planned);
    const residues = (await readdir(temp)).filter((entry) => entry.endsWith(".jsonlz4.tmp"));
    assert.equal(residues.length, 1);
    assert.deepEqual(await readJsonLz4(join(temp, residues[0])), original);
    await rm(temp, { recursive: true, force: true });
  });

  await t.test("failure before final directory sync has no residue but remains uncommitted", async () => {
    const temp = await mkdtemp(join(tmpdir(), "zts-jsonlz4-final-sync-"));
    const path = join(temp, "zen-sessions.jsonlz4");
    const original = { version: 1, marker: "source" };
    const planned = { version: 2, marker: "planned" };
    await writeJsonLz4(path, original);
    const expected = await readJsonLz4State(path);
    let boundaryCrossed = false;
    let committed = false;

    await assert.rejects(
      () => writeJsonLz4Durable(path, planned, {
        expectedSourceFingerprint: expected.fingerprint,
        onCommitBoundaryCrossed: () => { boundaryCrossed = true; },
        onCommitted: () => { committed = true; },
        beforeFinalDirectorySync: () => { throw new Error("fixture final directory sync failure"); }
      }),
      /final directory sync failure/iu
    );

    assert.equal(boundaryCrossed, true);
    assert.equal(committed, false);
    assert.deepEqual(await readJsonLz4(path), planned);
    assert.deepEqual(
      (await readdir(temp)).filter((entry) => entry.endsWith(".jsonlz4.tmp")),
      []
    );
    await rm(temp, { recursive: true, force: true });
  });
});

test("fingerprint-bound publication never overwrites a writer racing the atomic commit", {
  skip: process.platform !== "darwin"
}, async () => {
  const temp = await mkdtemp(join(tmpdir(), "zts-jsonlz4-cas-"));
  const path = join(temp, "zen-sessions.jsonlz4");
  const racedPath = join(temp, "raced.jsonlz4");
  const original = { version: 1, marker: "source" };
  const raced = { version: 9, marker: "writer" };
  await writeJsonLz4(path, original);
  const expected = await readJsonLz4State(path);
  const racedBytes = encodeJsonLz4Buffer(raced);

  await assert.rejects(
    () => writeJsonLz4Durable(path, { version: 2, marker: "planned" }, {
      expectedSourceFingerprint: expected.fingerprint,
      afterSourceValidation: async () => {
        const metadata = await stat(path);
        await writeFile(racedPath, racedBytes);
        await utimes(racedPath, metadata.atime, metadata.mtime);
        await rename(racedPath, path);
      }
    }),
    /atomic commit.+Drift|Drift.+atomic commit/i
  );

  assert.deepEqual(await readJsonLz4(path), raced);
});

test("fingerprint-bound publication preserves both writers when rollback is raced", {
  skip: process.platform !== "darwin"
}, async () => {
  const temp = await mkdtemp(join(tmpdir(), "zts-jsonlz4-cas-second-race-"));
  const path = join(temp, "zen-sessions.jsonlz4");
  const firstPath = join(temp, "first-writer.jsonlz4");
  const secondPath = join(temp, "second-writer.jsonlz4");
  const original = { version: 1, marker: "source" };
  const firstWriter = { version: 8, marker: "first!" };
  const secondWriter = { version: 9, marker: "second" };
  await writeJsonLz4(path, original);
  const expected = await readJsonLz4State(path);

  await assert.rejects(
    () => writeJsonLz4Durable(path, { version: 2, marker: "planned" }, {
      expectedSourceFingerprint: expected.fingerprint,
      afterSourceValidation: async () => {
        await writeFile(firstPath, encodeJsonLz4Buffer(firstWriter));
        await rename(firstPath, path);
      },
      afterAtomicSwap: async () => {
        await writeFile(secondPath, encodeJsonLz4Buffer(secondWriter));
        await rename(secondPath, path);
      }
    }),
    (error) => error?.code === "ATOMIC_FILE_COMMIT_UNCERTAIN"
  );

  assert.deepEqual(await readJsonLz4(path), secondWriter);
  const residues = (await readdir(temp)).filter((entry) => entry.endsWith(".jsonlz4.tmp"));
  assert.equal(residues.length, 1);
  assert.deepEqual(await readJsonLz4(join(temp, residues[0])), firstWriter);
});

test("fingerprint-bound publication never accepts a post-swap hardlink", {
  skip: process.platform !== "darwin"
}, async () => {
  const temp = await mkdtemp(join(tmpdir(), "zts-jsonlz4-cas-hardlink-race-"));
  const path = join(temp, "zen-sessions.jsonlz4");
  const linked = join(temp, "unexpected-hardlink.jsonlz4");
  await writeJsonLz4(path, { version: 1, marker: "source" });
  const expected = await readJsonLz4State(path);

  await assert.rejects(
    () => writeJsonLz4Durable(path, { version: 2, marker: "planned" }, {
      expectedSourceFingerprint: expected.fingerprint,
      afterAtomicSwap: () => link(path, linked)
    }),
    /hardlink count|uncertain/iu
  );
});
