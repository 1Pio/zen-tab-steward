import { createHash } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { lstat, open, type FileHandle } from "node:fs/promises";
import { dirname } from "node:path";
import { atomicSwapFilesDarwin } from "./atomic-fs.js";

import type { Sha256Digest } from "./domain/digest.js";

const READ_CHUNK_BYTES = 64 * 1024;

export interface AtomicFileFingerprint {
  readonly digest: Sha256Digest;
  readonly size: number;
  readonly mode: number;
  readonly modifiedMs: number;
  readonly changedMs: number;
  readonly device: number;
  readonly inode: number;
}

export interface AtomicReplaceBoundedFileOptions {
  readonly targetPath: string;
  readonly preparedPath: string;
  readonly expectedTarget: AtomicFileFingerprint;
  readonly expectedPreparedDigest: Sha256Digest;
  readonly maxBytes: number;
  /** Internal fault-injection hook after both open files are validated. */
  readonly afterSourceValidation?: () => void | Promise<void>;
  /** Internal fault-injection hook after the swap and before displaced validation. */
  readonly afterAtomicSwap?: () => void | Promise<void>;
}

export interface AtomicReplaceBoundedFileResult {
  /** The exact source displaced by the accepted commit, now at preparedPath. */
  readonly displaced: AtomicFileFingerprint;
}

export interface AtomicFileState {
  readonly bytes: Buffer;
  readonly fingerprint: AtomicFileFingerprint;
}

export interface InterruptedAtomicReplaceOptions {
  readonly targetPath: string;
  readonly preparedPath: string;
  readonly expectedTarget: AtomicFileFingerprint;
  readonly expectedPreparedDigest: Sha256Digest;
  readonly maxBytes: number;
  /** Internal race hook after initial classification and before reconciliation. */
  readonly afterClassification?: () => void | Promise<void>;
  /** Journal evidence proves the original helper outcome itself was indeterminate. */
  readonly commitOutcomePreviouslyUncertain?: boolean;
}

export type InterruptedAtomicReplaceResult =
  | {
      readonly classification: "accepted_commit" | "not_committed" | "drift_restored" | "commit_overwritten";
      readonly reason:
        | "expected_displaced_source"
        | "expected_source_present"
        | "external_drift_before_commit"
        | "raced_source_restored"
        | "external_writer_replaced_uncertain_commit";
      readonly mutationPerformed: boolean;
      readonly target: AtomicFileState;
      readonly prepared: AtomicFileState;
      readonly residuePaths: readonly [string];
    }
  | {
      readonly classification: "uncertain";
      readonly reason: string;
      readonly mutationPerformed: boolean | null;
      readonly target: AtomicFileState | null;
      readonly prepared: AtomicFileState | null;
      readonly residuePaths: readonly string[];
    };

export class AtomicFileMismatchError extends Error {
  readonly code = "ATOMIC_FILE_MISMATCH" as const;

  constructor(message: string) {
    super(message);
    this.name = "AtomicFileMismatchError";
  }
}

export class AtomicFileCommitUncertainError extends Error {
  readonly code = "ATOMIC_FILE_COMMIT_UNCERTAIN" as const;
  readonly mutationMayHaveOccurred = true;
  readonly residuePaths: readonly string[];

  constructor(message: string, residuePaths: readonly string[], options?: ErrorOptions) {
    super(message, options);
    this.name = "AtomicFileCommitUncertainError";
    this.residuePaths = [...new Set(residuePaths)];
  }
}

/**
 * Installs a prepared owner-private file at one exact expected target state.
 * The linearization point is a macOS atomic swap. The displaced source is
 * validated after that swap; mismatch is reversed with one second atomic
 * swap, so the canonical name is never absent. A later writer is never
 * overwritten when the expected pair has changed. Uncertain
 * recovery leaves every reachable entry in place and is typed distinctly.
 *
 * On success, the displaced source remains at preparedPath for the caller to
 * remove only after the new target and parent directory are durable.
 */
