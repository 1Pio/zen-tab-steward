/**
 * Exact change intent, validated decisions, authorization, and mutation
 * outcomes. Engines and callers propose intent. Only an Apply Transaction may
 * interpret executable Plan Operations as mutation requests.
 */

import { assertSha256Digest, sha256Canonical } from "./digest.js";
import { defineSnapshot } from "./snapshot.js";
import { assertExactKeys } from "./validation.js";

import type {
  ArtifactReference,
  Entity,
  EntityKind,
  EntityRef,
  MovementRootRef,
  NonEmptyReadonlyArray,
  Snapshot,
  Sha256Digest
} from "./snapshot.js";

export type EngineId = "manual" | "rules" | "lexical" | "bge_small" | "hybrid";
export type SemanticEngineId = "lexical" | "bge_small" | "hybrid";

export type TrustClass =
  | "manual_exact"
  | "rule_exact"
  | "approved_exact"
  | "semantic"
  | "unknown";

export type AuthorizableTrustClass = Exclude<TrustClass, "unknown">;

export interface EvidenceText {
  readonly value: string;
  readonly provenance: "zts_generated" | "caller_untrusted" | "engine_generated";
  readonly interpretation: "data_only";
  readonly referencedEntityRefs: readonly EntityRef[];
}

export interface CallerText extends EvidenceText {
  readonly provenance: "caller_untrusted";
}

export interface ZtsMessage {
  readonly value: string;
  readonly provenance: "zts_generated";
  readonly interpretation: "data_only";
}

export interface Patch {
  readonly schemaVersion: "zts.patch.provisional-1";
  readonly snapshotRevision: Sha256Digest;
  readonly operations: readonly PatchMove[];
}

export type PatchDraft = Pick<Patch, "operations">;

export interface PatchMove {
  readonly op: "move";
  /** A nested structural child cannot be targeted independently. */
  readonly entityRef: MovementRootRef;
  readonly expectedSourceWorkspaceId: string;
  readonly destinationWorkspaceId: string;
  readonly reason: CallerText;
}

/** Derives the exact Snapshot binding for untrusted caller-authored intent. */
export function createPatch<T extends PatchDraft>(snapshot: Snapshot, draft: T): Patch {
  validatePatchDraftShape(draft);
  return definePatch(snapshot, {
    schemaVersion: "zts.patch.provisional-1",
    snapshotRevision: snapshot.revision,
    operations: draft.operations
  });
}

/** Validates a parsed Patch against the actual Snapshot it claims to target. */
export function definePatch<T extends Patch>(snapshot: Snapshot, patch: T): T {
  defineSnapshot(snapshot);
  validatePatch(snapshot, patch);
  return deepFreeze(patch);
}

export type IntentSource =
  | {
      readonly kind: "manual_patch";
      readonly intentRevision: Sha256Digest;
    }
  | {
      readonly kind: "engine";
      readonly engine: Exclude<EngineId, "manual">;
      readonly intentRevision: Sha256Digest;
    };

export type AutoApplyEvidence =
  | {
      readonly status: "not_requested";
      readonly requested: false;
      readonly eligible: false;
      readonly reason: ZtsMessage;
    }
  | {
      readonly status: "ineligible";
      readonly requested: true;
      readonly eligible: false;
      readonly reason: ZtsMessage;
    }
  | {
      readonly status: "eligible";
      readonly requested: true;
      readonly eligible: true;
      readonly reason: ZtsMessage;
    };

type NoEligibleAutoApply = Exclude<AutoApplyEvidence, { readonly status: "eligible" }>;

export interface ManualDecisionEvidence {
  readonly engine: "manual";
  readonly trustClass: "manual_exact";
  readonly explanation: EvidenceText;
  readonly evidenceRevision: Sha256Digest;
  readonly autoApply: Extract<AutoApplyEvidence, { readonly status: "not_requested" }>;
}

export interface RuleDecisionEvidence {
  readonly engine: "rules";
  readonly trustClass: "rule_exact";
  readonly explanation: EvidenceText;
  readonly ruleRevision: Sha256Digest;
  readonly autoApply: AutoApplyEvidence;
}

export interface ApprovedDecisionEvidence {
  readonly engine: EngineId;
  readonly trustClass: "approved_exact";
  readonly explanation: EvidenceText;
  readonly approvalRevision: Sha256Digest;
  readonly autoApply: AutoApplyEvidence;
}

export interface SemanticThresholds {
  readonly suggestion: number;
  readonly autoApply: number;
  readonly minimumMargin: number;
}

export interface SemanticDecisionEvidence {
  readonly engine: SemanticEngineId;
  readonly trustClass: "semantic";
  readonly explanation: EvidenceText;
  readonly score: number;
  readonly margin: number;
  readonly thresholds: SemanticThresholds;
  readonly modelRevision: Sha256Digest;
  readonly calibrationRevision: Sha256Digest;
  readonly suggested: boolean;
  readonly autoApply: AutoApplyEvidence;
}

export interface UnknownDecisionEvidence {
  readonly engine: EngineId;
  readonly trustClass: "unknown";
  readonly explanation: EvidenceText;
  readonly evidenceRevision: Sha256Digest;
  readonly autoApply: NoEligibleAutoApply;
}

export type DecisionEvidence =
  | ManualDecisionEvidence
  | RuleDecisionEvidence
  | ApprovedDecisionEvidence
  | SemanticDecisionEvidence
  | UnknownDecisionEvidence;

export interface SemanticDecisionInput {
  readonly engine: SemanticEngineId;
  readonly explanation: EvidenceText;
  readonly score: number;
  readonly margin: number;
  readonly thresholds: SemanticThresholds;
  readonly modelRevision: Sha256Digest;
  readonly calibrationRevision: Sha256Digest;
  readonly autoApplyRequested: boolean;
}

/** Derives suggestion and automatic-apply eligibility from complete evidence. */
export function createSemanticDecision(input: SemanticDecisionInput): SemanticDecisionEvidence {
  validateSemanticInput(input);
  const suggested = input.score >= input.thresholds.suggestion;
  const eligible = input.autoApplyRequested
    && input.score >= input.thresholds.autoApply
    && input.margin >= input.thresholds.minimumMargin;
  const autoApply: AutoApplyEvidence = !input.autoApplyRequested
    ? {
        status: "not_requested",
        requested: false,
        eligible: false,
        reason: ztsMessage("Semantic automatic apply was not requested")
      }
    : eligible
      ? {
          status: "eligible",
          requested: true,
          eligible: true,
          reason: ztsMessage("Score and margin meet the explicit calibrated policy")
        }
      : {
          status: "ineligible",
          requested: true,
          eligible: false,
          reason: ztsMessage("Score or margin is below the explicit calibrated policy")
        };

  return deepFreeze({
    engine: input.engine,
    trustClass: "semantic",
    explanation: input.explanation,
    score: input.score,
    margin: input.margin,
    thresholds: { ...input.thresholds },
    modelRevision: input.modelRevision,
    calibrationRevision: input.calibrationRevision,
    suggested,
    autoApply
  });
}

export type MoveProtectionPrecondition =
  | {
      readonly protected: false;
      readonly reasons: readonly [];
      readonly requiredGrantId: null;
    }
  | {
      readonly protected: true;
      readonly reasons: NonEmptyReadonlyArray<string>;
      readonly protectionRevision: Sha256Digest;
      readonly requiredGrantId: string;
    };

export interface WorkspaceMovePrecondition {
  readonly workspaceId: string;
  readonly protection: MoveProtectionPrecondition;
}

export interface MoveOperation {
  readonly op: "move";
  readonly entityRef: MovementRootRef;
  readonly entityKind: EntityKind;
  readonly precondition: {
    readonly entityRevision: Sha256Digest;
    readonly entityProtection: MoveProtectionPrecondition;
    readonly sourceWorkspace: WorkspaceMovePrecondition;
    readonly destinationWorkspace: WorkspaceMovePrecondition;
  };
  readonly expectedPostState: {
    readonly workspaceId: string;
  };
  readonly inverse: {
    readonly op: "move";
    readonly destinationWorkspaceId: string;
  };
}

export type PlanAction =
  | {
      readonly actionId: string;
      readonly disposition: "move";
      readonly operation: MoveOperation;
      readonly decision: DecisionEvidence;
    }
  | {
      readonly actionId: string;
      readonly disposition: "review" | "protected" | "blocked" | "unchanged";
      readonly entityRef: EntityRef;
      readonly candidateDestinationWorkspaceId: string | null;
      readonly decision: DecisionEvidence;
    };

export type PlanDerivation =
  | {
      readonly kind: "original";
    }
  | {
      readonly kind: "subset";
      readonly parentPlanId: string;
      readonly parentPlanDigest: Sha256Digest;
      readonly selectedActionIds: NonEmptyReadonlyArray<string>;
    };

export interface Plan {
  readonly schemaVersion: "zts.plan.provisional-1";
  readonly id: string;
  readonly digest: Sha256Digest;
  readonly profileId: string;
  readonly snapshotRevision: Sha256Digest;
  readonly snapshotAuthority: "authoritative" | "persisted_observation";
  readonly snapshotFreshness: "current" | "possibly_stale" | "recovery";
  readonly configRevision: Sha256Digest;
  readonly engineManifestRevision: Sha256Digest;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly derivation: PlanDerivation;
  readonly source: IntentSource;
  /** One canonical list. Counts and summaries are derived presentation views. */
  readonly actions: readonly PlanAction[];
}

