import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { hostname } from "node:os";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface ProcessOwner {
  readonly pid: number;
  readonly processStartIdentity: string | null;
  readonly host: string;
}

export async function currentProcessOwner(): Promise<ProcessOwner> {
  return {
    pid: process.pid,
    processStartIdentity: await processStartIdentity(process.pid),
    host: hostname()
  };
}

export async function processOwnerIsActive(owner: ProcessOwner): Promise<boolean> {
  if (owner.host !== hostname()) return true;
  try {
    process.kill(owner.pid, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    return true;
  }
  const observedStart = await processStartIdentity(owner.pid);
  if (owner.processStartIdentity && observedStart) {
    // Locks written before the UTC-stable identity was introduced used the
    // caller's local timezone. A live PID with that legacy form cannot be
    // compared safely, so fail closed instead of declaring its lock stale.
    if (owner.processStartIdentity.startsWith("ps-lstart:")
      && observedStart.startsWith("darwin-ps-lstart-utc:")) return true;
    return owner.processStartIdentity === observedStart;
  }
  return true;
}

export function assertProcessOwner(value: ProcessOwner, label: string): void {
  if (!Number.isSafeInteger(value.pid) || value.pid <= 0) throw new Error(`${label} pid is invalid`);
  if (value.processStartIdentity !== null && !value.processStartIdentity.trim()) {
    throw new Error(`${label} process start identity is invalid`);
  }
  if (!value.host.trim()) throw new Error(`${label} host is invalid`);
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
      env: {
        ...process.env,
        LANG: "C",
        LC_ALL: "C",
        TZ: "UTC"
      },
      maxBuffer: 64 * 1024
    });
    const start = stdout.trim();
    return start ? `darwin-ps-lstart-utc:${start}` : null;
  } catch {
    return null;
  }
}
