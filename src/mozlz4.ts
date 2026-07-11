import { constants, type Stats } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { lstat, open, rename, rm, type FileHandle } from "node:fs/promises";
import { Buffer } from "node:buffer";
import { compressBlock, compressBound, decompressBlock } from "lz4js";
import { dirname, join } from "node:path";
import {
  AtomicFileCommitUncertainError,
  atomicReplaceBoundedFile
} from "./atomic-file-cas.js";
import type { Sha256Digest } from "./domain/digest.js";

const MAGIC = Buffer.from([0x6d, 0x6f, 0x7a, 0x4c, 0x7a, 0x34, 0x30, 0x00]);
const HEADER_LENGTH = 12;
// Decoding retains compressed bytes, an output buffer, a UTF-8/JS string, and
// the parsed object at once. This is an absolute envelope, not an environment-
// raisable default: a caller cannot turn an untrusted Profile into a multi-GB
// allocation request. Streaming support must precede any future increase.
export const DEFAULT_MAX_DECOMPRESSED_BYTES = 32 * 1024 * 1024;
export const DEFAULT_MAX_COMPRESSED_BYTES = Math.ceil(
  DEFAULT_MAX_DECOMPRESSED_BYTES + DEFAULT_MAX_DECOMPRESSED_BYTES / 255 + 16
) + HEADER_LENGTH;

export interface JsonLz4Fingerprint {
  readonly digest: Sha256Digest;
  readonly size: number;
  readonly mode: number;
  readonly modifiedMs: number;
  readonly changedMs: number;
  readonly device: number;
  readonly inode: number;
}

export interface JsonLz4State {
  readonly value: unknown;
  readonly bytes: Buffer;
  readonly fingerprint: JsonLz4Fingerprint;
}

export interface DurableJsonLz4WriteOptions {
  readonly mode?: number;
  /** Required by mutation callers to make replacement an exact atomic CAS. */
  readonly expectedSourceFingerprint?: JsonLz4Fingerprint;
  readonly beforePrepare?: (prepared: {
    readonly temporaryPath: string;
    readonly encodedDigest: Sha256Digest;
  }) => Promise<void>;
  readonly beforeCommit?: (prepared: {
    readonly temporaryPath: string;
    readonly encodedDigest: Sha256Digest;
  }) => Promise<void>;
  /** Internal fault-injection hook after CAS source validation and before swap. */
  readonly afterSourceValidation?: () => void | Promise<void>;
  /** Internal fault-injection hook after swap and before displaced validation. */
  readonly afterAtomicSwap?: () => void | Promise<void>;
  /** Records an accepted replacement that still requires durability and displaced-source cleanup. */
  readonly onCommitBoundaryCrossed?: () => void;
  readonly onCommitted?: () => void;
  /** Records that the atomic helper could not prove which side of the swap is canonical. */
  readonly onCommitUncertain?: (error: AtomicFileCommitUncertainError) => void;
  /** Internal fault-injection hook after an accepted replacement and before target durability. */
  readonly afterRename?: () => void | Promise<void>;
  /** Internal fault-injection hook after displaced-source unlink and before its directory sync. */
  readonly beforeFinalDirectorySync?: () => void | Promise<void>;
  /** Internal fault-injection hook. Intent is durable but no temp file exists yet. */
  readonly afterPrepareIntent?: () => void | Promise<void>;
  /** Internal fault-injection hook. The owner-private temp exists but is not written yet. */
  readonly afterTemporaryCreated?: (temporaryPath: string) => void | Promise<void>;
}