export type PlanDraft = Omit<
  Plan,
  "digest" | "profileId" | "snapshotRevision" | "snapshotAuthority" | "snapshotFreshness"
>;

/** Constructs a content-addressed Plan, then validates and freezes it. */
export function createPlan<T extends PlanDraft>(
  snapshot: Snapshot,
  draft: T
): T & Pick<Plan, "profileId" | "snapshotRevision" | "snapshotAuthority" | "snapshotFreshness" | "digest"> {
  const content = {
    ...draft,
    profileId: snapshot.profile.id,
    snapshotRevision: snapshot.revision,
    snapshotAuthority: snapshot.authority,
    snapshotFreshness: snapshot.freshness
  };
  const plan = definePlanForSnapshot(snapshot, { ...content, digest: sha256Canonical(content) });
  return plan as T & Pick<Plan, "profileId" | "snapshotRevision" | "snapshotAuthority" | "snapshotFreshness" | "digest">;
}

/** Validates cross-action decision invariants, then freezes the Plan. */
export function definePlan<T extends Plan>(plan: T): T {
  validatePlan(plan);
  return deepFreeze(plan);
}

/** Validates a stored or received Plan against the actual Snapshot it binds. */
export function definePlanForSnapshot<T extends Plan>(snapshot: Snapshot, plan: T): T {
  definePlan(plan);
  validatePlanAgainstSnapshot(snapshot, plan);
  return deepFreeze(plan);
}

interface ProtectionGrantBase {
  readonly id: string;
  readonly revision: Sha256Digest;
  readonly planDigest: Sha256Digest;
  readonly actionId: string;
  readonly protectionRevision: Sha256Digest;
  readonly reasons: NonEmptyReadonlyArray<string>;
  readonly issuedBy: "interactive" | "invocation" | "config";
}

export type ProtectionGrant =
  | (ProtectionGrantBase & {
      readonly subject: {
        readonly kind: "entity";
        readonly entityRef: MovementRootRef;
      };
    })
  | (ProtectionGrantBase & {
      readonly subject: {
        readonly kind: "workspace";
        readonly workspaceId: string;
        readonly participation: "source" | "destination";
      };
    });

export type ProtectionGrantDraft = ProtectionGrant extends infer Grant
  ? Grant extends ProtectionGrant ? Omit<Grant, "revision"> : never
  : never;

export function createProtectionGrant<T extends ProtectionGrantDraft>(draft: T): T & { readonly revision: Sha256Digest } {
  const grant = { ...draft, revision: sha256Canonical(draft) } as T & { readonly revision: Sha256Digest };
  validateProtectionGrantShape(grant);
  return deepFreeze(grant);
}

export type AuthorizationSource =
  | {
      readonly kind: "interactive";
      readonly consentArtifact: ArtifactReference;
    }
  | {
      readonly kind: "unattended_invocation";
      readonly consentArtifact: ArtifactReference;
    }
  | {
      readonly kind: "unattended_config";
      readonly policyRevision: Sha256Digest;
      readonly consentArtifact: ArtifactReference;
    };

export type LifecycleAuthorization =
  | {
      readonly kind: "none";
    }
  | {
      readonly kind: "managed_zen";
      readonly grantRevision: Sha256Digest;
      readonly relaunchRequired: true;
      readonly restoreWindowsRequired: true;
    };

export interface ApplyAuthorization {
  readonly schemaVersion: "zts.authorization.provisional-1";
  readonly id: string;
  readonly revision: Sha256Digest;
  readonly planId: string;
  readonly planDigest: Sha256Digest;
  readonly profileId: string;
  readonly authorizedAt: string;
  readonly expiresAt: string;
  readonly source: AuthorizationSource;
  /**
   * Authorization always covers every executable action in this exact Plan.
   * Applying a subset first creates a derived Plan.
   */
  readonly authorizedActionIds: NonEmptyReadonlyArray<string>;
  readonly allowedTrustClasses: NonEmptyReadonlyArray<AuthorizableTrustClass>;
  readonly protectionGrants: readonly ProtectionGrant[];
  readonly lifecycle: LifecycleAuthorization;
  readonly wholePlanPreflight: true;
}

export type ApplyAuthorizationDraft = Omit<ApplyAuthorization, "revision">;

/** Constructs exact content-bound consent for one executable Plan. */
export function createApplyAuthorization<T extends ApplyAuthorizationDraft>(
  snapshot: Snapshot,
  plan: Plan,
  draft: T
): T & { readonly revision: Sha256Digest } {
  return defineApplyAuthorization(snapshot, plan, { ...draft, revision: sha256Canonical(draft) }) as T & { readonly revision: Sha256Digest };
}

/** Validates exact Plan, action, Trust Class, Protection, and lifecycle consent. */
export function defineApplyAuthorization<T extends ApplyAuthorization>(snapshot: Snapshot, plan: Plan, authorization: T): T {
  validatePlan(plan);
  validatePlanAgainstSnapshot(snapshot, plan);
  validateAuthorization(plan, authorization);
  return deepFreeze(authorization);
}

export interface DomainIssue {
  readonly code: string;
  readonly severity: "info" | "warning" | "error";
  readonly message: ZtsMessage;
  readonly actionId: string | null;
}

interface OperationResultBase {
  readonly actionId: string;
  readonly entityRef: MovementRootRef;
  readonly observedWorkspaceId: string | null;
}

export interface NotAttemptedOperationResult extends OperationResultBase {
  readonly status: "not_attempted";
  readonly mutationAttempted: false;
  readonly netChanged: false;
  readonly issueCodes: NonEmptyReadonlyArray<string>;
}

export interface VerifiedOperationResult extends OperationResultBase {
  readonly status: "verified";
  readonly mutationAttempted: true;
  readonly netChanged: true;
  readonly observedWorkspaceId: string;
  readonly issueCodes: readonly [];
}

export interface FailedOperationResult extends OperationResultBase {
  readonly status: "failed";
  readonly mutationAttempted: true;
  readonly netChanged: boolean | null;
  readonly issueCodes: NonEmptyReadonlyArray<string>;
}

export interface CompensatedOperationResult extends OperationResultBase {
  readonly status: "compensated";
  readonly mutationAttempted: true;
  readonly netChanged: false;
  readonly observedWorkspaceId: string;
  readonly issueCodes: NonEmptyReadonlyArray<string>;
}

export interface CompensationFailedOperationResult extends OperationResultBase {
  readonly status: "compensation_failed";
  readonly mutationAttempted: true;
  readonly netChanged: boolean | null;
  readonly issueCodes: NonEmptyReadonlyArray<string>;
}

export type OperationResult =
  | NotAttemptedOperationResult
  | VerifiedOperationResult
  | FailedOperationResult
  | CompensatedOperationResult
  | CompensationFailedOperationResult;

interface ControlEvidenceBase {
  readonly proof: ArtifactReference;
}

export type CompletedControlEvidence =
  | (ControlEvidenceBase & {
      readonly route: "closed_session";
      readonly exclusiveControlReleased: "verified";
    })
  | (ControlEvidenceBase & {
      readonly route: "managed_zen";
      readonly quit: "verified";
      readonly stateFlush: "verified";
      readonly profileRestoration: "verified";
      readonly relaunch: "verified";
      readonly windowRestoration: "verified";
    })
  | (ControlEvidenceBase & {
      readonly route: "privileged_live";
      readonly sessionBinding: "verified";
      readonly listenerShutdown: "verified";
    })
  | (ControlEvidenceBase & {
      readonly route: "zen_owned";
      readonly controlSessionClosed: "verified";
    });

export type ControlExecutionEvidence =
  | CompletedControlEvidence
  | (ControlEvidenceBase & {
      readonly route: "closed_session";
      readonly exclusiveControlReleased: "not_started" | "unknown" | "failed";
    })
  | (ControlEvidenceBase & {
      readonly route: "managed_zen";
      readonly quit: "not_started" | "verified" | "failed";
      readonly stateFlush: "not_started" | "verified" | "failed";
      readonly profileRestoration: "not_started" | "verified" | "failed";
      readonly relaunch: "not_started" | "verified" | "failed";
      readonly windowRestoration: "not_started" | "verified" | "failed";
    })
  | (ControlEvidenceBase & {
      readonly route: "privileged_live";
      readonly sessionBinding: "not_started" | "verified" | "failed";
      readonly listenerShutdown: "not_started" | "verified" | "failed";
    })
  | (ControlEvidenceBase & {
      readonly route: "zen_owned";
      readonly controlSessionClosed: "not_started" | "verified" | "failed";
    });

interface ReceiptBase {
  readonly schemaVersion: "zts.receipt.provisional-1";
  readonly id: string;
  readonly planId: string;
  readonly planDigest: Sha256Digest;
  readonly authorization: {
    readonly id: string;
    readonly revision: Sha256Digest;
    readonly artifact: ArtifactReference;
  };
  readonly profileId: string;
  readonly beforeSnapshotRevision: Sha256Digest;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly journalArtifact: ArtifactReference;
  readonly issues: readonly DomainIssue[];
}

