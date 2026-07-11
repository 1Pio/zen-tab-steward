import { createHash, randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { lstat, open, opendir, statfs } from "node:fs/promises";
import { isAbsolute, resolve, sep } from "node:path";
import { acquireExclusiveFileControl } from "./exclusive-control.js";
import { stateDir } from "./paths.js";
import {
  assertPrivateDirectory,
  createPrivateJsonExclusive,
  ensurePrivateDirectory,
  inspectPrivateStandaloneTemporaryCandidate,
  isPrivateTemporaryBasename,
  privatePath,
  publishOwnedPrivateBytes,
  publishPrivateJson,
  readPrivateBytes,
  readPrivateJson,
  reconcilePrivatePublication,
  removePrivateFile,
  removePrivateStandaloneTemporaryCandidate,
  replacePrivateJson
} from "./private-store.js";
import {
  assertProfileIdentity,
  canonicalProfilePath,
  profileIdForPath,
  type ProfileContext
} from "./profile.js";
import { VERSION } from "./version.js";

const BACKUP_MANIFEST_SCHEMA = "zts.backup-manifest.v1" as const;
const BACKUP_CREATE_INTENT_SCHEMA = "zts.backup-create-intent.v1" as const;
const BACKUP_PRUNE_INTENT_SCHEMA = "zts.backup-prune-intent.v1" as const;
const BACKUP_PRUNE_RECEIPT_SCHEMA = "zts.backup-prune-receipt.v1" as const;
const KERNEL_LOCK_FILE_SCHEMA = "zts.kernel-lock-file.provisional-1" as const;

const MAX_BACKUP_BYTES = 64 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 256 * 1024;
const MAX_LIST_MANIFEST_BYTES = 16 * 1024 * 1024;
const MAX_PRUNE_ARTIFACT_BYTES = 12 * 1024 * 1024;
const MAX_DIRECTORY_ENTRIES = 16_384;
const MAX_BACKUPS = 2_048;
const MAX_COMMAND_BYTES = 4_096;
const MAX_PATH_BYTES = 8_192;
const MEBIBYTE = 1024 * 1024;
// Backups are safety artifacts, not an unbounded archive. Bound the complete
// per-Profile store and keep an independent filesystem floor.
const MAX_BACKUP_STORE_BYTES = 4 * 1024 * MEBIBYTE;
const MINIMUM_BACKUP_FILESYSTEM_FREE_BYTES = 512 * MEBIBYTE;
// The store can transiently contain one creation intent, one committed
// manifest, and the later intent-replacement temporary at the same time.
const BACKUP_STORE_METADATA_RESERVATION_BYTES = 3 * MAX_MANIFEST_BYTES;
const BACKUP_FILESYSTEM_METADATA_RESERVATION_BYTES = 3 * MAX_MANIFEST_BYTES;
const BACKUP_PRUNE_GUIDANCE = "preview with zts backup prune --dry-run --older-than 30d, then repeat without --dry-run";
const PRUNE_RECEIPT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_RETAINED_PRUNE_RECEIPTS = 8_192;

const BACKUP_ID_PATTERN = /^backup-\d{8}T\d{9}Z-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const PRUNE_ID_PATTERN = /^prune-\d{8}T\d{9}Z-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;

interface BackupSourceSpec {
  readonly token: string;
  readonly relative: readonly string[];
}

const BACKUP_SOURCE_SPECS: readonly BackupSourceSpec[] = Object.freeze([
  { token: "zen-sessions.jsonlz4", relative: ["zen-sessions.jsonlz4"] },
  { token: "zen-live-folders.jsonlz4", relative: ["zen-live-folders.jsonlz4"] },
  { token: "sessionstore-backups.recovery.jsonlz4", relative: ["sessionstore-backups", "recovery.jsonlz4"] },
  { token: "sessionstore-backups.previous.jsonlz4", relative: ["sessionstore-backups", "previous.jsonlz4"] }
]);

export interface FileFingerprint {
  readonly device: number;
  readonly inode: number;
  readonly size: number;
  readonly modifiedMs: number;
  readonly changedMs: number;
}

export interface BackupFileReceipt {
  readonly source: string;
  readonly backup: string;
  readonly size: number;
  readonly sha256: string;
  readonly sourceFingerprint: FileFingerprint;
}

export interface BackupManifest {
  readonly schemaVersion: typeof BACKUP_MANIFEST_SCHEMA;
  readonly id: string;
  readonly createdAt: string;
  readonly profilePath: string;
  readonly profileId: string;
  readonly primarySource: string;
  readonly zenRunning: boolean;
  readonly command: string;
  readonly ztsVersion: string;
  readonly files: readonly BackupFileReceipt[];
}

export interface RestorePreview {
  readonly backupId: string;
  readonly profileId: string;
  readonly profilePath: string;
  readonly files: readonly BackupFileReceipt[];
  readonly executable: false;
  readonly blocker: string;
}

export type BackupPruneFileOutcome = "planned" | "deleted" | "retained" | "changed";

export interface BackupPruneFile {
  readonly path: string;
  readonly size: number;
  readonly kind: "backup" | "manifest";
  readonly fingerprint: FileFingerprint;
  readonly outcome: BackupPruneFileOutcome;
}

export interface BackupPruneCandidate {
  readonly backupId: string;
  readonly createdAt: string;
  readonly files: readonly BackupPruneFile[];
}

export interface BackupPruneReceipt {
  readonly schemaVersion: typeof BACKUP_PRUNE_RECEIPT_SCHEMA;
  readonly id: string;
  readonly createdAt: string;
  readonly profileId: string;
  readonly before: string;
  readonly dryRun: boolean;
  readonly outcome: "dry_run" | "completed" | "failed" | "interrupted";
  readonly command: string;
  readonly ztsVersion: string;
  readonly prunedCount: number;
  readonly retainedCount: number;
  readonly candidates: readonly BackupPruneCandidate[];
  readonly receiptPath: string | null;
  readonly failure: string | null;
}

/** Fault hooks are test-only seams. Production callers leave them undefined. */
export interface BackupStoreHooks {
  readonly afterCapacityAdmission?: () => void;
  readonly afterSourceStat?: (source: string, index: number) => void;
  readonly afterBackupFilePublished?: (path: string, index: number) => void;
  readonly afterManifestPublished?: (path: string) => void;
  readonly afterPruneIntentPublished?: (path: string) => void;
  readonly afterPruneFileRemoved?: (path: string, index: number) => void;
  /** Test-only seam. Values may tighten, but never relax, production admission. */
  readonly capacityPolicy?: {
    readonly maxBackups?: number;
    readonly maxStoreBytes?: number;
    readonly minimumFreeBytes?: number;
  };
  /** Test-only simulation. Values can only make publication admission stricter. */
  readonly publicationCapacitySimulation?: {
    readonly additionalStoreBytes?: number;
    readonly maximumFreeBytes?: number;
  };
  /** Test-only seam. Values may tighten, but never relax, production retention. */
  readonly pruneReceiptPolicy?: {
    readonly maxReceipts?: number;
    readonly retentionMs?: number;
  };
}

interface BackupCreateIntent {
  readonly schemaVersion: typeof BACKUP_CREATE_INTENT_SCHEMA;
  readonly id: string;
  readonly createdAt: string;
  readonly profileId: string;
  readonly profilePath: string;
  readonly manifestPath: string;
  readonly backupPaths: readonly string[];
  readonly phase: "preparing" | "manifest_committed" | "rollback_required";
  readonly failure: string | null;
}

interface BackupPruneIntent {
  readonly schemaVersion: typeof BACKUP_PRUNE_INTENT_SCHEMA;
  readonly id: string;
  readonly createdAt: string;
  readonly profileId: string;
  readonly before: string;
  readonly command: string;
  readonly ztsVersion: string;
  readonly retainedCount: number;
  readonly candidates: readonly BackupPruneCandidate[];
  readonly receiptPath: string;
}

interface StableSource {
  readonly contents: Buffer;
  readonly fingerprint: FileFingerprint;
}

type BackupStoreGuard = () => Promise<void>;

export class BackupSelectionError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "BackupSelectionError";
  }
}

interface EffectiveBackupCapacityPolicy {
  readonly maxBackups: number;
  readonly maxStoreBytes: number;
  readonly minimumFreeBytes: number;
}

interface BackupCreationAdmission {
  // Prospective lstat sizes are capacity budgets only. Stable open-handle
  // reads and fingerprints remain authoritative for copied content.
  readonly policy: EffectiveBackupCapacityPolicy;
  readonly profileId: string;
  readonly admittedSourceSizes: readonly number[];
  readonly admittedSourceBytes: number;
  admittedSourceBytesThroughIndex: number;
  actualSourceBytes: number;
  nextSourceIndex: number;
}

export function backupRootForProfile(profileId: string): string {
  return privatePath(stateDir(), "backups", profileStorageSegment(profileId));
}

export async function createBackup(
  context: ProfileContext,
  command: string,
  hooks: BackupStoreHooks = {}
): Promise<BackupManifest> {
  validateContext(context);
  validateCommand(command);
  const backupRoot = await ensurePrivateDirectory(stateDir(), "backups", profileStorageSegment(context.profile.id));
  return withBackupControl(context.profile.id, backupRoot, async (assertStoreHeld) => {
    const reconciliation = await reconcileCreateIntents(context.profile.id, backupRoot, assertStoreHeld);
    if (reconciliation.length > 0) throw reconciliationError("creation", reconciliation);
    const pruneReconciliation = await reconcilePruneIntents(context.profile.id, assertStoreHeld);
    if (pruneReconciliation.length > 0) throw reconciliationError("prune", pruneReconciliation);

    const admission = await assertBackupCreationAdmission(context, backupRoot, hooks, assertStoreHeld);
    hooks.afterCapacityAdmission?.();
    await assertStoreHeld();
    const { id, createdAt, intentPath, intent } = await reserveCreateIntent(context, backupRoot);
    const files: BackupFileReceipt[] = [];
    let manifestPublished = false;
    try {
      for (const [index, sourceSpec] of BACKUP_SOURCE_SPECS.entries()) {
        const source = sourcePath(context.profile.path, sourceSpec);
        const backup = backupDataPath(backupRoot, id, sourceSpec.token);
        const copied = await copyStableSource(
          backupRoot,
          source,
          backup,
          hooks,
          index,
          admission,
          assertStoreHeld
        );
        if (!copied) continue;
        files.push({
          source,
          backup,
          size: copied.contents.byteLength,
          sha256: sha256(copied.contents),
          sourceFingerprint: copied.fingerprint
        });
      }

      if (files.length === 0) {
        throw new Error("Backup captured no source files; no manifest was published");
      }
      if (!files.some((file) => file.source === context.sessionFile.path)) {
        throw new Error(
          `Backup authoritative session source disappeared before capture: ${context.sessionFile.path}`
        );
      }

      const manifest: BackupManifest = Object.freeze({
        schemaVersion: BACKUP_MANIFEST_SCHEMA,
        id,
        createdAt,
        profilePath: context.profile.path,
        profileId: context.profile.id,
        primarySource: context.sessionFile.path,
        zenRunning: context.running,
        command,
        ztsVersion: VERSION,
        files: Object.freeze(files.map((file) => Object.freeze(file)))
      });
      const committedIntent = { ...intent, phase: "manifest_committed" as const };
      const manifestBytes = encodedBackupJsonBytes(manifest, "Backup manifest");
      const committedIntentBytes = encodedBackupJsonBytes(committedIntent, "Backup committed creation intent");
      const manifestPath = backupManifestPath(backupRoot, id);
      await assertManifestPublicationCapacity(
        backupRoot,
        admission.profileId,
        admission.policy,
        manifestBytes,
        committedIntentBytes,
        hooks,
        assertStoreHeld
      );
      await publishPrivateJson(manifestPath, manifest);
      manifestPublished = true;
      hooks.afterManifestPublished?.(manifestPath);
      await assertIntentReplacementCapacity(
        backupRoot,
        admission.profileId,
        admission.policy,
        committedIntentBytes,
        hooks,
        assertStoreHeld
      );
      await replacePrivateJson(intentPath, committedIntent);
      await removePrivateFile(intentPath);
      return manifest;
    } catch (error) {
      if (manifestPublished) {
        throw new Error(
          `Backup ${id} committed, but creation cleanup is incomplete at ${intentPath}: ${errorMessage(error)}`,
          { cause: error }
        );
      }
      const cleanupErrors = await rollbackCreateIntent(intent, backupRoot, assertStoreHeld);
      if (cleanupErrors.length === 0) {
        try {
          await assertStoreHeld();
          await removeIfPrivateFile(intentPath);
        } catch (cleanupError) {
          cleanupErrors.push(cleanupError);
        }
      }
      if (cleanupErrors.length > 0) {
        const failure = boundedFailure(error, cleanupErrors);
        try {
          await assertStoreHeld();
          await replacePrivateJson(intentPath, { ...intent, phase: "rollback_required", failure });
        } catch (intentError) {
          cleanupErrors.push(intentError);
        }
        throw new AggregateError(
          [error, ...cleanupErrors],
          `Backup ${id} failed and partial files require reconciliation at ${intentPath}`
        );
      }
      throw error;
    }
  });
}

