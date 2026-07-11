import { execFile } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import { promisify } from "node:util";
import {
  ManagedZenBindingError,
  parseZenProcessInventory
} from "./managed-zen-lifecycle.js";

import type {
  ManagedZenApplicationIdentity,
  ManagedZenLifecycleRequest,
  ManagedZenPlatform,
  ManagedZenWindow
} from "./managed-zen-lifecycle.js";

const execFileAsync = promisify(execFile);

export function createDarwinManagedZenPlatform(): ManagedZenPlatform {
  if (process.platform !== "darwin") {
    throw new ManagedZenBindingError("Managed Zen lifecycle is available only on macOS");
  }
  return {
    async listProcesses() {
      const { stdout } = await execFileAsync(
        "/bin/ps",
        ["-axo", "pid=,ppid=,uid=,lstart=,args="],
        {
          env: { ...process.env, LANG: "C", LC_ALL: "C", TZ: "UTC" },
          maxBuffer: 10 * 1024 * 1024
        }
      );
      return parseZenProcessInventory(stdout);
    },
    async inspectApplication(pid) {
      return inspectApplication(pid);
    },
    async inspectWindows(pid) {
      return inspectWindows(pid);
    },
    async restoreWindows(pid, windows) {
      assertPid(pid);
      const targets = JSON.stringify(windows);
      await runJxa(`
        ObjC.import("AppKit");
        const running = $.NSRunningApplication.runningApplicationWithProcessIdentifier(${pid});
        if (!running) throw new Error("Zen process is no longer a running application");
        const application = Application(ObjC.unwrap(running.bundleIdentifier));
        const targets = ${targets};
        const read = fn => { try { return fn(); } catch { return null; } };
        const semantic = application.windows().filter(window => {
          const id = read(() => window.id());
          const name = read(() => window.name());
          const bounds = read(() => window.bounds());
          return Number.isInteger(id)
            && name !== "Software Update"
            && bounds
            && Number(bounds.width) > 0
            && Number(bounds.height) > 0;
        });
        if (semantic.length !== targets.length) throw new Error("Zen semantic window count changed before restoration");
        semantic.forEach((window, index) => {
          const target = targets[index];
          window.bounds = target.bounds;
          window.visible = target.visible;
          window.miniaturized = target.miniaturized;
        });
        "restored";
      `);
    },
    async requestGracefulQuit(pid) {
      const { stdout } = await runJxa(`
        ObjC.import("AppKit");
        const app = $.NSRunningApplication.runningApplicationWithProcessIdentifier(${pid});
        if (!app) throw new Error("Zen process is no longer a running application");
        String(Boolean(app.terminate));
      `);
      return stdout.trim() === "true";
    },
    async launch(application) {
      await execFileAsync(
        "/usr/bin/open",
        ["-n", "-a", application.bundlePath, "--args", "-profile", application.profilePath],
        { maxBuffer: 64 * 1024 }
      );
    },
    async wait(milliseconds) {
      await new Promise<void>((resolveWait) => setTimeout(resolveWait, milliseconds));
    }
  };
}

export async function discoverDarwinManagedZenRequest(
  platform: ManagedZenPlatform,
  profilePath: string
): Promise<ManagedZenLifecycleRequest> {
  const uid = process.getuid?.();
  if (!Number.isSafeInteger(uid) || uid === undefined || uid < 0) {
    throw new ManagedZenBindingError("Managed Zen cannot determine the current macOS user id");
  }
  const processes = await platform.listProcesses();
  const roots = processes.filter((process) =>
    /^(\/.*\/Zen\.app\/Contents\/MacOS\/zen)(?:\s|$)/u.test(process.args)
  );
  if (roots.length !== 1) {
    throw new ManagedZenBindingError(`Managed Zen requires exactly one discoverable browser root; observed ${roots.length}`);
  }
  const application = await platform.inspectApplication(roots[0]!.pid);
  return {
    profilePath,
    executablePath: application.executablePath,
    uid,
    bundleIdentifier: application.bundleIdentifier
  };
}