export interface AppliedReceipt extends ReceiptBase {
  readonly outcome: "applied";
  readonly mutationAttempted: true;
  readonly netChanged: true;
  readonly afterSnapshotRevision: Sha256Digest;
  readonly control: CompletedControlEvidence;
  readonly backupArtifact: ArtifactReference;
  readonly inversePlanArtifact: ArtifactReference;
  readonly recoveryArtifact: null;
  readonly operations: NonEmptyReadonlyArray<VerifiedOperationResult>;
}

export interface BlockedReceipt extends ReceiptBase {
  readonly outcome: "blocked";
  readonly mutationAttempted: false;
  readonly netChanged: false;
  readonly afterSnapshotRevision: null;
  readonly control: ControlExecutionEvidence;
  readonly backupArtifact: null;
  readonly inversePlanArtifact: null;
  readonly recoveryArtifact: null;
  readonly operations: NonEmptyReadonlyArray<NotAttemptedOperationResult>;
}

export interface PartialReceipt extends ReceiptBase {
  readonly outcome: "partial";
  readonly mutationAttempted: true;
  readonly netChanged: boolean | null;
  readonly afterSnapshotRevision: Sha256Digest | null;
  readonly control: ControlExecutionEvidence;
  readonly backupArtifact: ArtifactReference;
  readonly inversePlanArtifact: ArtifactReference | null;
  readonly recoveryArtifact: ArtifactReference;
  readonly operations: NonEmptyReadonlyArray<OperationResult>;
}

export interface CompensatedReceipt extends ReceiptBase {
  readonly outcome: "compensated";
  readonly mutationAttempted: true;
  readonly netChanged: false;
  readonly afterSnapshotRevision: Sha256Digest;
  readonly control: CompletedControlEvidence;
  readonly backupArtifact: ArtifactReference;
  readonly inversePlanArtifact: ArtifactReference;
  readonly recoveryArtifact: ArtifactReference;
  readonly operations: NonEmptyReadonlyArray<OperationResult>;
}

export interface CompensationFailedReceipt extends ReceiptBase {
  readonly outcome: "compensation_failed";
  readonly mutationAttempted: true;
  readonly netChanged: true | null;
  readonly afterSnapshotRevision: Sha256Digest | null;
  readonly control: ControlExecutionEvidence;
  readonly backupArtifact: ArtifactReference;
  readonly inversePlanArtifact: ArtifactReference | null;
  readonly recoveryArtifact: ArtifactReference;
  readonly operations: NonEmptyReadonlyArray<OperationResult>;
}

export interface VerificationFailedReceipt extends ReceiptBase {
  readonly outcome: "verification_failed";
  readonly mutationAttempted: true;
  readonly netChanged: null;
  readonly afterSnapshotRevision: null;
  readonly control: ControlExecutionEvidence;
  readonly backupArtifact: ArtifactReference;
  readonly inversePlanArtifact: ArtifactReference | null;
  readonly recoveryArtifact: ArtifactReference;
  readonly operations: NonEmptyReadonlyArray<OperationResult>;
}

export interface InterruptedReceipt extends ReceiptBase {
  readonly outcome: "interrupted";
  readonly mutationAttempted: boolean;
  readonly netChanged: boolean | null;
  readonly afterSnapshotRevision: null;
  readonly control: ControlExecutionEvidence;
  readonly backupArtifact: ArtifactReference | null;
  readonly inversePlanArtifact: ArtifactReference | null;
  readonly recoveryArtifact: ArtifactReference;
  readonly operations: NonEmptyReadonlyArray<OperationResult>;
}

export type Receipt =
  | AppliedReceipt
  | BlockedReceipt
  | PartialReceipt
  | CompensatedReceipt
  | CompensationFailedReceipt
  | VerificationFailedReceipt
  | InterruptedReceipt;

export type ReceiptOutcome = Receipt["outcome"];

/** Validates exact Plan, authorization, operation ordering, and route evidence. */
export function defineReceipt<T extends Receipt>(
  snapshot: Snapshot,
  plan: Plan,
  authorization: ApplyAuthorization,
  receipt: T
): T {
  validatePlan(plan);
  validatePlanAgainstSnapshot(snapshot, plan);
  validateAuthorization(plan, authorization);
  validateReceipt(plan, authorization, receipt);
  return deepFreeze(receipt);
}

function validatePatch(snapshot: Snapshot, patch: Patch): void {
  validatePatchShape(patch);
  if (patch.schemaVersion !== "zts.patch.provisional-1") throw new Error("Unsupported Patch schema version");
  assertDigest(patch.snapshotRevision, "Patch Snapshot revision");
  if (patch.snapshotRevision !== snapshot.revision) throw new Error("Patch is not bound to the supplied exact Snapshot");
  if (!Array.isArray(patch.operations)) throw new Error("Patch operations must be an array");

  const entities = new Map<EntityRef, Entity>(snapshot.entities.map((entity) => [entity.ref, entity]));
  const workspaces = new Set(snapshot.workspaces.map((workspace) => workspace.id));
  const movedEntities = new Set<MovementRootRef>();
  for (const operation of patch.operations) {
    if (operation.op !== "move") throw new Error("Patch has an unknown Operation");
    if (typeof operation.entityRef !== "string" || !operation.entityRef.startsWith("entity:root:")) {
      throw new Error("Patch move does not target a Movement Root");
    }
    if (movedEntities.has(operation.entityRef)) {
      throw new Error(`Patch moves Entity ${operation.entityRef} more than once`);
    }
    movedEntities.add(operation.entityRef);

    const entity = entities.get(operation.entityRef);
    if (!entity || entity.parentRef !== null || entity.structuralRootRef !== entity.ref) {
      throw new Error(`Patch references Movement Root ${operation.entityRef} outside the Snapshot`);
    }
    if (operation.expectedSourceWorkspaceId !== entity.workspaceId) {
      throw new Error(`Patch source Workspace for ${operation.entityRef} does not match the Snapshot`);
    }
    if (!workspaces.has(operation.destinationWorkspaceId)) {
      throw new Error(`Patch destination Workspace for ${operation.entityRef} is outside the Snapshot`);
    }
    if (operation.destinationWorkspaceId === entity.workspaceId) {
      throw new Error(`Patch move for ${operation.entityRef} does not change Workspace`);
    }
    validateEvidenceText(operation.reason, `Patch reason for ${operation.entityRef}`);
    if (operation.reason.provenance !== "caller_untrusted") {
      throw new Error(`Patch reason for ${operation.entityRef} must remain caller-untrusted`);
    }
    validateEvidenceReferences(operation.reason, entities, `Patch reason for ${operation.entityRef}`);
  }
}

function validatePatchShape(patch: Patch): void {
  assertExactKeys(patch, ["schemaVersion", "snapshotRevision", "operations"], "Patch");
  assertArray(patch.operations, "Patch operations");
  for (const operation of patch.operations) {
    assertExactKeys(operation, [
      "op",
      "entityRef",
      "expectedSourceWorkspaceId",
      "destinationWorkspaceId",
      "reason"
    ], `Patch Operation ${operation.entityRef}`);
    assertEvidenceTextShape(operation.reason, `Patch reason for ${operation.entityRef}`);
  }
}

function validatePatchDraftShape(draft: PatchDraft): void {
  assertExactKeys(draft, ["operations"], "Patch draft");
  assertArray(draft.operations, "Patch draft operations");
  for (const operation of draft.operations) {
    assertExactKeys(operation, [
      "op",
      "entityRef",
      "expectedSourceWorkspaceId",
      "destinationWorkspaceId",
      "reason"
    ], `Patch draft Operation ${operation.entityRef}`);
    assertEvidenceTextShape(operation.reason, `Patch draft reason for ${operation.entityRef}`);
  }
}