export function decodeJsonLz4Buffer(buffer: Buffer): unknown {
  if (buffer.length > DEFAULT_MAX_COMPRESSED_BYTES) {
    throw new Error(
      `JSONLZ4 compressed size ${buffer.length} exceeds safety cap ${DEFAULT_MAX_COMPRESSED_BYTES}`
    );
  }
  if (buffer.length < HEADER_LENGTH) {
    throw new Error("JSONLZ4 file is too short");
  }

  if (!buffer.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new Error("JSONLZ4 file has an invalid mozLz40 header");
  }

  const expectedLength = buffer.readUInt32LE(8);
  const maxLength = maxDecompressedBytes();
  if (expectedLength > maxLength) {
    throw new Error(
      `JSONLZ4 decompressed length ${expectedLength} exceeds safety cap ${maxLength}`
    );
  }

  const destination = new Uint8Array(expectedLength);
  const compressed = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const written = decompressBlock(
    compressed,
    destination,
    HEADER_LENGTH,
    buffer.length - HEADER_LENGTH,
    0
  );

  if (written !== expectedLength) {
    throw new Error(
      `JSONLZ4 decompressed length mismatch: expected ${expectedLength}, got ${written}`
    );
  }

  let json: string;
  try {
    json = new TextDecoder("utf-8", { fatal: true }).decode(destination);
  } catch {
    throw new Error("JSONLZ4 payload is not valid UTF-8");
  }
  return JSON.parse(json);
}

function maxDecompressedBytes(): number {
  return DEFAULT_MAX_DECOMPRESSED_BYTES;
}

export async function readJsonLz4(path: string): Promise<unknown> {
  return (await readJsonLz4State(path)).value;
}

export async function writeJsonLz4(path: string, value: unknown): Promise<void> {
  await writeJsonLz4Durable(path, value);
}

export async function readJsonLz4State(
  path: string,
  maxCompressedBytes = DEFAULT_MAX_COMPRESSED_BYTES
): Promise<JsonLz4State> {
  if (!Number.isSafeInteger(maxCompressedBytes) || maxCompressedBytes < HEADER_LENGTH) {
    throw new Error("JSONLZ4 compressed read limit must be a positive safe integer");
  }
  if (maxCompressedBytes > DEFAULT_MAX_COMPRESSED_BYTES) {
    throw new Error(
      `JSONLZ4 compressed read limit cannot exceed the absolute safety cap ${DEFAULT_MAX_COMPRESSED_BYTES}`
    );
  }
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    assertSafeSource(before, path, maxCompressedBytes);
    const bytes = await readExactBounded(handle, before.size, path);
    const after = await handle.stat();
    assertSafeSource(after, path, maxCompressedBytes);
    if (
      before.dev !== after.dev
      || before.ino !== after.ino
      || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs
      || before.ctimeMs !== after.ctimeMs
      || bytes.byteLength !== after.size
    ) {
      throw new Error(`JSONLZ4 source changed while being read: ${path}`);
    }
    const pathState = await lstat(path);
    if (pathState.isSymbolicLink() || pathState.dev !== after.dev || pathState.ino !== after.ino) {
      throw new Error(`JSONLZ4 source path changed while being read: ${path}`);
    }
    return {
      value: decodeJsonLz4Buffer(bytes),
      bytes,
      fingerprint: {
        digest: sha256Bytes(bytes),
        size: after.size,
        mode: after.mode & 0o777,
        modifiedMs: after.mtimeMs,
        changedMs: after.ctimeMs,
        device: after.dev,
        inode: after.ino
      }
    };
  } finally {
    await handle.close();
  }
}

/**
 * Rebinds an already-read JSONLZ4 source to its canonical no-follow path
 * without allocating or decoding the private payload a second time.
 * Device/inode identity catches replacement, while ctime catches in-place
 * writes even when a caller restores the original size and mtime.
 */
