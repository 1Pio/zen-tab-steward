import { constants, type Stats } from "node:fs";
import { link, lstat, mkdir, open, readdir, rename, rm, rmdir } from "node:fs/promises";
import { basename, dirname, resolve, sep } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import {
  AtomicFileCommitUncertainError,
  AtomicFileMismatchError,
  atomicReplaceBoundedFile
} from "./atomic-file-cas.js";
import {
  AtomicRenameDestinationExistsError,
  atomicRenameNoReplaceDarwin
} from "./atomic-fs.js";

import type { AtomicFileFingerprint } from "./atomic-file-cas.js";
import type { Sha256Digest } from "./domain/digest.js";

const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const DEFAULT_MAX_JSON_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_BINARY_BYTES = 256 * 1024 * 1024;
const VALIDATION_CHUNK_BYTES = 64 * 1024;
const PRIVATE_TEMPORARY_BASENAME = /^\.tmp-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(?:artifact|json)$/u;

interface PrivateContentIdentity {
  readonly size: number;
  readonly digest: Sha256Digest;
}

export interface PrivatePublicationHooks {
  /** Internal fault-injection hook. The temp has bytes but has not been synced. */
  readonly afterTemporaryWrite?: () => void;
  /** Internal fault-injection hook. Both hardlinks exist when this runs. */
  readonly afterLink?: () => void;
}

export interface PrivateReplacementHooks {
  /** Internal fault-injection hook. The replacement temp is fully synced. */
  readonly beforeRename?: () => void | Promise<void>;
}

export interface PrivateComparedReplacementHooks {
  /** Internal fault-injection hook at the exact atomic exchange boundary. */
  readonly afterSourceValidation?: () => void | Promise<void>;
}

/**
 * Exact filesystem identity for one standalone zts temporary candidate.
 *
 * This is deliberately only a metadata classification. A one-link `.tmp-*`
 * inode is not, by itself, proof that deletion is safe: after a successful
 * compare-and-replace it can hold displaced-writer recovery evidence. A store
 * may call the removal primitive only after proving that the parent is owned
 * exclusively and that this parent uses ordinary exclusive-create,
 * immutable-publication, or replacement temporaries, never CAS temporaries.
 */
export interface PrivateStandaloneTemporaryCandidate {
  readonly path: string;
  readonly parentPath: string;
  readonly basename: string;
  readonly device: number;
  readonly inode: number;
  readonly size: number;
  readonly mode: number;
  readonly modifiedMs: number;
  readonly changedMs: number;
  readonly parentDevice: number;
  readonly parentInode: number;
  readonly maxBytes: number;
}

export function isPrivateTemporaryBasename(value: string): boolean {
  return PRIVATE_TEMPORARY_BASENAME.test(value);
}

/** Read-only strict classification. This function never reconciles or deletes. */
export async function inspectPrivateStandaloneTemporaryCandidate(
  path: string,
  maxBytes = DEFAULT_MAX_BINARY_BYTES
): Promise<PrivateStandaloneTemporaryCandidate> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new Error("Private temporary inspection limit must be a positive integer");
  }
  const resolvedPath = resolve(path);
  const parentPath = dirname(resolvedPath);
  const name = basename(resolvedPath);
  if (!isPrivateTemporaryBasename(name) || privatePath(parentPath, name) !== resolvedPath) {
    throw new Error(`Private temporary name is not one exact zts publication name: ${path}`);
  }
  await assertNoUserControlledSymlinkAncestors(resolvedPath);
  const parent = await lstat(parentPath);
  assertPrivateDirectoryMetadata(parent, parentPath);
  const handle = await open(resolvedPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    assertPrivateFileMetadata(before, resolvedPath);
    assertSinglePrivateLink(before, resolvedPath);
    assertPrivateFileMode(before, resolvedPath);
    if (!Number.isSafeInteger(before.size) || before.size < 0 || before.size > maxBytes) {
      throw new Error(`Private temporary exceeds the ${maxBytes}-byte inspection limit: ${resolvedPath}`);
    }
    const current = await lstat(resolvedPath);
    if (current.isSymbolicLink()
      || current.dev !== before.dev
      || current.ino !== before.ino
      || current.size !== before.size
      || (current.mode & 0o777) !== (before.mode & 0o777)
      || current.mtimeMs !== before.mtimeMs
      || current.ctimeMs !== before.ctimeMs) {
      throw new Error(`Private temporary changed during read-only inspection: ${resolvedPath}`);
    }
    return Object.freeze({
      path: resolvedPath,
      parentPath,
      basename: name,
      device: before.dev,
      inode: before.ino,
      size: before.size,
      mode: before.mode & 0o777,
      modifiedMs: before.mtimeMs,
      changedMs: before.ctimeMs,
      parentDevice: parent.dev,
      parentInode: parent.ino,
      maxBytes
    });
  } finally {
    await handle.close();
  }
}

/**
 * Removes one previously inspected standalone candidate by exact identity.
 * The caller must hold the parent store's exclusive owner and must have proved
 * that the parent cannot contain compare-and-replace displaced-writer temps.
 */
