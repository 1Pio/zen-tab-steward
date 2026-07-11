import { createHash, randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { lstat, open, opendir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { readBoundedFileState, reconcileInterruptedAtomicReplace } from "./atomic-file-cas.js";
import {
  applyArtifactLayout,
  artifactObjectPath,
  artifactReference,
  readApplyArtifactLayout,
  safeArtifactSegment
} from "./apply-artifacts.js";
import {
  appendApplyJournal,
  bindApplyRecoveryControl,
  defineApplyJournal,
  journalArtifactReference,
  journalBeforeFingerprint,
  journalCommitStageSeen,
  journalEntry,
  journalLockRevision,
  journalPreparedDigest
} from "./apply-journal.js";
import {
  assertJournalMatchesUnfinishedMarker,
  readApplyUnfinishedMarkers,
  removeApplyUnfinishedMarker
} from "./apply-unfinished-store.js";
import {
  preflightApplyReceiptPublication,
  publishApplyReceipt,
  withApplyReceiptHistoryMigration
} from "./apply-receipt-store.js";
import {
  APPLY_RECOVERY_TERMINAL_INTENT_MAX_BYTES,
  APPLY_TRANSACTION_ARTIFACT_CAP_BYTES,
  APPLY_TRANSACTION_MAX_ARTIFACT_BYTES,
  APPLY_TRANSACTION_RESERVATION_ENTRIES,
  ensureApplyStoreRecoveryReservation,
  readApplyStoreAccounting,
  reconcileAndMeasureApplyStoreSettlement,
  settleApplyStoreReservation
} from "./apply-store-accounting.js";
import {
  createInversePlan,
  ensureApplyReceiptSummaryHistory,
  findTransactionReceipt,
  inversePlanReplayability
} from "./apply-transaction.js";
import { loadConfig } from "./config.js";
import { acquireNativeProfileControl } from "./closed-session-control.js";
import {
  boundedZtsMessageValue,
  defineApplyAuthorization,
  definePlanForSnapshot,
  defineReceipt
} from "./domain/change.js";
import { sha256Canonical } from "./domain/digest.js";
import { DEFAULT_MAX_COMPRESSED_BYTES, readJsonLz4State, sameJsonLz4Fingerprint } from "./mozlz4.js";
import { loadStoredPlan } from "./plans.js";
import { loadInversePlan, publishInversePlan } from "./inverse-plan-store.js";
import { deriveExactPlannedAfterSnapshot } from "./planned-after-snapshot.js";
import {
  defineInvocationConsent,
  INVOCATION_CONSENT_MAX_BYTES
} from "./invocation-consent.js";
import {
  assertPrivateDirectory,
  createPrivateJsonExclusive,
  encodePrivateJsonBytes,
  ensurePrivateDirectory,
  privatePath,
  publishPrivateBytes,
  publishPrivateJson,
  readPrivateBytes,
  readPrivateJson,
  removePrivateFile,
  replacePrivateJson
} from "./private-store.js";
import { acquireExclusiveFileControl } from "./exclusive-control.js";
import { findSessionFile, zenProcessMayOwnProfile } from "./profile.js";
import { assertProcessOwner, currentProcessOwner, processOwnerIsActive } from "./process-owner.js";
import {
  acquireProfileTransactionLock,
  inspectProfileTransactionLock,
  releaseStaleProfileTransactionLock
} from "./profile-lock.js";
import { findZenProcesses } from "./processes.js";
import { captureControlledSessionSnapshot } from "./session-snapshot.js";

import type { ApplyAuthorization, Plan, PlanAction, Receipt, ZtsMessage } from "./domain/change.js";
import type { Sha256Digest } from "./domain/digest.js";
import type { ArtifactReference, Snapshot } from "./domain/snapshot.js";
import type { JsonLz4Fingerprint } from "./mozlz4.js";
import type { ProfileLockInspection } from "./profile-lock.js";
import type { ProfileTransactionLock } from "./profile-lock.js";
import type { ProfileContext } from "./profile.js";
import type { ApplyArtifactLayout } from "./apply-artifacts.js";
import type { ApplyJournal, ApplyJournalStage } from "./apply-journal.js";
import type { ApplyUnfinishedBootstrap } from "./apply-unfinished-store.js";
import type { StoredPlan } from "./plans.js";
import type { ExclusiveFileControl } from "./exclusive-control.js";
import type { NativeProfileControl } from "./closed-session-control.js";
import type { InterruptedAtomicReplaceResult } from "./atomic-file-cas.js";

const RECOVERY_SCHEMA = "zts.apply-recovery.provisional-1" as const;
const RECOVERY_CONTROL_SCHEMA = "zts.closed-session-recovery-control.provisional-1" as const;
const RECOVERY_CLAIM_SCHEMA = "zts.apply-recovery-claim.provisional-1" as const;
const RECOVERY_INSPECTION_SCHEMA = "zts.apply-recovery-inspection.provisional-1" as const;
const RECOVERY_TERMINAL_INTENT_SCHEMA = "zts.apply-recovery-terminal-intent.provisional-1" as const;
export const RECOVERY_TERMINAL_INTENT_FILENAME = "recovery-terminal-intent.json";
const MAX_LEGACY_RECOVERY_TRANSACTIONS = 512;
const MAX_PROFILE_RECOVERY_SCAN_ENTRIES = 4_096;

type MoveAction = Extract<PlanAction, { readonly disposition: "move" }>;
type ReconciledAtomicBoundary = Exclude<
  InterruptedAtomicReplaceResult,
  { readonly classification: "uncertain" }
>;

type RecoveryJournal = ApplyJournal;
type RecoveryJournalRecord = {
  readonly journal: RecoveryJournal;
  readonly journalPath: string;
  readonly fromUnfinishedIndex: boolean;
  readonly bootstrap: ApplyUnfinishedBootstrap | null;
  /** True only when no canonical journal exists and recovery is reading the initial journal from the marker. */
  readonly bootstrapOnly: boolean;
};

interface RecoveryClaimRecord {
  readonly schemaVersion: typeof RECOVERY_CLAIM_SCHEMA;
  readonly transactionId: string;
  readonly token: string;
  readonly pid: number;
  readonly processStartIdentity: string | null;
  readonly host: string;
  readonly claimedAt: string;
}

interface BackupManifestArtifact {
  readonly schemaVersion: "zts.session-backup.provisional-1";
  readonly transactionId: string;
  readonly profileId: string;
  readonly targetPathRevision: Sha256Digest;
  readonly capturedAt: string;
  readonly sourceFingerprint: JsonLz4Fingerprint;
  readonly rawArtifact: ArtifactReference;
}

interface RecoveryDescriptorArtifact {
  readonly schemaVersion: typeof RECOVERY_SCHEMA;
  readonly transactionId: string;
  readonly profileId: string;
  readonly planId: string;
  readonly planDigest: Sha256Digest;
  readonly targetPathRevision: Sha256Digest;
  readonly beforeSourceFingerprint: JsonLz4Fingerprint;
  readonly backupArtifact: ArtifactReference | null;
  readonly status: "prepared_before_mutation" | "created_during_hard_crash_recovery";
  readonly createdAt: string;
}

interface RecoveryControlProofArtifact {
  readonly schemaVersion: typeof RECOVERY_CONTROL_SCHEMA;
  readonly transactionId: string;
  readonly profileId: string;
  readonly route: "closed_session";
  readonly recoveredAt: string;
  readonly journalStageBeforeClosure: ApplyJournalStage;
  readonly lockStatusAtInspection: ProfileLockInspection["status"];
  readonly currentFingerprint: JsonLz4Fingerprint;
  readonly beforeFingerprint: JsonLz4Fingerprint | null;
  readonly preparedDigest: Sha256Digest | null;
  readonly classification: RecoveryClassification;
  readonly mutationAttempted: boolean;
  readonly allOperationsVerified: boolean;
  readonly atomicCommitReconciliation: Readonly<Record<string, unknown>> | null;
  readonly exclusiveControlReleased: "verified";
  readonly nativeProfileControl: {
    readonly proof: unknown;
    readonly released: true;
  };
  readonly ztsProfileControl: {
    readonly staleLockReleased: boolean;
    readonly recoveryLockReleased: boolean;
    readonly releasedAt: string;
  };
  readonly preparedTemporaryArtifact: ArtifactReference | null;
  readonly preparedTemporaryCompleteness: PreparedTemporaryReconciliation["completeness"] | null;
  readonly preparedTemporaryDisposition: PreparedTemporaryReconciliation["disposition"] | null;
}

type RecoveryReceiptTemplate = Receipt extends infer Candidate
  ? Candidate extends Receipt
    ? Omit<Candidate, "journalArtifact">
    : never
  : never;

interface RecoveryTerminalIntentContent {
  readonly schemaVersion: typeof RECOVERY_TERMINAL_INTENT_SCHEMA;
  readonly transactionId: string;
  readonly profileId: string;
  readonly planId: string;
  readonly planDigest: Sha256Digest;
  readonly authorizationRevision: Sha256Digest;
  readonly journalPrefixLength: number;
  readonly journalPrefixRevision: Sha256Digest;
  readonly preparedAt: string;
  readonly controlProof: RecoveryControlProofArtifact;
  readonly controlArtifact: ArtifactReference;
  readonly issueCode: string;
  readonly recoveryArtifact: ArtifactReference;
  readonly inversePlanArtifact: ArtifactReference | null;
  readonly receiptTemplate: RecoveryReceiptTemplate;
}

export interface RecoveryTerminalIntent {
  readonly content: RecoveryTerminalIntentContent;
  readonly intentBindingRevision: Sha256Digest;
  readonly finalJournalDigest: Sha256Digest;
  readonly receiptDigest: Sha256Digest;
}

interface ResolvedRecoveryTerminalIntent extends RecoveryTerminalIntent {
  readonly finalJournal: ApplyJournal;
  readonly receipt: Receipt;
}

export type RecoveryClaimInspection =
  | { readonly status: "absent"; readonly path: string; readonly artifactRevision: null }
  | {
      readonly status: "active" | "stale";
      readonly path: string;
      readonly artifactRevision: Sha256Digest;
      readonly pid: number;
      readonly claimedAt: string;
    }
  | {
      readonly status: "invalid";
      readonly path: string;
      readonly artifactRevision: null;
      readonly blocker: string;
    };

export type RecoveryClassification =
  | "complete"
  | "blocked_zen_running"
  | "blocked_native_control"
  | "blocked_active_lock"
  | "blocked_invalid_lock"
  | "blocked_lock_mismatch"
  | "blocked_target_mismatch"
  | "blocked_control_closure"
  | "blocked_ambiguous_drift"
  | "before_state_present"
  | "planned_after_present"
  | "external_drift"
  | "unclassified";

export interface ApplyRecoveryInspection {
  readonly transactionId: string;
  readonly receiptId: string;
  readonly planId: string;
  readonly planDigest: Sha256Digest;
  readonly journalStage: string;
  readonly journalPath: string;
  readonly recoveryRevision: Sha256Digest;
  readonly classification: RecoveryClassification;
  readonly currentFingerprint: JsonLz4Fingerprint | null;
  readonly beforeFingerprint: JsonLz4Fingerprint | null;
  readonly preparedDigest: Sha256Digest | null;
  readonly atomicResidue: {
    readonly path: string;
    readonly pathRevision: Sha256Digest;
    readonly fingerprint: JsonLz4Fingerprint;
  } | null;
  readonly lock: ProfileLockInspection;
  readonly recoveryClaim: RecoveryClaimInspection;
  readonly terminalReceipt: Receipt | null;
  readonly blockers: readonly string[];
  readonly recoverable: boolean;
}

export interface ApplyRecoveryOptions {
  readonly expectedRecoveryRevision: string;
  /** Internal race hook after revision-bound inspection but before recovery kernel ownership. */
  readonly afterInitialInspection?: () => void | Promise<void>;
  /** Internal orchestration hook used by crash-recovery acceptance harnesses. */
  readonly afterReceiptObject?: () => void | Promise<void>;
  /** Internal orchestration hook used by crash-recovery acceptance harnesses. */
  readonly afterReceipt?: () => void | Promise<void>;
  /** Internal orchestration hook used by crash-recovery acceptance harnesses. */
  readonly afterTemporaryPreserved?: () => void | Promise<void>;
  /** Internal orchestration hook used by crash-recovery acceptance harnesses. */
  readonly afterTemporaryUnlinked?: () => void | Promise<void>;
  /** Internal orchestration hook used by crash-recovery acceptance harnesses. */
  readonly afterControlReleased?: () => void | Promise<void>;
  /** Internal orchestration hook used by crash-recovery acceptance harnesses. */
  readonly afterRecoveryComplete?: () => void | Promise<void>;
  /** Internal hard-crash hook after the one terminal intent becomes durable. */
  readonly afterTerminalIntent?: () => void | Promise<void>;
  /** Internal hard-crash hook after the intent-bound recovery proof publication. */
  readonly afterRecoveryControlProof?: () => void | Promise<void>;
  /** Internal hard-crash hook after the intent-bound immutable recovery journal. */
  readonly afterRecoveryFinalJournal?: () => void | Promise<void>;
  /** Internal hard-crash hook immediately before Receipt intent publication. */
  readonly beforeRecoveryReceiptIntent?: () => void | Promise<void>;
  /** Internal hook after deterministic recovery descriptor publication/reuse. */
  readonly afterRecoveryDescriptor?: () => void | Promise<void>;
  /** Internal hook after deterministic legacy inverse publication/reuse. */
  readonly afterRecoveryInverse?: () => void | Promise<void>;
  /** Internal hard-crash hook after exact store settlement but before terminal marker removal. */
  readonly afterStoreSettlement?: () => void | Promise<void>;
  /** Internal orchestration hook used by crash-recovery acceptance harnesses. */
  readonly afterProfileLockAcquired?: () => void | Promise<void>;
  /** Internal orchestration hook used by crash-recovery acceptance harnesses. */
  readonly afterProfileLockBound?: () => void | Promise<void>;
  /** Internal race hook after a prepared temporary's no-follow pre-stat. */
  readonly afterPreparedTemporaryStat?: (path: string) => void | Promise<void>;
  /** Internal stricter bound used by recovery acceptance harnesses. */
  readonly preparedTemporaryReadLimitBytes?: number;
  /** Internal stricter bound used by recovery acceptance harnesses. */
  readonly profileScanEntryLimit?: number;
  /** Internal race hook after interrupted atomic-replace classification. */
  readonly afterAtomicRecoveryClassification?: () => void | Promise<void>;
  /** Internal failure hook after an atomic recovery has been fully reconciled. */
  readonly afterAtomicRecoveryReconciliation?: () => void | Promise<void>;
  /** Internal tighter caps used to prove all terminal artifacts are preflighted before intent publication. */
  readonly terminalArtifactPreflightLimits?: {
    readonly controlProofMaxBytes?: number;
    readonly finalJournalMaxBytes?: number;
    readonly terminalIntentMaxBytes?: number;
  };
}

interface PreparedTemporaryReconciliation {
  readonly artifact: ArtifactReference;
  readonly completeness: "complete" | "incomplete" | "external_writer";
  readonly disposition: "removed" | "observed_absent";
}

export class ApplyRecoveryBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ApplyRecoveryBlockedError";
  }
}

export class ApplyRecoveryUncertainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ApplyRecoveryUncertainError";
  }
}

async function assertApplyRecoveryTerminalWriteReservation(
  layout: ApplyArtifactLayout,
  profileId: string,
  transactionId: string
): Promise<void> {
  const accounting = await readApplyStoreAccounting(layout, profileId);
  if (!accounting
    || accounting.schemaVersion !== "zts.apply-store-accounting.provisional-5") {
    throw new ApplyRecoveryBlockedError(
      "Apply recovery refused a current-format artifact write without its exact expanded v5 byte and entry reservation"
    );
  }
  const reservation = accounting.activeReservation;
  if (!reservation
    || reservation?.transactionId !== transactionId
    || reservation.bytes < APPLY_TRANSACTION_MAX_ARTIFACT_BYTES
    || reservation.entries < APPLY_TRANSACTION_RESERVATION_ENTRIES
    || !["standard", "legacy_recovery"].includes(reservation.kind ?? "standard")) {
    throw new ApplyRecoveryBlockedError(
      "Apply recovery refused a current-format artifact write without its exact expanded v5 byte and entry reservation"
    );
  }
}