export async function previewBackupRestore(
  context: ProfileContext,
  backupId: string | undefined
): Promise<RestorePreview> {
  validateContext(context);
  if (!backupId) throw new BackupSelectionError("Backup id is required");
  try {
    validateBackupId(backupId);
  } catch (error) {
    throw new BackupSelectionError(error instanceof Error ? error.message : String(error), error);
  }
  await assertNoIncompletePrune(context.profile.id);
  const backupRoot = await existingBackupRoot(context.profile.id);
  if (!backupRoot) throw new BackupSelectionError(`Backup not found: ${backupId}`);
  await assertNoCreateIntents(context.profile.id, backupRoot);

  const manifestPath = backupManifestPath(backupRoot, backupId);
  let manifest: BackupManifest;
  try {
    manifest = await readBackupManifest(manifestPath, context.profile.id, backupRoot);
  } catch (error) {
    if (isMissing(error)) throw new BackupSelectionError(`Backup not found: ${backupId}`, error);
    throw error;
  }
  if (manifest.profilePath !== context.profile.path) {
    throw new Error(`Backup ${backupId} belongs to a different Profile path`);
  }
  await verifyManifestData(manifest);
  return {
    backupId: manifest.id,
    profileId: context.profile.id,
    profilePath: context.profile.path,
    files: manifest.files,
    executable: false,
    blocker: "Backup restore is production-disabled until the single-file durable restore transaction is available"
  };
}

export async function pruneBackups(
  profileId: string,
  before: Date,
  dryRun: boolean,
  command: string,
  hooks: BackupStoreHooks = {}
): Promise<BackupPruneReceipt> {
  validateProfileId(profileId);
  validateCommand(command);
  if (!Number.isFinite(before.getTime())) throw new Error("Prune cutoff is not a valid date");

  if (dryRun) {
    const backups = await listBackups(profileId);
    const candidates = await selectPruneCandidates(backups, before.getTime(), backupRootForProfile(profileId));
    const { id, createdAt } = newArtifactIdentity("prune");
    return definePruneReceipt({
      id,
      createdAt,
      profileId,
      before: before.toISOString(),
      dryRun: true,
      outcome: "dry_run",
      command,
      prunedCount: candidates.length,
      retainedCount: backups.length - candidates.length,
      candidates,
      receiptPath: null,
      failure: null
    });
  }

  const backupRoot = await ensurePrivateDirectory(stateDir(), "backups", profileStorageSegment(profileId));
  await ensurePrivateDirectory(stateDir(), "backup-prunes", profileStorageSegment(profileId));
  return withBackupControl(profileId, backupRoot, async (assertStoreHeld) => {
    const createReconciliation = await reconcileCreateIntents(profileId, backupRoot, assertStoreHeld);
    if (createReconciliation.length > 0) throw reconciliationError("creation", createReconciliation);
    const pruneReconciliation = await reconcilePruneIntents(profileId, assertStoreHeld);
    if (pruneReconciliation.length > 0) throw reconciliationError("prune", pruneReconciliation);

    const backups = await listBackupsInternal(profileId, backupRoot, { checkPruneIntents: false });
    const candidates = await selectPruneCandidates(backups, before.getTime(), backupRoot);
    const pruneRoot = pruneRootForProfile(profileId);
    await retainTerminalPruneReceipts(profileId, pruneRoot, hooks, assertStoreHeld);
    const { id, createdAt } = newArtifactIdentity("prune");
    if (candidates.length === 0) {
      // No deletion means there is no mutation to receipt. In particular,
      // repeated no-op maintenance must not grow a second unaccounted store.
      return definePruneReceipt({
        id,
        createdAt,
        profileId,
        before: before.toISOString(),
        dryRun: false,
        outcome: "completed",
        command,
        prunedCount: 0,
        retainedCount: backups.length,
        candidates: [],
        receiptPath: null,
        failure: null
      });
    }
    const receiptPath = pruneReceiptPath(pruneRoot, id);
    const intent: BackupPruneIntent = {
      schemaVersion: BACKUP_PRUNE_INTENT_SCHEMA,
      id,
      createdAt,
      profileId,
      before: before.toISOString(),
      command,
      ztsVersion: VERSION,
      retainedCount: backups.length - candidates.length,
      candidates,
      receiptPath
    };
    const intentPath = pruneIntentPath(pruneRoot, id);
    await assertPruneArtifactAdmission(profileId, backupRoot, intent, hooks, assertStoreHeld);
    await assertStoreHeld();
    if (!await createPrivateJsonExclusive(intentPath, intent)) {
      throw new Error(`Backup prune identifier collision: ${id}`);
    }
    hooks.afterPruneIntentPublished?.(intentPath);

    let receiptPublished = false;
    try {
      let fileIndex = 0;
      for (const candidate of candidates) {
        for (const file of candidate.files) {
          await assertStoreHeld();
          await assertFileFingerprint(file.path, file.fingerprint, file.size);
          await removePrivateFile(file.path);
          hooks.afterPruneFileRemoved?.(file.path, fileIndex);
          fileIndex += 1;
        }
      }
      const receipt = definePruneReceipt({
        id,
        createdAt,
        profileId,
        before: intent.before,
        dryRun: false,
        outcome: "completed",
        command,
        prunedCount: candidates.length,
        retainedCount: intent.retainedCount,
        candidates: withUniformOutcome(candidates, "deleted"),
        receiptPath,
        failure: null
      });
      await assertStoreHeld();
      await publishPrivateJson(receiptPath, receipt);
      receiptPublished = true;
      await assertStoreHeld();
      await removePrivateFile(intentPath);
      return receipt;
    } catch (error) {
      if (receiptPublished) {
        throw new Error(
          `Backup prune ${id} completed, but intent cleanup is incomplete at ${intentPath}: ${errorMessage(error)}`,
          { cause: error }
        );
      }
      throw new Error(
        `Backup prune ${id} failed; its pre-delete durable intent requires reconciliation at ${intentPath}: ${errorMessage(error)}`,
        { cause: error }
      );
    }
  });
}

export async function listBackups(profileId: string): Promise<BackupManifest[]> {
  validateProfileId(profileId);
  await assertNoIncompletePrune(profileId);
  const root = await existingBackupRoot(profileId);
  if (!root) return [];
  return listBackupsInternal(profileId, root, { checkPruneIntents: false });
}

async function listBackupsInternal(
  profileId: string,
  backupRoot: string,
  options: { readonly checkPruneIntents: boolean }
): Promise<BackupManifest[]> {
  if (options.checkPruneIntents) await assertNoIncompletePrune(profileId);
  const entries = await readDirectoryBounded(backupRoot, "backup store");
  const temporaryState = await classifyBackupTemporaries(backupRoot, entries, MAX_BACKUP_BYTES);
  const linkedCanonicalPaths = new Set(temporaryState.linked.map((pair) => pair.canonicalPath));
  const createIntentEntries = entries.filter((entry) => entry.endsWith("--create-intent.json"));
  if (createIntentEntries.length > 0) {
    for (const entry of createIntentEntries) {
      defineCreateIntent(await readPrivateJson(privatePath(backupRoot, entry), MAX_MANIFEST_BYTES), entry, profileId, backupRoot);
    }
    throw new Error(
      `Backup store has ${createIntentEntries.length} incomplete creation intent(s): ${createIntentEntries.join(", ")}`
    );
  }

  const manifestEntries = entries.filter((entry) => entry.endsWith("--manifest.json"));
  if (manifestEntries.length > MAX_BACKUPS) {
    throw new Error(`Backup store exceeds the ${MAX_BACKUPS}-manifest list limit`);
  }
  const manifests: BackupManifest[] = [];
  const expectedData = new Map<string, BackupFileReceipt>();
  let manifestBytes = 0;
  for (const entry of manifestEntries.sort()) {
    const manifestPath = privatePath(backupRoot, entry);
    manifestBytes += (await privateFileFingerprint(
      manifestPath,
      null,
      MAX_MANIFEST_BYTES,
      linkedCanonicalPaths.has(manifestPath)
    )).size;
    if (manifestBytes > MAX_LIST_MANIFEST_BYTES) {
      throw new Error(`Backup list exceeds the ${MAX_LIST_MANIFEST_BYTES}-byte manifest budget`);
    }
    const manifest = await readBackupManifest(manifestPath, profileId, backupRoot);
    manifests.push(manifest);
    for (const file of manifest.files) {
      const name = file.backup.slice(backupRoot.length + 1);
      if (expectedData.has(name)) throw new Error(`Backup data file is claimed by more than one manifest: ${name}`);
      expectedData.set(name, file);
    }
  }

  const dataEntries = entries.filter((entry) => entry.endsWith(".bak"));
  for (const entry of dataEntries) {
    const expected = expectedData.get(entry);
    if (!expected) throw new Error(`Backup store contains an orphan data file: ${entry}`);
    const path = privatePath(backupRoot, entry);
    await privateFileFingerprint(path, expected.size, MAX_BACKUP_BYTES, linkedCanonicalPaths.has(path));
    expectedData.delete(entry);
  }
  if (expectedData.size > 0) {
    throw new Error(`Backup store is missing manifest-bound data: ${[...expectedData.keys()].join(", ")}`);
  }

  const allowed = new Set<string>([...manifestEntries, ...dataEntries, ...createIntentEntries]);
  if (entries.includes(".backup-control.lock")) {
    defineKernelLock(await readPrivateJson(privatePath(backupRoot, ".backup-control.lock"), 64 * 1024));
    allowed.add(".backup-control.lock");
  }
  const toleratedTemporaries = new Set(temporaryState.standalone.map((item) => item.basename));
  for (const pair of temporaryState.linked) {
    const canonicalName = pair.canonicalPath.slice(pair.canonicalPath.lastIndexOf("/") + 1);
    if (!allowed.has(canonicalName)) {
      throw new Error(`Backup publication temporary is not bound to one validated canonical artifact: ${pair.temporaryName}`);
    }
    toleratedTemporaries.add(pair.temporaryName);
  }
  for (const entry of entries) {
    if (allowed.has(entry)) continue;
    if (toleratedTemporaries.has(entry)) continue;
    throw new Error(`Backup store contains an unexpected entry: ${entry}`);
  }
  return manifests.sort((left, right) =>
    right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id)
  );
}

