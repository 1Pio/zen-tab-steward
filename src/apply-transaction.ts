import { randomUUID } from "node:crypto";
import { readdir } from "node:fs/promises";
import { AtomicFileMismatchError } from "./atomic-file-cas.js";
import {
  applyArtifactLayout as applyLayout,
  artifactObjectPath as objectPath,
  artifactReference as artifact,
  digestHex,
  readApplyArtifactLayout,
  safeArtifactSegment as safeSegment
} from "./apply-artifacts.js";
import { appendApplyJournal, createApplyJournal } from "./apply-journal.js";
import {
  ApplyUnfinishedMarkerLimitError,
  hasApplyUnfinishedIndex,
  initializeApplyUnfinishedIndex,
  prepareApplyUnfinishedMarker,
  publishApplyUnfinishedMarker,
  readApplyUnfinishedMarkers,
  reconcileApplyUnfinishedIndexPublication,
  removeApplyUnfinishedMarker
} from "./apply-unfinished-store.js";
import {
  defineApplyReceiptSummary,
  findApplyReceiptSummary,
  preflightApplyReceiptCapacity,
  publishApplyReceipt,
  readApplyReceiptSummaryPage,
  readApplyReceiptPublicationIntent,
  readApplyReceiptPointer,
  reduceApplyReceiptUndoLineage,
  replaceApplyReceiptSummaryHistory,
  transactionIdFromReceiptId,
  withApplyReceiptHistoryMigration
} from "./apply-receipt-store.js";
import {
  APPLY_RECEIPT_MAX_BYTES,
  assertApplyStoreFreshBootstrap,
  assertApplyStoreAdmission,
  initializeEmptyApplyStoreAccounting,
  readApplyStoreAccounting,
  rebaseFreshApplyStoreAccountingExact,
  reconcileApplyStoreAdmissionTemporaries,
  reconcileApplyStoreFreshBootstrapTemporaries,
  reconcileAndMeasureApplyStoreSettlement,
  reserveApplyStoreForTransaction,
  settleApplyStoreReservation
} from "./apply-store-accounting.js";
import {
  boundedZtsMessageValue,
  createApplyAuthorization,
  createPlan,
  createProtectionGrant,
  defineApplyAuthorization,
  definePlan,
  definePlanForSnapshot,
  defineReceipt
} from "./domain/change.js";
import { sha256Canonical } from "./domain/digest.js";
import { movementEligibility } from "./domain/snapshot.js";
import { loadConfig } from "./config.js";
import {
  acquireNativeProfileControl,
  NativeProfileControlUnavailableError
} from "./closed-session-control.js";
import { ExclusiveFileControlUnavailableError } from "./exclusive-control.js";
import {
  readJsonLz4State,
  sameJsonLz4Fingerprint,
  writeJsonLz4Durable
} from "./mozlz4.js";
import {
  INVERSE_PLAN_MAX_BYTES,
  InversePlanArtifactLimitError,
  loadInversePlan,
  publishInversePlan
} from "./inverse-plan-store.js";
import { defineInvocationConsent, INVOCATION_CONSENT_SCHEMA } from "./invocation-consent.js";
import { deriveExactPlannedAfterSnapshot } from "./planned-after-snapshot.js";
import { discoverLegacyProfileIdentities, findSessionFile, profilePathsMatch, zenProcessMayOwnProfile } from "./profile.js";
import {
  acquireProfileTransactionLock,
  inspectProfileTransactionLock,
  legacyProfileTransactionLockPath,
  ProfileLockAcquisitionUncertainError
} from "./profile-lock.js";
import { findZenProcesses } from "./processes.js";
import {
  assertPrivateDirectory,
  ensurePrivateDirectory,
  privatePath,
  publishPrivateBytes,
  publishPrivateJson,
  readPrivateJson,
  replacePrivateJson
} from "./private-store.js";
import {
  captureControlledSessionSnapshot,
  captureSessionSnapshot,
  SessionSnapshotDriftError,
  sessionTabBindings
} from "./session-snapshot.js";
import {
  captureManagedZenLifecycleBinding,
  managedZenGrantRevision,
  quitManagedZen,
  relaunchManagedZen
} from "./managed-zen-lifecycle.js";

import type {
  ApplyAuthorization,
  AuthorizableTrustClass,
  MoveProtectionPrecondition,
  Plan,
  PlanAction,
  ProtectionGrant,
  Receipt,
  ZtsMessage
} from "./domain/change.js";
import type { Sha256Digest } from "./domain/digest.js";
import type { ArtifactReference, Protection, Snapshot } from "./domain/snapshot.js";
import type { JsonLz4Fingerprint } from "./mozlz4.js";
import type { ApplyArtifactLayout as ApplyLayout } from "./apply-artifacts.js";
import type { ApplyJournalEvidenceByStage, ApplyJournalStage } from "./apply-journal.js";
import type { ApplyReceiptSummary } from "./apply-receipt-store.js";
import type {
  ManagedZenClosedEvidence,
  ManagedZenLifecycleBinding,
  ManagedZenLifecycleRequest,
  ManagedZenLifecycleWaitOptions,
  ManagedZenPlatform
} from "./managed-zen-lifecycle.js";
import { loadStoredPlan, type StoredPlan } from "./plans.js";
import { applyUndoWindowExpiresAt } from "./apply-policy.js";
import {
  assertMaterializedUndoPlanBinding,
  inverseTemplateActionId,
  UndoLineageBindingError
} from "./undo-lineage.js";
import type { ProfileContext } from "./profile.js";
import type { RawZenSession, summarizeSession } from "./session.js";
import type { NativeProfileControl } from "./closed-session-control.js";

const BACKUP_SCHEMA = "zts.session-backup.provisional-1" as const;
const RECOVERY_SCHEMA = "zts.apply-recovery.provisional-1" as const;
const CONTROL_SCHEMA = "zts.closed-session-control-proof.provisional-1" as const;
const RECEIPT_MAX_BYTES = APPLY_RECEIPT_MAX_BYTES;
const MAX_APPLY_OPERATIONS = 500;

type MoveAction = Extract<PlanAction, { readonly disposition: "move" }>;

export interface ApplyTransactionResult {
  readonly snapshot: Snapshot;
  readonly plan: Plan;
  readonly authorization: ApplyAuthorization;
  readonly receipt: Extract<Receipt, { readonly outcome: "applied" }>;
  readonly receiptPath: string;
  readonly applied: true;
  readonly terminalCleanupRequired: boolean;
  readonly summary: {
    readonly moveCount: number;
  };
  readonly artifacts: readonly ({ readonly kind: string } & ArtifactReference)[];
}

export interface ApplyTransactionBlockedResult {
  readonly snapshot: Snapshot;
  readonly plan: Plan;
  readonly authorization: ApplyAuthorization;
  readonly receipt: Exclude<Receipt, { readonly outcome: "applied" }>;
  readonly receiptPath: string;
  readonly applied: false;
  /** Presentation disposition; never inferred from blocker text. */
  readonly failureKind: "safety" | "internal";
  readonly terminalCleanupRequired: boolean;
  readonly blocker: string;
  readonly summary: {
    readonly moveCount: number;
  };
  readonly artifacts: readonly ({ readonly kind: string } & ArtifactReference)[];
}

export type ApplyTransactionOutcome = ApplyTransactionResult | ApplyTransactionBlockedResult;

export class ApplyTransactionSafetyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ApplyTransactionSafetyError";
  }
}

export class ApplyTransactionUncertainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ApplyTransactionUncertainError";
  }
}

class ApplyControlReleaseUncertainError extends ApplyTransactionUncertainError {
  constructor(message: string) {
    super(message);
    this.name = "ApplyControlReleaseUncertainError";
  }
}

class ApplyCommitBoundaryUncertainError extends ApplyTransactionUncertainError {
  constructor(message: string) {
    super(message);
    this.name = "ApplyCommitBoundaryUncertainError";
  }
}

export interface TransactionReceiptSummary {
  readonly id: string;
  readonly kind: "saved_plan";
  readonly outcome: Receipt["outcome"];
  readonly planId: string;
  readonly planDigest: string;
  readonly causalSourceReceiptId: string | null;
  readonly causalSourceReceiptDigest: Sha256Digest | null;
  readonly completedAt: string;
  readonly operationCount: number;
  readonly inversePlanReplayability: "bound_snapshot" | "legacy_unbound" | "none";
  readonly fullReceiptAvailability: "available" | "archived_summary_only";
  readonly receiptPath: string | null;
}

export class ApplyReceiptArchivedError extends ApplyTransactionSafetyError {
  readonly receiptId: string;

  constructor(receiptId: string) {
    super(`Full Apply Receipt ${receiptId} was archived after its undo window; its durable history summary remains available`);
    this.name = "ApplyReceiptArchivedError";
    this.receiptId = receiptId;
  }
}

export class ApplyReceiptSelectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ApplyReceiptSelectionError";
  }
}

export interface TransactionReceiptPage {
  readonly receipts: readonly TransactionReceiptSummary[];
  readonly nextCursor: string | null;
}

export interface TransactionReceiptVerificationReport {
  readonly receiptId: string;
  readonly profileId: string;
  readonly receiptPath: string;
  readonly receipt: Receipt;
  readonly inversePlanReplayability: "bound_snapshot" | "legacy_unbound" | "none";
  readonly verification: {
    readonly ok: boolean;
    readonly checkedOperations: number;
    readonly mismatchCount: number;
    readonly blockers: string[];
    readonly mismatches: {
      readonly actionId: string;
      readonly entityRef: string;
      readonly expectedWorkspaceId: string | null;
      readonly actualWorkspaceId: string | null;
      readonly reason: "missing_entity" | "workspace_mismatch" | "unsupported_operation";
    }[];
  };
}

export interface ApplyStoredPlanOptions {
  readonly expectedDigest: string;
  readonly command: string;
  /** Explicit route preference overrides config, but never authorizes fallback from live to session. */
  readonly routePreference?: "auto" | "live" | "session";
  readonly executionIntent?:
    | { readonly kind: "standard" }
    | {
        readonly kind: "undo";
        readonly sourceReceiptId: string;
        readonly sourceReceiptDigest: Sha256Digest;
      };
  readonly managedLifecycle?: {
    readonly platform: ManagedZenPlatform;
    readonly request: ManagedZenLifecycleRequest;
    readonly waitOptions: ManagedZenLifecycleWaitOptions;
  };
  readonly now?: Date;
  /** Internal/test clock used for mutation-boundary expiry checks. */
  readonly clock?: () => Date;
  /** Internal orchestration hook used by crash/failure acceptance harnesses. */
  readonly afterSafetyCheck?: () => void | Promise<void>;
  /** Internal hook after quota charge but before the first transaction artifact. */
  readonly afterStoreReservation?: () => void | Promise<void>;
  /** Internal orchestration hook used by crash/failure acceptance harnesses. */
  readonly afterUnfinishedMarker?: () => void | Promise<void>;
  /** Internal hard-crash hook after exact managed closure but before native Profile control. */
  readonly afterManagedQuit?: () => void | Promise<void>;
  /** Internal orchestration hook used by crash/failure acceptance harnesses. */
  readonly afterJournal?: () => void | Promise<void>;
  /** Internal orchestration hook used by crash/failure acceptance harnesses. */
  readonly afterLock?: () => void | Promise<void>;
  /** Internal orchestration hook used by crash/failure acceptance harnesses. */
  readonly afterLockPublication?: () => void;
  /** Internal orchestration hook used by crash/failure acceptance harnesses. */
  readonly beforeCommit?: () => void | Promise<void>;
  /** Internal hook after exact source validation at the atomic swap boundary. */
  readonly afterSourceValidation?: () => void | Promise<void>;
  /** Internal hard-crash hook after the atomic swap but before displaced-source validation. */
  readonly afterAtomicSwap?: () => void | Promise<void>;
  /** Internal orchestration hook used by crash/failure acceptance harnesses. */
  readonly afterWriteIntent?: () => void | Promise<void>;
  /** Internal orchestration hook used by crash/failure acceptance harnesses. */
  readonly afterTemporaryCreated?: () => void | Promise<void>;
  /** Internal orchestration hook used by crash/failure acceptance harnesses. */
  readonly afterRename?: () => void | Promise<void>;
  /** Internal fault hook after displaced-source unlink but before final directory durability. */
  readonly beforeFinalDirectorySync?: () => void | Promise<void>;
  /** Internal orchestration hook used by crash/failure acceptance harnesses. */
  readonly afterCommit?: () => void | Promise<void>;
  /** Internal orchestration hook used by crash/failure acceptance harnesses. */
  readonly afterRelease?: () => void | Promise<void>;
  /** Internal orchestration hook used by crash/failure acceptance harnesses. */
  readonly afterReceipt?: () => void | Promise<void>;
  /** Internal orchestration hook used by crash/failure acceptance harnesses. */
  readonly afterReceiptObject?: () => void | Promise<void>;
  /** Internal orchestration hook used by crash/failure acceptance harnesses. */
  readonly afterHistoryIntent?: () => void | Promise<void>;
  /** Internal orchestration hook used by crash/failure acceptance harnesses. */
  readonly afterHistoryHead?: () => void | Promise<void>;
  /** Internal hard-crash hook after exact store settlement but before terminal marker removal. */
  readonly afterStoreSettlement?: () => void | Promise<void>;
}

