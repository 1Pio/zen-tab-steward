import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { backupRootForProfile, createBackup, listBackups, pruneBackups, restoreBackup } from "../dist/backup.js";

test("creates timestamped bak files plus a manifest without mutating source files", async () => {
  const temp = await mkdtemp(join(tmpdir(), "zts-backup-"));
  process.env.ZTS_STATE_DIR = join(temp, "state");

  const profilePath = join(temp, "profile");
  await mkdir(join(profilePath, "sessionstore-backups"), { recursive: true });
  await writeFile(join(profilePath, "zen-sessions.jsonlz4"), "session");
  await writeFile(join(profilePath, "zen-live-folders.jsonlz4"), "folders");
  await writeFile(join(profilePath, "sessionstore-backups", "recovery.jsonlz4"), "recovery");
  await writeFile(join(profilePath, "sessionstore-backups", "previous.jsonlz4"), "previous");

  const manifest = await createBackup(
    {
      appSupportDir: temp,
      running: true,
      runningProcesses: [],
      profile: {
        id: "Profile A",
        name: "Profile A",
        path: profilePath,
        isDefault: true,
        fromInstallDefault: true
      },
      sessionFile: {
        kind: "zen-sessions",
        path: join(profilePath, "zen-sessions.jsonlz4"),
        exists: true,
        size: 7,
        modifiedMs: 1
      }
    },
    "zts backup"
  );

  assert.equal(manifest.files.length, 4);
  assert.ok(manifest.files.every((file) => file.backup.endsWith(".bak")));
  assert.equal(await readFile(join(profilePath, "zen-sessions.jsonlz4"), "utf8"), "session");

  const listed = await listBackups("Profile A");
  assert.equal(listed.length, 1);
  assert.equal(listed[0].id, manifest.id);
});

test("restores a backup only when Zen is closed and writes a safety backup receipt", async () => {
  const temp = await mkdtemp(join(tmpdir(), "zts-restore-"));
  const oldStateDir = process.env.ZTS_STATE_DIR;
  process.env.ZTS_STATE_DIR = join(temp, "state");

  try {
    const profilePath = join(temp, "profile");
    await mkdir(join(profilePath, "sessionstore-backups"), { recursive: true });
    const sessionPath = join(profilePath, "zen-sessions.jsonlz4");
    const previousPath = join(profilePath, "sessionstore-backups", "previous.jsonlz4");
    await writeFile(sessionPath, "original-session");
    await writeFile(previousPath, "original-previous");

    const context = {
      appSupportDir: temp,
      running: false,
      runningProcesses: [],
      profile: {
        id: "Profile B",
        name: "Profile B",
        path: profilePath,
        isDefault: true,
        fromInstallDefault: true
      },
      sessionFile: {
        kind: "zen-sessions",
        path: sessionPath,
        exists: true,
        size: 16,
        modifiedMs: 1
      }
    };

    const manifest = await createBackup(context, "zts backup");
    await writeFile(sessionPath, "changed-session");
    await writeFile(previousPath, "changed-previous");

    const receipt = await restoreBackup(context, manifest.id, `zts backup restore ${manifest.id}`);

    assert.equal(receipt.restoredBackupId, manifest.id);
    assert.ok(receipt.safetyBackupId);
    assert.equal(receipt.files.length, 2);
    assert.ok(receipt.files.every((file) => file.verified));
    assert.equal(await readFile(sessionPath, "utf8"), "original-session");
    assert.equal(await readFile(previousPath, "utf8"), "original-previous");
    assert.equal((await listBackups("Profile B")).length, 2);
  } finally {
    if (oldStateDir === undefined) delete process.env.ZTS_STATE_DIR;
    else process.env.ZTS_STATE_DIR = oldStateDir;
  }
});

test("restore refuses while Zen is running", async () => {
  const temp = await mkdtemp(join(tmpdir(), "zts-restore-running-"));
  const oldStateDir = process.env.ZTS_STATE_DIR;
  process.env.ZTS_STATE_DIR = join(temp, "state");

  try {
    const profilePath = join(temp, "profile");
    await mkdir(profilePath, { recursive: true });
    const sessionPath = join(profilePath, "zen-sessions.jsonlz4");
    await writeFile(sessionPath, "session");
    const context = {
      appSupportDir: temp,
      running: true,
      runningProcesses: [],
      profile: {
        id: "Profile C",
        name: "Profile C",
        path: profilePath,
        isDefault: true,
        fromInstallDefault: true
      },
      sessionFile: {
        kind: "zen-sessions",
        path: sessionPath,
        exists: true,
        size: 7,
        modifiedMs: 1
      }
    };

    await assert.rejects(() => restoreBackup(context, "anything", "zts backup restore anything"), /Zen is running/);
  } finally {
    if (oldStateDir === undefined) delete process.env.ZTS_STATE_DIR;
    else process.env.ZTS_STATE_DIR = oldStateDir;
  }
});

