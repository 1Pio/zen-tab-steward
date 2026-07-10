/**
 * The normalized, immutable read model shared by every zts caller.
 *
 * Adapter-specific session fields, Profile paths, process details, endpoints,
 * and raw tab indices stop at this Module's seam.
 */

import { assertSha256Digest, sha256Canonical } from "./digest.js";
import { assertExactKeys } from "./validation.js";
import type { Sha256Digest } from "./digest.js";

export type { Sha256Digest } from "./digest.js";
export type EntityRef = `entity:${string}`;
export type MovementRootRef = `entity:root:${string}`;
export type StructuralChildRef = `entity:child:${string}`;
export type NonEmptyReadonlyArray<T> = readonly [T, ...T[]];

export type AuthoritativeControlRoute =
  | "closed_session"
  | "managed_zen"
  | "privileged_live"
  | "zen_owned";

export type ControlRoute = AuthoritativeControlRoute | "persisted_session";
export type ApplyControlRoute = AuthoritativeControlRoute;

export type EntityKind = "tab" | "tab_group" | "zen_folder" | "split_view";

export type CapabilityId =
  | "observe.snapshot"
  | "profile.exclusive_control"
  | "profile.managed_lifecycle"
  /** Each move capability includes immediate post-state verification. */
  | "move.tab"
  | "move.tab_group"
  | "move.zen_folder"
  | "move.split_view";

export interface ArtifactReference {
  readonly id: string;
  readonly digest: Sha256Digest;
}

export interface CapabilityScope {
  readonly profileId: string;
  readonly route: ControlRoute;
  readonly platform: string;
  readonly zenVersion: string;
  readonly zenBuildId: string | null;
  readonly schemaFamily: string;
  readonly entityKind: EntityKind | null;
}

export interface CapabilityProof {
  readonly artifact: ArtifactReference;
  readonly source: "runtime_probe" | "acceptance_fixture" | "compatibility_fixture";
  readonly capturedAt: string;
  readonly scope: CapabilityScope;
  /** Required by the validator for available privileged-live capabilities. */
  readonly controlSessionId: string | null;
  /** Required by the validator for available privileged-live capabilities. */
  readonly processBindingRevision: Sha256Digest | null;
}

export type CapabilityEvidence =
  | {
      readonly id: CapabilityId;
      readonly status: "available";
      readonly reason: string;
      readonly proof: CapabilityProof;
    }
  | {
      readonly id: CapabilityId;
      readonly status: "unavailable" | "unknown";
      readonly reason: string;
      readonly proof: CapabilityProof | null;
    };

export interface CapabilityReport {
  readonly observedAt: string;
  readonly evidence: NonEmptyReadonlyArray<CapabilityEvidence>;
}

export interface ProfileRef {
  readonly id: string;
  readonly name: string;
  readonly contentTrust: "browser_untrusted";
}

export type Protection =
  | {
      readonly protected: false;
      readonly reasons: readonly [];
    }
  | {
      readonly protected: true;
      readonly reasons: NonEmptyReadonlyArray<string>;
    };

export interface WorkspaceProtection {
  readonly source: Protection;
  readonly destination: Protection;
}

export interface Workspace {
  readonly id: string;
  readonly name: string;
  /** Names originate in Zen and must never be interpreted as instructions. */
  readonly contentTrust: "browser_untrusted";
  readonly position: number;
  readonly protection: WorkspaceProtection;
}

export interface EntityMember {
  readonly nativeId: string | null;
  readonly title: string;
  readonly url: string;
  /** Titles and URLs are full-detail browser data, not agent instructions. */
  readonly contentTrust: "browser_untrusted";
  readonly pinned: boolean;
  readonly essential: boolean;
  readonly hidden: boolean;
  readonly active: boolean;
}

interface EntityBase {
  readonly revision: Sha256Digest;
  readonly workspaceId: string;
  readonly title: string;
  readonly contentTrust: "browser_untrusted";
  readonly protection: Protection;
  /**
   * A root revision covers its complete ordered descendant closure, including
   * every child revision and direct member. A child revision covers its own
   * ordered descendant closure. Snapshot construction owns this digest rule.
   */
  readonly structuralRootRef: MovementRootRef;
}

export interface TabEntity extends EntityBase {
  readonly ref: MovementRootRef;
  readonly kind: "tab";
  readonly nativeId: string | null;
  readonly parentRef: null;
  readonly childRefs: readonly [];
  readonly members: readonly [EntityMember];
}

