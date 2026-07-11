import { boundedZtsMessageValue, createPlan } from "../domain/change.js";
import { sha256Canonical } from "../domain/digest.js";
import { movementEligibility } from "../domain/snapshot.js";
import { urlMatchesAnyPattern } from "../url-pattern.js";
import { destinationAllowedByPolicy, workspaceAllowedByPolicy } from "../workspace-policy.js";

import type {
  DecisionEvidence,
  EngineId,
  MoveProtectionPrecondition,
  Plan,
  PlanAction,
  UnknownDecisionEvidence,
  ZtsMessage
} from "../domain/change.js";
import type {
  Entity,
  EntityMember,
  EntityRef,
  MovementRootRef,
  Protection,
  Snapshot,
  Workspace
} from "../domain/snapshot.js";
import type { Sha256Digest } from "../domain/digest.js";

const PLAN_TTL_MS = 5 * 60 * 1000;
const DATA_LABEL_MAX_BYTES = 256;

export type SortScope =
  | { readonly kind: "all_workspaces" }
  | { readonly kind: "workspace"; readonly workspaceId: string };

export interface SortPolicyOptions {
  readonly scope: SortScope;
  readonly configRevision: Sha256Digest;
  readonly sourceAllowlist: readonly string[];
  readonly destinationAllowlist: readonly string[];
  readonly destinationDenylist: readonly string[];
  readonly only: readonly string[];
  readonly except: readonly string[];
  readonly includePinned: boolean;
  readonly includeEssentials: boolean;
  readonly limit: number | null;
  readonly autoApplyRequested: boolean;
  readonly now?: Date;
}

export interface SortProposalContext {
  readonly snapshot: Snapshot;
  readonly entity: Entity;
  readonly members: readonly EntityMember[];
  readonly source: Workspace;
}

export type SortProposal =
  | {
      readonly kind: "none";
      readonly decision: DecisionEvidence;
      readonly reason: string;
    }
  | {
      readonly kind: "candidate";
      readonly destination: Workspace;
      readonly decision: DecisionEvidence;
      readonly suggested: boolean;
      readonly reviewReason: string;
      readonly priority: {
        readonly score: number;
        readonly margin: number;
      };
    };

interface PendingMove {
  readonly kind: "pending_move";
  readonly identity: { readonly entityRef: string; readonly requestRevision: string };
  readonly entity: Entity;
  readonly source: Workspace;
  readonly destination: Workspace;
  readonly decision: DecisionEvidence;
  readonly priority: { readonly score: number; readonly margin: number };
}

export interface SortPlanEngine {
  readonly id: Exclude<EngineId, "manual">;
  readonly manifestRevision: Sha256Digest;
  readonly requestRevision: Sha256Digest;
  propose(context: SortProposalContext): SortProposal;
  unknownDecision(entity: Entity, message: string): UnknownDecisionEvidence;
}

/**
 * The shared policy-to-Plan compiler for Engine intent. Engines only rank or
 * select a destination. This module applies the same source/destination
 * Protection, filters, movement capability, and move cap before an Operation
 * can enter the authoritative Plan spine.
 */
