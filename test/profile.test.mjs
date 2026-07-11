import assert from "node:assert/strict";
import { appendFile, mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  assertProfileIdentity,
  canonicalProfilePath,
  discoverProfiles,
  profileIdForPath,
  readZenCompatibilityIdentity,
  selectProfile
} from "../dist/profile.js";
import { acquireProfileTransactionLock, ProfileLockError } from "../dist/profile-lock.js";

test("Profile selection requires one explicit or unambiguous candidate", () => {
  const first = {
    id: profileIdForPath("/profiles/first"), name: "First", path: "/profiles/first",
    isDefault: false, fromInstallDefault: false
  };
  const second = {
    id: profileIdForPath("/profiles/second"), name: "Second", path: "/profiles/second",
    isDefault: false, fromInstallDefault: false
  };
  assert.throws(() => selectProfile([first, second], []), /Multiple Zen Profiles.*ZTS_PROFILE/iu);
  assert.equal(selectProfile([first, second], [], second.id), second);
  assert.equal(selectProfile([first, second], [], "First"), first);
  assert.equal(selectProfile([{ ...first, fromInstallDefault: true }, second], []).id, first.id);
  assert.throws(
    () => selectProfile(
      [first, second],
      [
        { pid: 10, command: "zen", args: [], profilePath: first.path },
        { pid: 11, command: "zen", args: [], profilePath: second.path }
      ]
    ),
    /Multiple running Zen Profiles.*ZTS_PROFILE/iu
  );
});

test("Profile identity binds the canonical path even when directory basenames match", async () => {
  const temp = await mkdtemp(join(tmpdir(), "zts-profile-identity-"));
  const appSupport = join(temp, "zen");
  const first = join(temp, "first", "same.Default");
  const second = join(temp, "second", "same.Default");
  await mkdir(appSupport, { recursive: true });
  await mkdir(first, { recursive: true });
  await mkdir(second, { recursive: true });
  await writeFile(join(appSupport, "profiles.ini"), [
    "[Profile0]",
    "Name=First",
    "IsRelative=0",
    `Path=${first}`,
    "",
    "[Profile1]",
    "Name=Second",
    "IsRelative=0",
    `Path=${second}`,
    ""
  ].join("\n"));

  const profiles = await discoverProfiles(appSupport);
  assert.equal(profiles.length, 2);
  assert.notEqual(profiles[0].id, profiles[1].id);
  assert.equal(profiles[0].id, profileIdForPath(profiles[0].path));
  assert.equal(profiles[1].id, profileIdForPath(profiles[1].path));
  assert.doesNotThrow(() => assertProfileIdentity(profiles[0]));
  assert.throws(
    () => assertProfileIdentity({ ...profiles[0], path: profiles[1].path }),
    /identity is not bound/
  );
});

test("Profile identity detects a symlink retarget", async () => {
  const temp = await mkdtemp(join(tmpdir(), "zts-profile-symlink-"));
  const first = join(temp, "first");
  const second = join(temp, "second");
  const selected = join(temp, "selected.Default");
  await mkdir(first);
  await mkdir(second);
  await symlink(first, selected);
  const profile = {
    id: profileIdForPath(selected),
    name: "Selected",
    path: selected,
    isDefault: true,
    fromInstallDefault: true
  };
  assert.doesNotThrow(() => assertProfileIdentity(profile));
  await rm(selected);
  await symlink(second, selected);
  assert.throws(() => assertProfileIdentity(profile), /identity is not bound/);
});

test("Profile compatibility identity is bounded and exact", async () => {
  const temp = await mkdtemp(join(tmpdir(), "zts-profile-compatibility-"));
  await writeFile(join(temp, "compatibility.ini"), [
    "[Compatibility]",
    "LastVersion=1.19.3b_20260315063056/20260315063056",
    "LastOSABI=Darwin_aarch64-gcc3",
    ""
  ].join("\n"));
  assert.deepEqual(await readZenCompatibilityIdentity(temp), {
    version: "1.19.3b",
    buildId: "20260315063056",
    osAbi: "Darwin_aarch64-gcc3"
  });
  await writeFile(join(temp, "compatibility.ini"), [
    "[Compatibility]",
    "LastVersion=1.19.3b_20260315063056/20260315063057",
    "LastOSABI=Darwin_aarch64-gcc3",
    ""
  ].join("\n"));
  assert.equal(await readZenCompatibilityIdentity(temp), null);
});

test("two profiles.ini aliases to one Profile share one lock identity", async () => {
  const temp = await mkdtemp(join(tmpdir(), "zts-profile-alias-lock-"));
  const appSupport = join(temp, "zen");
  const target = join(temp, "target.Default");
  const firstAlias = join(temp, "first.Default");
  const secondAlias = join(temp, "second.Default");
  await mkdir(appSupport);
  await mkdir(target);
  await symlink(target, firstAlias);
  await symlink(target, secondAlias);
  await writeFile(join(appSupport, "profiles.ini"), [
    "[Profile0]",
    "Name=First alias",
    "IsRelative=0",
    `Path=${firstAlias}`,
    "",
    "[Profile1]",
    "Name=Second alias",
    "IsRelative=0",
    `Path=${secondAlias}`,
    ""
  ].join("\n"));
  const profiles = await discoverProfiles(appSupport);
  assert.equal(profiles[0].path, canonicalProfilePath(target));
  assert.equal(profiles[1].path, profiles[0].path);
  assert.equal(profiles[0].id, profiles[1].id);

  const previous = process.env.ZTS_STATE_DIR;
  process.env.ZTS_STATE_DIR = join(temp, "state");
  try {
    const first = await acquireProfileTransactionLock(profiles[0], "first alias");
    await assert.rejects(
      () => acquireProfileTransactionLock(profiles[1], "second alias"),
      (error) => error instanceof ProfileLockError && error.code === "PROFILE_LOCK_ACTIVE"
    );
    await first.release();
  } finally {
    if (previous === undefined) delete process.env.ZTS_STATE_DIR;
    else process.env.ZTS_STATE_DIR = previous;
  }
});

