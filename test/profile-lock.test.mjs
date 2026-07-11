import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { mkdtemp, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import {
  acquireProfileTransactionLock,
  inspectProfileTransactionLock,
  ProfileLockAcquisitionUncertainError,
  ProfileLockError,
  releaseStaleProfileTransactionLock
} from "../dist/profile-lock.js";
import { profileIdForPath } from "../dist/profile.js";

const execFileAsync = promisify(execFile);
const profile = {
  id: profileIdForPath("/tmp/zen-lock-fixture/lock.Default"),
  name: "Lock fixture",
  path: "/tmp/zen-lock-fixture/lock.Default",
  isDefault: true,
  fromInstallDefault: true
};

test("profile transaction lock has one owner and is durably reusable after verified release", async () => {
  const state = await mkdtemp(join(tmpdir(), "zts-profile-lock-"));
  const previous = process.env.ZTS_STATE_DIR;
  process.env.ZTS_STATE_DIR = state;
  try {
    const first = await acquireProfileTransactionLock(profile, "zts apply fixture");
    await assert.rejects(
      () => acquireProfileTransactionLock(profile, "zts apply contender"),
      (error) => error instanceof ProfileLockError && error.code === "PROFILE_LOCK_ACTIVE"
    );
    const entries = await readdir(join(state, "locks"));
    assert.equal(entries.length, 1);
    assert.equal((await stat(join(state, "locks", entries[0]))).mode & 0o777, 0o600);
    await first.release();

    const second = await acquireProfileTransactionLock(profile, "zts apply after release");
    await second.release();
    assert.deepEqual(await readdir(join(state, "locks")), []);
  } finally {
    if (previous === undefined) delete process.env.ZTS_STATE_DIR;
    else process.env.ZTS_STATE_DIR = previous;
  }
});

test("profile transaction lock detects a dead owner and refuses unsafe automatic stale takeover", async () => {
  const state = await mkdtemp(join(tmpdir(), "zts-profile-stale-lock-"));
  const script = [
    'import { acquireProfileTransactionLock } from "./dist/profile-lock.js";',
    `await acquireProfileTransactionLock(${JSON.stringify(profile)}, "fixture abandoned lock");`
  ].join("\n");
  await execFileAsync("node", ["--input-type=module", "--eval", script], {
    cwd: process.cwd(),
    env: { ...process.env, ZTS_STATE_DIR: state }
  });

  const previous = process.env.ZTS_STATE_DIR;
  process.env.ZTS_STATE_DIR = state;
  try {
    const inspection = await inspectProfileTransactionLock(profile);
    assert.equal(inspection.status, "stale");
    await assert.rejects(
      () => releaseStaleProfileTransactionLock(profile, `sha256:${"0".repeat(64)}`),
      /does not match the recovery journal/
    );
    assert.equal((await inspectProfileTransactionLock(profile)).status, "stale");
    await assert.rejects(
      () => acquireProfileTransactionLock(profile, "zts apply after crash"),
      (error) => error instanceof ProfileLockError
        && error.code === "PROFILE_LOCK_STALE"
        && /explicit recovery/.test(error.message)
    );
    await releaseStaleProfileTransactionLock(profile, inspection.artifactRevision);
    assert.equal((await inspectProfileTransactionLock(profile)).status, "absent");
  } finally {
    if (previous === undefined) delete process.env.ZTS_STATE_DIR;
    else process.env.ZTS_STATE_DIR = previous;
  }
});

test("Profile lock acquisition recovers exact ownership after post-link failure", async () => {
  const temp = await mkdtemp(join(tmpdir(), "zts-profile-lock-post-link-"));
  const previous = process.env.ZTS_STATE_DIR;
  process.env.ZTS_STATE_DIR = temp;
  try {
    const lock = await acquireProfileTransactionLock(
      profile,
      "zts apply post-link fixture",
      new Date(),
      "apply:00000000-0000-4000-8000-000000000099",
      { afterLink: () => { throw new Error("fixture post-link failure"); } }
    );
    const inspection = await inspectProfileTransactionLock(profile);
    assert.equal(inspection.status, "active");
    assert.equal(inspection.artifactRevision, lock.artifactRevision);
    await lock.release();
    assert.equal((await inspectProfileTransactionLock(profile)).status, "absent");
  } finally {
    if (previous === undefined) delete process.env.ZTS_STATE_DIR;
    else process.env.ZTS_STATE_DIR = previous;
  }
});

test("Profile lock acquisition reconciles a same-Profile prelink loser without read-only deletion", async () => {
  const temp = await mkdtemp(join(tmpdir(), "zts-profile-lock-prelink-"));
  const script = [
    'import { acquireProfileTransactionLock } from "./dist/profile-lock.js";',
    `await acquireProfileTransactionLock(${JSON.stringify(profile)}, "fixture prelink lock", new Date(), null, { afterTemporaryWrite: () => process.exit(98) });`
  ].join("\n");
  const crashed = await execFileAsync("node", ["--input-type=module", "--eval", script], {
    cwd: process.cwd(),
    env: { ...process.env, ZTS_STATE_DIR: temp }
  }).then(() => null, (error) => error);
  assert.equal(crashed?.code, 98);

  const previous = process.env.ZTS_STATE_DIR;
  process.env.ZTS_STATE_DIR = temp;
  try {
    const before = await readdir(join(temp, "locks"));
    assert.equal(before.length, 1);
    assert.equal(before[0].startsWith(".tmp-"), true);
    assert.equal((await inspectProfileTransactionLock(profile)).status, "absent");
    assert.deepEqual(await readdir(join(temp, "locks")), before);

    const lock = await acquireProfileTransactionLock(profile, "zts apply after prelink crash");
    assert.equal((await readdir(join(temp, "locks"))).some((entry) => entry.startsWith(".tmp-")), false);
    await lock.release();
    assert.deepEqual(await readdir(join(temp, "locks")), []);
  } finally {
    if (previous === undefined) delete process.env.ZTS_STATE_DIR;
    else process.env.ZTS_STATE_DIR = previous;
  }
});

test("Profile lock acquisition never accepts a same-content replacement inode", async () => {
  const temp = await mkdtemp(join(tmpdir(), "zts-profile-lock-inode-swap-"));
  const previous = process.env.ZTS_STATE_DIR;
  process.env.ZTS_STATE_DIR = temp;
  try {
    await assert.rejects(
      () => acquireProfileTransactionLock(
        profile,
        "zts apply inode-swap fixture",
        new Date(),
        "apply:00000000-0000-4000-8000-000000000100",
        {
          afterLink: () => {
            const root = join(temp, "locks");
            const canonicalName = readdirSync(root).find((entry) => !entry.startsWith(".tmp-"));
            assert.ok(canonicalName);
            const canonical = join(root, canonicalName);
            const displaced = join(root, "displaced-lock.json");
            const contents = readFileSync(canonical);
            renameSync(canonical, displaced);
            writeFileSync(canonical, contents, { mode: 0o600 });
          }
        }
      ),
      (error) => error instanceof ProfileLockAcquisitionUncertainError
    );
  } finally {
    if (previous === undefined) delete process.env.ZTS_STATE_DIR;
    else process.env.ZTS_STATE_DIR = previous;
  }
});