function validatePlan(plan: Plan): void {
  validatePlanShape(plan);
  if (plan.schemaVersion !== "zts.plan.provisional-1") throw new Error("Unsupported Plan schema version");
  if (!plan.id.trim() || !plan.profileId.trim()) throw new Error("Plan id and Profile id must not be empty");
  if (plan.snapshotAuthority === "authoritative") {
    if (plan.snapshotFreshness !== "current") throw new Error("Authoritative Plan Snapshot must be current");
  } else if (plan.snapshotAuthority === "persisted_observation") {
    if (!["possibly_stale", "recovery"].includes(plan.snapshotFreshness)) {
      throw new Error("Persisted-observation Plan has invalid freshness");
    }
  } else {
    throw new Error("Plan has an unknown Snapshot authority");
  }
  if (!["manual_patch", "engine"].includes(plan.source.kind)) throw new Error("Plan has an unknown intent source");
  assertDigest(plan.source.intentRevision, "Plan intent revision");
  if (plan.source.kind === "engine" && !["rules", "lexical", "bge_small", "hybrid"].includes(plan.source.engine)) {
    throw new Error("Plan intent source has an unknown Engine");
  }
  assertDigest(plan.digest, "Plan digest");
  assertDigest(plan.snapshotRevision, "Plan Snapshot revision");
  assertDigest(plan.configRevision, "Plan config revision");
  assertDigest(plan.engineManifestRevision, "Plan Engine manifest revision");
  assertTimestamp(plan.createdAt, "Plan createdAt");
  assertTimestamp(plan.expiresAt, "Plan expiresAt");
  if (Date.parse(plan.expiresAt) <= Date.parse(plan.createdAt)) throw new Error("Plan expiry must follow creation");
  validatePlanDerivation(plan);

  const actionIds = new Set<string>();
  const movedEntities = new Set<MovementRootRef>();
  for (const action of plan.actions) {
    if (!["move", "review", "protected", "blocked", "unchanged"].includes(action.disposition)) {
      throw new Error(`Plan action ${action.actionId} has an unknown disposition`);
    }
    if (!action.actionId.trim()) throw new Error("Plan action id must not be empty");
    if (actionIds.has(action.actionId)) throw new Error(`Duplicate Plan action id: ${action.actionId}`);
    actionIds.add(action.actionId);
    validateDecision(action.decision);
    if (plan.source.kind === "manual_patch" && action.decision.engine !== "manual") {
      throw new Error(`Manual Patch action ${action.actionId} has a non-manual decision`);
    }
    if (plan.source.kind === "engine"
      && plan.source.engine !== "hybrid"
      && action.decision.engine !== plan.source.engine) {
      throw new Error(`Action ${action.actionId} Decision Engine does not match the Plan source Engine`);
    }
    if (plan.source.kind === "engine" && plan.source.engine === "hybrid" && action.decision.engine === "manual") {
      throw new Error(`Hybrid Plan action ${action.actionId} cannot contain an unapproved manual decision`);
    }
    if (action.disposition === "move") {
      if (action.operation.op !== "move" || action.operation.inverse.op !== "move") {
        throw new Error(`Action ${action.actionId} has an unknown Operation`);
      }
      if (!["tab", "tab_group", "zen_folder", "split_view"].includes(action.operation.entityKind)) {
        throw new Error(`Action ${action.actionId} has an unknown Entity kind`);
      }
      if (!action.operation.entityRef.startsWith("entity:root:")) {
        throw new Error(`Action ${action.actionId} does not target a Movement Root`);
      }
      if (movedEntities.has(action.operation.entityRef)) {
        throw new Error(`Plan moves Entity ${action.operation.entityRef} more than once`);
      }
      movedEntities.add(action.operation.entityRef);
      assertDigest(action.operation.precondition.entityRevision, `Action ${action.actionId} Entity revision`);
      const sourceWorkspaceId = action.operation.precondition.sourceWorkspace.workspaceId;
      const destinationWorkspaceId = action.operation.precondition.destinationWorkspace.workspaceId;
      if (!sourceWorkspaceId.trim() || !destinationWorkspaceId.trim()) {
        throw new Error(`Action ${action.actionId} has an empty Workspace id`);
      }
      if (sourceWorkspaceId === destinationWorkspaceId) {
        throw new Error(`Action ${action.actionId} has the same source and destination Workspace`);
      }
      if (action.operation.inverse.destinationWorkspaceId !== sourceWorkspaceId) {
        throw new Error(`Action ${action.actionId} inverse does not restore the source Workspace`);
      }
      if (action.operation.expectedPostState.workspaceId !== destinationWorkspaceId) {
        throw new Error(`Action ${action.actionId} expected post-state does not match its destination`);
      }
      validateProtectionPrecondition(action.operation.precondition.entityProtection, `Action ${action.actionId} Entity`);
      validateProtectionPrecondition(action.operation.precondition.sourceWorkspace.protection, `Action ${action.actionId} source Workspace`);
      validateProtectionPrecondition(action.operation.precondition.destinationWorkspace.protection, `Action ${action.actionId} destination Workspace`);
    }
  }
  const { digest: _ignored, ...content } = plan;
  if (plan.digest !== sha256Canonical(content)) throw new Error("Plan digest does not match Plan content");
}

function validatePlanDerivation(plan: Plan): void {
  if (plan.derivation.kind === "original") return;
  if (!plan.derivation.parentPlanId.trim()) throw new Error("Subset Plan requires a parent Plan id");
  assertDigest(plan.derivation.parentPlanDigest, "Subset Plan parent digest");
  if (plan.derivation.parentPlanDigest === plan.digest) throw new Error("Subset Plan cannot derive from itself");
  if (plan.derivation.selectedActionIds.length === 0) throw new Error("Subset Plan requires selected action ids");
  if (new Set(plan.derivation.selectedActionIds).size !== plan.derivation.selectedActionIds.length) {
    throw new Error("Subset Plan selected action ids must be unique");
  }
  if (plan.actions.some((action) => action.disposition !== "move")) {
    throw new Error("Subset Plan may contain only executable move actions");
  }
  if (!sameOrderedValues(plan.derivation.selectedActionIds, plan.actions.map((action) => action.actionId))) {
    throw new Error("Subset Plan selected action ids must match its canonical action list");
  }
}

function validatePlanShape(plan: Plan): void {
  assertExactKeys(plan, [
    "schemaVersion",
    "id",
    "digest",
    "profileId",
    "snapshotRevision",
    "snapshotAuthority",
    "snapshotFreshness",
    "configRevision",
    "engineManifestRevision",
    "createdAt",
    "expiresAt",
    "derivation",
    "source",
    "actions"
  ], "Plan");
  if (plan.derivation.kind === "original") {
    assertExactKeys(plan.derivation, ["kind"], "Original Plan derivation");
  } else if (plan.derivation.kind === "subset") {
    assertExactKeys(plan.derivation, ["kind", "parentPlanId", "parentPlanDigest", "selectedActionIds"], "Subset Plan derivation");
    assertArray(plan.derivation.selectedActionIds, "Subset Plan selected actions");
  } else {
    throw new Error("Plan has an unknown derivation kind");
  }
  if (plan.source.kind === "manual_patch") {
    assertExactKeys(plan.source, ["kind", "intentRevision"], "Plan source");
  } else {
    assertExactKeys(plan.source, ["kind", "engine", "intentRevision"], "Plan source");
  }
  assertArray(plan.actions, "Plan actions");
  for (const action of plan.actions) {
    if (action.disposition === "move") {
      assertExactKeys(action, ["actionId", "disposition", "operation", "decision"], `Plan action ${action.actionId}`);
      assertMoveOperationShape(action.operation, `Plan action ${action.actionId} Operation`);
    } else {
      assertExactKeys(action, [
        "actionId",
        "disposition",
        "entityRef",
        "candidateDestinationWorkspaceId",
        "decision"
      ], `Plan action ${action.actionId}`);
    }
    assertDecisionShape(action.decision, `Plan action ${action.actionId} Decision`);
  }
}

function assertMoveOperationShape(operation: MoveOperation, label: string): void {
  assertExactKeys(operation, [
    "op",
    "entityRef",
    "entityKind",
    "precondition",
    "expectedPostState",
    "inverse"
  ], label);
  assertExactKeys(operation.precondition, [
    "entityRevision",
    "entityProtection",
    "sourceWorkspace",
    "destinationWorkspace"
  ], `${label} precondition`);
  assertMoveProtectionShape(operation.precondition.entityProtection, `${label} Entity Protection`);
  assertWorkspacePreconditionShape(operation.precondition.sourceWorkspace, `${label} source Workspace`);
  assertWorkspacePreconditionShape(operation.precondition.destinationWorkspace, `${label} destination Workspace`);
  assertExactKeys(operation.expectedPostState, ["workspaceId"], `${label} expected post-state`);
  assertExactKeys(operation.inverse, ["op", "destinationWorkspaceId"], `${label} inverse`);
}

function assertWorkspacePreconditionShape(precondition: WorkspaceMovePrecondition, label: string): void {
  assertExactKeys(precondition, ["workspaceId", "protection"], label);
  assertMoveProtectionShape(precondition.protection, `${label} Protection`);
}

function assertMoveProtectionShape(protection: MoveProtectionPrecondition, label: string): void {
  if (protection.protected === true) {
    assertExactKeys(protection, ["protected", "reasons", "protectionRevision", "requiredGrantId"], label);
  } else {
    assertExactKeys(protection, ["protected", "reasons", "requiredGrantId"], label);
  }
  assertArray(protection.reasons, `${label} reasons`);
}

function assertDecisionShape(decision: DecisionEvidence, label: string): void {
  if (decision.trustClass === "semantic") {
    assertExactKeys(decision, [
      "engine",
      "trustClass",
      "explanation",
      "score",
      "margin",
      "thresholds",
      "modelRevision",
      "calibrationRevision",
      "suggested",
      "autoApply"
    ], label);
    assertExactKeys(decision.thresholds, ["suggestion", "autoApply", "minimumMargin"], `${label} thresholds`);
  } else if (decision.trustClass === "rule_exact") {
    assertExactKeys(decision, ["engine", "trustClass", "explanation", "ruleRevision", "autoApply"], label);
  } else if (decision.trustClass === "approved_exact") {
    assertExactKeys(decision, ["engine", "trustClass", "explanation", "approvalRevision", "autoApply"], label);
  } else {
    assertExactKeys(decision, ["engine", "trustClass", "explanation", "evidenceRevision", "autoApply"], label);
  }
  assertEvidenceTextShape(decision.explanation, `${label} explanation`);
  assertAutoApplyShape(decision.autoApply, `${label} automatic-apply`);
}

