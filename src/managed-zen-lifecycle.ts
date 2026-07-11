import { resolve } from "node:path";
import { sha256Canonical } from "./domain/digest.js";

export interface ZenProcessInventoryEntry {
  readonly pid: number;
  readonly ppid: number;
  readonly uid: number;
  readonly processStartIdentity: string;
  readonly args: string;
  readonly profilePath: string | null;
}

export interface ManagedZenBindingRequest {
  readonly profilePath: string;
  readonly executablePath: string;
  readonly uid: number;
}

export interface ManagedZenProcessBinding {
  readonly root: ZenProcessInventoryEntry;
  readonly profilePath: string;
  readonly executablePath: string;
  readonly processes: readonly ZenProcessInventoryEntry[];
  readonly processPids: readonly number[];
  readonly profileEvidencePids: readonly number[];
  readonly revision: `sha256:${string}`;
}

export interface ManagedZenApplicationIdentity {
  readonly pid: number;
  readonly bundleIdentifier: string;
  readonly executablePath: string;
  readonly bundlePath: string;
  readonly version: string;
  readonly bundleVersion: string;
  readonly teamIdentifier: string;
  readonly codeDirectoryHash: string;
  readonly executableDevice: number;
  readonly executableInode: number;
  readonly executableSize: number;
  readonly executableModifiedMs: number;
}

export interface ManagedZenLifecycleRequest extends ManagedZenBindingRequest {
  readonly bundleIdentifier: string;
}

export interface ManagedZenLifecycleBinding {
  readonly profilePath: string;
  readonly executablePath: string;
  readonly bundleIdentifier: string;
  readonly uid: number;
  readonly rootPid: number;
  readonly processStartIdentity: string;
  readonly processBindingRevision: `sha256:${string}`;
  readonly boundProcesses: readonly {
    readonly pid: number;
    readonly processStartIdentity: string;
  }[];
  readonly windowState: ManagedZenWindowState;
  readonly application: ManagedZenApplicationIdentity;
  readonly revision: `sha256:${string}`;
}

export interface ManagedZenWindow {
  readonly visible: boolean;
  readonly miniaturized: boolean;
  readonly bounds: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  };
}

export interface ManagedZenWindowState {
  readonly windows: readonly ManagedZenWindow[];
  readonly revision: `sha256:${string}`;
}

export interface ManagedZenPlatform {
  listProcesses(): Promise<readonly ZenProcessInventoryEntry[]>;
  inspectApplication(pid: number): Promise<ManagedZenApplicationIdentity>;
  inspectWindows(pid: number): Promise<readonly ManagedZenWindow[]>;
  requestGracefulQuit(pid: number): Promise<boolean>;
  launch(application: { readonly bundlePath: string; readonly profilePath: string }): Promise<void>;
  wait(milliseconds: number): Promise<void>;
}

export interface ManagedZenLifecycleWaitOptions {
  readonly timeoutMs: number;
  readonly pollMs: number;
}

export interface ManagedZenClosedEvidence {
  readonly quit: "verified";
  readonly stateFlush: "pending_native_profile_control";
  readonly closedProcessBindingRevision: `sha256:${string}`;
}

export class ManagedZenBindingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ManagedZenBindingError";
  }
}

export function parseZenProcessInventory(stdout: string): ZenProcessInventoryEntry[] {
  const processes: ZenProcessInventoryEntry[] = [];
  for (const line of stdout.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed.includes("/Zen.app/Contents/MacOS/")) continue;
    const match = trimmed.match(
      /^(\d+)\s+(\d+)\s+(\d+)\s+([A-Z][a-z]{2}\s+[A-Z][a-z]{2}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.+)$/u
    );
    if (!match) continue;
    const pid = Number(match[1]);
    const ppid = Number(match[2]);
    const uid = Number(match[3]);
    const start = match[4] ?? "";
    const args = match[5] ?? "";
    if (!/^\/.*\/Zen\.app\/Contents\/MacOS\//u.test(args)) continue;
    if (![pid, ppid, uid].every(Number.isSafeInteger) || pid <= 0 || ppid < 0 || uid < 0) continue;
    processes.push({
      pid,
      ppid,
      uid,
      processStartIdentity: `darwin-ps-lstart-utc:${start}`,
      args,
      profilePath: extractProfilePath(args)
    });
  }
  return processes;
}

