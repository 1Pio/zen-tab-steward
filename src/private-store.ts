import { constants, type Stats } from "node:fs";
import { chmod, link, lstat, mkdir, open, rename, rm } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";

const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const DEFAULT_MAX_JSON_BYTES = 16 * 1024 * 1024;

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
  await ensureDirectory(resolvedRoot);
  let current = resolvedRoot;
  for (const segment of segments) {
    assertSafeSegment(segment);
    current = privatePath(current, segment);
    await ensureDirectory(current);
  }
  return current;
}

export async function publishPrivateJson(path: string, value: unknown): Promise<void> {
  const contents = encodeJson(value);
  const parent = dirname(path);
  await ensureDirectory(parent);
  const temporary = privatePath(parent, `.tmp-${randomUUID()}.json`);
  await writeSyncedTemporary(temporary, contents);
  try {
    await link(temporary, path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const existing = await readPrivateText(path, Buffer.byteLength(contents));
    if (existing !== contents) throw new Error("Private artifact identifier collision");
  } finally {
    await rm(temporary, { force: true });
  }
  await enforcePrivateFile(path);
  await syncDirectory(parent);
}

export async function replacePrivateJson(path: string, value: unknown): Promise<void> {
  const contents = encodeJson(value);
  const parent = dirname(path);
  await ensureDirectory(parent);
  const temporary = privatePath(parent, `.tmp-${randomUUID()}.json`);
  await writeSyncedTemporary(temporary, contents);
  try {
    await rename(temporary, path);
    await enforcePrivateFile(path);
    await syncDirectory(parent);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

export async function readPrivateJson(path: string, maxBytes = DEFAULT_MAX_JSON_BYTES): Promise<unknown> {
  const contents = await readPrivateText(path, maxBytes);
  try {
    return JSON.parse(contents) as unknown;
  } catch {
    throw new Error(`Private artifact is not valid JSON: ${path}`);
  }
}

async function ensureDirectory(path: string): Promise<void> {
  try {
    const existing = await lstat(path);
    if (existing.isSymbolicLink() || !existing.isDirectory()) {
      throw new Error(`Private artifact path is not a real directory: ${path}`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await mkdir(path, { recursive: true, mode: DIRECTORY_MODE });
    const created = await lstat(path);
    if (created.isSymbolicLink() || !created.isDirectory()) {
      throw new Error(`Private artifact directory was replaced during creation: ${path}`);
    }
  }
  await chmod(path, DIRECTORY_MODE);
}

async function writeSyncedTemporary(path: string, contents: string): Promise<void> {
  const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;
  const handle = await open(path, flags, FILE_MODE);
  try {
    await handle.chmod(FILE_MODE);
    await handle.writeFile(contents, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function readPrivateText(path: string, maxBytes: number): Promise<string> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error("Private artifact read limit must be a positive integer");
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    assertPrivateFileMetadata(before, path);
    if (before.size > maxBytes) throw new Error(`Private artifact exceeds the ${maxBytes}-byte read limit: ${path}`);
    await handle.chmod(FILE_MODE);
    const contents = await handle.readFile("utf8");
    const after = await handle.stat();
    assertPrivateFileMetadata(after, path);
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || Buffer.byteLength(contents) !== after.size) {
      throw new Error(`Private artifact changed while it was being read: ${path}`);
    }
    return contents;
  } finally {
    await handle.close();
  }
}

async function enforcePrivateFile(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    assertPrivateFileMetadata(await handle.stat(), path);
    await handle.chmod(FILE_MODE);
    assertPrivateFileMetadata(await handle.stat(), path);
  } finally {
    await handle.close();
  }
}

function assertPrivateFileMetadata(metadata: Stats, path: string): void {
  if (!metadata.isFile()) throw new Error(`Private artifact is not a regular file: ${path}`);
  if (metadata.nlink !== 1) throw new Error(`Private artifact has an unexpected hardlink count: ${path}`);
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function encodeJson(value: unknown): string {
  const contents = `${JSON.stringify(value, null, 2)}\n`;
  if (Buffer.byteLength(contents) > DEFAULT_MAX_JSON_BYTES) {
    throw new Error(`Private JSON artifact exceeds the ${DEFAULT_MAX_JSON_BYTES}-byte write limit`);
  }
  return contents;
}

function assertSafeSegment(segment: string): void {
  if (!segment || segment === "." || segment === ".." || !/^[A-Za-z0-9._-]+$/.test(segment)) {
    throw new Error(`Unsafe private artifact path segment: ${segment}`);
  }
}