export function assertSupportedApplyRoute(
  routePreference: "auto" | "live" | "session"
): void {
  if (routePreference !== "live") return;
  throw new ApplyTransactionSafetyError(
    "Apply route is configured as live, but production live mutation is unavailable; zts never falls back to closed-session mutation. Use --backend session or set defaults.apply_backend = \"session\" after review."
  );
}

async function assertUndoExecutionCausality(
  plan: Extract<Plan, { readonly source: { readonly kind: "inverse" } }> | Plan,
  intent: Extract<NonNullable<ApplyStoredPlanOptions["executionIntent"]>, { readonly kind: "undo" }>,
  executionSnapshot: Snapshot,
  now: Date
): Promise<void> {
  if (plan.source.kind !== "inverse"
    || plan.source.sourceReceiptDigest === null
    || plan.source.inverseTemplateDigest === null) {
    throw new ApplyTransactionSafetyError("Undo requires a materialized digest-bound inverse Plan");
  }
  const found = await findTransactionReceipt(plan.profileId, intent.sourceReceiptId);
  if (!found) throw new ApplyTransactionSafetyError(`Undo source Receipt not found: ${intent.sourceReceiptId}`);
  const source = found.receipt;
  if (sha256Canonical(source) !== intent.sourceReceiptDigest
    || intent.sourceReceiptDigest !== plan.source.sourceReceiptDigest
    || source.id !== plan.source.sourceReceiptId
    || source.planId !== plan.source.sourcePlanId
    || source.planDigest !== plan.source.sourcePlanDigest) {
    throw new ApplyTransactionSafetyError("Undo source Receipt digest or source Plan binding changed");
  }
  if (source.outcome !== "applied") {
    throw new ApplyTransactionSafetyError(`Undo requires an applied source Receipt; observed ${source.outcome}`);
  }
  if (!source.inversePlanArtifact
    || source.inversePlanArtifact.digest !== plan.source.inverseTemplateDigest) {
    throw new ApplyTransactionSafetyError("Undo Plan does not bind the source Receipt inverse template");
  }
  const sourcePlan = (await loadStoredPlan(plan.profileId, source.planDigest)).plan;
  if (sourcePlan.source.kind === "inverse") {
    throw new ApplyTransactionSafetyError("Undo-of-Undo is not enabled in the first production Undo contract");
  }
  if (now.getTime() >= Date.parse(applyUndoWindowExpiresAt(source.completedAt))) {
    throw new ApplyTransactionSafetyError(`Undo source Receipt expired at ${applyUndoWindowExpiresAt(source.completedAt)}`);
  }
  const layout = await readApplyArtifactLayout(plan.profileId);
  const lineage = await reduceApplyReceiptUndoLineage(
    layout,
    plan.profileId,
    { sourceReceiptId: source.id, maxNodes: 50_000 }
  );
  if (!lineage.source) {
    throw new ApplyTransactionSafetyError("Undo source Receipt is missing from canonical causal history");
  }
  if (lineage.barrier) {
    throw new ApplyTransactionSafetyError(
      `Undo source Receipt was superseded, consumed, or entered uncertain lineage through ${lineage.barrier.id} (${lineage.barrier.outcome})`
    );
  }
  const inverse = await loadInversePlan(layout, source.inversePlanArtifact);
  try {
    assertMaterializedUndoPlanBinding(
      inverse.snapshot,
      executionSnapshot,
      inverse.plan,
      source,
      sourcePlan,
      plan
    );
  } catch (error) {
    if (!(error instanceof UndoLineageBindingError)) throw error;
    throw new ApplyTransactionSafetyError(error.message);
  }
}

