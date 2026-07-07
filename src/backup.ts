import { createHash } from "node:crypto";
import { mkdir, readdir, stat, copyFile, readFile, writeFile, rename } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { stateDir } from "./paths.js";
import { ProfileContext } from "./profile.js";
import { VERSION } from "./version.js";

export interface BackupFileReceipt {
  source: string;
  backup: string;
  size: number;
  sha256: string;
}

export interface BackupManifest {
  id: string;
  createdAt: string;
  profilePath: string;
  profileId: string;
  zenRunning: boolean;
  command: string;
  ztsVersion: string;
  files: BackupFileReceipt[];
}

export interface RestoreFileReceipt {
  source: string;
  backup: string;
  size: number;
  sha256: string;
  verified: boolean;
}

export interface RestoreReceipt {
  id: string;
  createdAt: string;
  profilePath: string;
  profileId: string;
  restoredBackupId: string;
  safetyBackupId: string;
  command: string;
  ztsVersion: string;
  files: RestoreFileReceipt[];
  receiptPath: string;
}

export function backupRootForProfile(profileId: string): string {
  return join(stateDir(), "backups", sanitizePathSegment(profileId));
}

export async function createBackup(context: ProfileContext, command: string): Promise<BackupManifest> {
  const backupRoot = backupRootForProfile(context.profile.id);
  await mkdir(backupRoot, { recursive: true });
  const { id, createdAt } = await nextBackupId(backupRoot);

  const files: BackupFileReceipt[] = [];
  for (const source of backupSources(context.profile.path)) {
    try {
      const details = await stat(source);
      if (!details.isFile()) continue;
      const backup = join(backupRoot, `${id}--${basename(source)}.bak`);
      await copyFile(source, backup);
      const backupDetails = await stat(backup);
      files.push({
        source,
        backup,
        size: backupDetails.size,
        sha256: await sha256(backup)
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  const manifest: BackupManifest = {
    id,
    createdAt,
    profilePath: context.profile.path,
    profileId: context.profile.id,
    zenRunning: context.running,
    command,
    ztsVersion: VERSION,
    files
  };

  await writeFile(
    join(backupRoot, `${id}--manifest.json`),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8"
  );

  return manifest;
}

export async function restoreBackup(context: ProfileContext, backupId: string | undefined, command: string): Promise<RestoreReceipt> {
  if (!backupId) throw new Error("Backup id is required");
  if (context.running) throw new Error("Restore is refused because Zen is running");

  const manifest = await findBackup(context.profile.id, backupId);
  if (!manifest) throw new Error(`Backup not found: ${backupId}`);
  if (manifest.profilePath !== context.profile.path) {
    throw new Error(`Backup ${backupId} belongs to a different profile path`);
  }

  const backupRoot = backupRootForProfile(context.profile.id);
  const expectedSources = new Set(backupSources(context.profile.path));
  const restoreFiles = await preflightRestoreFiles(manifest, expectedSources, backupRoot);
  const safetyBackup = await createBackup(context, `${command} safety-backup`);
  const files: RestoreFileReceipt[] = [];

  for (const file of restoreFiles) {
    await mkdir(dirname(file.source), { recursive: true });
    const tempPath = join(dirname(file.source), `.zts-restore-${process.pid}-${Date.now()}-${basename(file.source)}.tmp`);
    await copyFile(file.backup, tempPath);
    await rename(tempPath, file.source);
    const restoredHash = await sha256(file.source);
    if (restoredHash !== file.sha256) {
      throw new Error(`Restore verification failed for ${file.source}`);
    }
    files.push({
      source: file.source,
      backup: file.backup,
      size: file.size,
      sha256: file.sha256,
      verified: true
    });
  }

  const createdAt = new Date().toISOString();
  const id = createdAt;
  const receiptRoot = join(stateDir(), "restores", sanitizePathSegment(context.profile.id));
  await mkdir(receiptRoot, { recursive: true });
  const receiptPath = join(receiptRoot, `${id}--restore.json`);
  const receipt: RestoreReceipt = {
    id,
    createdAt,
    profilePath: context.profile.path,
    profileId: context.profile.id,
    restoredBackupId: manifest.id,
    safetyBackupId: safetyBackup.id,
    command,
    ztsVersion: VERSION,
    files,
    receiptPath
  };
  await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
  return receipt;
}

async function preflightRestoreFiles(
  manifest: BackupManifest,
  expectedSources: Set<string>,
  backupRoot: string
): Promise<BackupFileReceipt[]> {
  for (const file of manifest.files) {
    if (!expectedSources.has(file.source)) {
      throw new Error(`Backup ${manifest.id} contains an unexpected restore target: ${file.source}`);
    }
    if (!isPathInside(file.backup, backupRoot)) {
      throw new Error(`Backup ${manifest.id} contains an unexpected backup path: ${file.backup}`);
    }
    const details = await stat(file.backup);
    if (!details.isFile()) {
      throw new Error(`Backup ${manifest.id} contains a non-file backup path: ${file.backup}`);
    }
    if (details.size !== file.size) {
      throw new Error(`Backup size mismatch for ${file.backup}`);
    }
    const backupHash = await sha256(file.backup);
    if (backupHash !== file.sha256) {
      throw new Error(`Backup hash mismatch for ${file.backup}`);
    }
  }
  return manifest.files;
}

export async function listBackups(profileId: string): Promise<BackupManifest[]> {
  const root = backupRootForProfile(profileId);
  try {
    const entries = await readdir(root);
    const manifests = entries.filter((entry) => entry.endsWith("--manifest.json")).sort().reverse();
    const parsed: BackupManifest[] = [];
    for (const manifest of manifests) {
      parsed.push(JSON.parse(await readFile(join(root, manifest), "utf8")) as BackupManifest);
    }
    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function findBackup(profileId: string, backupId: string): Promise<BackupManifest | null> {
  const backups = await listBackups(profileId);
  return backups.find((backup) => backup.id === backupId) ?? null;
}

function backupSources(profilePath: string): string[] {
  return [
    join(profilePath, "zen-sessions.jsonlz4"),
    join(profilePath, "zen-live-folders.jsonlz4"),
    join(profilePath, "sessionstore-backups", "recovery.jsonlz4"),
    join(profilePath, "sessionstore-backups", "previous.jsonlz4")
  ];
}

async function nextBackupId(backupRoot: string): Promise<{ id: string; createdAt: string }> {
  const createdAt = new Date().toISOString();
  let id = createdAt;
  let suffix = 1;
  while (await exists(join(backupRoot, `${id}--manifest.json`))) {
    id = `${createdAt}-${suffix}`;
    suffix += 1;
  }
  return { id, createdAt };
}

function sanitizePathSegment(segment: string): string {
  return segment.replace(/[^a-zA-Z0-9._ -]/g, "_");
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function isPathInside(child: string, parent: string): boolean {
  const relation = relative(resolve(parent), resolve(child));
  return relation.length === 0 || (!relation.startsWith("..") && !relation.startsWith("/"));
}

async function sha256(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}