export async function atomicReplaceBoundedFile(
  options: AtomicReplaceBoundedFileOptions
): Promise<AtomicReplaceBoundedFileResult> {
  validateLimit(options.maxBytes);
  if (dirname(options.targetPath) !== dirname(options.preparedPath)) {
    throw new Error("Atomic bounded-file replacement requires a same-directory prepared path");
  }
  const target = await open(options.targetPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  let prepared: FileHandle | null = null;
  let swapped = false;
  try {
    const targetBefore = await fingerprintOpenFile(target, options.targetPath, options.maxBytes, true);
    if (!sameAtomicFileFingerprint(targetBefore, options.expectedTarget)) {
      throw new AtomicFileMismatchError("Atomic commit refused source Drift before replacement");
    }
    await assertPathNamesHandle(options.targetPath, targetBefore);

    prepared = await open(options.preparedPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const preparedBefore = await fingerprintOpenFile(prepared, options.preparedPath, options.maxBytes, true);
    if (preparedBefore.digest !== options.expectedPreparedDigest) {
      throw new Error("Atomic commit prepared file digest does not match its durable intent");
    }
    if (preparedBefore.mode !== 0o600) throw new Error("Atomic commit prepared file is not owner-private");
    await assertPathNamesHandle(options.preparedPath, preparedBefore);
    await options.afterSourceValidation?.();

    try {
      await atomicSwapFilesDarwin(options.preparedPath, options.targetPath);
      swapped = true;
    } catch (error) {
      if (await pathsStillNameExpectedFiles(options, targetBefore, preparedBefore)) throw error;
      throw new AtomicFileCommitUncertainError(
        "Atomic commit helper ended without a trustworthy filesystem outcome",
        [options.targetPath, options.preparedPath],
        { cause: error }
      );
    }

    try {
      await options.afterAtomicSwap?.();
      const [displaced, committed] = await Promise.all([
        fingerprintOpenFile(target, options.preparedPath, options.maxBytes, true),
        fingerprintOpenFile(prepared, options.targetPath, options.maxBytes, true)
      ]);
      await Promise.all([
        assertPathNamesHandle(options.preparedPath, displaced),
        assertPathNamesHandle(options.targetPath, committed)
      ]);
      if (!sameFingerprintAfterRename(displaced, options.expectedTarget)
        || committed.digest !== options.expectedPreparedDigest
        || committed.device !== preparedBefore.device
        || committed.inode !== preparedBefore.inode
        || committed.size !== preparedBefore.size
        || committed.mode !== preparedBefore.mode
        || committed.modifiedMs !== preparedBefore.modifiedMs) {
        throw new AtomicFileMismatchError("Atomic commit detected source Drift at its swap boundary");
      }
      return { displaced };
    } catch (error) {
      const rollback = await rollbackWithoutOverwrite(
        options.targetPath,
        options.preparedPath,
        preparedBefore,
        null,
        options.maxBytes
      );
      swapped = false;
      if (rollback === "restored") {
        throw error instanceof AtomicFileMismatchError
          ? error
          : new AtomicFileMismatchError("Atomic commit detected Drift and restored the displaced writer exactly");
      }
      throw new AtomicFileCommitUncertainError(
        "Atomic commit detected concurrent replacement while restoring Drift; all reachable writer states were preserved",
        rollback.residuePaths,
        { cause: error }
      );
    }
  } finally {
    const errors: unknown[] = [];
    if (prepared) {
      try {
        await prepared.close();
      } catch (error) {
        errors.push(error);
      }
    }
    try {
      await target.close();
    } catch (error) {
      errors.push(error);
    }
    if (errors.length > 0 && !swapped) {
      // A close failure does not make an otherwise completed atomic swap
      // uncertain, but before/after rollback it remains a normal I/O error.
      throw errors.length === 1 ? errors[0] : new AggregateError(errors, "Atomic commit file handles failed to close");
    }
  }
}

/** Reads exact bounded bytes and their no-follow filesystem identity once. */
export async function readBoundedFileState(path: string, maxBytes: number): Promise<AtomicFileState> {
  validateLimit(maxBytes);
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    assertSafeMetadata(before, path, maxBytes, true);
    const bytes = Buffer.allocUnsafe(before.size);
    let offset = 0;
    while (offset < before.size) {
      const { bytesRead } = await handle.read(bytes, offset, before.size - offset, offset);
      if (bytesRead === 0) throw new Error(`Atomic bounded-file source truncated while being read: ${path}`);
      offset += bytesRead;
    }
    const extra = Buffer.allocUnsafe(1);
    if ((await handle.read(extra, 0, 1, before.size)).bytesRead !== 0) {
      throw new Error(`Atomic bounded-file source grew while being read: ${path}`);
    }
    const after = await handle.stat();
    assertSafeMetadata(after, path, maxBytes, true);
    if (before.dev !== after.dev
      || before.ino !== after.ino
      || before.size !== after.size
      || before.mode !== after.mode
      || before.mtimeMs !== after.mtimeMs
      || before.ctimeMs !== after.ctimeMs) {
      throw new Error(`Atomic bounded-file source changed while being read: ${path}`);
    }
    const fingerprint = fingerprintFromStats(
      after,
      `sha256:${createHash("sha256").update(bytes).digest("hex")}`
    );
    await assertPathNamesHandle(path, fingerprint);
    return { bytes, fingerprint };
  } finally {
    await handle.close();
  }
}

/**
 * Classifies and, only when required, reverses an interrupted atomic swap.
 * Callers must already hold their route-specific exclusive control. A valid
 * displaced expected source proves the commit boundary. A different displaced
 * source is restored with no-replace operations; uncertainty never unlinks a
 * path and reports every reachable residue for explicit recovery.
 */
export async function reconcileInterruptedAtomicReplace(
  options: InterruptedAtomicReplaceOptions
): Promise<InterruptedAtomicReplaceResult> {
  validateLimit(options.maxBytes);
  if (dirname(options.targetPath) !== dirname(options.preparedPath)) {
    throw new Error("Interrupted atomic replacement requires same-directory paths");
  }
  const [target, prepared] = await Promise.all([
    readBoundedFileState(options.targetPath, options.maxBytes),
    readBoundedFileState(options.preparedPath, options.maxBytes)
  ]);
  await options.afterClassification?.();

  if (target.fingerprint.digest === options.expectedPreparedDigest
    && sameFingerprintAfterRename(prepared.fingerprint, options.expectedTarget)) {
    const stable = await rereadStablePair(options, target, prepared);
    if (!stable) {
      return uncertainReconciliation(
        options,
        "Atomic replacement paths changed after a valid displaced source was observed",
        false
      );
    }
    return {
      classification: "accepted_commit",
      reason: "expected_displaced_source",
      mutationPerformed: false,
      target: stable.target,
      prepared: stable.prepared,
      residuePaths: [options.preparedPath]
    };
  }

  if (target.fingerprint.digest === options.expectedPreparedDigest
    && !sameFingerprintAfterRename(prepared.fingerprint, options.expectedTarget)) {
    const rollback = await rollbackWithoutOverwrite(
      options.targetPath,
      options.preparedPath,
      target.fingerprint,
      prepared.fingerprint,
      options.maxBytes
    );
    if (rollback !== "restored") {
      return uncertainReconciliation(
        options,
        "A second writer raced interrupted-swap restoration; every reachable state was preserved",
        rollback.mutationPerformed,
        rollback.residuePaths
      );
    }
    const [restoredTarget, restoredPrepared] = await Promise.all([
      readBoundedFileState(options.targetPath, options.maxBytes),
      readBoundedFileState(options.preparedPath, options.maxBytes)
    ]);
    if (!sameFingerprintAfterRename(restoredTarget.fingerprint, prepared.fingerprint)
      || restoredPrepared.fingerprint.digest !== options.expectedPreparedDigest
      || restoredPrepared.fingerprint.device !== target.fingerprint.device
      || restoredPrepared.fingerprint.inode !== target.fingerprint.inode) {
      return uncertainReconciliation(
        options,
        "Interrupted-swap restoration completed without the exact expected inode bindings",
        true
      );
    }
    return {
      classification: "drift_restored",
      reason: "raced_source_restored",
      mutationPerformed: true,
      target: restoredTarget,
      prepared: restoredPrepared,
      residuePaths: [options.preparedPath]
    };
  }

  if (prepared.fingerprint.digest === options.expectedPreparedDigest
    && target.fingerprint.digest !== options.expectedPreparedDigest) {
    const stable = await rereadStablePair(options, target, prepared);
    if (!stable) {
      return uncertainReconciliation(
        options,
        "Atomic replacement paths changed while a not-committed state was being confirmed",
        false
      );
    }
    return {
      classification: "not_committed",
      reason: sameAtomicFileFingerprint(target.fingerprint, options.expectedTarget)
        ? "expected_source_present"
        : "external_drift_before_commit",
      mutationPerformed: false,
      target: stable.target,
      prepared: stable.prepared,
      residuePaths: [options.preparedPath]
    };
  }

  if (options.commitOutcomePreviouslyUncertain) {
    const stable = await rereadStablePair(options, target, prepared);
    if (!stable) {
      return uncertainReconciliation(
        options,
        "Atomic replacement paths changed while an externally overwritten commit was being confirmed",
        null
      );
    }
    return {
      classification: "commit_overwritten",
      reason: "external_writer_replaced_uncertain_commit",
      mutationPerformed: false,
      target: stable.target,
      prepared: stable.prepared,
      residuePaths: [options.preparedPath]
    };
  }

  return uncertainReconciliation(
    options,
    "Interrupted atomic replacement does not match a recognized safe crash state",
    false
  );
}

export function sameAtomicFileFingerprint(
  left: AtomicFileFingerprint,
  right: AtomicFileFingerprint
): boolean {
  return left.digest === right.digest
    && left.size === right.size
    && left.mode === right.mode
    && left.modifiedMs === right.modifiedMs
    && left.changedMs === right.changedMs
    && left.device === right.device
    && left.inode === right.inode;
}

async function fingerprintOpenFile(
  handle: FileHandle,
  path: string,
  maxBytes: number,
  requireStableLinkCount: boolean
): Promise<AtomicFileFingerprint> {
  const before = await handle.stat();
  assertSafeMetadata(before, path, maxBytes, requireStableLinkCount);
  const hash = createHash("sha256");
  const chunk = Buffer.allocUnsafe(Math.max(1, Math.min(READ_CHUNK_BYTES, before.size)));
  let offset = 0;
  while (offset < before.size) {
    const length = Math.min(chunk.byteLength, before.size - offset);
    const { bytesRead } = await handle.read(chunk, 0, length, offset);
    if (bytesRead === 0) throw new Error(`Atomic commit source truncated while being read: ${path}`);
    hash.update(chunk.subarray(0, bytesRead));
    offset += bytesRead;
  }
  const extra = Buffer.allocUnsafe(1);
  if ((await handle.read(extra, 0, 1, before.size)).bytesRead !== 0) {
    throw new Error(`Atomic commit source grew while being read: ${path}`);
  }
  const after = await handle.stat();
  assertSafeMetadata(after, path, maxBytes, requireStableLinkCount);
  if (before.dev !== after.dev
    || before.ino !== after.ino
    || before.size !== after.size
    || before.mode !== after.mode
    || before.mtimeMs !== after.mtimeMs
    || before.ctimeMs !== after.ctimeMs) {
    throw new Error(`Atomic commit source changed while being read: ${path}`);
  }
  return fingerprintFromStats(after, `sha256:${hash.digest("hex")}`);
}

function assertSafeMetadata(metadata: Stats, path: string, maxBytes: number, requireLinkCount: boolean): void {
  if (!metadata.isFile()) throw new Error(`Atomic commit path is not a regular file: ${path}`);
  if (requireLinkCount && metadata.nlink !== 1) {
    throw new Error(`Atomic commit path has an unexpected hardlink count: ${path}`);
  }
  if (process.getuid && metadata.uid !== process.getuid()) {
    throw new Error(`Atomic commit path is not owned by the current user: ${path}`);
  }
  if (metadata.size > maxBytes) throw new Error(`Atomic commit path exceeds its ${maxBytes}-byte bound: ${path}`);
}

function fingerprintFromStats(metadata: Stats, digest: Sha256Digest): AtomicFileFingerprint {
  return {
    digest,
    size: metadata.size,
    mode: metadata.mode & 0o777,
    modifiedMs: metadata.mtimeMs,
    changedMs: metadata.ctimeMs,
    device: metadata.dev,
    inode: metadata.ino
  };
}

async function assertPathNamesHandle(path: string, held: AtomicFileFingerprint): Promise<void> {
  const canonical = await lstat(path);
  if (canonical.isSymbolicLink()
    || !canonical.isFile()
    || canonical.dev !== held.device
    || canonical.ino !== held.inode) {
    throw new Error(`Atomic commit canonical path changed: ${path}`);
  }
}

function sameFingerprintAfterRename(actual: AtomicFileFingerprint, expected: AtomicFileFingerprint): boolean {
  return actual.digest === expected.digest
    && actual.size === expected.size
    && actual.mode === expected.mode
    && actual.modifiedMs === expected.modifiedMs
    && actual.device === expected.device
    && actual.inode === expected.inode;
}

async function pathsStillNameExpectedFiles(
  options: AtomicReplaceBoundedFileOptions,
  target: AtomicFileFingerprint,
  prepared: AtomicFileFingerprint
): Promise<boolean> {
  try {
    await Promise.all([
      assertPathNamesHandle(options.targetPath, target),
      assertPathNamesHandle(options.preparedPath, prepared)
    ]);
    return true;
  } catch {
    return false;
  }
}

async function rollbackWithoutOverwrite(
  targetPath: string,
  preparedPath: string,
  installedAtTarget: AtomicFileFingerprint,
  expectedDisplacedAtPrepared: AtomicFileFingerprint | null,
  maxBytes: number
): Promise<"restored" | {
  readonly mutationPerformed: boolean | null;
  readonly residuePaths: readonly string[];
}> {
  let beforeTarget: AtomicFileState;
  let beforePrepared: AtomicFileState;
  try {
    [beforeTarget, beforePrepared] = await Promise.all([
      readBoundedFileState(targetPath, maxBytes),
      readBoundedFileState(preparedPath, maxBytes)
    ]);
  } catch {
    return { mutationPerformed: false, residuePaths: await existingPaths([targetPath, preparedPath]) };
  }
  if (!sameFingerprintAfterRename(beforeTarget.fingerprint, installedAtTarget)
    || (expectedDisplacedAtPrepared
      && !sameAtomicFileFingerprint(beforePrepared.fingerprint, expectedDisplacedAtPrepared))) {
    return { mutationPerformed: false, residuePaths: await existingPaths([targetPath, preparedPath]) };
  }

  try {
    // Restoring the displaced writer is itself one atomic swap. There is no
    // interval in which the canonical target is absent and no unjournaled
    // quarantine name that a later recovery would need to discover.
    await atomicSwapFilesDarwin(preparedPath, targetPath);
  } catch {
    // A lost helper response is resolved from exact inode placement below.
  }

  let afterTarget: AtomicFileState | null = null;
  let afterPrepared: AtomicFileState | null = null;
  try {
    [afterTarget, afterPrepared] = await Promise.all([
      readBoundedFileState(targetPath, maxBytes),
      readBoundedFileState(preparedPath, maxBytes)
    ]);
    if (sameFingerprintAfterRename(afterTarget.fingerprint, beforePrepared.fingerprint)
      && sameFingerprintAfterRename(afterPrepared.fingerprint, beforeTarget.fingerprint)) {
      // A helper response may be lost after the swap commits. Exact inode
      // placement, not the helper exit status, proves restoration.
      await syncParentDirectory(targetPath);
      return "restored";
    }
  } catch {
    // The exact reachable names are reported below. Atomic swap guarantees
    // that this helper itself never creates a canonical-absent intermediate.
  }
  return {
    mutationPerformed: null,
    residuePaths: await existingPaths([targetPath, preparedPath])
  };
}

async function syncParentDirectory(path: string): Promise<void> {
  const directory = await open(dirname(path), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

async function existingPaths(paths: readonly string[]): Promise<readonly string[]> {
  const existing: string[] = [];
  for (const path of paths) {
    try {
      await lstat(path);
      existing.push(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") existing.push(path);
    }
  }
  return existing;
}

async function rereadStablePair(
  options: InterruptedAtomicReplaceOptions,
  target: AtomicFileState,
  prepared: AtomicFileState
): Promise<{ readonly target: AtomicFileState; readonly prepared: AtomicFileState } | null> {
  try {
    const [currentTarget, currentPrepared] = await Promise.all([
      readBoundedFileState(options.targetPath, options.maxBytes),
      readBoundedFileState(options.preparedPath, options.maxBytes)
    ]);
    return sameAtomicFileFingerprint(currentTarget.fingerprint, target.fingerprint)
      && sameAtomicFileFingerprint(currentPrepared.fingerprint, prepared.fingerprint)
      ? { target: currentTarget, prepared: currentPrepared }
      : null;
  } catch {
    return null;
  }
}

async function uncertainReconciliation(
  options: InterruptedAtomicReplaceOptions,
  reason: string,
  mutationPerformed: boolean | null,
  additionalResiduePaths: readonly string[] = []
): Promise<Extract<InterruptedAtomicReplaceResult, { readonly classification: "uncertain" }>> {
  const [target, prepared] = await Promise.all([
    readOptionalBoundedFileState(options.targetPath, options.maxBytes),
    readOptionalBoundedFileState(options.preparedPath, options.maxBytes)
  ]);
  return {
    classification: "uncertain",
    reason,
    mutationPerformed,
    target,
    prepared,
    residuePaths: await existingPaths([
      options.targetPath,
      options.preparedPath,
      ...additionalResiduePaths
    ])
  };
}

async function readOptionalBoundedFileState(path: string, maxBytes: number): Promise<AtomicFileState | null> {
  try {
    return await readBoundedFileState(path, maxBytes);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    return null;
  }
}

function validateLimit(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error("Atomic bounded-file replacement requires a positive safe byte limit");
  }
}
