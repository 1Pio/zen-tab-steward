import assert from "node:assert/strict";
import { appendFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  truncate,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import {
  backupRootForProfile,
  createBackup,
  listBackups,
  previewBackupRestore,
  pruneBackups
} from "../dist/backup.js";
import { canonicalProfilePath, profileIdForPath } from "../dist/profile.js";

async function withBackupFixture(name, sourceContents, run) {
  const temp = await mkdtemp(join(tmpdir(), `${name}-`));
  const previousStateDir = process.env.ZTS_STATE_DIR;
  process.env.ZTS_STATE_DIR = join(temp, "state");
  try {
    const rawProfilePath = join(temp, "profile");
    await mkdir(rawProfilePath, { recursive: true });
    const profilePath = canonicalProfilePath(rawProfilePath);
    for (const [relative, contents] of Object.entries(sourceContents)) {
      const path = join(profilePath, ...relative.split("/"));
      await mkdir(path.slice(0, path.lastIndexOf("/")), { recursive: true });
      await writeFile(path, contents);
    }
    const sessionPath = join(profilePath, "zen-sessions.jsonlz4");
    const context = {
      appSupportDir: temp,
      running: false,
      runningProcesses: [],
      profile: {
        id: profileIdForPath(profilePath),
        name: "Fixture",
        path: profilePath,
        isDefault: true,
        fromInstallDefault: true
      },
      sessionFile: {
        kind: "zen-sessions",
        path: sessionPath,
        exists: Object.hasOwn(sourceContents, "zen-sessions.jsonlz4"),
        size: Buffer.byteLength(sourceContents["zen-sessions.jsonlz4"] ?? ""),
        modifiedMs: 1
      }
    };
    await run({ temp, profilePath, sessionPath, context, stateDir: process.env.ZTS_STATE_DIR });
  } finally {
    if (previousStateDir === undefined) delete process.env.ZTS_STATE_DIR;
    else process.env.ZTS_STATE_DIR = previousStateDir;
    await rm(temp, { recursive: true, force: true });
  }
}

const allSources = {
  "zen-sessions.jsonlz4": "session",
  "zen-live-folders.jsonlz4": "folders",
  "sessionstore-backups/recovery.jsonlz4": "recovery",
  "sessionstore-backups/previous.jsonlz4": "previous"
};

const BACKUP_SOURCE_LIMIT_BYTES = 64 * 1024 * 1024;

test("creates a durable private schema-bound backup and restore remains a verified preview", async () => {
  await withBackupFixture("zts-backup-happy", allSources, async ({ context, sessionPath, stateDir }) => {
    const previousUmask = process.umask(0);
    try {
      const manifest = await createBackup(context, "zts backup");
      assert.equal(manifest.schemaVersion, "zts.backup-manifest.v1");
      assert.equal(manifest.profileId, context.profile.id);
      assert.equal(manifest.files.length, 4);
      assert.equal(new Set(manifest.files.map((file) => file.backup)).size, 4);
      assert.ok(manifest.files.every((file) => file.sha256.length === 64));
      assert.ok(manifest.files.every((file) => file.sourceFingerprint.size === file.size));
      assert.equal(await readFile(sessionPath, "utf8"), "session");

      const root = backupRootForProfile(context.profile.id);
      const manifestPath = join(root, `${manifest.id}--manifest.json`);
      assert.equal((await stat(stateDir)).mode & 0o777, 0o700);
      assert.equal((await stat(root)).mode & 0o777, 0o700);
      assert.equal((await stat(manifestPath)).mode & 0o777, 0o600);
      for (const file of manifest.files) assert.equal((await stat(file.backup)).mode & 0o777, 0o600);

      const persisted = JSON.parse(await readFile(manifestPath, "utf8"));
      assert.equal(persisted.id, manifest.id);
      assert.equal(persisted.profilePath, context.profile.path);
      const listed = await listBackups(context.profile.id);
      assert.deepEqual(listed.map((backup) => backup.id), [manifest.id]);

      await writeFile(sessionPath, "changed-session");
      const preview = await previewBackupRestore(context, manifest.id);
      assert.equal(preview.executable, false);
      assert.equal(preview.files.length, 4);
      assert.match(preview.blocker, /production-disabled/);
      assert.equal(await readFile(sessionPath, "utf8"), "changed-session");
    } finally {
      process.umask(previousUmask);
    }
  });
});

test("rechecks the open source fingerprint after private publication and rolls back on drift", async () => {
  await withBackupFixture("zts-backup-drift", { "zen-sessions.jsonlz4": "before" }, async ({ context, sessionPath }) => {
    await assert.rejects(
      () => createBackup(context, "zts backup", {
        afterBackupFilePublished: () => appendFileSync(sessionPath, "-changed")
      }),
      /source changed before publication completed/
    );
    assert.equal(await readFile(sessionPath, "utf8"), "before-changed");
    assert.deepEqual(await listBackups(context.profile.id), []);
    assert.deepEqual(
      (await readdir(backupRootForProfile(context.profile.id))).filter((entry) => entry.endsWith(".bak") || entry.endsWith("--create-intent.json")),
      []
    );
  });
});

test("rejects symlinked and hardlinked Profile sources without copying outside bytes", async () => {
  await withBackupFixture("zts-backup-source-links", {}, async ({ temp, context, sessionPath }) => {
    const outside = join(temp, "outside-session");
    await writeFile(outside, "outside-secret");
    await symlink(outside, sessionPath);
    await assert.rejects(() => createBackup(context, "zts backup"), /not a real regular file/);
    assert.equal(await readFile(outside, "utf8"), "outside-secret");
    await rm(sessionPath);

    await link(outside, sessionPath);
    await assert.rejects(() => createBackup(context, "zts backup"), /unexpected hardlink count/);
    assert.equal(await readFile(outside, "utf8"), "outside-secret");
    assert.deepEqual(await listBackups(context.profile.id), []);
  });
});

test("manifest paths never control prune deletion and traversal ids are rejected", async () => {
  await withBackupFixture("zts-backup-traversal", { "zen-sessions.jsonlz4": "session" }, async ({ temp, context }) => {
    const manifest = await createBackup(context, "zts backup");
    const root = backupRootForProfile(context.profile.id);
    const manifestPath = join(root, `${manifest.id}--manifest.json`);
    const outside = join(temp, "must-survive");
    await writeFile(outside, "sentinel", { mode: 0o600 });
    const corrupted = JSON.parse(await readFile(manifestPath, "utf8"));
    corrupted.files[0].backup = outside;
    await writeFile(manifestPath, `${JSON.stringify(corrupted)}\n`);

    await assert.rejects(() => listBackups(context.profile.id), /data path is not filename-bound/);
    await assert.rejects(
      () => pruneBackups(context.profile.id, new Date(Date.now() + 60_000), false, "zts backup prune --older-than 1s"),
      /data path is not filename-bound/
    );
    await assert.rejects(() => previewBackupRestore(context, "../../outside"), /Invalid backup id/);
    assert.equal(await readFile(outside, "utf8"), "sentinel");
  });
});

test("list and restore reject hardlinked backup artifacts", async () => {
  await withBackupFixture("zts-backup-hardlink", { "zen-sessions.jsonlz4": "session" }, async ({ temp, context }) => {
    const manifest = await createBackup(context, "zts backup");
    const alias = join(temp, "backup-alias");
    await link(manifest.files[0].backup, alias);
    await assert.rejects(() => listBackups(context.profile.id), /unexpected hardlink count/);
    await assert.rejects(() => previewBackupRestore(context, manifest.id), /unexpected hardlink count/);
    await rm(alias);
    assert.equal((await listBackups(context.profile.id)).length, 1);
  });
});

test("strict bounded manifest reads reject unknown fields, Profile mismatch, and oversized input", async () => {
  await withBackupFixture("zts-backup-malformed", { "zen-sessions.jsonlz4": "session" }, async ({ context }) => {
    const manifest = await createBackup(context, "zts backup");
    const manifestPath = join(backupRootForProfile(context.profile.id), `${manifest.id}--manifest.json`);
    const parsed = JSON.parse(await readFile(manifestPath, "utf8"));
    parsed.unexpected = true;
    await writeFile(manifestPath, `${JSON.stringify(parsed)}\n`);
    await assert.rejects(() => listBackups(context.profile.id), /fields are invalid/);

    delete parsed.unexpected;
    parsed.profileId = `profile:${"f".repeat(64)}`;
    await writeFile(manifestPath, `${JSON.stringify(parsed)}\n`);
    await assert.rejects(() => listBackups(context.profile.id), /belongs to another Profile/);

    await writeFile(manifestPath, Buffer.alloc(300 * 1024, 0x20));
    await assert.rejects(() => listBackups(context.profile.id), /exceeds the 262144-byte read limit/);
  });
});

test("list has a hard manifest-count bound before parsing an attacker-sized directory", async () => {
  await withBackupFixture("zts-backup-list-bound", { "zen-sessions.jsonlz4": "session" }, async ({ context }) => {
    await createBackup(context, "zts backup");
    const root = backupRootForProfile(context.profile.id);
    for (let start = 0; start < 2_049; start += 128) {
      const end = Math.min(start + 128, 2_049);
      await Promise.all(Array.from({ length: end - start }, (_, offset) =>
        writeFile(join(root, `attacker-${String(start + offset).padStart(4, "0")}--manifest.json`), "{}\n", { mode: 0o600 })
      ));
    }
    await assert.rejects(() => listBackups(context.profile.id), /exceeds the 2048-manifest list limit/);
  });
});

test("creation refuses at the bounded backup count before reserving an id", async () => {
  await withBackupFixture("zts-backup-create-count", { "zen-sessions.jsonlz4": "session" }, async ({ context }) => {
    await createBackup(context, "zts backup first", {
      capacityPolicy: { maxBackups: 1 }
    });
    const root = backupRootForProfile(context.profile.id);
    const before = (await readdir(root)).sort();

    await assert.rejects(
      () => createBackup(context, "zts backup blocked", {
        capacityPolicy: { maxBackups: 1 }
      }),
      /already contains 1 backup.*zts backup prune/
    );
    assert.deepEqual((await readdir(root)).sort(), before);
  });
});

test("creation reserves exact source bytes and refuses before exceeding the backup store cap", async () => {
  await withBackupFixture("zts-backup-create-cap", { "zen-sessions.jsonlz4": "1234567" }, async ({ context }) => {
    await assert.rejects(
      () => createBackup(context, "zts backup blocked", {
        capacityPolicy: { maxStoreBytes: 1 }
      }),
      /backup store cap.*7 B exact current source data.*zts backup prune/i
    );
    assert.deepEqual(await readdir(backupRootForProfile(context.profile.id)), [".backup-control.lock"]);
  });
});

test("creation preserves an explicit filesystem free-space floor before reserving an id", async () => {
  await withBackupFixture("zts-backup-create-free", { "zen-sessions.jsonlz4": "session" }, async ({ context }) => {
    await assert.rejects(
      () => createBackup(context, "zts backup blocked", {
        capacityPolicy: { minimumFreeBytes: Number.MAX_SAFE_INTEGER }
      }),
      /preserving .* free.*zts backup prune.*free disk space/i
    );
    assert.deepEqual(await readdir(backupRootForProfile(context.profile.id)), [".backup-control.lock"]);
  });
});

test("creation rejects a source one byte above the 64 MiB per-source ceiling before reserving an id", async () => {
  await withBackupFixture("zts-backup-source-ceiling", { "zen-sessions.jsonlz4": "x" }, async ({ context, sessionPath }) => {
    await truncate(sessionPath, BACKUP_SOURCE_LIMIT_BYTES + 1);

    await assert.rejects(
      () => createBackup(context, "zts backup source-ceiling"),
      /exceeds the 67108864-byte limit/
    );
    assert.deepEqual(await readdir(backupRootForProfile(context.profile.id)), [".backup-control.lock"]);
  });
});

test("creation accepts a source exactly at the 64 MiB per-source ceiling", async () => {
  await withBackupFixture("zts-backup-source-boundary", { "zen-sessions.jsonlz4": "x" }, async ({ context, sessionPath }) => {
    await truncate(sessionPath, BACKUP_SOURCE_LIMIT_BYTES);

    const manifest = await createBackup(context, "zts backup source-boundary");
    assert.equal(manifest.files.length, 1);
    assert.equal(manifest.files[0].size, BACKUP_SOURCE_LIMIT_BYTES);
    assert.equal((await stat(manifest.files[0].backup)).size, BACKUP_SOURCE_LIMIT_BYTES);
  });
});

test("source growth after admission exceeds the cumulative budget and rolls back before publication", async () => {
  await withBackupFixture("zts-backup-create-growth", { "zen-sessions.jsonlz4": "before" }, async ({ context, sessionPath }) => {
    await assert.rejects(
      () => createBackup(context, "zts backup growth", {
        afterCapacityAdmission: () => appendFileSync(sessionPath, "-grew")
      }),
      /exceeds its cumulative capacity admission budget/
    );
    assert.equal(await readFile(sessionPath, "utf8"), "before-grew");
    assert.deepEqual(await listBackups(context.profile.id), []);
    assert.deepEqual(
      (await readdir(backupRootForProfile(context.profile.id))).filter((entry) =>
        entry.endsWith(".bak") || entry.endsWith("--manifest.json") || entry.endsWith("--create-intent.json")
      ),
      []
    );
  });
});

test("one-byte source growth after the stable open-handle stat is detected before publication", async () => {
  await withBackupFixture("zts-backup-read-growth", { "zen-sessions.jsonlz4": "before" }, async ({ context, sessionPath }) => {
    await assert.rejects(
      () => createBackup(context, "zts backup read-growth", {
        afterSourceStat: (source) => {
          if (source === sessionPath) appendFileSync(sessionPath, "x");
        }
      }),
      /source changed while being read/
    );
    assert.equal(await readFile(sessionPath, "utf8"), "beforex");
    assert.deepEqual(await listBackups(context.profile.id), []);
    assert.deepEqual(
      (await readdir(backupRootForProfile(context.profile.id))).filter((entry) =>
        entry.endsWith(".bak") || entry.endsWith("--manifest.json") || entry.endsWith("--create-intent.json")
      ),
      []
    );
  });
});

test("source publication rechecks simulated free-space loss and rolls back before writing data", async () => {
  await withBackupFixture("zts-backup-create-publication-free", { "zen-sessions.jsonlz4": "session" }, async ({ context }) => {
    await assert.rejects(
      () => createBackup(context, "zts backup publication-free", {
        publicationCapacitySimulation: { maximumFreeBytes: 0 }
      }),
      /filesystem free space changed before source publication.*zts backup prune.*free disk space/i
    );
    assert.deepEqual(await listBackups(context.profile.id), []);
    assert.deepEqual(
      (await readdir(backupRootForProfile(context.profile.id))).filter((entry) =>
        entry.endsWith(".bak") || entry.endsWith("--manifest.json") || entry.endsWith("--create-intent.json")
      ),
      []
    );
  });
});

test("source publication rechecks a tightened store projection and rolls back before writing data", async () => {
  await withBackupFixture("zts-backup-create-publication-cap", { "zen-sessions.jsonlz4": "session" }, async ({ context }) => {
    await assert.rejects(
      () => createBackup(context, "zts backup publication-cap", {
        publicationCapacitySimulation: { additionalStoreBytes: 4 * 1024 * 1024 * 1024 }
      }),
      /store projection changed before source publication.*zts backup prune/i
    );
    assert.deepEqual(await listBackups(context.profile.id), []);
    assert.deepEqual(
      (await readdir(backupRootForProfile(context.profile.id))).filter((entry) =>
        entry.endsWith(".bak") || entry.endsWith("--manifest.json") || entry.endsWith("--create-intent.json")
      ),
      []
    );
  });
});

test("backup refuses an empty Profile without publishing a zero-file manifest", async () => {
  await withBackupFixture("zts-backup-create-manifest-free", {}, async ({ context }) => {
    await assert.rejects(
      () => createBackup(context, "zts backup manifest-free", {
        publicationCapacitySimulation: { maximumFreeBytes: 0 }
      }),
      /captured no source files.*no manifest was published/i
    );
    assert.deepEqual(await listBackups(context.profile.id), []);
    assert.deepEqual(
      (await readdir(backupRootForProfile(context.profile.id))).filter((entry) =>
        entry.endsWith(".bak") || entry.endsWith("--manifest.json") || entry.endsWith("--create-intent.json")
      ),
      []
    );
  });
});

test("source rotation after admission rolls back instead of publishing a zero-file success", async () => {
  await withBackupFixture("zts-backup-source-rotation", allSources, async ({ context, profilePath }) => {
    await assert.rejects(
      () => createBackup(context, "zts backup source-rotation", {
        afterCapacityAdmission: () => {
          for (const relative of Object.keys(allSources)) {
            rmSync(join(profilePath, ...relative.split("/")));
          }
        }
      }),
      /captured no source files.*no manifest was published/i
    );
    assert.deepEqual(await listBackups(context.profile.id), []);
    assert.deepEqual(
      (await readdir(backupRootForProfile(context.profile.id))).filter((entry) =>
        entry.endsWith(".bak") || entry.endsWith("--manifest.json") || entry.endsWith("--create-intent.json")
      ),
      []
    );
  });
});

test("backup requires the authoritative primary source even when secondary sources remain", async () => {
  await withBackupFixture("zts-backup-primary-rotation", allSources, async ({ context, sessionPath }) => {
    await assert.rejects(
      () => createBackup(context, "zts backup primary-rotation", {
        afterCapacityAdmission: () => rmSync(sessionPath)
      }),
      /authoritative session source disappeared before capture/i
    );
    assert.deepEqual(await listBackups(context.profile.id), []);
  });
});

test("concurrent creators reserve unique ids and publish complete non-overlapping manifests", {
  skip: process.platform !== "darwin"
}, async () => {
  await withBackupFixture("zts-backup-concurrent", { "zen-sessions.jsonlz4": "session" }, async ({ context }) => {
    const manifests = await Promise.all(
      Array.from({ length: 8 }, (_, index) => createBackup(context, `zts backup fixture-${index}`))
    );
    assert.equal(new Set(manifests.map((manifest) => manifest.id)).size, manifests.length);
    const listed = await listBackups(context.profile.id);
    assert.equal(listed.length, manifests.length);
    assert.equal(new Set(listed.flatMap((manifest) => manifest.files.map((file) => file.backup))).size, manifests.length);
  });
});

test("backup list preserves a prelink control temp and the next controlled create reconciles it", {
  skip: process.platform !== "darwin"
}, async () => {
  await withBackupFixture("zts-backup-control-prelink", { "zen-sessions.jsonlz4": "session" }, async ({ context, stateDir }) => {
    const root = backupRootForProfile(context.profile.id);
    const profileSegment = root.slice(root.lastIndexOf("/") + 1);
    const script = [
      'import { createPrivateJsonExclusive, ensurePrivateDirectory, privatePath } from "./dist/private-store.js";',
      `const root = await ensurePrivateDirectory(${JSON.stringify(stateDir)}, "backups", ${JSON.stringify(profileSegment)});`,
      'await createPrivateJsonExclusive(privatePath(root, ".backup-control.lock"), { schemaVersion: "zts.kernel-lock-file.provisional-1" }, { afterTemporaryWrite: () => process.exit(97) });'
    ].join("\n");
    const crashed = spawnSync(process.execPath, ["--input-type=module", "--eval", script], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: process.env
    });
    assert.equal(crashed.status, 97, `${crashed.stdout}\n${crashed.stderr}`);
    const before = (await readdir(root)).filter((entry) => entry.startsWith(".tmp-"));
    assert.equal(before.length, 1);

    assert.deepEqual(await listBackups(context.profile.id), []);
    assert.deepEqual((await readdir(root)).filter((entry) => entry.startsWith(".tmp-")), before,
      "read-only listing must not delete the uncommitted control temporary");

    const created = await createBackup(context, "zts backup after control prelink crash");
    assert.equal(created.files.length, 1);
    assert.equal((await readdir(root)).some((entry) => entry.startsWith(".tmp-")), false);

    const linkedTemporary = join(root, ".tmp-00000000-0000-4000-8000-000000000098.artifact");
    await link(join(root, `${created.id}--manifest.json`), linkedTemporary);
    assert.equal((await stat(linkedTemporary)).nlink, 2);
    assert.equal((await listBackups(context.profile.id)).length, 1);
    assert.equal((await stat(linkedTemporary)).nlink, 2, "read-only listing must preserve committed residue");
    await createBackup(context, "zts backup after manifest link residue");
    await assert.rejects(() => lstat(linkedTemporary), /ENOENT/);
  });
});

