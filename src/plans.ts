import { sha256Canonical } from "./domain/digest.js";
import { definePlan, definePlanForSnapshot } from "./domain/change.js";
import { stateDir } from "./paths.js";
import { ensurePrivateDirectory, privatePath, publishPrivateJson, readPrivateJson, replacePrivateJson } from "./private-store.js";

import type { Plan } from "./domain/change.js";
import type { ArtifactReference, Snapshot } from "./domain/snapshot.js";
import type { Sha256Digest } from "./domain/digest.js";

const ARTIFACT_SCHEMA = "zts.plan-artifact.provisional-1" as const;
const POINTER_SCHEMA = "zts.plan-pointer.provisional-1" as const;

interface PlanArtifactEnvelope {
  readonly schemaVersion: typeof ARTIFACT_SCHEMA;
  readonly requestRevision: Sha256Digest;
  readonly plan: Plan;
}

interface PlanPointer {
  readonly schemaVersion: typeof POINTER_SCHEMA;
  readonly planId: string;
  readonly planDigest: Sha256Digest;
  readonly requestRevision: Sha256Digest;
  readonly updatedAt: string;
}

export interface StoredPlan {
  readonly plan: Plan;
  readonly requestRevision: Sha256Digest;
  readonly artifact: ArtifactReference;
}

export interface ResolvedPlan extends StoredPlan {
  readonly resolution: "created" | "reused_latest";
}

export type PlanReuseErrorCode = "PLAN_PREVIEW_REQUIRED" | "PLAN_SNAPSHOT_DRIFT" | "PLAN_EXPIRED";

export class PlanReuseError extends Error {
  readonly code: PlanReuseErrorCode;
  readonly storedPlan: StoredPlan | null;
  readonly currentSnapshotRevision: Sha256Digest;

  constructor(
    code: PlanReuseErrorCode,
    message: string,
    currentSnapshotRevision: Sha256Digest,
    storedPlan: StoredPlan | null
  ) {
    super(message);
    this.name = "PlanReuseError";
    this.code = code;
    this.currentSnapshotRevision = currentSnapshotRevision;
    this.storedPlan = storedPlan;
  }
}

export async function resolveOrCreatePlan(
  snapshot: Snapshot,
  requestRevision: Sha256Digest,
  create: () => Plan,
  now = new Date(),
  policy: "create_or_reuse" | "require_existing" = "create_or_reuse"
): Promise<ResolvedPlan> {
  assertDigest(requestRevision, "Plan request revision");
  const layout = await planLayout(snapshot.profile.id);
  const requestPointerPath = privatePath(layout.requests, `${digestHex(requestRevision)}.json`);
  const existing = await readPointerIfPresent(requestPointerPath);
  if (existing && existing.requestRevision === requestRevision) {
    const stored = await readStoredPlan(layout, existing.planDigest);
    if (stored.requestRevision !== requestRevision || stored.plan.profileId !== snapshot.profile.id) {
      throw new Error("Stored Plan request or Profile binding does not match its pointer");
    }
    if (
      stored.plan.snapshotRevision !== snapshot.revision
      || stored.plan.snapshotAuthority !== snapshot.authority
      || stored.plan.snapshotFreshness !== snapshot.freshness
    ) {
      if (policy === "require_existing") {
        throw new PlanReuseError(
          "PLAN_SNAPSHOT_DRIFT",
          `Snapshot Drift: reviewed Plan ${stored.plan.digest} binds ${stored.plan.snapshotRevision}, current Snapshot is ${snapshot.revision}`,
          snapshot.revision,
          stored
        );
      }
    } else if (Date.parse(stored.plan.expiresAt) <= now.getTime()) {
      if (policy === "require_existing") {
        throw new PlanReuseError(
          "PLAN_EXPIRED",
          `Reviewed Plan ${stored.plan.digest} expired at ${stored.plan.expiresAt}; create a fresh preview`,
          snapshot.revision,
          stored
        );
      }
    } else {
      definePlanForSnapshot(snapshot, stored.plan);
      return { ...stored, resolution: "reused_latest" };
    }
  }

  if (policy === "require_existing") {
    throw new PlanReuseError(
      "PLAN_PREVIEW_REQUIRED",
      "No matching reviewed Plan exists; create a preview before requesting dry-run or apply",
      snapshot.revision,
      null
    );
  }

  const plan = definePlanForSnapshot(snapshot, create());
  const stored = await storePlan(layout, requestRevision, plan, now);
  return { ...stored, resolution: "created" };
}

export async function loadStoredPlan(profileId: string, selector: string): Promise<StoredPlan> {
  const layout = await planLayout(profileId);
  const pointer = selector === "latest"
    ? await readPointer(privatePath(layout.root, "latest.json"))
    : selector.startsWith("sha256:")
      ? null
      : await readPointer(privatePath(layout.ids, `${digestHex(sha256Canonical({ planId: selector }))}.json`));
  const digest = pointer?.planDigest ?? selector as Sha256Digest;
  assertDigest(digest, "Plan selector digest");
  const stored = await readStoredPlan(layout, digest);
  if (pointer && (pointer.planId !== stored.plan.id || pointer.requestRevision !== stored.requestRevision)) {
    throw new Error("Plan pointer does not match its stored Plan artifact");
  }
  return stored;
}