async function copyStableSource(
  backupRoot: string,
  source: string,
  backup: string,
  hooks: BackupStoreHooks,
  index: number,
  admission: BackupCreationAdmission,
  assertStoreHeld: BackupStoreGuard
): Promise<StableSource | null> {
  advanceSourceAdmission(admission, index);
  let initial: Stats;
  try {
    initial = await lstat(source);
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
  await assertSourceParent(source);
  if (initial.isSymbolicLink() || !initial.isFile()) {
    throw new Error(`Backup source is not a real regular file: ${source}`);
  }
  const handle = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    assertSourceFile(before, source);
    assertSameIdentity(initial, before, `Backup source changed before read: ${source}`);
    if (before.size > MAX_BACKUP_BYTES) {
      throw new Error(`Backup source exceeds the ${MAX_BACKUP_BYTES}-byte limit: ${source}`);
    }
    hooks.afterSourceStat?.(source, index);
    const contents = await readFileExact(handle, before.size, MAX_BACKUP_BYTES, source);
    if (contents.byteLength !== before.size) throw new Error(`Backup source changed while being read: ${source}`);
    const fingerprint = fileFingerprint(before);
    assertSameFingerprint(fingerprint, fileFingerprint(await handle.stat()), `Backup source changed while being read: ${source}`);
    const actualSourceBytes = addByteCounts(
      admission.actualSourceBytes,
      contents.byteLength,
      "Backup actual source bytes"
    );
    if (actualSourceBytes > admission.admittedSourceBytesThroughIndex) {
      throw new Error(
        `Backup source ${source} exceeds its cumulative capacity admission budget (${formatBytes(actualSourceBytes)} actual, ${formatBytes(admission.admittedSourceBytesThroughIndex)} admitted)`
      );
    }

    const remainingSourceBytes = maximumRemainingSourceBytes(admission, actualSourceBytes, index);
    await assertSourcePublicationCapacity(
      backupRoot,
      admission.profileId,
      admission.policy,
      contents.byteLength,
      remainingSourceBytes,
      hooks,
      assertStoreHeld
    );
    await publishOwnedPrivateBytes(backup, contents, MAX_BACKUP_BYTES);
    admission.actualSourceBytes = actualSourceBytes;
    hooks.afterBackupFilePublished?.(backup, index);
    assertSameFingerprint(fingerprint, fileFingerprint(await handle.stat()), `Backup source changed before publication completed: ${source}`);
    const canonical = await lstat(source);
    assertSameIdentity(canonical, before, `Backup source path changed before publication completed: ${source}`);
    return { contents, fingerprint };
  } finally {
    await handle.close();
  }
}

async function reserveCreateIntent(
  context: ProfileContext,
  backupRoot: string
): Promise<{ id: string; createdAt: string; intentPath: string; intent: BackupCreateIntent }> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const { id, createdAt } = newArtifactIdentity("backup");
    const intentPath = createIntentPath(backupRoot, id);
    const intent: BackupCreateIntent = {
      schemaVersion: BACKUP_CREATE_INTENT_SCHEMA,
      id,
      createdAt,
      profileId: context.profile.id,
      profilePath: context.profile.path,
      manifestPath: backupManifestPath(backupRoot, id),
      backupPaths: BACKUP_SOURCE_SPECS.map((spec) => backupDataPath(backupRoot, id, spec.token)),
      phase: "preparing",
      failure: null
    };
    encodedBackupJsonBytes(intent, "Backup creation intent");
    if (await createPrivateJsonExclusive(intentPath, intent)) return { id, createdAt, intentPath, intent };
  }
  throw new Error("Could not reserve a unique backup identifier after 8 attempts");
}

async function reconcileCreateIntents(
  profileId: string,
  backupRoot: string,
  assertStoreHeld: BackupStoreGuard
): Promise<string[]> {
  const entries = await readDirectoryBounded(backupRoot, "backup store");
  const messages: string[] = [];
  for (const entry of entries.filter((name) => name.endsWith("--create-intent.json")).sort()) {
    const intentPath = privatePath(backupRoot, entry);
    const intent = defineCreateIntent(await readPrivateJson(intentPath, MAX_MANIFEST_BYTES), entry, profileId, backupRoot);
    if (await pathExistsNoFollow(intent.manifestPath)) {
      const manifest = await readBackupManifest(intent.manifestPath, profileId, backupRoot);
      await verifyManifestData(manifest);
      await assertStoreHeld();
      await removePrivateFile(intentPath);
      messages.push(`committed backup ${intent.id} had a stale creation intent; marker removed`);
      continue;
    }
    const cleanupErrors = await rollbackCreateIntent(intent, backupRoot, assertStoreHeld);
    if (cleanupErrors.length > 0) {
      throw new AggregateError(cleanupErrors, `Incomplete backup ${intent.id} could not be rolled back safely`);
    }
    await removePrivateFile(intentPath);
    messages.push(`incomplete backup ${intent.id} was rolled back from its durable creation intent`);
  }
  return messages;
}

async function verifyManifestData(manifest: BackupManifest): Promise<void> {
  for (const file of manifest.files) {
    const contents = await readPrivateBytes(file.backup, MAX_BACKUP_BYTES);
    if (contents.byteLength !== file.size) throw new Error(`Backup size mismatch for ${file.backup}`);
    if (sha256(contents) !== file.sha256) throw new Error(`Backup hash mismatch for ${file.backup}`);
  }
}

async function rollbackCreateIntent(
  intent: BackupCreateIntent,
  backupRoot: string,
  assertStoreHeld: BackupStoreGuard
): Promise<unknown[]> {
  const errors: unknown[] = [];
  for (const path of intent.backupPaths) {
    try {
      await assertStoreHeld();
      assertExactChild(path, backupRoot);
      await removeIfPrivateFile(path);
    } catch (error) {
      errors.push(error);
    }
  }
  return errors;
}

async function assertNoCreateIntents(profileId: string, backupRoot: string): Promise<void> {
  const entries = await readDirectoryBounded(backupRoot, "backup store");
  const intents = entries.filter((entry) => entry.endsWith("--create-intent.json"));
  if (intents.length === 0) return;
  for (const entry of intents) {
    defineCreateIntent(await readPrivateJson(privatePath(backupRoot, entry), MAX_MANIFEST_BYTES), entry, profileId, backupRoot);
  }
  throw new Error(`Backup store has an incomplete creation intent: ${intents.join(", ")}`);
}

async function selectPruneCandidates(
  backups: readonly BackupManifest[],
  cutoff: number,
  backupRoot: string
): Promise<BackupPruneCandidate[]> {
  const candidates: BackupPruneCandidate[] = [];
  for (const manifest of backups) {
    const createdMs = Date.parse(manifest.createdAt);
    if (createdMs >= cutoff) continue;
    const files: BackupPruneFile[] = [];
    for (const file of manifest.files) {
      const fingerprint = await privateFileFingerprint(file.backup, file.size, MAX_BACKUP_BYTES);
      files.push({ path: file.backup, size: file.size, kind: "backup", fingerprint, outcome: "planned" });
    }
    const manifestPath = backupManifestPath(backupRoot, manifest.id);
    const manifestFingerprint = await privateFileFingerprint(manifestPath, null, MAX_MANIFEST_BYTES);
    files.push({
      path: manifestPath,
      size: manifestFingerprint.size,
      kind: "manifest",
      fingerprint: manifestFingerprint,
      outcome: "planned"
    });
    candidates.push({ backupId: manifest.id, createdAt: manifest.createdAt, files });
  }
  return candidates.sort((left, right) =>
    left.createdAt.localeCompare(right.createdAt) || left.backupId.localeCompare(right.backupId)
  );
}

async function completeInterruptedPrune(
  intent: BackupPruneIntent,
  profileId: string,
  assertStoreHeld: BackupStoreGuard
): Promise<BackupPruneCandidate[]> {
  const backupRoot = backupRootForProfile(profileId);
  const completed: BackupPruneCandidate[] = [];
  for (const candidate of intent.candidates) {
    const inspected = await inspectPruneCandidate(candidate);
    if (inspected.some((file) => file.outcome === "changed")) {
      completed.push({ ...candidate, files: inspected });
      continue;
    }
    const manifestFile = inspected.find((file) => file.kind === "manifest")!;
    if (manifestFile.outcome === "retained") {
      const manifest = await readBackupManifest(manifestFile.path, profileId, backupRoot);
      assertCandidateMatchesManifest(candidate, manifest, backupRoot);
    } else if (inspected.some((file) => file.kind === "backup" && file.outcome === "retained")) {
      // A valid prune always deletes the manifest last. Existing data without
      // that manifest therefore cannot be proven to be the planned target.
      completed.push({ ...candidate, files: inspected });
      continue;
    }

    const files: BackupPruneFile[] = [];
    for (const file of inspected) {
      if (file.outcome === "deleted") {
        files.push(file);
        continue;
      }
      await assertStoreHeld();
      await assertFileFingerprint(file.path, file.fingerprint, file.size);
      await removePrivateFile(file.path);
      files.push({ ...file, outcome: "deleted" });
    }
    completed.push({ ...candidate, files });
  }
  return completed;
}

async function inspectPruneCandidate(candidate: BackupPruneCandidate): Promise<BackupPruneFile[]> {
  const files: BackupPruneFile[] = [];
  for (const file of candidate.files) {
    try {
      const current = await privateFileFingerprint(
        file.path,
        file.size,
        file.kind === "manifest" ? MAX_MANIFEST_BYTES : MAX_BACKUP_BYTES
      );
      files.push({ ...file, outcome: fingerprintsEqual(current, file.fingerprint) ? "retained" : "changed" });
    } catch (error) {
      if (isMissing(error)) files.push({ ...file, outcome: "deleted" });
      else throw error;
    }
  }
  return files;
}

function assertCandidateMatchesManifest(
  candidate: BackupPruneCandidate,
  manifest: BackupManifest,
  backupRoot: string
): void {
  if (manifest.id !== candidate.backupId || manifest.createdAt !== candidate.createdAt) {
    throw new Error(`Backup prune candidate ${candidate.backupId} does not match its manifest identity`);
  }
  const expected = new Map<string, number | null>(manifest.files.map((file) => [file.backup, file.size]));
  expected.set(backupManifestPath(backupRoot, manifest.id), null);
  if (candidate.files.length !== expected.size) {
    throw new Error(`Backup prune candidate ${candidate.backupId} does not cover its exact manifest closure`);
  }
  for (const file of candidate.files) {
    if (!expected.has(file.path)) throw new Error(`Backup prune candidate ${candidate.backupId} contains an unbound path`);
    const expectedSize = expected.get(file.path);
    if (expectedSize !== null && expectedSize !== file.size) {
      throw new Error(`Backup prune candidate ${candidate.backupId} size does not match its manifest`);
    }
    expected.delete(file.path);
  }
  if (expected.size > 0) throw new Error(`Backup prune candidate ${candidate.backupId} omits manifest-bound data`);
}