export interface TabGroupEntity extends EntityBase {
  readonly ref: MovementRootRef;
  readonly kind: "tab_group";
  readonly nativeId: string;
  readonly parentRef: null;
  readonly childRefs: readonly [];
  readonly members: NonEmptyReadonlyArray<EntityMember>;
}

export interface RootFolderEntity extends EntityBase {
  readonly ref: MovementRootRef;
  readonly kind: "zen_folder";
  readonly nativeId: string;
  readonly parentRef: null;
  readonly childRefs: readonly StructuralChildRef[];
  /** Direct members only. Descendant members belong to child folder nodes. */
  readonly members: readonly EntityMember[];
}

export interface ChildFolderEntity extends EntityBase {
  readonly ref: StructuralChildRef;
  readonly kind: "zen_folder";
  readonly nativeId: string;
  readonly parentRef: EntityRef;
  readonly childRefs: readonly StructuralChildRef[];
  readonly members: readonly EntityMember[];
}

export interface SplitViewEntity extends EntityBase {
  readonly ref: MovementRootRef;
  readonly kind: "split_view";
  readonly nativeId: string;
  readonly parentRef: null;
  readonly childRefs: readonly [];
  readonly members: readonly [EntityMember, EntityMember, ...EntityMember[]];
}

export type Entity = TabEntity | TabGroupEntity | RootFolderEntity | ChildFolderEntity | SplitViewEntity;

interface SnapshotProvenanceBase {
  readonly sourceRevision: Sha256Digest;
  readonly platform: string;
  readonly zenVersion: string;
  readonly zenBuildId: string | null;
  readonly schemaFamily: string;
}

export interface AuthoritativeSnapshotProvenance extends SnapshotProvenanceBase {
  readonly route: AuthoritativeControlRoute;
}

export interface PersistedObservationProvenance extends SnapshotProvenanceBase {
  readonly route: "persisted_session";
}

interface SnapshotBase {
  readonly schemaVersion: "zts.snapshot.provisional-1";
  readonly profile: ProfileRef;
  readonly revision: Sha256Digest;
  readonly capturedAt: string;
  readonly capabilities: CapabilityReport;
  readonly workspaces: readonly Workspace[];
  /**
   * Direct member ownership is non-overlapping. Nested folders are child nodes
   * of one top-level Movement Root and cannot be targeted by Patch or Plan.
   */
  readonly entities: readonly Entity[];
}

export interface AuthoritativeSnapshot extends SnapshotBase {
  readonly authority: "authoritative";
  readonly freshness: "current";
  readonly provenance: AuthoritativeSnapshotProvenance;
}

export interface PersistedObservation extends SnapshotBase {
  readonly authority: "persisted_observation";
  readonly freshness: "possibly_stale" | "recovery";
  readonly provenance: PersistedObservationProvenance;
}

export type Snapshot = AuthoritativeSnapshot | PersistedObservation;

type EntityDraftOf<T> = T extends Entity ? Omit<T, "revision"> : never;
export type EntityDraft = EntityDraftOf<Entity>;

type SnapshotDraftOf<T> = T extends Snapshot
  ? Omit<T, "revision" | "entities"> & { readonly entities: readonly EntityDraft[] }
  : never;
export type SnapshotDraft = SnapshotDraftOf<Snapshot>;

/**
 * Constructs content-addressed Entity revisions and a normalized-state
 * Snapshot revision before validating and freezing the result.
 */
export function createSnapshot(draft: SnapshotDraft): Snapshot {
  const normalizedDraft = {
    ...draft,
    workspaces: [...draft.workspaces].sort((left, right) => left.position - right.position),
    entities: [...draft.entities].sort((left, right) => compareText(left.ref, right.ref))
  } as SnapshotDraft;
  const entityRevisions = computeEntityRevisions(normalizedDraft.entities);
  const entities = normalizedDraft.entities.map((entity) => ({
    ...entity,
    revision: requiredEntityRevision(entityRevisions, entity.ref)
  })) as readonly Entity[];
  const snapshot = {
    ...normalizedDraft,
    entities,
    revision: computeSnapshotRevision({ ...normalizedDraft, entities })
  } as Snapshot;
  return defineSnapshot(snapshot);
}