export async function assertJsonLz4SourceIdentity(
  path: string,
  expected: JsonLz4Fingerprint
): Promise<void> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const held = await handle.stat();
    assertSafeSource(held, path, DEFAULT_MAX_COMPRESSED_BYTES);
    const canonical = await lstat(path);
    if (canonical.isSymbolicLink()
      || canonical.dev !== held.dev
      || canonical.ino !== held.ino
      || held.dev !== expected.device
      || held.ino !== expected.inode
      || held.size !== expected.size
      || (held.mode & 0o777) !== expected.mode
      || held.mtimeMs !== expected.modifiedMs
      || held.ctimeMs !== expected.changedMs) {
      throw new Error(`JSONLZ4 source path no longer names the expected exact file: ${path}`);
    }
  } finally {
    await handle.close();
  }
}

async function readExactBounded(handle: FileHandle, expectedSize: number, path: string): Promise<Buffer> {
  const bytes = Buffer.allocUnsafe(expectedSize);
  let offset = 0;
  while (offset < expectedSize) {
    const { bytesRead } = await handle.read(bytes, offset, expectedSize - offset, null);
    if (bytesRead === 0) throw new Error(`JSONLZ4 source truncated while being read: ${path}`);
    offset += bytesRead;
  }
  const extra = Buffer.allocUnsafe(1);
  if ((await handle.read(extra, 0, 1, null)).bytesRead !== 0) {
    throw new Error(`JSONLZ4 source grew beyond its safety-checked size while being read: ${path}`);
  }
  return bytes;
}

export async function writeJsonLz4Durable(
  path: string,
  value: unknown,
  options: DurableJsonLz4WriteOptions = {}
): Promise<void> {
  const parent = dirname(path);
  const tempPath = join(parent, `.zts-${process.pid}-${randomUUID()}.jsonlz4.tmp`);
  const mode = options.mode ?? 0o600;
  const encoded = encodeJsonLz4Buffer(value);
  if (encoded.byteLength > DEFAULT_MAX_COMPRESSED_BYTES) {
    throw new Error(
      `JSONLZ4 encoded size ${encoded.byteLength} exceeds readable safety cap ${DEFAULT_MAX_COMPRESSED_BYTES}`
    );
  }
  const prepared = { temporaryPath: tempPath, encodedDigest: sha256Bytes(encoded) } as const;
  await options.beforePrepare?.(prepared);
  await options.afterPrepareIntent?.();
  const handle = await open(
    tempPath,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600
  );
  try {
    await handle.chmod(0o600);
    await options.afterTemporaryCreated?.(tempPath);
    await handle.writeFile(encoded);
    await handle.sync();
  } catch (error) {
    await handle.close();
    await rm(tempPath, { force: true });
    throw error;
  }
  await handle.close();
  let preserveTemporary = false;
  let commitBoundaryCrossed = false;
  let committedRecorded = false;
  const recordCommitBoundaryCrossed = () => {
    if (commitBoundaryCrossed) return;
    commitBoundaryCrossed = true;
    // For an exact CAS, the prepared path now names the displaced source.
    // Retain that evidence through every remaining fallible durability step.
    preserveTemporary = true;
    options.onCommitBoundaryCrossed?.();
  };
  const recordCommitted = () => {
    if (committedRecorded) return;
    committedRecorded = true;
    options.onCommitted?.();
  };
  try {
    await options.beforeCommit?.(prepared);
    if (options.expectedSourceFingerprint) {
      try {
        await atomicReplaceBoundedFile({
          targetPath: path,
          preparedPath: tempPath,
          expectedTarget: options.expectedSourceFingerprint,
          expectedPreparedDigest: prepared.encodedDigest,
          maxBytes: DEFAULT_MAX_COMPRESSED_BYTES,
          afterSourceValidation: options.afterSourceValidation,
          afterAtomicSwap: options.afterAtomicSwap
        });
      } catch (error) {
        if (error instanceof AtomicFileCommitUncertainError) {
          preserveTemporary = true;
          options.onCommitUncertain?.(error);
        }
        throw error;
      }
    } else {
      await rename(tempPath, path);
    }
    // The accepted swap is the mutation boundary, but not yet a durable
    // commit. The displaced source remains recoverable until the target,
    // directory entry, unlink, and final directory state are all synced.
    recordCommitBoundaryCrossed();
    await options.afterRename?.();
    const committed = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      await committed.chmod(mode);
      await committed.sync();
    } finally {
      await committed.close();
    }
    const directory = await open(parent, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
    if (options.expectedSourceFingerprint) {
      await rm(tempPath);
      await options.beforeFinalDirectorySync?.();
      const cleanedDirectory = await open(parent, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        await cleanedDirectory.sync();
      } finally {
        await cleanedDirectory.close();
      }
    }
    // Only the complete durability and displaced-source cleanup sequence is a
    // committed write. Any earlier failure remains an unfinished transaction.
    recordCommitted();
  } catch (error) {
    if (!preserveTemporary) await rm(tempPath, { force: true });
    throw error;
  }
}

