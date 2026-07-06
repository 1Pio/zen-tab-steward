import { createHash } from "node:crypto";
import { mkdir, readdir, stat, copyFile, readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
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

export function backupRootForProfile(profileId: string): string {
  return join(stateDir(), "backups", sanitizePathSegment(profileId));
}

export async function createBackup(context: ProfileContext, command: string): Promise<BackupManifest> {
  const createdAt = new Date().toISOString();
  const id = createdAt;
  const backupRoot = backupRootForProfile(context.profile.id);
  await mkdir(backupRoot, { recursive: true });

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

function backupSources(profilePath: string): string[] {
  return [
    join(profilePath, "zen-sessions.jsonlz4"),
    join(profilePath, "zen-live-folders.jsonlz4"),
    join(profilePath, "sessionstore-backups", "recovery.jsonlz4"),
    join(profilePath, "sessionstore-backups", "previous.jsonlz4")
  ];
}

function sanitizePathSegment(segment: string): string {
  return segment.replace(/[^a-zA-Z0-9._ -]/g, "_");
}

async function sha256(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}