export async function removePrivateStandaloneTemporaryCandidate(
  expected: PrivateStandaloneTemporaryCandidate
): Promise<void> {
  const current = await inspectPrivateStandaloneTemporaryCandidate(expected.path, expected.maxBytes);
  if (current.parentPath !== expected.parentPath
    || current.basename !== expected.basename
    || current.device !== expected.device
    || current.inode !== expected.inode
    || current.size !== expected.size
    || current.mode !== expected.mode
    || current.modifiedMs !== expected.modifiedMs
    || current.changedMs !== expected.changedMs
    || current.parentDevice !== expected.parentDevice
    || current.parentInode !== expected.parentInode) {
    throw new Error(`Private temporary Drifted before exact owner reconciliation: ${expected.path}`);
  }
  await rm(expected.path);
  try {
    await lstat(expected.path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      await syncDirectory(expected.parentPath);
      return;
    }
    throw error;
  }
  throw new Error(`Private temporary path reappeared during exact owner reconciliation: ${expected.path}`);
}

export class PrivatePublicationCommittedError extends Error {
  readonly path: string;
  readonly cause: unknown;
  readonly canonicalPathStillNamesPublication: boolean;

  constructor(path: string, cause: unknown, canonicalPathStillNamesPublication = true) {
    super(`Private publication committed at ${path} but post-publication durability work failed`);
    this.name = "PrivatePublicationCommittedError";
    this.path = path;
    this.cause = cause;
    this.canonicalPathStillNamesPublication = canonicalPathStillNamesPublication;
  }
}

export function privatePath(root: string, ...segments: string[]): string {
  const resolvedRoot = resolve(root);
  for (const segment of segments) assertSafeSegment(segment);
  const path = resolve(resolvedRoot, ...segments);
  if (path !== resolvedRoot && !path.startsWith(`${resolvedRoot}${sep}`)) {
    throw new Error("Private artifact path escapes its configured root");
  }
  return path;
}

export async function ensurePrivateDirectory(root: string, ...segments: string[]): Promise<string> {
  const resolvedRoot = resolve(root);
  await ensureDirectory(resolvedRoot, true);
  let current = resolvedRoot;
  for (const segment of segments) {
    assertSafeSegment(segment);
    current = privatePath(current, segment);
    await ensureDirectory(current, false);
  }
  return current;
}

export async function assertPrivateDirectory(root: string, ...segments: string[]): Promise<string> {
  const resolvedRoot = resolve(root);
  let current = resolvedRoot;
  await assertNoUserControlledSymlinkAncestors(current);
  assertPrivateDirectoryMetadata(await lstat(current), current);
  for (const segment of segments) {
    assertSafeSegment(segment);
    current = privatePath(current, segment);
    await assertNoUserControlledSymlinkAncestors(current);
    assertPrivateDirectoryMetadata(await lstat(current), current);
  }
  return current;
}

export async function publishPrivateJson(
  path: string,
  value: unknown,
  hooks: PrivatePublicationHooks = {}
): Promise<void> {
  await publishOwnedPrivateBytes(
    path,
    encodePrivateJsonBytes(value),
    DEFAULT_MAX_JSON_BYTES,
    hooks
  );
}