export function bindZenProcessTree(
  processes: readonly ZenProcessInventoryEntry[],
  request: ManagedZenBindingRequest
): ManagedZenProcessBinding {
  const expectedProfile = resolve(request.profilePath);
  const expectedExecutable = resolve(request.executablePath);
  const roots = processes.filter((process) => commandStartsWithExecutable(process.args, expectedExecutable));
  if (roots.length !== 1) {
    throw new ManagedZenBindingError(
      `Managed Zen requires exactly one browser root for ${expectedExecutable}; observed ${roots.length}`
    );
  }
  const root = roots[0]!;
  if (root.uid !== request.uid) {
    throw new ManagedZenBindingError(`Managed Zen browser root ${root.pid} belongs to uid ${root.uid}, not ${request.uid}`);
  }
  const byParent = new Map<number, ZenProcessInventoryEntry[]>();
  for (const process of processes) {
    const children = byParent.get(process.ppid) ?? [];
    children.push(process);
    byParent.set(process.ppid, children);
  }
  const tree: ZenProcessInventoryEntry[] = [];
  const queue = [root];
  const seen = new Set<number>();
  while (queue.length > 0) {
    const process = queue.shift()!;
    if (seen.has(process.pid)) {
      throw new ManagedZenBindingError(`Managed Zen process tree contains a cycle at pid ${process.pid}`);
    }
    seen.add(process.pid);
    tree.push(process);
    queue.push(...(byParent.get(process.pid) ?? []));
  }
  if (tree.length !== processes.length) {
    const outside = processes.filter((process) => !seen.has(process.pid)).map((process) => process.pid);
    throw new ManagedZenBindingError(`Managed Zen inventory contains another root or orphan process: ${outside.join(", ")}`);
  }
  for (const process of tree) {
    if (process.uid !== request.uid) {
      throw new ManagedZenBindingError(`Managed Zen process ${process.pid} belongs to uid ${process.uid}, not ${request.uid}`);
    }
    if (process.profilePath !== null && resolve(process.profilePath) !== expectedProfile) {
      throw new ManagedZenBindingError(
        `Managed Zen process ${process.pid} is bound to a different Profile: ${process.profilePath}`
      );
    }
  }
  const profileEvidencePids = tree
    .filter((process) => process.profilePath !== null && resolve(process.profilePath) === expectedProfile)
    .map((process) => process.pid)
    .sort((left, right) => left - right);
  if (profileEvidencePids.length === 0) {
    throw new ManagedZenBindingError("Managed Zen browser root has no exact-Profile process evidence");
  }
  const processPids = tree.map((process) => process.pid).sort((left, right) => left - right);
  const content = {
    root: {
      pid: root.pid,
      ppid: root.ppid,
      uid: root.uid,
      processStartIdentity: root.processStartIdentity
    },
    profilePath: expectedProfile,
    executablePath: expectedExecutable,
    processPids,
    profileEvidencePids
  };
  return Object.freeze({ ...content, root, processes: tree, revision: sha256Canonical(content) });
}