test("backup list preserves prune-root standalone and linked temps until backup control reconciles them", {
  skip: process.platform !== "darwin"
}, async () => {
  await withBackupFixture("zts-backup-prune-temp", { "zen-sessions.jsonlz4": "session" }, async ({ context, stateDir }) => {
    await createBackup(context, "zts backup before prune temp fixture");
    const receipt = await pruneBackups(
      context.profile.id,
      new Date(Date.now() + 60_000),
      false,
      "zts backup prune temp fixture"
    );
    assert.ok(receipt.receiptPath);
    const pruneRoot = receipt.receiptPath.slice(0, receipt.receiptPath.lastIndexOf("/"));
    const linkedTemporary = join(pruneRoot, ".tmp-00000000-0000-4000-8000-000000000105.artifact");
    await link(receipt.receiptPath, linkedTemporary);
    const standaloneTarget = join(pruneRoot, "never-committed--receipt.json");
    const script = [
      'import { publishPrivateBytes } from "./dist/private-store.js";',
      `await publishPrivateBytes(${JSON.stringify(standaloneTarget)}, Buffer.from("uncommitted prune receipt"), 1024, { afterTemporaryWrite: () => process.exit(105) });`
    ].join("\n");
    const crashed = spawnSync(process.execPath, ["--input-type=module", "--eval", script], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...process.env, ZTS_STATE_DIR: stateDir }
    });
    assert.equal(crashed.status, 105, `${crashed.stdout}\n${crashed.stderr}`);
    const before = (await readdir(pruneRoot)).filter((entry) => entry.startsWith(".tmp-")).sort();
    assert.equal(before.length, 2);

    assert.deepEqual(await listBackups(context.profile.id), []);
    assert.deepEqual((await readdir(pruneRoot)).filter((entry) => entry.startsWith(".tmp-")).sort(), before);
    await createBackup(context, "zts backup after prune temp fixture");
    assert.equal((await readdir(pruneRoot)).some((entry) => entry.startsWith(".tmp-")), false);
  });
});

