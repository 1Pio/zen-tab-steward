import { constants, type Stats } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { lstat, open, rename, rm } from "node:fs/promises";
import { Buffer } from "node:buffer";
import { decompressBlock } from "lz4js";
import { dirname, join } from "node:path";
import type { Sha256Digest } from "./domain/digest.js";

const MAGIC = Buffer.from([0x6d, 0x6f, 0x7a, 0x4c, 0x7a, 0x34, 0x30, 0x00]);
const HEADER_LENGTH = 12;
export const DEFAULT_MAX_DECOMPRESSED_BYTES = 256 * 1024 * 1024;
export const DEFAULT_MAX_COMPRESSED_BYTES = 256 * 1024 * 1024;

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
  readonly beforeCommit?: () => Promise<void>;
}

export function decodeJsonLz4Buffer(buffer: Buffer): unknown {
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

  const json = Buffer.from(destination).toString("utf8");
  return JSON.parse(json);
}

function maxDecompressedBytes(): number {
  const configured = process.env.ZTS_MAX_JSONLZ4_DECOMPRESSED_BYTES;
  if (!configured) return DEFAULT_MAX_DECOMPRESSED_BYTES;
  const parsed = Number(configured);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_MAX_DECOMPRESSED_BYTES;
  return Math.floor(parsed);
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
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    assertSafeSource(before, path, maxCompressedBytes);
    const bytes = await handle.readFile();
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

export async function writeJsonLz4Durable(
  path: string,
  value: unknown,
  options: DurableJsonLz4WriteOptions = {}
): Promise<void> {
  const parent = dirname(path);
  const tempPath = join(parent, `.zts-${process.pid}-${randomUUID()}.jsonlz4.tmp`);
  const mode = options.mode ?? 0o600;
  const handle = await open(
    tempPath,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    mode
  );
  try {
    await handle.chmod(mode);
    await handle.writeFile(encodeJsonLz4Buffer(value));
    await handle.sync();
  } catch (error) {
    await handle.close();
    await rm(tempPath, { force: true });
    throw error;
  }
  await handle.close();
  try {
    await options.beforeCommit?.();
    await rename(tempPath, path);
    const directory = await open(parent, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } catch (error) {
    await rm(tempPath, { force: true });
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
  const header = Buffer.alloc(HEADER_LENGTH);
  MAGIC.copy(header, 0);
  header.writeUInt32LE(payload.length, 8);
  return Buffer.concat([header, encodeLiteralOnlyBlock(payload), payload]);
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