async function storePlan(
  layout: PlanLayout,
  requestRevision: Sha256Digest,
  plan: Plan,
  now: Date
): Promise<StoredPlan> {
  const envelope: PlanArtifactEnvelope = {
    schemaVersion: ARTIFACT_SCHEMA,
    requestRevision,
    plan
  };
  const objectPath = privatePath(layout.objects, `${digestHex(plan.digest)}.json`);
  await publishPrivateJson(objectPath, envelope);
  const pointer: PlanPointer = {
    schemaVersion: POINTER_SCHEMA,
    planId: plan.id,
    planDigest: plan.digest,
    requestRevision,
    updatedAt: canonicalTimestamp(now)
  };
  await replacePrivateJson(privatePath(layout.requests, `${digestHex(requestRevision)}.json`), pointer);
  await replacePrivateJson(privatePath(layout.ids, `${digestHex(sha256Canonical({ planId: plan.id }))}.json`), pointer);
  await replacePrivateJson(privatePath(layout.root, "latest.json"), pointer);
  return storedPlan(envelope);
}

async function readStoredPlan(layout: PlanLayout, digest: Sha256Digest): Promise<StoredPlan> {
  const value = await readPrivateJson(privatePath(layout.objects, `${digestHex(digest)}.json`));
  const envelope = defineArtifactEnvelope(value);
  if (envelope.plan.digest !== digest) throw new Error("Plan artifact filename does not match its Plan digest");
  definePlan(envelope.plan);
  return storedPlan(envelope);
}

function storedPlan(envelope: PlanArtifactEnvelope): StoredPlan {
  return {
    plan: envelope.plan,
    requestRevision: envelope.requestRevision,
    artifact: { id: envelope.plan.id, digest: envelope.plan.digest }
  };
}

interface PlanLayout {
  readonly root: string;
  readonly objects: string;
  readonly requests: string;
  readonly ids: string;
}

async function planLayout(profileId: string): Promise<PlanLayout> {
  if (!profileId.trim()) throw new Error("Plan store requires a non-empty Profile id");
  const profileKey = `profile-${digestHex(sha256Canonical({ profileId }))}`;
  const root = await ensurePrivateDirectory(stateDir(), "plans", profileKey);
  const objects = await ensurePrivateDirectory(root, "objects");
  const requests = await ensurePrivateDirectory(root, "requests");
  const ids = await ensurePrivateDirectory(root, "ids");
  return { root, objects, requests, ids };
}

async function readPointerIfPresent(path: string): Promise<PlanPointer | null> {
  try {
    return await readPointer(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function readPointer(path: string): Promise<PlanPointer> {
  const value = await readPrivateJson(path);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Plan pointer must be an object");
  assertExactKeys(value, ["schemaVersion", "planId", "planDigest", "requestRevision", "updatedAt"], "Plan pointer");
  const pointer = value as unknown as PlanPointer;
  if (pointer.schemaVersion !== POINTER_SCHEMA || !pointer.planId.trim()) throw new Error("Plan pointer has invalid identity");
  assertDigest(pointer.planDigest, "Plan pointer digest");
  assertDigest(pointer.requestRevision, "Plan pointer request revision");
  assertTimestamp(pointer.updatedAt, "Plan pointer timestamp");
  return pointer;
}

function defineArtifactEnvelope(value: unknown): PlanArtifactEnvelope {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Plan artifact must be an object");
  assertExactKeys(value, ["schemaVersion", "requestRevision", "plan"], "Plan artifact");
  const envelope = value as unknown as PlanArtifactEnvelope;
  if (envelope.schemaVersion !== ARTIFACT_SCHEMA) throw new Error("Plan artifact has an unsupported schema");
  assertDigest(envelope.requestRevision, "Plan artifact request revision");
  return envelope;
}

function digestHex(digest: string): string {
  assertDigest(digest, "Digest path key");
  return digest.slice("sha256:".length);
}

function canonicalTimestamp(date: Date): string {
  if (!Number.isFinite(date.getTime())) throw new Error("Plan store timestamp is invalid");
  return date.toISOString();
}

function assertTimestamp(value: string, label: string): void {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) {
    throw new Error(`${label} must be a canonical UTC ISO timestamp`);
  }
}

function assertDigest(value: string, label: string): asserts value is Sha256Digest {
  if (!/^sha256:[a-f0-9]{64}$/.test(value)) throw new Error(`${label} must be a canonical SHA-256 digest`);
}

function assertExactKeys(value: object, expected: readonly string[], label: string): void {
  const keys = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (keys.length !== wanted.length || keys.some((key, index) => key !== wanted[index])) {
    throw new Error(`${label} contains unknown or missing fields`);
  }
}
