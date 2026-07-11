import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { sha256Canonical } from "./domain/digest.js";
import { acquireExclusiveFileControl } from "./exclusive-control.js";
import { findZenProcesses } from "./processes.js";
import { assertProfileIdentity, zenProcessMayOwnProfile } from "./profile.js";
import { currentProcessOwner } from "./process-owner.js";

import type { Sha256Digest } from "./domain/digest.js";
import type { ExclusiveFileControl } from "./exclusive-control.js";
import type { ProfileContext, ZenProfile } from "./profile.js";

const NATIVE_CONTROL_SCHEMA = "zts.native-profile-control.provisional-1" as const;

export class NativeProfileControlUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NativeProfileControlUnavailableError";
  }
}

export interface NativeProfileControlProof {
  readonly schemaVersion: typeof NATIVE_CONTROL_SCHEMA;
  readonly leaseId: string;
  readonly profileId: string;
  readonly profilePathRevision: Sha256Digest;
  readonly lockPathRevision: Sha256Digest;
  readonly lockIdentity: ExclusiveFileControl["identity"];
  readonly primitive: "darwin_lockf_gecko_compatible";
  readonly owner: Awaited<ReturnType<typeof currentProcessOwner>>;
  readonly acquiredAt: string;
  readonly processCheckedAt: string;
}

export interface NativeProfileControl {
  readonly proof: NativeProfileControlProof;
  assertHeld(): Promise<void>;
  release(): Promise<void>;
}

interface ActiveNativeProfileControl {
  readonly profile: ZenProfile;
  readonly kernelControl: ExclusiveFileControl;
  readonly proof: NativeProfileControlProof;
  released: boolean;
}

const activeNativeProfileControls = new WeakMap<NativeProfileControl, ActiveNativeProfileControl>();

/** Acquires Gecko's own macOS `.parentlock`, preventing Zen from opening the Profile. */
export async function acquireNativeProfileControl(
  context: ProfileContext,
  timeoutSeconds = 0
): Promise<NativeProfileControl> {
  assertProfileIdentity(context.profile);
  const lockPath = join(context.profile.path, ".parentlock");
  const kernelControl = await acquireExclusiveFileControl(
    lockPath,
    `Native Zen Profile control for ${context.profile.id}`,
    { timeoutSeconds, fileKind: "native_profile" }
  );
  try {
    await assertNoZenOwner(context.profile);
    const processCheckedAt = new Date().toISOString();
    const proof: NativeProfileControlProof = {
      schemaVersion: NATIVE_CONTROL_SCHEMA,
      leaseId: randomUUID(),
      profileId: context.profile.id,
      profilePathRevision: sha256Canonical({ profilePath: context.profile.path }),
      lockPathRevision: sha256Canonical({ profileId: context.profile.id, lockPath }),
      lockIdentity: kernelControl.identity,
      primitive: "darwin_lockf_gecko_compatible",
      owner: await currentProcessOwner(),
      acquiredAt: new Date().toISOString(),
      processCheckedAt
    };
    const state: ActiveNativeProfileControl = {
      profile: context.profile,
      kernelControl,
      proof,
      released: false
    };
    const control: NativeProfileControl = {
      proof,
      async assertHeld() {
        await assertNativeProfileControl(control, context.profile);
      },
      async release() {
        if (state.released) throw new Error("Native Zen Profile control has already been released");
        try {
          await kernelControl.release();
        } finally {
          state.released = true;
          activeNativeProfileControls.delete(control);
        }
      }
    };
    activeNativeProfileControls.set(control, state);
    return control;
  } catch (error) {
    await kernelControl.release().catch(() => undefined);
    throw error;
  }
}

export async function assertNativeProfileControl(
  control: NativeProfileControl,
  profile: ZenProfile
): Promise<NativeProfileControlProof> {
  const state = activeNativeProfileControls.get(control);
  if (!state || state.released) {
    throw new Error("Authoritative closed-session Snapshot requires an active native Profile control lease");
  }
  if (state.profile.id !== profile.id || state.proof.profileId !== profile.id) {
    throw new Error("Native Profile control lease belongs to a different Profile");
  }
  await state.kernelControl.assertHeld();
  await assertNoZenOwner(profile);
  return state.proof;
}

async function assertNoZenOwner(profile: ZenProfile): Promise<void> {
  const processes = await findZenProcesses();
  if (processes.some((process) => zenProcessMayOwnProfile(process, profile))) {
    throw new NativeProfileControlUnavailableError(
      "Zen owns or may own the target Profile despite native Profile control"
    );
  }
}