/**
 * Validates cross-record invariants that TypeScript cannot express, then
 * freezes the complete Snapshot. Adapters must use this constructor before a
 * Snapshot crosses the domain seam.
 */
export function defineSnapshot<T extends Snapshot>(snapshot: T): T {
  validateSnapshotShape(snapshot);
  validateSnapshotIdentity(snapshot);
  validateCapabilities(snapshot);
  validateEntityGraph(snapshot);
  validateContentDigests(snapshot);
  return deepFreeze(snapshot);
}

function validateSnapshotShape(snapshot: Snapshot): void {
  assertExactKeys(snapshot, [
    "schemaVersion",
    "profile",
    "revision",
    "capturedAt",
    "authority",
    "freshness",
    "provenance",
    "capabilities",
    "workspaces",
    "entities"
  ], "Snapshot");
  assertExactKeys(snapshot.profile, ["id", "name", "contentTrust"], "Snapshot Profile");
  assertExactKeys(snapshot.provenance, [
    "route",
    "sourceRevision",
    "platform",
    "zenVersion",
    "zenBuildId",
    "schemaFamily"
  ], "Snapshot provenance");
  assertExactKeys(snapshot.capabilities, ["observedAt", "evidence"], "Capability report");
  assertArray(snapshot.capabilities.evidence, "Capability evidence");
  for (const evidence of snapshot.capabilities.evidence) {
    assertExactKeys(evidence, ["id", "status", "reason", "proof"], `Capability ${evidence.id}`);
    if (evidence.proof !== null) validateCapabilityProofShape(evidence.proof, `Capability ${evidence.id} proof`);
  }
  assertArray(snapshot.workspaces, "Snapshot workspaces");
  for (const workspace of snapshot.workspaces) {
    assertExactKeys(workspace, ["id", "name", "contentTrust", "position", "protection"], `Workspace ${workspace.id}`);
    assertExactKeys(workspace.protection, ["source", "destination"], `Workspace ${workspace.id} Protection`);
    assertProtectionShape(workspace.protection.source, `Workspace ${workspace.id} source Protection`);
    assertProtectionShape(workspace.protection.destination, `Workspace ${workspace.id} destination Protection`);
  }
  assertArray(snapshot.entities, "Snapshot entities");
  for (const entity of snapshot.entities) {
    assertExactKeys(entity, [
      "ref",
      "revision",
      "kind",
      "nativeId",
      "parentRef",
      "childRefs",
      "structuralRootRef",
      "workspaceId",
      "title",
      "contentTrust",
      "members",
      "protection"
    ], `Entity ${entity.ref}`);
    assertArray(entity.childRefs, `Entity ${entity.ref} children`);
    assertArray(entity.members, `Entity ${entity.ref} members`);
    assertProtectionShape(entity.protection, `Entity ${entity.ref} Protection`);
    for (const member of entity.members) {
      assertExactKeys(member, [
        "nativeId",
        "title",
        "url",
        "contentTrust",
        "pinned",
        "essential",
        "hidden",
        "active"
      ], `Entity ${entity.ref} member`);
    }
  }
}

function validateCapabilityProofShape(proof: CapabilityProof, label: string): void {
  assertExactKeys(proof, [
    "artifact",
    "source",
    "capturedAt",
    "scope",
    "controlSessionId",
    "processBindingRevision"
  ], label);
  assertArtifactShape(proof.artifact, `${label} artifact`);
  assertExactKeys(proof.scope, [
    "profileId",
    "route",
    "platform",
    "zenVersion",
    "zenBuildId",
    "schemaFamily",
    "entityKind"
  ], `${label} scope`);
}

