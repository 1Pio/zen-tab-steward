import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBackup, listBackups } from "../dist/backup.js";

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
