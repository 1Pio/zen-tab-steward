import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { basename, dirname, isAbsolute } from "node:path";

const RENAME_SWAP = 0x00000002;
const RENAME_EXCL = 0x00000004;
const RENAME_NOFOLLOW_ANY = 0x00000010;
const RENAME_RESOLVE_BENEATH = 0x00000020;
const MAX_DIAGNOSTIC_BYTES = 64 * 1024;
const HELPER_TIMEOUT_MS = 10_000;

const RENAME_SCRIPT = String.raw`
function run(argv) {
  ObjC.bindFunction("renameatx_np", ["int", ["int", "char *", "int", "char *", "uint32"]]);
  ObjC.bindFunction("__error", ["int *", []]);
  const flags = Number(argv[2]);
  const result = $.renameatx_np(3, argv[0], 3, argv[1], flags);
  if (result !== 0) throw new Error("ZTS_RENAME_FAILED:" + String($.__error()[0]));
  return "ZTS_RENAME_OK";
}
`;

export class AtomicRenameError extends Error {
  readonly errno: number | null;

  constructor(message: string, errno: number | null, options?: ErrorOptions) {
    super(message, options);
    this.name = "AtomicRenameError";
    this.errno = errno;
  }
}

export class AtomicRenameDestinationExistsError extends AtomicRenameError {
  readonly code = "EEXIST" as const;

  constructor(message: string, options?: ErrorOptions) {
    super(message, 17, options);
    this.name = "AtomicRenameDestinationExistsError";
  }
}

/**
 * Atomically exchanges two existing entries in one already-opened directory.
 * macOS renameatx_np is reached through the system JXA runtime so the package
 * does not need an install-time compiler or native Node addon. No ordinary
 * rename fallback is permitted because it would reintroduce overwrite races.
 */
export async function atomicSwapFilesDarwin(leftPath: string, rightPath: string): Promise<void> {
  await renameRelativeDarwin(
    leftPath,
    rightPath,
    RENAME_SWAP | RENAME_NOFOLLOW_ANY | RENAME_RESOLVE_BENEATH,
    "atomic swap"
  );
}

/** Atomically renames one entry only when the destination is still absent. */
export async function atomicRenameNoReplaceDarwin(sourcePath: string, destinationPath: string): Promise<void> {
  await renameRelativeDarwin(
    sourcePath,
    destinationPath,
    RENAME_EXCL | RENAME_NOFOLLOW_ANY | RENAME_RESOLVE_BENEATH,
    "no-replace rename"
  );
}

async function renameRelativeDarwin(
  sourcePath: string,
  destinationPath: string,
  flags: number,
  operation: string
): Promise<void> {
  if (process.platform !== "darwin") {
    throw new Error(`${operation} requires macOS renameatx_np in this production baseline`);
  }
  if (!isAbsolute(sourcePath) || !isAbsolute(destinationPath)) {
    throw new Error(`${operation} requires absolute paths`);
  }
  const parent = dirname(sourcePath);
  if (dirname(destinationPath) !== parent) {
    throw new Error(`${operation} requires two entries in the same directory`);
  }
  const sourceName = safeEntryName(sourcePath, operation);
  const destinationName = safeEntryName(destinationPath, operation);
  if (sourceName === destinationName) throw new Error(`${operation} requires distinct entries`);

  const directory = await open(parent, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const metadata = await directory.stat();
    if (!metadata.isDirectory()) throw new Error(`${operation} parent is not a directory`);
    await runRenameHelper(sourceName, destinationName, flags, operation, directory.fd);
  } finally {
    await directory.close();
  }
}

function safeEntryName(path: string, operation: string): string {
  const name = basename(path);
  if (name.length === 0 || name === "." || name === ".." || name.includes("/") || name.includes("\0")) {
    throw new Error(`${operation} received an unsafe directory entry name`);
  }
  return name;
}

async function runRenameHelper(
  sourceName: string,
  destinationName: string,
  flags: number,
  operation: string,
  directoryFd: number
): Promise<void> {
  const child = spawn(
    "/usr/bin/osascript",
    ["-l", "JavaScript", "-e", RENAME_SCRIPT, sourceName, destinationName, String(flags)],
    { stdio: ["ignore", "pipe", "pipe", directoryFd] }
  );
  let stdout = "";
  let stderr = "";
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    if (stdout.length < MAX_DIAGNOSTIC_BYTES) stdout += chunk.slice(0, MAX_DIAGNOSTIC_BYTES - stdout.length);
  });
  child.stderr?.on("data", (chunk: string) => {
    if (stderr.length < MAX_DIAGNOSTIC_BYTES) stderr += chunk.slice(0, MAX_DIAGNOSTIC_BYTES - stderr.length);
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGKILL");
  }, HELPER_TIMEOUT_MS);
  timer.unref();
  try {
    const result = await new Promise<{ readonly code: number | null; readonly signal: NodeJS.Signals | null }>(
      (resolve, reject) => {
        child.once("error", reject);
        child.once("exit", (code, signal) => resolve({ code, signal }));
      }
    );
    if (timedOut) throw new Error(`${operation} helper timed out`);
    if (result.code !== 0 || result.signal !== null || !stdout.includes("ZTS_RENAME_OK")) {
      const errnoMatch = /ZTS_RENAME_FAILED:([0-9]+)/u.exec(stderr);
      const errno = errnoMatch ? Number(errnoMatch[1]) : null;
      const message = `${operation} was not completed by macOS renameatx_np (${result.signal ?? `code ${String(result.code)}`}): ${stderr.trim() || "no success receipt"}`;
      if (errno === 17) throw new AtomicRenameDestinationExistsError(message);
      throw new AtomicRenameError(message, errno);
    }
  } finally {
    clearTimeout(timer);
  }
}
