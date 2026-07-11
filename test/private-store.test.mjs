import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { renameSync, writeFileSync } from "node:fs";
import { chmod, link, mkdtemp, mkdir, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  assertPrivateDirectory,
  createPrivateJsonExclusive,
  ensurePrivateDirectory,
  inspectPrivateStandaloneTemporaryCandidate,
  isPrivateTemporaryBasename,
  privatePath,
  publishPrivateBytes,
  publishPrivateJson,
  publishOwnedPrivateBytes,
  readPrivateBytes,
  readPrivateJson,
  reconcilePrivatePublication,
  removePrivateStandaloneTemporaryCandidate,
  replacePrivateJson
} from "../dist/private-store.js";
import { applyArtifactLayout, readApplyArtifactLayout } from "../dist/apply-artifacts.js";
import { loadStoredPlan } from "../dist/plans.js";

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

  await chmod(pointerPath, 0o644);
  await assert.rejects(() => readPrivateJson(pointerPath), /permissions are not owner-only/);
  assert.equal((await stat(pointerPath)).mode & 0o777, 0o644);

  await chmod(plans, 0o755);
  await assert.rejects(() => assertPrivateDirectory(root, "plans"), /directory permissions are not owner-only/);
  assert.equal((await stat(plans)).mode & 0o777, 0o755);

  const outside = join(temp, "outside");
  const linkedRoot = join(temp, "linked-state");
  await mkdir(outside);
  await symlink(outside, linkedRoot);
  await assert.rejects(() => ensurePrivateDirectory(linkedRoot, "plans"), /not a real directory/);
  assert.deepEqual(await readdir(outside), []);
});

test("apply and Plan stores reject symlinked parent directories without creating redirected data", async () => {
  const temp = await mkdtemp(join(tmpdir(), "zts-private-parent-links-"));
  const state = join(temp, "state");
  const outside = join(temp, "outside");
  await mkdir(state, { mode: 0o700 });
  await mkdir(outside, { mode: 0o700 });
  await symlink(outside, join(state, "apply-transactions"));
  await symlink(outside, join(state, "plans"));
  const previous = process.env.ZTS_STATE_DIR;
  process.env.ZTS_STATE_DIR = state;
  try {
    await assert.rejects(() => applyArtifactLayout("profile-fixture"), /not a real directory/);
    await assert.rejects(() => readApplyArtifactLayout("profile-fixture"), /not a real directory/);
    await assert.rejects(() => loadStoredPlan("profile-fixture", "latest"), /not a real directory/);
    assert.deepEqual(await readdir(outside), []);
  } finally {
    if (previous === undefined) delete process.env.ZTS_STATE_DIR;
    else process.env.ZTS_STATE_DIR = previous;
  }
});

test("private roots reject a symlinked ancestor before creating or chmoding redirected directories", async () => {
  const temp = await mkdtemp(join(tmpdir(), "zts-private-ancestor-link-"));
  const outside = join(temp, "outside");
  const redirected = join(temp, "redirected");
  await mkdir(outside, { mode: 0o755 });
  await symlink(outside, redirected);

  await assert.rejects(
    () => ensurePrivateDirectory(join(redirected, "zts-state"), "objects"),
    /symbolic link ancestor/iu
  );
  await writeFile(join(outside, "private.json"), "private", { mode: 0o600 });
  await assert.rejects(
    () => readPrivateBytes(join(redirected, "private.json"), 1024),
    /symbolic link ancestor/iu
  );

  assert.deepEqual(await readdir(outside), ["private.json"]);
  assert.equal((await stat(outside)).mode & 0o777, 0o755);
});

test("private root setup never adopts and chmods a broad existing user directory", async () => {
  const temp = await mkdtemp(join(tmpdir(), "zts-private-broad-root-"));
  const broad = join(temp, "Documents");
  await chmod(temp, 0o755);
  await mkdir(broad, { mode: 0o755 });
  await writeFile(join(broad, "personal.txt"), "user-owned", { mode: 0o600 });

  await assert.rejects(
    () => ensurePrivateDirectory(broad),
    /not clearly zts-owned/iu
  );

  assert.equal((await stat(temp)).mode & 0o777, 0o755);
  assert.equal((await stat(broad)).mode & 0o777, 0o755);
  assert.deepEqual(await readdir(broad), ["personal.txt"]);
});