function assertAutoApplyShape(autoApply: AutoApplyEvidence, label: string): void {
  assertExactKeys(autoApply, ["status", "requested", "eligible", "reason"], label);
  assertZtsMessageShape(autoApply.reason, `${label} reason`);
}

function validatePlanAgainstSnapshot(snapshot: Snapshot, plan: Plan): void {
  defineSnapshot(snapshot);
  if (
    plan.profileId !== snapshot.profile.id
    || plan.snapshotRevision !== snapshot.revision
    || plan.snapshotAuthority !== snapshot.authority
    || plan.snapshotFreshness !== snapshot.freshness
  ) {
    throw new Error("Plan is not bound to the supplied exact Snapshot");
  }

  const entities = new Map<EntityRef, Entity>(snapshot.entities.map((entity) => [entity.ref, entity]));
  const workspaces = new Map(snapshot.workspaces.map((workspace) => [workspace.id, workspace]));
  const plannedEntities = new Set<EntityRef>();
  for (const action of plan.actions) {
    const entityRef = action.disposition === "move" ? action.operation.entityRef : action.entityRef;
    const entity = entities.get(entityRef);
    if (!entity) throw new Error(`Plan action ${action.actionId} references an Entity outside the Snapshot`);
    if (plannedEntities.has(entityRef)) throw new Error(`Plan contains more than one action for Entity ${entityRef}`);
    plannedEntities.add(entityRef);
    validateEvidenceReferences(action.decision.explanation, entities, `Decision explanation for ${action.actionId}`);
    if (action.disposition !== "move") {
      if (action.candidateDestinationWorkspaceId !== null && !workspaces.has(action.candidateDestinationWorkspaceId)) {
        throw new Error(`Plan action ${action.actionId} candidate destination is outside the Snapshot`);
      }
      continue;
    }
    if (entity.parentRef !== null || entity.structuralRootRef !== entity.ref) {
      throw new Error(`Plan action ${action.actionId} does not target a Snapshot Movement Root`);
    }
    if (action.operation.entityKind !== entity.kind || action.operation.precondition.entityRevision !== entity.revision) {
      throw new Error(`Plan action ${action.actionId} Entity precondition does not match the Snapshot`);
    }
    if (!sameProtectionPrecondition(action.operation.precondition.entityProtection, entity.protection)) {
      throw new Error(`Plan action ${action.actionId} Entity Protection does not match the Snapshot`);
    }

    const source = workspaces.get(action.operation.precondition.sourceWorkspace.workspaceId);
    const destination = workspaces.get(action.operation.precondition.destinationWorkspace.workspaceId);
    if (!source || source.id !== entity.workspaceId) {
      throw new Error(`Plan action ${action.actionId} source Workspace does not match the Snapshot`);
    }
    if (!destination) throw new Error(`Plan action ${action.actionId} destination Workspace is outside the Snapshot`);
    if (!sameProtectionPrecondition(action.operation.precondition.sourceWorkspace.protection, source.protection.source)) {
      throw new Error(`Plan action ${action.actionId} source Workspace Protection does not match the Snapshot`);
    }
    if (!sameProtectionPrecondition(action.operation.precondition.destinationWorkspace.protection, destination.protection.destination)) {
      throw new Error(`Plan action ${action.actionId} destination Workspace Protection does not match the Snapshot`);
    }
  }
}

function sameProtectionPrecondition(
  expected: MoveProtectionPrecondition,
  actual: { readonly protected: boolean; readonly reasons: readonly string[] }
): boolean {
  if (expected.protected !== actual.protected || !sameOrderedValues(expected.reasons, actual.reasons)) return false;
  if (!actual.protected) return expected.requiredGrantId === null;
  if (!expected.protected) return false;
  return expected.protectionRevision === sha256Canonical(actual) && Boolean(expected.requiredGrantId.trim());
}

function validateProtectionPrecondition(protection: MoveProtectionPrecondition, label: string): void {
  if (protection.protected !== true && protection.protected !== false) {
    throw new Error(`${label} has an invalid Protection discriminant`);
  }
  if (protection.protected) {
    assertDigest(protection.protectionRevision, `${label} Protection revision`);
    if (!protection.requiredGrantId.trim()) throw new Error(`${label} requires a Protection grant id`);
    if (protection.reasons.length === 0 || protection.reasons.some((reason) => !reason.trim())) {
      throw new Error(`${label} requires non-empty Protection reasons`);
    }
    return;
  }
  if (protection.requiredGrantId !== null || protection.reasons.length !== 0) {
    throw new Error(`${label} has contradictory unprotected state`);
  }
}

function validateDecision(decision: DecisionEvidence): void {
  validateEvidenceText(decision.explanation, "Decision explanation");
  validateZtsMessage(decision.autoApply.reason, "Automatic-apply reason");
  if (!["manual", "rules", "lexical", "bge_small", "hybrid"].includes(decision.engine)) {
    throw new Error("Decision has an unknown Engine");
  }
  if (!["manual_exact", "rule_exact", "approved_exact", "semantic", "unknown"].includes(decision.trustClass)) {
    throw new Error("Decision has an unknown Trust Class");
  }
  if (!["not_requested", "ineligible", "eligible"].includes(decision.autoApply.status)) {
    throw new Error("Decision has an invalid automatic-apply status");
  }
  if (
    (decision.autoApply.status === "eligible" && (!decision.autoApply.requested || !decision.autoApply.eligible))
    || (decision.autoApply.status === "ineligible" && (!decision.autoApply.requested || decision.autoApply.eligible))
    || (decision.autoApply.status === "not_requested" && (decision.autoApply.requested || decision.autoApply.eligible))
  ) {
    throw new Error("Decision has contradictory automatic-apply evidence");
  }
  if (decision.trustClass === "semantic") {
    const derived = createSemanticDecision({
      engine: decision.engine,
      explanation: decision.explanation,
      score: decision.score,
      margin: decision.margin,
      thresholds: decision.thresholds,
      modelRevision: decision.modelRevision,
      calibrationRevision: decision.calibrationRevision,
      autoApplyRequested: decision.autoApply.requested
    });
    if (decision.suggested !== derived.suggested || decision.autoApply.status !== derived.autoApply.status) {
      throw new Error("Semantic decision eligibility was not derived from its evidence");
    }
    return;
  }
  if (decision.trustClass === "manual_exact") {
    if (decision.engine !== "manual" || decision.autoApply.status !== "not_requested") {
      throw new Error("Manual exact decision has mismatched Engine or automatic-apply evidence");
    }
    assertDigest(decision.evidenceRevision, "Manual decision evidence revision");
    return;
  }
  if (decision.trustClass === "rule_exact") {
    if (decision.engine !== "rules") throw new Error("Rule exact decision must use the rules Engine");
    assertDigest(decision.ruleRevision, "Rule decision revision");
    return;
  }
  if (decision.trustClass === "approved_exact") {
    assertDigest(decision.approvalRevision, "Approved decision revision");
    return;
  }
  if ((decision.autoApply as AutoApplyEvidence).status === "eligible") {
    throw new Error("Unknown decision cannot be eligible for automatic apply");
  }
  assertDigest(decision.evidenceRevision, "Unknown decision evidence revision");
}

function validateSemanticInput(input: SemanticDecisionInput): void {
  assertExactKeys(input, [
    "engine",
    "explanation",
    "score",
    "margin",
    "thresholds",
    "modelRevision",
    "calibrationRevision",
    "autoApplyRequested"
  ], "Semantic decision input");
  assertExactKeys(input.thresholds, ["suggestion", "autoApply", "minimumMargin"], "Semantic decision thresholds");
  validateEvidenceText(input.explanation, "Semantic explanation");
  validateUnitInterval(input.score, "Semantic score");
  validateUnitInterval(input.margin, "Semantic margin");
  validateUnitInterval(input.thresholds.suggestion, "Semantic suggestion threshold");
  validateUnitInterval(input.thresholds.autoApply, "Semantic automatic-apply threshold");
  validateUnitInterval(input.thresholds.minimumMargin, "Semantic minimum margin");
  if (input.thresholds.suggestion > input.thresholds.autoApply) {
    throw new Error("Semantic suggestion threshold cannot exceed the automatic-apply threshold");
  }
  assertDigest(input.modelRevision, "Semantic model revision");
  assertDigest(input.calibrationRevision, "Semantic calibration revision");
}