async function reconcilePruneIntents(
  profileId: string,
  assertStoreHeld: BackupStoreGuard
): Promise<string[]> {
  const pruneRoot = await existingPruneRoot(profileId);
  if (!pruneRoot) return [];
  const entries = await readDirectoryBounded(pruneRoot, "backup prune store");
  const messages: string[] = [];
  for (const entry of entries.filter((name) => name.endsWith("--intent.json")).sort()) {
    const intentPath = privatePath(pruneRoot, entry);
    const intent = definePruneIntent(await readPrivateJson(intentPath, MAX_PRUNE_ARTIFACT_BYTES), entry, profileId, pruneRoot);
    if (await pathExistsNoFollow(intent.receiptPath)) {
      const receipt = definePruneReceipt(
        await readPrivateJson(intent.receiptPath, MAX_PRUNE_ARTIFACT_BYTES),
        intent.receiptPath,
        profileId,
        pruneRoot
      );
      assertPruneReceiptMatchesIntent(receipt, intent);
      await assertStoreHeld();
      await removePrivateFile(intentPath);
      messages.push(`prune ${intent.id} had a terminal receipt and stale intent; marker removed`);
      continue;
    }
    const candidates = await completeInterruptedPrune(intent, profileId, assertStoreHeld);
    const receipt = definePruneReceipt({
      id: intent.id,
      createdAt: intent.createdAt,
      profileId,
      before: intent.before,
      dryRun: false,
      outcome: "interrupted",
      command: intent.command,
      prunedCount: intent.candidates.length,
      retainedCount: intent.retainedCount,
      candidates,
      receiptPath: intent.receiptPath,
      failure: "Prune process ended before publishing a terminal receipt"
    });
    await assertStoreHeld();
    await publishPrivateJson(intent.receiptPath, receipt);
    await removePrivateFile(intentPath);
    messages.push(`interrupted prune ${intent.id} was recorded at ${intent.receiptPath}`);
  }
  return messages;
}

async function assertNoIncompletePrune(profileId: string): Promise<void> {
  const pruneRoot = await existingPruneRoot(profileId);
  if (!pruneRoot) return;
  const entries = await readDirectoryBounded(pruneRoot, "backup prune store");
  const temporaryState = await classifyBackupTemporaries(pruneRoot, entries, MAX_PRUNE_ARTIFACT_BYTES);
  const linkedCanonicalPaths = new Set(temporaryState.linked.map((pair) => pair.canonicalPath));
  const allowed = new Set<string>();
  const intents = entries.filter((entry) => entry.endsWith("--intent.json"));
  for (const entry of intents) {
    definePruneIntent(await readPrivateJson(privatePath(pruneRoot, entry), MAX_PRUNE_ARTIFACT_BYTES), entry, profileId, pruneRoot);
    allowed.add(entry);
  }
  for (const entry of entries.filter((name) => name.endsWith("--receipt.json"))) {
    const path = privatePath(pruneRoot, entry);
    await assertPrivateFileMetadata(path, MAX_PRUNE_ARTIFACT_BYTES, linkedCanonicalPaths.has(path));
    allowed.add(entry);
  }
  const toleratedTemporaries = new Set(temporaryState.standalone.map((item) => item.basename));
  for (const pair of temporaryState.linked) {
    const canonicalName = pair.canonicalPath.slice(pair.canonicalPath.lastIndexOf("/") + 1);
    if (!allowed.has(canonicalName)) {
      throw new Error(`Backup prune publication temporary is not bound to one validated canonical artifact: ${pair.temporaryName}`);
    }
    toleratedTemporaries.add(pair.temporaryName);
  }
  for (const entry of entries) {
    if (!allowed.has(entry) && !toleratedTemporaries.has(entry)) {
      throw new Error(`Backup prune store contains an unexpected entry: ${entry}`);
    }
  }
  if (intents.length > 0) {
    throw new Error(`Backup prune has ${intents.length} incomplete durable intent(s): ${intents.join(", ")}`);
  }
}

function defineCreateIntent(value: unknown, filename: string, profileId: string, backupRoot: string): BackupCreateIntent {
  const object = strictObject(value, [
    "schemaVersion", "id", "createdAt", "profileId", "profilePath", "manifestPath", "backupPaths", "phase", "failure"
  ], "Backup creation intent");
  if (object.schemaVersion !== BACKUP_CREATE_INTENT_SCHEMA) throw new Error("Backup creation intent schema is unsupported");
  const id = stringValue(object.id, "Backup creation intent id", 128);
  validateBackupId(id);
  if (filename !== `${id}--create-intent.json`) throw new Error("Backup creation intent id does not match its filename");
  if (object.profileId !== profileId) throw new Error("Backup creation intent belongs to another Profile");
  const profilePath = canonicalBoundProfilePath(object.profilePath, profileId, "Backup creation intent");
  const manifestPath = stringValue(object.manifestPath, "Backup creation intent manifestPath", MAX_PATH_BYTES);
  if (manifestPath !== backupManifestPath(backupRoot, id)) throw new Error("Backup creation intent manifest path is not canonical");
  if (!Array.isArray(object.backupPaths) || object.backupPaths.length !== BACKUP_SOURCE_SPECS.length) {
    throw new Error("Backup creation intent backupPaths is invalid");
  }
  const backupPaths = object.backupPaths.map((path, index) => {
    const parsed = stringValue(path, "Backup creation intent backup path", MAX_PATH_BYTES);
    const expected = backupDataPath(backupRoot, id, BACKUP_SOURCE_SPECS[index]!.token);
    if (parsed !== expected) throw new Error("Backup creation intent backup path is not canonical");
    return parsed;
  });
  const phase = object.phase;
  if (phase !== "preparing" && phase !== "manifest_committed" && phase !== "rollback_required") {
    throw new Error("Backup creation intent phase is invalid");
  }
  const failure = nullableString(object.failure, "Backup creation intent failure", MAX_COMMAND_BYTES);
  const createdAt = isoTimestamp(object.createdAt, "Backup creation intent createdAt");
  assertArtifactTimeBinding(id, createdAt, "backup");
  return {
    schemaVersion: BACKUP_CREATE_INTENT_SCHEMA,
    id,
    createdAt,
    profileId,
    profilePath,
    manifestPath,
    backupPaths,
    phase,
    failure
  };
}

async function readBackupManifest(path: string, profileId: string, backupRoot: string): Promise<BackupManifest> {
  const value = await readPrivateJson(path, MAX_MANIFEST_BYTES);
  return defineBackupManifest(value, path, profileId, backupRoot);
}

function defineBackupManifest(value: unknown, path: string, profileId: string, backupRoot: string): BackupManifest {
  const object = strictObject(value, [
    "schemaVersion", "id", "createdAt", "profilePath", "profileId", "primarySource", "zenRunning", "command", "ztsVersion", "files"
  ], "Backup manifest");
  if (object.schemaVersion !== BACKUP_MANIFEST_SCHEMA) throw new Error("Backup manifest schema is unsupported");
  const id = stringValue(object.id, "Backup manifest id", 128);
  validateBackupId(id);
  if (path !== backupManifestPath(backupRoot, id)) throw new Error("Backup manifest id does not match its filename");
  if (object.profileId !== profileId) throw new Error("Backup manifest belongs to another Profile");
  const profilePath = canonicalBoundProfilePath(object.profilePath, profileId, "Backup manifest");
  const createdAt = isoTimestamp(object.createdAt, "Backup manifest createdAt");
  assertArtifactTimeBinding(id, createdAt, "backup");
  if (typeof object.zenRunning !== "boolean") throw new Error("Backup manifest zenRunning must be boolean");
  const command = stringValue(object.command, "Backup manifest command", MAX_COMMAND_BYTES);
  const ztsVersion = stringValue(object.ztsVersion, "Backup manifest ztsVersion", 128);
  if (!Array.isArray(object.files) || object.files.length < 1 || object.files.length > BACKUP_SOURCE_SPECS.length) {
    throw new Error("Backup manifest files must be a non-empty bounded array");
  }
  const allowedBySource = new Map(BACKUP_SOURCE_SPECS.map((spec) => [sourcePath(profilePath, spec), spec]));
  const primarySource = stringValue(object.primarySource, "Backup manifest primary source", MAX_PATH_BYTES);
  if (!allowedBySource.has(primarySource)) {
    throw new Error("Backup manifest primary source is outside the bounded source set");
  }
  const seenSources = new Set<string>();
  const files = object.files.map((entry) => {
    const file = strictObject(entry, ["source", "backup", "size", "sha256", "sourceFingerprint"], "Backup file receipt");
    const source = stringValue(file.source, "Backup source path", MAX_PATH_BYTES);
    const spec = allowedBySource.get(source);
    if (!spec || seenSources.has(source)) throw new Error(`Backup manifest contains an unexpected or duplicate source: ${source}`);
    seenSources.add(source);
    const backup = stringValue(file.backup, "Backup data path", MAX_PATH_BYTES);
    if (backup !== backupDataPath(backupRoot, id, spec.token)) {
      throw new Error(`Backup manifest data path is not filename-bound: ${backup}`);
    }
    const size = boundedInteger(file.size, "Backup file size", MAX_BACKUP_BYTES);
    const sha = stringValue(file.sha256, "Backup file sha256", 64);
    if (!SHA256_PATTERN.test(sha)) throw new Error("Backup file sha256 is invalid");
    const sourceFingerprint = defineFingerprint(file.sourceFingerprint, "Backup source fingerprint");
    if (sourceFingerprint.size !== size) throw new Error("Backup source fingerprint size does not match the file receipt");
    return Object.freeze({ source, backup, size, sha256: sha, sourceFingerprint });
  });
  if (!files.some((file) => file.source === primarySource)) {
    throw new Error("Backup manifest does not contain its authoritative primary source");
  }
  return Object.freeze({
    schemaVersion: BACKUP_MANIFEST_SCHEMA,
    id,
    createdAt,
    profilePath,
    profileId,
    primarySource,
    zenRunning: object.zenRunning,
    command,
    ztsVersion,
    files: Object.freeze(files)
  });
}

function definePruneIntent(value: unknown, filename: string, profileId: string, pruneRoot: string): BackupPruneIntent {
  const object = strictObject(value, [
    "schemaVersion", "id", "createdAt", "profileId", "before", "command", "ztsVersion", "retainedCount", "candidates", "receiptPath"
  ], "Backup prune intent");
  if (object.schemaVersion !== BACKUP_PRUNE_INTENT_SCHEMA) throw new Error("Backup prune intent schema is unsupported");
  const id = stringValue(object.id, "Backup prune intent id", 128);
  validatePruneId(id);
  if (filename !== `${id}--intent.json`) throw new Error("Backup prune intent id does not match its filename");
  if (object.profileId !== profileId) throw new Error("Backup prune intent belongs to another Profile");
  const createdAt = isoTimestamp(object.createdAt, "Backup prune intent createdAt");
  assertArtifactTimeBinding(id, createdAt, "prune");
  const before = isoTimestamp(object.before, "Backup prune intent cutoff");
  const command = stringValue(object.command, "Backup prune intent command", MAX_COMMAND_BYTES);
  const ztsVersion = stringValue(object.ztsVersion, "Backup prune intent ztsVersion", 128);
  const retainedCount = boundedInteger(object.retainedCount, "Backup prune retainedCount", MAX_BACKUPS);
  const candidates = definePruneCandidates(object.candidates, profileId);
  const cutoffMs = Date.parse(before);
  if (candidates.some((candidate) => Date.parse(candidate.createdAt) >= cutoffMs)) {
    throw new Error("Backup prune intent contains a candidate outside its cutoff");
  }
  if (candidates.some((candidate) => candidate.files.some((file) => file.outcome !== "planned"))) {
    throw new Error("Backup prune intent must contain only planned file outcomes");
  }
  const receiptPath = stringValue(object.receiptPath, "Backup prune receiptPath", MAX_PATH_BYTES);
  if (receiptPath !== pruneReceiptPath(pruneRoot, id)) throw new Error("Backup prune receiptPath is not canonical");
  return { schemaVersion: BACKUP_PRUNE_INTENT_SCHEMA, id, createdAt, profileId, before, command, ztsVersion, retainedCount, candidates, receiptPath };
}