test("immutable publication crash residue remains readable and reconciles by exact inode", async () => {
  const temp = await mkdtemp(join(tmpdir(), "zts-private-link-crash-"));
  const root = join(temp, "state");
  const objectPath = join(root, "objects", "receipt.json");
  const script = [
    'import { ensurePrivateDirectory, privatePath, publishPrivateBytes } from "./dist/private-store.js";',
    `const objects = await ensurePrivateDirectory(${JSON.stringify(root)}, "objects");`,
    `await publishPrivateBytes(privatePath(objects, "receipt.json"), Buffer.from("durable receipt"), 1024, { afterLink: () => process.exit(93) });`
  ].join("\n");
  const crashed = spawnSync("node", ["--input-type=module", "--eval", script], {
    cwd: process.cwd(),
    encoding: "utf8"
  });
  assert.equal(crashed.status, 93, `${crashed.stdout}\n${crashed.stderr}`);
  assert.equal((await stat(objectPath)).nlink, 2);
  assert.equal((await readPrivateBytes(objectPath, 1024)).toString("utf8"), "durable receipt");
  assert.equal((await readdir(join(root, "objects"))).filter((entry) => entry.startsWith(".tmp-")).length, 1);

  assert.equal(await reconcilePrivatePublication(objectPath), true);
  assert.equal((await stat(objectPath)).nlink, 1);
  assert.deepEqual(await readdir(join(root, "objects")), ["receipt.json"]);
  assert.equal(await reconcilePrivatePublication(objectPath), false);
});

test("standalone private temporaries are classified read-only and removed only by exact owner identity", async () => {
  const temp = await mkdtemp(join(tmpdir(), "zts-private-prelink-crash-"));
  const root = join(temp, "state");
  const script = [
    'import { ensurePrivateDirectory, privatePath, publishPrivateBytes } from "./dist/private-store.js";',
    `const objects = await ensurePrivateDirectory(${JSON.stringify(root)}, "objects");`,
    `await publishPrivateBytes(privatePath(objects, "receipt.json"), Buffer.from("uncommitted receipt"), 1024, { afterTemporaryWrite: () => process.exit(94) });`
  ].join("\n");
  const crashed = spawnSync("node", ["--input-type=module", "--eval", script], {
    cwd: process.cwd(),
    encoding: "utf8"
  });
  assert.equal(crashed.status, 94, `${crashed.stdout}\n${crashed.stderr}`);

  const objects = join(root, "objects");
  const names = await readdir(objects);
  assert.equal(names.length, 1);
  assert.equal(isPrivateTemporaryBasename(names[0]), true);
  const path = join(objects, names[0]);
  const inspected = await inspectPrivateStandaloneTemporaryCandidate(path, 1024);
  assert.equal(inspected.size, Buffer.byteLength("uncommitted receipt"));
  assert.deepEqual(await readdir(objects), names, "read-only classification must not delete residue");

  await removePrivateStandaloneTemporaryCandidate(inspected);
  assert.deepEqual(await readdir(objects), []);
});

test("standalone private temporary classification rejects unsafe names, modes, links, and Drift", async () => {
  const temp = await mkdtemp(join(tmpdir(), "zts-private-temp-safety-"));
  const objects = await ensurePrivateDirectory(join(temp, "state"), "objects");
  const unsafeName = join(objects, ".tmp-not-a-uuid.artifact");
  await writeFile(unsafeName, "unsafe", { mode: 0o600 });
  await assert.rejects(
    () => inspectPrivateStandaloneTemporaryCandidate(unsafeName, 1024),
    /exact zts publication name/
  );

  const strictName = `.tmp-00000000-0000-4000-8000-000000000001.artifact`;
  const strictPath = join(objects, strictName);
  await writeFile(strictPath, "private", { mode: 0o600 });
  await chmod(strictPath, 0o644);
  await assert.rejects(
    () => inspectPrivateStandaloneTemporaryCandidate(strictPath, 1024),
    /permissions are not owner-only/
  );
  await chmod(strictPath, 0o600);
  const linked = join(objects, "linked.json");
  await link(strictPath, linked);
  await assert.rejects(
    () => inspectPrivateStandaloneTemporaryCandidate(strictPath, 1024),
    /unexpected hardlink count/
  );
  await rm(linked);

  const inspected = await inspectPrivateStandaloneTemporaryCandidate(strictPath, 1024);
  await rm(strictPath);
  await writeFile(strictPath, "replacement", { mode: 0o600 });
  await assert.rejects(
    () => removePrivateStandaloneTemporaryCandidate(inspected),
    /Drifted before exact owner reconciliation/
  );
  assert.equal((await stat(strictPath)).size, Buffer.byteLength("replacement"));
});

test("immutable publication never accepts a same-content replacement after linking", async () => {
  const temp = await mkdtemp(join(tmpdir(), "zts-private-link-swap-"));
  const objects = await ensurePrivateDirectory(join(temp, "state"), "objects");
  const path = privatePath(objects, "receipt.json");
  const displaced = privatePath(objects, "displaced.json");
  const contents = Buffer.from("durable receipt");

  await assert.rejects(
    () => publishPrivateBytes(path, contents, 1024, {
      afterLink: () => {
        renameSync(path, displaced);
        writeFileSync(path, contents, { mode: 0o600 });
      }
    }),
    /private publication committed/iu
  );

  assert.deepEqual(await readPrivateBytes(path, 1024), contents);
  assert.deepEqual(await readPrivateBytes(displaced, 1024), contents);
  assert.equal((await readdir(objects)).filter((entry) => entry.startsWith(".tmp-")).length, 1);
  assert.notEqual((await stat(path)).ino, (await stat(displaced)).ino);
});