function validateAuthorization(plan: Plan, authorization: ApplyAuthorization): void {
  validateAuthorizationShape(authorization);
  if (authorization.schemaVersion !== "zts.authorization.provisional-1") {
    throw new Error("Unsupported Apply Authorization schema version");
  }
  if (!authorization.id.trim()) throw new Error("Authorization id must not be empty");
  if (plan.snapshotAuthority !== "authoritative" || plan.snapshotFreshness !== "current") {
    throw new Error("Apply Authorization requires a current authoritative Plan Snapshot");
  }
  if (authorization.wholePlanPreflight !== true) throw new Error("Authorization must require whole-Plan preflight");
  assertDigest(authorization.revision, "Authorization revision");
  if (authorization.planId !== plan.id || authorization.planDigest !== plan.digest) {
    throw new Error("Authorization is not bound to this exact Plan");
  }
  if (authorization.profileId !== plan.profileId) throw new Error("Authorization Profile does not match the Plan");
  assertTimestamp(authorization.authorizedAt, "Authorization authorizedAt");
  assertTimestamp(authorization.expiresAt, "Authorization expiresAt");
  if (Date.parse(authorization.expiresAt) <= Date.parse(authorization.authorizedAt)) {
    throw new Error("Authorization expiry must follow authorization time");
  }
  if (Date.parse(authorization.authorizedAt) < Date.parse(plan.createdAt) || Date.parse(authorization.expiresAt) > Date.parse(plan.expiresAt)) {
    throw new Error("Authorization validity must remain within the Plan validity window");
  }
  if (!["interactive", "unattended_invocation", "unattended_config"].includes(authorization.source.kind)) {
    throw new Error("Authorization has an unknown consent source");
  }
  assertArtifact(authorization.source.consentArtifact, "Authorization consent artifact");
  if (authorization.source.kind === "unattended_config") {
    assertDigest(authorization.source.policyRevision, "Authorization policy revision");
  }
  if (!["none", "managed_zen"].includes(authorization.lifecycle.kind)) {
    throw new Error("Authorization has an unknown lifecycle grant kind");
  }
  if (authorization.lifecycle.kind === "managed_zen") {
    assertDigest(authorization.lifecycle.grantRevision, "Managed Zen lifecycle grant");
    if (authorization.lifecycle.relaunchRequired !== true || authorization.lifecycle.restoreWindowsRequired !== true) {
      throw new Error("Managed Zen lifecycle Authorization must require relaunch and window restoration");
    }
  }

  const moveActions = plan.actions.filter((action): action is Extract<PlanAction, { readonly disposition: "move" }> =>
    action.disposition === "move"
  );
  if (moveActions.length === 0) throw new Error("A no-change Plan does not need Apply Authorization");
  const expectedIds = moveActions.map((action) => action.actionId);
  if (!sameOrderedValues(expectedIds, authorization.authorizedActionIds)) {
    throw new Error("Authorization must cover every executable action in deterministic Plan order");
  }

  const allowedTrust = new Set<TrustClass>(authorization.allowedTrustClasses);
  const requiredGrantIds = new Set<string>();
  const seenGrantIds = new Set<string>();
  for (const grant of authorization.protectionGrants) {
    if (seenGrantIds.has(grant.id)) throw new Error(`Duplicate Protection grant ${grant.id}`);
    seenGrantIds.add(grant.id);
    if (!["interactive", "invocation", "config"].includes(grant.issuedBy)) {
      throw new Error(`Protection grant ${grant.id} has an unknown issuer`);
    }
    if (!["entity", "workspace"].includes(grant.subject.kind)) {
      throw new Error(`Protection grant ${grant.id} has an unknown subject`);
    }
    assertDigest(grant.revision, `Protection grant ${grant.id} revision`);
    assertDigest(grant.protectionRevision, `Protection grant ${grant.id} Protection revision`);
    const { revision: _ignored, ...grantContent } = grant;
    if (grant.revision !== sha256Canonical(grantContent)) {
      throw new Error(`Protection grant ${grant.id} revision does not match its content`);
    }
  }
  for (const action of moveActions) {
    if (action.decision.trustClass === "unknown" || !allowedTrust.has(action.decision.trustClass)) {
      throw new Error(`Authorization does not cover Trust Class for ${action.actionId}`);
    }
    if (authorization.source.kind === "unattended_config" && action.decision.autoApply.status !== "eligible") {
      throw new Error(`Configured unattended apply is not eligible for ${action.actionId}`);
    }
    for (const expectation of protectionExpectations(action)) {
      if (!expectation.protection.protected) continue;
      requiredGrantIds.add(expectation.protection.requiredGrantId);
      const grant = authorization.protectionGrants.find((candidate) => candidate.id === expectation.protection.requiredGrantId);
      if (!grant) throw new Error(`Missing Protection grant for ${action.actionId} ${expectation.label}`);
      if (
        grant.planDigest !== plan.digest
        || grant.actionId !== action.actionId
        || grant.protectionRevision !== expectation.protection.protectionRevision
        || !sameOrderedValues(grant.reasons, expectation.protection.reasons)
        || !sameProtectionSubject(grant.subject, expectation.subject)
      ) {
        throw new Error(`Protection grant ${grant.id} does not match ${action.actionId} ${expectation.label}`);
      }
    }
  }

  const extraGrant = authorization.protectionGrants.find((grant) => !requiredGrantIds.has(grant.id));
  if (extraGrant) throw new Error(`Authorization contains unused Protection grant ${extraGrant.id}`);
  const { revision: _ignored, ...content } = authorization;
  if (authorization.revision !== sha256Canonical(content)) {
    throw new Error("Authorization revision does not match Authorization content");
  }
}

function validateAuthorizationShape(authorization: ApplyAuthorization): void {
  assertExactKeys(authorization, [
    "schemaVersion",
    "id",
    "revision",
    "planId",
    "planDigest",
    "profileId",
    "authorizedAt",
    "expiresAt",
    "source",
    "authorizedActionIds",
    "allowedTrustClasses",
    "protectionGrants",
    "lifecycle",
    "wholePlanPreflight"
  ], "Apply Authorization");
  if (authorization.source.kind === "unattended_config") {
    assertExactKeys(authorization.source, ["kind", "policyRevision", "consentArtifact"], "Authorization source");
  } else {
    assertExactKeys(authorization.source, ["kind", "consentArtifact"], "Authorization source");
  }
  assertArtifactShape(authorization.source.consentArtifact, "Authorization consent artifact");
  assertArray(authorization.authorizedActionIds, "Authorization action ids");
  assertArray(authorization.allowedTrustClasses, "Authorization Trust Classes");
  assertArray(authorization.protectionGrants, "Authorization Protection grants");
  for (const grant of authorization.protectionGrants) validateProtectionGrantShape(grant);
  if (authorization.lifecycle.kind === "managed_zen") {
    assertExactKeys(authorization.lifecycle, [
      "kind",
      "grantRevision",
      "relaunchRequired",
      "restoreWindowsRequired"
    ], "Authorization lifecycle");
  } else {
    assertExactKeys(authorization.lifecycle, ["kind"], "Authorization lifecycle");
  }
}

function validateProtectionGrantShape(grant: ProtectionGrant): void {
  assertExactKeys(grant, [
    "id",
    "revision",
    "planDigest",
    "actionId",
    "protectionRevision",
    "reasons",
    "issuedBy",
    "subject"
  ], `Protection grant ${grant.id}`);
  assertArray(grant.reasons, `Protection grant ${grant.id} reasons`);
  if (grant.subject.kind === "entity") {
    assertExactKeys(grant.subject, ["kind", "entityRef"], `Protection grant ${grant.id} subject`);
  } else {
    assertExactKeys(grant.subject, [
      "kind",
      "workspaceId",
      "participation"
    ], `Protection grant ${grant.id} subject`);
  }
}

type ProtectionSubject = ProtectionGrant["subject"];

function protectionExpectations(action: Extract<PlanAction, { readonly disposition: "move" }>): readonly {
  label: string;
  protection: MoveProtectionPrecondition;
  subject: ProtectionSubject;
}[] {
  return [
    {
      label: "Entity",
      protection: action.operation.precondition.entityProtection,
      subject: { kind: "entity", entityRef: action.operation.entityRef }
    },
    {
      label: "source Workspace",
      protection: action.operation.precondition.sourceWorkspace.protection,
      subject: {
        kind: "workspace",
        workspaceId: action.operation.precondition.sourceWorkspace.workspaceId,
        participation: "source"
      }
    },
    {
      label: "destination Workspace",
      protection: action.operation.precondition.destinationWorkspace.protection,
      subject: {
        kind: "workspace",
        workspaceId: action.operation.precondition.destinationWorkspace.workspaceId,
        participation: "destination"
      }
    }
  ];
}

function sameProtectionSubject(left: ProtectionSubject, right: ProtectionSubject): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === "entity" && right.kind === "entity") return left.entityRef === right.entityRef;
  if (left.kind === "workspace" && right.kind === "workspace") {
    return left.workspaceId === right.workspaceId && left.participation === right.participation;
  }
  return false;
}