export async function createPrivateJsonExclusive(
  path: string,
  value: unknown,
  hooks: PrivatePublicationHooks = {}
): Promise<boolean> {
  const contents = encodePrivateJsonBytes(value);
  const expected = privateContentIdentity(contents);
  const parent = dirname(path);
  await ensureDirectory(parent);
  const temporary = privatePath(parent, `.tmp-${randomUUID()}.json`);
  await writeSyncedTemporary(temporary, contents, hooks);
  const intended = await publicationTemporaryIdentity(temporary);
  let linked = false;
  try {
    try {
      await link(temporary, path);
      linked = true;
      hooks.afterLink?.();
    } catch (error) {
      if (linked || (error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      await rm(temporary);
      await reconcilePrivatePublication(path);
      return false;
    }
    await finalizeLinkedPublication(path, temporary, intended, expected, DEFAULT_MAX_JSON_BYTES);
    return true;
  } catch (error) {
    if (linked) {
      try {
        await finalizeLinkedPublication(path, temporary, intended, expected, DEFAULT_MAX_JSON_BYTES);
        return true;
      } catch (recoveryError) {
        throw new PrivatePublicationCommittedError(
          path,
          new AggregateError([error, recoveryError], "Committed private publication recovery failed"),
          await pathNamesPrivateIdentity(path, intended)
        );
      }
    }
    await rm(temporary, { force: true });
    throw error;
  }
}

export async function publishPrivateBytes(
  path: string,
  value: Uint8Array,
  maxBytes = DEFAULT_MAX_BINARY_BYTES,
  hooks: PrivatePublicationHooks = {}
): Promise<void> {
  const contents = boundedBytes(value, maxBytes, "Private binary artifact");
  await publishOwnedPrivateBytes(path, contents, maxBytes, hooks);
}

/**
 * Publishes a Buffer whose ownership is transferred to this call. Callers may
 * not mutate it after invocation. The pre-write digest and streaming inode
 * validation make any accidental mutation fail closed without a second full
 * memory copy.
 */
export async function publishOwnedPrivateBytes(
  path: string,
  contents: Buffer,
  maxBytes = DEFAULT_MAX_BINARY_BYTES,
  hooks: PrivatePublicationHooks = {}
): Promise<void> {
  assertBoundedByteLength(contents, maxBytes, "Private binary artifact");
  const expected = privateContentIdentity(contents);
  const parent = dirname(path);
  await ensureDirectory(parent);
  const temporary = privatePath(parent, `.tmp-${randomUUID()}.artifact`);
  await writeSyncedTemporary(temporary, contents, hooks);
  const intended = await publicationTemporaryIdentity(temporary);
  let linked = false;
  try {
    // The caller transfers ownership rather than paying for another full
    // Buffer copy. Prove the prepared inode still contains the synchronously
    // captured identity before it can acquire the canonical name.
    await validatePreparedPrivateInode(temporary, intended, expected, maxBytes);
    try {
      await link(temporary, path);
      linked = true;
      hooks.afterLink?.();
    } catch (error) {
      if (!linked && (error as NodeJS.ErrnoException).code === "EEXIST") {
        await validatePrivateContentIdentity(path, expected, maxBytes);
        await rm(temporary);
        await reconcilePrivatePublication(path);
        return;
      } else {
        throw error;
      }
    }
    await finalizeLinkedPublication(path, temporary, intended, expected, maxBytes);
  } catch (error) {
    if (linked) {
      try {
        await finalizeLinkedPublication(path, temporary, intended, expected, maxBytes);
        return;
      } catch (recoveryError) {
        throw new PrivatePublicationCommittedError(
          path,
          new AggregateError([error, recoveryError], "Committed private publication recovery failed"),
          await pathNamesPrivateIdentity(path, intended)
        );
      }
    }
    await rm(temporary, { force: true });
    throw error;
  }
}

export async function replacePrivateJson(path: string, value: unknown): Promise<void> {
  await replacePrivateBytes(path, encodePrivateJsonBytes(value), DEFAULT_MAX_JSON_BYTES);
}

export async function replacePrivateBytes(
  path: string,
  value: Uint8Array,
  maxBytes = DEFAULT_MAX_BINARY_BYTES,
  hooks: PrivateReplacementHooks = {}
): Promise<void> {
  const contents = boundedBytes(value, maxBytes, "Private binary artifact");
  const parent = dirname(path);
  await ensureDirectory(parent);
  const temporary = privatePath(parent, `.tmp-${randomUUID()}.artifact`);
  await writeSyncedTemporary(temporary, contents);
  let renamed = false;
  try {
    await hooks.beforeRename?.();
    await rename(temporary, path);
    renamed = true;
    await enforcePrivateFile(path);
    await syncDirectory(parent);
  } catch (error) {
    await rm(temporary, { force: true });
    if (renamed) {
      try {
        await recoverCommittedPublication(path, parent, contents, maxBytes);
        return;
      } catch (recoveryError) {
        throw new PrivatePublicationCommittedError(
          path,
          new AggregateError([error, recoveryError], "Committed private replacement recovery failed")
        );
      }
    }
    throw error;
  }
}

/**
 * Atomically publishes bytes only when the target still has one exact expected
 * filesystem identity, or is still absent. A Darwin no-overwrite rename owns
 * first creation; replacement uses swap-and-validate CAS so an external editor
 * that saves at the exchange boundary is restored rather than overwritten.
 */
export async function compareAndReplacePrivateBytes(
  path: string,
  value: Uint8Array,
  expectedTarget: AtomicFileFingerprint | null,
  maxBytes = DEFAULT_MAX_BINARY_BYTES,
  hooks: PrivateComparedReplacementHooks = {}
): Promise<void> {
  const contents = boundedBytes(value, maxBytes, "Private binary artifact");
  const parent = dirname(path);
  await ensureDirectory(parent);
  const temporary = privatePath(parent, `.tmp-${randomUUID()}.artifact`);
  await writeSyncedTemporary(temporary, contents);
  const intended = await publicationTemporaryIdentity(temporary);
  const expectedContents = privateContentIdentity(contents);
  const preparedDigest = expectedContents.digest;
  let preserveTemporary = false;

  try {
    if (expectedTarget) {
      let displaced: AtomicFileFingerprint;
      try {
        ({ displaced } = await atomicReplaceBoundedFile({
          targetPath: path,
          preparedPath: temporary,
          expectedTarget,
          expectedPreparedDigest: preparedDigest,
          maxBytes,
          afterSourceValidation: hooks.afterSourceValidation
        }));
      } catch (error) {
        if (error instanceof AtomicFileCommitUncertainError) preserveTemporary = true;
        throw error;
      }

      // The successful swap leaves the displaced source at the temporary
      // name. Keep it as recovery evidence through every fallible durability
      // check and delete only that exact inode once the new target is durable.
      preserveTemporary = true;
      try {
        await validatePublishedInode(path, intended, expectedContents, maxBytes, 1);
        await syncDirectory(parent);
        await removeExactPrivateFile(temporary, displaced);
        await syncDirectory(parent);
        preserveTemporary = false;
        return;
      } catch (error) {
        throw new PrivatePublicationCommittedError(
          path,
          error,
          await pathNamesPrivateIdentity(path, intended)
        );
      }
    }

    await assertPrivatePathAbsent(path);
    await hooks.afterSourceValidation?.();
    try {
      await atomicRenameNoReplaceDarwin(temporary, path);
    } catch (error) {
      const location = await locatePrivateFileIdentity(path, temporary, intended);
      if (location === "target") {
        // The helper response was lost after the no-replace rename committed.
        // Continue through exact target validation and durability.
      } else if (error instanceof AtomicRenameDestinationExistsError && location === "temporary") {
        throw new AtomicFileMismatchError("Atomic private creation refused because the target appeared");
      } else if (location === "temporary") {
        throw error;
      } else {
        preserveTemporary = true;
        throw new AtomicFileCommitUncertainError(
          "Atomic private creation ended without a trustworthy filesystem outcome",
          [path, temporary],
          { cause: error }
        );
      }
    }
    try {
      await validatePublishedInode(path, intended, expectedContents, maxBytes, 1);
      await syncDirectory(parent);
      return;
    } catch (error) {
      preserveTemporary = true;
      throw new PrivatePublicationCommittedError(
        path,
        error,
        await pathNamesPrivateIdentity(path, intended)
      );
    }
  } catch (error) {
    if (!preserveTemporary) {
      try {
        await removeExactPrivateFile(temporary, intended);
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], "Private compared replacement failed and cleanup was incomplete");
      }
    }
    throw error;
  }
}