function definePruneReceipt(input: Omit<BackupPruneReceipt, "schemaVersion" | "ztsVersion">): BackupPruneReceipt;
function definePruneReceipt(value: unknown, path: string, profileId: string, pruneRoot: string): BackupPruneReceipt;
function definePruneReceipt(
  value: unknown,
  path?: string,
  profileId?: string,
  pruneRoot?: string
): BackupPruneReceipt {
  if (path === undefined) {
    return Object.freeze({
      schemaVersion: BACKUP_PRUNE_RECEIPT_SCHEMA,
      ...(value as Omit<BackupPruneReceipt, "schemaVersion" | "ztsVersion">),
      ztsVersion: VERSION
    });
  }
  const object = strictObject(value, [
    "schemaVersion", "id", "createdAt", "profileId", "before", "dryRun", "outcome", "command", "ztsVersion",
    "prunedCount", "retainedCount", "candidates", "receiptPath", "failure"
  ], "Backup prune receipt");
  if (object.schemaVersion !== BACKUP_PRUNE_RECEIPT_SCHEMA) throw new Error("Backup prune receipt schema is unsupported");
  const id = stringValue(object.id, "Backup prune receipt id", 128);
  validatePruneId(id);
  if (!profileId || object.profileId !== profileId) throw new Error("Backup prune receipt belongs to another Profile");
  if (!pruneRoot || path !== pruneReceiptPath(pruneRoot, id)) throw new Error("Backup prune receipt id does not match its filename");
  const createdAt = isoTimestamp(object.createdAt, "Backup prune receipt createdAt");
  assertArtifactTimeBinding(id, createdAt, "prune");
  const before = isoTimestamp(object.before, "Backup prune receipt cutoff");
  if (object.dryRun !== false) throw new Error("Persisted backup prune receipt cannot be a dry run");
  if (object.outcome !== "completed" && object.outcome !== "failed" && object.outcome !== "interrupted") {
    throw new Error("Backup prune receipt outcome is invalid");
  }
  const command = stringValue(object.command, "Backup prune receipt command", MAX_COMMAND_BYTES);
  const ztsVersion = stringValue(object.ztsVersion, "Backup prune receipt ztsVersion", 128);
  const prunedCount = boundedInteger(object.prunedCount, "Backup prune prunedCount", MAX_BACKUPS);
  const retainedCount = boundedInteger(object.retainedCount, "Backup prune retainedCount", MAX_BACKUPS);
  const candidates = definePruneCandidates(object.candidates, profileId);
  if (candidates.length !== prunedCount) throw new Error("Backup prune receipt count does not match its candidates");
  const receiptPath = stringValue(object.receiptPath, "Backup prune receiptPath", MAX_PATH_BYTES);
  if (receiptPath !== path) throw new Error("Backup prune receiptPath is not canonical");
  const failure = nullableString(object.failure, "Backup prune receipt failure", MAX_COMMAND_BYTES);
  const fileOutcomes = candidates.flatMap((candidate) => candidate.files.map((file) => file.outcome));
  if (fileOutcomes.includes("planned")) throw new Error("Terminal backup prune receipt contains a planned outcome");
  if (object.outcome === "completed") {
    if (failure !== null || fileOutcomes.some((outcome) => outcome !== "deleted")) {
      throw new Error("Completed backup prune receipt does not prove every deletion");
    }
  } else if (failure === null) {
    throw new Error("Non-completed backup prune receipt requires a failure explanation");
  }
  return Object.freeze({
    schemaVersion: BACKUP_PRUNE_RECEIPT_SCHEMA,
    id,
    createdAt,
    profileId,
    before,
    dryRun: false,
    outcome: object.outcome,
    command,
    ztsVersion,
    prunedCount,
    retainedCount,
    candidates,
    receiptPath,
    failure
  });
}

function assertPruneReceiptMatchesIntent(receipt: BackupPruneReceipt, intent: BackupPruneIntent): void {
  if (receipt.id !== intent.id
    || receipt.createdAt !== intent.createdAt
    || receipt.profileId !== intent.profileId
    || receipt.before !== intent.before
    || receipt.command !== intent.command
    || receipt.prunedCount !== intent.candidates.length
    || receipt.retainedCount !== intent.retainedCount
    || receipt.receiptPath !== intent.receiptPath
    || receipt.candidates.length !== intent.candidates.length) {
    throw new Error(`Backup prune receipt ${receipt.id} is not bound to its durable intent`);
  }
  for (let candidateIndex = 0; candidateIndex < intent.candidates.length; candidateIndex += 1) {
    const planned = intent.candidates[candidateIndex]!;
    const terminal = receipt.candidates[candidateIndex]!;
    if (terminal.backupId !== planned.backupId
      || terminal.createdAt !== planned.createdAt
      || terminal.files.length !== planned.files.length) {
      throw new Error(`Backup prune receipt ${receipt.id} candidate identity differs from its intent`);
    }
    for (let fileIndex = 0; fileIndex < planned.files.length; fileIndex += 1) {
      const plannedFile = planned.files[fileIndex]!;
      const terminalFile = terminal.files[fileIndex]!;
      if (terminalFile.path !== plannedFile.path
        || terminalFile.size !== plannedFile.size
        || terminalFile.kind !== plannedFile.kind
        || !fingerprintsEqual(terminalFile.fingerprint, plannedFile.fingerprint)) {
        throw new Error(`Backup prune receipt ${receipt.id} file evidence differs from its intent`);
      }
    }
  }
}

function definePruneCandidates(value: unknown, profileId: string): BackupPruneCandidate[] {
  if (!Array.isArray(value) || value.length > MAX_BACKUPS) throw new Error("Backup prune candidates must be a bounded array");
  const backupRoot = backupRootForProfile(profileId);
  const seen = new Set<string>();
  return value.map((entry) => {
    const candidate = strictObject(entry, ["backupId", "createdAt", "files"], "Backup prune candidate");
    const backupId = stringValue(candidate.backupId, "Backup prune candidate id", 128);
    validateBackupId(backupId);
    if (seen.has(backupId)) throw new Error("Backup prune candidate id is duplicated");
    seen.add(backupId);
    const createdAt = isoTimestamp(candidate.createdAt, "Backup prune candidate createdAt");
    assertArtifactTimeBinding(backupId, createdAt, "backup");
    if (!Array.isArray(candidate.files) || candidate.files.length < 1 || candidate.files.length > BACKUP_SOURCE_SPECS.length + 1) {
      throw new Error("Backup prune candidate files is invalid");
    }
    let manifestCount = 0;
    const paths = new Set<string>();
    const files = candidate.files.map((entryFile) => {
      const file = strictObject(entryFile, ["path", "size", "kind", "fingerprint", "outcome"], "Backup prune file");
      const path = stringValue(file.path, "Backup prune file path", MAX_PATH_BYTES);
      assertExactChild(path, backupRoot);
      if (paths.has(path)) throw new Error("Backup prune file path is duplicated");
      paths.add(path);
      if (file.kind !== "backup" && file.kind !== "manifest") throw new Error("Backup prune file kind is invalid");
      const kind: BackupPruneFile["kind"] = file.kind;
      if (kind === "manifest") {
        manifestCount += 1;
        if (path !== backupManifestPath(backupRoot, backupId)) throw new Error("Backup prune manifest path is not canonical");
      } else if (!BACKUP_SOURCE_SPECS.some((spec) => path === backupDataPath(backupRoot, backupId, spec.token))) {
        throw new Error("Backup prune data path is not canonical");
      }
      const size = boundedInteger(file.size, "Backup prune file size", MAX_BACKUP_BYTES);
      const fingerprint = defineFingerprint(file.fingerprint, "Backup prune file fingerprint");
      if (fingerprint.size !== size) throw new Error("Backup prune file fingerprint size mismatch");
      if (file.outcome !== "planned" && file.outcome !== "deleted" && file.outcome !== "retained" && file.outcome !== "changed") {
        throw new Error("Backup prune file outcome is invalid");
      }
      const outcome: BackupPruneFileOutcome = file.outcome;
      return { path, size, kind, fingerprint, outcome };
    });
    if (manifestCount !== 1) throw new Error("Backup prune candidate must contain exactly one manifest");
    return { backupId, createdAt, files };
  });
}

function defineFingerprint(value: unknown, label: string): FileFingerprint {
  const object = strictObject(value, ["device", "inode", "size", "modifiedMs", "changedMs"], label);
  return {
    device: boundedInteger(object.device, `${label} device`, Number.MAX_SAFE_INTEGER),
    inode: boundedInteger(object.inode, `${label} inode`, Number.MAX_SAFE_INTEGER),
    size: boundedInteger(object.size, `${label} size`, MAX_BACKUP_BYTES),
    modifiedMs: finiteNumber(object.modifiedMs, `${label} modifiedMs`),
    changedMs: finiteNumber(object.changedMs, `${label} changedMs`)
  };
}