export function compileSortPlan(
  snapshot: Snapshot,
  options: SortPolicyOptions,
  engine: SortPlanEngine
): Plan {
  const now = options.now ?? new Date();
  const createdAt = canonicalTimestamp(now, engine.id);
  const expiresAt = new Date(now.getTime() + PLAN_TTL_MS).toISOString();
  const workspaces = new Map(snapshot.workspaces.map((workspace) => [workspace.id, workspace]));
  const entities = new Map(snapshot.entities.map((entity) => [entity.ref, entity]));
  const draftedActions: Array<PlanAction | PendingMove> = [];

  for (const entity of snapshot.entities) {
    if (entity.parentRef !== null || entity.structuralRootRef !== entity.ref) continue;
    if (!entityInScope(entity, options.scope)) continue;
    const source = workspaces.get(entity.workspaceId);
    if (!source) throw new Error(`Entity ${entity.ref} references a missing source Workspace`);
    const members = movementRootMembers(entity, entities);
    const actionIdBase = { entityRef: entity.ref, requestRevision: engine.requestRevision };

    if (source.protection.source.protected) {
      draftedActions.push(unknownNonMoveAction(
        engine,
        actionIdBase,
        entity,
        "protected",
        null,
        `Source Workspace ${boundedDataLabel(source.name)} is protected from sorting`
      ));
      continue;
    }
    if (!workspaceAllowedByPolicy(source, options.sourceAllowlist)) {
      draftedActions.push(unknownNonMoveAction(
        engine,
        actionIdBase,
        entity,
        "blocked",
        null,
        `Source Workspace ${boundedDataLabel(source.name)} is outside the active source policy`
      ));
      continue;
    }
    if (entity.protection.protected && !includedEntityProtection(entity.protection, options)) {
      draftedActions.push(unknownNonMoveAction(
        engine,
        actionIdBase,
        entity,
        "protected",
        null,
        `Entity is protected: ${entity.protection.reasons.map(boundedDataLabel).join(", ")}`
      ));
      continue;
    }
    if (members.some((member) => urlMatchesAnyPattern(member.url, options.except))) {
      draftedActions.push(unknownNonMoveAction(
        engine,
        actionIdBase,
        entity,
        "unchanged",
        null,
        "Entity is excluded by the active filter"
      ));
      continue;
    }
    if (options.only.length > 0
      && !members.every((member) => urlMatchesAnyPattern(member.url, options.only))) {
      draftedActions.push(unknownNonMoveAction(
        engine,
        actionIdBase,
        entity,
        "review",
        null,
        "Entity contains content outside the active only filter"
      ));
      continue;
    }

    const proposal = engine.propose({ snapshot, entity, members, source });
    if (proposal.kind === "none") {
      draftedActions.push(nonMoveAction(
        engine,
        actionIdBase,
        entity,
        "review",
        null,
        proposal.decision,
        proposal.reason
      ));
      continue;
    }

    const destination = proposal.destination;
    if (destination.protection.destination.protected) {
      draftedActions.push(nonMoveAction(
        engine,
        actionIdBase,
        entity,
        "protected",
        destination.id,
        proposal.decision,
        `Destination Workspace ${boundedDataLabel(destination.name)} is protected from receiving sorted Entities`
      ));
      continue;
    }
    if (!destinationAllowedByPolicy(
      destination,
      options.destinationAllowlist,
      options.destinationDenylist
    )) {
      draftedActions.push(nonMoveAction(
        engine,
        actionIdBase,
        entity,
        "blocked",
        destination.id,
        proposal.decision,
        `Destination Workspace ${boundedDataLabel(destination.name)} is outside the active destination policy`
      ));
      continue;
    }
    if (!proposal.suggested) {
      draftedActions.push(nonMoveAction(
        engine,
        actionIdBase,
        entity,
        "review",
        destination.id,
        proposal.decision,
        proposal.reviewReason
      ));
      continue;
    }
    if (destination.id === source.id) {
      draftedActions.push(nonMoveAction(
        engine,
        actionIdBase,
        entity,
        "unchanged",
        destination.id,
        proposal.decision,
        `Entity already best matches its current Workspace ${boundedDataLabel(destination.name)}`
      ));
      continue;
    }
    const movement = movementEligibility(snapshot, entity);
    if (!movement.eligible) {
      draftedActions.push(nonMoveAction(
        engine,
        actionIdBase,
        entity,
        "review",
        destination.id,
        proposal.decision,
        `Entity cannot move through the current Snapshot: ${movement.reason}`
      ));
      continue;
    }
    draftedActions.push({
      kind: "pending_move",
      identity: actionIdBase,
      entity,
      source,
      destination,
      decision: proposal.decision,
      priority: proposal.priority
    });
  }

  const pending = draftedActions.filter((action): action is PendingMove => isPendingMove(action));
  const selected = new Set((options.limit === null
    ? pending
    : [...pending]
      .sort((left, right) =>
        right.priority.score - left.priority.score
        || right.priority.margin - left.priority.margin
        || compareText(left.entity.ref, right.entity.ref)
        || compareText(left.destination.id, right.destination.id)
      )
      .slice(0, options.limit)));
  const actions: PlanAction[] = draftedActions.map((action) => {
    if (!isPendingMove(action)) return action;
    if (!selected.has(action)) {
      return nonMoveAction(
        engine,
        action.identity,
        action.entity,
        "review",
        action.destination.id,
        action.decision,
        options.limit === 0
          ? "Move limit 0 allows no executable suggestions; review this candidate"
          : `Move limit ${options.limit} has been reached; a stronger suggestion was retained first`
      );
    }
    return moveAction(engine, action);
  });

  const idRevision = sha256Canonical({
    snapshotRevision: snapshot.revision,
    requestRevision: engine.requestRevision,
    createdAt
  });
  return createPlan(snapshot, {
    schemaVersion: "zts.plan.provisional-1",
    id: `plan:${engine.id}:${shortDigest(idRevision)}`,
    configRevision: options.configRevision,
    engineManifestRevision: engine.manifestRevision,
    createdAt,
    expiresAt,
    derivation: { kind: "original" },
    source: { kind: "engine", engine: engine.id, intentRevision: engine.requestRevision },
    actions
  });
}

export function movementRootMembers(
  root: Entity,
  entities: ReadonlyMap<EntityRef, Entity>
): readonly EntityMember[] {
  const members: EntityMember[] = [];
  const visited = new Set<EntityRef>();
  const visiting = new Set<EntityRef>();
  const visit = (entity: Entity): void => {
    if (visiting.has(entity.ref)) throw new Error(`Entity graph cycle at ${entity.ref}`);
    if (visited.has(entity.ref)) {
      throw new Error(`Movement Root ${root.ref} repeats structural child ${entity.ref}`);
    }
    if (entity.structuralRootRef !== root.ref) {
      throw new Error(`Structural child ${entity.ref} escapes Movement Root ${root.ref}`);
    }
    visiting.add(entity.ref);
    members.push(...entity.members);
    for (const childRef of entity.childRefs) {
      const child = entities.get(childRef);
      if (!child) throw new Error(`Movement Root ${root.ref} references missing child ${childRef}`);
      visit(child);
    }
    visiting.delete(entity.ref);
    visited.add(entity.ref);
  };
  visit(root);
  return members;
}