export async function applyStoredPlanClosedSession(
  initialContext: ProfileContext,
  stored: StoredPlan,
  options: ApplyStoredPlanOptions
): Promise<ApplyTransactionOutcome> {
  const plan = stored.plan;
  const executionIntent = options.executionIntent ?? { kind: "standard" as const };
  if (plan.source.kind === "inverse") {
    if (executionIntent.kind !== "undo"
      || executionIntent.sourceReceiptId !== plan.source.sourceReceiptId
      || plan.source.sourceReceiptDigest === null
      || executionIntent.sourceReceiptDigest !== plan.source.sourceReceiptDigest) {
      throw new ApplyTransactionSafetyError(
        "Inverse templates and Plans may execute only through zts undo for their exact source Receipt digest"
      );
    }
  } else if (executionIntent.kind === "undo") {
    throw new ApplyTransactionSafetyError("Undo execution requires a Receipt-bound inverse Plan");
  }
  if (options.expectedDigest !== plan.digest) {
    throw new Error(`Expected Plan digest ${options.expectedDigest} does not match selected Plan ${plan.digest}`);
  }
  definePlanForSnapshot(stored.snapshot, plan);
  if (plan.snapshotAuthority !== "authoritative" || plan.snapshotFreshness !== "current") {
    throw new ApplyTransactionSafetyError("Saved Plan apply requires a Plan created from a current authoritative Snapshot");
  }
  const clock = options.clock ?? (() => new Date());
  const authorizedAt = canonicalTimestamp(options.now ?? clock());
  if (plan.source.kind === "inverse" && executionIntent.kind === "undo") {
    await assertUndoExecutionCausality(plan, executionIntent, stored.snapshot, new Date(authorizedAt));
  }
  if (Date.parse(plan.expiresAt) <= Date.parse(authorizedAt)) {
    throw new ApplyTransactionSafetyError(`Saved Plan ${plan.digest} expired at ${plan.expiresAt}; create a fresh preview`);
  }
  if (initialContext.profile.id !== plan.profileId) {
    throw new ApplyTransactionSafetyError("Selected Plan belongs to a different Zen Profile");
  }
  const admissionConfig = await loadConfig();
  const routePreference = options.routePreference ?? admissionConfig.config.defaults.applyBackend;
  assertSupportedApplyRoute(routePreference);
  const moveActions = executableActions(plan);
  if (moveActions.length > MAX_APPLY_OPERATIONS) {
    throw new ApplyTransactionSafetyError(
      `Selected Plan has ${moveActions.length} executable Operations; the production transaction cap is ${MAX_APPLY_OPERATIONS}. Derive a reviewed subset or plan with --limit.`
    );
  }
  if (moveActions.length > 0) preflightApplyReceiptCapacity(moveActions.length);
  let managedLifecycleBinding: ManagedZenLifecycleBinding | null = null;
  if (options.managedLifecycle) {
    managedLifecycleBinding = await captureManagedZenLifecycleBinding(
      options.managedLifecycle.platform,
      options.managedLifecycle.request
    );
    if (!profilePathsMatch(managedLifecycleBinding.profilePath, initialContext.profile.path)) {
      throw new ApplyTransactionSafetyError("Managed Zen lifecycle binding belongs to a different Profile path");
    }
  }
  const layout = await applyLayout(plan.profileId);
  await ensureApplyReceiptSummaryHistory(layout, plan.profileId, {
    bootstrapAt: new Date(authorizedAt)
  });
  await assertNoLegacyIdentityHazards(initialContext);
  const existingLock = await inspectProfileTransactionLock(initialContext.profile);
  if (existingLock.status !== "absent") {
    const detail = existingLock.status === "invalid"
      ? existingLock.blocker
      : `pid ${existingLock.pid}, acquired ${existingLock.acquiredAt}`;
    throw new ApplyTransactionSafetyError(
      `Profile transaction lock is ${existingLock.status} and was left in place (${detail})`
    );
  }
  await options.afterSafetyCheck?.();
  const registered = await withApplyReceiptHistoryMigration(layout, plan.profileId, async (historyControl) => {
    await reconcileApplyStoreAdmissionTemporaries(layout, historyControl);
    const registeredUnfinished = await readApplyUnfinishedMarkers(layout, plan.profileId, loadUnfinishedMarkerPlan);
    if (registeredUnfinished === null) {
      throw new ApplyTransactionSafetyError("Apply unfinished index disappeared during transaction admission");
    }
    const existingUnfinished = registeredUnfinished[0];
    if (existingUnfinished) {
      throw new ApplyTransactionSafetyError(
        `Unfinished Apply Transaction ${existingUnfinished.journal.transactionId} requires recovery before another mutation`
      );
    }
    await assertApplyStoreAdmission(layout, plan.profileId);
    const transactionId = `apply:${randomUUID()}`;
    const receiptId = `receipt:${transactionId}`;
    const consent = defineInvocationConsent({
      schemaVersion: INVOCATION_CONSENT_SCHEMA,
      transactionId,
      planId: plan.id,
      planDigest: plan.digest,
      confirmedDigest: options.expectedDigest,
      confirmedAt: authorizedAt,
      commandRevision: sha256Canonical({ command: options.command }),
      purpose: executionIntent.kind === "undo"
        ? {
            kind: "undo" as const,
            sourceReceiptId: executionIntent.sourceReceiptId,
            sourceReceiptDigest: executionIntent.sourceReceiptDigest
          }
        : { kind: "apply" as const }
    }, {
      transactionId,
      planId: plan.id,
      planDigest: plan.digest,
      planSource: plan.source
    });
    const consentArtifact = artifact(`consent:${transactionId}`, sha256Canonical(consent));
    const authorization = createAuthorization(
      stored.snapshot,
      plan,
      moveActions,
      consentArtifact,
      transactionId,
      authorizedAt,
      managedLifecycleBinding
    );
    const authorizationArtifact = artifact(authorization.id, authorization.revision);
    const journal = createApplyJournal({
      transactionId,
      planId: plan.id,
      planDigest: plan.digest,
      authorizationRevision: authorization.revision,
      profileId: plan.profileId,
      targetPathRevision: sha256Canonical({ path: initialContext.sessionFile.path })
    });
    let unfinishedMarker;
    try {
      unfinishedMarker = prepareApplyUnfinishedMarker(journal, {
        consent,
        consentArtifact,
        authorization,
        authorizationArtifact,
        lifecycle: managedLifecycleBinding
          ? { kind: "managed_zen", binding: managedLifecycleBinding }
          : { kind: "none" }
      }, plan);
    } catch (error) {
      if (!(error instanceof ApplyUnfinishedMarkerLimitError)) throw error;
      throw new ApplyTransactionSafetyError(
        `${error.message}; derive a smaller reviewed Plan before applying`
      );
    }
    await initializeApplyUnfinishedIndex(layout, plan.profileId);
    await reserveApplyStoreForTransaction(
      layout,
      plan.profileId,
      transactionId,
      undefined,
      new Date(authorizedAt)
    );
    await options.afterStoreReservation?.();
    await publishApplyUnfinishedMarker(layout, unfinishedMarker);
    await options.afterUnfinishedMarker?.();
    const transactionRoot = await ensurePrivateDirectory(layout.transactions, safeSegment(transactionId));
    const journalPath = privatePath(transactionRoot, "journal.json");
    await publishPrivateJson(objectPath(layout.consents, consentArtifact.digest, "json"), consent);
    await publishPrivateJson(objectPath(layout.authorizations, authorization.revision, "json"), authorization);
    await replacePrivateJson(journalPath, journal);
    await options.afterJournal?.();
    return {
      transactionId,
      receiptId,
      transactionRoot,
      journalPath,
      consentArtifact,
      authorization,
      authorizationArtifact,
      journal
    };
  });
  const {
    transactionId,
    receiptId,
    transactionRoot,
    journalPath,
    consentArtifact,
    authorization,
    authorizationArtifact,
    journal
  } = registered;
  const updateJournal = async <Stage extends ApplyJournalStage>(
    stage: Stage,
    evidence: ApplyJournalEvidenceByStage[Stage]
  ) => {
    appendApplyJournal(journal, stage, evidence);
    await replacePrivateJson(journalPath, journal);
  };
  let lock;
  try {
    lock = await acquireProfileTransactionLock(
      initialContext.profile,
      options.command,
      new Date(authorizedAt),
      transactionId,
      { afterLink: options.afterLockPublication }
    );
  } catch (error) {
    if (error instanceof ProfileLockAcquisitionUncertainError) {
      throw new ApplyTransactionSafetyError(
        `${error.message}; unfinished transaction ${transactionId} was retained for explicit recovery`
      );
    }
    const blocker = error instanceof Error ? error.message : String(error);
    const issueCode = "profile_lock_unavailable";
    await updateJournal("preflight_blocked", {
      issueCode,
      message: blocker,
      mutationStatus: "not_committed",
      backupArtifact: null,
      recoveryArtifact: null,
      inversePlanArtifact: null
    });
    const controlProof = {
      schemaVersion: CONTROL_SCHEMA,
      transactionId,
      profileId: plan.profileId,
      route: "closed_session" as const,
      lockRevision: null,
      lockAcquiredAt: null,
      lockReleasedAt: null,
      releaseStatus: "not_started" as const,
      failure: { issueCode, message: blocker, mutationStatus: "not_committed" }
    };
    const controlArtifact = artifact(`control:${transactionId}`, sha256Canonical(controlProof));
    await publishPrivateJson(objectPath(layout.controls, controlArtifact.digest, "json"), controlProof);
    await updateJournal("failure_recorded", {
      controlArtifact,
      releaseStatus: "unknown",
      releasedAt: null,
      receiptId
    });
    const finalJournal = structuredClone(journal);
    const journalArtifact = artifact(`journal:${transactionId}`, sha256Canonical(finalJournal));
    await publishPrivateJson(objectPath(layout.journals, journalArtifact.digest, "json"), finalJournal);
    const receipt = defineReceipt(stored.snapshot, plan, authorization, {
      schemaVersion: "zts.receipt.provisional-1",
      id: receiptId,
      planId: plan.id,
      planDigest: plan.digest,
      authorization: {
        id: authorization.id,
        revision: authorization.revision,
        artifact: authorizationArtifact
      },
      profileId: plan.profileId,
      beforeSnapshotRevision: plan.snapshotRevision,
      startedAt: authorizedAt,
      completedAt: new Date().toISOString(),
      journalArtifact,
      issues: [{ code: issueCode, severity: "error", message: ztsMessage(blocker), actionId: null }],
      outcome: "blocked",
      mutationAttempted: false,
      netChanged: false,
      afterSnapshotRevision: null,
      control: {
        route: "closed_session",
        proof: controlArtifact,
        exclusiveControlReleased: "not_started"
      },
      backupArtifact: null,
      inversePlanArtifact: null,
      recoveryArtifact: null,
      operations: moveActions.map((action) => ({
        actionId: action.actionId,
        entityRef: action.operation.entityRef,
        observedWorkspaceId: stored.snapshot.entities.find((entity) => entity.ref === action.operation.entityRef)?.workspaceId ?? null,
        status: "not_attempted" as const,
        mutationAttempted: false as const,
        netChanged: false as const,
        issueCodes: [issueCode] as [string]
      })) as unknown as Extract<Receipt, { readonly outcome: "blocked" }>["operations"]
    });
    const { artifact: receiptArtifact, receiptPath } = await publishApplyReceipt(
      layout,
      transactionRoot,
      receipt,
      {
        afterReceiptObject: options.afterReceiptObject,
        afterHistoryIntent: options.afterHistoryIntent,
        afterHistoryHead: options.afterHistoryHead,
        inversePlanReplayability: await inversePlanReplayability(layout, receipt.inversePlanArtifact),
        causalSourceReceiptId: plan.source.kind === "inverse" ? plan.source.sourceReceiptId : null,
        causalSourceReceiptDigest: plan.source.kind === "inverse" ? plan.source.sourceReceiptDigest : null
      }
    );
    const terminalCleanupRequired = !await removeTerminalMarker(
      layout,
      plan.profileId,
      transactionId,
      options.afterStoreSettlement
    );
    return {
      snapshot: stored.snapshot,
      plan,
      authorization,
      receipt,
      receiptPath,
      applied: false,
      failureKind: "safety",
      terminalCleanupRequired,
      blocker,
      summary: { moveCount: moveActions.length },
      artifacts: [
        { kind: "consent", ...consentArtifact },
        { kind: "authorization", ...authorizationArtifact },
        { kind: "control_proof", ...controlArtifact },
        { kind: "journal", ...journalArtifact },
        { kind: "receipt", ...receiptArtifact }
      ]
    };
  }
  let lockReleased = false;
  let lockReleaseAttempted = false;
  let nativeControl: NativeProfileControl | null = null;
  let nativeProfileControlVerified = false;
  let nativeControlReleased = false;
  let nativeControlReleaseAttempted = false;
  let mutationCommitted = false;
  let commitBoundaryCrossed = false;
  let commitBoundaryUncertain = false;
  let observedSnapshot = stored.snapshot;
  let backupArtifact: ArtifactReference | null = null;
  let recoveryArtifact: ArtifactReference | null = null;
  let inversePlanArtifact: ArtifactReference | null = null;
  let expectedAfterSnapshot: Snapshot | null = null;
  let managedClosedEvidence: ManagedZenClosedEvidence | null = null;
  let managedRelaunchedBinding: ManagedZenLifecycleBinding | null = null;
  let managedQuitAttempted = false;
  const processChecks: Array<Readonly<Record<string, unknown>>> = [];
  try {
    await assertNoUnfinishedApplyTransactions(plan.profileId, transactionId);
    if (managedLifecycleBinding && options.managedLifecycle) {
      managedQuitAttempted = true;
      managedClosedEvidence = await quitManagedZen(
        options.managedLifecycle.platform,
        managedLifecycleBinding,
        options.managedLifecycle.waitOptions
      );
      await options.afterManagedQuit?.();
    }
    nativeControl = await acquireNativeProfileControl(initialContext, 0);
    await nativeControl.assertHeld();
    nativeProfileControlVerified = true;
    await options.afterLock?.();
    await updateJournal("locked", {
      lockRevision: lock.artifactRevision,
      nativeControlLeaseRevision: sha256Canonical(nativeControl.proof),
      authorizedActionIds: authorization.authorizedActionIds
    });
    const loadedConfig = await loadConfig();
    assertEffectiveConfigRevision(plan, loadedConfig.revision, "whole-Plan preflight");
    const beforeCapture = await captureControlledSessionSnapshot(
      initialContext,
      nativeControl,
      loadedConfig.config
    );
    const currentContext = beforeCapture.context;
    processChecks.push(processCheck("after_lock", currentContext));
    assertClosedSessionRoute(currentContext);
    const beforeState = beforeCapture.state;
    const beforeSession = beforeCapture.session;
    const beforeSummary = beforeCapture.summary;
    const beforeSnapshot = beforeCapture.snapshot;
    observedSnapshot = beforeSnapshot;
    assertPlanForPreflight(beforeSnapshot, plan);
    const bindings = preflightOperations(beforeSnapshot, beforeSession, beforeSummary, moveActions);
    expectedAfterSnapshot = deriveExactPlannedAfterSnapshot(beforeSnapshot, moveActions);
    const inversePlan = createInversePlan(
      expectedAfterSnapshot,
      plan,
      moveActions,
      receiptId,
      clock()
    );
    try {
      inversePlanArtifact = await publishInversePlan(layout, expectedAfterSnapshot, inversePlan);
    } catch (error) {
      if (error instanceof InversePlanArtifactLimitError) {
        throw new ApplyTransactionSafetyError(`${error.message}; derive a smaller reviewed Plan`);
      }
      throw error;
    }
    await updateJournal("preflight_ok", {
      beforeSnapshotRevision: beforeSnapshot.revision,
      expectedAfterSnapshotRevision: expectedAfterSnapshot.revision,
      sourceFingerprint: beforeState.fingerprint,
      operationCount: moveActions.length,
      inversePlanArtifact
    });

    backupArtifact = await publishBackup(
      layout,
      transactionId,
      currentContext,
      beforeState.bytes,
      beforeState.fingerprint
    );
    recoveryArtifact = await publishRecoveryDescriptor(
      layout,
      transactionId,
      plan,
      currentContext,
      beforeState.fingerprint,
      backupArtifact
    );
    await updateJournal("backup_published", {
      backupArtifact,
      recoveryArtifact
    });

    const nextSession = structuredClone(beforeSession);
    applyOperationsInMemory(nextSession, bindings, moveActions);
    await writeJsonLz4Durable(currentContext.sessionFile.path, nextSession, {
      mode: beforeState.fingerprint.mode,
      expectedSourceFingerprint: beforeState.fingerprint,
      beforePrepare: async (prepared) => {
        await updateJournal("write_prepared", {
          backupArtifact: requiredArtifact(backupArtifact, "Prepared write backup"),
          recoveryArtifact: requiredArtifact(recoveryArtifact, "Prepared write recovery descriptor"),
          temporaryPathRevision: sha256Canonical({ path: prepared.temporaryPath }),
          preparedDigest: prepared.encodedDigest
        });
      },
      afterPrepareIntent: options.afterWriteIntent,
      afterTemporaryCreated: options.afterTemporaryCreated,
      beforeCommit: async () => {
        const finalLoadedConfig = await loadConfig();
        assertEffectiveConfigRevision(plan, finalLoadedConfig.revision, "whole-Plan preflight before commit");
        const finalCapture = await captureControlledSessionSnapshot(
          initialContext,
          nativeControl!,
          finalLoadedConfig.config
        );
        const finalContext = finalCapture.context;
        processChecks.push(processCheck("before_commit", finalContext));
        assertClosedSessionRoute(finalContext);
        const finalState = finalCapture.state;
        if (!sameJsonLz4Fingerprint(beforeState.fingerprint, finalState.fingerprint)) {
          throw new ApplyTransactionSafetyError(
            "Whole-Plan preflight failed: Zen session file Drift was detected before commit"
          );
        }
        const finalSession = finalCapture.session;
        const finalSummary = finalCapture.summary;
        const finalSnapshot = finalCapture.snapshot;
        assertPlanForPreflight(finalSnapshot, plan);
        preflightOperations(finalSnapshot, finalSession, finalSummary, moveActions);
        await options.beforeCommit?.();
        const boundaryConfig = await loadConfig();
        assertEffectiveConfigRevision(plan, boundaryConfig.revision, "final mutation boundary");
        await nativeControl!.assertHeld();
        const boundaryContext = await refreshTargetContext(initialContext);
        assertClosedSessionRoute(boundaryContext);
        const boundaryState = await readJsonLz4State(boundaryContext.sessionFile.path);
        await nativeControl!.assertHeld();
        if (!sameJsonLz4Fingerprint(beforeState.fingerprint, boundaryState.fingerprint)) {
          throw new ApplyTransactionSafetyError(
            "Whole-Plan preflight failed: Zen session file Drift was detected at the commit boundary"
          );
        }
        if (Date.parse(plan.expiresAt) <= clock().getTime()) {
          throw new ApplyTransactionSafetyError(
            `Saved Plan ${plan.digest} expired before the commit boundary at ${plan.expiresAt}`
          );
        }
        if (plan.source.kind === "inverse" && executionIntent.kind === "undo") {
          await assertUndoExecutionCausality(plan, executionIntent, finalSnapshot, clock());
        }
      },
      afterSourceValidation: options.afterSourceValidation,
      afterAtomicSwap: options.afterAtomicSwap,
      onCommitBoundaryCrossed: () => {
        commitBoundaryCrossed = true;
      },
      onCommitted: () => {
        mutationCommitted = true;
      },
      onCommitUncertain: () => {
        commitBoundaryUncertain = true;
      },
      afterRename: options.afterRename,
      beforeFinalDirectorySync: options.beforeFinalDirectorySync
    });
    await updateJournal("write_committed", { backupArtifact, recoveryArtifact });
    await options.afterCommit?.();

    const afterCapture = await captureControlledSessionSnapshot(
      initialContext,
      nativeControl,
      loadedConfig.config
    );
    const verificationContext = afterCapture.context;
    processChecks.push(processCheck("after_commit", verificationContext));
    assertClosedSessionRoute(verificationContext);
    const afterState = afterCapture.state;
    const afterSnapshot = afterCapture.snapshot;
    observedSnapshot = afterSnapshot;
    assertExactPlannedAfterSnapshot(afterSnapshot, expectedAfterSnapshot);
    const operations = verifyOperations(afterSnapshot, moveActions);
    await updateJournal("verified", {
      afterSnapshotRevision: afterSnapshot.revision,
      afterSourceFingerprint: afterState.fingerprint,
      inversePlanArtifact
    });

    nativeControlReleaseAttempted = true;
    await nativeControl.release();
    nativeControlReleased = true;
    lockReleaseAttempted = true;
    const released = await lock.release();
    lockReleased = true;
    await options.afterRelease?.();
    if (managedLifecycleBinding && options.managedLifecycle) {
      managedRelaunchedBinding = await relaunchManagedZen(
        options.managedLifecycle.platform,
        managedLifecycleBinding,
        options.managedLifecycle.waitOptions
      );
    }
    const controlProof = managedLifecycleBinding && managedClosedEvidence && managedRelaunchedBinding
      ? {
          schemaVersion: CONTROL_SCHEMA,
          transactionId,
          profileId: plan.profileId,
          route: "managed_zen" as const,
          lifecycleBinding: managedLifecycleBinding,
          closedEvidence: managedClosedEvidence,
          relaunchedBinding: managedRelaunchedBinding,
          lockRevision: lock.artifactRevision,
          lockAcquiredAt: lock.acquiredAt,
          lockReleasedAt: released.releasedAt,
          beforeSnapshotRevision: beforeSnapshot.revision,
          afterSnapshotRevision: afterSnapshot.revision,
          beforeSourceFingerprint: beforeState.fingerprint,
          afterSourceFingerprint: afterState.fingerprint,
          nativeProfileControl: {
            proof: nativeControl.proof,
            released: nativeControlReleased
          },
          zenProcessChecks: processChecks
        }
      : {
      schemaVersion: CONTROL_SCHEMA,
      transactionId,
      profileId: plan.profileId,
      route: "closed_session" as const,
      lockRevision: lock.artifactRevision,
      lockAcquiredAt: lock.acquiredAt,
      lockReleasedAt: released.releasedAt,
      beforeSnapshotRevision: beforeSnapshot.revision,
      afterSnapshotRevision: afterSnapshot.revision,
      beforeSourceFingerprint: beforeState.fingerprint,
      afterSourceFingerprint: afterState.fingerprint,
      nativeProfileControl: {
        proof: nativeControl.proof,
        released: nativeControlReleased
      },
      zenProcessChecks: processChecks
        };
    const controlArtifact = artifact(`control:${transactionId}`, sha256Canonical(controlProof));
    await publishPrivateJson(objectPath(layout.controls, controlArtifact.digest, "json"), controlProof);

    await updateJournal("released", {
      releasedAt: released.releasedAt,
      controlArtifact,
      receiptId,
      inversePlanArtifact
    });
    const finalJournal = structuredClone(journal);
    const journalArtifact = artifact(`journal:${transactionId}`, sha256Canonical(finalJournal));
    await publishPrivateJson(objectPath(layout.journals, journalArtifact.digest, "json"), finalJournal);

    const completedAt = new Date().toISOString();
    const receipt = defineReceipt(beforeSnapshot, plan, authorization, {
      schemaVersion: "zts.receipt.provisional-1",
      id: receiptId,
      planId: plan.id,
      planDigest: plan.digest,
      authorization: {
        id: authorization.id,
        revision: authorization.revision,
        artifact: authorizationArtifact
      },
      profileId: plan.profileId,
      beforeSnapshotRevision: beforeSnapshot.revision,
      startedAt: authorizedAt,
      completedAt,
      journalArtifact,
      issues: [],
      outcome: "applied",
      mutationAttempted: true,
      netChanged: true,
      afterSnapshotRevision: afterSnapshot.revision,
      control: managedLifecycleBinding
        ? {
            route: "managed_zen",
            proof: controlArtifact,
            quit: "verified",
            stateFlush: "verified",
            profileRestoration: "verified",
            relaunch: "verified",
            windowRestoration: "verified"
          }
        : {
            route: "closed_session",
            proof: controlArtifact,
            exclusiveControlReleased: "verified"
          },
      backupArtifact,
      inversePlanArtifact,
      recoveryArtifact: null,
      operations
    });
    const { artifact: receiptArtifact, receiptPath } = await publishApplyReceipt(
      layout,
      transactionRoot,
      receipt,
      {
        afterReceiptObject: options.afterReceiptObject,
        afterHistoryIntent: options.afterHistoryIntent,
        afterHistoryHead: options.afterHistoryHead,
        inversePlanReplayability: await inversePlanReplayability(layout, receipt.inversePlanArtifact),
        causalSourceReceiptId: plan.source.kind === "inverse" ? plan.source.sourceReceiptId : null,
        causalSourceReceiptDigest: plan.source.kind === "inverse" ? plan.source.sourceReceiptDigest : null
      }
    );
    await options.afterReceipt?.();
    const terminalCleanupRequired = !await removeTerminalMarker(
      layout,
      plan.profileId,
      transactionId,
      options.afterStoreSettlement
    );
    return {
      snapshot: beforeSnapshot,
      plan,
      authorization,
      receipt,
      receiptPath,
      applied: true,
      terminalCleanupRequired,
      summary: { moveCount: moveActions.length },
      artifacts: [
        { kind: "consent", ...consentArtifact },
        { kind: "authorization", ...authorizationArtifact },
        { kind: "backup", ...backupArtifact },
        { kind: "inverse_plan", ...inversePlanArtifact },
        { kind: "journal", ...journalArtifact },
        { kind: "control_proof", ...controlArtifact },
        { kind: "receipt", ...receiptArtifact }
      ]
    };
  } catch (error) {
    const blocker = error instanceof Error ? error.message : String(error);
    const failureKind = error instanceof ApplyTransactionSafetyError
      || error instanceof AtomicFileMismatchError
      || error instanceof ExclusiveFileControlUnavailableError
      || error instanceof NativeProfileControlUnavailableError
      || error instanceof SessionSnapshotDriftError
      ? "safety" as const
      : "internal" as const;
    const mutationStatus = mutationCommitted
      ? "committed" as const
      : commitBoundaryCrossed || commitBoundaryUncertain
        ? "uncertain" as const
        : "not_committed" as const;
    const issueCode = mutationStatus === "committed"
      ? "apply_interrupted"
      : mutationStatus === "uncertain"
        ? "atomic_commit_uncertain"
        : classifyPreflightIssue(blocker);
    let verifiedFailureOperations: ReturnType<typeof verifyOperations> | null = null;
    if (mutationCommitted && inversePlanArtifact && expectedAfterSnapshot) {
      try {
        assertExactPlannedAfterSnapshot(observedSnapshot, expectedAfterSnapshot);
        verifiedFailureOperations = verifyOperations(observedSnapshot, moveActions);
      } catch {
        verifiedFailureOperations = null;
      }
    }
    if (mutationCommitted && !verifiedFailureOperations
      && nativeControl && !nativeControlReleaseAttempted) {
      try {
        const failureConfig = await loadConfig();
        const failureCapture = await captureControlledSessionSnapshot(
          initialContext,
          nativeControl,
          failureConfig.config
        );
        if (!expectedAfterSnapshot || !inversePlanArtifact) {
          throw new Error("Committed Apply lacks its pre-mutation inverse Plan proof");
        }
        assertExactPlannedAfterSnapshot(failureCapture.snapshot, expectedAfterSnapshot);
        const candidateOperations = verifyOperations(failureCapture.snapshot, moveActions);
        observedSnapshot = failureCapture.snapshot;
        verifiedFailureOperations = candidateOperations;
      } catch {
        verifiedFailureOperations = null;
      }
    }
    try {
      await updateJournal(mutationStatus === "not_committed" ? "preflight_blocked" : "interrupted", {
        issueCode,
        message: blocker,
        mutationStatus,
        backupArtifact,
        recoveryArtifact,
        inversePlanArtifact
      });
      let releasedAt: string | null = null;
      let releaseStatus: "verified" | "unknown" = "unknown";
      if (nativeControl && !nativeControlReleaseAttempted) {
        nativeControlReleaseAttempted = true;
        try {
          await nativeControl.release();
          nativeControlReleased = true;
        } catch {
          nativeControlReleased = false;
        }
      }
      if (!lockReleaseAttempted) {
        lockReleaseAttempted = true;
        try {
          const released = await lock.release();
          releasedAt = released.releasedAt;
          lockReleased = true;
        } catch {
          releaseStatus = "unknown";
        }
      }
      releaseStatus = lockReleased && (!nativeControl || nativeControlReleased) ? "verified" : "unknown";
      const lifecycleReleasedAt = releaseStatus === "verified" ? releasedAt : null;
      let managedRelaunchFailure: string | null = null;
      const safeToRelaunch = mutationStatus !== "uncertain"
        && !(mutationCommitted && !verifiedFailureOperations);
      if (managedLifecycleBinding
        && managedClosedEvidence
        && !managedRelaunchedBinding
        && options.managedLifecycle
        && safeToRelaunch
        && releaseStatus === "verified") {
        try {
          managedRelaunchedBinding = await relaunchManagedZen(
            options.managedLifecycle.platform,
            managedLifecycleBinding,
            options.managedLifecycle.waitOptions
          );
        } catch (relaunchError) {
          managedRelaunchFailure = relaunchError instanceof Error ? relaunchError.message : String(relaunchError);
        }
      }
      const managedControl = managedLifecycleBinding
        ? {
            route: "managed_zen" as const,
            quit: managedClosedEvidence ? "verified" as const : "failed" as const,
            stateFlush: nativeProfileControlVerified ? "verified" as const : managedClosedEvidence ? "failed" as const : "not_started" as const,
            profileRestoration: managedRelaunchedBinding ? "verified" as const : managedClosedEvidence ? "failed" as const : "not_started" as const,
            relaunch: managedRelaunchedBinding ? "verified" as const : managedClosedEvidence ? "failed" as const : "not_started" as const,
            windowRestoration: managedRelaunchedBinding ? "verified" as const : managedClosedEvidence ? "failed" as const : "not_started" as const
          }
        : null;
      const controlProof = managedLifecycleBinding
        ? {
            schemaVersion: CONTROL_SCHEMA,
            transactionId,
            profileId: plan.profileId,
            route: "managed_zen" as const,
            lifecycleBinding: managedLifecycleBinding,
            closedEvidence: managedClosedEvidence,
            relaunchedBinding: managedRelaunchedBinding,
            relaunchFailure: managedRelaunchFailure,
            lockRevision: lock.artifactRevision,
            lockAcquiredAt: lock.acquiredAt,
            lockReleasedAt: releasedAt,
            releaseStatus,
            beforeSnapshotRevision: plan.snapshotRevision,
            observedSnapshotRevision: observedSnapshot.revision,
            nativeProfileControl: nativeControl
              ? { proof: nativeControl.proof, released: nativeControlReleased }
              : null,
            zenProcessChecks: processChecks,
            failure: { issueCode, message: blocker, mutationStatus }
          }
        : {
            schemaVersion: CONTROL_SCHEMA,
            transactionId,
            profileId: plan.profileId,
            route: "closed_session" as const,
            lockRevision: lock.artifactRevision,
            lockAcquiredAt: lock.acquiredAt,
            lockReleasedAt: releasedAt,
            releaseStatus,
            beforeSnapshotRevision: plan.snapshotRevision,
            observedSnapshotRevision: observedSnapshot.revision,
            nativeProfileControl: nativeControl
              ? { proof: nativeControl.proof, released: nativeControlReleased }
              : null,
            zenProcessChecks: processChecks,
            failure: { issueCode, message: blocker, mutationStatus }
          };
      const controlArtifact = artifact(`control:${transactionId}`, sha256Canonical(controlProof));
      await publishPrivateJson(objectPath(layout.controls, controlArtifact.digest, "json"), controlProof);
      await updateJournal("failure_recorded", {
        controlArtifact,
        releaseStatus,
        releasedAt: lifecycleReleasedAt,
        receiptId
      });
      if (releaseStatus !== "verified") {
        // A terminal Receipt is the immutable lifecycle authority. Publishing
        // one while control release is unknown would leave recovery no honest
        // way to add closure evidence to that immutable chain. Keep the
        // unfinished marker and mutable failure journal instead; recovery will
        // reacquire control and publish the one canonical terminal Receipt.
        throw new ApplyControlReleaseUncertainError(
          `Apply control release is uncertain after ${issueCode}; no terminal Receipt was published and ${transactionId} requires zts apply recover`
        );
      }
      if (managedLifecycleBinding && managedQuitAttempted && !managedClosedEvidence) {
        throw new ApplyControlReleaseUncertainError(
          `Managed Zen quit outcome is uncertain after ${issueCode}; no terminal Receipt was published and ${transactionId} requires zts apply recover`
        );
      }
      if (mutationStatus === "uncertain") {
        // The journal-bound target and prepared path are the only authority
        // after an indeterminate atomic helper outcome. A terminal Receipt
        // would erase the recovery entry before that pair is classified.
        throw new ApplyCommitBoundaryUncertainError(
          `Atomic session commit outcome is uncertain; no terminal Receipt was published and ${transactionId} requires zts apply recover`
        );
      }
      if (mutationCommitted && !verifiedFailureOperations) {
        throw new ApplyTransactionUncertainError(
          `Apply committed but its final state could not be verified; no terminal Receipt was published and ${transactionId} requires zts apply recover`
        );
      }
      if (managedLifecycleBinding && managedClosedEvidence && !managedRelaunchedBinding) {
        throw new ApplyControlReleaseUncertainError(
          `Managed Zen lifecycle restoration is incomplete after ${issueCode}; no terminal Receipt was published and ${transactionId} requires zts apply recover${managedRelaunchFailure ? `: ${managedRelaunchFailure}` : ""}`
        );
      }
      const finalJournal = structuredClone(journal);
      const journalArtifact = artifact(`journal:${transactionId}`, sha256Canonical(finalJournal));
      await publishPrivateJson(objectPath(layout.journals, journalArtifact.digest, "json"), finalJournal);
      const completedAt = new Date().toISOString();
      const operations = verifiedFailureOperations ?? moveActions.map((action) => ({
            actionId: action.actionId,
            entityRef: action.operation.entityRef,
            observedWorkspaceId: observedSnapshot.entities.find((entity) => entity.ref === action.operation.entityRef)?.workspaceId ?? null,
            status: "not_attempted" as const,
            mutationAttempted: false as const,
            netChanged: false as const,
            issueCodes: [issueCode] as [string]
          }));
      const common = {
        schemaVersion: "zts.receipt.provisional-1" as const,
        id: receiptId,
        planId: plan.id,
        planDigest: plan.digest,
        authorization: {
          id: authorization.id,
          revision: authorization.revision,
          artifact: authorizationArtifact
        },
        profileId: plan.profileId,
        beforeSnapshotRevision: plan.snapshotRevision,
        startedAt: authorizedAt,
        completedAt,
        journalArtifact,
        issues: [{
          code: issueCode,
          severity: (verifiedFailureOperations ? "warning" : "error") as "warning" | "error",
          message: ztsMessage(blocker),
          actionId: null
        }],
        control: managedControl
          ? { ...managedControl, proof: controlArtifact }
          : {
              route: "closed_session" as const,
              proof: controlArtifact,
              exclusiveControlReleased: releaseStatus
            }
      };
      let receipt: Receipt;
      if (verifiedFailureOperations) {
        const appliedControl = managedLifecycleBinding
          ? {
              route: "managed_zen" as const,
              proof: controlArtifact,
              quit: "verified" as const,
              stateFlush: "verified" as const,
              profileRestoration: "verified" as const,
              relaunch: "verified" as const,
              windowRestoration: "verified" as const
            }
          : {
              route: "closed_session" as const,
              proof: controlArtifact,
              exclusiveControlReleased: "verified" as const
            };
        receipt = defineReceipt(stored.snapshot, plan, authorization, {
            ...common,
            control: appliedControl,
            outcome: "applied",
            mutationAttempted: true,
            netChanged: true,
            afterSnapshotRevision: observedSnapshot.revision,
            backupArtifact: requiredArtifact(backupArtifact, "Recovered applied Receipt backup"),
            inversePlanArtifact: requiredArtifact(inversePlanArtifact, "Recovered applied Receipt inverse Plan"),
            recoveryArtifact: null,
            operations: operations as unknown as Extract<Receipt, { readonly outcome: "applied" }>["operations"]
          });
      } else {
        receipt = defineReceipt(stored.snapshot, plan, authorization, {
            ...common,
            outcome: "blocked",
            mutationAttempted: false,
            netChanged: false,
            afterSnapshotRevision: null,
            backupArtifact: null,
            inversePlanArtifact: null,
            recoveryArtifact: null,
            operations: operations as unknown as Extract<Receipt, { readonly outcome: "blocked" }>["operations"]
          });
      }
      const { artifact: receiptArtifact, receiptPath } = await publishApplyReceipt(
        layout,
        transactionRoot,
        receipt,
        {
          afterHistoryIntent: options.afterHistoryIntent,
          afterHistoryHead: options.afterHistoryHead,
          inversePlanReplayability: await inversePlanReplayability(layout, receipt.inversePlanArtifact),
          causalSourceReceiptId: plan.source.kind === "inverse" ? plan.source.sourceReceiptId : null,
          causalSourceReceiptDigest: plan.source.kind === "inverse" ? plan.source.sourceReceiptDigest : null
        }
      );
      const terminalCleanupRequired = releaseStatus !== "verified"
        || !await removeTerminalMarker(
          layout,
          plan.profileId,
          transactionId,
          options.afterStoreSettlement
        );
      const artifacts = [
          { kind: "consent", ...consentArtifact },
          { kind: "authorization", ...authorizationArtifact },
          ...(backupArtifact ? [{ kind: "backup", ...backupArtifact }] : []),
          ...(recoveryArtifact ? [{ kind: "recovery", ...recoveryArtifact }] : []),
          ...(inversePlanArtifact ? [{ kind: "inverse_plan", ...inversePlanArtifact }] : []),
          { kind: "journal", ...journalArtifact },
          { kind: "control_proof", ...controlArtifact },
          { kind: "receipt", ...receiptArtifact }
        ];
      if (receipt.outcome === "applied") {
        return {
          snapshot: stored.snapshot,
          plan,
          authorization,
          receipt,
          receiptPath,
          applied: true,
          terminalCleanupRequired,
          summary: { moveCount: moveActions.length },
          artifacts
        };
      }
      return {
        snapshot: observedSnapshot,
        plan,
        authorization,
        receipt,
        receiptPath,
        applied: false,
        failureKind,
        terminalCleanupRequired,
        blocker,
        summary: { moveCount: moveActions.length },
        artifacts
      };
    } catch (recordingError) {
      if (recordingError instanceof ApplyTransactionUncertainError) throw recordingError;
      const message = mutationStatus !== "not_committed"
        ? `Apply may have changed the session but durable failure recording was incomplete; use recovery artifact ${recoveryArtifact?.id ?? "(unavailable)"}`
        : "Apply was blocked before mutation, and its blocked Receipt could not be published";
      if (mutationStatus !== "not_committed") {
        throw new ApplyTransactionUncertainError(message);
      }
      throw new AggregateError([error, recordingError], message);
    }
  } finally {
    const cleanupErrors: unknown[] = [];
    if (nativeControl && !nativeControlReleased && !nativeControlReleaseAttempted) {
      try {
        await nativeControl.release();
        nativeControlReleased = true;
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    if (!lockReleased && !lockReleaseAttempted) {
      try {
        await lock.release();
        lockReleased = true;
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    if (cleanupErrors.length > 0) {
      throw new ApplyTransactionUncertainError(
        cleanupErrors.length === 1
          ? `Closed-session control release is uncertain: ${cleanupErrors[0] instanceof Error ? cleanupErrors[0].message : String(cleanupErrors[0])}`
          : "Closed-session controls could not be released"
      );
    }
  }
}

export async function listTransactionReceiptPage(
  profileId: string,
  options: { readonly limit?: number; readonly cursor?: string } = {}
): Promise<TransactionReceiptPage> {
  let layout: ApplyLayout;
  try {
    layout = await readApplyArtifactLayout(profileId);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { receipts: [], nextCursor: null };
    throw error;
  }
  let indexed = await readApplyReceiptSummaryPage(layout, profileId, {
    limit: options.limit ?? 50,
    ...(options.cursor === undefined ? {} : { cursor: options.cursor })
  });
  if (!indexed) {
    throw new ApplyTransactionSafetyError(
      "Apply Receipt history has no complete ready head; automatic legacy or missing-head migration is disabled"
    );
  }
  return {
    receipts: indexed.receipts.map((summary) => {
      const fullReceiptAvailability = summary.fullReceiptAvailability;
      return {
        id: summary.id,
        kind: summary.kind,
        outcome: summary.outcome,
        planId: summary.planId,
        planDigest: summary.planDigest,
        causalSourceReceiptId: summary.causalSourceReceiptId,
        causalSourceReceiptDigest: summary.causalSourceReceiptDigest,
        completedAt: summary.completedAt,
        operationCount: summary.operationCount,
        inversePlanReplayability: summary.inversePlanReplayability,
        fullReceiptAvailability,
        receiptPath: fullReceiptAvailability === "available"
          ? objectPath(layout.receipts, summary.receiptDigest, "json")
          : null
      };
    }),
    nextCursor: indexed.nextCursor
  };
}

/**
 * Rebuilds the disposable pagination index from canonical, fully validated
 * transaction Receipts. The sentinel is replaced only after every summary is
 * present and no unowned summary remains.
 */
export async function ensureApplyReceiptSummaryHistory(
  layout: ApplyLayout,
  profileId: string,
  hooks: {
    readonly afterMigrationLock?: () => void | Promise<void>;
    readonly afterFreshBootstrapArtifacts?: () => void | Promise<void>;
    readonly bootstrapAt?: Date;
  } = {}
): Promise<void> {
  await withApplyReceiptHistoryMigration(layout, profileId, async (historyControl) => {
    const readyHistory = await readApplyReceiptSummaryPage(layout, profileId, { limit: 1, historyControl });
    let hasUnfinishedIndex = await hasApplyUnfinishedIndex(layout, profileId);
    if (hasUnfinishedIndex) {
      await reconcileApplyUnfinishedIndexPublication(layout, profileId);
      hasUnfinishedIndex = await hasApplyUnfinishedIndex(layout, profileId);
    }
    const accounting = await readApplyStoreAccounting(layout, profileId);
    if (readyHistory && hasUnfinishedIndex && accounting) {
      if (isPristineFreshApplyStore(readyHistory, accounting)) {
        await rebaseFreshApplyStoreAccountingExact(
          layout,
          profileId,
          historyControl,
          hooks.bootstrapAt ?? new Date()
        );
      }
      return;
    }
    await hooks.afterMigrationLock?.();
    await reconcileApplyStoreFreshBootstrapTemporaries(layout, historyControl);
    // Normal commands may only complete a crash-interrupted empty bootstrap.
    // Any transaction-bearing or ledger-bearing store requires an explicit
    // future migration protocol with its own durable reservation and receipt.
    if (readyHistory || hasUnfinishedIndex || accounting) {
      try {
        await assertApplyStoreFreshBootstrap(layout);
      } catch (error) {
        throw new ApplyTransactionSafetyError(
          `Apply store bootstrap is incomplete and cannot be repaired implicitly: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    } else {
      await assertApplyStoreFreshBootstrap(layout);
    }
    if (!accounting) {
      await initializeEmptyApplyStoreAccounting(layout, profileId, hooks.bootstrapAt ?? new Date());
    }
    if (!hasUnfinishedIndex) await initializeApplyUnfinishedIndex(layout, profileId);
    if (!readyHistory) {
      await replaceApplyReceiptSummaryHistory(layout, profileId, [], { historyControl });
    }
    const verified = await readApplyReceiptSummaryPage(layout, profileId, { limit: 1, historyControl });
    if (!verified || !await hasApplyUnfinishedIndex(layout, profileId)
      || !await readApplyStoreAccounting(layout, profileId)) {
      throw new ApplyTransactionSafetyError(
        "Fresh Apply store bootstrap did not publish its complete accounting, unfinished index, and ready Receipt head"
      );
    }
    await hooks.afterFreshBootstrapArtifacts?.();
    const verifiedAccounting = await readApplyStoreAccounting(layout, profileId);
    if (!verifiedAccounting || !isPristineFreshApplyStore(verified, verifiedAccounting)) {
      throw new ApplyTransactionSafetyError(
        "Fresh Apply store bootstrap lost its pristine exact-rebase eligibility"
      );
    }
    await rebaseFreshApplyStoreAccountingExact(
      layout,
      profileId,
      historyControl,
      hooks.bootstrapAt ?? new Date()
    );
  });
}

function isPristineFreshApplyStore(
  history: Awaited<ReturnType<typeof readApplyReceiptSummaryPage>>,
  accounting: NonNullable<Awaited<ReturnType<typeof readApplyStoreAccounting>>>
): boolean {
  return history !== null
    && history.receipts.length === 0
    && history.nextCursor === null
    && accounting.schemaVersion === "zts.apply-store-accounting.provisional-5"
    && accounting.activeReservation === null
    && accounting.lastSettledTransactionId === null
    && accounting.settledMarkerCredit === null
    && accounting.maintenanceId === null
    && accounting.maintenanceReservationBytes === 0
    && accounting.maintenanceReservationEntries === 0
    && accounting.maintenanceSourceHeadRevision === null;
}

export async function listTransactionReceipts(
  profileId: string,
  options: { readonly limit?: number; readonly cursor?: string } = {}
): Promise<TransactionReceiptSummary[]> {
  return [...(await listTransactionReceiptPage(profileId, options)).receipts];
}

async function assertNoUnfinishedApplyTransactions(
  profileId: string,
  excludedTransactionId: string | null = null
): Promise<void> {
  let layout: ApplyLayout;
  try {
    layout = await readApplyArtifactLayout(profileId);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  let markers = await readApplyUnfinishedMarkers(layout, profileId, loadUnfinishedMarkerPlan);
  if (markers === null) {
    const writableLayout = await applyLayout(profileId);
    await ensureApplyReceiptSummaryHistory(writableLayout, profileId);
    markers = await readApplyUnfinishedMarkers(writableLayout, profileId, loadUnfinishedMarkerPlan);
  }
  if (markers !== null) {
    const unfinished = markers.find((marker) => marker.journal.transactionId !== excludedTransactionId);
    if (unfinished) {
      const transactionId = unfinished.journal.transactionId;
      throw new ApplyTransactionSafetyError(
        `Unfinished Apply Transaction ${transactionId} blocks new mutation; inspect it with zts apply recover ${transactionId}`
      );
    }
    return;
  }
  throw new ApplyTransactionSafetyError("Apply unfinished index migration did not complete");
}

async function assertNoLegacyIdentityHazards(context: ProfileContext): Promise<void> {
  const identities = await discoverLegacyProfileIdentities(context.appSupportDir, context.profile);
  const checkedProfileIds = new Set<string>();
  for (const identity of identities) {
    if (checkedProfileIds.has(identity.profileId)) continue;
    checkedProfileIds.add(identity.profileId);
    try {
      await assertNoUnfinishedApplyTransactions(identity.profileId);
    } catch (error) {
      throw new ApplyTransactionSafetyError(
        `Pre-path-identity zts safety state blocks mutation: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  for (const identity of identities) {
    const legacyLockPath = legacyProfileTransactionLockPath(identity);
    try {
      await readPrivateJson(legacyLockPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw new ApplyTransactionSafetyError(
        `Pre-path-identity zts Profile lock is unreadable and blocks mutation at ${legacyLockPath}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
    throw new ApplyTransactionSafetyError(
      `Pre-path-identity zts Profile lock blocks mutation and must be audited before removal: ${legacyLockPath}`
    );
  }
}

export async function verifyTransactionReceipt(
  context: ProfileContext,
  receiptId: string
): Promise<TransactionReceiptVerificationReport> {
  const found = await findTransactionReceipt(context.profile.id, receiptId);
  if (!found) throw new ApplyReceiptSelectionError(`Transaction apply receipt not found: ${receiptId}`);
  const blockers: string[] = [];
  if (found.receipt.profileId !== context.profile.id) blockers.push("Transaction receipt belongs to a different Profile");
  if (found.receipt.outcome !== "applied" && found.receipt.outcome !== "compensated") {
    blockers.push(`Receipt outcome ${found.receipt.outcome} is not a verified successful final state`);
  }
  const config = await loadConfig();
  const captured = await captureSessionSnapshot(context, config.config);
  if (captured.authorityBlocker) {
    blockers.push(`Transaction receipt verification is non-authoritative: ${captured.authorityBlocker}`);
  }
  const snapshot = captured.snapshot;
  const entities = new Map(snapshot.entities.map((entity) => [entity.ref, entity]));
  const mismatches: TransactionReceiptVerificationReport["verification"]["mismatches"] = [];
  let checkedOperations = 0;
  for (const operation of found.receipt.operations) {
    if (operation.status !== "verified" && operation.status !== "compensated") continue;
    checkedOperations += 1;
    if (!operation.observedWorkspaceId) {
      mismatches.push({
        actionId: operation.actionId,
        entityRef: operation.entityRef,
        expectedWorkspaceId: null,
        actualWorkspaceId: null,
        reason: "unsupported_operation"
      });
      continue;
    }
    const entity = entities.get(operation.entityRef);
    if (!entity) {
      mismatches.push({
        actionId: operation.actionId,
        entityRef: operation.entityRef,
        expectedWorkspaceId: operation.observedWorkspaceId,
        actualWorkspaceId: null,
        reason: "missing_entity"
      });
      continue;
    }
    if (entity.workspaceId !== operation.observedWorkspaceId) {
      mismatches.push({
        actionId: operation.actionId,
        entityRef: operation.entityRef,
        expectedWorkspaceId: operation.observedWorkspaceId,
        actualWorkspaceId: entity.workspaceId,
        reason: "workspace_mismatch"
      });
    }
  }
  return {
    receiptId: found.receipt.id,
    profileId: found.receipt.profileId,
    receiptPath: found.receiptPath,
    receipt: found.receipt,
    inversePlanReplayability: await inversePlanReplayability(
      await readApplyArtifactLayout(context.profile.id),
      found.receipt.inversePlanArtifact
    ),
    verification: {
      ok: blockers.length === 0 && mismatches.length === 0,
      checkedOperations,
      mismatchCount: mismatches.length,
      blockers,
      mismatches
    }
  };
}

export async function findTransactionReceipt(
  profileId: string,
  receiptId: string,
  options: { readonly allowLegacyGlobalScan?: boolean } = {}
): Promise<{ readonly receipt: Receipt; readonly receiptPath: string } | null> {
  let layout: ApplyLayout;
  try {
    layout = await readApplyArtifactLayout(profileId);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const transactionId = transactionIdFromReceiptId(receiptId);
  const markers = await readApplyUnfinishedMarkers(layout, profileId, loadUnfinishedMarkerPlan);
  const isCurrentUnfinished = markers?.some((marker) =>
    marker.journal.transactionId === transactionId
  ) ?? false;
  let historySummary: ApplyReceiptSummary | null = null;
  // The exact unfinished marker is exclusive admission authority. While it
  // exists, no later transaction can append, so its terminal publication (if
  // any) can be resolved from its transaction pointer and O(1) ready-head
  // identity without scanning completed history.
  if (!isCurrentUnfinished) {
    historySummary = await findApplyReceiptSummary(layout, profileId, receiptId, 50_000);
    if (historySummary?.fullReceiptAvailability === "archived_summary_only") {
      throw new ApplyReceiptArchivedError(receiptId);
    }
  }
  let transactionRoot: string;
  try {
    transactionRoot = await assertPrivateDirectory(layout.transactions, safeSegment(transactionId));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      if (historySummary) {
        throw new Error(`Ready Apply Receipt ${receiptId} is missing its canonical transaction directory`);
      }
      return null;
    }
    throw error;
  }
  if (!isCurrentUnfinished && markers !== null && historySummary === null) {
    throw new Error(`Markerless Apply Receipt ${receiptId} has transaction artifacts but is not reachable from ready history`);
  }
  const pointer = await readApplyReceiptPointer(transactionRoot, receiptId);
  const intent = await readApplyReceiptPublicationIntent(transactionRoot, receiptId);
  if (pointer && intent && (
    pointer.transactionId !== intent.transactionId
    || pointer.receiptId !== intent.receiptId
    || pointer.receiptDigest !== intent.receiptDigest
  )) {
    throw new Error("Apply Receipt pointer and publication intent disagree");
  }
  if (historySummary && !pointer) {
    throw new Error(`Ready Apply Receipt ${receiptId} is missing its canonical transaction pointer`);
  }
  if (historySummary && !intent) {
    throw new Error(`Ready Apply Receipt ${receiptId} is missing its canonical publication intent`);
  }
  if (pointer) {
    if (historySummary && pointer.receiptDigest !== historySummary.receiptDigest) {
      throw new Error("Apply Receipt pointer disagrees with its ready history summary");
    }
    const filename = `${digestHex(pointer.receiptDigest)}.json`;
    const receiptPath = privatePath(layout.receipts, filename);
    const receipt = await loadTransactionReceiptAt(profileId, receiptPath, filename);
    if (receipt.id !== receiptId) throw new Error("Apply Receipt pointer resolves to a different Receipt");
    if (intent && sha256Canonical(receipt) !== sha256Canonical(intent.receipt)) {
      throw new Error("Apply Receipt pointer object disagrees with its publication intent bytes");
    }
    if (historySummary) await assertReceiptMatchesReadySummary(layout, receipt, historySummary);
    return { receipt, receiptPath };
  }

  if (intent) {
    const receipt = await defineStoredTransactionReceipt(profileId, intent.receipt);
    const filename = `${digestHex(intent.receiptDigest)}.json`;
    const receiptPath = privatePath(layout.receipts, filename);
    try {
      const storedReceipt = await loadTransactionReceiptAt(profileId, receiptPath, filename);
      if (sha256Canonical(storedReceipt) !== intent.receiptDigest) {
        throw new Error("Apply Receipt object does not match its publication intent");
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    return { receipt, receiptPath };
  }

  if (options.allowLegacyGlobalScan === false || await hasApplyUnfinishedIndex(layout, profileId)) return null;

  const entries = (await readDirectoryIfPresent(layout.receipts)).filter((entry) => entry.endsWith(".json"));
  for (const entry of entries) {
    const receiptPath = privatePath(layout.receipts, entry);
    const receipt = await loadTransactionReceiptAt(profileId, receiptPath, entry);
    if (receipt.id === receiptId) return { receipt, receiptPath };
  }
  return null;
}

/** Explicit maintenance validator: one full Receipt is parsed and bound once. */
export async function validateTransactionReceiptSummaryForRetention(
  profileId: string,
  summary: ApplyReceiptSummary
): Promise<Receipt> {
  const definedSummary = defineApplyReceiptSummary(summary, profileId);
  if (definedSummary.fullReceiptAvailability !== "available") {
    throw new Error(`Full Apply Receipt ${summary.id} is already archived`);
  }
  const layout = await readApplyArtifactLayout(profileId);
  const transactionId = transactionIdFromReceiptId(summary.id);
  const transactionRoot = await assertPrivateDirectory(layout.transactions, safeSegment(transactionId));
  const pointer = await readApplyReceiptPointer(transactionRoot, summary.id);
  if (!pointer || pointer.receiptDigest !== summary.receiptDigest) {
    throw new Error(`Apply Receipt ${summary.id} pointer does not match its ready history summary`);
  }
  const filename = `${digestHex(summary.receiptDigest)}.json`;
  const receipt = await loadTransactionReceiptAt(
    profileId,
    privatePath(layout.receipts, filename),
    filename
  );
  await assertReceiptMatchesReadySummary(layout, receipt, definedSummary);
  return receipt;
}

async function assertReceiptMatchesReadySummary(
  layout: ApplyLayout,
  receipt: Receipt,
  summary: ApplyReceiptSummary
): Promise<void> {
  const replayability = await inversePlanReplayability(layout, receipt.inversePlanArtifact);
  const receiptPlan = (await loadStoredPlan(summary.profileId, receipt.planDigest)).plan;
  const canonical = defineApplyReceiptSummary({
    id: receipt.id,
    kind: "saved_plan",
    outcome: receipt.outcome,
    planId: receipt.planId,
    planDigest: receipt.planDigest,
    causalSourceReceiptId: receiptPlan.source.kind === "inverse"
      ? receiptPlan.source.sourceReceiptId
      : null,
    causalSourceReceiptDigest: receiptPlan.source.kind === "inverse"
      ? receiptPlan.source.sourceReceiptDigest
      : null,
    profileId: receipt.profileId,
    completedAt: receipt.completedAt,
    operationCount: receipt.operations.length,
    inversePlanReplayability: replayability,
    receiptDigest: sha256Canonical(receipt),
    fullReceiptAvailability: "available",
    archivedAt: null
  }, summary.profileId);
  if (sha256Canonical(canonical) !== sha256Canonical(summary)) {
    throw new Error(`Full Apply Receipt ${summary.id} disagrees with its ready history summary`);
  }
}

async function loadTransactionReceiptAt(profileId: string, receiptPath: string, filename: string): Promise<Receipt> {
  const value = await readPrivateJson(receiptPath, RECEIPT_MAX_BYTES);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Transaction Receipt must be an object");
  const receipt = value as Receipt;
  const expectedFilename = `${digestHex(sha256Canonical(receipt))}.json`;
  if (filename !== expectedFilename) throw new Error("Transaction Receipt filename does not match its content digest");
  return defineStoredTransactionReceipt(profileId, receipt);
}

async function defineStoredTransactionReceipt(profileId: string, receipt: Receipt): Promise<Receipt> {
  if (receipt.profileId !== profileId) throw new Error("Transaction Receipt Profile does not match its store");
  const stored = await loadStoredPlan(profileId, receipt.planDigest);
  const layout = await readApplyArtifactLayout(profileId);
  const authorizationValue = await readPrivateJson(
    objectPath(layout.authorizations, receipt.authorization.revision, "json")
  );
  const authorization = defineApplyAuthorization(
    stored.snapshot,
    stored.plan,
    authorizationValue as ApplyAuthorization
  );
  const defined = defineReceipt(stored.snapshot, stored.plan, authorization, receipt);
  await assertJsonArtifact(layout.journals, defined.journalArtifact);
  await assertJsonArtifact(layout.controls, defined.control.proof);
  if (defined.backupArtifact) await assertJsonArtifact(layout.backupManifests, defined.backupArtifact);
  if (defined.recoveryArtifact) await assertJsonArtifact(layout.recoveries, defined.recoveryArtifact);
  if (defined.inversePlanArtifact) {
    await inversePlanReplayability(layout, defined.inversePlanArtifact);
  }
  return defined;
}

export async function inversePlanReplayability(
  layout: ApplyLayout,
  reference: ArtifactReference | null
): Promise<"bound_snapshot" | "legacy_unbound" | "none"> {
  if (!reference) return "none";
  const value = await readPrivateJson(
    objectPath(layout.inverses, reference.digest, "json"),
    INVERSE_PLAN_MAX_BYTES
  );
  if (value && typeof value === "object" && !Array.isArray(value)
    && (value as { schemaVersion?: unknown }).schemaVersion === "zts.inverse-plan-artifact.provisional-1") {
    await loadInversePlan(layout, reference);
    return "bound_snapshot";
  }
  const legacy = definePlan(value as Plan);
  if (legacy.id !== reference.id || legacy.digest !== reference.digest) {
    throw new Error("Legacy inverse Plan artifact does not match its Receipt reference");
  }
  return "legacy_unbound";
}

async function assertJsonArtifact(root: string, reference: ArtifactReference): Promise<void> {
  const value = await readPrivateJson(objectPath(root, reference.digest, "json"));
  if (sha256Canonical(value) !== reference.digest) {
    throw new Error(`Transaction artifact ${reference.id} does not match its Receipt digest`);
  }
}

async function readDirectoryIfPresent(path: string): Promise<string[]> {
  try {
    return await readdir(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

function createAuthorization(
  snapshot: Snapshot,
  plan: Plan,
  moveActions: readonly MoveAction[],
  consentArtifact: ArtifactReference,
  transactionId: string,
  authorizedAt: string,
  managedLifecycleBinding: ManagedZenLifecycleBinding | null
): ApplyAuthorization {
  const trustClasses = uniqueTrustClasses(moveActions);
  const protectionGrants = moveActions.flatMap((action) => protectionGrantsForAction(plan, action));
  return createApplyAuthorization(snapshot, plan, {
    schemaVersion: "zts.authorization.provisional-1",
    id: `authorization:${transactionId}`,
    planId: plan.id,
    planDigest: plan.digest,
    profileId: plan.profileId,
    authorizedAt,
    expiresAt: plan.expiresAt,
    source: { kind: "unattended_invocation", consentArtifact },
    authorizedActionIds: moveActions.map((action) => action.actionId) as [string, ...string[]],
    allowedTrustClasses: trustClasses,
    protectionGrants,
    lifecycle: managedLifecycleBinding
      ? {
          kind: "managed_zen",
          grantRevision: managedZenGrantRevision(
            managedLifecycleBinding,
            plan.digest,
            consentArtifact.digest
          ),
          relaunchRequired: true,
          restoreWindowsRequired: true
        }
      : { kind: "none" },
    wholePlanPreflight: true
  });
}

function protectionGrantsForAction(plan: Plan, action: MoveAction): ProtectionGrant[] {
  const grants: ProtectionGrant[] = [];
  const add = (
    protection: MoveProtectionPrecondition,
    subject: ProtectionGrant["subject"]
  ) => {
    if (!protection.protected) return;
    const common = {
      id: protection.requiredGrantId,
      planDigest: plan.digest,
      actionId: action.actionId,
      protectionRevision: protection.protectionRevision,
      reasons: protection.reasons,
      issuedBy: "invocation" as const
    };
    grants.push(subject.kind === "entity"
      ? createProtectionGrant({ ...common, subject })
      : createProtectionGrant({ ...common, subject }));
  };
  add(action.operation.precondition.entityProtection, {
    kind: "entity",
    entityRef: action.operation.entityRef
  });
  add(action.operation.precondition.sourceWorkspace.protection, {
    kind: "workspace",
    workspaceId: action.operation.precondition.sourceWorkspace.workspaceId,
    participation: "source"
  });
  add(action.operation.precondition.destinationWorkspace.protection, {
    kind: "workspace",
    workspaceId: action.operation.precondition.destinationWorkspace.workspaceId,
    participation: "destination"
  });
  return grants;
}

function preflightOperations(
  snapshot: Snapshot,
  session: RawZenSession,
  summary: ReturnType<typeof summarizeSession>,
  moveActions: readonly MoveAction[]
) {
  const exclusive = snapshot.capabilities.evidence.find((item) => item.id === "profile.exclusive_control");
  const moveTab = snapshot.capabilities.evidence.find((item) => item.id === "move.tab");
  if (exclusive?.status !== "available") {
    throw new ApplyTransactionSafetyError("Closed-session apply lacks current exclusive Profile capability proof");
  }
  if (moveTab?.status !== "available") {
    throw new ApplyTransactionSafetyError("Closed-session apply lacks current tab-move capability proof");
  }
  const bindings = sessionTabBindings(snapshot, session, summary);
  const entities = new Map(snapshot.entities.map((entity) => [entity.ref, entity]));
  for (const action of moveActions) {
    if (action.operation.entityKind !== "tab") {
      throw new ApplyTransactionSafetyError(
        `Closed-session apply does not yet support ${action.operation.entityKind} Operation ${action.actionId}`
      );
    }
    const entity = entities.get(action.operation.entityRef);
    const binding = bindings.get(action.operation.entityRef);
    if (!entity || !movementEligibility(snapshot, entity).eligible || !binding || entity.nativeId !== binding.nativeId) {
      throw new ApplyTransactionSafetyError(
        `Whole-Plan preflight cannot bind ${action.operation.entityRef} to one exact native tab`
      );
    }
    if (binding.workspaceId !== action.operation.precondition.sourceWorkspace.workspaceId) {
      throw new ApplyTransactionSafetyError(
        `Whole-Plan preflight found source Workspace Drift for ${action.operation.entityRef}`
      );
    }
  }
  return bindings;
}

function applyOperationsInMemory(
  session: RawZenSession,
  bindings: ReturnType<typeof sessionTabBindings>,
  moveActions: readonly MoveAction[]
): void {
  if (!Array.isArray(session.tabs)) throw new Error("Zen session has no tab array to mutate");
  for (const action of moveActions) {
    const binding = bindings.get(action.operation.entityRef);
    const tab = binding ? session.tabs[binding.rawIndex] : undefined;
    if (!binding || !tab || tab.zenWorkspace !== action.operation.precondition.sourceWorkspace.workspaceId) {
      throw new Error(`Apply Transaction lost the preflight binding for ${action.operation.entityRef}`);
    }
    tab.zenWorkspace = action.operation.expectedPostState.workspaceId;
  }
}

function verifyOperations(snapshot: Snapshot, moveActions: readonly MoveAction[]) {
  const entities = new Map(snapshot.entities.map((entity) => [entity.ref, entity]));
  const results = moveActions.map((action) => {
    const entity = entities.get(action.operation.entityRef);
    if (!entity || entity.workspaceId !== action.operation.expectedPostState.workspaceId) {
      throw new Error(`Independent verification failed for ${action.operation.entityRef}`);
    }
    return {
      actionId: action.actionId,
      entityRef: action.operation.entityRef,
      observedWorkspaceId: entity.workspaceId,
      status: "verified" as const,
      mutationAttempted: true as const,
      netChanged: true as const,
      issueCodes: [] as const
    };
  });
  return results as [typeof results[number], ...typeof results[number][]];
}

function assertExactPlannedAfterSnapshot(
  observedSnapshot: Snapshot,
  expectedAfterSnapshot: Snapshot
): void {
  if (observedSnapshot.revision !== expectedAfterSnapshot.revision) {
    throw new Error(
      `Independent verification observed Snapshot ${observedSnapshot.revision}, expected the exact planned after-Snapshot ${expectedAfterSnapshot.revision}`
    );
  }
}

export function createInversePlan(
  afterSnapshot: Snapshot,
  appliedPlan: Plan,
  moveActions: readonly MoveAction[],
  sourceReceiptId: string,
  now: Date
): Plan {
  const createdAt = canonicalTimestamp(now);
  const expiresAt = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString();
  const entities = new Map(afterSnapshot.entities.map((entity) => [entity.ref, entity]));
  const workspaces = new Map(afterSnapshot.workspaces.map((workspace) => [workspace.id, workspace]));
  const actions = [...moveActions].reverse().map((appliedAction, index): PlanAction => {
    const entity = entities.get(appliedAction.operation.entityRef);
    const source = entity ? workspaces.get(entity.workspaceId) : undefined;
    const destination = workspaces.get(appliedAction.operation.inverse.destinationWorkspaceId);
    if (!entity || entity.parentRef !== null || !source || !destination) {
      throw new Error(`Cannot construct inverse Operation for ${appliedAction.actionId}`);
    }
    const actionId = inverseTemplateActionId(
      appliedPlan.digest,
      appliedAction.actionId,
      index
    );
    const explanation = {
      value: `Restore the Workspace changed by ${appliedAction.actionId}`,
      provenance: "zts_generated" as const,
      interpretation: "data_only" as const,
      referencedEntityRefs: [entity.ref]
    };
    return {
      actionId,
      disposition: "move",
      operation: {
        op: "move",
        entityRef: appliedAction.operation.entityRef,
        entityKind: entity.kind,
        precondition: {
          entityRevision: entity.revision,
          entityProtection: inverseProtection(entity.protection, `grant:${actionId}:entity`),
          sourceWorkspace: {
            workspaceId: source.id,
            protection: inverseProtection(source.protection.source, `grant:${actionId}:source`)
          },
          destinationWorkspace: {
            workspaceId: destination.id,
            protection: inverseProtection(destination.protection.destination, `grant:${actionId}:destination`)
          }
        },
        expectedPostState: { workspaceId: destination.id },
        inverse: { op: "move", destinationWorkspaceId: source.id }
      },
      decision: {
        engine: "manual",
        trustClass: "manual_exact",
        explanation,
        evidenceRevision: sha256Canonical(explanation),
        autoApply: {
          status: "not_requested",
          requested: false,
          eligible: false,
          reason: ztsMessage("Inverse Plans require separate exact review and authorization")
        }
      }
    };
  });
  return createPlan(afterSnapshot, {
    schemaVersion: "zts.plan.provisional-1",
    id: `plan:inverse:${digestHex(sha256Canonical({
      sourcePlanId: appliedPlan.id,
      sourcePlanDigest: appliedPlan.digest,
      afterSnapshotRevision: afterSnapshot.revision
    }))}`,
    configRevision: appliedPlan.configRevision,
    engineManifestRevision: sha256Canonical({ inverseAdapter: "zts.closed-session.provisional-1" }),
    createdAt,
    expiresAt,
    derivation: { kind: "original" },
    source: {
      kind: "inverse",
      sourceReceiptId,
      sourceReceiptDigest: null,
      inverseTemplateDigest: null,
      sourcePlanId: appliedPlan.id,
      sourcePlanDigest: appliedPlan.digest,
      intentRevision: sha256Canonical({
        sourceReceiptId,
        inverseOfPlan: appliedPlan.digest,
        operations: [...moveActions].reverse().map((action) => action.operation.inverse)
      })
    },
    actions
  });
}

async function publishBackup(
  layout: ApplyLayout,
  transactionId: string,
  context: ProfileContext,
  bytes: Uint8Array,
  fingerprint: JsonLz4Fingerprint
): Promise<ArtifactReference> {
  const rawArtifact = artifact(`backup-bytes:${transactionId}`, fingerprint.digest);
  await publishPrivateBytes(objectPath(layout.backups, rawArtifact.digest, "jsonlz4"), bytes);
  const manifest = {
    schemaVersion: BACKUP_SCHEMA,
    transactionId,
    profileId: context.profile.id,
    targetPathRevision: sha256Canonical({ path: context.sessionFile.path }),
    capturedAt: new Date().toISOString(),
    sourceFingerprint: fingerprint,
    rawArtifact
  };
  const reference = artifact(`backup:${transactionId}`, sha256Canonical(manifest));
  await publishPrivateJson(objectPath(layout.backupManifests, reference.digest, "json"), manifest);
  return reference;
}

async function publishRecoveryDescriptor(
  layout: ApplyLayout,
  transactionId: string,
  plan: Plan,
  context: ProfileContext,
  fingerprint: JsonLz4Fingerprint,
  backupArtifact: ArtifactReference
): Promise<ArtifactReference> {
  const recovery = {
    schemaVersion: RECOVERY_SCHEMA,
    transactionId,
    profileId: plan.profileId,
    planId: plan.id,
    planDigest: plan.digest,
    targetPathRevision: sha256Canonical({ path: context.sessionFile.path }),
    beforeSourceFingerprint: fingerprint,
    backupArtifact,
    status: "prepared_before_mutation",
    createdAt: new Date().toISOString()
  };
  const reference = artifact(`recovery:${transactionId}`, sha256Canonical(recovery));
  await publishPrivateJson(objectPath(layout.recoveries, reference.digest, "json"), recovery);
  return reference;
}

async function refreshTargetContext(initial: ProfileContext): Promise<ProfileContext> {
  const runningProcesses = await findZenProcesses();
  const running = runningProcesses.some((candidate) => zenProcessMayOwnProfile(candidate, initial.profile));
  return {
    ...initial,
    running,
    runningProcesses,
    sessionFile: await findSessionFile(initial.profile.path)
  };
}

function assertClosedSessionRoute(context: ProfileContext): void {
  if (context.running) {
    throw new ApplyTransactionSafetyError(
      "Closed-session Apply Transaction is blocked because Zen owns or may own the target Profile"
    );
  }
  if (context.sessionFile.kind !== "zen-sessions") {
    throw new ApplyTransactionSafetyError(
      "Closed-session Apply Transaction requires zen-sessions.jsonlz4 as the authoritative source"
    );
  }
}

function executableActions(plan: Plan): readonly MoveAction[] {
  const actions = plan.actions.filter((action): action is MoveAction => action.disposition === "move");
  if (actions.length === 0) throw new Error("Selected Plan has no executable move Operations");
  return actions;
}

function uniqueTrustClasses(actions: readonly MoveAction[]): [AuthorizableTrustClass, ...AuthorizableTrustClass[]] {
  const values: AuthorizableTrustClass[] = [];
  for (const action of actions) {
    if (action.decision.trustClass === "unknown") {
      throw new Error(`Plan Operation ${action.actionId} has an unknown Trust Class and cannot be authorized`);
    }
    if (!values.includes(action.decision.trustClass)) values.push(action.decision.trustClass);
  }
  return values as [AuthorizableTrustClass, ...AuthorizableTrustClass[]];
}

function inverseProtection(protection: Protection, grantId: string): MoveProtectionPrecondition {
  if (!protection.protected) return { protected: false, reasons: [], requiredGrantId: null };
  return {
    protected: true,
    reasons: protection.reasons,
    protectionRevision: sha256Canonical(protection),
    requiredGrantId: grantId
  };
}

async function removeTerminalMarker(
  layout: ApplyLayout,
  profileId: string,
  transactionId: string,
  afterStoreSettlement?: () => void | Promise<void>
): Promise<boolean> {
  try {
    await withApplyReceiptHistoryMigration(layout, profileId, async () => {
      const settlement = await reconcileAndMeasureApplyStoreSettlement(
        layout,
        profileId,
        transactionId
      );
      await settleApplyStoreReservation(
        layout,
        profileId,
        transactionId,
        settlement.exactStoreBytes,
        settlement.exactStoreEntries,
        settlement.markerBytes
      );
      await afterStoreSettlement?.();
      await removeApplyUnfinishedMarker(layout, transactionId);
    });
    return true;
  } catch {
    // A terminal Receipt is already durable. Keeping the marker is fail-safe:
    // recovery listing will surface the remaining index cleanup explicitly.
    return false;
  }
}

function canonicalTimestamp(value: Date): string {
  if (!Number.isFinite(value.getTime())) throw new Error("Apply Transaction timestamp is invalid");
  return value.toISOString();
}

async function loadUnfinishedMarkerPlan(profileId: string, planDigest: string): Promise<Plan> {
  return (await loadStoredPlan(profileId, planDigest)).plan;
}

function processCheck(label: string, context: ProfileContext): Readonly<Record<string, unknown>> {
  const applicablePids = context.runningProcesses
    .filter((candidate) => zenProcessMayOwnProfile(candidate, context.profile))
    .map((candidate) => candidate.pid)
    .sort((left, right) => left - right);
  return {
    label,
    checkedAt: new Date().toISOString(),
    processRevision: sha256Canonical(context.runningProcesses.map((candidate) => ({
      pid: candidate.pid,
      argsRevision: sha256Canonical({ args: candidate.args }),
      profilePathRevision: candidate.profilePath ? sha256Canonical({ path: candidate.profilePath }) : null
    }))),
    processCount: context.runningProcesses.length,
    applicablePids,
    targetProfilePossiblyOwned: context.running
  };
}

function classifyPreflightIssue(message: string): string {
  if (/Zen owns|Zen.*running|persisted observation/iu.test(message)) return "zen_running";
  if (/Drift|exact Snapshot|bound to the supplied exact Snapshot/iu.test(message)) return "plan_drift";
  if (/capability/iu.test(message)) return "capability_unavailable";
  return "preflight_blocked";
}

function assertEffectiveConfigRevision(
  plan: Plan,
  observedRevision: Sha256Digest,
  boundary: string
): void {
  if (observedRevision !== plan.configRevision) {
    throw new ApplyTransactionSafetyError(
      `Whole-Plan preflight failed: effective config Drift was detected at the ${boundary}; create and review a fresh Plan`
    );
  }
}

function assertPlanForPreflight(snapshot: Snapshot, plan: Plan): void {
  if (plan.profileId !== snapshot.profile.id
    || plan.snapshotRevision !== snapshot.revision
    || plan.snapshotAuthority !== snapshot.authority
    || plan.snapshotFreshness !== snapshot.freshness) {
    throw new ApplyTransactionSafetyError(
      `Whole-Plan preflight failed: Plan ${plan.digest} is not bound to the current exact Snapshot ${snapshot.revision}`
    );
  }
  // A matching binding followed by any remaining domain validation failure is
  // stored-Plan corruption or an implementation invariant, not a safe state
  // refusal, and must retain the internal-error disposition.
  definePlanForSnapshot(snapshot, plan);
}

function requiredArtifact(value: ArtifactReference | null, label: string): ArtifactReference {
  if (!value) throw new Error(`${label} is unavailable`);
  return value;
}

function ztsMessage(value: string): ZtsMessage {
  return {
    value: boundedZtsMessageValue(value),
    provenance: "zts_generated",
    interpretation: "data_only"
  };
}
