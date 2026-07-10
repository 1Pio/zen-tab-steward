import assert from "node:assert/strict";
import { link, mkdtemp, mkdir, readdir, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  ensurePrivateDirectory,
  privatePath,
  publishPrivateBytes,
  publishPrivateJson,
  readPrivateBytes,
  readPrivateJson,
  replacePrivateJson
} from "../dist/private-store.js";

test("private JSON artifacts enforce owner-only durable publication and reject symlink roots", async () => {
  const temp = await mkdtemp(join(tmpdir(), "zts-private-store-"));
  const root = join(temp, "state");
  const plans = await ensurePrivateDirectory(root, "plans");
  const objectPath = privatePath(plans, "object.json");
  const pointerPath = privatePath(plans, "latest.json");
  const binaryPath = privatePath(plans, "session-backup.jsonlz4");

  await publishPrivateJson(objectPath, { schemaVersion: "fixture-1", value: "private" });
  await replacePrivateJson(pointerPath, { schemaVersion: "pointer-1", value: 1 });
  await replacePrivateJson(pointerPath, { schemaVersion: "pointer-1", value: 2 });
  await publishPrivateBytes(binaryPath, Buffer.from([0, 1, 2, 255]));

  assert.deepEqual(await readPrivateJson(objectPath), { schemaVersion: "fixture-1", value: "private" });
  assert.deepEqual(await readPrivateJson(pointerPath), { schemaVersion: "pointer-1", value: 2 });
  assert.deepEqual(await readPrivateBytes(binaryPath), Buffer.from([0, 1, 2, 255]));
  assert.equal((await stat(root)).mode & 0o777, 0o700);
  assert.equal((await stat(plans)).mode & 0o777, 0o700);
  assert.equal((await stat(objectPath)).mode & 0o777, 0o600);
  assert.equal((await stat(pointerPath)).mode & 0o777, 0o600);
  assert.equal((await stat(binaryPath)).mode & 0o777, 0o600);
  assert.equal((await readdir(plans)).some((entry) => entry.startsWith(".tmp-")), false);

  const hardlinkPath = join(temp, "artifact-hardlink.json");
  await link(objectPath, hardlinkPath);
  await assert.rejects(() => readPrivateJson(objectPath), /unexpected hardlink count/);
  await rm(hardlinkPath);

  const outside = join(temp, "outside");
  const linkedRoot = join(temp, "linked-state");
  await mkdir(outside);
  await symlink(outside, linkedRoot);
  await assert.rejects(() => ensurePrivateDirectory(linkedRoot, "plans"), /not a real directory/);
  assert.deepEqual(await readdir(outside), []);
});