test("a killed create remains visible, then reconciles by exact intent before a new backup", {
  skip: process.platform !== "darwin"
}, async () => {
  await withBackupFixture("zts-backup-create-crash", { "zen-sessions.jsonlz4": "session" }, async ({ context }) => {
    const script = [
      'import { createBackup } from "./dist/backup.js";',
      `const context = ${JSON.stringify(context)};`,
      'await createBackup(context, "zts backup crash-fixture", { afterBackupFilePublished: () => process.exit(91) });'
    ].join("\n");
    const crashed = spawnSync(process.execPath, ["--input-type=module", "--eval", script], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: process.env
    });
    assert.equal(crashed.status, 91, `${crashed.stdout}\n${crashed.stderr}`);
    await assert.rejects(() => listBackups(context.profile.id), /incomplete creation intent/);
    await assert.rejects(
      () => createBackup(context, "zts backup after-crash"),
      /Previous backup creation required reconciliation/
    );
    assert.deepEqual(await listBackups(context.profile.id), []);
    const replacement = await createBackup(context, "zts backup after-reconciliation");
    assert.deepEqual((await listBackups(context.profile.id)).map((manifest) => manifest.id), [replacement.id]);
  });
});

test("prune dry-run is read-only and successful prune has intent-before-delete plus a durable receipt", {
  skip: process.platform !== "darwin"
}, async () => {
  await withBackupFixture("zts-backup-prune", { "zen-sessions.jsonlz4": "session" }, async ({ context }) => {
    const oldBackup = await createBackup(context, "zts backup old");
    await delay(12);
    const cutoff = new Date();
    await delay(12);
    const freshBackup = await createBackup(context, "zts backup fresh");

    const dryRun = await pruneBackups(context.profile.id, cutoff, true, "zts backup prune --dry-run");
    assert.equal(dryRun.outcome, "dry_run");
    assert.equal(dryRun.prunedCount, 1);
    assert.equal(dryRun.receiptPath, null);
    assert.equal((await listBackups(context.profile.id)).length, 2);

    let intentWasDurable = false;
    const receipt = await pruneBackups(context.profile.id, cutoff, false, "zts backup prune", {
      afterPruneIntentPublished: (path) => {
        intentWasDurable = true;
        assert.equal(path.endsWith("--intent.json"), true);
      }
    });
    assert.equal(intentWasDurable, true);
    assert.equal(receipt.outcome, "completed");
    assert.equal(receipt.prunedCount, 1);
    assert.ok(receipt.receiptPath);
    assert.equal((await stat(receipt.receiptPath)).mode & 0o777, 0o600);
    await assert.rejects(() => lstat(oldBackup.files[0].backup), /ENOENT/);
    assert.deepEqual((await listBackups(context.profile.id)).map((manifest) => manifest.id), [freshBackup.id]);
    assert.equal((await readdir(receipt.receiptPath.slice(0, receipt.receiptPath.lastIndexOf("/")))).some((entry) => entry.endsWith("--intent.json")), false);
  });
});

