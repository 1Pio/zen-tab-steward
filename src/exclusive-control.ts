import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { lstat, open, opendir } from "node:fs/promises";
import { dirname } from "node:path";
import {
  createPrivateJsonExclusive,
  inspectPrivateStandaloneTemporaryCandidate,
  isPrivateTemporaryBasename,
  privatePath,
  readPrivateJson,
  reconcilePrivatePublication,
  removePrivateStandaloneTemporaryCandidate
} from "./private-store.js";

const LOCK_FILE_SCHEMA = "zts.kernel-lock-file.provisional-1" as const;
const MAX_DIAGNOSTIC_BYTES = 64 * 1024;

export interface ExclusiveFileControl {
  readonly path: string;
  readonly identity: {
    readonly device: number;
    readonly inode: number;
    readonly linkCount: number;
    readonly mode: number;
  };
  assertHeld(): Promise<void>;
  release(): Promise<void>;
}

export interface ExclusiveFileControlOptions {
  readonly timeoutSeconds?: number;
  /** Native Profile locks are compatible with Gecko and are not zts JSON artifacts. */
  readonly fileKind?: "private" | "native_profile";
}

export class ExclusiveFileControlUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExclusiveFileControlUnavailableError";
  }
}

/**
 * Acquires a macOS kernel lock on a parent-owned open file description.
 * `lockf` receives a dup of fd 3, exits after acquisition, and the parent's
 * still-open descriptor retains control. Parent death or explicit close is
 * therefore the only release path; no helper lifetime or stale-PID takeover
 * participates in correctness.
 */