export async function captureManagedZenLifecycleBinding(
  platform: ManagedZenPlatform,
  request: ManagedZenLifecycleRequest
): Promise<ManagedZenLifecycleBinding> {
  const processBinding = bindZenProcessTree(await platform.listProcesses(), request);
  const root = processBinding.root;
  if (hasPrivilegedRemoteFlag(root.args)) {
    throw new ManagedZenBindingError("Managed closed-session lifecycle requires an ordinary Zen launch without privileged remote-control flags");
  }
  const application = await platform.inspectApplication(root.pid);
  validateApplicationIdentity(application, root.pid, request);
  const windowState = defineWindowState(await platform.inspectWindows(root.pid));
  const content = {
    profilePath: resolve(request.profilePath),
    executablePath: resolve(request.executablePath),
    bundleIdentifier: request.bundleIdentifier,
    uid: request.uid,
    rootPid: root.pid,
    processStartIdentity: root.processStartIdentity,
    processBindingRevision: processBinding.revision,
    boundProcesses: processBinding.processes
      .map((process) => ({ pid: process.pid, processStartIdentity: process.processStartIdentity }))
      .sort((left, right) => left.pid - right.pid),
    windowState,
    application
  };
  return Object.freeze({ ...content, revision: sha256Canonical(content) });
}

export function defineManagedZenLifecycleBinding(value: unknown): ManagedZenLifecycleBinding {
  assertRecordKeys(value, [
    "profilePath",
    "executablePath",
    "bundleIdentifier",
    "uid",
    "rootPid",
    "processStartIdentity",
    "processBindingRevision",
    "boundProcesses",
    "windowState",
    "application",
    "revision"
  ], "Managed Zen lifecycle binding");
  const binding = value as unknown as ManagedZenLifecycleBinding;
  assertRecordKeys(binding.application, [
    "pid",
    "bundleIdentifier",
    "executablePath",
    "bundlePath",
    "version",
    "bundleVersion",
    "teamIdentifier",
    "codeDirectoryHash",
    "executableDevice",
    "executableInode",
    "executableSize",
    "executableModifiedMs"
  ], "Managed Zen application identity");
  validateApplicationIdentity(binding.application, binding.rootPid, {
    profilePath: binding.profilePath,
    executablePath: binding.executablePath,
    uid: binding.uid,
    bundleIdentifier: binding.bundleIdentifier
  });
  if (binding.profilePath !== resolve(binding.profilePath)
    || binding.executablePath !== resolve(binding.executablePath)
    || !Number.isSafeInteger(binding.uid) || binding.uid < 0
    || typeof binding.processStartIdentity !== "string" || !binding.processStartIdentity.trim()
    || !isDigest(binding.processBindingRevision)
    || !Array.isArray(binding.boundProcesses)
    || binding.boundProcesses.length === 0) {
    throw new ManagedZenBindingError("Managed Zen lifecycle binding identity is invalid");
  }
  const seenPids = new Set<number>();
  for (const boundProcess of binding.boundProcesses) {
    assertRecordKeys(boundProcess, ["pid", "processStartIdentity"], "Managed Zen bound process");
    const candidate = boundProcess as unknown as { pid: unknown; processStartIdentity: unknown };
    if (!Number.isSafeInteger(candidate.pid) || Number(candidate.pid) <= 0
      || seenPids.has(Number(candidate.pid))
      || typeof candidate.processStartIdentity !== "string"
      || !candidate.processStartIdentity.trim()) {
      throw new ManagedZenBindingError("Managed Zen bound process identity is invalid");
    }
    seenPids.add(Number(candidate.pid));
  }
  if (!seenPids.has(binding.rootPid)) {
    throw new ManagedZenBindingError("Managed Zen lifecycle binding omits its browser root process");
  }
  assertRecordKeys(binding.windowState, ["windows", "revision"], "Managed Zen window state");
  if (!Array.isArray(binding.windowState.windows)) {
    throw new ManagedZenBindingError("Managed Zen window state must contain a window array");
  }
  for (const window of binding.windowState.windows) {
    assertRecordKeys(window, ["visible", "miniaturized", "bounds"], "Managed Zen window");
    assertRecordKeys(window.bounds, ["x", "y", "width", "height"], "Managed Zen window bounds");
  }
  const windowState = defineWindowState(binding.windowState.windows);
  if (windowState.revision !== binding.windowState.revision) {
    throw new ManagedZenBindingError("Managed Zen window state revision is invalid");
  }
  const { revision: _revision, ...content } = binding;
  if (!isDigest(binding.revision) || sha256Canonical(content) !== binding.revision) {
    throw new ManagedZenBindingError("Managed Zen lifecycle binding revision is invalid");
  }
  return binding;
}