test("repeated no-op prune stays receipt-free and operable", {
  skip: process.platform !== "darwin"
}, async () => {
  await withBackupFixture("zts-backup-prune-noop", { "zen-sessions.jsonlz4": "session" }, async ({ context, stateDir }) => {
    for (let index = 0; index < 20; index += 1) {
      const result = await pruneBackups(
        context.profile.id,
        new Date(0),
        false,
        `zts backup prune no-op-${index}`,
        { pruneReceiptPolicy: { maxReceipts: 2, retentionMs: 0 } }
      );
      assert.equal(result.prunedCount, 0);
      assert.equal(result.receiptPath, null);
    }
    const [profileRoot] = await readdir(join(stateDir, "backup-prunes"));
    assert.ok(profileRoot);
    assert.deepEqual(await readdir(join(stateDir, "backup-prunes", profileRoot)), []);
    const created = await createBackup(context, "zts backup after no-op prunes");
    assert.equal(created.files.length, 1);
  });
});

test("terminal prune receipts compact under a strict retention policy and remain in backup accounting", {
  skip: process.platform !== "darwin"
}, async () => {
  await withBackupFixture("zts-backup-prune-retention", { "zen-sessions.jsonlz4": "session" }, async ({ context, stateDir }) => {
    for (let index = 0; index < 4; index += 1) {
      await createBackup(context, `zts backup retention-${index}`);
      const result = await pruneBackups(
        context.profile.id,
        new Date(Date.now() + 60_000),
        false,
        `zts backup prune retention-${index}`,
        { pruneReceiptPolicy: { maxReceipts: 2, retentionMs: 0 } }
      );
      assert.equal(result.prunedCount, 1);
      assert.ok(result.receiptPath);
    }
    const [profileRoot] = await readdir(join(stateDir, "backup-prunes"));
    const entries = await readdir(join(stateDir, "backup-prunes", profileRoot));
    assert.ok(entries.filter((entry) => entry.endsWith("--receipt.json")).length <= 1);
    assert.equal(entries.some((entry) => entry.endsWith("--intent.json")), false);
    await assert.doesNotReject(() => listBackups(context.profile.id));
  });
});