function validateSnapshotIdentity(snapshot: Snapshot): void {
  if (snapshot.schemaVersion !== "zts.snapshot.provisional-1") throw new Error("Unsupported Snapshot schema version");
  assertDigest(snapshot.revision, "Snapshot revision");
  assertDigest(snapshot.provenance.sourceRevision, "Snapshot source revision");
  if (!snapshot.profile.id.trim()) throw new Error("Snapshot Profile id must not be empty");
  if (!snapshot.profile.name.trim()) throw new Error("Snapshot Profile name must not be empty");
  if (snapshot.profile.contentTrust !== "browser_untrusted") throw new Error("Snapshot Profile name lacks browser-untrusted labeling");
  if ("path" in snapshot.profile) throw new Error("Snapshot Profile cannot contain an Adapter-private path");
  assertTimestamp(snapshot.capturedAt, "Snapshot capturedAt");
  const runtime = snapshot as unknown as {
    authority: string;
    freshness: string;
    provenance: { route: string };
  };
  if (!["closed_session", "managed_zen", "privileged_live", "zen_owned", "persisted_session"].includes(runtime.provenance.route)) {
    throw new Error("Unknown Snapshot Control Route");
  }
  if (runtime.authority === "authoritative") {
    if (runtime.freshness !== "current" || runtime.provenance.route === "persisted_session") {
      throw new Error("Authoritative Snapshot has contradictory freshness or Control Route");
    }
  } else if (runtime.authority === "persisted_observation") {
    if (!["possibly_stale", "recovery"].includes(runtime.freshness) || runtime.provenance.route !== "persisted_session") {
      throw new Error("Persisted Observation has contradictory freshness or Control Route");
    }
  } else {
    throw new Error("Unknown Snapshot authority");
  }
}

function validateContentDigests(snapshot: Snapshot): void {
  const entityRevisions = computeEntityRevisions(snapshot.entities);
  for (const entity of snapshot.entities) {
    const expected = requiredEntityRevision(entityRevisions, entity.ref);
    if (entity.revision !== expected) throw new Error(`Entity ${entity.ref} revision does not match its content closure`);
  }
  const expectedSnapshotRevision = computeSnapshotRevision(snapshot);
  if (snapshot.revision !== expectedSnapshotRevision) throw new Error("Snapshot revision does not match normalized state content");
}

function computeEntityRevisions(entities: readonly (Entity | EntityDraft)[]): ReadonlyMap<EntityRef, Sha256Digest> {
  const byRef = new Map<EntityRef, Entity | EntityDraft>();
  for (const entity of entities) {
    if (byRef.has(entity.ref)) throw new Error(`Duplicate Entity ref: ${entity.ref}`);
    byRef.set(entity.ref, entity);
  }
  const revisions = new Map<EntityRef, Sha256Digest>();
  const visiting = new Set<EntityRef>();
  const compute = (ref: EntityRef): Sha256Digest => {
    const existing = revisions.get(ref);
    if (existing) return existing;
    if (visiting.has(ref)) throw new Error(`Entity graph cycle at ${ref}`);
    const entity = byRef.get(ref);
    if (!entity) throw new Error(`Entity graph references missing ${ref}`);
    visiting.add(ref);
    const childRevisions = entity.childRefs.map((childRef) => ({ ref: childRef, revision: compute(childRef) }));
    visiting.delete(ref);
    const { revision: _ignored, ...content } = entity as Entity;
    const revision = sha256Canonical({ content, childRevisions });
    revisions.set(ref, revision);
    return revision;
  };
  for (const entity of entities) compute(entity.ref);
  return revisions;
}

function computeSnapshotRevision(snapshot: Omit<Snapshot, "revision"> | Snapshot): Sha256Digest {
  return sha256Canonical({
    schemaVersion: snapshot.schemaVersion,
    profile: snapshot.profile,
    workspaces: snapshot.workspaces,
    entities: snapshot.entities.map((entity) => ({ ref: entity.ref, revision: entity.revision }))
  });
}

function requiredEntityRevision(revisions: ReadonlyMap<EntityRef, Sha256Digest>, ref: EntityRef): Sha256Digest {
  const revision = revisions.get(ref);
  if (!revision) throw new Error(`Missing computed Entity revision for ${ref}`);
  return revision;
}