export function managedZenGrantRevision(
  binding: ManagedZenLifecycleBinding,
  planDigest: string,
  consentDigest: string
): `sha256:${string}` {
  defineManagedZenLifecycleBinding(binding);
  if (!isDigest(planDigest) || !isDigest(consentDigest)) {
    throw new ManagedZenBindingError("Managed Zen lifecycle grant requires exact Plan and consent digests");
  }
  return sha256Canonical({
    kind: "managed_zen",
    lifecycleBindingRevision: binding.revision,
    planDigest,
    consentDigest
  });
}

export function assertManagedZenRelaunchBinding(
  beforeValue: unknown,
  afterValue: unknown
): asserts afterValue is ManagedZenLifecycleBinding {
  const before = defineManagedZenLifecycleBinding(beforeValue);
  const after = defineManagedZenLifecycleBinding(afterValue);
  if (after.profilePath !== before.profilePath
    || after.executablePath !== before.executablePath
    || after.bundleIdentifier !== before.bundleIdentifier
    || after.uid !== before.uid
    || (after.rootPid === before.rootPid && after.processStartIdentity === before.processStartIdentity)) {
    throw new ManagedZenBindingError("Managed Zen relaunch does not bind a new exact process for the authorized Profile");
  }
  assertSameApplication(before.application, after.application);
  if (after.windowState.revision !== before.windowState.revision) {
    throw new ManagedZenBindingError("Managed Zen relaunch did not restore the authorized semantic window state");
  }
}

export async function quitManagedZen(
  platform: ManagedZenPlatform,
  binding: ManagedZenLifecycleBinding,
  options: ManagedZenLifecycleWaitOptions
): Promise<ManagedZenClosedEvidence> {
  validateWaitOptions(options);
  const current = await captureManagedZenLifecycleBinding(platform, requestFromBinding(binding));
  if (current.revision !== binding.revision) {
    throw new ManagedZenBindingError("Managed Zen lifecycle binding changed before graceful quit");
  }
  if (!await platform.requestGracefulQuit(binding.rootPid)) {
    throw new ManagedZenBindingError(`Managed Zen rejected the graceful quit request for pid ${binding.rootPid}`);
  }
  const attempts = waitAttempts(options);
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const processes = await platform.listProcesses();
    const originalByPid = new Map(binding.boundProcesses.map((process) => [process.pid, process]));
    const reused = processes.find((process) => {
      const original = originalByPid.get(process.pid);
      return original && process.processStartIdentity !== original.processStartIdentity;
    });
    if (reused) throw new ManagedZenBindingError(`Managed Zen process pid ${reused.pid} was reused during quit`);
    const targetProcesses = processes.filter((process) => {
      const original = originalByPid.get(process.pid);
      return (original && process.processStartIdentity === original.processStartIdentity)
        || (process.profilePath !== null && resolve(process.profilePath) === binding.profilePath);
    });
    if (targetProcesses.length === 0) {
      return {
        quit: "verified",
        stateFlush: "pending_native_profile_control",
        closedProcessBindingRevision: sha256Canonical({
          lifecycleRevision: binding.revision,
          processPids: []
        })
      };
    }
    if (attempt + 1 < attempts) await platform.wait(options.pollMs);
  }
  throw new ManagedZenBindingError(
    `Managed Zen did not release the exact Profile within ${options.timeoutMs}ms; no force quit was attempted`
  );
}