export function sameJsonLz4Fingerprint(left: JsonLz4Fingerprint, right: JsonLz4Fingerprint): boolean {
  return left.digest === right.digest
    && left.size === right.size
    && left.mode === right.mode
    && left.modifiedMs === right.modifiedMs
    && left.changedMs === right.changedMs
    && left.device === right.device
    && left.inode === right.inode;
}

export function encodeJsonLz4Buffer(value: unknown): Buffer {
  const payload = Buffer.from(JSON.stringify(value), "utf8");
  if (payload.length > maxDecompressedBytes()) {
    throw new Error(`JSONLZ4 encoded length ${payload.length} exceeds safety cap ${maxDecompressedBytes()}`);
  }
  const destination = new Uint8Array(compressBound(payload.length));
  const compressedLength = compressBlock(
    payload,
    destination,
    0,
    payload.length,
    new Uint32Array(1 << 16)
  );
  const literalHeader = encodeLiteralOnlyBlock(payload);
  const useCompressed = compressedLength > 0 && compressedLength < literalHeader.length + payload.length;
  const blockLength = useCompressed ? compressedLength : literalHeader.length + payload.length;
  const result = Buffer.allocUnsafe(HEADER_LENGTH + blockLength);
  MAGIC.copy(result, 0);
  result.writeUInt32LE(payload.length, 8);
  if (useCompressed) {
    Buffer.from(destination.buffer, destination.byteOffset, compressedLength).copy(result, HEADER_LENGTH);
  } else {
    literalHeader.copy(result, HEADER_LENGTH);
    payload.copy(result, HEADER_LENGTH + literalHeader.length);
  }
  if (result.byteLength > DEFAULT_MAX_COMPRESSED_BYTES) {
    throw new Error(
      `JSONLZ4 encoded size ${result.byteLength} exceeds readable safety cap ${DEFAULT_MAX_COMPRESSED_BYTES}`
    );
  }
  return result;
}

export function encodeLiteralJsonLz4ForFixture(value: unknown): Buffer {
  return encodeJsonLz4Buffer(value);
}

function encodeLiteralOnlyBlock(payload: Buffer): Buffer {
  const length = payload.length;
  const bytes: number[] = [];
  bytes.push(Math.min(15, length) << 4);

  if (length >= 15) {
    let remaining = length - 15;
    while (remaining >= 255) {
      bytes.push(255);
      remaining -= 255;
    }
    bytes.push(remaining);
  }

  return Buffer.from(bytes);
}

function assertSafeSource(
  metadata: Stats,
  path: string,
  maxCompressedBytes: number
): void {
  if (!metadata.isFile()) throw new Error(`JSONLZ4 source is not a regular file: ${path}`);
  if (metadata.nlink !== 1) throw new Error(`JSONLZ4 source has an unexpected hardlink count: ${path}`);
  if (metadata.size > maxCompressedBytes) {
    throw new Error(`JSONLZ4 compressed size ${metadata.size} exceeds safety cap ${maxCompressedBytes}`);
  }
}

function sha256Bytes(value: Uint8Array): Sha256Digest {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}