test("Profile discovery refuses symbolic-link INI files", async () => {
  const temp = await mkdtemp(join(tmpdir(), "zts-profile-ini-symlink-"));
  const appSupport = join(temp, "zen");
  await mkdir(appSupport);
  const actualProfilesIni = join(temp, "profiles.ini");
  await writeFile(actualProfilesIni, "[Profile0]\nPath=profile.Default\n");
  await symlink(actualProfilesIni, join(appSupport, "profiles.ini"));

  await assert.rejects(
    () => discoverProfiles(appSupport),
    /symbolic link|no-follow|ELOOP/i
  );
});

test("Profile discovery does not follow an installs.ini symbolic link", async () => {
  const temp = await mkdtemp(join(tmpdir(), "zts-installs-ini-symlink-"));
  const appSupport = join(temp, "zen");
  await mkdir(appSupport);
  await writeFile(join(appSupport, "profiles.ini"), "[Profile0]\nPath=profile.Default\n");
  const actualInstallsIni = join(temp, "installs.ini");
  await writeFile(actualInstallsIni, "[Install123]\nDefault=profile.Default\n");
  await symlink(actualInstallsIni, join(appSupport, "installs.ini"));

  await assert.rejects(
    () => discoverProfiles(appSupport),
    /symbolic link|no-follow|ELOOP/i
  );
});

test("Profile discovery refuses an INI file that grows during its bounded read", async () => {
  const temp = await mkdtemp(join(tmpdir(), "zts-profile-ini-growth-"));
  const appSupport = join(temp, "zen");
  await mkdir(appSupport);
  await writeFile(join(appSupport, "profiles.ini"), "[Profile0]\nPath=profile.Default\n");

  await assert.rejects(
    () => discoverProfiles(appSupport, {
      afterIniStat: async (path) => {
        if (path.endsWith("profiles.ini")) await appendFile(path, "# changed\n");
      }
    }),
    /grew|changed while being read/i
  );
});

test("Profile discovery fails closed when optional installs.ini disappears after open", async () => {
  const temp = await mkdtemp(join(tmpdir(), "zts-installs-ini-race-"));
  const appSupport = join(temp, "zen");
  await mkdir(appSupport);
  await writeFile(join(appSupport, "profiles.ini"), "[Profile0]\nPath=profile.Default\n");
  await writeFile(join(appSupport, "installs.ini"), "[Install123]\nDefault=profile.Default\n");

  await assert.rejects(
    () => discoverProfiles(appSupport, {
      afterIniStat: async (path) => {
        if (path.endsWith("installs.ini")) await rm(path);
      }
    }),
    /ENOENT|changed|canonical|hardlink count/i
  );
});

test("Profile discovery enforces explicit INI file, section, key, and string bounds", async (t) => {
  await t.test("file bytes", async () => {
    const temp = await mkdtemp(join(tmpdir(), "zts-profile-ini-bytes-"));
    const appSupport = join(temp, "zen");
    await mkdir(appSupport);
    await writeFile(join(appSupport, "profiles.ini"), `#${"x".repeat(1_048_576)}\n`);
    await assert.rejects(() => discoverProfiles(appSupport), /exceeds the 1048576-byte limit/i);
  });

  await t.test("section count", async () => {
    const temp = await mkdtemp(join(tmpdir(), "zts-profile-ini-sections-"));
    const appSupport = join(temp, "zen");
    await mkdir(appSupport);
    await writeFile(
      join(appSupport, "profiles.ini"),
      Array.from({ length: 257 }, (_, index) => `[Profile${index}]\nPath=profile-${index}.Default\n`).join("")
    );
    await assert.rejects(() => discoverProfiles(appSupport), /exceeds the 256-section limit/i);
  });

  await t.test("keys per section", async () => {
    const temp = await mkdtemp(join(tmpdir(), "zts-profile-ini-keys-"));
    const appSupport = join(temp, "zen");
    await mkdir(appSupport);
    await writeFile(
      join(appSupport, "profiles.ini"),
      `[Profile0]\nPath=profile.Default\n${Array.from({ length: 64 }, (_, index) => `Extra${index}=1\n`).join("")}`
    );
    await assert.rejects(() => discoverProfiles(appSupport), /exceeds the 64-key limit/i);
  });

  await t.test("value bytes", async () => {
    const temp = await mkdtemp(join(tmpdir(), "zts-profile-ini-value-"));
    const appSupport = join(temp, "zen");
    await mkdir(appSupport);
    await writeFile(join(appSupport, "profiles.ini"), `[Profile0]\nPath=${"x".repeat(16_385)}\n`);
    await assert.rejects(() => discoverProfiles(appSupport), /value exceeds the 16384-byte limit/i);
  });
});