test("a killed prune cannot be silent and recovery completes only fingerprint-bound deletions with an interrupted receipt", {
  skip: process.platform !== "darwin"
}, async () => {
  await withBackupFixture("zts-backup-prune-crash", { "zen-sessions.jsonlz4": "session" }, async ({ context, stateDir }) => {
    await createBackup(context, "zts backup before-prune-crash");
    const cutoff = new Date(Date.now() + 60_000);
    const script = [
      'import { pruneBackups } from "./dist/backup.js";',
      `await pruneBackups(${JSON.stringify(context.profile.id)}, new Date(${JSON.stringify(cutoff.toISOString())}), false, "zts backup prune crash-fixture", { afterPruneFileRemoved: () => process.exit(92) });`
    ].join("\n");
    const crashed = spawnSync(process.execPath, ["--input-type=module", "--eval", script], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: process.env
    });
    assert.equal(crashed.status, 92, `${crashed.stdout}\n${crashed.stderr}`);
    await assert.rejects(() => listBackups(context.profile.id), /incomplete durable intent/);
    await assert.rejects(
      () => pruneBackups(context.profile.id, cutoff, false, "zts backup prune recover"),
      /Previous backup prune required reconciliation/
    );
    assert.deepEqual(await listBackups(context.profile.id), []);

    const profileSegment = `profile-${context.profile.id.slice("profile:".length)}`;
    const pruneRoot = join(stateDir, "backup-prunes", profileSegment);
    const entries = await readdir(pruneRoot);
    assert.equal(entries.some((entry) => entry.endsWith("--intent.json")), false);
    const receiptName = entries.find((entry) => entry.endsWith("--receipt.json"));
    assert.ok(receiptName);
    const receipt = JSON.parse(await readFile(join(pruneRoot, receiptName), "utf8"));
    assert.equal(receipt.outcome, "interrupted");
    assert.ok(receipt.candidates.flatMap((candidate) => candidate.files).every((file) => file.outcome === "deleted"));
  });
});