function validateCapabilities(snapshot: Snapshot): void {
  assertTimestamp(snapshot.capabilities.observedAt, "Capability observedAt");
  if (snapshot.capabilities.observedAt !== snapshot.capturedAt) {
    throw new Error("Capability report must use the Snapshot capture time");
  }
  const ids = new Set<CapabilityId>();
  for (const evidence of snapshot.capabilities.evidence) {
    if (![
      "observe.snapshot",
      "profile.exclusive_control",
      "profile.managed_lifecycle",
      "move.tab",
      "move.tab_group",
      "move.zen_folder",
      "move.split_view"
    ].includes(evidence.id)) {
      throw new Error(`Unknown Capability id: ${evidence.id}`);
    }
    if (!["available", "unavailable", "unknown"].includes(evidence.status)) {
      throw new Error(`Capability ${evidence.id} has an invalid status`);
    }
    if (ids.has(evidence.id)) throw new Error(`Duplicate Capability evidence: ${evidence.id}`);
    ids.add(evidence.id);
    if (!evidence.reason.trim()) throw new Error(`Capability ${evidence.id} requires a reason`);
    const { proof } = evidence;
    if (evidence.status === "available" && !proof) throw new Error(`Capability ${evidence.id} lacks proof`);
    if (!proof) continue;
    if (!["runtime_probe", "acceptance_fixture", "compatibility_fixture"].includes(proof.source)) {
      throw new Error(`Capability ${evidence.id} proof has an unknown source`);
    }
    assertArtifact(proof.artifact, `Capability ${evidence.id} proof`);
    assertTimestamp(proof.capturedAt, `Capability ${evidence.id} proof capturedAt`);
    if (evidence.status === "available") {
      if (proof.source !== "runtime_probe") {
        throw new Error(`Available Capability ${evidence.id} requires current runtime proof`);
      }
      if (proof.capturedAt !== snapshot.capturedAt) {
        throw new Error(`Available Capability ${evidence.id} proof is not bound to the Snapshot capture`);
      }
    }
    if (proof.scope.profileId !== snapshot.profile.id) throw new Error(`Capability ${evidence.id} Profile scope mismatch`);
    if (proof.scope.route !== snapshot.provenance.route) throw new Error(`Capability ${evidence.id} Control Route mismatch`);
    if (proof.scope.platform !== snapshot.provenance.platform) throw new Error(`Capability ${evidence.id} platform mismatch`);
    if (proof.scope.zenVersion !== snapshot.provenance.zenVersion) throw new Error(`Capability ${evidence.id} Zen version mismatch`);
    if (proof.scope.zenBuildId !== snapshot.provenance.zenBuildId) throw new Error(`Capability ${evidence.id} Zen build mismatch`);
    if (proof.scope.schemaFamily !== snapshot.provenance.schemaFamily) throw new Error(`Capability ${evidence.id} schema-family mismatch`);

    const expectedKind = entityKindForCapability(evidence.id);
    if (proof.scope.entityKind !== expectedKind) throw new Error(`Capability ${evidence.id} Entity-kind scope mismatch`);
    if (evidence.status === "available" && snapshot.provenance.route === "privileged_live") {
      if (!proof.controlSessionId?.trim()) throw new Error(`Capability ${evidence.id} lacks a live control-session binding`);
      if (!proof.processBindingRevision) throw new Error(`Capability ${evidence.id} lacks a live process binding`);
      assertDigest(proof.processBindingRevision, `Capability ${evidence.id} process binding`);
    }
  }

  const observe = snapshot.capabilities.evidence.find((evidence) => evidence.id === "observe.snapshot");
  if (!observe || observe.status !== "available") throw new Error("Snapshot requires available observe.snapshot evidence");
  if (snapshot.authority === "authoritative" && ["closed_session", "managed_zen"].includes(snapshot.provenance.route)) {
    const exclusive = snapshot.capabilities.evidence.find((evidence) =>
      evidence.id === "profile.exclusive_control" && evidence.status === "available"
    );
    if (!exclusive) throw new Error(`${snapshot.provenance.route} authoritative Snapshot requires exclusive Profile control evidence`);
  }
  if (snapshot.authority === "authoritative" && snapshot.provenance.route === "managed_zen") {
    const managed = snapshot.capabilities.evidence.find((evidence) =>
      evidence.id === "profile.managed_lifecycle" && evidence.status === "available"
    );
    if (!managed) throw new Error("Managed Zen authoritative Snapshot requires lifecycle evidence");
  }
  if (snapshot.authority === "persisted_observation") {
    const unsafe = snapshot.capabilities.evidence.find((evidence) =>
      evidence.status === "available" && evidence.id !== "observe.snapshot"
    );
    if (unsafe) throw new Error(`Persisted Observation cannot claim ${unsafe.id} is available`);
  }
}

