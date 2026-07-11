import { sha256Canonical } from "./domain/digest.js";
import { stateDir } from "./paths.js";
import {
  createPrivateJsonExclusive,
  ensurePrivateDirectory,
  privatePath,
  readPrivateJson,
  removePrivateFile,
  replacePrivateJson
} from "./private-store.js";
import { acquireNativeProfileControl } from "./closed-session-control.js";
import { acquireExclusiveFileControl } from "./exclusive-control.js";
import { captureControlledSessionSnapshot, captureSessionSnapshot } from "./session-snapshot.js";
import {
  captureManagedZenLifecycleBinding,
  defineManagedZenLifecycleBinding,
  quitManagedZen,
  relaunchManagedZen,
  verifyOrRestoreManagedZenRelaunch
} from "./managed-zen-lifecycle.js";

import type { ZtsConfig } from "./config.js";
import type { ProfileContext } from "./profile.js";
import { profilePathsMatch } from "./profile.js";
import type { ControlledSessionCapture, SessionSnapshotCapture } from "./session-snapshot.js";
import type {
  ManagedZenLifecycleBinding,
  ManagedZenLifecycleRequest,
  ManagedZenLifecycleWaitOptions,
  ManagedZenPlatform
} from "./managed-zen-lifecycle.js";

const MARKER_SCHEMA = "zts.managed-authoritative-capture.provisional-1" as const;

interface ManagedCaptureMarker {
  readonly schemaVersion: typeof MARKER_SCHEMA;
  readonly profileId: string;
  readonly phase: "prepared" | "closed";
  readonly binding: ManagedZenLifecycleBinding;
  readonly revision: `sha256:${string}`;
}

export interface ManagedAuthoritativeCaptureOptions {
  readonly platform: ManagedZenPlatform;
  readonly request?: ManagedZenLifecycleRequest;
  readonly waitOptions: ManagedZenLifecycleWaitOptions;
  readonly afterMarker?: () => void | Promise<void>;
  readonly afterQuit?: () => void | Promise<void>;
  readonly afterCapture?: () => void | Promise<void>;
}

export interface ManagedCaptureEvidence {
  readonly requested: boolean;
  readonly performed: boolean;
  readonly quit: "not_needed" | "verified";
  readonly relaunch: "not_needed" | "verified";
  readonly lifecycleBindingRevision: `sha256:${string}` | null;
  readonly relaunchedBindingRevision: `sha256:${string}` | null;
}

type ManagedCapturedSession = ControlledSessionCapture | SessionSnapshotCapture;

export class ManagedCaptureRecoveryRequiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ManagedCaptureRecoveryRequiredError";
  }
}

export async function runManagedAuthoritativeCapture<T>(
  context: ProfileContext,
  config: ZtsConfig,
  options: ManagedAuthoritativeCaptureOptions,
  operation: (captured: ManagedCapturedSession) => Promise<T>
): Promise<{ readonly captured: ManagedCapturedSession; readonly value: T; readonly lifecycle: ManagedCaptureEvidence }> {
  const control = await acquireExclusiveFileControl(
    await managedCaptureControlPath(context.profile.id),
    "Managed authoritative Snapshot capture",
    { timeoutSeconds: 15 }
  );
  try {
    return await runManagedAuthoritativeCaptureOwned(context, config, options, operation);
  } finally {
    await control.release();
  }
}

async function runManagedAuthoritativeCaptureOwned<T>(
  context: ProfileContext,
  config: ZtsConfig,
  options: ManagedAuthoritativeCaptureOptions,
  operation: (captured: ManagedCapturedSession) => Promise<T>
): Promise<{ readonly captured: ManagedCapturedSession; readonly value: T; readonly lifecycle: ManagedCaptureEvidence }> {
  if (await recoverManagedAuthoritativeCaptureOwned(context, options)) {
    throw new ManagedCaptureRecoveryRequiredError(
      "Recovered an interrupted managed Snapshot capture and restored Zen; rerun the exact Diff Plan command"
    );
  }
  if (!context.running) {
    const captured = await captureSessionSnapshot(context, config, { requireAuthoritative: true });
    return {
      captured,
      value: await operation(captured),
      lifecycle: {
        requested: true,
        performed: false,
        quit: "not_needed",
        relaunch: "not_needed",
        lifecycleBindingRevision: null,
        relaunchedBindingRevision: null
      }
    };
  }

  if (!options.request) throw new Error("Managed Snapshot capture requires an exact running Zen request");
  const binding = await captureManagedZenLifecycleBinding(options.platform, options.request);
  if (!profilePathsMatch(binding.profilePath, context.profile.path)) {
    throw new Error("Managed Snapshot capture binding belongs to a different Profile");
  }
  const markerPath = await managedCaptureMarkerPath(context.profile.id);
  await createPrivateJsonExclusive(markerPath, createMarker(context.profile.id, "prepared", binding));
  await options.afterMarker?.();
  let nativeControl: Awaited<ReturnType<typeof acquireNativeProfileControl>> | null = null;
  let relaunched: ManagedZenLifecycleBinding | null = null;
  try {
    await quitManagedZen(options.platform, binding, options.waitOptions);
    await replacePrivateJson(markerPath, createMarker(context.profile.id, "closed", binding));
    await options.afterQuit?.();
    nativeControl = await acquireNativeProfileControl(context, 0);
    await nativeControl.assertHeld();
    const captured = await captureControlledSessionSnapshot(context, nativeControl, config);
    await options.afterCapture?.();
    const value = await operation(captured);
    await nativeControl.release();
    nativeControl = null;
    relaunched = await relaunchManagedZen(options.platform, binding, options.waitOptions);
    await removePrivateFile(markerPath);
    return {
      captured,
      value,
      lifecycle: {
        requested: true,
        performed: true,
        quit: "verified",
        relaunch: "verified",
        lifecycleBindingRevision: binding.revision,
        relaunchedBindingRevision: relaunched.revision
      }
    };
  } catch (error) {
    if (nativeControl) {
      try { await nativeControl.release(); } catch { /* marker remains authoritative */ }
    }
    if (!relaunched) {
      try {
        relaunched = await relaunchManagedZen(options.platform, binding, options.waitOptions);
      } catch (relaunchError) {
        throw new ManagedCaptureRecoveryRequiredError(
          `${error instanceof Error ? error.message : String(error)}; Zen restoration remains pending: ${relaunchError instanceof Error ? relaunchError.message : String(relaunchError)}`
        );
      }
    }
    await removePrivateFile(markerPath);
    throw error;
  }
}