function validateReceipt(plan: Plan, authorization: ApplyAuthorization, receipt: Receipt): void {
  validateReceiptShape(receipt);
  if (receipt.schemaVersion !== "zts.receipt.provisional-1") throw new Error("Unsupported Receipt schema version");
  if (!["applied", "blocked", "partial", "compensated", "compensation_failed", "verification_failed", "interrupted"].includes(receipt.outcome)) {
    throw new Error("Receipt has an unknown outcome");
  }
  if (!["closed_session", "managed_zen", "privileged_live", "zen_owned"].includes(receipt.control.route)) {
    throw new Error("Receipt has an unknown Control Route");
  }
  if (receipt.planId !== plan.id || receipt.planDigest !== plan.digest) throw new Error("Receipt does not match the exact Plan");
  if (receipt.profileId !== plan.profileId) throw new Error("Receipt Profile does not match the Plan");
  if (receipt.beforeSnapshotRevision !== plan.snapshotRevision) throw new Error("Receipt before-Snapshot does not match the Plan");
  if (receipt.authorization.id !== authorization.id || receipt.authorization.revision !== authorization.revision) {
    throw new Error("Receipt does not match the exact Authorization");
  }
  assertArtifact(receipt.authorization.artifact, "Receipt Authorization artifact");
  if (receipt.authorization.artifact.digest !== authorization.revision) {
    throw new Error("Receipt Authorization artifact does not match the Authorization revision");
  }
  assertArtifact(receipt.journalArtifact, "Receipt journal artifact");
  assertArtifact(receipt.control.proof, "Receipt Control Route proof");
  if (receipt.backupArtifact) assertArtifact(receipt.backupArtifact, "Receipt backup artifact");
  if (receipt.inversePlanArtifact) assertArtifact(receipt.inversePlanArtifact, "Receipt inverse Plan artifact");
  if (receipt.recoveryArtifact) assertArtifact(receipt.recoveryArtifact, "Receipt recovery artifact");
  assertDigest(receipt.beforeSnapshotRevision, "Receipt before-Snapshot revision");
  if (receipt.afterSnapshotRevision) assertDigest(receipt.afterSnapshotRevision, "Receipt after-Snapshot revision");
  assertTimestamp(receipt.startedAt, "Receipt startedAt");
  assertTimestamp(receipt.completedAt, "Receipt completedAt");
  if (Date.parse(receipt.startedAt) < Date.parse(authorization.authorizedAt) || Date.parse(receipt.startedAt) >= Date.parse(authorization.expiresAt)) {
    throw new Error("Receipt mutation did not begin within the Authorization window");
  }
  if (Date.parse(receipt.completedAt) < Date.parse(receipt.startedAt)) throw new Error("Receipt completion precedes start");

  validateControlEvidence(receipt.control);

  if (authorization.lifecycle.kind === "managed_zen" && receipt.control.route !== "managed_zen") {
    throw new Error("Managed Zen lifecycle Authorization requires the managed Control Route");
  }
  if (authorization.lifecycle.kind === "none" && receipt.control.route === "managed_zen") {
    throw new Error("Managed Zen Control Route requires separate lifecycle Authorization");
  }
  if ((receipt.outcome === "applied" || receipt.outcome === "compensated") && !isCompletedControl(receipt.control)) {
    throw new Error(`${receipt.outcome} Receipt requires completed Control Route evidence`);
  }

  const resultIds = receipt.operations.map((operation) => operation.actionId);
  if (!sameOrderedValues(resultIds, authorization.authorizedActionIds)) {
    throw new Error("Receipt must report every authorized Operation in deterministic order");
  }
  let executionStopped = false;
  for (const operation of receipt.operations) {
    const action = plan.actions.find((candidate) => candidate.actionId === operation.actionId);
    if (!action || action.disposition !== "move" || action.operation.entityRef !== operation.entityRef) {
      throw new Error(`Receipt Operation ${operation.actionId} does not match the Plan`);
    }
    validateOperationResult(operation, action);
    // Closed-session publication commits one complete session-file image, so
    // every Operation in that image is attempted together before independent
    // verification. Other routes remain strictly stop-after-first-failure.
    const closedSessionBatchUncertain = receipt.control.route === "closed_session"
      && (receipt.outcome === "interrupted" || receipt.outcome === "verification_failed");
    if (executionStopped && operation.status !== "not_attempted" && !closedSessionBatchUncertain) {
      throw new Error(`Receipt Operation ${operation.actionId} was attempted after execution stopped`);
    }
    if (operation.status === "failed" || operation.status === "not_attempted") {
      executionStopped = true;
    }
  }
  const anyOperationAttempted = receipt.operations.some((operation) => operation.mutationAttempted);
  if (receipt.mutationAttempted !== anyOperationAttempted) {
    throw new Error("Receipt mutation-attempt state disagrees with its Operation results");
  }
  const aggregateNetChanged = receipt.operations.some((operation) => operation.netChanged === null)
    ? null
    : receipt.operations.some((operation) => operation.netChanged === true);
  if (receipt.netChanged !== aggregateNetChanged) {
    throw new Error("Receipt net-change state disagrees with its Operation results");
  }
  for (const issue of receipt.issues) {
    if (!issue.code.trim()) throw new Error("Receipt issues require a code");
    validateZtsMessage(issue.message, "Receipt issue message");
    if (issue.actionId !== null && !resultIds.includes(issue.actionId)) {
      throw new Error(`Receipt issue references unknown action ${issue.actionId}`);
    }
  }
  validateReceiptOutcome(receipt);
}

function validateReceiptShape(receipt: Receipt): void {
  assertExactKeys(receipt, [
    "schemaVersion",
    "id",
    "planId",
    "planDigest",
    "authorization",
    "profileId",
    "beforeSnapshotRevision",
    "startedAt",
    "completedAt",
    "journalArtifact",
    "issues",
    "outcome",
    "mutationAttempted",
    "netChanged",
    "afterSnapshotRevision",
    "control",
    "backupArtifact",
    "inversePlanArtifact",
    "recoveryArtifact",
    "operations"
  ], "Receipt");
  assertExactKeys(receipt.authorization, ["id", "revision", "artifact"], "Receipt Authorization reference");
  assertArtifactShape(receipt.authorization.artifact, "Receipt Authorization artifact");
  assertArtifactShape(receipt.journalArtifact, "Receipt journal artifact");
  assertControlShape(receipt.control);
  if (receipt.backupArtifact !== null) assertArtifactShape(receipt.backupArtifact, "Receipt backup artifact");
  if (receipt.inversePlanArtifact !== null) assertArtifactShape(receipt.inversePlanArtifact, "Receipt inverse Plan artifact");
  if (receipt.recoveryArtifact !== null) assertArtifactShape(receipt.recoveryArtifact, "Receipt recovery artifact");
  assertArray(receipt.operations, "Receipt operations");
  for (const operation of receipt.operations) assertOperationResultShape(operation);
  assertArray(receipt.issues, "Receipt issues");
  for (const issue of receipt.issues) {
    assertExactKeys(issue, ["code", "severity", "message", "actionId"], `Receipt issue ${issue.code}`);
    assertZtsMessageShape(issue.message, `Receipt issue ${issue.code} message`);
  }
}

function assertControlShape(control: ControlExecutionEvidence): void {
  if (control.route === "closed_session") {
    assertExactKeys(control, ["route", "proof", "exclusiveControlReleased"], "Receipt closed-session control");
  } else if (control.route === "managed_zen") {
    assertExactKeys(control, [
      "route",
      "proof",
      "quit",
      "stateFlush",
      "profileRestoration",
      "relaunch",
      "windowRestoration"
    ], "Receipt managed-Zen control");
  } else if (control.route === "privileged_live") {
    assertExactKeys(control, ["route", "proof", "sessionBinding", "listenerShutdown"], "Receipt privileged-live control");
  } else if (control.route === "zen_owned") {
    assertExactKeys(control, ["route", "proof", "controlSessionClosed"], "Receipt Zen-owned control");
  } else {
    throw new Error("Receipt has an unknown Control Route");
  }
  assertArtifactShape(control.proof, "Receipt Control Route proof");
}

function assertOperationResultShape(operation: OperationResult): void {
  assertExactKeys(operation, [
    "actionId",
    "entityRef",
    "observedWorkspaceId",
    "status",
    "mutationAttempted",
    "netChanged",
    "issueCodes"
  ], `Receipt Operation ${operation.actionId}`);
  assertArray(operation.issueCodes, `Receipt Operation ${operation.actionId} issues`);
}

function validateEvidenceText(text: EvidenceText, label: string): void {
  assertEvidenceTextShape(text, label);
  if (typeof text.value !== "string" || !text.value.trim()) throw new Error(`${label} must not be empty`);
  if (!["zts_generated", "caller_untrusted", "engine_generated"].includes(text.provenance)) {
    throw new Error(`${label} has unknown provenance`);
  }
  if (text.interpretation !== "data_only") throw new Error(`${label} must be marked data-only`);
  if (!Array.isArray(text.referencedEntityRefs)
    || text.referencedEntityRefs.some((ref) => typeof ref !== "string" || !ref.trim())) {
    throw new Error(`${label} requires valid Entity-reference provenance`);
  }
  if (new Set(text.referencedEntityRefs).size !== text.referencedEntityRefs.length) {
    throw new Error(`${label} repeats an Entity reference`);
  }
}

function validateEvidenceReferences(
  text: EvidenceText,
  entities: ReadonlyMap<EntityRef, Entity>,
  label: string
): void {
  for (const ref of text.referencedEntityRefs) {
    if (!entities.has(ref)) throw new Error(`${label} references an Entity outside the Snapshot`);
  }
}