async function existingBackupRoot(profileId: string): Promise<string | null> {
  const segment = profileStorageSegment(profileId);
  try {
    return await assertPrivateDirectory(stateDir(), "backups", segment);
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}

async function existingPruneRoot(profileId: string): Promise<string | null> {
  const segment = profileStorageSegment(profileId);
  try {
    return await assertPrivateDirectory(stateDir(), "backup-prunes", segment);
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}

function pruneRootForProfile(profileId: string): string {
  return privatePath(stateDir(), "backup-prunes", profileStorageSegment(profileId));
}

async function withBackupControl<T>(
  profileId: string,
  backupRoot: string,
  operation: (assertStoreHeld: BackupStoreGuard) => Promise<T>
): Promise<T> {
  const controlPath = privatePath(backupRoot, ".backup-control.lock");
  const control = await acquireExclusiveFileControl(controlPath, "Backup store control", { timeoutSeconds: 15 });
  try {
    const rootIdentity = await lstat(backupRoot);
    assertPrivateDirectoryMetadata(rootIdentity, backupRoot);
    const assertStoreHeld = async () => {
      await control.assertHeld();
      const current = await lstat(backupRoot);
      assertPrivateDirectoryMetadata(current, backupRoot);
      if (current.dev !== rootIdentity.dev || current.ino !== rootIdentity.ino) {
        throw new Error("Backup store root no longer names the controlled directory");
      }
    };
    await assertStoreHeld();
    await reconcileBackupStandaloneTemporaries(
      backupRoot,
      await existingPruneRoot(profileId),
      assertStoreHeld
    );
    return await operation(assertStoreHeld);
  } finally {
    await control.release();
  }
}

async function reconcileBackupStandaloneTemporaries(
  backupRoot: string,
  pruneRoot: string | null,
  assertStoreHeld: BackupStoreGuard
): Promise<void> {
  for (const parent of [
    { path: backupRoot, maxBytes: MAX_BACKUP_BYTES },
    ...(pruneRoot ? [{ path: pruneRoot, maxBytes: MAX_PRUNE_ARTIFACT_BYTES }] : [])
  ]) {
    const entries = await readDirectoryBounded(parent.path, "backup temporary reconciliation");
    const temporaryState = await classifyBackupTemporaries(parent.path, entries, parent.maxBytes);
    for (const pair of temporaryState.linked) {
      await assertStoreHeld();
      if (!await reconcilePrivatePublication(pair.canonicalPath)) {
        throw new Error(`Backup publication residue disappeared before exact reconciliation: ${pair.temporaryName}`);
      }
    }
    for (const candidate of temporaryState.standalone) {
      await assertStoreHeld();
      await removePrivateStandaloneTemporaryCandidate(candidate);
    }
  }
  await assertStoreHeld();
}

interface BackupTemporaryState {
  readonly standalone: readonly Awaited<ReturnType<typeof inspectPrivateStandaloneTemporaryCandidate>>[];
  readonly linked: readonly {
    readonly canonicalPath: string;
    readonly temporaryName: string;
  }[];
}

async function classifyBackupTemporaries(
  root: string,
  entries: readonly string[],
  maxBytes: number
): Promise<BackupTemporaryState> {
  const linkedByIdentity = new Map<string, { readonly name: string; readonly metadata: Stats }[]>();
  for (const name of entries) {
    const metadata = await lstat(privatePath(root, name));
    if (metadata.isFile() && metadata.nlink === 2) {
      const key = `${metadata.dev}:${metadata.ino}`;
      const group = linkedByIdentity.get(key) ?? [];
      group.push({ name, metadata });
      linkedByIdentity.set(key, group);
    }
  }
  const standalone: BackupTemporaryState["standalone"][number][] = [];
  const linked: BackupTemporaryState["linked"][number][] = [];
  for (const name of entries) {
    if (!isPrivateTemporaryBasename(name)) continue;
    const path = privatePath(root, name);
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink() || !metadata.isFile()
      || (typeof process.getuid === "function" && metadata.uid !== process.getuid())
      || (metadata.mode & 0o077) !== 0
      || metadata.size < 0 || metadata.size > maxBytes) {
      throw new Error(`Backup publication temporary is not one bounded owner-private file: ${name}`);
    }
    if (metadata.nlink === 1) {
      standalone.push(await inspectPrivateStandaloneTemporaryCandidate(path, maxBytes));
      continue;
    }
    if (metadata.nlink !== 2) {
      throw new Error(`Backup publication temporary has an invalid hardlink count: ${name}`);
    }
    const group = linkedByIdentity.get(`${metadata.dev}:${metadata.ino}`) ?? [];
    const canonicals = group.filter((item) => !isPrivateTemporaryBasename(item.name));
    const temporaries = group.filter((item) => isPrivateTemporaryBasename(item.name));
    if (group.length !== 2 || canonicals.length !== 1 || temporaries.length !== 1) {
      throw new Error(`Backup publication temporary lacks one exact canonical inode pair: ${name}`);
    }
    linked.push({ canonicalPath: privatePath(root, canonicals[0].name), temporaryName: name });
  }
  return { standalone, linked };
}

async function backupStoreBytes(
  backupRoot: string,
  allowCreateIntent = false,
  profileId?: string
): Promise<number> {
  const entries = await readDirectoryBounded(backupRoot, "backup store capacity inventory");
  let bytes = 0;
  for (const entry of entries) {
    let limit: number;
    if (entry.endsWith(".bak")) limit = MAX_BACKUP_BYTES;
    else if (entry.endsWith("--manifest.json")) limit = MAX_MANIFEST_BYTES;
    else if (allowCreateIntent && entry.endsWith("--create-intent.json")) limit = MAX_MANIFEST_BYTES;
    else if (entry === ".backup-control.lock") limit = 64 * 1024;
    else throw new Error(`Backup store changed during capacity inventory: ${entry}`);
    const fingerprint = await privateFileFingerprint(privatePath(backupRoot, entry), null, limit);
    bytes = addByteCounts(bytes, fingerprint.size, "Backup store byte inventory");
  }
  if (profileId) {
    bytes = addByteCounts(bytes, await pruneStoreBytes(profileId), "Backup plus prune store byte inventory");
  }
  return bytes;
}

async function pruneStoreBytes(profileId: string): Promise<number> {
  const root = await existingPruneRoot(profileId);
  if (!root) return 0;
  const entries = await readDirectoryBounded(root, "backup prune capacity inventory");
  let bytes = 0;
  for (const entry of entries) {
    if (!entry.endsWith("--intent.json") && !entry.endsWith("--receipt.json")) {
      throw new Error(`Backup prune store changed during capacity inventory: ${entry}`);
    }
    const fingerprint = await privateFileFingerprint(
      privatePath(root, entry),
      null,
      MAX_PRUNE_ARTIFACT_BYTES
    );
    bytes = addByteCounts(bytes, fingerprint.size, "Backup prune store byte inventory");
  }
  return bytes;
}

async function retainTerminalPruneReceipts(
  profileId: string,
  pruneRoot: string,
  hooks: BackupStoreHooks,
  assertStoreHeld: BackupStoreGuard
): Promise<void> {
  const policy = effectivePruneReceiptPolicy(hooks);
  const entries = await readDirectoryBounded(pruneRoot, "backup prune retention inventory");
  const intents = entries.filter((entry) => entry.endsWith("--intent.json"));
  if (intents.length > 0) throw new Error("Backup prune retention is blocked by an incomplete intent");
  const receipts: { readonly entry: string; readonly createdAt: string }[] = [];
  for (const entry of entries) {
    if (!entry.endsWith("--receipt.json")) {
      throw new Error(`Backup prune store contains an unexpected entry during retention: ${entry}`);
    }
    const path = privatePath(pruneRoot, entry);
    const receipt = definePruneReceipt(
      await readPrivateJson(path, MAX_PRUNE_ARTIFACT_BYTES),
      path,
      profileId,
      pruneRoot
    );
    receipts.push({ entry, createdAt: receipt.createdAt });
  }
  const cutoff = Date.now() - policy.retentionMs;
  for (const receipt of receipts
    .filter((item) => Date.parse(item.createdAt) <= cutoff)
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.entry.localeCompare(right.entry))) {
    await assertStoreHeld();
    await removePrivateFile(privatePath(pruneRoot, receipt.entry));
  }
  const retained = receipts.filter((item) => Date.parse(item.createdAt) > cutoff).length;
  if (retained >= policy.maxReceipts) {
    throw new Error(
      `Backup prune receipt retention contains ${retained} recent receipts, its ${policy.maxReceipts}-receipt cap`
    );
  }
}

function effectivePruneReceiptPolicy(hooks: BackupStoreHooks): {
  readonly maxReceipts: number;
  readonly retentionMs: number;
} {
  const maxReceipts = hooks.pruneReceiptPolicy?.maxReceipts ?? MAX_RETAINED_PRUNE_RECEIPTS;
  const retentionMs = hooks.pruneReceiptPolicy?.retentionMs ?? PRUNE_RECEIPT_RETENTION_MS;
  if (!Number.isSafeInteger(maxReceipts) || maxReceipts < 1 || maxReceipts > MAX_RETAINED_PRUNE_RECEIPTS) {
    throw new Error("Backup prune receipt max must be a positive production-tightening bound");
  }
  if (!Number.isSafeInteger(retentionMs) || retentionMs < 0 || retentionMs > PRUNE_RECEIPT_RETENTION_MS) {
    throw new Error("Backup prune receipt retention must be a non-negative production-tightening bound");
  }
  return { maxReceipts, retentionMs };
}

async function assertPruneArtifactAdmission(
  profileId: string,
  backupRoot: string,
  intent: BackupPruneIntent,
  hooks: BackupStoreHooks,
  assertStoreHeld: BackupStoreGuard
): Promise<void> {
  const intentBytes = Buffer.byteLength(`${JSON.stringify(intent, null, 2)}\n`);
  if (!Number.isSafeInteger(intentBytes) || intentBytes < 1 || intentBytes > MAX_PRUNE_ARTIFACT_BYTES) {
    throw new Error(`Backup prune intent exceeds the ${MAX_PRUNE_ARTIFACT_BYTES}-byte artifact limit`);
  }
  const policy = effectiveBackupCapacityPolicy(hooks);
  await assertStoreHeld();
  const existingBytes = await backupStoreBytes(backupRoot, false, profileId);
  const reservation = addByteCounts(
    intentBytes,
    MAX_PRUNE_ARTIFACT_BYTES,
    "Backup prune intent and terminal Receipt reservation"
  );
  if (addByteCounts(existingBytes, reservation, "Backup prune store projection") > policy.maxStoreBytes) {
    throw new Error("Backup prune metadata cannot be reserved under the bounded backup store cap");
  }
  const filesystem = await statfs(backupRoot, { bigint: true });
  if (filesystem.bavail < 0n || filesystem.bsize <= 0n) {
    throw new Error("Backup prune filesystem free-space accounting is invalid");
  }
  if (filesystem.bavail * filesystem.bsize < BigInt(policy.minimumFreeBytes) + BigInt(reservation)) {
    throw new Error("Backup prune metadata cannot be reserved while preserving the filesystem free-space floor");
  }
  await assertStoreHeld();
}

async function assertBackupCreationAdmission(
  context: ProfileContext,
  backupRoot: string,
  hooks: BackupStoreHooks,
  assertStoreHeld: BackupStoreGuard
): Promise<BackupCreationAdmission> {
  const policy = effectiveBackupCapacityPolicy(hooks);
  await assertStoreHeld();
  const backups = await listBackupsInternal(context.profile.id, backupRoot, { checkPruneIntents: false });
  if (backups.length >= policy.maxBackups) {
    throw new Error(
      `Backup store already contains ${backups.length} ${backups.length === 1 ? "backup" : "backups"}, its creation limit; ${BACKUP_PRUNE_GUIDANCE} before creating another backup`
    );
  }

  await assertStoreHeld();
  const existingStoreBytes = await backupStoreBytes(backupRoot, false, context.profile.id);
  const admittedSourceSizes = await prospectiveSourceSizes(context.profile.path);
  const sourceBytes = admittedSourceSizes.reduce(
    (total, size) => addByteCounts(total, size, "Backup source reservation"),
    0
  );
  const storeReservationBytes = addByteCounts(
    sourceBytes,
    BACKUP_STORE_METADATA_RESERVATION_BYTES,
    "Backup durable store reservation"
  );
  const projectedStoreBytes = addByteCounts(existingStoreBytes, storeReservationBytes, "Backup store projection");
  if (projectedStoreBytes > policy.maxStoreBytes) {
    throw new Error(
      `Backup store cap would be exceeded: ${formatBytes(existingStoreBytes)} existing plus ${formatBytes(sourceBytes)} exact current source data and ${formatBytes(BACKUP_STORE_METADATA_RESERVATION_BYTES)} metadata reserve exceeds ${formatBytes(policy.maxStoreBytes)}; ${BACKUP_PRUNE_GUIDANCE} before creating another backup`
    );
  }

  await assertStoreHeld();
  const filesystem = await statfs(backupRoot, { bigint: true });
  await assertStoreHeld();
  if (filesystem.bavail < 0n || filesystem.bsize <= 0n) {
    throw new Error("Backup filesystem free-space accounting is invalid");
  }
  const filesystemFreeBytes = filesystem.bavail * filesystem.bsize;
  const filesystemReservationBytes = addByteCounts(
    sourceBytes,
    BACKUP_FILESYSTEM_METADATA_RESERVATION_BYTES,
    "Backup filesystem reservation"
  );
  const requiredFilesystemBytes = BigInt(policy.minimumFreeBytes) + BigInt(filesystemReservationBytes);
  if (filesystemFreeBytes < requiredFilesystemBytes) {
    throw new Error(
      `Backup cannot reserve ${formatBytes(filesystemReservationBytes)} while preserving ${formatBytes(policy.minimumFreeBytes)} free; ${BACKUP_PRUNE_GUIDANCE}, or free disk space before creating another backup`
    );
  }
  await assertStoreHeld();
  return {
    policy,
    profileId: context.profile.id,
    admittedSourceSizes: Object.freeze(admittedSourceSizes),
    admittedSourceBytes: sourceBytes,
    admittedSourceBytesThroughIndex: 0,
    actualSourceBytes: 0,
    nextSourceIndex: 0
  };
}