async function inspectApplication(pid: number): Promise<ManagedZenApplicationIdentity> {
  assertPid(pid);
  const { stdout } = await runJxa(`
    ObjC.import("AppKit");
    const app = $.NSRunningApplication.runningApplicationWithProcessIdentifier(${pid});
    if (!app) throw new Error("Zen process is no longer a running application");
    JSON.stringify({
      pid: Number(app.processIdentifier),
      bundleIdentifier: ObjC.unwrap(app.bundleIdentifier),
      executablePath: ObjC.unwrap(app.executableURL.path),
      bundlePath: ObjC.unwrap(app.bundleURL.path)
    });
  `);
  const running = parseJsonRecord(stdout, "Managed Zen running application identity");
  const executablePath = await realpath(requiredString(running.executablePath, "Managed Zen executable path"));
  const bundlePath = await realpath(requiredString(running.bundlePath, "Managed Zen bundle path"));
  const executable = await stat(executablePath);
  if (!executable.isFile()) throw new ManagedZenBindingError("Managed Zen executable is not a regular file");
  const infoPath = `${bundlePath}/Contents/Info.plist`;
  const [versionResult, bundleVersionResult, signatureResult] = await Promise.all([
    execFileAsync("/usr/bin/plutil", ["-extract", "CFBundleShortVersionString", "raw", "-o", "-", infoPath], { maxBuffer: 64 * 1024 }),
    execFileAsync("/usr/bin/plutil", ["-extract", "CFBundleVersion", "raw", "-o", "-", infoPath], { maxBuffer: 64 * 1024 }),
    execFileAsync("/usr/bin/codesign", ["-dv", "--verbose=4", bundlePath], { maxBuffer: 1024 * 1024 })
  ]);
  const signature = `${signatureResult.stdout}\n${signatureResult.stderr}`;
  return {
    pid: requiredPositiveInteger(running.pid, "Managed Zen application pid"),
    bundleIdentifier: requiredString(running.bundleIdentifier, "Managed Zen bundle identifier"),
    executablePath,
    bundlePath,
    version: versionResult.stdout.trim(),
    bundleVersion: bundleVersionResult.stdout.trim(),
    teamIdentifier: requiredMatch(signature, /^TeamIdentifier=(.+)$/mu, "Managed Zen TeamIdentifier"),
    codeDirectoryHash: requiredMatch(signature, /^CDHash=([a-f0-9]+)$/mu, "Managed Zen CDHash"),
    executableDevice: executable.dev,
    executableInode: executable.ino,
    executableSize: executable.size,
    executableModifiedMs: Math.trunc(executable.mtimeMs)
  };
}

async function inspectWindows(pid: number): Promise<readonly ManagedZenWindow[]> {
  assertPid(pid);
  const { stdout } = await runJxa(`
    ObjC.import("AppKit");
    const running = $.NSRunningApplication.runningApplicationWithProcessIdentifier(${pid});
    if (!running) throw new Error("Zen process is no longer a running application");
    const bundle = ObjC.unwrap(running.bundleIdentifier);
    const application = Application(bundle);
    const read = fn => { try { return fn(); } catch { return null; } };
    const windows = application.windows().map(window => ({
      id: read(() => window.id()),
      name: read(() => window.name()),
      visible: read(() => window.visible()),
      miniaturized: read(() => window.miniaturized()),
      bounds: read(() => window.bounds())
    })).filter(window =>
      Number.isInteger(window.id)
      && window.name !== "Software Update"
      && window.bounds
      && Number(window.bounds.width) > 0
      && Number(window.bounds.height) > 0
    ).map(window => ({
      visible: Boolean(window.visible),
      miniaturized: Boolean(window.miniaturized),
      bounds: {
        x: Number(window.bounds.x),
        y: Number(window.bounds.y),
        width: Number(window.bounds.width),
        height: Number(window.bounds.height)
      }
    }));
    JSON.stringify(windows);
  `);
  let value: unknown;
  try {
    value = JSON.parse(stdout);
  } catch (error) {
    throw new ManagedZenBindingError(`Managed Zen window inspection returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!Array.isArray(value)) throw new ManagedZenBindingError("Managed Zen window inspection did not return an array");
  return value as ManagedZenWindow[];
}

async function runJxa(script: string) {
  return execFileAsync(
    "/usr/bin/osascript",
    ["-l", "JavaScript", "-e", script],
    { maxBuffer: 1024 * 1024 }
  );
}

function parseJsonRecord(text: string, label: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new ManagedZenBindingError(`${label} returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ManagedZenBindingError(`${label} did not return an object`);
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ManagedZenBindingError(`${label} is missing`);
  }
  return value;
}

function requiredPositiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) {
    throw new ManagedZenBindingError(`${label} is invalid`);
  }
  return Number(value);
}

function requiredMatch(text: string, pattern: RegExp, label: string): string {
  const match = text.match(pattern)?.[1]?.trim();
  if (!match) throw new ManagedZenBindingError(`${label} is missing`);
  return match;
}

function assertPid(pid: number): void {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new ManagedZenBindingError("Managed Zen pid is invalid");
}