test("exclusive private JSON creation binds success to the prepared inode", async () => {
  const temp = await mkdtemp(join(tmpdir(), "zts-private-exclusive-swap-"));
  const objects = await ensurePrivateDirectory(join(temp, "state"), "objects");
  const path = privatePath(objects, "control.json");
  const displaced = privatePath(objects, "displaced.json");
  const value = { schemaVersion: "fixture-1", owner: "zts" };
  const encoded = `${JSON.stringify(value, null, 2)}\n`;

  await assert.rejects(
    () => createPrivateJsonExclusive(path, value, {
      afterLink: () => {
        renameSync(path, displaced);
        writeFileSync(path, encoded, { mode: 0o600 });
      }
    }),
    /private publication committed/iu
  );

  assert.deepEqual(await readPrivateJson(path), value);
  assert.deepEqual(await readPrivateJson(displaced), value);
  assert.equal((await readdir(objects)).filter((entry) => entry.startsWith(".tmp-")).length, 1);
  assert.notEqual((await stat(path)).ino, (await stat(displaced)).ino);
});

test("ordinary private temporary write failure removes partial sensitive bytes", async () => {
  const temp = await mkdtemp(join(tmpdir(), "zts-private-write-failure-"));
  const objects = await ensurePrivateDirectory(join(temp, "state"), "objects");
  const path = privatePath(objects, "never-published.json");
  await assert.rejects(
    () => publishPrivateBytes(path, Buffer.from("private browser state"), 1024, {
      afterTemporaryWrite: () => { throw new Error("fixture sync failure"); }
    }),
    /fixture sync failure/
  );
  assert.deepEqual(await readdir(objects), []);
});

test("owned private publication rejects caller mutation before publishing a canonical path", async () => {
  const temp = await mkdtemp(join(tmpdir(), "zts-private-owned-mutation-"));
  const objects = await ensurePrivateDirectory(join(temp, "state"), "objects");
  const path = privatePath(objects, "receipt.bin");
  const transferred = Buffer.from("original artifact");

  const publication = publishOwnedPrivateBytes(path, transferred, 1024);
  transferred.fill("x");

  await assert.rejects(publication, /content changed/iu);
  assert.deepEqual(await readdir(objects), []);
});

test("owned private publication collision compares canonical bytes with the captured identity", async () => {
  const temp = await mkdtemp(join(tmpdir(), "zts-private-owned-collision-"));
  const objects = await ensurePrivateDirectory(join(temp, "state"), "objects");
  const path = privatePath(objects, "receipt.bin");
  const canonical = Buffer.from("canonical bytes");
  await publishPrivateBytes(path, canonical, 1024);

  const transferred = Buffer.from("original bytes!");
  await assert.rejects(
    () => publishOwnedPrivateBytes(path, transferred, 1024, {
      afterTemporaryWrite: () => transferred.set(canonical)
    }),
    /identifier collision/iu
  );

  assert.deepEqual(await readPrivateBytes(path, 1024), canonical);
  assert.deepEqual(await readdir(objects), ["receipt.bin"]);
});

test("owned private publication leaves an existing canonical path intact after immediate caller mutation", async () => {
  const temp = await mkdtemp(join(tmpdir(), "zts-private-owned-existing-mutation-"));
  const objects = await ensurePrivateDirectory(join(temp, "state"), "objects");
  const path = privatePath(objects, "receipt.bin");
  const canonical = Buffer.from("canonical bytes");
  await publishPrivateBytes(path, canonical, 1024);
  const transferred = Buffer.from("original bytes!");

  const publication = publishOwnedPrivateBytes(path, transferred, 1024);
  transferred.set(canonical);

  await assert.rejects(publication, /content changed/iu);
  assert.deepEqual(await readPrivateBytes(path, 1024), canonical);
  assert.deepEqual(await readdir(objects), ["receipt.bin"]);
});

test("private JSON reads reject malformed UTF-8", async () => {
  const temp = await mkdtemp(join(tmpdir(), "zts-private-utf8-"));
  const objects = await ensurePrivateDirectory(join(temp, "state"), "objects");
  const path = privatePath(objects, "malformed.json");
  await writeFile(path, Buffer.from([
    ...Buffer.from('{"value":"', "utf8"),
    0x80,
    ...Buffer.from('"}', "utf8")
  ]), { mode: 0o600 });

  await assert.rejects(() => readPrivateJson(path), /valid UTF-8/);
});