async function assertSourcePublicationCapacity(
  backupRoot: string,
  profileId: string,
  policy: EffectiveBackupCapacityPolicy,
  publicationBytes: number,
  remainingSourceBytes: number,
  hooks: BackupStoreHooks,
  assertStoreHeld: BackupStoreGuard
): Promise<void> {
  const simulation = publicationCapacitySimulation(hooks);
  await assertStoreHeld();
  const currentStoreBytes = addByteCounts(
    await backupStoreBytes(backupRoot, true, profileId),
    simulation.additionalStoreBytes,
    "Simulated backup store inventory"
  );
  const sourceWrites = addByteCounts(publicationBytes, remainingSourceBytes, "Remaining backup source writes");
  const projectedStoreBytes = addByteCounts(
    addByteCounts(currentStoreBytes, sourceWrites, "Backup source publication projection"),
    2 * MAX_MANIFEST_BYTES,
    "Backup remaining metadata publication projection"
  );
  if (projectedStoreBytes > policy.maxStoreBytes) {
    throw new Error(
      `Backup store projection changed before source publication: ${formatBytes(projectedStoreBytes)} would exceed ${formatBytes(policy.maxStoreBytes)}; ${BACKUP_PRUNE_GUIDANCE} before retrying`
    );
  }

  const remainingWrites = addByteCounts(
    sourceWrites,
    2 * MAX_MANIFEST_BYTES,
    "Remaining backup filesystem writes"
  );
  const filesystemFreeBytes = await publicationFilesystemFreeBytes(
    backupRoot,
    simulation.maximumFreeBytes,
    assertStoreHeld
  );
  if (filesystemFreeBytes < BigInt(policy.minimumFreeBytes) + BigInt(remainingWrites)) {
    throw new Error(
      `Backup filesystem free space changed before source publication: cannot reserve ${formatBytes(remainingWrites)} while preserving ${formatBytes(policy.minimumFreeBytes)} free; ${BACKUP_PRUNE_GUIDANCE}, or free disk space before retrying`
    );
  }
  await assertStoreHeld();
}

async function assertManifestPublicationCapacity(
  backupRoot: string,
  profileId: string,
  policy: EffectiveBackupCapacityPolicy,
  manifestBytes: number,
  committedIntentBytes: number,
  hooks: BackupStoreHooks,
  assertStoreHeld: BackupStoreGuard
): Promise<void> {
  const simulation = publicationCapacitySimulation(hooks);
  await assertStoreHeld();
  const currentStoreBytes = addByteCounts(
    await backupStoreBytes(backupRoot, true, profileId),
    simulation.additionalStoreBytes,
    "Simulated backup store inventory"
  );
  const metadataWrites = addByteCounts(manifestBytes, committedIntentBytes, "Backup remaining metadata writes");
  const projectedStoreBytes = addByteCounts(currentStoreBytes, metadataWrites, "Backup manifest publication projection");
  if (projectedStoreBytes > policy.maxStoreBytes) {
    throw new Error(
      `Backup store projection changed before manifest publication: ${formatBytes(projectedStoreBytes)} would exceed ${formatBytes(policy.maxStoreBytes)}; ${BACKUP_PRUNE_GUIDANCE} before retrying`
    );
  }

  const remainingWrites = metadataWrites;
  const filesystemFreeBytes = await publicationFilesystemFreeBytes(
    backupRoot,
    simulation.maximumFreeBytes,
    assertStoreHeld
  );
  if (filesystemFreeBytes < BigInt(policy.minimumFreeBytes) + BigInt(remainingWrites)) {
    throw new Error(
      `Backup filesystem free space changed before manifest publication: cannot reserve ${formatBytes(remainingWrites)} while preserving ${formatBytes(policy.minimumFreeBytes)} free; ${BACKUP_PRUNE_GUIDANCE}, or free disk space before retrying`
    );
  }
  await assertStoreHeld();
}

async function assertIntentReplacementCapacity(
  backupRoot: string,
  profileId: string,
  policy: EffectiveBackupCapacityPolicy,
  committedIntentBytes: number,
  hooks: BackupStoreHooks,
  assertStoreHeld: BackupStoreGuard
): Promise<void> {
  const simulation = publicationCapacitySimulation(hooks);
  await assertStoreHeld();
  const currentStoreBytes = addByteCounts(
    await backupStoreBytes(backupRoot, true, profileId),
    simulation.additionalStoreBytes,
    "Simulated backup store inventory"
  );
  const projectedStoreBytes = addByteCounts(
    currentStoreBytes,
    committedIntentBytes,
    "Backup intent replacement projection"
  );
  if (projectedStoreBytes > policy.maxStoreBytes) {
    throw new Error(
      `Backup store projection changed before creation-intent cleanup: ${formatBytes(projectedStoreBytes)} would exceed ${formatBytes(policy.maxStoreBytes)}; committed backup recovery remains required`
    );
  }

  const filesystemFreeBytes = await publicationFilesystemFreeBytes(
    backupRoot,
    simulation.maximumFreeBytes,
    assertStoreHeld
  );
  if (filesystemFreeBytes < BigInt(policy.minimumFreeBytes) + BigInt(committedIntentBytes)) {
    throw new Error(
      `Backup filesystem free space changed before creation-intent cleanup: cannot reserve ${formatBytes(committedIntentBytes)} while preserving ${formatBytes(policy.minimumFreeBytes)} free; committed backup recovery remains required`
    );
  }
  await assertStoreHeld();
}

async function publicationFilesystemFreeBytes(
  backupRoot: string,
  simulatedMaximumFreeBytes: number | null,
  assertStoreHeld: BackupStoreGuard
): Promise<bigint> {
  // This is the last check before the corresponding zts write. Unrelated
  // processes can still consume filesystem capacity after statfs returns.
  await assertStoreHeld();
  const filesystem = await statfs(backupRoot, { bigint: true });
  await assertStoreHeld();
  if (filesystem.bavail < 0n || filesystem.bsize <= 0n) {
    throw new Error("Backup filesystem free-space accounting is invalid");
  }
  const actual = filesystem.bavail * filesystem.bsize;
  return simulatedMaximumFreeBytes === null
    ? actual
    : actual < BigInt(simulatedMaximumFreeBytes) ? actual : BigInt(simulatedMaximumFreeBytes);
}

function publicationCapacitySimulation(hooks: BackupStoreHooks): {
  readonly additionalStoreBytes: number;
  readonly maximumFreeBytes: number | null;
} {
  const additionalStoreBytes = hooks.publicationCapacitySimulation?.additionalStoreBytes ?? 0;
  if (!Number.isSafeInteger(additionalStoreBytes) || additionalStoreBytes < 0) {
    throw new Error("Backup publication simulation additionalStoreBytes must be a non-negative safe integer");
  }
  const maximumFreeBytes = hooks.publicationCapacitySimulation?.maximumFreeBytes ?? null;
  if (maximumFreeBytes !== null && (!Number.isSafeInteger(maximumFreeBytes) || maximumFreeBytes < 0)) {
    throw new Error("Backup publication simulation maximumFreeBytes must be a non-negative safe integer");
  }
  return { additionalStoreBytes, maximumFreeBytes };
}

function maximumRemainingSourceBytes(
  admission: BackupCreationAdmission,
  actualSourceBytes: number,
  index: number
): number {
  const unconsumedBudget = admission.admittedSourceBytes - actualSourceBytes;
  if (!Number.isSafeInteger(unconsumedBudget) || unconsumedBudget < 0) {
    throw new Error("Backup remaining source admission is invalid");
  }
  const futureSourceCount = admission.admittedSourceSizes.length - index - 1;
  const futureFileMaximum = futureSourceCount * MAX_BACKUP_BYTES;
  if (!Number.isSafeInteger(futureFileMaximum) || futureFileMaximum < 0) {
    throw new Error("Backup remaining source file bound is invalid");
  }
  return Math.min(unconsumedBudget, futureFileMaximum);
}

async function prospectiveSourceSizes(profilePath: string): Promise<number[]> {
  const sizes: number[] = [];
  for (const spec of BACKUP_SOURCE_SPECS) {
    const source = sourcePath(profilePath, spec);
    let metadata: Stats;
    try {
      metadata = await lstat(source);
    } catch (error) {
      if (isMissing(error)) {
        sizes.push(0);
        continue;
      }
      throw error;
    }
    await assertSourceParent(source);
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
      throw new Error(`Backup source is not a real regular file: ${source}`);
    }
    assertSourceFile(metadata, source);
    if (metadata.size > MAX_BACKUP_BYTES) {
      throw new Error(`Backup source exceeds the ${MAX_BACKUP_BYTES}-byte limit: ${source}`);
    }
    sizes.push(metadata.size);
  }
  return sizes;
}

function advanceSourceAdmission(admission: BackupCreationAdmission, index: number): void {
  if (index !== admission.nextSourceIndex || index < 0 || index >= admission.admittedSourceSizes.length) {
    throw new Error("Backup source capacity admission was consumed out of order");
  }
  admission.admittedSourceBytesThroughIndex = addByteCounts(
    admission.admittedSourceBytesThroughIndex,
    admission.admittedSourceSizes[index]!,
    "Backup cumulative source admission"
  );
  admission.nextSourceIndex += 1;
}

function encodedBackupJsonBytes(value: unknown, label: string): number {
  const bytes = Buffer.byteLength(`${JSON.stringify(value, null, 2)}\n`);
  if (!Number.isSafeInteger(bytes) || bytes < 1 || bytes > MAX_MANIFEST_BYTES) {
    throw new Error(`${label} exceeds the ${MAX_MANIFEST_BYTES}-byte backup metadata limit`);
  }
  return bytes;
}

async function readDirectoryBounded(path: string, label: string): Promise<string[]> {
  const before = await lstat(path);
  assertPrivateDirectoryMetadata(before, path);
  const directory = await opendir(path);
  const entries: string[] = [];
  try {
    for await (const entry of directory) {
      entries.push(entry.name);
      if (entries.length > MAX_DIRECTORY_ENTRIES) {
        throw new Error(`${label} exceeds the ${MAX_DIRECTORY_ENTRIES}-entry scan limit`);
      }
    }
  } finally {
    await directory.close().catch((error) => {
      if ((error as NodeJS.ErrnoException).code !== "ERR_DIR_CLOSED") throw error;
    });
  }
  const after = await lstat(path);
  assertPrivateDirectoryMetadata(after, path);
  if (before.dev !== after.dev || before.ino !== after.ino) {
    throw new Error(`${label} changed while it was being scanned`);
  }
  return entries.sort();
}

async function readFileExact(
  handle: Awaited<ReturnType<typeof open>>,
  expectedBytes: number,
  maxBytes: number,
  source: string
): Promise<Buffer> {
  if (!Number.isSafeInteger(expectedBytes) || expectedBytes < 0 || expectedBytes > maxBytes) {
    throw new Error(`Backup source exceeds the ${maxBytes}-byte read limit: ${source}`);
  }
  const contents = Buffer.allocUnsafe(expectedBytes);
  let offset = 0;
  while (offset < expectedBytes) {
    const { bytesRead } = await handle.read(contents, offset, expectedBytes - offset, offset);
    if (bytesRead === 0) throw new Error(`Backup source changed while being read: ${source}`);
    offset += bytesRead;
  }
  const growthProbe = Buffer.allocUnsafe(1);
  const { bytesRead: growthBytes } = await handle.read(growthProbe, 0, 1, expectedBytes);
  if (growthBytes !== 0) throw new Error(`Backup source changed while being read: ${source}`);
  return contents;
}

async function assertSourceParent(source: string): Promise<void> {
  const parent = source.slice(0, source.lastIndexOf(sep));
  const metadata = await lstat(parent);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error(`Backup source parent is not a real directory: ${parent}`);
  }
  assertCurrentUser(metadata, parent);
}

function assertPrivateDirectoryMetadata(metadata: Stats, path: string): void {
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error(`Private backup path is not a real directory: ${path}`);
  }
  if ((metadata.mode & 0o077) !== 0) throw new Error(`Private backup directory permissions are not owner-only: ${path}`);
  assertCurrentUser(metadata, path);
}

function validateContext(context: ProfileContext): void {
  assertProfileIdentity(context.profile);
  const canonical = canonicalProfilePath(context.profile.path);
  if (resolve(context.profile.path) !== canonical) {
    throw new Error("Backup Profile path must be its canonical filesystem target");
  }
}

