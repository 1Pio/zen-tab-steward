import { constants } from "node:fs";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { open, readFile, rm } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname } from "node:path";
import { promisify } from "node:util";
import { sha256Canonical } from "./domain/digest.js";
import { stateDir } from "./paths.js";
import {
  createPrivateJsonExclusive,
  ensurePrivateDirectory,
  privatePath,
  readPrivateJson
} from "./private-store.js";

import type { ZenProfile } from "./profile.js";
import type { Sha256Digest } from "./domain/digest.js";

const execFileAsync = promisify(execFile);
const LOCK_SCHEMA = "zts.profile-transaction-lock.provisional-1" as const;

interface LockRecord {
  readonly schemaVersion: typeof LOCK_SCHEMA;
  readonly token: string;
  readonly profileId: string;
  readonly profilePathRevision: Sha256Digest;
  readonly pid: number;
  readonly processStartIdentity: string | null;
  readonly host: string;
  readonly acquiredAt: string;
  readonly commandRevision: Sha256Digest;
}

export interface ProfileTransactionLock {
  readonly token: string;
  readonly acquiredAt: string;
  readonly artifactRevision: Sha256Digest;
  release(): Promise<{ readonly releasedAt: string }>;
}

export class ProfileLockError extends Error {
  readonly code: "PROFILE_LOCK_ACTIVE" | "PROFILE_LOCK_STALE" | "PROFILE_LOCK_INVALID";
  readonly lockPath: string;

  constructor(code: ProfileLockError["code"], message: string, lockPath: string) {
    super(message);
    this.name = "ProfileLockError";
    this.code = code;
    this.lockPath = lockPath;
  }
}

export async function acquireProfileTransactionLock(
  profile: ZenProfile,
  command: string,
  now = new Date()
): Promise<ProfileTransactionLock> {
  if (!profile.id.trim() || !profile.path.trim()) throw new Error("Profile transaction lock requires an exact Profile");
  const acquiredAt = canonicalTimestamp(now);
  const token = randomUUID();
  const root = await ensurePrivateDirectory(stateDir(), "locks");
  const profileKey = digestHex(sha256Canonical({ profileId: profile.id, profilePath: profile.path }));
  const lockPath = privatePath(root, `profile-${profileKey}.json`);
  const record: LockRecord = {
    schemaVersion: LOCK_SCHEMA,
    token,
    profileId: profile.id,
    profilePathRevision: sha256Canonical({ profilePath: profile.path }),
    pid: process.pid,
    processStartIdentity: await processStartIdentity(process.pid),
    host: hostname(),
    acquiredAt,
    commandRevision: sha256Canonical({ command })
  };
  const created = await createPrivateJsonExclusive(lockPath, record);
  if (!created) throw await describeExistingLock(lockPath);

  let released = false;
  return {
    token,
    acquiredAt,
    artifactRevision: sha256Canonical(record),
    async release() {
      if (released) throw new Error("Profile transaction lock has already been released");
      const current = defineLockRecord(await readPrivateJson(lockPath));
      if (current.token !== token || current.pid !== process.pid || current.profileId !== profile.id) {
        throw new Error("Profile transaction lock ownership changed before release");
      }
      await rm(lockPath);
      await syncDirectory(dirname(lockPath));
      released = true;
      return { releasedAt: new Date().toISOString() };
    }
  };
}

async function describeExistingLock(lockPath: string): Promise<ProfileLockError> {
  let record: LockRecord;
  try {
    record = defineLockRecord(await readPrivateJson(lockPath));
  } catch (error) {
    return new ProfileLockError(
      "PROFILE_LOCK_INVALID",
      `Profile transaction lock is unreadable or invalid and was left in place: ${error instanceof Error ? error.message : String(error)}`,
      lockPath
    );
  }
  const active = await lockOwnerIsActive(record);
  return new ProfileLockError(
    active ? "PROFILE_LOCK_ACTIVE" : "PROFILE_LOCK_STALE",
    active
      ? `Another zts Apply Transaction owns this Profile lock (pid ${record.pid}, acquired ${record.acquiredAt})`
      : `A stale zts Profile lock was detected (pid ${record.pid}, acquired ${record.acquiredAt}); it was left in place for explicit recovery`,
    lockPath
  );
}

async function lockOwnerIsActive(record: LockRecord): Promise<boolean> {
  if (record.host !== hostname()) return true;
  try {
    process.kill(record.pid, 0);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return false;
    return true;
  }
  const observedStart = await processStartIdentity(record.pid);
  if (record.processStartIdentity && observedStart) return record.processStartIdentity === observedStart;
  return true;
}

async function processStartIdentity(pid: number): Promise<string | null> {
  if (process.platform === "linux") {
    try {
      const stat = await readFile(`/proc/${pid}/stat`, "utf8");
      const close = stat.lastIndexOf(")");
      if (close === -1) return null;
      const fields = stat.slice(close + 2).trim().split(/\s+/u);
      const startTicks = fields[19];
      return startTicks ? `linux-start-ticks:${startTicks}` : null;
    } catch {
      return null;
    }
  }
  try {
    const { stdout } = await execFileAsync("/bin/ps", ["-p", String(pid), "-o", "lstart="], {
      maxBuffer: 64 * 1024
    });
    const start = stdout.trim();
    return start ? `ps-lstart:${start}` : null;
  } catch {
    return null;
  }
}

function defineLockRecord(value: unknown): LockRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Profile lock must be an object");
  const keys = Object.keys(value).sort();
  const expected = [
    "schemaVersion",
    "token",
    "profileId",
    "profilePathRevision",
    "pid",
    "processStartIdentity",
    "host",
    "acquiredAt",
    "commandRevision"
  ].sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw new Error("Profile lock contains unknown or missing fields");
  }
  const record = value as LockRecord;
  if (record.schemaVersion !== LOCK_SCHEMA || !record.token.trim() || !record.profileId.trim() || !record.host.trim()) {
    throw new Error("Profile lock has invalid identity");
  }
  if (!Number.isSafeInteger(record.pid) || record.pid <= 0) throw new Error("Profile lock pid is invalid");
  if (record.processStartIdentity !== null && !record.processStartIdentity.trim()) {
    throw new Error("Profile lock process start identity is invalid");
  }
  assertDigest(record.profilePathRevision, "Profile lock path revision");
  assertDigest(record.commandRevision, "Profile lock command revision");
  canonicalTimestamp(new Date(record.acquiredAt));
  return record;
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function digestHex(digest: Sha256Digest): string {
  return digest.slice("sha256:".length);
}

function canonicalTimestamp(value: Date): string {
  if (!Number.isFinite(value.getTime())) throw new Error("Profile lock timestamp must be valid");
  return value.toISOString();
}

function assertDigest(value: string, label: string): asserts value is Sha256Digest {
  if (!/^sha256:[a-f0-9]{64}$/u.test(value)) throw new Error(`${label} must be a canonical SHA-256 digest`);
}