export async function relaunchManagedZen(
  platform: ManagedZenPlatform,
  binding: ManagedZenLifecycleBinding,
  options: ManagedZenLifecycleWaitOptions
): Promise<ManagedZenLifecycleBinding> {
  validateWaitOptions(options);
  const beforeLaunch = await platform.listProcesses();
  if (beforeLaunch.some((process) =>
    process.pid === binding.rootPid
    || (process.profilePath !== null && resolve(process.profilePath) === binding.profilePath)
  )) {
    throw new ManagedZenBindingError("Managed Zen cannot relaunch while the previous Profile process tree remains present");
  }
  await platform.launch({
    bundlePath: binding.application.bundlePath,
    profilePath: binding.profilePath
  });
  const request = requestFromBinding(binding);
  const attempts = waitAttempts(options);
  let lastError: unknown = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const relaunched = await captureManagedZenLifecycleBinding(platform, request);
      assertManagedZenRelaunchBinding(binding, relaunched);
      await platform.wait(options.pollMs);
      const stable = await captureManagedZenLifecycleBinding(platform, request);
      if (stable.rootPid !== relaunched.rootPid
        || stable.processStartIdentity !== relaunched.processStartIdentity
        || stable.processBindingRevision !== relaunched.processBindingRevision
        || stable.windowState.revision !== relaunched.windowState.revision) {
        throw new ManagedZenBindingError("Managed Zen relaunch process or window state did not remain stable across verification");
      }
      return stable;
    } catch (error) {
      lastError = error;
      if (attempt + 1 < attempts) await platform.wait(options.pollMs);
    }
  }
  throw new ManagedZenBindingError(
    `Managed Zen did not restore the exact application, Profile, and windows within ${options.timeoutMs}ms: ${lastError instanceof Error ? lastError.message : String(lastError)}`
  );
}

export async function ensureManagedZenRelaunched(
  platform: ManagedZenPlatform,
  binding: ManagedZenLifecycleBinding,
  options: ManagedZenLifecycleWaitOptions
): Promise<ManagedZenLifecycleBinding> {
  const processes = await platform.listProcesses();
  const targetPresent = processes.some((process) =>
    process.pid === binding.rootPid
    || (process.profilePath !== null && resolve(process.profilePath) === binding.profilePath)
  );
  if (!targetPresent && processes.length === 0) {
    return relaunchManagedZen(platform, binding, options);
  }
  const current = await captureManagedZenLifecycleBinding(platform, requestFromBinding(binding));
  assertManagedZenRelaunchBinding(binding, current);
  return current;
}

function commandStartsWithExecutable(args: string, executablePath: string): boolean {
  return args === executablePath || args.startsWith(`${executablePath} `);
}

function requestFromBinding(binding: ManagedZenLifecycleBinding): ManagedZenLifecycleRequest {
  return {
    profilePath: binding.profilePath,
    executablePath: binding.executablePath,
    uid: binding.uid,
    bundleIdentifier: binding.bundleIdentifier
  };
}

function validateApplicationIdentity(
  application: ManagedZenApplicationIdentity,
  expectedPid: number,
  request: ManagedZenLifecycleRequest
): void {
  if (application.pid !== expectedPid) {
    throw new ManagedZenBindingError(`Managed Zen application identity returned pid ${application.pid}; expected ${expectedPid}`);
  }
  if (application.bundleIdentifier !== request.bundleIdentifier) {
    throw new ManagedZenBindingError(`Managed Zen bundle is ${application.bundleIdentifier}, not ${request.bundleIdentifier}`);
  }
  if (resolve(application.executablePath) !== resolve(request.executablePath)) {
    throw new ManagedZenBindingError("Managed Zen executable identity does not match the bound application");
  }
  for (const [label, value] of Object.entries({
    bundlePath: application.bundlePath,
    version: application.version,
    bundleVersion: application.bundleVersion,
    teamIdentifier: application.teamIdentifier,
    codeDirectoryHash: application.codeDirectoryHash
  })) {
    if (typeof value !== "string" || value.trim().length === 0) {
      throw new ManagedZenBindingError(`Managed Zen application ${label} is missing`);
    }
  }
  for (const [label, value] of Object.entries({
    executableDevice: application.executableDevice,
    executableInode: application.executableInode,
    executableSize: application.executableSize,
    executableModifiedMs: application.executableModifiedMs
  })) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new ManagedZenBindingError(`Managed Zen application ${label} is invalid`);
    }
  }
}