export async function readPrivateJson(path: string, maxBytes = DEFAULT_MAX_JSON_BYTES): Promise<unknown> {
  let contents: string;
  try {
    contents = new TextDecoder("utf-8", { fatal: true }).decode(await readPrivateBytes(path, maxBytes));
  } catch (error) {
    if (error instanceof TypeError) throw new Error(`Private artifact is not valid UTF-8: ${path}`);
    throw error;
  }
  try {
    return JSON.parse(contents) as unknown;
  } catch {
    throw new Error(`Private artifact is not valid JSON: ${path}`);
  }
}

/**
 * Repairs a current-user, single-link regular file without ever following a
 * symbolic link. Callers must opt into this migration behavior explicitly;
 * ordinary private artifact reads remain validation-only.
 */
export async function repairPrivateFilePermissions(path: string): Promise<void> {
  await assertNoUserControlledSymlinkAncestors(path);
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    await assertNoUserControlledSymlinkAncestors(path);
    const before = await handle.stat();
    assertPrivateFileMetadata(before, path);
    assertSinglePrivateLink(before, path);
    await assertCurrentPrivateFilePath(path, before, "permission validation");
    await handle.chmod(FILE_MODE);
    await handle.sync();
    const after = await handle.stat();
    assertPrivateFileMetadata(after, path);
    assertSinglePrivateLink(after, path);
    if ((after.mode & 0o777) !== FILE_MODE) {
      throw new Error(`Private artifact permissions could not be repaired to owner-only: ${path}`);
    }
    if (
      after.dev !== before.dev
      || after.ino !== before.ino
      || after.size !== before.size
      || after.mtimeMs !== before.mtimeMs
    ) {
      throw new Error(`Private artifact changed during permission repair: ${path}`);
    }
    await assertNoUserControlledSymlinkAncestors(path);
    await assertCurrentPrivateFilePath(path, after, "permission repair");
  } finally {
    await handle.close();
  }
}

export async function removePrivateFile(path: string): Promise<void> {
  const parent = dirname(path);
  await reconcilePrivatePublication(path);
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const metadata = await handle.stat();
    assertPrivateFileMetadata(metadata, path);
    assertSinglePrivateLink(metadata, path);
    assertPrivateFileMode(metadata, path);
  } finally {
    await handle.close();
  }
  await rm(path);
  await syncDirectory(parent);
}

/**
 * Removes one named owner-private subtree without following links. The full
 * subtree is validated before the first unlink so an unexpected entry cannot
 * turn a maintenance pass into a partial, silently permissive deletion.
 */
export async function removePrivateDirectoryTree(
  root: string,
  segment: string,
  maxEntries = 10_000
): Promise<void> {
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) {
    throw new Error("Private directory removal limit must be a positive integer");
  }
  const path = privatePath(root, segment);
  await assertNoUserControlledSymlinkAncestors(path);
  const rootMetadata = await lstat(path);
  assertPrivateDirectoryMetadata(rootMetadata, path);
  const files: string[] = [];
  const directories: string[] = [];
  let entryCount = 0;

  const inspect = async (directory: string, depth: number): Promise<void> => {
    if (depth > 64) throw new Error(`Private artifact subtree is too deeply nested: ${path}`);
    const entries = (await readdir(directory, { withFileTypes: true }))
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      entryCount += 1;
      if (entryCount > maxEntries) {
        throw new Error(`Private artifact subtree exceeds the ${maxEntries}-entry removal limit: ${path}`);
      }
      const child = privatePath(directory, entry.name);
      const metadata = await lstat(child);
      if (metadata.isSymbolicLink()) throw new Error(`Private artifact subtree contains a symbolic link: ${child}`);
      if (metadata.isDirectory()) {
        assertPrivateDirectoryMetadata(metadata, child);
        await inspect(child, depth + 1);
        directories.push(child);
        continue;
      }
      assertPrivateFileMetadata(metadata, child);
      assertSinglePrivateLink(metadata, child);
      assertPrivateFileMode(metadata, child);
      files.push(child);
    }
  };
  await inspect(path, 0);
  for (const file of files) await removePrivateFile(file);
  for (const directory of directories) {
    assertPrivateDirectoryMetadata(await lstat(directory), directory);
    if ((await readdir(directory)).length !== 0) {
      throw new Error(`Private artifact directory changed during removal: ${directory}`);
    }
    await rmdir(directory);
  }
  assertPrivateDirectoryMetadata(await lstat(path), path);
  if ((await readdir(path)).length !== 0) {
    throw new Error(`Private artifact root changed during removal: ${path}`);
  }
  await rmdir(path);
  await syncDirectory(root);
}