function validateProfileId(profileId: string): void {
  if (!/^profile:[0-9a-f]{64}$/u.test(profileId)) throw new Error("Backup Profile id is not canonical");
}

function profileStorageSegment(profileId: string): string {
  validateProfileId(profileId);
  return `profile-${profileId.slice("profile:".length)}`;
}

function validateCommand(command: string): void {
  if (!command || Buffer.byteLength(command) > MAX_COMMAND_BYTES) {
    throw new Error(`Backup command must contain 1 to ${MAX_COMMAND_BYTES} UTF-8 bytes`);
  }
}

function effectiveBackupCapacityPolicy(hooks: BackupStoreHooks): EffectiveBackupCapacityPolicy {
  const requestedBackups = hooks.capacityPolicy?.maxBackups ?? MAX_BACKUPS;
  if (!Number.isSafeInteger(requestedBackups) || requestedBackups < 1) {
    throw new Error("Backup capacity maxBackups must be a positive safe integer");
  }
  const requestedStoreBytes = hooks.capacityPolicy?.maxStoreBytes ?? MAX_BACKUP_STORE_BYTES;
  if (!Number.isSafeInteger(requestedStoreBytes) || requestedStoreBytes < 1) {
    throw new Error("Backup capacity maxStoreBytes must be a positive safe integer");
  }
  const requestedFreeBytes = hooks.capacityPolicy?.minimumFreeBytes ?? MINIMUM_BACKUP_FILESYSTEM_FREE_BYTES;
  if (!Number.isSafeInteger(requestedFreeBytes) || requestedFreeBytes < 0) {
    throw new Error("Backup capacity minimumFreeBytes must be a non-negative safe integer");
  }
  return {
    maxBackups: Math.min(requestedBackups, MAX_BACKUPS),
    maxStoreBytes: Math.min(requestedStoreBytes, MAX_BACKUP_STORE_BYTES),
    minimumFreeBytes: Math.max(requestedFreeBytes, MINIMUM_BACKUP_FILESYSTEM_FREE_BYTES)
  };
}

function addByteCounts(left: number, right: number, label: string): number {
  const total = left + right;
  if (!Number.isSafeInteger(left) || left < 0
    || !Number.isSafeInteger(right) || right < 0
    || !Number.isSafeInteger(total)) {
    throw new Error(`${label} is outside the safe integer range`);
  }
  return total;
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * MEBIBYTE) return `${(bytes / (1024 * MEBIBYTE)).toFixed(2)} GiB`;
  if (bytes >= MEBIBYTE) return `${(bytes / MEBIBYTE).toFixed(2)} MiB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(2)} KiB`;
  return `${bytes} B`;
}

function validateBackupId(id: string): void {
  if (!BACKUP_ID_PATTERN.test(id)) throw new Error(`Invalid backup id: ${id}`);
}

function validatePruneId(id: string): void {
  if (!PRUNE_ID_PATTERN.test(id)) throw new Error(`Invalid backup prune id: ${id}`);
}

function newArtifactIdentity(kind: "backup" | "prune"): { id: string; createdAt: string } {
  const createdAt = new Date().toISOString();
  return { id: `${kind}-${compactTimestamp(createdAt)}-${randomUUID()}`, createdAt };
}

function compactTimestamp(value: string): string {
  return value.replace(/[-:.]/gu, "");
}

function assertArtifactTimeBinding(id: string, createdAt: string, kind: "backup" | "prune"): void {
  if (!id.startsWith(`${kind}-${compactTimestamp(createdAt)}-`)) {
    throw new Error(`${kind} id is not bound to its createdAt timestamp`);
  }
}

function backupManifestPath(root: string, id: string): string {
  validateBackupId(id);
  return privatePath(root, `${id}--manifest.json`);
}

function createIntentPath(root: string, id: string): string {
  validateBackupId(id);
  return privatePath(root, `${id}--create-intent.json`);
}

function backupDataPath(root: string, id: string, token: string): string {
  validateBackupId(id);
  if (!BACKUP_SOURCE_SPECS.some((spec) => spec.token === token)) throw new Error("Unknown backup source token");
  return privatePath(root, `${id}--${token}.bak`);
}

function pruneIntentPath(root: string, id: string): string {
  validatePruneId(id);
  return privatePath(root, `${id}--intent.json`);
}

function pruneReceiptPath(root: string, id: string): string {
  validatePruneId(id);
  return privatePath(root, `${id}--receipt.json`);
}

function sourcePath(profilePath: string, spec: BackupSourceSpec): string {
  const source = resolve(profilePath, ...spec.relative);
  const root = resolve(profilePath);
  if (!source.startsWith(`${root}${sep}`)) throw new Error("Backup source escapes its Profile root");
  return source;
}

function canonicalBoundProfilePath(value: unknown, profileId: string, label: string): string {
  const path = stringValue(value, `${label} profilePath`, MAX_PATH_BYTES);
  if (!isAbsolute(path) || resolve(path) !== path) throw new Error(`${label} Profile path is not absolute and normalized`);
  if (profileIdForPath(path) !== profileId) throw new Error(`${label} Profile path does not match its Profile id`);
  return path;
}

async function privateFileFingerprint(
  path: string,
  expectedSize: number | null,
  limit = MAX_BACKUP_BYTES,
  allowPublicationResidue = false
): Promise<FileFingerprint> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const metadata = await handle.stat();
    assertPrivateMetadata(metadata, path, allowPublicationResidue);
    if (metadata.size > limit) {
      throw new Error(`Private backup file exceeds the ${limit}-byte read limit: ${path}`);
    }
    if (expectedSize !== null && metadata.size !== expectedSize) {
      throw new Error(`Private backup file size is invalid: ${path}`);
    }
    const canonical = await lstat(path);
    assertSameIdentity(canonical, metadata, `Private backup path changed: ${path}`);
    return fileFingerprint(metadata);
  } finally {
    await handle.close();
  }
}

async function assertPrivateFileMetadata(
  path: string,
  maxBytes: number,
  allowPublicationResidue = false
): Promise<void> {
  await privateFileFingerprint(path, null, maxBytes, allowPublicationResidue);
}

async function assertFileFingerprint(path: string, expected: FileFingerprint, expectedSize: number): Promise<void> {
  const current = await privateFileFingerprint(
    path,
    expectedSize,
    path.endsWith("--manifest.json") ? MAX_MANIFEST_BYTES : MAX_BACKUP_BYTES
  );
  assertSameFingerprint(expected, current, `Backup prune target changed after intent publication: ${path}`);
}

function assertSourceFile(metadata: Stats, path: string): void {
  if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error(`Backup source is not a regular file: ${path}`);
  if (metadata.nlink !== 1) throw new Error(`Backup source has an unexpected hardlink count: ${path}`);
  assertCurrentUser(metadata, path);
}

function assertPrivateMetadata(metadata: Stats, path: string, allowPublicationResidue = false): void {
  if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error(`Private backup artifact is not a regular file: ${path}`);
  if (metadata.nlink !== 1 && !(allowPublicationResidue && metadata.nlink === 2)) {
    throw new Error(`Private backup artifact has an unexpected hardlink count: ${path}`);
  }
  if ((metadata.mode & 0o077) !== 0) throw new Error(`Private backup artifact permissions are not owner-only: ${path}`);
  assertCurrentUser(metadata, path);
}

function assertCurrentUser(metadata: Stats, path: string): void {
  if (typeof process.getuid === "function" && metadata.uid !== process.getuid()) {
    throw new Error(`Backup path is not owned by the current user: ${path}`);
  }
}

function fileFingerprint(metadata: Stats): FileFingerprint {
  for (const [label, value] of Object.entries({
    device: metadata.dev,
    inode: metadata.ino,
    size: metadata.size,
    modifiedMs: metadata.mtimeMs,
    changedMs: metadata.ctimeMs
  })) {
    if (!Number.isSafeInteger(value) && label !== "modifiedMs" && label !== "changedMs") {
      throw new Error(`File fingerprint ${label} is outside the safe integer range`);
    }
    if (!Number.isFinite(value) || value < 0) throw new Error(`File fingerprint ${label} is invalid`);
  }
  return {
    device: metadata.dev,
    inode: metadata.ino,
    size: metadata.size,
    modifiedMs: metadata.mtimeMs,
    changedMs: metadata.ctimeMs
  };
}

function fingerprintsEqual(left: FileFingerprint, right: FileFingerprint): boolean {
  return left.device === right.device
    && left.inode === right.inode
    && left.size === right.size
    && left.modifiedMs === right.modifiedMs
    && left.changedMs === right.changedMs;
}

function assertSameFingerprint(left: FileFingerprint, right: FileFingerprint, message: string): void {
  if (!fingerprintsEqual(left, right)) throw new Error(message);
}

function assertSameIdentity(left: Stats, right: Stats, message: string): void {
  if (left.isSymbolicLink() || !left.isFile() || left.dev !== right.dev || left.ino !== right.ino || left.nlink !== right.nlink) {
    throw new Error(message);
  }
}

function assertExactChild(path: string, root: string): void {
  const resolvedRoot = resolve(root);
  const resolvedPath = resolve(path);
  if (resolvedPath === resolvedRoot || !resolvedPath.startsWith(`${resolvedRoot}${sep}`)) {
    throw new Error(`Backup artifact path escapes its Profile backup root: ${path}`);
  }
}

async function removeIfPrivateFile(path: string): Promise<void> {
  try {
    await removePrivateFile(path);
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
}

async function pathExistsNoFollow(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

function withUniformOutcome(
  candidates: readonly BackupPruneCandidate[],
  outcome: BackupPruneFileOutcome
): BackupPruneCandidate[] {
  return candidates.map((candidate) => ({
    ...candidate,
    files: candidate.files.map((file) => ({ ...file, outcome }))
  }));
}

function strictObject(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${label} fields are invalid`);
  }
  return value as Record<string, unknown>;
}

function stringValue(value: unknown, label: string, maxBytes: number): string {
  if (typeof value !== "string" || value.length === 0 || Buffer.byteLength(value) > maxBytes || value.includes("\0")) {
    throw new Error(`${label} must be a non-empty string no larger than ${maxBytes} bytes`);
  }
  return value;
}

function nullableString(value: unknown, label: string, maxBytes: number): string | null {
  if (value === null) return null;
  return stringValue(value, label, maxBytes);
}

function isoTimestamp(value: unknown, label: string): string {
  const parsed = stringValue(value, label, 64);
  const milliseconds = Date.parse(parsed);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== parsed) {
    throw new Error(`${label} must be a canonical ISO timestamp`);
  }
  return parsed;
}

function boundedInteger(value: unknown, label: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > maximum) {
    throw new Error(`${label} is outside its supported range`);
  }
  return value as number;
}

function finiteNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new Error(`${label} is invalid`);
  return value;
}

function defineKernelLock(value: unknown): void {
  const object = strictObject(value, ["schemaVersion"], "Backup kernel control file");
  if (object.schemaVersion !== KERNEL_LOCK_FILE_SCHEMA) throw new Error("Backup kernel control file schema is invalid");
}

function sha256(contents: Uint8Array): string {
  return createHash("sha256").update(contents).digest("hex");
}

function boundedFailure(error: unknown, additional: readonly unknown[] = []): string {
  const message = [error, ...additional].map(errorMessage).join("; ");
  return Buffer.byteLength(message) <= MAX_COMMAND_BYTES
    ? message
    : Buffer.from(message).subarray(0, MAX_COMMAND_BYTES).toString("utf8");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function reconciliationError(kind: string, messages: readonly string[]): Error {
  return new Error(`Previous backup ${kind} required reconciliation; no new operation started: ${messages.join("; ")}`);
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === "ENOENT";
}