export interface ApplyRecoveryResult {
  readonly recoveryRecorded: true;
  readonly sessionMutated: boolean;
  readonly recoveryMutation: {
    readonly kind: "none" | "restored_displaced_writer";
    readonly beforeFingerprint: JsonLz4Fingerprint | null;
    readonly afterFingerprint: JsonLz4Fingerprint | null;
  };
  readonly alreadyComplete: boolean;
  readonly inspection: ApplyRecoveryInspection;
  readonly receipt: Receipt;
  readonly receiptPath: string;
  readonly staleLockReleased: boolean;
  readonly recoveryLockReleased: boolean;
  readonly artifacts: readonly ({ readonly kind: string } & ArtifactReference)[];
}

export async function listApplyRecoveryInspections(context: ProfileContext): Promise<ApplyRecoveryInspection[]> {
  const journals = await readRecoveryJournals(context.profile.id);
  const inspections: ApplyRecoveryInspection[] = [];
  for (const item of journals) {
    const inspection = await inspectApplyRecoveryInternal(context, item.journal.transactionId, item);
    if (item.fromUnfinishedIndex || !inspection.terminalReceipt || inspection.lock.status === "stale") {
      inspections.push(inspection);
    }
  }
  return inspections;
}

export async function inspectApplyRecovery(
  context: ProfileContext,
  selector: string
): Promise<ApplyRecoveryInspection> {
  return inspectApplyRecoveryInternal(context, selector);
}

async function inspectApplyRecoveryInternal(
  context: ProfileContext,
  selector: string,
  known?: RecoveryJournalRecord,
  ignoreRecoveryClaim = false,
  ownedProfileLockRevision: Sha256Digest | null = null,
  nativeControl: NativeProfileControl | null = null
): Promise<ApplyRecoveryInspection> {
  const selected = known ?? await findRecoveryJournal(context.profile.id, selector);
  if (!selected) throw new Error(`Apply recovery transaction not found: ${selector}`);
  const { journal, journalPath } = selected;
  if (journal.profileId !== context.profile.id) throw new Error("Apply recovery journal belongs to a different Profile");
  await assertRecoveryInvocationConsent(context.profile.id, selected);
  const receiptId = `receipt:${journal.transactionId}`;
  const foundReceipt = await findTransactionReceipt(context.profile.id, receiptId);
  const observedLock = await inspectProfileTransactionLock(context.profile);
  const lock: ProfileLockInspection = observedLock.status === "active"
    && ownedProfileLockRevision !== null
    && observedLock.artifactRevision === ownedProfileLockRevision
    ? {
        status: "absent",
        lockPath: observedLock.lockPath,
        artifactRevision: null,
        pid: null,
        acquiredAt: null,
        transactionId: null,
        commandRevision: null
      }
    : observedLock;
  const recoveryClaim = await inspectRecoveryClaim(
    privatePath(dirname(journalPath), "recovery-claim.json"),
    journal.transactionId
  );
  let terminalIntent: ResolvedRecoveryTerminalIntent | null = null;
  if (!foundReceipt) {
    const layout = await readApplyArtifactLayout(context.profile.id);
    const stored = await loadStoredPlan(context.profile.id, journal.planDigest);
    const authorization = await loadRecoveryAuthorizationAndConsent(
      layout,
      journal,
      stored,
      selected.bootstrap,
      selected.bootstrapOnly
    );
    if (!authorization) throw new Error("Recovery terminal intent lacks its canonical Authorization");
    terminalIntent = await readRecoveryTerminalIntent(
      dirname(journalPath),
      journal,
      stored,
      authorization
    );
  }
  const staleLockMatches = lock.status !== "stale" || staleLockMatchesJournal(journal, lock);
  const blockers: string[] = [];
  if (selected.bootstrapOnly && lock.status !== "absent") {
    blockers.push("Marker-only recovery requires the original zts Profile lock to be absent");
  }
  if (lock.status === "active") blockers.push("The original or another zts Apply Transaction still owns the Profile lock");
  if (lock.status === "invalid") blockers.push(`Profile lock is invalid: ${lock.blocker}`);
  if (!staleLockMatches) {
    blockers.push("Stale Profile lock does not match this transaction journal");
  }
  // The JSON claim is diagnostic only. The persistent kernel recovery control
  // is the sole concurrency authority, so stale/corrupt records never create a
  // takeover race or permanently strand recovery.
  void ignoreRecoveryClaim;

  let currentFingerprint: JsonLz4Fingerprint | null = null;
  let atomicResidue: ApplyRecoveryInspection["atomicResidue"] = null;
  let classification: RecoveryClassification = "unclassified";
  if (lock.status === "active") {
    classification = "blocked_active_lock";
  } else if (lock.status === "invalid") {
    classification = "blocked_invalid_lock";
  } else if (!staleLockMatches) {
    classification = "blocked_lock_mismatch";
  } else if (terminalIntent) {
    if (lock.status !== "absent") {
      blockers.push("Recovery terminal intent conflicts with a remaining zts Profile lock");
      classification = "blocked_control_closure";
    } else {
      // The intent contains the exact released-control proof and Receipt
      // template. Replay never reacquires native/Profile control or recaptures
      // browser state, even if Zen reopened after the intent became durable.
      currentFingerprint = terminalIntent.content.controlProof.currentFingerprint;
      classification = terminalIntent.content.controlProof.classification;
    }
  } else if (!foundReceipt) {
    const prepared = journalEntry(journal, "recovery_receipt_prepared");
    if (prepared && "terminalIntentRevision" in prepared.evidence) {
      blockers.push("Intent-bound recovery journal is missing its fixed-path terminal intent");
      classification = "blocked_control_closure";
    } else {
      const refreshed = await refreshTargetContext(context);
      const targetMatches = sha256Canonical({ path: refreshed.sessionFile.path }) === journal.targetPathRevision;
      const commitStageSeen = journalCommitStageSeen(journal);
      if (!targetMatches) {
        blockers.push("Current authoritative session path does not match the recovery journal target");
        classification = "blocked_target_mismatch";
      }
      let control = nativeControl;
      let releaseControl = false;
      if (targetMatches && !control) {
        try {
          control = await acquireNativeProfileControl(refreshed, 0);
          releaseControl = true;
        } catch (error) {
          blockers.push(
            `Apply recovery requires Zen to be closed and native Profile control to be available: ${error instanceof Error ? error.message : String(error)}`
          );
          classification = refreshed.running ? "blocked_zen_running" : "blocked_native_control";
        }
      }
      if (targetMatches && control) {
        try {
          await control.assertHeld();
          assertPrimarySessionSource(refreshed);
          currentFingerprint = (await readJsonLz4State(refreshed.sessionFile.path)).fingerprint;
          atomicResidue = await inspectJournalBoundAtomicResidue(
            journal,
            refreshed.sessionFile.path,
            MAX_PROFILE_RECOVERY_SCAN_ENTRIES,
            DEFAULT_MAX_COMPRESSED_BYTES
          );
          await control.assertHeld();
          const beforeFingerprint = journalBeforeFingerprint(journal);
          const preparedDigest = journalPreparedDigest(journal);
          classification = beforeFingerprint && currentFingerprint.digest === beforeFingerprint.digest
            ? "before_state_present"
            : preparedDigest && currentFingerprint.digest === preparedDigest
              ? "planned_after_present"
              : beforeFingerprint || preparedDigest
                ? "external_drift"
                : "unclassified";
          if (classification === "external_drift" && !commitStageSeen) {
            const recoverableAtomicEvidence = await journalHasRecoverableAtomicEvidence(
              journal,
              refreshed.sessionFile.path
            );
            if (!recoverableAtomicEvidence) {
              blockers.push(
                "Session Drift after write preparation makes the commit boundary ambiguous; manual review is required"
              );
              classification = "blocked_ambiguous_drift";
            }
          }
        } finally {
          if (releaseControl) await control.release();
        }
      }
    }
  } else if (foundReceipt) {
    if (!terminalReceiptProvesSafeCleanup(foundReceipt.receipt)) {
      blockers.push(
        `Terminal Receipt ${foundReceipt.receipt.id} does not prove closed-session control release; retain its unfinished marker for explicit repair`
      );
      classification = "blocked_control_closure";
    } else if (lock.status !== "absent") {
      blockers.push(
        `Terminal Receipt ${foundReceipt.receipt.id} conflicts with a ${lock.status} zts Profile lock; retain its unfinished marker`
      );
      classification = "blocked_control_closure";
    } else {
      classification = "complete";
    }
  }

  const recoveryRevision = sha256Canonical({
    schemaVersion: RECOVERY_INSPECTION_SCHEMA,
    transactionId: journal.transactionId,
    journalRevision: sha256Canonical(journal),
    classification,
    currentFingerprint,
    atomicResidueRevision: atomicResidue ? sha256Canonical(atomicResidue) : null,
    lockStatus: lock.status,
    lockRevision: lock.artifactRevision,
    terminalReceiptRevision: foundReceipt ? sha256Canonical(foundReceipt.receipt) : null,
    terminalIntentRevision: terminalIntent?.intentBindingRevision ?? null
  });

  return {
    transactionId: journal.transactionId,
    receiptId,
    planId: journal.planId,
    planDigest: journal.planDigest,
    journalStage: recoveryDisplayStage(journal),
    journalPath,
    recoveryRevision,
    classification,
    currentFingerprint,
    beforeFingerprint: journalBeforeFingerprint(journal),
    preparedDigest: journalPreparedDigest(journal),
    atomicResidue,
    lock,
    recoveryClaim,
    terminalReceipt: foundReceipt?.receipt ?? null,
    blockers,
    recoverable: blockers.length === 0 && (terminalIntent
      ? lock.status === "absent"
      : !foundReceipt || lock.status === "stale" || lock.status === "absent")
  };
}