async function ensureDirectory(path: string, recursive = false): Promise<void> {
  await assertNoUserControlledSymlinkAncestors(path);
  try {
    const existing = await lstat(path);
    if (existing.isSymbolicLink() || !existing.isDirectory()) {
      throw new Error(`Private artifact path is not a real directory: ${path}`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    try {
      await mkdir(path, { recursive, mode: DIRECTORY_MODE });
    } catch (mkdirError) {
      if ((mkdirError as NodeJS.ErrnoException).code !== "EEXIST") throw mkdirError;
    }
    const created = await lstat(path);
    if (created.isSymbolicLink() || !created.isDirectory()) {
      throw new Error(`Private artifact directory was replaced during creation: ${path}`);
    }
  }
  await assertNoUserControlledSymlinkAncestors(path);
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    await assertNoUserControlledSymlinkAncestors(path);
    const before = await handle.stat();
    if (!before.isDirectory()) throw new Error(`Private artifact path is not a real directory: ${path}`);
    assertCurrentUserOwns(before, path);
    if ((before.mode & 0o077) !== 0 && !await directoryIsClearlyPrivateRoot(path)) {
      throw new Error(`Private artifact directory is not clearly zts-owned; refusing to change its permissions: ${path}`);
    }
    await handle.chmod(DIRECTORY_MODE);
    await handle.sync();
    const after = await handle.stat();
    assertPrivateDirectoryMetadata(after, path);
    await assertNoUserControlledSymlinkAncestors(path);
    const current = await lstat(path);
    if (current.isSymbolicLink() || current.dev !== after.dev || current.ino !== after.ino) {
      throw new Error(`Private artifact directory changed during validation: ${path}`);
    }
  } finally {
    await handle.close();
  }
}

async function directoryIsClearlyPrivateRoot(path: string): Promise<boolean> {
  const name = basename(path).toLowerCase();
  if (
    name === "zts"
    || name.startsWith("zts-")
    || name.startsWith("zts_")
    || name.startsWith(".zts-")
    || name.startsWith(".zts_")
    || name.includes("zen-tab-steward")
  ) {
    return true;
  }

  const parent = dirname(path);
  if (parent === path) return false;
  const metadata = await lstat(parent);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) return false;
  if (typeof process.getuid === "function" && metadata.uid !== process.getuid()) return false;
  return (metadata.mode & 0o077) === 0;
}

async function assertNoUserControlledSymlinkAncestors(path: string): Promise<void> {
  const ancestors: string[] = [];
  let current = dirname(resolve(path));
  while (true) {
    ancestors.push(current);
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }

  for (const ancestor of ancestors.reverse()) {
    let metadata: Stats;
    try {
      metadata = await lstat(ancestor);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    if (metadata.isSymbolicLink()) {
      // macOS has root-owned compatibility aliases such as /var -> /private/var.
      // They are outside the user-controlled private-root boundary; an
      // ancestor symlink owned by the invoking user is never followed.
      if (metadata.uid === 0) continue;
      throw new Error(`Private artifact path has a symbolic link ancestor: ${ancestor}`);
    }
    if (!metadata.isDirectory()) {
      throw new Error(`Private artifact ancestor is not a real directory: ${ancestor}`);
    }
  }
}

async function writeSyncedTemporary(
  path: string,
  contents: string | Uint8Array,
  hooks: PrivatePublicationHooks = {}
): Promise<void> {
  const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(path, flags, FILE_MODE);
    await handle.chmod(FILE_MODE);
    await handle.writeFile(contents, "utf8");
    hooks.afterTemporaryWrite?.();
    await handle.sync();
    await handle.close();
  } catch (error) {
    const errors: unknown[] = [error];
    if (handle) {
      try {
        await handle.close();
      } catch (closeError) {
        errors.push(closeError);
      }
    }
    try {
      await rm(path, { force: true });
    } catch (removeError) {
      errors.push(removeError);
    }
    if (errors.length > 1) {
      throw new AggregateError(errors, "Private temporary write failed and cleanup was incomplete");
    }
    throw error;
  }
}

export async function readPrivateBytes(path: string, maxBytes = DEFAULT_MAX_BINARY_BYTES): Promise<Buffer> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error("Private artifact read limit must be a positive integer");
  await assertNoUserControlledSymlinkAncestors(path);
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    await assertNoUserControlledSymlinkAncestors(path);
    const before = await handle.stat();
    assertPrivateFileMetadata(before, path);
    await assertPrivatePublicationLinkState(path, before);
    assertPrivateFileMode(before, path);
    if (before.size > maxBytes) throw new Error(`Private artifact exceeds the ${maxBytes}-byte read limit: ${path}`);
    const contents = await readBoundedPrivateFile(handle, before.size, maxBytes);
    const after = await handle.stat();
    assertPrivateFileMetadata(after, path);
    await assertPrivatePublicationLinkState(path, after);
    assertPrivateFileMode(after, path);
    if (
      before.dev !== after.dev
      || before.ino !== after.ino
      || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs
      || contents.byteLength !== after.size
    ) {
      throw new Error(`Private artifact changed while it was being read: ${path}`);
    }
    await assertNoUserControlledSymlinkAncestors(path);
    const current = await lstat(path);
    if (current.isSymbolicLink() || current.dev !== after.dev || current.ino !== after.ino) {
      throw new Error(`Private artifact path changed while it was being read: ${path}`);
    }
    return contents;
  } finally {
    await handle.close();
  }
}