function validateZtsMessage(message: ZtsMessage, label: string): void {
  assertZtsMessageShape(message, label);
  if (typeof message.value !== "string"
    || !message.value.trim()
    || message.provenance !== "zts_generated"
    || message.interpretation !== "data_only") {
    throw new Error(`${label} must be non-empty zts-generated data`);
  }
}

function ztsMessage(value: string): ZtsMessage {
  return { value, provenance: "zts_generated", interpretation: "data_only" };
}

function assertEvidenceTextShape(text: EvidenceText, label: string): void {
  assertExactKeys(text, ["value", "provenance", "interpretation", "referencedEntityRefs"], label);
  assertArray(text.referencedEntityRefs, `${label} Entity references`);
}

function assertZtsMessageShape(message: ZtsMessage, label: string): void {
  assertExactKeys(message, ["value", "provenance", "interpretation"], label);
}

function validateOperationResult(
  operation: OperationResult,
  action: Extract<PlanAction, { readonly disposition: "move" }>
): void {
  if (!["not_attempted", "verified", "failed", "compensated", "compensation_failed"].includes(operation.status)) {
    throw new Error(`Operation ${operation.actionId} has an unknown status`);
  }
  if (operation.status === "not_attempted") {
    if (operation.mutationAttempted || operation.netChanged || operation.issueCodes.length === 0) {
      throw new Error(`Not-attempted Operation ${operation.actionId} has contradictory state`);
    }
    return;
  }
  if (operation.status === "verified") {
    if (!operation.mutationAttempted || !operation.netChanged || operation.observedWorkspaceId === null || operation.issueCodes.length !== 0) {
      throw new Error(`Verified Operation ${operation.actionId} has contradictory state`);
    }
    if (operation.observedWorkspaceId !== action.operation.expectedPostState.workspaceId) {
      throw new Error(`Verified Operation ${operation.actionId} observed the wrong Workspace`);
    }
    return;
  }
  if (!operation.mutationAttempted || operation.issueCodes.length === 0) {
    throw new Error(`${operation.status} Operation ${operation.actionId} lacks mutation or issue evidence`);
  }
  if (operation.status === "compensated" && (operation.netChanged || operation.observedWorkspaceId === null)) {
    throw new Error(`Compensated Operation ${operation.actionId} has contradictory final state`);
  }
  if (operation.status === "compensated" && operation.observedWorkspaceId !== action.operation.precondition.sourceWorkspace.workspaceId) {
    throw new Error(`Compensated Operation ${operation.actionId} did not return to its source Workspace`);
  }
}

function validateReceiptOutcome(receipt: Receipt): void {
  // Parsed artifacts reach this validator before they can be trusted as the
  // discriminated Receipt union, so use a deliberately broad runtime view.
  const runtime = receipt as unknown as {
    outcome: string;
    mutationAttempted: boolean;
    netChanged: boolean | null;
    afterSnapshotRevision: string | null;
    backupArtifact: ArtifactReference | null;
    inversePlanArtifact: ArtifactReference | null;
    recoveryArtifact: ArtifactReference | null;
    operations: readonly OperationResult[];
  };
  if (runtime.outcome === "applied") {
    if (
      !runtime.mutationAttempted
      || !runtime.netChanged
      || !runtime.afterSnapshotRevision
      || !runtime.backupArtifact
      || !runtime.inversePlanArtifact
      || runtime.recoveryArtifact !== null
    ) {
      throw new Error("Applied Receipt has contradictory top-level state");
    }
    if (runtime.operations.some((operation) => operation.status !== "verified")) {
      throw new Error("Applied Receipt contains a non-verified Operation");
    }
    if (runtime.afterSnapshotRevision === receipt.beforeSnapshotRevision) {
      throw new Error("Applied Receipt after-Snapshot did not change");
    }
    return;
  }
  if (runtime.outcome === "blocked") {
    if (runtime.mutationAttempted || runtime.netChanged || runtime.afterSnapshotRevision !== null) {
      throw new Error("Blocked Receipt claims mutation or post-state");
    }
    if (runtime.backupArtifact || runtime.inversePlanArtifact || runtime.recoveryArtifact) {
      throw new Error("Blocked Receipt cannot claim mutation recovery artifacts");
    }
    if (runtime.operations.some((operation) => operation.status !== "not_attempted")) {
      throw new Error("Blocked Receipt contains an attempted Operation");
    }
    return;
  }
  if (runtime.outcome === "interrupted") {
    if (!runtime.recoveryArtifact) throw new Error("Interrupted Receipt must preserve a recovery artifact");
    if (runtime.mutationAttempted && !runtime.backupArtifact) {
      throw new Error("Interrupted Receipt after mutation requires a backup artifact");
    }
    return;
  }
  if (!runtime.mutationAttempted) throw new Error(`${runtime.outcome} Receipt must record a mutation attempt`);
  if (!runtime.operations.some((operation) => operation.mutationAttempted)) {
    throw new Error(`${runtime.outcome} Receipt has no attempted Operation`);
  }
  if (!runtime.backupArtifact || !runtime.recoveryArtifact) {
    throw new Error(`${runtime.outcome} Receipt requires backup and recovery artifacts`);
  }
  if (runtime.outcome === "compensated") {
    if (runtime.netChanged || !runtime.afterSnapshotRevision || !runtime.inversePlanArtifact) {
      throw new Error("Compensated Receipt has contradictory final state");
    }
    if (!runtime.operations.some((operation) => operation.status === "compensated")) {
      throw new Error("Compensated Receipt contains no compensated Operation");
    }
    if (runtime.operations.some((operation) =>
      operation.status === "verified"
      || operation.status === "compensation_failed"
      || operation.netChanged !== false
    )) {
      throw new Error("Compensated Receipt retains an uncompensated change");
    }
    if (runtime.afterSnapshotRevision !== receipt.beforeSnapshotRevision) {
      throw new Error("Compensated Receipt did not restore the before-Snapshot revision");
    }
    return;
  }
  if (runtime.outcome === "verification_failed" && runtime.netChanged !== null) {
    throw new Error(`${runtime.outcome} Receipt must report unknown net state`);
  }
  if (runtime.outcome === "compensation_failed"
    && !runtime.operations.some((operation) => operation.status === "compensation_failed")) {
    throw new Error("Compensation-failed Receipt contains no compensation failure");
  }
  if ((runtime.outcome === "partial" || runtime.outcome === "verification_failed")
    && !runtime.operations.some((operation) => operation.status === "failed" || operation.status === "compensation_failed")) {
    throw new Error(`${runtime.outcome} Receipt contains no failed Operation`);
  }
  if (!["partial", "compensation_failed", "verification_failed"].includes(runtime.outcome)) {
    throw new Error(`Unknown Receipt outcome: ${runtime.outcome}`);
  }
}

function validateControlEvidence(control: ControlExecutionEvidence): void {
  if (control.route === "closed_session") {
    if (!["not_started", "unknown", "failed", "verified"].includes(control.exclusiveControlReleased)) {
      throw new Error("Closed-session Control evidence has an invalid release status");
    }
    return;
  }
  if (control.route === "managed_zen") {
    for (const status of [control.quit, control.stateFlush, control.profileRestoration, control.relaunch, control.windowRestoration]) {
      if (!["not_started", "verified", "failed"].includes(status)) {
        throw new Error("Managed Zen Control evidence has an invalid lifecycle status");
      }
    }
    return;
  }
  if (control.route === "privileged_live") {
    if (!["not_started", "verified", "failed"].includes(control.sessionBinding)
      || !["not_started", "verified", "failed"].includes(control.listenerShutdown)) {
      throw new Error("Privileged-live Control evidence has an invalid status");
    }
    return;
  }
  if (control.route === "zen_owned") {
    if (!["not_started", "verified", "failed"].includes(control.controlSessionClosed)) {
      throw new Error("Zen-owned Control evidence has an invalid closure status");
    }
    return;
  }
  throw new Error("Unknown Control Route evidence");
}

function isCompletedControl(control: ControlExecutionEvidence): control is CompletedControlEvidence {
  if (control.route === "closed_session") return control.exclusiveControlReleased === "verified";
  if (control.route === "managed_zen") {
    return control.quit === "verified"
      && control.stateFlush === "verified"
      && control.profileRestoration === "verified"
      && control.relaunch === "verified"
      && control.windowRestoration === "verified";
  }
  if (control.route === "privileged_live") {
    return control.sessionBinding === "verified" && control.listenerShutdown === "verified";
  }
  if (control.route === "zen_owned") return control.controlSessionClosed === "verified";
  return false;
}

function validateUnitInterval(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error(`${label} must be between 0 and 1`);
}

function sameOrderedValues(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function assertArtifact(artifact: ArtifactReference, label: string): void {
  assertArtifactShape(artifact, label);
  if (!artifact.id.trim()) throw new Error(`${label} id must not be empty`);
  assertDigest(artifact.digest, `${label} digest`);
}

function assertArtifactShape(artifact: ArtifactReference, label: string): void {
  assertExactKeys(artifact, ["id", "digest"], label);
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

function assertArray(value: unknown, label: string): asserts value is readonly unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return value;
}