test("prunes only backups older than the selected cutoff", async () => {
  const temp = await mkdtemp(join(tmpdir(), "zts-prune-"));
  const oldStateDir = process.env.ZTS_STATE_DIR;
  process.env.ZTS_STATE_DIR = join(temp, "state");

  try {
    const profilePath = join(temp, "profile");
    await mkdir(profilePath, { recursive: true });
    const sessionPath = join(profilePath, "zen-sessions.jsonlz4");
    await writeFile(sessionPath, "session");
    const context = {
      appSupportDir: temp,
      running: false,
      runningProcesses: [],
      profile: {
        id: "Profile Prune",
        name: "Profile Prune",
        path: profilePath,
        isDefault: true,
        fromInstallDefault: true
      },
      sessionFile: {
        kind: "zen-sessions",
        path: sessionPath,
        exists: true,
        size: 7,
        modifiedMs: 1
      }
    };

    const oldBackup = await createBackup(context, "zts backup old");
    const freshBackup = await createBackup(context, "zts backup fresh");
    const backupRoot = backupRootForProfile(context.profile.id);
    const oldManifestPath = join(backupRoot, `${oldBackup.id}--manifest.json`);
    const oldManifest = {
      ...oldBackup,
      createdAt: "2020-01-01T00:00:00.000Z"
    };
    await writeFile(oldManifestPath, `${JSON.stringify(oldManifest, null, 2)}\n`, "utf8");

    const dryRun = await pruneBackups(context.profile.id, new Date("2021-01-01T00:00:00.000Z"), true, "zts backup prune --dry-run --before 2021-01-01T00:00:00.000Z");
    assert.equal(dryRun.dryRun, true);
    assert.equal(dryRun.prunedCount, 1);
    assert.equal(dryRun.retainedCount, 1);
    assert.equal((await listBackups(context.profile.id)).length, 2);

    const receipt = await pruneBackups(context.profile.id, new Date("2021-01-01T00:00:00.000Z"), false, "zts backup prune --before 2021-01-01T00:00:00.000Z");
    assert.equal(receipt.dryRun, false);
    assert.equal(receipt.prunedCount, 1);
    assert.ok(receipt.receiptPath);
    await assert.rejects(() => readFile(oldManifestPath, "utf8"), /ENOENT/);
    await assert.rejects(() => readFile(oldBackup.files[0].backup, "utf8"), /ENOENT/);
    const remaining = await listBackups(context.profile.id);
    assert.equal(remaining.length, 1);
    assert.equal(remaining[0].id, freshBackup.id);
  } finally {
    if (oldStateDir === undefined) delete process.env.ZTS_STATE_DIR;
    else process.env.ZTS_STATE_DIR = oldStateDir;
  }
});

test("restore preflights all backup files before mutating any profile file", async () => {
  const temp = await mkdtemp(join(tmpdir(), "zts-restore-preflight-"));
  const oldStateDir = process.env.ZTS_STATE_DIR;
  process.env.ZTS_STATE_DIR = join(temp, "state");

  try {
    const profilePath = join(temp, "profile");
    await mkdir(join(profilePath, "sessionstore-backups"), { recursive: true });
    const sessionPath = join(profilePath, "zen-sessions.jsonlz4");
    const previousPath = join(profilePath, "sessionstore-backups", "previous.jsonlz4");
    await writeFile(sessionPath, "original-session");
    await writeFile(previousPath, "original-previous");
    const context = {
      appSupportDir: temp,
      running: false,
      runningProcesses: [],
      profile: {
        id: "Profile D",
        name: "Profile D",
        path: profilePath,
        isDefault: true,
        fromInstallDefault: true
      },
      sessionFile: {
        kind: "zen-sessions",
        path: sessionPath,
        exists: true,
        size: 16,
        modifiedMs: 1
      }
    };

    const manifest = await createBackup(context, "zts backup");
    const previousBackup = manifest.files.find((file) => file.source === previousPath);
    assert.ok(previousBackup);
    await writeFile(sessionPath, "changed-session");
    await writeFile(previousPath, "changed-previous");
    await writeFile(previousBackup.backup, "corrupt-previous");

    await assert.rejects(
      () => restoreBackup(context, manifest.id, `zts backup restore ${manifest.id}`),
      /Backup (size|hash) mismatch/
    );

    assert.equal(await readFile(sessionPath, "utf8"), "changed-session");
    assert.equal(await readFile(previousPath, "utf8"), "changed-previous");
    assert.equal((await listBackups("Profile D")).length, 1);
  } finally {
    if (oldStateDir === undefined) delete process.env.ZTS_STATE_DIR;
    else process.env.ZTS_STATE_DIR = oldStateDir;
  }
});