function assertSameApplication(
  before: ManagedZenApplicationIdentity,
  after: ManagedZenApplicationIdentity
): void {
  const identity = (value: ManagedZenApplicationIdentity) => ({
    bundleIdentifier: value.bundleIdentifier,
    executablePath: resolve(value.executablePath),
    bundlePath: resolve(value.bundlePath),
    version: value.version,
    bundleVersion: value.bundleVersion,
    teamIdentifier: value.teamIdentifier,
    codeDirectoryHash: value.codeDirectoryHash,
    executableDevice: value.executableDevice,
    executableInode: value.executableInode,
    executableSize: value.executableSize,
    executableModifiedMs: value.executableModifiedMs
  });
  if (sha256Canonical(identity(before)) !== sha256Canonical(identity(after))) {
    throw new ManagedZenBindingError("Managed Zen application identity changed across relaunch");
  }
}

function validateWaitOptions(options: ManagedZenLifecycleWaitOptions): void {
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1
    || !Number.isSafeInteger(options.pollMs) || options.pollMs < 1
    || options.pollMs > options.timeoutMs) {
    throw new ManagedZenBindingError("Managed Zen lifecycle wait options are invalid");
  }
}

function waitAttempts(options: ManagedZenLifecycleWaitOptions): number {
  return Math.max(1, Math.ceil(options.timeoutMs / options.pollMs));
}

function hasPrivilegedRemoteFlag(args: string): boolean {
  return ["--remote-debugging-port", "--start-debugger-server", "--marionette", "--remote-allow-system-access"]
    .some((flag) => args.includes(flag));
}

function defineWindowState(windows: readonly ManagedZenWindow[]): ManagedZenWindowState {
  const normalized = windows.map((window, index): ManagedZenWindow => {
    if (typeof window.visible !== "boolean" || typeof window.miniaturized !== "boolean") {
      throw new ManagedZenBindingError(`Managed Zen window ${index + 1} has invalid visibility state`);
    }
    const bounds = window.bounds;
    for (const [label, value] of Object.entries(bounds)) {
      if (!Number.isFinite(value)) {
        throw new ManagedZenBindingError(`Managed Zen window ${index + 1} ${label} is invalid`);
      }
    }
    if (bounds.width <= 0 || bounds.height <= 0) {
      throw new ManagedZenBindingError(`Managed Zen window ${index + 1} has non-restorable bounds`);
    }
    return {
      visible: window.visible,
      miniaturized: window.miniaturized,
      bounds: {
        x: Math.round(bounds.x),
        y: Math.round(bounds.y),
        width: Math.round(bounds.width),
        height: Math.round(bounds.height)
      }
    };
  }).sort((left, right) =>
    left.bounds.x - right.bounds.x
    || left.bounds.y - right.bounds.y
    || left.bounds.width - right.bounds.width
    || left.bounds.height - right.bounds.height
    || Number(left.miniaturized) - Number(right.miniaturized)
    || Number(left.visible) - Number(right.visible)
  );
  return Object.freeze({ windows: normalized, revision: sha256Canonical({ windows: normalized }) });
}

function assertRecordKeys(value: unknown, keys: readonly string[], label: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ManagedZenBindingError(`${label} must be a record`);
  }
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new ManagedZenBindingError(`${label} contains unknown or missing fields`);
  }
}

function isDigest(value: unknown): value is `sha256:${string}` {
  return typeof value === "string" && /^sha256:[a-f0-9]{64}$/u.test(value);
}

function extractProfilePath(args: string): string | null {
  const marker = args.match(/ --?profile /u);
  if (!marker || marker.index === undefined) return null;
  let value = args.slice(marker.index + marker[0].length).trim();
  for (const terminator of [" org.mozilla.", " --"]) {
    const index = value.indexOf(terminator);
    if (index !== -1) value = value.slice(0, index).trim();
  }
  return value.length > 0 ? value : null;
}