function validateEntityGraph(snapshot: Snapshot): void {
  const workspaceIds = new Set<string>();
  const workspacePositions = new Set<number>();
  for (const workspace of snapshot.workspaces) {
    if (!workspace.id.trim()) throw new Error("Workspace id must not be empty");
    if (workspaceIds.has(workspace.id)) throw new Error(`Duplicate Workspace id: ${workspace.id}`);
    workspaceIds.add(workspace.id);
    if (!Number.isInteger(workspace.position) || workspace.position < 0 || workspacePositions.has(workspace.position)) {
      throw new Error(`Workspace ${workspace.id} has an invalid or duplicate position`);
    }
    workspacePositions.add(workspace.position);
    if (workspace.contentTrust !== "browser_untrusted") throw new Error(`Workspace ${workspace.id} lacks browser-untrusted labeling`);
    validateProtection(workspace.protection.source, `Workspace ${workspace.id} source`);
    validateProtection(workspace.protection.destination, `Workspace ${workspace.id} destination`);
  }
  if (snapshot.workspaces.some((workspace, index) => workspace.position !== index)) {
    throw new Error("Workspace array must be in canonical position order without gaps");
  }

  const entities = new Map<EntityRef, Entity>();
  const memberNativeIds = new Set<string>();
  const entityNativeIds = new Set<string>();
  if (snapshot.entities.some((entity, index, all) => index > 0 && compareText(all[index - 1].ref, entity.ref) > 0)) {
    throw new Error("Entity array must be in canonical reference order");
  }
  for (const entity of snapshot.entities) {
    if (!["tab", "tab_group", "zen_folder", "split_view"].includes(entity.kind)) {
      throw new Error(`Entity ${entity.ref} has an invalid kind`);
    }
    if (entities.has(entity.ref)) throw new Error(`Duplicate Entity ref: ${entity.ref}`);
    entities.set(entity.ref, entity);
    assertDigest(entity.revision, `Entity ${entity.ref} revision`);
    if (entity.contentTrust !== "browser_untrusted") throw new Error(`Entity ${entity.ref} lacks browser-untrusted labeling`);
    if (!workspaceIds.has(entity.workspaceId)) throw new Error(`Entity ${entity.ref} references an unknown Workspace`);
    validateProtection(entity.protection, `Entity ${entity.ref}`);
    if (entity.parentRef === null && entity.structuralRootRef !== entity.ref) {
      throw new Error(`Movement Root ${entity.ref} must reference itself`);
    }
    if (entity.parentRef === null && !isMovementRootRef(entity.ref)) {
      throw new Error(`Movement Root ${entity.ref} has an invalid reference`);
    }
    if (entity.parentRef !== null && !isStructuralChildRef(entity.ref)) {
      throw new Error(`Structural child ${entity.ref} has an invalid reference`);
    }
    if (entity.parentRef !== null && !isMovementRootRef(entity.structuralRootRef)) {
      throw new Error(`Structural child ${entity.ref} has an invalid Movement Root reference`);
    }
    if (entity.kind === "tab" && entity.members.length !== 1) throw new Error(`Tab Entity ${entity.ref} must own exactly one member`);
    if (entity.kind === "tab_group" && entity.members.length === 0) throw new Error(`Tab group ${entity.ref} must own at least one member`);
    if (entity.kind === "split_view" && entity.members.length < 2) throw new Error(`Split view ${entity.ref} must own at least two members`);
    if (entity.kind !== "zen_folder" && entity.childRefs.length !== 0) {
      throw new Error(`Only a Zen folder may own structural children: ${entity.ref}`);
    }
    if (entity.nativeId !== null && !entity.nativeId.trim()) throw new Error(`Native id for Entity ${entity.ref} must not be empty`);
    if (entity.kind !== "tab" && entity.nativeId === null) throw new Error(`Structured Entity ${entity.ref} requires a native id`);
    if (entity.nativeId) {
      if (entityNativeIds.has(entity.nativeId)) throw new Error(`Native Entity id ${entity.nativeId} has multiple owners`);
      entityNativeIds.add(entity.nativeId);
    }
    if (entity.kind === "tab" && entity.nativeId !== entity.members[0].nativeId) {
      throw new Error(`Tab Entity ${entity.ref} native identity does not match its member`);
    }
    for (const member of entity.members) {
      if (member.contentTrust !== "browser_untrusted") throw new Error(`Entity member in ${entity.ref} lacks browser-untrusted labeling`);
      if (member.nativeId !== null && !member.nativeId.trim()) throw new Error(`Entity member in ${entity.ref} has an empty native id`);
      if (member.nativeId) {
        if (memberNativeIds.has(member.nativeId)) throw new Error(`Entity member ${member.nativeId} has multiple owners`);
        memberNativeIds.add(member.nativeId);
      }
    }
  }

  const childOwners = new Map<StructuralChildRef, EntityRef>();
  for (const entity of snapshot.entities) {
    for (const childRef of entity.childRefs) {
      const child = entities.get(childRef);
      if (!child || child.kind !== "zen_folder") throw new Error(`Entity ${entity.ref} references an invalid folder child ${childRef}`);
      if (child.parentRef !== entity.ref) throw new Error(`Folder child ${childRef} has an inconsistent parent`);
      if (child.workspaceId !== entity.workspaceId) throw new Error(`Folder child ${childRef} crosses Workspaces`);
      if (child.structuralRootRef !== entity.structuralRootRef) throw new Error(`Folder child ${childRef} has an inconsistent Movement Root`);
      if (childOwners.has(childRef)) throw new Error(`Folder child ${childRef} has multiple parents`);
      childOwners.set(childRef, entity.ref);
    }
  }

  for (const entity of snapshot.entities) {
    if (entity.parentRef !== null && !childOwners.has(entity.ref)) {
      throw new Error(`Folder child ${entity.ref} is not owned by its declared parent`);
    }
  }

  const visited = new Set<EntityRef>();
  const visiting = new Set<EntityRef>();
  for (const entity of snapshot.entities) {
    if (entity.parentRef === null) visitEntity(entity.ref, entities, visited, visiting);
  }
  if (visited.size !== entities.size) throw new Error("Entity graph contains an unreachable child or cycle");
}