async function readBoundedPrivateFile(
  handle: Awaited<ReturnType<typeof open>>,
  expectedSize: number,
  maxBytes: number
): Promise<Buffer> {
  const buffer = Buffer.allocUnsafe(Math.min(maxBytes + 1, expectedSize + 1));
  let offset = 0;
  while (offset < buffer.byteLength) {
    const { bytesRead } = await handle.read(buffer, offset, buffer.byteLength - offset, offset);
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
  return buffer.subarray(0, offset);
}

export async function reconcilePrivatePublication(path: string): Promise<boolean> {
  await assertNoUserControlledSymlinkAncestors(path);
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    await assertNoUserControlledSymlinkAncestors(path);
    const metadata = await handle.stat();
    assertPrivateFileMetadata(metadata, path);
    assertPrivateFileMode(metadata, path);
    const temporary = await recoverablePublicationTemporary(path, metadata);
    if (!temporary) return false;

    const current = await lstat(path);
    if (current.isSymbolicLink() || current.dev !== metadata.dev || current.ino !== metadata.ino) {
      throw new Error(`Private artifact path changed before publication reconciliation: ${path}`);
    }
    try {
      await rm(temporary);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const after = await handle.stat();
    assertPrivateFileMetadata(after, path);
    assertSinglePrivateLink(after, path);
    assertPrivateFileMode(after, path);
    await syncDirectory(dirname(path));
    return true;
  } finally {
    await handle.close();
  }
}

async function assertPrivatePublicationLinkState(path: string, metadata: Stats): Promise<void> {
  if (metadata.nlink === 1) return;
  await recoverablePublicationTemporary(path, metadata);
}

async function recoverablePublicationTemporary(path: string, metadata: Stats): Promise<string | null> {
  if (metadata.nlink === 1) return null;
  if (metadata.nlink !== 2) {
    throw new Error(`Private artifact has an unexpected hardlink count: ${path}`);
  }
  const parent = dirname(path);
  const candidates: string[] = [];
  for (const entry of await readdir(parent, { withFileTypes: true })) {
    if (!/^\.tmp-[0-9a-f-]+\.(?:artifact|json)$/iu.test(entry.name)) continue;
    const candidate = privatePath(parent, entry.name);
    let candidateMetadata: Stats;
    try {
      candidateMetadata = await lstat(candidate);
    } catch (error) {
      // Another no-replace publisher can finish and remove its unrelated temp
      // after readdir. Absence contributes no identity evidence for this path.
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    if (candidateMetadata.isSymbolicLink() || !candidateMetadata.isFile()) continue;
    if (candidateMetadata.dev !== metadata.dev || candidateMetadata.ino !== metadata.ino) continue;
    assertPrivateFileMetadata(candidateMetadata, candidate);
    assertPrivateFileMode(candidateMetadata, candidate);
    if (candidateMetadata.nlink !== 2) {
      throw new Error(`Private publication temporary has an unexpected hardlink count: ${candidate}`);
    }
    candidates.push(candidate);
  }
  if (candidates.length !== 1 || basename(candidates[0]!) === basename(path)) {
    const current = await lstat(path);
    if (!current.isSymbolicLink()
      && current.dev === metadata.dev
      && current.ino === metadata.ino
      && current.nlink === 1) {
      return null;
    }
    throw new Error(`Private artifact has an unexpected hardlink count without one recoverable publication temporary: ${path}`);
  }
  return candidates[0]!;
}

async function enforcePrivateFile(path: string): Promise<void> {
  await reconcilePrivatePublication(path);
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    assertPrivateFileMetadata(before, path);
    assertSinglePrivateLink(before, path);
    await handle.chmod(FILE_MODE);
    const after = await handle.stat();
    assertPrivateFileMetadata(after, path);
    assertSinglePrivateLink(after, path);
  } finally {
    await handle.close();
  }
}

async function publicationTemporaryIdentity(path: string): Promise<Stats> {
  const metadata = await lstat(path);
  assertPrivateFileMetadata(metadata, path);
  assertSinglePrivateLink(metadata, path);
  assertPrivateFileMode(metadata, path);
  return metadata;
}

async function assertPrivatePathAbsent(path: string): Promise<void> {
  try {
    await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  throw new AtomicFileMismatchError("Atomic private creation refused because the target already exists");
}

async function removeExactPrivateFile(
  path: string,
  expected: Stats | AtomicFileFingerprint
): Promise<void> {
  let metadata: Stats;
  try {
    metadata = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  assertPrivateFileMetadata(metadata, path);
  const device = "device" in expected ? expected.device : expected.dev;
  const inode = "inode" in expected ? expected.inode : expected.ino;
  if (metadata.dev !== device || metadata.ino !== inode) {
    throw new Error(`Private cleanup path no longer names the expected exact file: ${path}`);
  }
  assertSinglePrivateLink(metadata, path);
  assertPrivateFileMode(metadata, path);
  await rm(path);
}

async function locatePrivateFileIdentity(
  target: string,
  temporary: string,
  intended: Stats
): Promise<"target" | "temporary" | "uncertain"> {
  const atTarget = await pathNamesPrivateIdentity(target, intended);
  const atTemporary = await pathNamesPrivateIdentity(temporary, intended);
  if (atTarget && !atTemporary) return "target";
  if (atTemporary && !atTarget) return "temporary";
  return "uncertain";
}

async function pathNamesPrivateIdentity(path: string, intended: Stats): Promise<boolean> {
  try {
    const metadata = await lstat(path);
    return !metadata.isSymbolicLink()
      && metadata.isFile()
      && metadata.dev === intended.dev
      && metadata.ino === intended.ino;
  } catch {
    return false;
  }
}

/**
 * Completes a no-replace hardlink publication only while the canonical name is
 * still bound to the exact temporary inode that zts prepared. Content equality
 * alone is not publication identity: another writer can install identical
 * bytes under the canonical name after the link succeeds.
 */
async function finalizeLinkedPublication(
  path: string,
  temporary: string,
  intended: Stats,
  expected: PrivateContentIdentity,
  maxBytes: number
): Promise<void> {
  let temporaryExists = true;
  try {
    const metadata = await lstat(temporary);
    assertSamePrivateFileIdentity(metadata, intended, temporary);
    if (metadata.nlink !== 2) {
      throw new Error(`Private publication temporary has an unexpected hardlink count: ${temporary}`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    temporaryExists = false;
  }

  await validatePublishedInode(path, intended, expected, maxBytes, temporaryExists ? 2 : 1);
  await syncDirectory(dirname(path));

  if (temporaryExists) {
    const beforeRemoval = await lstat(temporary);
    assertSamePrivateFileIdentity(beforeRemoval, intended, temporary);
    if (beforeRemoval.nlink !== 2) {
      throw new Error(`Private publication temporary has an unexpected hardlink count: ${temporary}`);
    }
    await assertCurrentPrivateFilePath(path, intended, "immutable publication finalization");
    await rm(temporary);
    await validatePublishedInode(path, intended, expected, maxBytes, 1);
    await syncDirectory(dirname(path));
  }
}

async function validatePublishedInode(
  path: string,
  intended: Stats,
  expected: PrivateContentIdentity,
  maxBytes: number,
  expectedLinks: number
): Promise<void> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    assertPrivateFileMetadata(before, path);
    assertSamePrivateFileIdentity(before, intended, path);
    if (before.nlink !== expectedLinks) {
      throw new Error(`Private publication target has an unexpected hardlink count: ${path}`);
    }
    if (before.size > maxBytes) {
      throw new Error(`Private artifact exceeds the ${maxBytes}-byte read limit: ${path}`);
    }
    if (before.size !== expected.size) {
      throw new Error("Committed private publication size changed during recovery");
    }
    await handle.chmod(FILE_MODE);
    await handle.sync();
    const digest = await digestPrivateFileExactly(handle, before.size, path, "publication finalization");
    const after = await handle.stat();
    assertPrivateFileMetadata(after, path);
    assertSamePrivateFileIdentity(after, intended, path);
    if (
      after.nlink !== expectedLinks
      || after.size !== before.size
      || after.mtimeMs !== before.mtimeMs
    ) {
      throw new Error(`Private publication target changed during finalization: ${path}`);
    }
    assertPrivateFileMode(after, path);
    if (digest !== expected.digest) {
      throw new Error("Committed private publication content changed during recovery");
    }
    await assertCurrentPrivateFilePath(path, after, "immutable publication finalization");
  } finally {
    await handle.close();
  }
}

async function validatePreparedPrivateInode(
  path: string,
  intended: Stats,
  expected: PrivateContentIdentity,
  maxBytes: number
): Promise<void> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    assertPrivateFileMetadata(before, path);
    assertSamePrivateFileIdentity(before, intended, path);
    assertSinglePrivateLink(before, path);
    assertPrivateFileMode(before, path);
    if (before.size > maxBytes) {
      throw new Error(`Private artifact exceeds the ${maxBytes}-byte read limit: ${path}`);
    }
    if (before.size !== expected.size) {
      throw new Error("Prepared private publication size changed before linking");
    }

    const digest = await digestPrivateFileExactly(handle, before.size, path, "pre-publication validation");
    const after = await handle.stat();
    assertPrivateFileMetadata(after, path);
    assertSamePrivateFileIdentity(after, intended, path);
    assertSinglePrivateLink(after, path);
    assertPrivateFileMode(after, path);
    if (
      before.size !== after.size
      || before.mtimeMs !== after.mtimeMs
      || before.ctimeMs !== after.ctimeMs
    ) {
      throw new Error(`Prepared private publication changed before linking: ${path}`);
    }
    await assertCurrentPrivateFilePath(path, after, "pre-publication validation");
    if (digest !== expected.digest) {
      throw new Error("Prepared private publication content changed before linking");
    }
  } finally {
    await handle.close();
  }
}

async function validatePrivateContentIdentity(
  path: string,
  expected: PrivateContentIdentity,
  maxBytes: number
): Promise<void> {
  await assertNoUserControlledSymlinkAncestors(path);
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    await assertNoUserControlledSymlinkAncestors(path);
    const before = await handle.stat();
    assertPrivateFileMetadata(before, path);
    await assertPrivatePublicationLinkState(path, before);
    assertPrivateFileMode(before, path);
    if (before.size > maxBytes) {
      throw new Error(`Private artifact exceeds the ${maxBytes}-byte read limit: ${path}`);
    }
    if (before.size !== expected.size) {
      throw new Error("Private artifact identifier collision");
    }

    const digest = await digestPrivateFileExactly(handle, before.size, path, "identity validation");
    const after = await handle.stat();
    assertPrivateFileMetadata(after, path);
    await assertPrivatePublicationLinkState(path, after);
    assertPrivateFileMode(after, path);
    if (
      before.dev !== after.dev
      || before.ino !== after.ino
      || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs
      || before.ctimeMs !== after.ctimeMs
    ) {
      throw new Error(`Private artifact changed during identity validation: ${path}`);
    }
    await assertNoUserControlledSymlinkAncestors(path);
    await assertCurrentPrivateFilePath(path, after, "identity validation");
    if (digest !== expected.digest) {
      throw new Error("Private artifact identifier collision");
    }
  } finally {
    await handle.close();
  }
}

