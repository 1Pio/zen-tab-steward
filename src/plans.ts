import { constants, type Stats } from "node:fs";
import { lstat, open, opendir, statfs } from "node:fs/promises";
import { basename } from "node:path";
import { sha256Canonical } from "./domain/digest.js";
import { createPlan, definePlanForSnapshot } from "./domain/change.js";
import { defineSnapshot } from "./domain/snapshot.js";
import { stateDir } from "./paths.js";
import { readApplyArtifactLayout } from "./apply-artifacts.js";
import { defineApplyJournal } from "./apply-journal.js";
import { readApplyUnfinishedMarkers } from "./apply-unfinished-store.js";
import { acquireExclusiveFileControl } from "./exclusive-control.js";
import {
  assertPrivateDirectory,
  ensurePrivateDirectory,
  inspectPrivateStandaloneTemporaryCandidate,
  isPrivateTemporaryBasename,
  privatePath,
  publishPrivateBytes,
  readPrivateBytes,
  readPrivateJson,
  reconcilePrivatePublication,
  removePrivateFile,
  removePrivateStandaloneTemporaryCandidate,
  replacePrivateJson
} from "./private-store.js";

import type { Plan } from "./domain/change.js";
import type { ArtifactReference, Snapshot } from "./domain/snapshot.js";
import type { Sha256Digest } from "./domain/digest.js";

const ARTIFACT_SCHEMA = "zts.plan-artifact.provisional-2" as const;
const POINTER_SCHEMA = "zts.plan-pointer.provisional-1" as const;
const PLAN_OBJECT_MAX_BYTES = 128 * 1024 * 1024;
const PLAN_POINTER_MAX_BYTES = 16 * 1024;
const PLAN_STORE_MAX_BYTES = 1024 * 1024 * 1024;
const PLAN_STORE_MINIMUM_FREE_BYTES = 512 * 1024 * 1024;
const PLAN_STORE_MAX_OBJECTS = 2_048;
const PLAN_STORE_MAX_POINTERS_PER_INDEX = 4_096;
const PLAN_UNREFERENCED_RETENTION_MS = 24 * 60 * 60 * 1000;
const PLAN_APPLY_REFERENCE_SCAN_LIMIT = 50_000;

export interface PlanStorePolicy {
  readonly maxStoreBytes: number;
  readonly minimumFreeBytes: number;
  readonly maxObjects: number;
  readonly unreferencedRetentionMs: number;
}

export const DEFAULT_PLAN_STORE_POLICY: PlanStorePolicy = Object.freeze({
  maxStoreBytes: PLAN_STORE_MAX_BYTES,
  minimumFreeBytes: PLAN_STORE_MINIMUM_FREE_BYTES,
  maxObjects: PLAN_STORE_MAX_OBJECTS,
  unreferencedRetentionMs: PLAN_UNREFERENCED_RETENTION_MS
});

interface PlanArtifactEnvelope {
  readonly schemaVersion: typeof ARTIFACT_SCHEMA;
  readonly requestRevision: Sha256Digest;
  readonly snapshot: Snapshot;
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
  readonly snapshot: Snapshot;
  readonly plan: Plan;
  readonly requestRevision: Sha256Digest;
  readonly artifact: ArtifactReference;
}

export interface ResolvedPlan extends StoredPlan {
  readonly resolution: "created" | "reused_latest";
}

export interface PlanStorePublicationHooks {
  /** Internal fault-injection hook after the immutable Plan object is durable. */
  readonly afterObjectPublication?: () => void | Promise<void>;
  /** Internal fault-injection hook after the request pointer is durable. */
  readonly afterRequestPointerPublication?: () => void | Promise<void>;
  /** Internal fault-injection hook after the Plan-id pointer is durable. */
  readonly afterIdPointerPublication?: () => void | Promise<void>;
  /** Internal fault-injection hook after the latest pointer is durable. */
  readonly afterLatestPointerPublication?: () => void | Promise<void>;
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
  policy: "create_or_reuse" | "create_if_missing_require_existing_state" | "require_existing" = "create_or_reuse",
  storePolicy: PlanStorePolicy = DEFAULT_PLAN_STORE_POLICY,
  hooks: PlanStorePublicationHooks = {}
): Promise<ResolvedPlan> {
  assertDigest(requestRevision, "Plan request revision");
  const layout = await ensurePlanLayout(snapshot.profile.id);
  return withPlanStoreControl(layout, async () => {
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
        if (policy !== "create_or_reuse") {
          throw new PlanReuseError(
            "PLAN_SNAPSHOT_DRIFT",
            `Snapshot Drift: reviewed Plan ${stored.plan.digest} binds ${stored.plan.snapshotRevision}, current Snapshot is ${snapshot.revision}`,
            snapshot.revision,
            stored
          );
        }
      } else if (Date.parse(stored.plan.expiresAt) <= now.getTime()) {
        if (policy !== "create_or_reuse") {
          throw new PlanReuseError(
            "PLAN_EXPIRED",
            `Reviewed Plan ${stored.plan.digest} expired at ${stored.plan.expiresAt}; create a fresh preview`,
            snapshot.revision,
            stored
          );
        }
      } else {
        definePlanForSnapshot(snapshot, stored.plan);
        await repairPlanPointerSet(layout, stored, existing, now, storePolicy, hooks);
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
    const stored = await storePlanControlled(
      layout,
      requestRevision,
      snapshot,
      plan,
      now,
      storePolicy,
      hooks
    );
    return { ...stored, resolution: "created" };
  });
}

