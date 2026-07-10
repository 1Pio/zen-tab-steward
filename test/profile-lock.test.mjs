import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { acquireProfileTransactionLock, ProfileLockError } from "../dist/profile-lock.js";

const execFileAsync = promisify(execFile);
const profile = {
  id: "lock.Default",
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
    await assert.rejects(
      () => acquireProfileTransactionLock(profile, "zts apply after crash"),
      (error) => error instanceof ProfileLockError
        && error.code === "PROFILE_LOCK_STALE"
        && /explicit recovery/.test(error.message)
    );
  } finally {
    if (previous === undefined) delete process.env.ZTS_STATE_DIR;
    else process.env.ZTS_STATE_DIR = previous;
  }
});