test("nested source parent symlinks are rejected rather than followed", async () => {
  await withBackupFixture("zts-backup-parent-link", { "zen-sessions.jsonlz4": "session" }, async ({ temp, profilePath, context }) => {
    const outside = join(temp, "outside-parent");
    await mkdir(outside);
    await writeFile(join(outside, "previous.jsonlz4"), "outside-previous");
    await symlink(outside, join(profilePath, "sessionstore-backups"));
    await assert.rejects(() => createBackup(context, "zts backup"), /source parent is not a real directory/);
    assert.equal(await readFile(join(outside, "previous.jsonlz4"), "utf8"), "outside-previous");
    assert.deepEqual(await listBackups(context.profile.id), []);
  });
});

test("artifact permission widening and manifest filename mismatch fail closed", async () => {
  await withBackupFixture("zts-backup-binding", { "zen-sessions.jsonlz4": "session" }, async ({ context }) => {
    const first = await createBackup(context, "zts backup first");
    const second = await createBackup(context, "zts backup second");
    const root = backupRootForProfile(context.profile.id);
    const firstPath = join(root, `${first.id}--manifest.json`);
    const secondPath = join(root, `${second.id}--manifest.json`);
    await writeFile(secondPath, await readFile(firstPath));
    await assert.rejects(() => listBackups(context.profile.id), /id does not match its filename/);

    await writeFile(secondPath, `${JSON.stringify(second)}\n`);
    await chmod(first.files[0].backup, 0o644);
    await assert.rejects(() => listBackups(context.profile.id), /permissions are not owner-only/);
  });
});