export async function acquireExclusiveFileControl(
  path: string,
  label: string,
  options: ExclusiveFileControlOptions = {}
): Promise<ExclusiveFileControl> {
  if (process.platform !== "darwin") {
    throw new Error(`${label} requires macOS /usr/bin/lockf in this production baseline`);
  }
  const timeoutSeconds = options.timeoutSeconds ?? 5;
  if (!Number.isSafeInteger(timeoutSeconds) || timeoutSeconds < 0 || timeoutSeconds > 60) {
    throw new Error(`${label} timeout must be between 0 and 60 seconds`);
  }
  const fileKind = options.fileKind ?? "private";
  let createdPrivateControl = false;
  if (fileKind === "private") {
    const lockFile = { schemaVersion: LOCK_FILE_SCHEMA };
    try {
      defineLockFile(await readPrivateJson(path, 64 * 1024));
      // A previous publisher may have committed the canonical hardlink and
      // died before removing its exact temp. Reconcile that nlink=2 pair once;
      // the ordinary nlink=1 path performs no directory scan or temp write.
      await reconcilePrivatePublication(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      createdPrivateControl = await createPrivateJsonExclusive(path, lockFile);
    }
    // The ENOENT observation can race another creator. Whether this process
    // won or lost, reread the canonical schema before opening it for lockf.
    defineLockFile(await readPrivateJson(path));
  }

  const handle = await open(
    path,
    constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW,
    0o600
  );
  try {
    if (fileKind === "private") await handle.chmod(0o600);
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1 || (process.getuid && before.uid !== process.getuid())) {
      throw new Error(`${label} path is not one current-user private regular file`);
    }
    const child = spawn(
      "/usr/bin/lockf",
      ["-s", "-t", String(timeoutSeconds), "3"],
      { stdio: ["ignore", "ignore", "pipe", handle.fd] }
    );
    let stderr = "";
    const diagnostics = child.stderr;
    if (!diagnostics) throw new Error(`${label} holder did not expose diagnostics`);
    diagnostics.setEncoding("utf8");
    diagnostics.on("data", (chunk: string) => {
      if (stderr.length < MAX_DIAGNOSTIC_BYTES) stderr += chunk.slice(0, MAX_DIAGNOSTIC_BYTES - stderr.length);
    });
    const { code, signal } = await waitForExit(child);
    if (code !== 0 || signal !== null) {
      if (code === 75 && signal === null) {
        throw new ExclusiveFileControlUnavailableError(
          `${label} could not be acquired: already controlled by another process`
        );
      }
      throw new Error(
        `${label} could not be acquired (${signal ?? `code ${String(code)}`}): ${stderr.trim() || "already controlled"}`
      );
    }
    const assertHeld = async () => {
      const [held, canonical] = await Promise.all([handle.stat(), lstat(path)]);
      if (held.dev !== before.dev
        || held.ino !== before.ino
        || canonical.isSymbolicLink()
        || !canonical.isFile()
        || canonical.nlink !== 1
        || canonical.dev !== held.dev
        || canonical.ino !== held.ino) {
        throw new Error(`${label} canonical path no longer names the controlled file`);
      }
    };
    await assertHeld();
    if (fileKind === "private" && createdPrivateControl) {
      // A process can die after writing the exclusive-create temporary but
      // before linking the canonical kernel-control file. The acquired kernel
      // lock proves no other holder owns this newly created control. This scan
      // is intentionally first-creation-only: receipt-history is a large
      // directory and must never become an O(N) lock-acquisition hot path.
      // Delete only standalone
      // candidates whose bounded JSON is exactly this control-file schema;
      // other temps in this parent may be CAS displaced-writer evidence.
      await reconcileKernelControlPublicationLosers(path, assertHeld);
    }

    let released = false;
    return {
      path,
      identity: {
        device: before.dev,
        inode: before.ino,
        linkCount: before.nlink,
        mode: before.mode & 0o777
      },
      assertHeld,
      async release() {
        if (released) throw new Error(`${label} has already been released`);
        const errors: unknown[] = [];
        try {
          await assertHeld();
        } catch (error) {
          errors.push(error);
        }
        try {
          await handle.close();
        } catch (error) {
          errors.push(error);
        }
        released = true;
        if (errors.length === 1) throw errors[0];
        if (errors.length > 1) throw new AggregateError(errors, `${label} identity check and release both failed`);
      }
    };
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}

async function reconcileKernelControlPublicationLosers(
  controlPath: string,
  assertHeld: () => Promise<void>
): Promise<void> {
  const parent = dirname(controlPath);
  const directory = await opendir(parent);
  let entries = 0;
  try {
    for await (const entry of directory) {
      entries += 1;
      if (entries > 4_096) {
        throw new Error("Kernel-control parent exceeds the 4096-entry reconciliation bound");
      }
      if (!isPrivateTemporaryBasename(entry.name)) continue;
      const candidatePath = privatePath(parent, entry.name);
      // This generic owner may share a parent with CAS displaced-writer
      // evidence. Only one-link exclusive-create losers are in scope here;
      // store-specific owners classify nlink=2 publication pairs.
      if ((await lstat(candidatePath)).nlink !== 1) continue;
      const candidate = await inspectPrivateStandaloneTemporaryCandidate(candidatePath);
      let value: unknown;
      try {
        value = await readPrivateJson(candidate.path, 64 * 1024);
        defineLockFile(value);
      } catch {
        // Another store primitive can share this parent. Classification remains
        // read-only and its non-control temporary is deliberately preserved.
        continue;
      }
      await assertHeld();
      await removePrivateStandaloneTemporaryCandidate(candidate);
    }
  } finally {
    await directory.close().catch(() => undefined);
  }
  await assertHeld();
}

async function waitForExit(child: ReturnType<typeof spawn>): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
}

function defineLockFile(value: unknown): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Kernel lock file must be an object");
  const keys = Object.keys(value);
  if (keys.length !== 1 || keys[0] !== "schemaVersion"
    || (value as { schemaVersion?: unknown }).schemaVersion !== LOCK_FILE_SCHEMA) {
    throw new Error("Kernel lock file identity is invalid");
  }
}
