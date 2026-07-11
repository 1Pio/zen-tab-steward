import { constants } from "node:fs";
import { randomUUID } from "node:crypto";
import { lstat, open, opendir, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { sha256Canonical } from "./domain/digest.js";
import { stateDir } from "./paths.js";
import { assertProcessOwner, currentProcessOwner, processOwnerIsActive } from "./process-owner.js";
import { assertProfileIdentity } from "./profile.js";
import {
  createPrivateJsonExclusive,
  ensurePrivateDirectory,
  inspectPrivateStandaloneTemporaryCandidate,
  isPrivateTemporaryBasename,
  privatePath,
  PrivatePublicationCommittedError,
  readPrivateJson,
  reconcilePrivatePublication,
  removePrivateStandaloneTemporaryCandidate
} from "./private-store.js";

import type { LegacyProfileIdentity, ZenProfile } from "./profile.js";
import type { Sha256Digest } from "./domain/digest.js";
import type { PrivatePublicationHooks } from "./private-store.js";

const LOCK_SCHEMA = "zts.profile-transaction-lock.provisional-2" as const;

interface LockRecord {
  readonly schemaVersion: typeof LOCK_SCHEMA;
  readonly token: string;
  readonly transactionId: string | null;
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

export type ProfileLockInspection =
  | {
      readonly status: "absent";
      readonly lockPath: string;
      readonly artifactRevision: null;
      readonly pid: null;
      readonly acquiredAt: null;
      readonly transactionId: null;
      readonly commandRevision: null;
    }
  | {
      readonly status: "active" | "stale";
      readonly lockPath: string;
      readonly artifactRevision: Sha256Digest;
      readonly pid: number;
      readonly acquiredAt: string;
      readonly transactionId: string | null;
      readonly commandRevision: Sha256Digest;
    }
  | {
      readonly status: "invalid";
      readonly lockPath: string;
      readonly artifactRevision: null;
      readonly pid: null;
      readonly acquiredAt: null;
      readonly transactionId: null;
      readonly commandRevision: null;
      readonly blocker: string;
    };

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

export class ProfileLockAcquisitionUncertainError extends Error {
  readonly lockPath: string;
  readonly cause: unknown;

  constructor(lockPath: string, cause: unknown) {
    super(`Profile lock publication may have committed but ownership recovery failed: ${lockPath}`);
    this.name = "ProfileLockAcquisitionUncertainError";
    this.lockPath = lockPath;
    this.cause = cause;
  }
}

export async function acquireProfileTransactionLock(
  profile: ZenProfile,
  command: string,
  now = new Date(),
  transactionId: string | null = null,
  publicationHooks: PrivatePublicationHooks = {}
): Promise<ProfileTransactionLock> {
  assertProfileIdentity(profile);
  if (!profile.id.trim() || !profile.path.trim()) throw new Error("Profile transaction lock requires an exact Profile");
  const acquiredAt = canonicalTimestamp(now);
  const token = randomUUID();
  const owner = await currentProcessOwner();
  const root = await ensurePrivateDirectory(stateDir(), "locks");
  const lockPath = lockPathForProfile(profile, root);
  const record: LockRecord = {
    schemaVersion: LOCK_SCHEMA,
    token,
    transactionId,
    profileId: profile.id,
    profilePathRevision: sha256Canonical({ profilePath: profile.path }),
    ...owner,
    acquiredAt,
    commandRevision: sha256Canonical({ command })
  };
  let created: boolean;
  try {
    created = await createPrivateJsonExclusive(lockPath, record, publicationHooks);
  } catch (error) {
    if (!(error instanceof PrivatePublicationCommittedError) || error.path !== lockPath) throw error;
    if (!error.canonicalPathStillNamesPublication) {
      throw new ProfileLockAcquisitionUncertainError(
        lockPath,
        new AggregateError([error], "Profile lock canonical path no longer names the published inode")
      );
    }
    try {
      await reconcilePrivatePublication(lockPath);
      const current = defineLockRecord(await readPrivateJson(lockPath));
      if (sha256Canonical(current) !== sha256Canonical(record) || current.token !== token) {
        throw new Error("Committed Profile lock does not match the acquiring transaction");
      }
      await syncDirectory(dirname(lockPath));
      created = true;
    } catch (recoveryError) {
      throw new ProfileLockAcquisitionUncertainError(
        lockPath,
        new AggregateError([error, recoveryError], "Profile lock publication and ownership recovery failed")
      );
    }
  }
  if (!created) throw await describeExistingLock(lockPath);
  try {
    await reconcileProfileLockPublicationLosers(root, profile, lockPath, record);
  } catch (error) {
    // Do not strand the just-acquired canonical lock when owner-temp cleanup
    // fails. Remove only our exact token before surfacing bounded recovery.
    try {
      const current = defineLockRecord(await readPrivateJson(lockPath));
      if (current.token === token && current.pid === process.pid) {
        await rm(lockPath);
        await syncDirectory(root);
      }
    } catch (cleanupError) {
      throw new ProfileLockAcquisitionUncertainError(
        lockPath,
        new AggregateError([error, cleanupError], "Profile lock temporary reconciliation and canonical rollback both failed")
      );
    }
    throw new ProfileLockAcquisitionUncertainError(lockPath, error);
  }

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

async function reconcileProfileLockPublicationLosers(
  root: string,
  profile: ZenProfile,
  lockPath: string,
  owner: LockRecord
): Promise<void> {
  const directory = await opendir(root);
  let entries = 0;
  try {
    for await (const entry of directory) {
      entries += 1;
      if (entries > 16_384) {
        throw new Error("Profile lock root exceeds the 16384-entry reconciliation bound");
      }
      if (!isPrivateTemporaryBasename(entry.name)) continue;
      const path = privatePath(root, entry.name);
      const metadata = await lstat(path);
      if (metadata.nlink !== 1) continue;
      const candidate = await inspectPrivateStandaloneTemporaryCandidate(path, 64 * 1024);
      let displaced: LockRecord;
      try {
        displaced = defineLockRecord(await readPrivateJson(path, 64 * 1024));
      } catch {
        // Without a valid lock record this temporary cannot be bound to the
        // selected Profile. Preserve it for explicit diagnostics.
        continue;
      }
      if (displaced.profileId !== profile.id) continue;
      const current = defineLockRecord(await readPrivateJson(lockPath, 64 * 1024));
      if (current.token !== owner.token || current.pid !== owner.pid) {
        throw new Error("Profile lock ownership changed during temporary reconciliation");
      }
      await removePrivateStandaloneTemporaryCandidate(candidate);
    }
  } finally {
    await directory.close().catch(() => undefined);
  }
}

export async function inspectProfileTransactionLock(profile: ZenProfile): Promise<ProfileLockInspection> {
  assertProfileIdentity(profile);
  const lockPath = lockPathForProfile(profile);
  let value: unknown;
  try {
    value = await readPrivateJson(lockPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {
        status: "absent",
        lockPath,
        artifactRevision: null,
        pid: null,
        acquiredAt: null,
        transactionId: null,
        commandRevision: null
      };
    }
    return {
      status: "invalid",
      lockPath,
      artifactRevision: null,
      pid: null,
      acquiredAt: null,
      transactionId: null,
      commandRevision: null,
      blocker: error instanceof Error ? error.message : String(error)
    };
  }
  try {
    const record = defineLockRecord(value);
    const expectedPathRevision = sha256Canonical({ profilePath: profile.path });
    if (record.profileId !== profile.id || record.profilePathRevision !== expectedPathRevision) {
      throw new Error("Profile lock identity does not match the selected Profile");
    }
    return {
      status: await lockOwnerIsActive(record) ? "active" : "stale",
      lockPath,
      artifactRevision: sha256Canonical(record),
      pid: record.pid,
      acquiredAt: record.acquiredAt,
      transactionId: record.transactionId,
      commandRevision: record.commandRevision
    };
  } catch (error) {
    return {
      status: "invalid",
      lockPath,
      artifactRevision: null,
      pid: null,
      acquiredAt: null,
      transactionId: null,
      commandRevision: null,
      blocker: error instanceof Error ? error.message : String(error)
    };
  }
}

export async function releaseStaleProfileTransactionLock(
  profile: ZenProfile,
  expectedRevision: Sha256Digest
): Promise<{ readonly releasedAt: string }> {
  const inspection = await inspectProfileTransactionLock(profile);
  if (inspection.status !== "stale") {
    throw new Error(`Stale Profile lock release requires stale status; observed ${inspection.status}`);
  }
  if (inspection.artifactRevision !== expectedRevision) {
    throw new Error("Stale Profile lock revision does not match the recovery journal");
  }
  const current = defineLockRecord(await readPrivateJson(inspection.lockPath));
  if (sha256Canonical(current) !== expectedRevision || await lockOwnerIsActive(current)) {
    throw new Error("Profile lock changed or became active before stale release");
  }
  await rm(inspection.lockPath);
  await syncDirectory(dirname(inspection.lockPath));
  return { releasedAt: new Date().toISOString() };
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
  return processOwnerIsActive(record);
}

function defineLockRecord(value: unknown): LockRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Profile lock must be an object");
  const keys = Object.keys(value).sort();
  const expected = [
    "schemaVersion",
    "token",
    "transactionId",
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
  if (record.transactionId !== null && !record.transactionId.trim()) {
    throw new Error("Profile lock transaction id is invalid");
  }
  assertProcessOwner(record, "Profile lock");
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

function lockPathForProfile(profile: ZenProfile, root = privatePath(stateDir(), "locks")): string {
  const profileKey = digestHex(sha256Canonical({ profileId: profile.id }));
  return privatePath(root, `profile-${profileKey}.json`);
}

export function legacyProfileTransactionLockPath(identity: LegacyProfileIdentity): string {
  const profileKey = digestHex(sha256Canonical({
    profileId: identity.profileId,
    profilePath: identity.profilePath
  }));
  return privatePath(stateDir(), "locks", `profile-${profileKey}.json`);
}

function canonicalTimestamp(value: Date): string {
  if (!Number.isFinite(value.getTime())) throw new Error("Profile lock timestamp must be valid");
  return value.toISOString();
}

function assertDigest(value: string, label: string): asserts value is Sha256Digest {
  if (!/^sha256:[a-f0-9]{64}$/u.test(value)) throw new Error(`${label} must be a canonical SHA-256 digest`);
}