export async function loadStoredPlan(profileId: string, selector: string): Promise<StoredPlan> {
  const layout = await readPlanLayout(profileId);
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

/**
 * Makes a reviewed system-owned Plan recoverable without publishing it as a
 * user-selectable request/id/latest Plan. Inverse Plans use this path so a
 * crash can reload the exact digest while generic `zts apply` cannot discover
 * or execute them by a friendly pointer.
 */
export async function publishDetachedPlanObject(
  snapshot: Snapshot,
  plan: Plan,
  requestRevision: Sha256Digest,
  now = new Date(),
  policy: PlanStorePolicy = DEFAULT_PLAN_STORE_POLICY
): Promise<StoredPlan> {
  assertDigest(requestRevision, "Detached Plan request revision");
  definePlanForSnapshot(snapshot, plan);
  const layout = await ensurePlanLayout(snapshot.profile.id);
  return withPlanStoreControl(layout, async () => {
    const envelope: PlanArtifactEnvelope = {
      schemaVersion: ARTIFACT_SCHEMA,
      requestRevision,
      snapshot,
      plan
    };
    const envelopeBytes = encodePlanEnvelope(envelope);
    await maintainPlanStore(layout, plan.profileId, envelope, envelopeBytes, now, policy);
    await publishPrivateBytes(
      privatePath(layout.objects, `${digestHex(plan.digest)}.json`),
      envelopeBytes,
      PLAN_OBJECT_MAX_BYTES
    );
    return storedPlan(envelope);
  });
}

export async function deriveAndStoreSubsetPlan(
  snapshot: Snapshot,
  parent: Plan,
  requestedActionIds: readonly string[],
  now = new Date()
): Promise<StoredPlan> {
  definePlanForSnapshot(snapshot, parent);
  if (parent.source.kind === "inverse") {
    throw new Error("Inverse Plans cannot be subset or applied outside their Receipt-bound Undo flow");
  }
  if (Date.parse(parent.expiresAt) <= now.getTime()) throw new Error(`Plan ${parent.digest} has expired`);
  if (requestedActionIds.length === 0) throw new Error("Selected apply requires at least one action id");
  if (new Set(requestedActionIds).size !== requestedActionIds.length) throw new Error("Selected action ids must be unique");
  const requested = new Set(requestedActionIds);
  const executable = new Map(
    parent.actions
      .filter((action) => action.disposition === "move")
      .map((action) => [action.actionId, action] as const)
  );
  for (const actionId of requested) {
    if (!executable.has(actionId)) throw new Error(`Selected action id is not executable in Plan ${parent.id}: ${actionId}`);
  }
  const actions = parent.actions.filter((action) => requested.has(action.actionId));
  const selectedActionIds = actions.map((action) => action.actionId) as [string, ...string[]];
  const intentRevision = sha256Canonical({
    kind: "subset",
    parentPlanId: parent.id,
    parentPlanDigest: parent.digest,
    selectedActionIds
  });
  const source = parent.source.kind === "engine"
    ? { kind: "engine" as const, engine: parent.source.engine, intentRevision }
    : { kind: "manual_patch" as const, intentRevision };
  const plan = createPlan(snapshot, {
    schemaVersion: "zts.plan.provisional-1",
    id: `plan:subset:${digestHex(intentRevision).slice(0, 20)}`,
    configRevision: parent.configRevision,
    engineManifestRevision: parent.engineManifestRevision,
    createdAt: parent.createdAt,
    expiresAt: parent.expiresAt,
    derivation: {
      kind: "subset",
      parentPlanId: parent.id,
      parentPlanDigest: parent.digest,
      selectedActionIds
    },
    source,
    actions
  });
  const layout = await ensurePlanLayout(snapshot.profile.id);
  return storePlan(layout, intentRevision, snapshot, plan, now, DEFAULT_PLAN_STORE_POLICY);
}

async function storePlan(
  layout: PlanLayout,
  requestRevision: Sha256Digest,
  snapshot: Snapshot,
  plan: Plan,
  now: Date,
  policy: PlanStorePolicy,
  hooks: PlanStorePublicationHooks = {}
): Promise<StoredPlan> {
  return withPlanStoreControl(layout, () => storePlanControlled(
    layout,
    requestRevision,
    snapshot,
    plan,
    now,
    policy,
    hooks
  ));
}

async function storePlanControlled(
  layout: PlanLayout,
  requestRevision: Sha256Digest,
  snapshot: Snapshot,
  plan: Plan,
  now: Date,
  policy: PlanStorePolicy,
  hooks: PlanStorePublicationHooks
): Promise<StoredPlan> {
  definePlanForSnapshot(snapshot, plan);
  const envelope: PlanArtifactEnvelope = {
    schemaVersion: ARTIFACT_SCHEMA,
    requestRevision,
    snapshot,
    plan
  };
  const envelopeBytes = encodePlanEnvelope(envelope);
  const objectPath = privatePath(layout.objects, `${digestHex(plan.digest)}.json`);
  const pointer: PlanPointer = {
    schemaVersion: POINTER_SCHEMA,
    planId: plan.id,
    planDigest: plan.digest,
    requestRevision,
    updatedAt: canonicalTimestamp(now)
  };
  await maintainPlanStore(layout, plan.profileId, envelope, envelopeBytes, now, policy);
  await publishPrivateBytes(objectPath, envelopeBytes, PLAN_OBJECT_MAX_BYTES);
  await hooks.afterObjectPublication?.();
  await replacePrivateJson(privatePath(layout.requests, `${digestHex(requestRevision)}.json`), pointer);
  await hooks.afterRequestPointerPublication?.();
  await replacePrivateJson(privatePath(layout.ids, `${digestHex(sha256Canonical({ planId: plan.id }))}.json`), pointer);
  await hooks.afterIdPointerPublication?.();
  await replacePrivateJson(privatePath(layout.root, "latest.json"), pointer);
  await hooks.afterLatestPointerPublication?.();
  return storedPlan(envelope);
}

async function repairPlanPointerSet(
  layout: PlanLayout,
  stored: StoredPlan,
  requestPointer: PlanPointer,
  now: Date,
  policy: PlanStorePolicy,
  hooks: PlanStorePublicationHooks
): Promise<void> {
  const envelope: PlanArtifactEnvelope = {
    schemaVersion: ARTIFACT_SCHEMA,
    requestRevision: stored.requestRevision,
    snapshot: stored.snapshot,
    plan: stored.plan
  };
  await maintainPlanStore(layout, stored.plan.profileId, envelope, null, now, policy);
  const currentRequest = await readPointer(privatePath(
    layout.requests,
    `${digestHex(stored.requestRevision)}.json`
  ));
  if (!samePointerBinding(currentRequest, requestPointer)) {
    throw new Error("Plan request pointer changed while its publication was being repaired");
  }
  const idPath = privatePath(layout.ids, `${digestHex(sha256Canonical({ planId: stored.plan.id }))}.json`);
  const currentId = await readPointerIfPresent(idPath);
  if (currentId && !samePointerBinding(currentId, requestPointer)) {
    throw new Error("Plan id pointer conflicts with the reviewed Plan publication");
  }
  if (!currentId) {
    await replacePrivateJson(idPath, requestPointer);
    await hooks.afterIdPointerPublication?.();
  }
  const latestPath = privatePath(layout.root, "latest.json");
  const currentLatest = await readPointerIfPresent(latestPath);
  const interruptedLatest = !currentLatest
    || (!samePointerBinding(currentLatest, requestPointer)
      && currentLatest.updatedAt < requestPointer.updatedAt);
  if (interruptedLatest) {
    await replacePrivateJson(latestPath, requestPointer);
    await hooks.afterLatestPointerPublication?.();
  }
}

function samePointerBinding(left: PlanPointer, right: PlanPointer): boolean {
  return left.planId === right.planId
    && left.planDigest === right.planDigest
    && left.requestRevision === right.requestRevision;
}

async function readStoredPlan(layout: PlanLayout, digest: Sha256Digest): Promise<StoredPlan> {
  const value = decodePlanEnvelope(await readPrivateBytes(
    privatePath(layout.objects, `${digestHex(digest)}.json`),
    PLAN_OBJECT_MAX_BYTES
  ));
  const envelope = defineArtifactEnvelope(value);
  if (envelope.plan.digest !== digest) throw new Error("Plan artifact filename does not match its Plan digest");
  defineSnapshot(envelope.snapshot);
  definePlanForSnapshot(envelope.snapshot, envelope.plan);
  return storedPlan(envelope);
}

function storedPlan(envelope: PlanArtifactEnvelope): StoredPlan {
  return {
    snapshot: envelope.snapshot,
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

async function ensurePlanLayout(profileId: string): Promise<PlanLayout> {
  const profileKey = planProfileKey(profileId);
  const root = await ensurePrivateDirectory(stateDir(), "plans", profileKey);
  return {
    root,
    objects: await ensurePrivateDirectory(root, "objects"),
    requests: await ensurePrivateDirectory(root, "requests"),
    ids: await ensurePrivateDirectory(root, "ids")
  };
}

async function readPlanLayout(profileId: string): Promise<PlanLayout> {
  const profileKey = planProfileKey(profileId);
  const root = await assertPrivateDirectory(stateDir(), "plans", profileKey);
  return {
    root,
    objects: await assertPrivateDirectory(root, "objects"),
    requests: await assertPrivateDirectory(root, "requests"),
    ids: await assertPrivateDirectory(root, "ids")
  };
}

interface PlanStoreObjectInventory {
  readonly digest: Sha256Digest;
  readonly path: string;
  readonly size: number;
  readonly planIdRevision: Sha256Digest;
  readonly requestRevision: Sha256Digest;
  /** The validated semantic boundary after which this Plan cannot enter Apply. */
  readonly expiresAt: string;
  /** Filesystem publication time, independent of semantic Plan chronology. */
  readonly storedAt: string;
}

interface PlanStorePointerInventory {
  readonly path: string;
  readonly planDigest: Sha256Digest;
  readonly planIdRevision: Sha256Digest;
  readonly requestRevision: Sha256Digest;
  readonly size: number;
}

interface PlanStoreInventory {
  readonly objects: readonly PlanStoreObjectInventory[];
  readonly requestPointers: readonly PlanStorePointerInventory[];
  readonly idPointers: readonly PlanStorePointerInventory[];
  readonly latest: { readonly path: string; readonly pointer: PlanPointer; readonly size: number } | null;
  readonly bytes: number;
}

function encodePlanEnvelope(envelope: PlanArtifactEnvelope): Buffer {
  const bytes = Buffer.from(`${JSON.stringify(envelope, null, 2)}\n`, "utf8");
  if (bytes.byteLength < 1 || bytes.byteLength > PLAN_OBJECT_MAX_BYTES) {
    throw new Error(
      `Plan artifact is ${bytes.byteLength} bytes and exceeds the coherent ${PLAN_OBJECT_MAX_BYTES}-byte Snapshot/Plan envelope limit`
    );
  }
  return bytes;
}

function decodePlanEnvelope(bytes: Buffer): unknown {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("Plan artifact is not valid UTF-8");
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error("Plan artifact is not valid JSON");
  }
}

async function withPlanStoreControl<T>(layout: PlanLayout, action: () => Promise<T>): Promise<T> {
  const path = privatePath(layout.root, ".plan-store-control.lock");
  const control = await acquireExclusiveFileControl(path, "Plan store control", { timeoutSeconds: 15 });
  try {
    const before = await lstat(layout.root);
    assertOwnerPrivateDirectory(before, layout.root);
    await control.assertHeld();
    await reconcilePlanStandaloneTemporaries(layout, control.assertHeld);
    const result = await action();
    await control.assertHeld();
    const after = await lstat(layout.root);
    assertOwnerPrivateDirectory(after, layout.root);
    if (before.dev !== after.dev || before.ino !== after.ino) {
      throw new Error("Plan store root changed while its kernel control was held");
    }
    return result;
  } finally {
    await control.release();
  }
}

async function reconcilePlanStandaloneTemporaries(
  layout: PlanLayout,
  assertHeld: () => Promise<void>
): Promise<void> {
  const parents = [
    { path: layout.root, maxEntries: 72, maxBytes: PLAN_POINTER_MAX_BYTES },
    { path: layout.objects, maxEntries: PLAN_STORE_MAX_OBJECTS + 64, maxBytes: PLAN_OBJECT_MAX_BYTES },
    { path: layout.requests, maxEntries: PLAN_STORE_MAX_POINTERS_PER_INDEX + 64, maxBytes: PLAN_POINTER_MAX_BYTES },
    { path: layout.ids, maxEntries: PLAN_STORE_MAX_POINTERS_PER_INDEX + 64, maxBytes: PLAN_POINTER_MAX_BYTES }
  ] as const;
  for (const parent of parents) {
    for (const entry of await readDirectoryNames(parent.path, parent.maxEntries, "Plan temporary reconciliation")) {
      if (!isPrivateTemporaryBasename(entry)) continue;
      const path = privatePath(parent.path, entry);
      const metadata = await lstat(path);
      if (metadata.nlink !== 1) continue;
      const candidate = await inspectPrivateStandaloneTemporaryCandidate(path, parent.maxBytes);
      await assertHeld();
      await removePrivateStandaloneTemporaryCandidate(candidate);
    }
  }
  await assertHeld();
}

async function maintainPlanStore(
  layout: PlanLayout,
  profileId: string,
  incoming: PlanArtifactEnvelope,
  incomingBytes: Buffer | null,
  now: Date,
  requestedPolicy: PlanStorePolicy
): Promise<void> {
  const policy = definePlanStorePolicy(requestedPolicy);
  let inventory = await readPlanStoreInventory(layout, profileId);
  const cutoff = now.getTime() - policy.unreferencedRetentionMs;
  // Publication age alone cannot make a detached Plan disposable. Undo can
  // legitimately materialize the same still-executable Plan long after its
  // immutable object was first published. Its validated expiry is therefore
  // a crash-stable self-pin until Apply can no longer admit it. Once expired,
  // unfinished/history references remain the final retention authority.
  const candidates = inventory.objects.filter((item) =>
    Date.parse(item.storedAt) <= cutoff
    && Date.parse(item.expiresAt) <= now.getTime()
  );
  if (candidates.length > 0) {
    const protectedDigests = await applyReferencedPlanDigests(profileId);
    protectedDigests.add(incoming.plan.digest);
    const removable = candidates
      .filter((item) => !protectedDigests.has(item.digest))
      .sort((left, right) =>
        left.storedAt.localeCompare(right.storedAt)
        || left.digest.localeCompare(right.digest)
      );
    if (removable.length > 0) {
      const deleted = new Set(removable.map((item) => item.digest));
      await removePointersToDigests(inventory, deleted);
      // Pointers disappear before their objects. A crash can therefore leave
      // an unreachable object for the next retention pass, but can never
      // leave a canonical pointer naming an object that was already removed.
      for (const item of removable) await removePrivateFile(item.path);
      inventory = await readPlanStoreInventory(layout, profileId);
    }
  }

  const alreadyStored = inventory.objects.some((item) => item.digest === incoming.plan.digest);
  if (incomingBytes === null && !alreadyStored) {
    throw new Error("Reviewed Plan object disappeared while its pointer set was being repaired");
  }
  const incomingByteLength = incomingBytes?.byteLength ?? 0;
  const objectCount = inventory.objects.length + (alreadyStored ? 0 : 1);
  if (objectCount > policy.maxObjects) {
    throw new Error(
      `Plan store cannot retain ${objectCount} objects under its ${policy.maxObjects}-object cap; applied Plans remain protected until Apply retention archives them`
    );
  }
  const requestPointerPath = privatePath(layout.requests, `${digestHex(incoming.requestRevision)}.json`);
  const idPointerPath = privatePath(layout.ids, `${digestHex(sha256Canonical({ planId: incoming.plan.id }))}.json`);
  const newRequestPointer = inventory.requestPointers.some((item) => item.path === requestPointerPath) ? 0 : 1;
  const newIdPointer = inventory.idPointers.some((item) => item.path === idPointerPath) ? 0 : 1;
  if (inventory.requestPointers.length + newRequestPointer > PLAN_STORE_MAX_POINTERS_PER_INDEX
    || inventory.idPointers.length + newIdPointer > PLAN_STORE_MAX_POINTERS_PER_INDEX) {
    throw new Error("Plan pointer index reached its bounded entry limit after retention");
  }
  const durableGrowth = (alreadyStored ? 0 : incomingByteLength)
    + ((newRequestPointer + newIdPointer + (inventory.latest ? 0 : 1)) * PLAN_POINTER_MAX_BYTES);
  const transientPointerReserve = 3 * PLAN_POINTER_MAX_BYTES;
  const projectedBytes = inventory.bytes + durableGrowth + transientPointerReserve;
  if (!Number.isSafeInteger(projectedBytes) || projectedBytes > policy.maxStoreBytes) {
    throw new Error(
      `Plan store cannot reserve this ${incomingByteLength}-byte reviewed Plan under its ${policy.maxStoreBytes}-byte cap`
    );
  }
  const filesystem = await statfs(layout.root, { bigint: true });
  if (filesystem.bavail < 0n || filesystem.bsize <= 0n) {
    throw new Error("Plan store filesystem free-space accounting is invalid");
  }
  const filesystemReserve = BigInt((alreadyStored ? 0 : incomingByteLength) + transientPointerReserve);
  if (filesystem.bavail * filesystem.bsize < BigInt(policy.minimumFreeBytes) + filesystemReserve) {
    throw new Error("Plan store cannot preserve its configured filesystem free-space floor");
  }
}

async function readPlanStoreInventory(layout: PlanLayout, profileId: string): Promise<PlanStoreInventory> {
  await assertPlanStoreRootShape(layout);
  await reconcilePlanObjectPublications(layout.objects);
  const objects: PlanStoreObjectInventory[] = [];
  let bytes = await boundedPrivateFileSize(privatePath(layout.root, ".plan-store-control.lock"), 64 * 1024);
  for (const entry of await readDirectoryNames(layout.objects, PLAN_STORE_MAX_OBJECTS + 64, "Plan object store")) {
    if (!/^[a-f0-9]{64}\.json$/u.test(entry)) throw new Error(`Plan object store contains an unexpected entry: ${entry}`);
    const path = privatePath(layout.objects, entry);
    const objectBytes = await readPrivateBytes(path, PLAN_OBJECT_MAX_BYTES);
    const envelope = defineArtifactEnvelope(decodePlanEnvelope(objectBytes));
    defineSnapshot(envelope.snapshot);
    definePlanForSnapshot(envelope.snapshot, envelope.plan);
    const digest = `sha256:${entry.slice(0, 64)}` as Sha256Digest;
    if (envelope.plan.profileId !== profileId || envelope.plan.digest !== digest) {
      throw new Error(`Plan object ${entry} does not match its Profile and content address`);
    }
    objects.push({
      digest,
      path,
      size: objectBytes.byteLength,
      // Inventory retains only fixed-size validated identity metadata. The full
      // Snapshot/Plan envelope and its potentially large browser-owned strings
      // become unreachable before the next object is opened.
      planIdRevision: sha256Canonical({ planId: envelope.plan.id }),
      requestRevision: envelope.requestRevision,
      expiresAt: envelope.plan.expiresAt,
      storedAt: await privateFilePublicationTime(path)
    });
    bytes = addPlanStoreBytes(bytes, objectBytes.byteLength);
  }
  const requestPointers = await readPointerInventory(
    layout.requests,
    PLAN_STORE_MAX_POINTERS_PER_INDEX,
    "Plan request pointer store"
  );
  const idPointers = await readPointerInventory(
    layout.ids,
    PLAN_STORE_MAX_POINTERS_PER_INDEX,
    "Plan id pointer store"
  );
  for (const item of [...requestPointers, ...idPointers]) bytes = addPlanStoreBytes(bytes, item.size);
  let latest: PlanStoreInventory["latest"] = null;
  const latestPath = privatePath(layout.root, "latest.json");
  try {
    const pointer = await readPointer(latestPath);
    const size = await boundedPrivateFileSize(latestPath, PLAN_POINTER_MAX_BYTES);
    latest = { path: latestPath, pointer, size };
    bytes = addPlanStoreBytes(bytes, size);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  validatePlanPointers(objects, requestPointers, idPointers, latest);
  return { objects, requestPointers, idPointers, latest, bytes };
}

async function readPointerInventory(
  root: string,
  limit: number,
  label: string
): Promise<PlanStorePointerInventory[]> {
  const pointers = [];
  for (const entry of await readDirectoryNames(root, limit + 64, label)) {
    if (!/^[a-f0-9]{64}\.json$/u.test(entry)) throw new Error(`${label} contains an unexpected entry: ${entry}`);
    const path = privatePath(root, entry);
    const pointer = await readPointer(path);
    pointers.push({
      path,
      planDigest: pointer.planDigest,
      planIdRevision: sha256Canonical({ planId: pointer.planId }),
      requestRevision: pointer.requestRevision,
      size: await boundedPrivateFileSize(path, PLAN_POINTER_MAX_BYTES)
    });
  }
  if (pointers.length > limit) throw new Error(`${label} exceeds ${limit} entries`);
  return pointers;
}

async function removePointersToDigests(inventory: PlanStoreInventory, deleted: ReadonlySet<Sha256Digest>): Promise<void> {
  for (const item of [...inventory.requestPointers, ...inventory.idPointers]) {
    if (deleted.has(item.planDigest)) await removePrivateFile(item.path);
  }
  if (inventory.latest && deleted.has(inventory.latest.pointer.planDigest)) {
    await removePrivateFile(inventory.latest.path);
  }
}

async function applyReferencedPlanDigests(profileId: string): Promise<Set<Sha256Digest>> {
  const digests = new Set<Sha256Digest>();
  let layout;
  try {
    layout = await readApplyArtifactLayout(profileId);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return digests;
    throw error;
  }
  const markers = await readApplyUnfinishedMarkers(
    layout,
    profileId,
    async (boundProfileId, planDigest) => (await loadStoredPlan(boundProfileId, planDigest)).plan
  );
  if (markers === null) {
    throw new Error(
      "Plan retention cannot prove Apply references because the Apply unfinished index is absent; explicit legacy-store repair is required"
    );
  }
  for (const marker of markers) digests.add(marker.journal.planDigest);
  const entries = await readDirectoryNames(
    layout.transactions,
    PLAN_APPLY_REFERENCE_SCAN_LIMIT,
    "Apply Plan-reference transaction store"
  );
  const markerSegments = new Set(markers.map((marker) =>
    marker.journal.transactionId.trim().replace(/[^A-Za-z0-9._-]+/gu, "-").replace(/^-+|-+$/gu, "") || "unknown"
  ));
  for (const entry of entries) {
    const transactionRoot = await assertPrivateDirectory(layout.transactions, entry);
    const journalPath = privatePath(transactionRoot, "journal.json");
    try {
      const journal = defineApplyJournal(await readPrivateJson(journalPath));
      if (journal.profileId !== profileId) throw new Error("Apply Plan reference belongs to another Profile");
      digests.add(journal.planDigest);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" && markerSegments.has(entry)) continue;
      throw new Error(
        `Plan retention cannot prove whether Apply transaction ${entry} references a Plan: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  return digests;
}

async function assertPlanStoreRootShape(layout: PlanLayout): Promise<void> {
  const allowed = new Set([".plan-store-control.lock", "ids", "latest.json", "objects", "requests"]);
  for (const entry of await readDirectoryNames(layout.root, allowed.size + 1, "Plan store root")) {
    if (!allowed.has(entry)) throw new Error(`Plan store root contains an unexpected entry: ${entry}`);
  }
  for (const path of [layout.objects, layout.requests, layout.ids]) {
    assertOwnerPrivateDirectory(await lstat(path), path);
  }
}

async function reconcilePlanObjectPublications(root: string): Promise<void> {
  const entries = await readDirectoryNames(root, PLAN_STORE_MAX_OBJECTS + 64, "Plan object store");
  for (const entry of entries) {
    if (!/^[a-f0-9]{64}\.json$/u.test(entry)) continue;
    // Immutable publication can die after its canonical hardlink is durable
    // but before the proof-bound temporary is unlinked. Reconcile only that
    // exact inode pair; every standalone or otherwise unexplained temp remains
    // visible to the subsequent inventory and fails closed.
    await reconcilePrivatePublication(privatePath(root, entry));
  }
}

function validatePlanPointers(
  objects: readonly PlanStoreObjectInventory[],
  requestPointers: PlanStoreInventory["requestPointers"],
  idPointers: PlanStoreInventory["idPointers"],
  latest: PlanStoreInventory["latest"]
): void {
  const byDigest = new Map(objects.map((item) => [item.digest, item] as const));
  for (const item of requestPointers) {
    if (basename(item.path) !== `${digestHex(item.requestRevision)}.json`) {
      throw new Error("Plan request pointer filename does not match its request revision");
    }
    assertPointerMatchesObject(item, byDigest);
  }
  for (const item of idPointers) {
    const expected = `${digestHex(item.planIdRevision)}.json`;
    if (basename(item.path) !== expected) {
      throw new Error("Plan id pointer filename does not match its Plan id");
    }
    assertPointerMatchesObject(item, byDigest);
  }
  if (latest) assertPointerMatchesObject({
    path: latest.path,
    planDigest: latest.pointer.planDigest,
    planIdRevision: sha256Canonical({ planId: latest.pointer.planId }),
    requestRevision: latest.pointer.requestRevision,
    size: latest.size
  }, byDigest);
}

function assertPointerMatchesObject(
  pointer: PlanStorePointerInventory,
  objects: ReadonlyMap<Sha256Digest, PlanStoreObjectInventory>
): void {
  const object = objects.get(pointer.planDigest);
  if (!object) throw new Error(`Plan pointer references a missing object: ${pointer.planDigest}`);
  if (pointer.planIdRevision !== object.planIdRevision || pointer.requestRevision !== object.requestRevision) {
    throw new Error("Plan pointer does not match its content-addressed Plan object");
  }
}

async function readDirectoryNames(path: string, maxEntries: number, label: string): Promise<string[]> {
  const directory = await opendir(path);
  const entries: string[] = [];
  try {
    for await (const entry of directory) {
      if (entries.length >= maxEntries) throw new Error(`${label} exceeds ${maxEntries} entries`);
      entries.push(entry.name);
    }
  } finally {
    await directory.close().catch(() => undefined);
  }
  return entries.sort();
}

async function boundedPrivateFileSize(path: string, maxBytes: number): Promise<number> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.nlink !== 1
      || (typeof process.getuid === "function" && metadata.uid !== process.getuid())
      || (metadata.mode & 0o077) !== 0
      || metadata.size < 1 || metadata.size > maxBytes) {
      throw new Error(`Plan store file is not one bounded owner-private file: ${path}`);
    }
    return metadata.size;
  } finally {
    await handle.close();
  }
}

async function privateFilePublicationTime(path: string): Promise<string> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.nlink !== 1
      || (typeof process.getuid === "function" && metadata.uid !== process.getuid())
      || (metadata.mode & 0o077) !== 0
      || !Number.isFinite(metadata.birthtimeMs)
      || metadata.birthtimeMs <= 0) {
      throw new Error(`Plan object lacks a trustworthy owner-private publication time: ${path}`);
    }
    return new Date(metadata.birthtimeMs).toISOString();
  } finally {
    await handle.close();
  }
}

function assertOwnerPrivateDirectory(metadata: Stats, path: string): void {
  if (metadata.isSymbolicLink() || !metadata.isDirectory()
    || (typeof process.getuid === "function" && metadata.uid !== process.getuid())
    || (metadata.mode & 0o077) !== 0) {
    throw new Error(`Plan store is not an owner-private real directory: ${path}`);
  }
}

function addPlanStoreBytes(left: number, right: number): number {
  const total = left + right;
  if (!Number.isSafeInteger(left) || left < 0 || !Number.isSafeInteger(right) || right < 0
    || !Number.isSafeInteger(total)) {
    throw new Error("Plan store byte inventory exceeds the safe integer range");
  }
  return total;
}

function definePlanStorePolicy(policy: PlanStorePolicy): PlanStorePolicy {
  if (!Number.isSafeInteger(policy.maxStoreBytes) || policy.maxStoreBytes < 1
    || policy.maxStoreBytes > PLAN_STORE_MAX_BYTES
    || !Number.isSafeInteger(policy.minimumFreeBytes)
    || policy.minimumFreeBytes < PLAN_STORE_MINIMUM_FREE_BYTES
    || !Number.isSafeInteger(policy.maxObjects) || policy.maxObjects < 1
    || policy.maxObjects > PLAN_STORE_MAX_OBJECTS
    || !Number.isSafeInteger(policy.unreferencedRetentionMs)
    || policy.unreferencedRetentionMs < 0
    || policy.unreferencedRetentionMs > PLAN_UNREFERENCED_RETENTION_MS) {
    throw new Error("Plan store policy may only tighten the bounded production policy");
  }
  return policy;
}

function planProfileKey(profileId: string): string {
  if (!profileId.trim()) throw new Error("Plan store requires a non-empty Profile id");
  return `profile-${digestHex(sha256Canonical({ profileId }))}`;
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
  const value = await readPrivateJson(path, PLAN_POINTER_MAX_BYTES);
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
  assertExactKeys(value, ["schemaVersion", "requestRevision", "snapshot", "plan"], "Plan artifact");
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