export function boundedDataLabel(value: string): string {
  if (Buffer.byteLength(value, "utf8") <= DATA_LABEL_MAX_BYTES) return value;
  const suffix = "…";
  const budget = DATA_LABEL_MAX_BYTES - Buffer.byteLength(suffix, "utf8");
  let output = "";
  let used = 0;
  for (const character of value) {
    const bytes = Buffer.byteLength(character, "utf8");
    if (used + bytes > budget) break;
    output += character;
    used += bytes;
  }
  return `${output}${suffix}`;
}

export function engineEvidenceText(value: string, entity: Entity) {
  return {
    value: boundedZtsMessageValue(value),
    provenance: "engine_generated" as const,
    interpretation: "data_only" as const,
    referencedEntityRefs: [entity.ref]
  };
}

export function notRequested(value: string) {
  return {
    status: "not_requested" as const,
    requested: false as const,
    eligible: false as const,
    reason: ztsMessage(value)
  };
}

export function ztsMessage(value: string): ZtsMessage {
  return {
    value: boundedZtsMessageValue(value),
    provenance: "zts_generated",
    interpretation: "data_only"
  };
}

function isPendingMove(action: PlanAction | PendingMove): action is PendingMove {
  return "kind" in action && action.kind === "pending_move";
}

function moveAction(engine: SortPlanEngine, pending: PendingMove): PlanAction {
  const { identity, entity, source, destination, decision } = pending;
  const actionId = stableActionId(engine.id, {
    ...identity,
    disposition: "move",
    destinationWorkspaceId: destination.id
  });
  return {
    actionId,
    disposition: "move",
    operation: {
      op: "move",
      entityRef: entity.ref as MovementRootRef,
      entityKind: entity.kind,
      precondition: {
        entityRevision: entity.revision,
        entityProtection: moveProtection(entity.protection, `grant:${actionId}:entity`),
        sourceWorkspace: {
          workspaceId: source.id,
          protection: moveProtection(source.protection.source, `grant:${actionId}:source`)
        },
        destinationWorkspace: {
          workspaceId: destination.id,
          protection: moveProtection(destination.protection.destination, `grant:${actionId}:destination`)
        }
      },
      expectedPostState: { workspaceId: destination.id },
      inverse: { op: "move", destinationWorkspaceId: source.id }
    },
    decision
  };
}

function nonMoveAction(
  engine: SortPlanEngine,
  identity: { readonly entityRef: string; readonly requestRevision: string },
  entity: Entity,
  disposition: "review" | "protected" | "blocked" | "unchanged",
  candidateDestinationWorkspaceId: string | null,
  decision: DecisionEvidence,
  dispositionReason: string
): PlanAction {
  return {
    actionId: stableActionId(engine.id, { ...identity, disposition, candidateDestinationWorkspaceId }),
    disposition,
    entityRef: entity.ref,
    candidateDestinationWorkspaceId,
    decision,
    dispositionReason: ztsMessage(dispositionReason)
  };
}

function unknownNonMoveAction(
  engine: SortPlanEngine,
  identity: { readonly entityRef: string; readonly requestRevision: string },
  entity: Entity,
  disposition: "review" | "protected" | "blocked" | "unchanged",
  candidateDestinationWorkspaceId: string | null,
  dispositionReason: string
): PlanAction {
  return nonMoveAction(
    engine,
    identity,
    entity,
    disposition,
    candidateDestinationWorkspaceId,
    engine.unknownDecision(entity, dispositionReason),
    dispositionReason
  );
}

function includedEntityProtection(
  protection: Protection,
  options: Pick<SortPolicyOptions, "includePinned" | "includeEssentials">
): boolean {
  if (!protection.protected) return true;
  return protection.reasons.every((reason) =>
    (reason === "pinned" && options.includePinned)
    || (reason === "essential" && options.includeEssentials)
  );
}

function moveProtection(protection: Protection, grantId: string): MoveProtectionPrecondition {
  if (!protection.protected) return { protected: false, reasons: [], requiredGrantId: null };
  return {
    protected: true,
    reasons: protection.reasons,
    protectionRevision: sha256Canonical(protection),
    requiredGrantId: grantId
  };
}

function entityInScope(entity: Entity, scope: SortScope): boolean {
  return scope.kind === "all_workspaces" || entity.workspaceId === scope.workspaceId;
}

function stableActionId(engine: SortPlanEngine["id"], value: unknown): string {
  return `action:${engine}:${shortDigest(sha256Canonical(value))}`;
}

function shortDigest(digest: string): string {
  return digest.slice("sha256:".length, "sha256:".length + 20);
}

function canonicalTimestamp(date: Date, engine: string): string {
  if (!Number.isFinite(date.getTime())) throw new Error(`${engine} Engine Plan timestamp is invalid`);
  return date.toISOString();
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