async function digestPrivateFileExactly(
  handle: Awaited<ReturnType<typeof open>>,
  expectedSize: number,
  path: string,
  phase: string
): Promise<Sha256Digest> {
  const digest = createHash("sha256");
  const chunk = Buffer.allocUnsafe(Math.min(VALIDATION_CHUNK_BYTES, Math.max(1, expectedSize)));
  let offset = 0;
  while (offset < expectedSize) {
    const requested = Math.min(chunk.byteLength, expectedSize - offset);
    const { bytesRead } = await handle.read(chunk, 0, requested, offset);
    if (bytesRead === 0) {
      throw new Error(`Private artifact truncated during ${phase}: ${path}`);
    }
    digest.update(chunk.subarray(0, bytesRead));
    offset += bytesRead;
  }
  const growth = Buffer.allocUnsafe(1);
  if ((await handle.read(growth, 0, 1, expectedSize)).bytesRead !== 0) {
    throw new Error(`Private artifact grew during ${phase}: ${path}`);
  }
  return `sha256:${digest.digest("hex")}` as Sha256Digest;
}

async function recoverCommittedPublication(
  path: string,
  parent: string,
  expected: Buffer,
  maxBytes: number
): Promise<void> {
  await reconcilePrivatePublication(path);
  const existing = await readPrivateBytes(path, maxBytes);
  if (!existing.equals(expected)) throw new Error("Committed private publication content changed during recovery");
  await enforcePrivateFile(path);
  await syncDirectory(parent);
}