export async function recoverApplyTransaction(
  context: ProfileContext,
  selector: string,
  options: ApplyRecoveryOptions
): Promise<ApplyRecoveryResult> {
  assertDigest(options.expectedRecoveryRevision, "Expected Apply recovery revision");
  const selected = await findRecoveryJournal(context.profile.id, selector);
  if (!selected) throw new Error(`Apply recovery transaction not found: ${selector}`);
  const initial = await inspectApplyRecoveryInternal(context, selector, selected);
  if (initial.recoveryRevision !== options.expectedRecoveryRevision) {
    throw new ApplyRecoveryBlockedError(
      `Expected Apply recovery revision ${options.expectedRecoveryRevision} does not match current inspection ${initial.recoveryRevision}`
    );
  }
  await options.afterInitialInspection?.();
  const terminalCleanupOnly = Boolean(
    initial.terminalReceipt
    && initial.lock.status === "absent"
    && terminalReceiptProvesSafeCleanup(initial.terminalReceipt)
  );
  if (initial.terminalReceipt && !terminalCleanupOnly) {
    throw new ApplyRecoveryBlockedError(
      initial.lock.status !== "absent"
        ? `Terminal Receipt ${initial.terminalReceipt.id} conflicts with a ${initial.lock.status} zts Profile lock; its unfinished marker was retained`
        : `Terminal Receipt ${initial.terminalReceipt.id} does not prove closed-session control release; its unfinished marker was retained for explicit repair`
    );
  }
  if (!initial.recoverable && !terminalCleanupOnly) {
    throw new ApplyRecoveryBlockedError(initial.blockers.join("; ") || "Apply transaction is not recoverable");
  }

  if (terminalCleanupOnly) {
    const completedLayout = await readApplyArtifactLayout(context.profile.id);
    const markers = await readApplyUnfinishedMarkers(
      completedLayout,
      context.profile.id,
      loadUnfinishedRecoveryPlan
    );
    const transactionMarkerPresent = markers?.some((marker) =>
      marker.journal.transactionId === selected.journal.transactionId
    ) ?? true;
    if (markers !== null && !transactionMarkerPresent) {
      // A markerless repeat has no authority to grow or repair the store. The
      // canonical Receipt lookup revalidates ready-history reachability, the
      // full immutable payload closure, and the transaction pointer before we
      // return without acquiring control or touching the store.
      const found = await findTransactionReceipt(
        context.profile.id,
        initial.terminalReceipt!.id
      );
      if (!found
        || sha256Canonical(found.receipt) !== sha256Canonical(initial.terminalReceipt!)) {
        throw new Error("Markerless recovery Receipt changed after its bound inspection");
      }
      const terminalStored = await loadStoredPlan(
        context.profile.id,
        initial.terminalReceipt!.planDigest
      );
      await loadRecoveryAuthorizationAndConsent(
        completedLayout,
        selected.journal,
        terminalStored,
        selected.bootstrap,
        false
      );
      return {
        recoveryRecorded: true,
        sessionMutated: false,
        recoveryMutation: {
          kind: "none",
          beforeFingerprint: initial.currentFingerprint,
          afterFingerprint: initial.currentFingerprint
        },
        alreadyComplete: true,
        inspection: initial,
        receipt: found.receipt,
        receiptPath: found.receiptPath,
        staleLockReleased: false,
        recoveryLockReleased: false,
        artifacts: []
      };
    }
  }

  const bootstrapLayout = selected.bootstrapOnly
    ? await applyArtifactLayout(context.profile.id)
    : null;
  const transactionRoot = bootstrapLayout
    ? await ensurePrivateDirectory(
      bootstrapLayout.transactions,
      safeArtifactSegment(selected.journal.transactionId)
    )
    : dirname(selected.journalPath);
  const claimPath = privatePath(transactionRoot, "recovery-claim.json");
  const recoveryControlPath = privatePath(transactionRoot, "recovery-control.lock");
  const { claim, control: recoveryControl } = await acquireRecoveryControl(
    recoveryControlPath,
    claimPath,
    selected.journal.transactionId
  );
  let primaryError: unknown = null;
  let recoveryProfileLock: ProfileTransactionLock | null = null;
  let recoveryLockReleased = false;
  let nativeControl: NativeProfileControl | null = null;
  let nativeControlReleased = false;
  let nativeControlReleaseAttempted = false;
  let claimRemoved = false;
  let recoverySessionMutation: "not_started" | "possible" | "performed" = "not_started";
  const removeOwnedRecoveryClaim = async () => {
    if (claimRemoved) return;
    await assertRecoveryClaimOwned(claimPath, claim);
    await removePrivateFile(claimPath);
    claimRemoved = true;
  };

  try {
    if (bootstrapLayout) {
      await materializeRecoveryBootstrap(
        context.profile.id,
        selected,
        bootstrapLayout,
        recoveryControl
      );
    } else {
      await assertRecoveryJournalUnchanged(selected, recoveryControl);
    }
    const replayLayout = await applyArtifactLayout(context.profile.id);
    const replayStored = await loadStoredPlan(context.profile.id, selected.journal.planDigest);
    const replayAuthorization = await loadRecoveryAuthorizationAndConsent(
      replayLayout,
      selected.journal,
      replayStored,
      selected.bootstrap,
      false
    );
    if (!replayAuthorization) throw new Error("Apply recovery terminal replay lacks its Authorization");
    await withApplyReceiptHistoryMigration(replayLayout, context.profile.id, async (historyControl) => {
      await ensureApplyStoreRecoveryReservation(
        replayLayout,
        context.profile.id,
        selected.journal.transactionId,
        historyControl
      );
    });
    const persistedTerminalIntent = initial.terminalReceipt
      ? null
      : await readRecoveryTerminalIntent(
          transactionRoot,
          selected.journal,
          replayStored,
          replayAuthorization
        );
    if (persistedTerminalIntent) {
      if (initial.lock.status !== "absent") {
        throw new ApplyRecoveryBlockedError(
          `Recovery terminal intent requires no remaining zts Profile lock; observed ${initial.lock.status}`
        );
      }
      await assertApplyRecoveryTerminalWriteReservation(
        replayLayout,
        context.profile.id,
        selected.journal.transactionId
      );
      await ensureApplyReceiptSummaryHistory(replayLayout, context.profile.id);
      const { receiptArtifact, receiptPath } = await publishRecoveryTerminalArtifacts(
        replayLayout,
        transactionRoot,
        selected.journal,
        persistedTerminalIntent,
        replayStored,
        replayAuthorization,
        options
      );
      await options.afterReceipt?.();
      const proof = persistedTerminalIntent.content.controlProof;
      appendApplyJournal(selected.journal, "recovery_complete", {
        receiptArtifact,
        staleLockReleased: proof.ztsProfileControl.staleLockReleased,
        recoveryLockReleased: proof.ztsProfileControl.recoveryLockReleased
      });
      await replacePrivateJson(selected.journalPath, selected.journal);
      await options.afterRecoveryComplete?.();
      await removeOwnedRecoveryClaim();
      await finalizeRecoveredMarker(
        replayLayout,
        context.profile.id,
        selected.journal.transactionId,
        options.afterStoreSettlement
      );
      const atomic = proof.atomicCommitReconciliation;
      const restored = atomic?.classification === "drift_restored";
      return {
        recoveryRecorded: true,
        sessionMutated: atomic?.mutationPerformed === true,
        recoveryMutation: {
          kind: restored ? "restored_displaced_writer" : "none",
          beforeFingerprint: initial.currentFingerprint,
          afterFingerprint: proof.currentFingerprint
        },
        alreadyComplete: false,
        inspection: initial,
        receipt: persistedTerminalIntent.receipt,
        receiptPath,
        staleLockReleased: proof.ztsProfileControl.staleLockReleased,
        recoveryLockReleased: proof.ztsProfileControl.recoveryLockReleased,
        artifacts: [
          { kind: "recovery", ...persistedTerminalIntent.content.recoveryArtifact },
          ...(persistedTerminalIntent.content.inversePlanArtifact
            ? [{ kind: "inverse_plan", ...persistedTerminalIntent.content.inversePlanArtifact }]
            : []),
          { kind: "control_proof", ...persistedTerminalIntent.content.controlArtifact },
          {
            kind: "journal",
            ...artifactReference(
              `journal:recovery:${selected.journal.transactionId}`,
              persistedTerminalIntent.finalJournalDigest
            )
          },
          { kind: "receipt", ...receiptArtifact }
        ]
      };
    }
    if (initial.lock.status === "absent" && !terminalCleanupOnly) {
      try {
        recoveryProfileLock = await acquireProfileTransactionLock(
          context.profile,
          `zts apply recover ${selected.journal.transactionId}`,
          new Date(),
          selected.journal.transactionId
        );
      } catch (error) {
        throw new ApplyRecoveryBlockedError(error instanceof Error ? error.message : String(error));
      }
      await options.afterProfileLockAcquired?.();
    }
    let refreshed = terminalCleanupOnly ? context : await refreshTargetContext(context);
    if (!terminalCleanupOnly) {
      try {
        nativeControl = await acquireNativeProfileControl(refreshed, 0);
      } catch (error) {
        throw new ApplyRecoveryBlockedError(
          `Apply recovery requires Zen to be closed and native Profile control to be available: ${error instanceof Error ? error.message : String(error)}`
        );
      }
      await nativeControl.assertHeld();
      assertPrimarySessionSource(refreshed);
    }
    const inspection = await inspectApplyRecoveryInternal(
      refreshed,
      selector,
      selected,
      true,
      recoveryProfileLock?.artifactRevision ?? null,
      nativeControl
    );
    if (inspection.recoveryRevision !== options.expectedRecoveryRevision) {
      throw new ApplyRecoveryBlockedError(
        `Apply recovery inspection changed before finalization: expected ${options.expectedRecoveryRevision}, observed ${inspection.recoveryRevision}`
      );
    }
    if (!inspection.recoverable && !terminalCleanupOnly) {
      throw new ApplyRecoveryBlockedError(
        inspection.blockers.join("; ") || "Apply transaction is no longer recoverable"
      );
    }
    if (!terminalCleanupOnly) {
      const boundLockRevision = recoveryProfileLock?.artifactRevision ?? inspection.lock.artifactRevision;
      if (!boundLockRevision) throw new Error("Apply recovery has no exact zts Profile control revision to bind");
      bindApplyRecoveryControl(selected.journal, {
        lockRevision: boundLockRevision,
        nativeControlLeaseRevision: sha256Canonical(nativeControl!.proof)
      });
      await replacePrivateJson(selected.journalPath, selected.journal);
      await options.afterProfileLockBound?.();
    }

    if (inspection.terminalReceipt) {
      await assertRecoveryClaimOwned(claimPath, claim);
      const completedLayout = await applyArtifactLayout(refreshed.profile.id);
      await ensureApplyReceiptSummaryHistory(completedLayout, refreshed.profile.id);
      const terminalStored = await loadStoredPlan(
        refreshed.profile.id,
        inspection.terminalReceipt.planDigest
      );
      await loadRecoveryAuthorizationAndConsent(
        completedLayout,
        selected.journal,
        terminalStored,
        selected.bootstrap,
        false
      );
      const terminalPlan = terminalStored.plan;
      const published = await publishApplyReceipt(
        completedLayout,
        transactionRoot,
        inspection.terminalReceipt,
        {
          inversePlanReplayability: await inversePlanReplayability(
            completedLayout,
            inspection.terminalReceipt.inversePlanArtifact
          ),
          causalSourceReceiptId: terminalPlan.source.kind === "inverse"
            ? terminalPlan.source.sourceReceiptId
            : null,
          causalSourceReceiptDigest: terminalPlan.source.kind === "inverse"
            ? terminalPlan.source.sourceReceiptDigest
            : null
        }
      );
      if (nativeControl && !nativeControlReleased) {
        await nativeControl.assertHeld();
        await nativeControl.release();
        nativeControlReleased = true;
      }
      const staleReleased = recoveryProfileLock
        ? false
        : await releaseMatchingStaleLock(refreshed, selected.journal, inspection.lock);
      if (recoveryProfileLock) {
        await recoveryProfileLock.release();
        recoveryLockReleased = true;
      }
      await options.afterControlReleased?.();
      if (selected.journal.stage !== "recovery_complete"
        && ["failure_recorded", "recovery_control_acquired", "recovery_receipt_prepared"].includes(selected.journal.stage)) {
        appendApplyJournal(selected.journal, "recovery_complete", {
          receiptArtifact: published.artifact,
          staleLockReleased: staleReleased,
          recoveryLockReleased
        });
        await replacePrivateJson(selected.journalPath, selected.journal);
      }
      if (selected.journal.stage === "recovery_complete") await options.afterRecoveryComplete?.();
      // Kernel recovery control remains held. Remove the diagnostic claim
      // before exact store settlement so neither bytes nor its one entry leak
      // into the durable baseline after this transaction is complete.
      await removeOwnedRecoveryClaim();
      await finalizeRecoveredMarker(
        completedLayout,
        refreshed.profile.id,
        selected.journal.transactionId,
        options.afterStoreSettlement
      );
      return {
        recoveryRecorded: true,
        sessionMutated: false,
        recoveryMutation: {
          kind: "none",
          beforeFingerprint: inspection.currentFingerprint,
          afterFingerprint: inspection.currentFingerprint
        },
        alreadyComplete: true,
        inspection,
        receipt: inspection.terminalReceipt,
        receiptPath: published.receiptPath,
        staleLockReleased: staleReleased,
        recoveryLockReleased,
        artifacts: []
      };
    }

    const layout = await applyArtifactLayout(refreshed.profile.id);
    await ensureApplyReceiptSummaryHistory(layout, refreshed.profile.id);
    const stored = await loadStoredPlan(refreshed.profile.id, selected.journal.planDigest);
    const plan = stored.plan;
    const authorization = await loadRecoveryAuthorizationAndConsent(
      layout,
      selected.journal,
      stored,
      selected.bootstrap,
      false
    );
    if (!authorization) throw new Error("Apply recovery Authorization and invocation consent are missing");
    const moveActions = executableActions(plan);
    validateJournalBindings(selected.journal, stored.snapshot, plan, authorization, moveActions);
    if (inspection.atomicResidue) recoverySessionMutation = "possible";
    let atomicBoundary = await reconcileInterruptedCommitBoundary(
      selected.journal,
      refreshed.sessionFile.path,
      options,
      inspection.atomicResidue
    );
    recoverySessionMutation = atomicBoundary?.mutationPerformed ? "performed" : "not_started";
    await options.afterAtomicRecoveryReconciliation?.();
    let expectedCurrentFingerprint = atomicBoundary?.target.fingerprint ?? inspection.currentFingerprint;
    if (!expectedCurrentFingerprint) {
      throw new ApplyRecoveryBlockedError("Apply recovery lacks current session evidence after atomic reconciliation");
    }
    expectedCurrentFingerprint = await completeInterruptedTargetDurability(
      selected.journal,
      refreshed.sessionFile.path,
      expectedCurrentFingerprint
    );
    if (atomicBoundary) {
      atomicBoundary = {
        ...atomicBoundary,
        target: { ...atomicBoundary.target, fingerprint: expectedCurrentFingerprint }
      };
    }
    const config = await loadConfig();
    const captured = await captureControlledSessionSnapshot(
      refreshed,
      nativeControl!,
      config.config
    );
    refreshed = captured.context;
    const state = captured.state;
    if (!sameJsonLz4Fingerprint(expectedCurrentFingerprint, state.fingerprint)) {
      throw new ApplyRecoveryBlockedError("Apply recovery session evidence changed after the digest-bound inspection");
    }
    const observedSnapshot = captured.snapshot;
    const preparedDigest = journalPreparedDigest(selected.journal);
    const commitStageSeen = journalCommitStageSeen(selected.journal);
    if (atomicBoundary?.classification === "not_committed" && commitStageSeen) {
      throw new ApplyRecoveryBlockedError(
        "Apply recovery found a not-committed atomic boundary after the journal already claimed commit"
      );
    }
    const effectiveClassification: RecoveryClassification = atomicBoundary
      ? atomicBoundary.classification === "accepted_commit"
        ? "planned_after_present"
        : atomicBoundary.reason === "expected_source_present"
          ? "before_state_present"
          : "external_drift"
      : inspection.classification;
    const currentIsPrepared = preparedDigest !== null && state.fingerprint.digest === preparedDigest;
    const mutationAttempted = atomicBoundary
      ? atomicBoundary.classification === "accepted_commit"
        || atomicBoundary.classification === "commit_overwritten"
      : currentIsPrepared || commitStageSeen;
    const notAttemptedOperationIssueCode = atomicBoundary?.classification === "drift_restored"
      ? "hard_crash_commit_race_restored"
      : atomicBoundary?.classification === "not_committed"
        && atomicBoundary.reason === "external_drift_before_commit"
        ? "hard_crash_external_drift_before_commit"
        : "hard_crash_before_mutation";
    const operations = recoveredOperations(
      observedSnapshot,
      moveActions,
      mutationAttempted,
      effectiveClassification,
      notAttemptedOperationIssueCode
    );
    const netChanged = operationNetChanged(operations);
    const expectedAfterSnapshot = deriveExactPlannedAfterSnapshot(stored.snapshot, moveActions);
    const currentMatchesExactPlannedAfter = observedSnapshot.revision === expectedAfterSnapshot.revision;
    const allVerified = effectiveClassification === "planned_after_present"
      && currentMatchesExactPlannedAfter
      && operations.every((operation) => operation.status === "verified");

    const verifiedJournalEntry = journalEntry(selected.journal, "verified");
    if (verifiedJournalEntry
      && verifiedJournalEntry.evidence.afterSnapshotRevision !== expectedAfterSnapshot.revision) {
      throw new Error("Apply recovery journal verification does not match the exact planned after-Snapshot");
    }

    let backupArtifact = journalArtifactReference(selected.journal, "backupArtifact");
    let recoveryArtifact = journalArtifactReference(selected.journal, "recoveryArtifact");
    if (mutationAttempted && !backupArtifact) {
      throw new Error("Crashed Apply Transaction lacks the backup required after mutation");
    }
    if (backupArtifact) {
      await loadAndValidateBackupManifest(layout, backupArtifact, selected.journal);
    }
    if (!recoveryArtifact) {
      await assertApplyRecoveryTerminalWriteReservation(
        layout,
        plan.profileId,
        selected.journal.transactionId
      );
      const descriptor = {
        schemaVersion: RECOVERY_SCHEMA,
        transactionId: selected.journal.transactionId,
        profileId: plan.profileId,
        planId: plan.id,
        planDigest: plan.digest,
        targetPathRevision: selected.journal.targetPathRevision,
        beforeSourceFingerprint: journalBeforeFingerprint(selected.journal) ?? state.fingerprint,
        backupArtifact,
        status: "created_during_hard_crash_recovery",
        createdAt: stableRecoveryTimestamp(selected.journal)
      };
      recoveryArtifact = artifactReference(`recovery:${selected.journal.transactionId}`, sha256Canonical(descriptor));
      await publishPrivateJson(artifactObjectPath(layout.recoveries, recoveryArtifact.digest), descriptor);
      await loadAndValidateRecoveryDescriptor(
        layout,
        recoveryArtifact,
        selected.journal,
        plan,
        backupArtifact
      );
      await options.afterRecoveryDescriptor?.();
    } else {
      await loadAndValidateRecoveryDescriptor(
        layout,
        recoveryArtifact,
        selected.journal,
        plan,
        backupArtifact
      );
    }

    const preparedTemporary = await reconcilePreparedTemporary(
      layout,
      selected.journalPath,
      selected.journal,
      refreshed.sessionFile.path,
      options,
      atomicBoundary
    );

    let inversePlanArtifact = journalArtifactReference(selected.journal, "inversePlanArtifact");
    if (inversePlanArtifact) {
      const storedInverse = await loadInversePlan(layout, inversePlanArtifact);
      assertExactRecoveredInversePlan(
        storedInverse,
        expectedAfterSnapshot,
        plan,
        moveActions,
        inspection.receiptId
      );
      await options.afterRecoveryInverse?.();
      if (allVerified) definePlanForSnapshot(observedSnapshot, storedInverse.plan);
    } else if (allVerified) {
      await assertApplyRecoveryTerminalWriteReservation(
        layout,
        plan.profileId,
        selected.journal.transactionId
      );
      const inverse = createInversePlan(
        expectedAfterSnapshot,
        plan,
        moveActions,
        inspection.receiptId,
        new Date(stableRecoveryTimestamp(selected.journal))
      );
      inversePlanArtifact = await publishInversePlan(layout, expectedAfterSnapshot, inverse);
      const storedInverse = await loadInversePlan(layout, inversePlanArtifact);
      assertExactRecoveredInversePlan(
        storedInverse,
        expectedAfterSnapshot,
        plan,
        moveActions,
        inspection.receiptId
      );
      await options.afterRecoveryInverse?.();
    }

    const issueCode = atomicBoundary?.classification === "drift_restored"
      ? "hard_crash_commit_race_restored"
      : atomicBoundary?.classification === "commit_overwritten"
        ? "hard_crash_commit_overwritten"
      : atomicBoundary?.classification === "not_committed"
        && atomicBoundary.reason === "external_drift_before_commit"
      ? "hard_crash_external_drift_before_commit"
      : effectiveClassification === "external_drift"
      ? "hard_crash_external_drift"
      : !mutationAttempted
      ? "hard_crash_before_mutation"
      : allVerified
        ? "hard_crash_after_state_verified"
        : "hard_crash_state_uncertain";
    const issueMessage = atomicBoundary?.classification === "drift_restored"
      ? "Recovered the exact external writer displaced by an interrupted atomic swap; the planned Operations were not accepted"
      : atomicBoundary?.classification === "commit_overwritten"
        ? "An external writer replaced an indeterminate atomic commit; no planned Operation result was trusted and the displaced writer image was preserved"
      : atomicBoundary?.classification === "not_committed"
        && atomicBoundary.reason === "external_drift_before_commit"
      ? "Recovered an external writer that arrived before the atomic commit; the planned Operations were not attempted"
      : effectiveClassification === "external_drift"
      ? "Recovered an interrupted Apply Transaction after external session Drift; no Operation result was trusted"
      : !mutationAttempted
      ? "Recovered an abandoned Apply Transaction before any session mutation"
      : allVerified
        ? "Recovered an interrupted Apply Transaction whose complete planned after-state is present"
        : "Recovered an interrupted Apply Transaction with external Drift or uncertain post-state";
    // Terminal evidence is published only after both exclusive controls are
    // actually released. A crash anywhere before publication leaves the
    // unfinished marker authoritative and a retry can reacquire fresh control.
    await assertRecoveryEvidenceStable(refreshed, selected.journal, state.fingerprint, nativeControl!);
    await assertRecoveryClaimOwned(claimPath, claim);
    nativeControlReleaseAttempted = true;
    await nativeControl!.release();
    nativeControlReleased = true;
    const staleLockReleased = recoveryProfileLock
      ? false
      : await releaseMatchingStaleLock(refreshed, selected.journal, inspection.lock);
    let profileControlReleasedAt: string;
    if (recoveryProfileLock) {
      const released = await recoveryProfileLock.release();
      recoveryLockReleased = true;
      profileControlReleasedAt = released.releasedAt;
    } else {
      profileControlReleasedAt = new Date().toISOString();
    }
    await options.afterControlReleased?.();
    await assertRecoveryClaimOwned(claimPath, claim);

    const preparedAt = new Date(Math.max(
      Date.now(),
      Date.parse(selected.journal.history.at(-1)!.at)
    )).toISOString();
    const controlProof: RecoveryControlProofArtifact = {
      schemaVersion: RECOVERY_CONTROL_SCHEMA,
      transactionId: selected.journal.transactionId,
      profileId: plan.profileId,
      route: "closed_session" as const,
      recoveredAt: preparedAt,
      journalStageBeforeClosure: selected.journal.stage,
      lockStatusAtInspection: inspection.lock.status,
      currentFingerprint: state.fingerprint,
      beforeFingerprint: journalBeforeFingerprint(selected.journal),
      preparedDigest,
      classification: effectiveClassification,
      mutationAttempted,
      allOperationsVerified: allVerified,
      atomicCommitReconciliation: atomicBoundary ? {
        classification: atomicBoundary.classification,
        reason: atomicBoundary.reason,
        mutationPerformed: atomicBoundary.mutationPerformed,
        targetFingerprint: atomicBoundary.target.fingerprint,
        preparedFingerprint: atomicBoundary.prepared.fingerprint,
        residuePaths: atomicBoundary.residuePaths
      } : null,
      exclusiveControlReleased: "verified" as const,
      nativeProfileControl: {
        proof: nativeControl!.proof,
        released: true
      },
      ztsProfileControl: {
        staleLockReleased,
        recoveryLockReleased,
        releasedAt: profileControlReleasedAt
      },
      preparedTemporaryArtifact: preparedTemporary?.artifact ?? null,
      preparedTemporaryCompleteness: preparedTemporary?.completeness ?? null,
      preparedTemporaryDisposition: preparedTemporary?.disposition ?? null
    };
    const controlArtifact = artifactReference(
      `control:recovery:${selected.journal.transactionId}`,
      sha256Canonical(controlProof)
    );
    const placeholderJournalArtifact = artifactReference(
      `journal:recovery:${selected.journal.transactionId}`,
      `sha256:${"0".repeat(64)}` as Sha256Digest
    );

    const receiptBase = {
      schemaVersion: "zts.receipt.provisional-1" as const,
      id: inspection.receiptId,
      planId: plan.id,
      planDigest: plan.digest,
      authorization: {
        id: authorization.id,
        revision: authorization.revision,
        artifact: { id: authorization.id, digest: authorization.revision }
      },
      profileId: plan.profileId,
      beforeSnapshotRevision: plan.snapshotRevision,
      startedAt: authorization.authorizedAt,
      completedAt: preparedAt,
      journalArtifact: placeholderJournalArtifact,
      issues: [{
        code: issueCode,
        severity: (allVerified ? "warning" : "error") as "warning" | "error",
        message: ztsMessage(issueMessage),
        actionId: null
      }],
      control: {
        route: "closed_session" as const,
        proof: controlArtifact,
        exclusiveControlReleased: "verified" as const
      }
    };
    let receipt: Receipt;
    if (allVerified && mutationAttempted && netChanged === true) {
      if (!backupArtifact || !inversePlanArtifact) {
        throw new Error("Recovered applied Receipt requires backup and inverse Plan artifacts");
      }
      receipt = defineReceipt(stored.snapshot, plan, authorization, {
        ...receiptBase,
        outcome: "applied",
        mutationAttempted: true,
        netChanged: true,
        afterSnapshotRevision: observedSnapshot.revision,
        backupArtifact,
        inversePlanArtifact,
        recoveryArtifact: null,
        operations: operations as unknown as Extract<Receipt, { readonly outcome: "applied" }>["operations"]
      });
    } else {
      receipt = defineReceipt(stored.snapshot, plan, authorization, {
        ...receiptBase,
        outcome: "interrupted",
        mutationAttempted,
        netChanged,
        afterSnapshotRevision: null,
        backupArtifact,
        // A prepublished inverse is only an audit/recovery artifact until the
        // exact planned after-Snapshot is verified. Interrupted Receipts never
        // advertise it as Receipt-bound Undo state.
        inversePlanArtifact: null,
        recoveryArtifact,
        operations: operations as unknown as Extract<Receipt, { readonly outcome: "interrupted" }>["operations"]
      });
    }
    await assertRecoveryClaimOwned(claimPath, claim);
    await assertApplyRecoveryTerminalWriteReservation(
      layout,
      plan.profileId,
      selected.journal.transactionId
    );
    const terminalIntent = buildRecoveryTerminalIntent(
      selected.journal,
      controlProof,
      controlArtifact,
      issueCode,
      recoveryArtifact,
      inversePlanArtifact,
      receipt,
      stored,
      authorization,
      preparedAt
    );
    await publishRecoveryTerminalIntent(
      transactionRoot,
      terminalIntent,
      selected.journal,
      stored,
      authorization,
      options.terminalArtifactPreflightLimits
    );
    await options.afterTerminalIntent?.();
    const { receiptArtifact, receiptPath } = await publishRecoveryTerminalArtifacts(
      layout,
      transactionRoot,
      selected.journal,
      terminalIntent,
      stored,
      authorization,
      options
    );
    await options.afterReceipt?.();
    receipt = terminalIntent.receipt;
    appendApplyJournal(selected.journal, "recovery_complete", {
      receiptArtifact,
      staleLockReleased,
      recoveryLockReleased
    });
    await replacePrivateJson(selected.journalPath, selected.journal);
    await options.afterRecoveryComplete?.();
    await removeOwnedRecoveryClaim();
    await finalizeRecoveredMarker(
      layout,
      refreshed.profile.id,
      selected.journal.transactionId,
      options.afterStoreSettlement
    );
    return {
      recoveryRecorded: true,
      sessionMutated: atomicBoundary?.mutationPerformed === true,
      recoveryMutation: {
        kind: atomicBoundary?.classification === "drift_restored"
          ? "restored_displaced_writer"
          : "none",
        beforeFingerprint: inspection.currentFingerprint,
        afterFingerprint: state.fingerprint
      },
      alreadyComplete: false,
      inspection,
      receipt,
      receiptPath,
      staleLockReleased,
      recoveryLockReleased,
      artifacts: [
        ...(backupArtifact ? [{ kind: "backup", ...backupArtifact }] : []),
        { kind: "recovery", ...recoveryArtifact },
        ...(inversePlanArtifact ? [{ kind: "inverse_plan", ...inversePlanArtifact }] : []),
        ...(preparedTemporary ? [{
          kind: preparedTemporary.completeness === "complete"
            ? "prepared_image"
            : preparedTemporary.completeness === "external_writer"
              ? "displaced_writer"
              : "prepared_fragment",
          ...preparedTemporary.artifact
        }] : []),
        { kind: "control_proof", ...controlArtifact },
        {
          kind: "journal",
          ...artifactReference(
            `journal:recovery:${selected.journal.transactionId}`,
            terminalIntent.finalJournalDigest
          )
        },
        { kind: "receipt", ...receiptArtifact }
      ]
    };
  } catch (error) {
    const surfaced = recoverySessionMutation === "not_started"
      || error instanceof ApplyRecoveryUncertainError
      ? error
      : new ApplyRecoveryUncertainError(
          `Apply recovery may have changed the session before failing: ${error instanceof Error ? error.message : String(error)}`
        );
    primaryError = surfaced;
    throw surfaced;
  } finally {
    const cleanupErrors: unknown[] = [];
    if (nativeControl && !nativeControlReleased && !nativeControlReleaseAttempted) {
      try {
        await nativeControl.release();
        nativeControlReleased = true;
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
    }
    if (recoveryProfileLock && !recoveryLockReleased) {
      try {
        await recoveryProfileLock.release();
        recoveryLockReleased = true;
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
    }
    if (!claimRemoved) {
      try {
        await removeOwnedRecoveryClaim();
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
    }
    try {
      await recoveryControl.release();
    } catch (cleanupError) {
      cleanupErrors.push(cleanupError);
    }
    if (cleanupErrors.length > 0) {
      throw new ApplyRecoveryUncertainError(
        primaryError
          ? "Apply recovery failed and exclusive recovery control could not be fully released"
          : "Apply recovery completed but exclusive recovery control could not be fully released"
      );
    }
  }
}

async function acquireRecoveryControl(
  controlPath: string,
  claimPath: string,
  transactionId: string
): Promise<{ readonly claim: RecoveryClaimRecord; readonly control: ExclusiveFileControl }> {
  let control: ExclusiveFileControl;
  try {
    control = await acquireExclusiveFileControl(
      controlPath,
      `Apply recovery control for ${transactionId}`,
      { timeoutSeconds: 0 }
    );
  } catch (error) {
    throw new ApplyRecoveryBlockedError(
      `Another recovery attempt already owns kernel control for this Apply Transaction: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  const owner = await currentProcessOwner();
  const claim: RecoveryClaimRecord = {
    schemaVersion: RECOVERY_CLAIM_SCHEMA,
    transactionId,
    token: randomUUID(),
    ...owner,
    claimedAt: new Date().toISOString()
  };
  try {
    await control.assertHeld();
    await replacePrivateJson(claimPath, claim);
    await control.assertHeld();
    return { claim, control };
  } catch (error) {
    try {
      await control.release();
    } catch (releaseError) {
      void releaseError;
      throw new ApplyRecoveryUncertainError(
        `Recovery claim publication and kernel control release both failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
    throw error;
  }
}

async function inspectRecoveryClaim(path: string, transactionId: string): Promise<RecoveryClaimInspection> {
  let claim: RecoveryClaimRecord;
  try {
    claim = defineRecoveryClaim(await readPrivateJson(path), transactionId);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { status: "absent", path, artifactRevision: null };
    }
    return {
      status: "invalid",
      path,
      artifactRevision: null,
      blocker: error instanceof Error ? error.message : String(error)
    };
  }
  return {
    status: await processOwnerIsActive(claim) ? "active" : "stale",
    path,
    artifactRevision: sha256Canonical(claim),
    pid: claim.pid,
    claimedAt: claim.claimedAt
  };
}

async function assertRecoveryClaimOwned(path: string, expected: RecoveryClaimRecord): Promise<void> {
  const current = defineRecoveryClaim(await readPrivateJson(path), expected.transactionId);
  if (current.token !== expected.token || sha256Canonical(current) !== sha256Canonical(expected)) {
    throw new ApplyRecoveryBlockedError("Apply recovery claim ownership changed before terminal evidence publication");
  }
}

function defineRecoveryClaim(value: unknown, expectedTransactionId?: string): RecoveryClaimRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Apply recovery claim must be an object");
  }
  const keys = Object.keys(value).sort();
  const expectedKeys = [
    "schemaVersion",
    "transactionId",
    "token",
    "pid",
    "processStartIdentity",
    "host",
    "claimedAt"
  ].sort();
  if (keys.length !== expectedKeys.length || keys.some((key, index) => key !== expectedKeys[index])) {
    throw new Error("Apply recovery claim contains unknown or missing fields");
  }
  const claim = value as RecoveryClaimRecord;
  if (
    claim.schemaVersion !== RECOVERY_CLAIM_SCHEMA
    || !claim.transactionId.trim()
    || !claim.token.trim()
    || (expectedTransactionId !== undefined && claim.transactionId !== expectedTransactionId)
  ) {
    throw new Error("Apply recovery claim identity is invalid");
  }
  assertProcessOwner(claim, "Apply recovery claim");
  canonicalTimestamp(claim.claimedAt, "Apply recovery claim timestamp");
  return claim;
}

function recoveryDisplayStage(journal: RecoveryJournal): ApplyJournalStage {
  if (journal.stage !== "recovery_control_acquired") return journal.stage;
  const preserved = journalEntry(journal, "recovery_temporary_preserved");
  const closed = journalEntry(journal, "recovery_temporary_closed");
  return preserved && !closed ? "recovery_temporary_preserved" : journal.stage;
}

function stableRecoveryTimestamp(journal: RecoveryJournal): string {
  const firstRecoveryControl = journal.history.find((entry) => entry.stage === "recovery_control_acquired");
  return canonicalTimestamp(
    firstRecoveryControl?.at ?? journal.history[0]!.at,
    "Stable Apply recovery timestamp"
  );
}

async function loadUnfinishedRecoveryPlan(profileId: string, planDigest: string): Promise<Plan> {
  return (await loadStoredPlan(profileId, planDigest)).plan;
}

async function assertRecoveryInvocationConsent(
  profileId: string,
  selected: RecoveryJournalRecord
): Promise<void> {
  const layout = await readApplyArtifactLayout(profileId);
  const stored = await loadStoredPlan(profileId, selected.journal.planDigest);
  await loadRecoveryAuthorizationAndConsent(
    layout,
    selected.journal,
    stored,
    selected.bootstrap,
    selected.bootstrapOnly
  );
}

async function loadRecoveryAuthorizationAndConsent(
  layout: ApplyArtifactLayout,
  journal: RecoveryJournal,
  stored: StoredPlan,
  bootstrap: ApplyUnfinishedBootstrap | null,
  allowMissingCanonicalArtifacts: boolean
): Promise<ApplyAuthorization | null> {
  const binding = {
    transactionId: journal.transactionId,
    planId: stored.plan.id,
    planDigest: stored.plan.digest,
    planSource: stored.plan.source
  } as const;
  const bootstrapConsent = bootstrap
    ? defineInvocationConsent(bootstrap.consent, binding)
    : null;
  let bootstrapAuthorization: ApplyAuthorization | null = null;
  if (bootstrap && bootstrapConsent) {
    if (bootstrap.consentArtifact.id !== `consent:${journal.transactionId}`
      || sha256Canonical(bootstrapConsent) !== bootstrap.consentArtifact.digest
      || bootstrap.authorization.source.consentArtifact.id !== bootstrap.consentArtifact.id
      || bootstrap.authorization.source.consentArtifact.digest !== bootstrap.consentArtifact.digest) {
      throw new Error("Apply recovery marker bootstrap does not bind its exact invocation consent");
    }
    bootstrapAuthorization = defineApplyAuthorization(
      stored.snapshot,
      stored.plan,
      bootstrap.authorization
    );
    if (bootstrapAuthorization.id !== bootstrap.authorizationArtifact.id
      || bootstrapAuthorization.revision !== bootstrap.authorizationArtifact.digest
      || bootstrapAuthorization.revision !== journal.authorizationRevision
      || bootstrapAuthorization.planId !== journal.planId
      || bootstrapAuthorization.planDigest !== journal.planDigest
      || bootstrapAuthorization.profileId !== journal.profileId
      || bootstrapAuthorization.source.consentArtifact.id !== bootstrap.consentArtifact.id
      || bootstrapAuthorization.source.consentArtifact.digest !== bootstrap.consentArtifact.digest
      || bootstrapAuthorization.authorizedAt !== bootstrapConsent.confirmedAt) {
      throw new Error("Apply recovery marker bootstrap Authorization is invalid");
    }
    try {
      const existingConsentValue = await readPrivateJson(
        artifactObjectPath(layout.consents, bootstrap.consentArtifact.digest),
        INVOCATION_CONSENT_MAX_BYTES
      );
      const existingConsent = defineInvocationConsent(existingConsentValue, binding);
      if (sha256Canonical(existingConsent) !== bootstrap.consentArtifact.digest) {
        throw new Error("Stored invocation consent does not match its artifact digest");
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  let authorizationValue: unknown;
  try {
    authorizationValue = await readPrivateJson(
      artifactObjectPath(layout.authorizations, journal.authorizationRevision)
    );
  } catch (error) {
    if (allowMissingCanonicalArtifacts
      && (error as NodeJS.ErrnoException).code === "ENOENT"
      && bootstrapAuthorization) return bootstrapAuthorization;
    throw error;
  }
  const authorization = defineApplyAuthorization(
    stored.snapshot,
    stored.plan,
    authorizationValue as ApplyAuthorization
  );
  if (authorization.revision !== journal.authorizationRevision
    || authorization.planId !== journal.planId
    || authorization.planDigest !== journal.planDigest
    || authorization.profileId !== journal.profileId
    || authorization.source.consentArtifact.id !== `consent:${journal.transactionId}`) {
    throw new Error("Apply recovery Authorization does not match its journal and invocation consent identity");
  }
  if (bootstrapConsent && authorization.authorizedAt !== bootstrapConsent.confirmedAt) {
    throw new Error("Apply recovery marker Authorization timestamp does not match its invocation consent");
  }
  let consentValue: unknown;
  try {
    consentValue = await readPrivateJson(
      artifactObjectPath(layout.consents, authorization.source.consentArtifact.digest),
      INVOCATION_CONSENT_MAX_BYTES
    );
  } catch (error) {
    if (allowMissingCanonicalArtifacts
      && (error as NodeJS.ErrnoException).code === "ENOENT"
      && bootstrapAuthorization
      && bootstrapConsent
      && authorization.revision === bootstrapAuthorization.revision) {
      return bootstrapAuthorization;
    }
    throw error;
  }
  const consent = defineInvocationConsent(consentValue, binding);
  if (authorization.authorizedAt !== consent.confirmedAt) {
    throw new Error("Apply recovery Authorization timestamp does not match its invocation consent");
  }
  if (sha256Canonical(consent) !== authorization.source.consentArtifact.digest) {
    throw new Error("Stored invocation consent does not match its Authorization artifact digest");
  }
  if (bootstrap && (authorization.id !== bootstrap.authorizationArtifact.id
    || authorization.revision !== bootstrap.authorizationArtifact.digest
    || authorization.source.consentArtifact.id !== bootstrap.consentArtifact.id
    || authorization.source.consentArtifact.digest !== bootstrap.consentArtifact.digest
    || sha256Canonical(consent) !== sha256Canonical(bootstrapConsent))) {
    throw new Error("Stored recovery Authorization or invocation consent differs from its unfinished marker bootstrap");
  }
  return authorization;
}

async function readRecoveryJournals(
  profileId: string
): Promise<RecoveryJournalRecord[]> {
  let layout: ApplyArtifactLayout;
  try {
    layout = await readApplyArtifactLayout(profileId);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const markers = await readApplyUnfinishedMarkers(layout, profileId, loadUnfinishedRecoveryPlan);
  if (markers !== null) {
    const journals = [];
    for (const marker of markers) {
      let transactionRoot: string;
      let transactionRootAbsent = false;
      try {
        transactionRoot = await assertPrivateDirectory(
          layout.transactions,
          safeArtifactSegment(marker.journal.transactionId)
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        transactionRoot = privatePath(layout.transactions, safeArtifactSegment(marker.journal.transactionId));
        transactionRootAbsent = true;
      }
      const journalPath = privatePath(transactionRoot, "journal.json");
      let journal: RecoveryJournal;
      let bootstrapOnly = false;
      try {
        journal = defineApplyJournal(await readPrivateJson(journalPath));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        if (!transactionRootAbsent) {
          throw new Error(
            "Apply recovery transaction directory exists but its canonical journal is missing; explicit repair is required"
          );
        }
        journal = marker.journal;
        bootstrapOnly = true;
      }
      assertJournalMatchesUnfinishedMarker(marker, journal);
      journals.push({
        journal,
        journalPath,
        fromUnfinishedIndex: true,
        bootstrap: marker.bootstrap,
        bootstrapOnly
      });
    }
    return journals;
  }

  const transactions = layout.transactions;
  const entries = await readBoundedDirectory(
    transactions,
    MAX_LEGACY_RECOVERY_TRANSACTIONS,
    "Legacy Apply recovery transaction scan"
  );
  const journals = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const transactionRoot = await assertPrivateDirectory(transactions, entry.name);
    const journalPath = privatePath(transactionRoot, "journal.json");
    try {
      const journal = defineApplyJournal(await readPrivateJson(journalPath));
      if (safeArtifactSegment(journal.transactionId) !== entry.name) {
        throw new Error("Apply recovery journal identity does not match its transaction directory");
      }
      journals.push({
        journal,
        journalPath,
        fromUnfinishedIndex: false,
        bootstrap: null,
        bootstrapOnly: false
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return journals;
}

async function materializeRecoveryBootstrap(
  profileId: string,
  selected: RecoveryJournalRecord,
  layout: ApplyArtifactLayout,
  control: ExclusiveFileControl
): Promise<string> {
  const bootstrap = selected.bootstrap;
  if (!bootstrap) return dirname(selected.journalPath);
  await control.assertHeld();
  const markers = await readApplyUnfinishedMarkers(layout, profileId, loadUnfinishedRecoveryPlan);
  const marker = markers?.find((candidate) =>
    candidate.journal.transactionId === selected.journal.transactionId
  );
  if (!marker
    || sha256Canonical(marker.bootstrap) !== sha256Canonical(bootstrap)) {
    throw new ApplyRecoveryBlockedError(
      "Apply unfinished marker changed before recovery acquired kernel control; inspect recovery again"
    );
  }
  assertJournalMatchesUnfinishedMarker(marker, selected.journal);
  const stored = await loadStoredPlan(profileId, selected.journal.planDigest);
  const consent = defineInvocationConsent(bootstrap.consent, {
    transactionId: selected.journal.transactionId,
    planId: stored.plan.id,
    planDigest: stored.plan.digest,
    planSource: stored.plan.source
  });
  if (bootstrap.consentArtifact.id !== `consent:${selected.journal.transactionId}`
    || sha256Canonical(consent) !== bootstrap.consentArtifact.digest) {
    throw new Error("Apply marker bootstrap invocation consent artifact is invalid");
  }
  const authorization = defineApplyAuthorization(
    stored.snapshot,
    stored.plan,
    bootstrap.authorization
  );
  if (authorization.id !== bootstrap.authorizationArtifact.id
    || authorization.revision !== bootstrap.authorizationArtifact.digest
    || authorization.source.consentArtifact.id !== bootstrap.consentArtifact.id
    || authorization.source.consentArtifact.digest !== bootstrap.consentArtifact.digest) {
    throw new Error("Apply marker bootstrap does not match its domain Authorization and consent");
  }
  const transactionRoot = await ensurePrivateDirectory(
    layout.transactions,
    safeArtifactSegment(selected.journal.transactionId)
  );
  await publishPrivateJson(
    artifactObjectPath(layout.consents, bootstrap.consentArtifact.digest),
    consent
  );
  await publishPrivateJson(
    artifactObjectPath(layout.authorizations, bootstrap.authorizationArtifact.digest),
    bootstrap.authorization
  );
  const journalPath = privatePath(transactionRoot, "journal.json");
  let existing: RecoveryJournal | null = null;
  try {
    existing = defineApplyJournal(await readPrivateJson(journalPath));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (existing) {
    assertJournalMatchesUnfinishedMarker(marker, existing);
    if (sha256Canonical(existing) !== sha256Canonical(selected.journal)) {
      throw new ApplyRecoveryBlockedError(
        "Apply recovery journal changed before recovery acquired kernel control; inspect recovery again"
      );
    }
  } else {
    if (sha256Canonical(selected.journal) !== sha256Canonical(marker.journal)) {
      throw new ApplyRecoveryBlockedError(
        "Apply recovery journal disappeared after it progressed; explicit repair is required"
      );
    }
    const created = await createPrivateJsonExclusive(journalPath, selected.journal);
    if (!created) {
      throw new ApplyRecoveryBlockedError(
        "Apply recovery journal appeared during exclusive bootstrap; inspect recovery again"
      );
    }
  }
  await control.assertHeld();
  return transactionRoot;
}

async function assertRecoveryJournalUnchanged(
  selected: RecoveryJournalRecord,
  control: ExclusiveFileControl
): Promise<void> {
  await control.assertHeld();
  const current = defineApplyJournal(await readPrivateJson(selected.journalPath));
  if (sha256Canonical(current) !== sha256Canonical(selected.journal)) {
    throw new ApplyRecoveryBlockedError(
      "Apply recovery journal changed before recovery acquired kernel control; inspect recovery again"
    );
  }
  await control.assertHeld();
}

function recoveryTerminalIntentPath(transactionRoot: string): string {
  return privatePath(transactionRoot, RECOVERY_TERMINAL_INTENT_FILENAME);
}

function recoveryJournalPrefix(journal: ApplyJournal, length: number): ApplyJournal {
  if (!Number.isSafeInteger(length) || length < 1 || length > journal.history.length) {
    throw new Error("Recovery terminal intent journal prefix length is invalid");
  }
  const history = structuredClone(journal.history.slice(0, length));
  return defineApplyJournal({
    ...structuredClone(journal),
    stage: history.at(-1)!.stage,
    history
  });
}

function recoveryReceiptTemplate(receipt: Receipt): RecoveryReceiptTemplate {
  const { journalArtifact: _journalArtifact, ...template } = receipt;
  return structuredClone(template) as RecoveryReceiptTemplate;
}

function defineRecoveryControlProof(
  value: unknown,
  journal: ApplyJournal
): RecoveryControlProofArtifact {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Recovery terminal control proof must be an object");
  }
  assertObjectKeys(value as Record<string, unknown>, [
    "schemaVersion", "transactionId", "profileId", "route", "recoveredAt",
    "journalStageBeforeClosure", "lockStatusAtInspection", "currentFingerprint",
    "beforeFingerprint", "preparedDigest", "classification", "mutationAttempted",
    "allOperationsVerified", "atomicCommitReconciliation", "exclusiveControlReleased",
    "nativeProfileControl", "ztsProfileControl", "preparedTemporaryArtifact",
    "preparedTemporaryCompleteness", "preparedTemporaryDisposition"
  ], "Recovery terminal control proof");
  const proof = value as RecoveryControlProofArtifact;
  const expectedBeforeFingerprint = journalBeforeFingerprint(journal);
  const expectedPreparedDigest = journalPreparedDigest(journal);
  if (proof.schemaVersion !== RECOVERY_CONTROL_SCHEMA
    || proof.transactionId !== journal.transactionId
    || proof.profileId !== journal.profileId
    || proof.route !== "closed_session"
    || proof.journalStageBeforeClosure !== journal.stage
    || proof.exclusiveControlReleased !== "verified"
    || typeof proof.mutationAttempted !== "boolean"
    || typeof proof.allOperationsVerified !== "boolean"
    || !isFingerprint(proof.currentFingerprint)
    || (proof.beforeFingerprint !== null && !isFingerprint(proof.beforeFingerprint))
    || (proof.preparedDigest !== null && !isDigest(proof.preparedDigest))
    || (expectedBeforeFingerprint === null) !== (proof.beforeFingerprint === null)
    || (expectedBeforeFingerprint !== null
      && proof.beforeFingerprint !== null
      && !sameJsonLz4Fingerprint(expectedBeforeFingerprint, proof.beforeFingerprint))
    || proof.preparedDigest !== expectedPreparedDigest
    || !([
      "complete", "blocked_zen_running", "blocked_native_control", "blocked_active_lock",
      "blocked_invalid_lock", "blocked_lock_mismatch", "blocked_target_mismatch",
      "blocked_control_closure", "blocked_ambiguous_drift", "before_state_present",
      "planned_after_present", "external_drift", "unclassified"
    ] as readonly string[]).includes(proof.classification)
    || !(["absent", "active", "stale", "invalid"] as readonly string[]).includes(proof.lockStatusAtInspection)) {
    throw new Error("Recovery terminal control proof identity is invalid");
  }
  canonicalTimestamp(proof.recoveredAt, "Recovery terminal control proof timestamp");
  if (!proof.nativeProfileControl || typeof proof.nativeProfileControl !== "object"
    || Array.isArray(proof.nativeProfileControl)) {
    throw new Error("Recovery terminal native control proof is invalid");
  }
  assertObjectKeys(proof.nativeProfileControl as unknown as Record<string, unknown>, ["proof", "released"], "Recovery terminal native control");
  if (proof.nativeProfileControl.released !== true
    || !proof.nativeProfileControl.proof
    || typeof proof.nativeProfileControl.proof !== "object"
    || Array.isArray(proof.nativeProfileControl.proof)) {
    throw new Error("Recovery terminal native control was not proven released");
  }
  if (!proof.ztsProfileControl || typeof proof.ztsProfileControl !== "object"
    || Array.isArray(proof.ztsProfileControl)) {
    throw new Error("Recovery terminal zts control proof is invalid");
  }
  assertObjectKeys(proof.ztsProfileControl as unknown as Record<string, unknown>, [
    "staleLockReleased", "recoveryLockReleased", "releasedAt"
  ], "Recovery terminal zts control");
  if (typeof proof.ztsProfileControl.staleLockReleased !== "boolean"
    || typeof proof.ztsProfileControl.recoveryLockReleased !== "boolean") {
    throw new Error("Recovery terminal zts control release evidence is invalid");
  }
  canonicalTimestamp(proof.ztsProfileControl.releasedAt, "Recovery terminal zts control release timestamp");
  const hasPreparedArtifact = proof.preparedTemporaryArtifact !== null;
  if (hasPreparedArtifact !== (proof.preparedTemporaryCompleteness !== null)
    || hasPreparedArtifact !== (proof.preparedTemporaryDisposition !== null)
    || (proof.preparedTemporaryArtifact !== null && !isArtifactReference(proof.preparedTemporaryArtifact))
    || (proof.preparedTemporaryCompleteness !== null
      && !["complete", "incomplete", "external_writer"].includes(proof.preparedTemporaryCompleteness))
    || (proof.preparedTemporaryDisposition !== null
      && !["removed", "observed_absent"].includes(proof.preparedTemporaryDisposition))) {
    throw new Error("Recovery terminal prepared-temporary evidence is invalid");
  }
  if (proof.atomicCommitReconciliation !== null) {
    if (typeof proof.atomicCommitReconciliation !== "object" || Array.isArray(proof.atomicCommitReconciliation)) {
      throw new Error("Recovery terminal atomic reconciliation is invalid");
    }
    const atomic = proof.atomicCommitReconciliation as Record<string, unknown>;
    assertObjectKeys(atomic, [
      "classification", "reason", "mutationPerformed", "targetFingerprint",
      "preparedFingerprint", "residuePaths"
    ], "Recovery terminal atomic reconciliation");
    if (![
      "accepted_commit", "not_committed", "drift_restored", "commit_overwritten"
    ].includes(String(atomic.classification))
      || ![
        "expected_displaced_source", "expected_source_present", "external_drift_before_commit",
        "raced_source_restored", "external_writer_replaced_uncertain_commit"
      ].includes(String(atomic.reason))
      || typeof atomic.mutationPerformed !== "boolean"
      || !isFingerprint(atomic.targetFingerprint)
      || !isFingerprint(atomic.preparedFingerprint)
      || !Array.isArray(atomic.residuePaths)
      || atomic.residuePaths.length !== 1
      || typeof atomic.residuePaths[0] !== "string"
      || atomic.residuePaths[0].length === 0) {
      throw new Error("Recovery terminal atomic reconciliation evidence is invalid");
    }
  }
  return proof;
}

function buildRecoveryTerminalIntent(
  journalPrefix: ApplyJournal,
  controlProof: RecoveryControlProofArtifact,
  controlArtifact: ArtifactReference,
  issueCode: string,
  recoveryArtifact: ArtifactReference,
  inversePlanArtifact: ArtifactReference | null,
  receiptWithPlaceholderJournal: Receipt,
  stored: StoredPlan,
  authorization: ApplyAuthorization,
  preparedAt: string
): ResolvedRecoveryTerminalIntent {
  const content: RecoveryTerminalIntentContent = {
    schemaVersion: RECOVERY_TERMINAL_INTENT_SCHEMA,
    transactionId: journalPrefix.transactionId,
    profileId: journalPrefix.profileId,
    planId: journalPrefix.planId,
    planDigest: journalPrefix.planDigest,
    authorizationRevision: journalPrefix.authorizationRevision,
    journalPrefixLength: journalPrefix.history.length,
    journalPrefixRevision: sha256Canonical(journalPrefix),
    preparedAt: canonicalTimestamp(preparedAt, "Recovery terminal intent prepared timestamp"),
    controlProof: defineRecoveryControlProof(controlProof, journalPrefix),
    controlArtifact,
    issueCode,
    recoveryArtifact,
    inversePlanArtifact,
    receiptTemplate: recoveryReceiptTemplate(receiptWithPlaceholderJournal)
  };
  const intentBindingRevision = sha256Canonical(content);
  const finalJournal = structuredClone(journalPrefix);
  appendApplyJournal(finalJournal, "recovery_receipt_prepared", {
    issueCode,
    controlArtifact,
    recoveryArtifact,
    inversePlanArtifact,
    terminalIntentRevision: intentBindingRevision
  }, new Date(content.preparedAt));
  const finalJournalDigest = sha256Canonical(finalJournal);
  const journalArtifact = artifactReference(
    `journal:recovery:${journalPrefix.transactionId}`,
    finalJournalDigest
  );
  const receipt = defineReceipt(stored.snapshot, stored.plan, authorization, {
    ...structuredClone(content.receiptTemplate),
    journalArtifact
  } as Receipt);
  const intent: RecoveryTerminalIntent = {
    content,
    intentBindingRevision,
    finalJournalDigest,
    receiptDigest: sha256Canonical(receipt)
  };
  return defineRecoveryTerminalIntent(intent, journalPrefix, stored, authorization);
}

function defineRecoveryTerminalIntent(
  value: unknown,
  currentJournal: ApplyJournal,
  stored: StoredPlan,
  authorization: ApplyAuthorization
): ResolvedRecoveryTerminalIntent {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Recovery terminal intent must be an object");
  }
  assertObjectKeys(value as Record<string, unknown>, [
    "content", "intentBindingRevision", "finalJournalDigest", "receiptDigest"
  ], "Recovery terminal intent");
  const intent = value as RecoveryTerminalIntent;
  if (!intent.content || typeof intent.content !== "object" || Array.isArray(intent.content)) {
    throw new Error("Recovery terminal intent content must be an object");
  }
  assertObjectKeys(intent.content as unknown as Record<string, unknown>, [
    "schemaVersion", "transactionId", "profileId", "planId", "planDigest",
    "authorizationRevision", "journalPrefixLength", "journalPrefixRevision", "preparedAt",
    "controlProof", "controlArtifact", "issueCode", "recoveryArtifact",
    "inversePlanArtifact", "receiptTemplate"
  ], "Recovery terminal intent content");
  const content = intent.content;
  if (content.schemaVersion !== RECOVERY_TERMINAL_INTENT_SCHEMA
    || content.transactionId !== currentJournal.transactionId
    || content.profileId !== stored.plan.profileId
    || content.planId !== stored.plan.id
    || content.planDigest !== stored.plan.digest
    || content.authorizationRevision !== authorization.revision
    || !Number.isSafeInteger(content.journalPrefixLength)
    || content.journalPrefixLength < 1
    || !isDigest(content.journalPrefixRevision)
    || !isDigest(intent.intentBindingRevision)
    || !isDigest(intent.finalJournalDigest)
    || !isDigest(intent.receiptDigest)
    || !isArtifactReference(content.controlArtifact)
    || content.controlArtifact.id !== `control:recovery:${content.transactionId}`
    || !isArtifactReference(content.recoveryArtifact)
    || (content.inversePlanArtifact !== null && !isArtifactReference(content.inversePlanArtifact))) {
    throw new Error("Recovery terminal intent identity is invalid");
  }
  canonicalTimestamp(content.preparedAt, "Recovery terminal intent prepared timestamp");
  const prefix = recoveryJournalPrefix(currentJournal, content.journalPrefixLength);
  if (sha256Canonical(prefix) !== content.journalPrefixRevision) {
    throw new Error("Recovery terminal intent does not match the exact prior mutable journal prefix");
  }
  const proof = defineRecoveryControlProof(content.controlProof, prefix);
  if (proof.recoveredAt !== content.preparedAt) {
    throw new Error("Recovery terminal control proof timestamp does not match its intent");
  }
  if (sha256Canonical(proof) !== content.controlArtifact.digest) {
    throw new Error("Recovery terminal control proof does not match its artifact digest");
  }
  if (sha256Canonical(content) !== intent.intentBindingRevision) {
    throw new Error("Recovery terminal intent binding revision is invalid");
  }
  const finalJournal = structuredClone(prefix);
  appendApplyJournal(finalJournal, "recovery_receipt_prepared", {
    issueCode: content.issueCode,
    controlArtifact: content.controlArtifact,
    recoveryArtifact: content.recoveryArtifact,
    inversePlanArtifact: content.inversePlanArtifact,
    terminalIntentRevision: intent.intentBindingRevision
  }, new Date(content.preparedAt));
  const finalRevision = sha256Canonical(finalJournal);
  const currentRevision = sha256Canonical(currentJournal);
  if (currentRevision !== content.journalPrefixRevision && currentRevision !== finalRevision) {
    throw new Error("Recovery terminal intent accepts only its exact prior prefix or reconstructed prepared journal");
  }
  const prepared = finalJournal.history.at(-1)!;
  if (prepared.stage !== "recovery_receipt_prepared"
    || prepared.at !== content.preparedAt
    || prepared.evidence.issueCode !== content.issueCode
    || !sameArtifactReference(prepared.evidence.controlArtifact, content.controlArtifact)
    || !sameArtifactReference(prepared.evidence.recoveryArtifact, content.recoveryArtifact)
    || !sameArtifactReference(prepared.evidence.inversePlanArtifact, content.inversePlanArtifact)
    || !("terminalIntentRevision" in prepared.evidence)
    || prepared.evidence.terminalIntentRevision !== intent.intentBindingRevision) {
    throw new Error("Recovery terminal prepared journal evidence does not bind its exact intent");
  }
  if (finalRevision !== intent.finalJournalDigest) {
    throw new Error("Recovery terminal final journal digest is invalid");
  }
  const journalArtifact = artifactReference(
    `journal:recovery:${content.transactionId}`,
    intent.finalJournalDigest
  );
  if (!content.receiptTemplate || typeof content.receiptTemplate !== "object"
    || Array.isArray(content.receiptTemplate)
    || Object.hasOwn(content.receiptTemplate, "journalArtifact")) {
    throw new Error("Recovery terminal Receipt template is invalid");
  }
  const receipt = defineReceipt(stored.snapshot, stored.plan, authorization, {
    ...structuredClone(content.receiptTemplate),
    journalArtifact
  } as Receipt);
  const backupArtifact = journalArtifactReference(prefix, "backupArtifact");
  if (sha256Canonical(receipt) !== intent.receiptDigest
    || receipt.id !== `receipt:${content.transactionId}`
    || receipt.completedAt !== content.preparedAt
    || receipt.issues.length !== 1
    || receipt.issues[0]?.code !== content.issueCode
    || receipt.mutationAttempted !== proof.mutationAttempted
    || !sameArtifactReference(receipt.backupArtifact, backupArtifact)
    || !sameArtifactReference(receipt.control.proof, content.controlArtifact)
    || !sameArtifactReference(receipt.journalArtifact, journalArtifact)) {
    throw new Error("Recovery terminal Receipt does not reconstruct byte-identically from its template");
  }
  if (receipt.outcome === "applied") {
    if (!proof.allOperationsVerified
      || !sameArtifactReference(receipt.inversePlanArtifact, content.inversePlanArtifact)
      || receipt.recoveryArtifact !== null
      || receipt.operations.some((operation) => operation.status !== "verified")) {
      throw new Error("Applied recovery terminal Receipt does not match its intent evidence");
    }
  } else if (receipt.outcome === "interrupted") {
    if (proof.allOperationsVerified
      || receipt.inversePlanArtifact !== null
      || !sameArtifactReference(receipt.recoveryArtifact, content.recoveryArtifact)) {
      throw new Error("Interrupted recovery terminal Receipt does not match its intent evidence");
    }
  } else {
    throw new Error("Recovery terminal intent may reconstruct only applied or interrupted Receipts");
  }
  return {
    content: { ...content, controlProof: proof },
    intentBindingRevision: intent.intentBindingRevision,
    finalJournal,
    finalJournalDigest: intent.finalJournalDigest,
    receipt,
    receiptDigest: intent.receiptDigest
  };
}

async function readRecoveryTerminalIntent(
  transactionRoot: string,
  currentJournal: ApplyJournal,
  stored: StoredPlan,
  authorization: ApplyAuthorization
): Promise<ResolvedRecoveryTerminalIntent | null> {
  let value: unknown;
  try {
    value = await readPrivateJson(
      recoveryTerminalIntentPath(transactionRoot),
      APPLY_RECOVERY_TERMINAL_INTENT_MAX_BYTES
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  return defineRecoveryTerminalIntent(value, currentJournal, stored, authorization);
}

async function publishRecoveryTerminalIntent(
  transactionRoot: string,
  intent: ResolvedRecoveryTerminalIntent,
  currentJournal: ApplyJournal,
  stored: StoredPlan,
  authorization: ApplyAuthorization,
  limits?: ApplyRecoveryOptions["terminalArtifactPreflightLimits"]
): Promise<void> {
  const encoded = preflightRecoveryTerminalArtifacts(intent, limits);
  await publishPrivateBytes(
    recoveryTerminalIntentPath(transactionRoot),
    encoded,
    APPLY_RECOVERY_TERMINAL_INTENT_MAX_BYTES
  );
  const reread = await readRecoveryTerminalIntent(
    transactionRoot,
    currentJournal,
    stored,
    authorization
  );
  if (!reread || reread.intentBindingRevision !== intent.intentBindingRevision) {
    throw new Error("Recovery terminal intent publication did not preserve its exact binding");
  }
}

function preflightRecoveryTerminalArtifacts(
  intent: ResolvedRecoveryTerminalIntent,
  limits?: ApplyRecoveryOptions["terminalArtifactPreflightLimits"]
): Buffer {
  encodePrivateJsonBytes(
    intent.content.controlProof,
    stricterPositiveLimit(
      limits?.controlProofMaxBytes,
      APPLY_TRANSACTION_ARTIFACT_CAP_BYTES.recoveryControlProof,
      "Recovery terminal control proof preflight"
    ),
    "Recovery terminal control proof"
  );
  encodePrivateJsonBytes(
    intent.finalJournal,
    stricterPositiveLimit(
      limits?.finalJournalMaxBytes,
      APPLY_TRANSACTION_ARTIFACT_CAP_BYTES.recoveryImmutableJournal,
      "Recovery terminal journal preflight"
    ),
    "Recovery terminal immutable journal"
  );
  // The Receipt store constructs and encodes the exact nested publication
  // intent. This proves both artifacts fit before the terminal intent is made
  // durable instead of inferring the nested size from the Receipt alone.
  preflightApplyReceiptPublication(intent.receipt);
  return encodePrivateJsonBytes(
    persistedRecoveryTerminalIntent(intent),
    stricterPositiveLimit(
      limits?.terminalIntentMaxBytes,
      APPLY_RECOVERY_TERMINAL_INTENT_MAX_BYTES,
      "Recovery terminal intent preflight"
    ),
    "Recovery terminal intent"
  );
}

function persistedRecoveryTerminalIntent(
  intent: ResolvedRecoveryTerminalIntent
): RecoveryTerminalIntent {
  return {
    content: intent.content,
    intentBindingRevision: intent.intentBindingRevision,
    finalJournalDigest: intent.finalJournalDigest,
    receiptDigest: intent.receiptDigest
  };
}

async function publishRecoveryTerminalArtifacts(
  layout: ApplyArtifactLayout,
  transactionRoot: string,
  currentJournal: ApplyJournal,
  intent: ResolvedRecoveryTerminalIntent,
  stored: StoredPlan,
  authorization: ApplyAuthorization,
  options: ApplyRecoveryOptions
): Promise<{
  readonly receiptArtifact: ArtifactReference;
  readonly receiptPath: string;
}> {
  const validated = defineRecoveryTerminalIntent(
    persistedRecoveryTerminalIntent(intent),
    currentJournal,
    stored,
    authorization
  );
  await validateRecoveryTerminalDependencies(layout, currentJournal, validated, stored);
  preflightRecoveryTerminalArtifacts(validated, options.terminalArtifactPreflightLimits);
  await publishPrivateJson(
    artifactObjectPath(layout.controls, validated.content.controlArtifact.digest),
    validated.content.controlProof
  );
  await options.afterRecoveryControlProof?.();

  if (sha256Canonical(currentJournal) === validated.content.journalPrefixRevision) {
    currentJournal.stage = validated.finalJournal.stage;
    currentJournal.history = structuredClone(validated.finalJournal.history);
    await replacePrivateJson(privatePath(transactionRoot, "journal.json"), currentJournal);
  } else if (sha256Canonical(currentJournal) !== validated.finalJournalDigest) {
    throw new Error("Recovery terminal mutable journal changed before prepared publication");
  }
  await publishPrivateJson(
    artifactObjectPath(layout.journals, validated.finalJournalDigest),
    validated.finalJournal
  );
  await options.afterRecoveryFinalJournal?.();
  await options.beforeRecoveryReceiptIntent?.();
  const plan = stored.plan;
  const published = await publishApplyReceipt(
    layout,
    transactionRoot,
    validated.receipt,
    {
      afterReceiptObject: options.afterReceiptObject,
      inversePlanReplayability: await inversePlanReplayability(
        layout,
        validated.receipt.inversePlanArtifact
      ),
      causalSourceReceiptId: plan.source.kind === "inverse" ? plan.source.sourceReceiptId : null,
      causalSourceReceiptDigest: plan.source.kind === "inverse" ? plan.source.sourceReceiptDigest : null
    }
  );
  if (published.artifact.digest !== validated.receiptDigest) {
    throw new Error("Recovery terminal Receipt publication does not match its intent digest");
  }
  return { receiptArtifact: published.artifact, receiptPath: published.receiptPath };
}

async function validateRecoveryTerminalDependencies(
  layout: ApplyArtifactLayout,
  currentJournal: ApplyJournal,
  intent: ResolvedRecoveryTerminalIntent,
  stored: StoredPlan
): Promise<void> {
  const prefix = recoveryJournalPrefix(
    currentJournal,
    intent.content.journalPrefixLength
  );
  const backupArtifact = journalArtifactReference(prefix, "backupArtifact");
  if (backupArtifact) {
    await loadAndValidateBackupManifest(layout, backupArtifact, prefix);
  }
  await loadAndValidateRecoveryDescriptor(
    layout,
    intent.content.recoveryArtifact,
    prefix,
    stored.plan,
    backupArtifact
  );
  if (intent.content.inversePlanArtifact) {
    const actions = executableActions(stored.plan);
    const expectedAfterSnapshot = deriveExactPlannedAfterSnapshot(stored.snapshot, actions);
    const inverse = await loadInversePlan(layout, intent.content.inversePlanArtifact);
    assertExactRecoveredInversePlan(
      inverse,
      expectedAfterSnapshot,
      stored.plan,
      actions,
      intent.receipt.id
    );
  }
  const proof = intent.content.controlProof;
  if (proof.preparedTemporaryArtifact && proof.preparedTemporaryCompleteness) {
    await validatePreservedTemporary(
      layout,
      proof.preparedTemporaryArtifact,
      proof.preparedTemporaryCompleteness
    );
  }
}

async function finalizeRecoveredMarker(
  layout: ApplyArtifactLayout,
  profileId: string,
  transactionId: string,
  afterStoreSettlement?: () => void | Promise<void>
): Promise<void> {
  await withApplyReceiptHistoryMigration(layout, profileId, async () => {
    const markers = await readApplyUnfinishedMarkers(layout, profileId, loadUnfinishedRecoveryPlan);
    if (!markers?.some((marker) => marker.journal.transactionId === transactionId)) return;
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
}

async function findRecoveryJournal(
  profileId: string,
  selector: string
): Promise<RecoveryJournalRecord | null> {
  const exactTransactionId = selector.startsWith("receipt:apply:")
    ? selector.slice("receipt:".length)
    : selector.startsWith("apply:")
      ? selector
      : null;
  if (exactTransactionId) {
    let layout: ApplyArtifactLayout;
    try {
      layout = await readApplyArtifactLayout(profileId);
      const transactionRoot = await assertPrivateDirectory(
        layout.transactions,
        safeArtifactSegment(exactTransactionId)
      );
      const journalPath = privatePath(transactionRoot, "journal.json");
      const journal = defineApplyJournal(await readPrivateJson(journalPath));
      if (journal.transactionId !== exactTransactionId || journal.profileId !== profileId) {
        throw new Error("Apply recovery journal does not match its direct selector");
      }
      return {
        journal,
        journalPath,
        fromUnfinishedIndex: false,
        bootstrap: null,
        bootstrapOnly: false
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  const normalized = safeArtifactSegment(selector);
  const journals = await readRecoveryJournals(profileId);
  return journals.find((item) =>
    item.journal.transactionId === selector
    || safeArtifactSegment(item.journal.transactionId) === normalized
    || `receipt:${item.journal.transactionId}` === selector
  ) ?? null;
}

async function journalHasRecoverableAtomicEvidence(
  journal: RecoveryJournal,
  sessionPath: string
): Promise<boolean> {
  if (!journalEntry(journal, "write_prepared")) return false;
  if (journalEntry(journal, "recovery_temporary_preserved")
    || journalEntry(journal, "recovery_temporary_closed")) return true;
  return (await findMatchingPreparedTemporaryPaths(
    journal,
    sessionPath,
    MAX_PROFILE_RECOVERY_SCAN_ENTRIES
  )).length > 0;
}

async function reconcileInterruptedCommitBoundary(
  journal: RecoveryJournal,
  sessionPath: string,
  options: ApplyRecoveryOptions,
  expectedResidue: ApplyRecoveryInspection["atomicResidue"]
): Promise<ReconciledAtomicBoundary | null> {
  const prepared = journalEntry(journal, "write_prepared");
  if (!prepared) return null;
  const profileScanEntryLimit = stricterPositiveLimit(
    options.profileScanEntryLimit,
    MAX_PROFILE_RECOVERY_SCAN_ENTRIES,
    "Prepared temporary Profile scan"
  );
  const maxBytes = stricterPositiveLimit(
    options.preparedTemporaryReadLimitBytes,
    DEFAULT_MAX_COMPRESSED_BYTES,
    "Prepared temporary read"
  );
  const matching = await findMatchingPreparedTemporaryPaths(journal, sessionPath, profileScanEntryLimit);
  if (matching.length === 0) {
    if (expectedResidue) {
      throw new ApplyRecoveryBlockedError("The digest-bound atomic commit residue disappeared after inspection");
    }
    return null;
  }
  if (matching.length > 1) throw new ApplyRecoveryBlockedError("Multiple journal-bound atomic commit residues exist");
  if (!expectedResidue
    || expectedResidue.path !== matching[0]
    || expectedResidue.pathRevision !== prepared.evidence.temporaryPathRevision) {
    throw new ApplyRecoveryBlockedError("The atomic commit residue set changed after digest-bound inspection");
  }
  const before = journalBeforeFingerprint(journal);
  if (!before) throw new ApplyRecoveryBlockedError("Atomic commit recovery lacks its exact before-source fingerprint");

  const [targetState, preparedState] = await Promise.all([
    readBoundedFileState(sessionPath, maxBytes),
    readBoundedFileState(matching[0]!, maxBytes)
  ]);
  if (!sameJsonLz4Fingerprint(preparedState.fingerprint, expectedResidue.fingerprint)) {
    throw new ApplyRecoveryBlockedError("The atomic commit residue changed after digest-bound inspection");
  }
  const commitOutcomePreviouslyUncertain =
    journalEntry(journal, "interrupted")?.evidence.mutationStatus === "uncertain";
  if (!commitOutcomePreviouslyUncertain
    && targetState.fingerprint.digest !== prepared.evidence.preparedDigest
    && preparedState.fingerprint.digest !== prepared.evidence.preparedDigest) {
    if (sameJsonLz4Fingerprint(before, targetState.fingerprint)) return null;
    throw new ApplyRecoveryBlockedError(
      "An incomplete prepared image is paired with session Drift; the commit boundary remains ambiguous and every residue was retained"
    );
  }
  // A fragment created before the prepared image was complete is not a
  // candidate commit image. When the exact before-source is still canonical,
  // leave it to the artifact-preservation path below instead of attempting to
  // decode attacker- or crash-truncated bytes as JSONLZ4. Every actual commit
  // candidate and every indeterminate displaced writer is still decoded.
  const decodedPrepared = await readJsonLz4State(matching[0]!);
  if (!sameJsonLz4Fingerprint(decodedPrepared.fingerprint, preparedState.fingerprint)) {
    throw new ApplyRecoveryBlockedError("The atomic commit residue changed during JSONLZ4 validation");
  }

  const result = await reconcileInterruptedAtomicReplace({
    targetPath: sessionPath,
    preparedPath: matching[0]!,
    expectedTarget: before,
    expectedPreparedDigest: prepared.evidence.preparedDigest,
    maxBytes,
    afterClassification: options.afterAtomicRecoveryClassification,
    commitOutcomePreviouslyUncertain
  });
  if (result.classification === "uncertain") {
    throw new ApplyRecoveryBlockedError(
      `${result.reason}; atomic recovery retained ${result.residuePaths.join(", ")}`
    );
  }
  return result;
}

async function inspectJournalBoundAtomicResidue(
  journal: RecoveryJournal,
  sessionPath: string,
  maxEntries: number,
  maxBytes: number
): Promise<ApplyRecoveryInspection["atomicResidue"]> {
  const prepared = journalEntry(journal, "write_prepared");
  if (!prepared) return null;
  const matching = await findMatchingPreparedTemporaryPaths(journal, sessionPath, maxEntries);
  if (matching.length === 0) return null;
  if (matching.length > 1) throw new ApplyRecoveryBlockedError("Multiple journal-bound atomic commit residues exist");
  const state = await readBoundedFileState(matching[0]!, maxBytes);
  if ((state.fingerprint.mode & 0o022) !== 0) {
    throw new ApplyRecoveryBlockedError("Journal-bound atomic commit residue is writable by another user or group");
  }
  return {
    path: matching[0]!,
    pathRevision: prepared.evidence.temporaryPathRevision,
    fingerprint: state.fingerprint
  };
}

/**
 * Recovery must close the same durability boundary as the original writer
 * before it can publish terminal evidence. This is required both while the
 * displaced source still exists and when its unlink succeeded but the final
 * parent-directory sync did not, leaving no residue to clean up.
 */
async function completeInterruptedTargetDurability(
  journal: RecoveryJournal,
  sessionPath: string,
  expected: JsonLz4Fingerprint
): Promise<JsonLz4Fingerprint> {
  const preparedDigest = journalPreparedDigest(journal);
  if (!preparedDigest || expected.digest !== preparedDigest) return expected;
  const before = journalBeforeFingerprint(journal);
  if (!before) throw new ApplyRecoveryBlockedError("Interrupted commit durability lacks its before-source mode");

  const initial = await readJsonLz4State(sessionPath);
  if (!sameJsonLz4Fingerprint(initial.fingerprint, expected)) {
    throw new ApplyRecoveryBlockedError("Interrupted commit target changed before durability completion");
  }
  const target = await open(sessionPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  let targetIdentity: Stats;
  try {
    targetIdentity = await target.stat();
    if (!targetIdentity.isFile()
      || targetIdentity.nlink !== 1
      || (typeof process.getuid === "function" && targetIdentity.uid !== process.getuid())
      || targetIdentity.dev !== initial.fingerprint.device
      || targetIdentity.ino !== initial.fingerprint.inode
      || targetIdentity.size !== initial.fingerprint.size
      || (targetIdentity.mode & 0o777) !== initial.fingerprint.mode
      || targetIdentity.mtimeMs !== initial.fingerprint.modifiedMs
      || targetIdentity.ctimeMs !== initial.fingerprint.changedMs) {
      throw new ApplyRecoveryBlockedError("Interrupted commit target inode changed before durability completion");
    }
    const beforeChmod = await lstat(sessionPath);
    if (beforeChmod.isSymbolicLink()
      || !beforeChmod.isFile()
      || beforeChmod.nlink !== 1
      || beforeChmod.dev !== targetIdentity.dev
      || beforeChmod.ino !== targetIdentity.ino) {
      throw new ApplyRecoveryBlockedError("Interrupted commit target path changed before durability completion");
    }
    await target.chmod(before.mode);
    await target.sync();
    const canonical = await lstat(sessionPath);
    if (canonical.isSymbolicLink()
      || canonical.dev !== targetIdentity.dev
      || canonical.ino !== targetIdentity.ino) {
      throw new ApplyRecoveryBlockedError("Interrupted commit target path changed during durability completion");
    }
  } finally {
    await target.close();
  }
  await syncDirectory(dirname(sessionPath));
  const durable = await readJsonLz4State(sessionPath);
  if (durable.fingerprint.digest !== preparedDigest
    || durable.fingerprint.device !== targetIdentity.dev
    || durable.fingerprint.inode !== targetIdentity.ino
    || durable.fingerprint.mode !== before.mode) {
    throw new ApplyRecoveryBlockedError("Interrupted commit target failed exact durability completion");
  }
  return durable.fingerprint;
}

async function findMatchingPreparedTemporaryPaths(
  journal: RecoveryJournal,
  sessionPath: string,
  maxEntries: number
): Promise<string[]> {
  const prepared = journalEntry(journal, "write_prepared");
  if (!prepared) return [];
  const targetDirectory = dirname(sessionPath);
  const matching: string[] = [];
  const target = await opendir(targetDirectory);
  let scannedEntries = 0;
  try {
    for await (const entry of target) {
      scannedEntries += 1;
      if (scannedEntries > maxEntries) {
        throw new Error(`Prepared temporary scan exceeds ${maxEntries} Profile entries`);
      }
      if (!entry.isFile() || !/^\.zts-[0-9]+-[0-9a-f-]+\.jsonlz4\.tmp$/iu.test(entry.name)) continue;
      const candidate = join(targetDirectory, entry.name);
      if (sha256Canonical({ path: candidate }) === prepared.evidence.temporaryPathRevision) {
        matching.push(candidate);
      }
    }
  } finally {
    await target.close().catch(() => undefined);
  }
  return matching;
}

async function reconcilePreparedTemporary(
  layout: ApplyArtifactLayout,
  journalPath: string,
  journal: RecoveryJournal,
  sessionPath: string,
  options: ApplyRecoveryOptions,
  atomicBoundary: ReconciledAtomicBoundary | null
): Promise<PreparedTemporaryReconciliation | null> {
  const prepared = journalEntry(journal, "write_prepared");
  if (!prepared) return null;
  const targetDirectory = dirname(sessionPath);
  const profileScanEntryLimit = stricterPositiveLimit(
    options.profileScanEntryLimit,
    MAX_PROFILE_RECOVERY_SCAN_ENTRIES,
    "Prepared temporary Profile scan"
  );
  const preparedTemporaryReadLimit = stricterPositiveLimit(
    options.preparedTemporaryReadLimitBytes,
    DEFAULT_MAX_COMPRESSED_BYTES,
    "Prepared temporary read"
  );
  const matching = await findMatchingPreparedTemporaryPaths(
    journal,
    sessionPath,
    profileScanEntryLimit
  );
  if (matching.length > 1) throw new Error("Apply recovery found multiple matching prepared temporary images");

  if (atomicBoundary?.classification === "accepted_commit") {
    if (matching.length !== 1) {
      throw new Error("Accepted atomic commit lost its exact displaced before-source residue before cleanup");
    }
    const displaced = await readBoundedFileState(matching[0]!, preparedTemporaryReadLimit);
    if (!sameJsonLz4Fingerprint(displaced.fingerprint, atomicBoundary.prepared.fingerprint)) {
      throw new Error("Accepted atomic commit displaced source changed before durable cleanup");
    }
    await rm(matching[0]!);
    await syncDirectory(targetDirectory);
    await options.afterTemporaryUnlinked?.();
    return null;
  }

  const preserved = journalEntry(journal, "recovery_temporary_preserved");
  const closed = journalEntry(journal, "recovery_temporary_closed");
  if (closed) {
    if (matching.length !== 0) {
      throw new Error("Prepared temporary image reappeared after recorded reconciliation");
    }
    if (!preserved) throw new Error("Prepared temporary closure lacks preservation evidence");
    await validatePreservedTemporary(layout, preserved.evidence.preparedArtifact, preserved.evidence.completeness);
    return {
      artifact: preserved.evidence.preparedArtifact,
      completeness: preserved.evidence.completeness,
      disposition: closed.evidence.disposition
    };
  }

  let reconciliation: PreparedTemporaryReconciliation;
  if (preserved) {
    await validatePreservedTemporary(layout, preserved.evidence.preparedArtifact, preserved.evidence.completeness);
    reconciliation = {
      artifact: preserved.evidence.preparedArtifact,
      completeness: preserved.evidence.completeness,
      disposition: matching.length === 0 ? "observed_absent" : "removed"
    };
  } else {
    if (matching.length === 0) return null;
    const temporary = await readPreparedTemporary(
      matching[0]!,
      preparedTemporaryReadLimit,
      options.afterPreparedTemporaryStat
    );
    const completeness = temporary.digest === prepared.evidence.preparedDigest
      ? "complete" as const
      : atomicBoundary?.classification === "commit_overwritten"
        ? "external_writer" as const
        : "incomplete" as const;
    const preparedArtifact = artifactReference(
      `${completeness === "complete"
        ? "prepared-image"
        : completeness === "external_writer"
          ? "displaced-writer"
          : "prepared-fragment"}:${journal.transactionId}`,
      temporary.digest
    );
    await publishPrivateBytes(
      artifactObjectPath(
        layout.preparedImages,
        preparedArtifact.digest,
        completeness === "incomplete" ? "bin" : "jsonlz4"
      ),
      temporary.bytes
    );
    appendApplyJournal(journal, "recovery_temporary_preserved", {
      temporaryPathRevision: prepared.evidence.temporaryPathRevision,
      preparedArtifact,
      completeness,
      preservedAt: new Date().toISOString()
    });
    await replacePrivateJson(journalPath, journal);
    await options.afterTemporaryPreserved?.();
    reconciliation = { artifact: preparedArtifact, completeness, disposition: "removed" };
  }

  if (matching.length !== 0) {
    const beforeRemoval = await readPreparedTemporary(
      matching[0]!,
      preparedTemporaryReadLimit,
      options.afterPreparedTemporaryStat
    );
    if (beforeRemoval.digest !== reconciliation.artifact.digest) {
      throw new Error("Prepared temporary image changed after preservation");
    }
    await rm(matching[0]!);
    await syncDirectory(targetDirectory);
    await options.afterTemporaryUnlinked?.();
  }
  appendApplyJournal(journal, "recovery_temporary_closed", {
    temporaryPathRevision: prepared.evidence.temporaryPathRevision,
    preparedArtifact: reconciliation.artifact,
    disposition: reconciliation.disposition,
    closedAt: new Date().toISOString()
  });
  await replacePrivateJson(journalPath, journal);
  return reconciliation;
}

async function validatePreservedTemporary(
  layout: ApplyArtifactLayout,
  artifact: ArtifactReference,
  completeness: "complete" | "incomplete" | "external_writer"
): Promise<void> {
  const bytes = await readPrivateBytes(artifactObjectPath(
    layout.preparedImages,
    artifact.digest,
    completeness === "incomplete" ? "bin" : "jsonlz4"
  ), DEFAULT_MAX_COMPRESSED_BYTES);
  if (sha256Bytes(bytes) !== artifact.digest) {
    throw new Error("Preserved prepared image does not match its recovery artifact digest");
  }
}

async function readPreparedTemporary(
  path: string,
  maxBytes: number,
  afterStat?: (path: string) => void | Promise<void>
): Promise<{ readonly bytes: Buffer; readonly digest: Sha256Digest }> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1) {
      throw new Error("Prepared temporary image is not one owner-controlled regular file");
    }
    if (typeof process.getuid === "function" && before.uid !== process.getuid()) {
      throw new Error("Prepared temporary image is not owned by the current user");
    }
    if ((before.mode & 0o022) !== 0) {
      throw new Error("Prepared temporary image is writable by another user or group");
    }
    if (before.size > maxBytes) throw new Error("Prepared temporary image exceeds the read limit");
    await afterStat?.(path);
    const bytes = Buffer.allocUnsafe(before.size);
    let offset = 0;
    while (offset < before.size) {
      const { bytesRead } = await handle.read(bytes, offset, before.size - offset, offset);
      if (bytesRead === 0) throw new Error("Prepared temporary image changed while it was read");
      offset += bytesRead;
    }
    const growthProbe = Buffer.allocUnsafe(1);
    const { bytesRead: growthBytes } = await handle.read(growthProbe, 0, 1, before.size);
    if (growthBytes !== 0) {
      throw new Error("Prepared temporary image exceeds the read limit while being read");
    }
    const after = await handle.stat();
    if (before.dev !== after.dev
      || before.ino !== after.ino
      || before.nlink !== after.nlink
      || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs
      || before.ctimeMs !== after.ctimeMs
      || bytes.byteLength !== after.size) {
      throw new Error("Prepared temporary image changed while it was read");
    }
    const current = await lstat(path);
    if (current.isSymbolicLink() || current.dev !== after.dev || current.ino !== after.ino) {
      throw new Error("Prepared temporary image path changed while it was read");
    }
    return { bytes, digest: sha256Bytes(bytes) };
  } finally {
    await handle.close();
  }
}

function stricterPositiveLimit(value: number | undefined, maximum: number, label: string): number {
  const resolved = value ?? maximum;
  if (!Number.isSafeInteger(resolved) || resolved < 1 || resolved > maximum) {
    throw new Error(`${label} limit must be a positive integer no greater than ${maximum}`);
  }
  return resolved;
}

async function readBoundedDirectory(
  path: string,
  maxEntries: number,
  label: string
): Promise<import("node:fs").Dirent[]> {
  let directory;
  try {
    directory = await opendir(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const entries: import("node:fs").Dirent[] = [];
  try {
    for await (const entry of directory) {
      if (entries.length >= maxEntries) throw new Error(`${label} exceeds ${maxEntries} entries`);
      entries.push(entry);
    }
  } finally {
    await directory.close().catch(() => undefined);
  }
  return entries;
}

function sha256Bytes(bytes: Uint8Array): Sha256Digest {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}` as Sha256Digest;
}

async function syncDirectory(path: string): Promise<void> {
  const directory = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

function recoveredOperations(
  snapshot: Snapshot,
  actions: readonly MoveAction[],
  mutationAttempted: boolean,
  classification: RecoveryClassification,
  notAttemptedIssueCode = "hard_crash_before_mutation"
) {
  const entities = new Map(snapshot.entities.map((entity) => [entity.ref, entity]));
  return actions.map((action) => {
    const entity = entities.get(action.operation.entityRef);
    if (!mutationAttempted) {
      return {
        actionId: action.actionId,
        entityRef: action.operation.entityRef,
        observedWorkspaceId: entity?.workspaceId ?? null,
        status: "not_attempted" as const,
        mutationAttempted: false as const,
        netChanged: false as const,
        issueCodes: [notAttemptedIssueCode] as [string]
      };
    }
    if (classification === "external_drift") {
      return {
        actionId: action.actionId,
        entityRef: action.operation.entityRef,
        observedWorkspaceId: entity?.workspaceId ?? null,
        status: "failed" as const,
        mutationAttempted: true as const,
        netChanged: null,
        issueCodes: ["hard_crash_external_drift"] as [string]
      };
    }
    if (entity?.workspaceId === action.operation.expectedPostState.workspaceId) {
      return {
        actionId: action.actionId,
        entityRef: action.operation.entityRef,
        observedWorkspaceId: entity.workspaceId,
        status: "verified" as const,
        mutationAttempted: true as const,
        netChanged: true as const,
        issueCodes: [] as const
      };
    }
    const unchanged = entity?.workspaceId === action.operation.precondition.sourceWorkspace.workspaceId;
    return {
      actionId: action.actionId,
      entityRef: action.operation.entityRef,
      observedWorkspaceId: entity?.workspaceId ?? null,
      status: "failed" as const,
      mutationAttempted: true as const,
      netChanged: unchanged ? false as const : null,
      issueCodes: [unchanged ? "hard_crash_operation_unchanged" : "hard_crash_state_uncertain"] as [string]
    };
  });
}

function operationNetChanged(operations: ReturnType<typeof recoveredOperations>): boolean | null {
  if (operations.some((operation) => operation.netChanged === null)) return null;
  return operations.some((operation) => operation.netChanged === true);
}

function assertExactRecoveredInversePlan(
  storedInverse: { readonly snapshot: Snapshot; readonly plan: Plan },
  expectedAfterSnapshot: Snapshot,
  sourcePlan: Plan,
  actions: readonly MoveAction[],
  sourceReceiptId: string
): void {
  if (storedInverse.snapshot.revision !== expectedAfterSnapshot.revision) {
    throw new Error("Existing inverse Plan Snapshot does not match the exact planned after-Snapshot");
  }
  const expectedInverse = createInversePlan(
    storedInverse.snapshot,
    sourcePlan,
    actions,
    sourceReceiptId,
    new Date(storedInverse.plan.createdAt)
  );
  if (expectedInverse.digest !== storedInverse.plan.digest) {
    throw new Error("Existing inverse Plan does not exactly reverse its recovered source Plan and Operations");
  }
}

function terminalReceiptProvesSafeCleanup(receipt: Receipt): boolean {
  if (receipt.control.route !== "closed_session") return false;
  if (receipt.control.exclusiveControlReleased === "verified") return true;
  return receipt.outcome === "blocked"
    && receipt.mutationAttempted === false
    && receipt.control.exclusiveControlReleased === "not_started";
}

async function releaseMatchingStaleLock(
  context: ProfileContext,
  journal: RecoveryJournal,
  lock: ProfileLockInspection
): Promise<boolean> {
  if (lock.status === "absent") return false;
  if (lock.status !== "stale") {
    throw new ApplyRecoveryBlockedError(`Cannot release Profile lock in ${lock.status} state`);
  }
  if (!staleLockMatchesJournal(journal, lock)) {
    throw new ApplyRecoveryBlockedError("Stale Profile lock does not match this recovery journal");
  }
  await releaseStaleProfileTransactionLock(context.profile, lock.artifactRevision);
  return true;
}

function staleLockMatchesJournal(
  journal: RecoveryJournal,
  lock: {
    readonly artifactRevision: Sha256Digest;
    readonly transactionId: string | null;
    readonly commandRevision: Sha256Digest;
  }
): boolean {
  const expected = journalLockRevision(journal);
  if (expected === lock.artifactRevision) return true;
  if (lock.transactionId !== journal.transactionId) return false;
  if (lock.commandRevision === sha256Canonical({ command: `zts apply recover ${journal.transactionId}` })) {
    return true;
  }
  return expected === null;
}

async function assertRecoveryEvidenceStable(
  context: ProfileContext,
  journal: RecoveryJournal,
  expectedFingerprint: JsonLz4Fingerprint,
  nativeControl: NativeProfileControl
): Promise<void> {
  await nativeControl.assertHeld();
  const refreshed = await refreshTargetContext(context);
  assertPrimarySessionSource(refreshed);
  if (sha256Canonical({ path: refreshed.sessionFile.path }) !== journal.targetPathRevision) {
    throw new ApplyRecoveryBlockedError("Apply recovery target path changed before terminal publication");
  }
  const current = await readJsonLz4State(refreshed.sessionFile.path);
  if (!sameJsonLz4Fingerprint(expectedFingerprint, current.fingerprint)) {
    throw new ApplyRecoveryBlockedError("Apply recovery session evidence changed before terminal publication");
  }
  await nativeControl.assertHeld();
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

function assertPrimarySessionSource(context: ProfileContext): void {
  if (context.sessionFile.kind !== "zen-sessions") {
    throw new Error("Apply recovery requires zen-sessions.jsonlz4 as the authoritative source");
  }
}

function executableActions(plan: { readonly actions: readonly PlanAction[] }): readonly MoveAction[] {
  const actions = plan.actions.filter((action): action is MoveAction => action.disposition === "move");
  if (actions.length === 0) throw new Error("Recovery Plan has no executable Operations");
  return actions;
}

function validateJournalBindings(
  journal: RecoveryJournal,
  beforeSnapshot: Snapshot,
  plan: Plan,
  authorization: ApplyAuthorization,
  actions: readonly MoveAction[]
): void {
  if (
    journal.planId !== plan.id
    || journal.planDigest !== plan.digest
    || journal.profileId !== plan.profileId
    || journal.authorizationRevision !== authorization.revision
  ) {
    throw new Error("Apply recovery journal does not match its Plan or Authorization");
  }
  const locked = journalEntry(journal, "locked");
  if (locked) {
    const ids = locked.evidence.authorizedActionIds as readonly string[];
    if (ids.length !== authorization.authorizedActionIds.length
      || ids.some((id, index) => id !== authorization.authorizedActionIds[index])) {
      throw new Error("Apply recovery journal authorized actions do not match the Authorization");
    }
  }
  const preflight = journalEntry(journal, "preflight_ok");
  if (preflight?.evidence.operationCount !== undefined
    && preflight.evidence.operationCount !== actions.length) {
    throw new Error("Apply recovery journal Operation count does not match the Plan");
  }
  if (preflight && "expectedAfterSnapshotRevision" in preflight.evidence) {
    const expectedAfterSnapshot = deriveExactPlannedAfterSnapshot(beforeSnapshot, actions);
    if (preflight.evidence.expectedAfterSnapshotRevision !== expectedAfterSnapshot.revision) {
      throw new Error("Apply recovery journal expected after-Snapshot does not match the exact Plan result");
    }
    const inverse = journalArtifactReference(journal, "inversePlanArtifact");
    if (!inverse
      || inverse.id !== preflight.evidence.inversePlanArtifact.id
      || inverse.digest !== preflight.evidence.inversePlanArtifact.digest) {
      throw new Error("Apply recovery journal lost its pre-mutation inverse Plan binding");
    }
  }
}

async function loadAndValidateBackupManifest(
  layout: ApplyArtifactLayout,
  reference: ArtifactReference,
  journal: RecoveryJournal
): Promise<BackupManifestArtifact> {
  const value = await loadJsonArtifact(layout.backupManifests, reference, "Backup manifest");
  assertObjectKeys(value, [
    "schemaVersion",
    "transactionId",
    "profileId",
    "targetPathRevision",
    "capturedAt",
    "sourceFingerprint",
    "rawArtifact"
  ], "Backup manifest");
  const manifest = value as unknown as BackupManifestArtifact;
  if (
    manifest.schemaVersion !== "zts.session-backup.provisional-1"
    || manifest.transactionId !== journal.transactionId
    || manifest.profileId !== journal.profileId
    || manifest.targetPathRevision !== journal.targetPathRevision
    || reference.id !== `backup:${journal.transactionId}`
    || !isFingerprint(manifest.sourceFingerprint)
    || !isArtifactReference(manifest.rawArtifact)
    || manifest.rawArtifact.id !== `backup-bytes:${journal.transactionId}`
    || manifest.rawArtifact.digest !== manifest.sourceFingerprint.digest
  ) {
    throw new Error("Backup manifest does not match the recovery transaction");
  }
  canonicalTimestamp(manifest.capturedAt, "Backup manifest capturedAt");
  const raw = await readPrivateBytes(
    artifactObjectPath(layout.backups, manifest.rawArtifact.digest, "jsonlz4"),
    DEFAULT_MAX_COMPRESSED_BYTES
  );
  const rawDigest = `sha256:${createHash("sha256").update(raw).digest("hex")}`;
  if (rawDigest !== manifest.rawArtifact.digest || raw.byteLength !== manifest.sourceFingerprint.size) {
    throw new Error("Backup bytes do not match the Backup manifest");
  }
  return manifest;
}

async function loadAndValidateRecoveryDescriptor(
  layout: ApplyArtifactLayout,
  reference: ArtifactReference,
  journal: RecoveryJournal,
  plan: Plan,
  backupArtifact: ArtifactReference | null
): Promise<RecoveryDescriptorArtifact> {
  const value = await loadJsonArtifact(layout.recoveries, reference, "Recovery descriptor");
  assertObjectKeys(value, [
    "schemaVersion",
    "transactionId",
    "profileId",
    "planId",
    "planDigest",
    "targetPathRevision",
    "beforeSourceFingerprint",
    "backupArtifact",
    "status",
    "createdAt"
  ], "Recovery descriptor");
  const descriptor = value as unknown as RecoveryDescriptorArtifact;
  const journalBefore = journalBeforeFingerprint(journal);
  if (
    descriptor.schemaVersion !== RECOVERY_SCHEMA
    || descriptor.transactionId !== journal.transactionId
    || descriptor.profileId !== plan.profileId
    || descriptor.planId !== plan.id
    || descriptor.planDigest !== plan.digest
    || descriptor.targetPathRevision !== journal.targetPathRevision
    || reference.id !== `recovery:${journal.transactionId}`
    || !isFingerprint(descriptor.beforeSourceFingerprint)
    || (journalBefore !== null && !sameJsonLz4Fingerprint(journalBefore, descriptor.beforeSourceFingerprint))
    || !sameArtifactReference(descriptor.backupArtifact, backupArtifact)
    || !["prepared_before_mutation", "created_during_hard_crash_recovery"].includes(descriptor.status)
  ) {
    throw new Error("Recovery descriptor does not match the recovery transaction");
  }
  canonicalTimestamp(descriptor.createdAt, "Recovery descriptor createdAt");
  return descriptor;
}

async function loadJsonArtifact(
  root: string,
  reference: ArtifactReference,
  label: string
): Promise<Record<string, unknown>> {
  const value = await readPrivateJson(artifactObjectPath(root, reference.digest));
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  if (sha256Canonical(value) !== reference.digest) {
    throw new Error(`${label} ${reference.id} does not match its digest`);
  }
  return value as Record<string, unknown>;
}

function assertObjectKeys(value: Record<string, unknown>, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  if (actual.length !== sortedExpected.length || actual.some((key, index) => key !== sortedExpected[index])) {
    throw new Error(`${label} contains unknown or missing fields`);
  }
}

function sameArtifactReference(
  left: ArtifactReference | null,
  right: ArtifactReference | null
): boolean {
  if (left === null || right === null) return left === right;
  return left.id === right.id && left.digest === right.digest;
}

function isArtifactReference(value: unknown): value is ArtifactReference {
  return Boolean(value && typeof value === "object"
    && !Array.isArray(value)
    && typeof (value as { id?: unknown }).id === "string"
    && isDigest((value as { digest?: unknown }).digest));
}

function isFingerprint(value: unknown): value is JsonLz4Fingerprint {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Partial<JsonLz4Fingerprint>;
  return isDigest(candidate.digest)
    && [candidate.size, candidate.mode, candidate.modifiedMs, candidate.changedMs, candidate.device, candidate.inode]
      .every((entry) => typeof entry === "number" && Number.isFinite(entry));
}

function isDigest(value: unknown): value is Sha256Digest {
  return typeof value === "string" && /^sha256:[a-f0-9]{64}$/u.test(value);
}

function assertDigest(value: string, label: string): asserts value is Sha256Digest {
  if (!isDigest(value)) throw new Error(`${label} must be a canonical SHA-256 digest`);
}

function ztsMessage(value: string): ZtsMessage {
  return {
    value: boundedZtsMessageValue(value),
    provenance: "zts_generated",
    interpretation: "data_only"
  };
}

function canonicalTimestamp(value: unknown, label: string): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new Error(`${label} must be a canonical timestamp`);
  }
  return new Date(value).toISOString();
}