export async function recoverManagedAuthoritativeCapture(
  context: ProfileContext,
  options: Pick<ManagedAuthoritativeCaptureOptions, "platform" | "request" | "waitOptions">
): Promise<boolean> {
  const control = await acquireExclusiveFileControl(
    await managedCaptureControlPath(context.profile.id),
    "Managed authoritative Snapshot recovery",
    { timeoutSeconds: 15 }
  );
  try {
    return await recoverManagedAuthoritativeCaptureOwned(context, options);
  } finally {
    await control.release();
  }
}

async function recoverManagedAuthoritativeCaptureOwned(
  context: ProfileContext,
  options: Pick<ManagedAuthoritativeCaptureOptions, "platform" | "request" | "waitOptions">
): Promise<boolean> {
  const markerPath = await managedCaptureMarkerPath(context.profile.id);
  let value: unknown;
  try {
    value = await readPrivateJson(markerPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  const marker = defineMarker(value, context.profile.id);
  const processes = await options.platform.listProcesses();
  if (processes.length === 0) {
    await relaunchManagedZen(options.platform, marker.binding, options.waitOptions);
    await removePrivateFile(markerPath);
    return true;
  }
  const current = await captureManagedZenLifecycleBinding(options.platform, {
    profilePath: marker.binding.profilePath,
    executablePath: marker.binding.executablePath,
    uid: marker.binding.uid,
    bundleIdentifier: marker.binding.bundleIdentifier
  });
  if (current.revision !== marker.binding.revision) {
    await verifyOrRestoreManagedZenRelaunch(
      options.platform,
      marker.binding,
      current,
      options.waitOptions
    );
  }
  await removePrivateFile(markerPath);
  return true;
}

async function managedCaptureMarkerPath(profileId: string): Promise<string> {
  const root = await ensurePrivateDirectory(stateDir(), "managed-captures");
  return privatePath(root, `profile-${sha256Canonical({ profileId }).slice("sha256:".length)}.json`);
}

async function managedCaptureControlPath(profileId: string): Promise<string> {
  const root = await ensurePrivateDirectory(stateDir(), "managed-captures");
  return privatePath(root, `profile-${sha256Canonical({ profileId }).slice("sha256:".length)}.control.lock`);
}

function createMarker(
  profileId: string,
  phase: ManagedCaptureMarker["phase"],
  binding: ManagedZenLifecycleBinding
): ManagedCaptureMarker {
  const content = { schemaVersion: MARKER_SCHEMA, profileId, phase, binding };
  return { ...content, revision: sha256Canonical(content) };
}

function defineMarker(value: unknown, profileId: string): ManagedCaptureMarker {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Managed Snapshot capture marker must be an object");
  }
  const keys = Object.keys(value).sort();
  const expected = ["schemaVersion", "profileId", "phase", "binding", "revision"].sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw new Error("Managed Snapshot capture marker contains unknown or missing fields");
  }
  const marker = value as ManagedCaptureMarker;
  if (marker.schemaVersion !== MARKER_SCHEMA
    || marker.profileId !== profileId
    || !["prepared", "closed"].includes(marker.phase)) {
    throw new Error("Managed Snapshot capture marker identity is invalid");
  }
  const binding = defineManagedZenLifecycleBinding(marker.binding);
  const { revision: _revision, ...content } = marker;
  if (sha256Canonical(content) !== marker.revision) {
    throw new Error("Managed Snapshot capture marker revision is invalid");
  }
  return { ...marker, binding };
}