function assertPrivateFileMetadata(metadata: Stats, path: string): void {
  if (!metadata.isFile()) throw new Error(`Private artifact is not a regular file: ${path}`);
  assertCurrentUserOwns(metadata, path);
}

function assertSinglePrivateLink(metadata: Stats, path: string): void {
  if (metadata.nlink !== 1) throw new Error(`Private artifact has an unexpected hardlink count: ${path}`);
}

function assertSamePrivateFileIdentity(metadata: Stats, intended: Stats, path: string): void {
  if (metadata.dev !== intended.dev || metadata.ino !== intended.ino) {
    throw new Error(`Private publication target is not the prepared inode: ${path}`);
  }
}

function assertPrivateFileMode(metadata: Stats, path: string): void {
  if ((metadata.mode & 0o077) !== 0) {
    throw new Error(`Private artifact permissions are not owner-only: ${path}`);
  }
}

async function assertCurrentPrivateFilePath(path: string, metadata: Stats, phase: string): Promise<void> {
  const current = await lstat(path);
  if (current.isSymbolicLink() || current.dev !== metadata.dev || current.ino !== metadata.ino) {
    throw new Error(`Private artifact path changed during ${phase}: ${path}`);
  }
}

function assertPrivateDirectoryMetadata(metadata: Stats, path: string): void {
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error(`Private artifact path is not a real directory: ${path}`);
  }
  assertCurrentUserOwns(metadata, path);
  if ((metadata.mode & 0o077) !== 0) {
    throw new Error(`Private artifact directory permissions are not owner-only: ${path}`);
  }
}

function assertCurrentUserOwns(metadata: Stats, path: string): void {
  if (typeof process.getuid === "function" && metadata.uid !== process.getuid()) {
    throw new Error(`Private artifact is not owned by the current user: ${path}`);
  }
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export function encodePrivateJsonBytes(
  value: unknown,
  maxBytes = DEFAULT_MAX_JSON_BYTES,
  label = "Private JSON artifact"
): Buffer {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value, null, 2);
  } catch (error) {
    throw new Error(`${label} is not serializable`, { cause: error });
  }
  if (serialized === undefined) throw new Error(`${label} is not serializable`);
  const contents = Buffer.from(`${serialized}\n`, "utf8");
  assertBoundedByteLength(contents, maxBytes, label);
  return contents;
}

function boundedBytes(value: Uint8Array, maxBytes: number, label: string): Buffer {
  assertBoundedByteLength(value, maxBytes, label);
  return Buffer.from(value);
}

function assertBoundedByteLength(value: Uint8Array, maxBytes: number, label: string): void {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new Error(`${label} write limit must be a positive integer`);
  }
  if (value.byteLength > maxBytes) throw new Error(`${label} exceeds the ${maxBytes}-byte write limit`);
}

function privateContentIdentity(contents: Uint8Array): PrivateContentIdentity {
  return {
    size: contents.byteLength,
    digest: `sha256:${createHash("sha256").update(contents).digest("hex")}` as Sha256Digest
  };
}

function assertSafeSegment(segment: string): void {
  if (!segment || segment === "." || segment === ".." || !/^[A-Za-z0-9._-]+$/.test(segment)) {
    throw new Error(`Unsafe private artifact path segment: ${segment}`);
  }
}