function visitEntity(
  ref: EntityRef,
  entities: ReadonlyMap<EntityRef, Entity>,
  visited: Set<EntityRef>,
  visiting: Set<EntityRef>
): void {
  if (visiting.has(ref)) throw new Error(`Entity graph cycle at ${ref}`);
  if (visited.has(ref)) return;
  const entity = entities.get(ref);
  if (!entity) throw new Error(`Entity graph references missing ${ref}`);
  visiting.add(ref);
  for (const childRef of entity.childRefs) visitEntity(childRef, entities, visited, visiting);
  visiting.delete(ref);
  visited.add(ref);
}

function validateProtection(protection: Protection, label: string): void {
  if (protection.protected !== true && protection.protected !== false) {
    throw new Error(`${label} has an invalid Protection discriminant`);
  }
  if (protection.protected && protection.reasons.length === 0) throw new Error(`${label} Protection requires a reason`);
  if (!protection.protected && protection.reasons.length !== 0) throw new Error(`${label} cannot have Protection reasons when unprotected`);
  if (protection.reasons.some((reason) => !reason.trim())) throw new Error(`${label} has an empty Protection reason`);
}

function entityKindForCapability(id: CapabilityId): EntityKind | null {
  if (id === "move.tab") return "tab";
  if (id === "move.tab_group") return "tab_group";
  if (id === "move.zen_folder") return "zen_folder";
  if (id === "move.split_view") return "split_view";
  return null;
}

function isMovementRootRef(ref: string): ref is MovementRootRef {
  return ref.startsWith("entity:root:") && ref.length > "entity:root:".length;
}

function isStructuralChildRef(ref: string): ref is StructuralChildRef {
  return ref.startsWith("entity:child:") && ref.length > "entity:child:".length;
}

function assertArtifact(artifact: ArtifactReference, label: string): void {
  assertArtifactShape(artifact, label);
  if (!artifact.id.trim()) throw new Error(`${label} id must not be empty`);
  assertDigest(artifact.digest, `${label} digest`);
}

function assertArtifactShape(artifact: ArtifactReference, label: string): void {
  assertExactKeys(artifact, ["id", "digest"], label);
}

function assertProtectionShape(protection: Protection, label: string): void {
  assertExactKeys(protection, ["protected", "reasons"], label);
  assertArray(protection.reasons, `${label} reasons`);
}

function assertArray(value: unknown, label: string): asserts value is readonly unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
}

function assertDigest(value: string, label: string): void {
  assertSha256Digest(value, label);
}

function assertTimestamp(value: string, label: string): void {
  if (
    typeof value !== "string"
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
    || !Number.isFinite(Date.parse(value))
    || new Date(value).toISOString() !== value
  ) {
    throw new Error(`${label} must be a canonical UTC ISO timestamp`);
  }
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return value;
}
