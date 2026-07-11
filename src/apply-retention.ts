import { createHash, randomUUID } from "node:crypto";
import { lstat, readdir } from "node:fs/promises";
import { basename, relative, sep } from "node:path";
import {
  artifactObjectPath,
  digestHex,
  readApplyArtifactLayout,
  safeArtifactSegment
} from "./apply-artifacts.js";
import {
  buildApplyReceiptSummaryGeneration,
  defineApplyReceiptHistoryHead,
  defineApplyReceiptSummary,
  scanApplyReceiptSummaries,
  readApplyReceiptHistoryHead,
  readApplyReceiptHistoryNodeDigests,
  swapApplyReceiptHistoryHead,
  transactionIdFromReceiptId,
  withApplyReceiptHistoryMigration
} from "./apply-receipt-store.js";
import {
  APPLY_RETENTION_FIXED_HEADROOM_BYTES,
  APPLY_RETENTION_FIXED_PEAK_ENTRIES,
  APPLY_RETENTION_HISTORY_NODE_MAX_BYTES,
  APPLY_RETENTION_MANIFEST_MAX_BYTES,
  APPLY_RETENTION_MAX_TARGET_ENTRIES,
  APPLY_RETENTION_MAX_INVENTORY_ENTRIES,
  APPLY_RETENTION_RESULT_MAX_BYTES,
  APPLY_STORE_ACCOUNTING_MAX_BYTES,
  APPLY_STORE_MAX_BYTES,
  APPLY_STORE_MAX_ENTRIES,
  beginApplyStoreMaintenance,
  beginLegacyApplyStoreMaintenance,
  clearOrphanApplyStoreReservation,
  completeApplyStoreMaintenance,
  initializeApplyStoreAccountingBaseline,
  readApplyStoreAccounting
} from "./apply-store-accounting.js";
import { readApplyUnfinishedMarkers } from "./apply-unfinished-store.js";
import { validateTransactionReceiptSummaryForRetention } from "./apply-transaction.js";
import { APPLY_UNDO_WINDOW_DAYS } from "./apply-policy.js";
import { defineApplyJournal } from "./apply-journal.js";
import { sha256Canonical } from "./domain/digest.js";
import { INVERSE_PLAN_MAX_BYTES, loadInversePlan } from "./inverse-plan-store.js";
import { loadStoredPlan } from "./plans.js";
import {
  inspectPrivateStandaloneTemporaryCandidate,
  isPrivateTemporaryBasename,
  privatePath,
  publishPrivateBytes,
  readPrivateBytes,
  readPrivateJson,
  reconcilePrivatePublication,
  removePrivateDirectoryTree,
  removePrivateFile,
  removePrivateStandaloneTemporaryCandidate,
  replacePrivateJson
} from "./private-store.js";

import type { ApplyArtifactLayout } from "./apply-artifacts.js";
import type { Sha256Digest } from "./domain/digest.js";
import type { PrivateStandaloneTemporaryCandidate } from "./private-store.js";
import type { ArtifactReference } from "./domain/snapshot.js";
import type {
  ApplyReceiptHistoryControl,
  ApplyReceiptHistoryGeneration,
  ApplyReceiptHistoryHead,
  ApplyReceiptSummary
} from "./apply-receipt-store.js";

const MANIFEST_SCHEMA = "zts.apply-retention-manifest.provisional-3" as const;
const RESULT_SCHEMA = "zts.apply-retention-result.provisional-1" as const;
const MANIFEST_FILENAME = "retention-manifest.json";
const RESULT_FILENAME = "retention-last.json";
const MANIFEST_MAX_BYTES = APPLY_RETENTION_MANIFEST_MAX_BYTES;
const RESULT_MAX_BYTES = APPLY_RETENTION_RESULT_MAX_BYTES;
const MAX_DELETION_TARGETS = APPLY_STORE_MAX_ENTRIES;
const HISTORY_NODE_MAX_BYTES = APPLY_RETENTION_HISTORY_NODE_MAX_BYTES;
const MAINTENANCE_METADATA_BYTES = APPLY_RETENTION_FIXED_HEADROOM_BYTES;
const DAY_MS = 24 * 60 * 60 * 1000;
const MEBIBYTE = 1024 * 1024;
const MAX_REACHABILITY_REFERENCES = 50_000;
const MAX_REACHABILITY_VALUES = 250_000;
const MAX_REACHABILITY_DEPTH = 64;

export const APPLY_RETENTION_DESTRUCTIVE_CONSENT = "delete_archived_apply_payloads" as const;

export interface ApplyRetentionPolicy {
  readonly undoWindowDays: number;
  readonly maxSummaryEntries: number;
  readonly maxInventoryEntries: number;
  readonly maxStoreBytes: number;
  readonly minimumFreeBytes: number;
}

export const DEFAULT_APPLY_RETENTION_POLICY: ApplyRetentionPolicy = Object.freeze({
  undoWindowDays: APPLY_UNDO_WINDOW_DAYS,
  maxSummaryEntries: 2_048,
  maxInventoryEntries: APPLY_RETENTION_MAX_INVENTORY_ENTRIES,
  maxStoreBytes: 2 * 1024 * 1024 * 1024,
  minimumFreeBytes: 512 * 1024 * 1024
});

type MaintenanceAction =
  | "plan"
  | "reconcile_publication_residue"
  | "resume_deletions"
  | "discard_prepared_generation"
  | "clear_orphan_gate"
  | "clear_orphan_reservation";

interface FileIdentity {
  readonly kind: "file";
  readonly device: number;
  readonly inode: number;
  readonly size: number;
  readonly mode: number;
  readonly modifiedMs: number;
  readonly changedMs: number;
}

interface DirectoryIdentity {
  readonly kind: "transaction_directory";
  readonly device: number;
  readonly inode: number;
  readonly mode: number;
  readonly modifiedMs: number;
  readonly changedMs: number;
  readonly treeRevision: Sha256Digest;
  readonly totalBytes: number;
  readonly fileCount: number;
  readonly entryCount: number;
  readonly treeEntries: readonly TreeEntryIdentity[];
}

interface TreeEntryIdentity {
  readonly path: string;
  readonly kind: "file" | "directory";
  readonly device: number;
  readonly inode: number;
  readonly size: number;
  readonly mode: number;
  readonly modifiedMs: number;
  readonly changedMs: number;
}

type DeletionTarget = {
  readonly relativePath: string;
  readonly bytes: number;
  readonly files: number;
  readonly identity: FileIdentity | DirectoryIdentity;
};

interface ApplyRetentionManifest {
  readonly schemaVersion: typeof MANIFEST_SCHEMA;
  readonly maintenanceId: string;
  readonly profileId: string;
  readonly sourceHead: ApplyReceiptHistoryHead;
  readonly sourceNodeDigests: readonly Sha256Digest[];
  readonly targetHead: ApplyReceiptHistoryHead;
  readonly targetNodeDigests: readonly Sha256Digest[];
  readonly sourceSummaryCount: number;
  readonly targetSummaryCount: number;
  readonly sourceFullReceiptCount: number;
  readonly targetFullReceiptCount: number;
  readonly archivedReceiptCount: number;
  readonly evictedSummaryCount: number;
  readonly createdAt: string;
  readonly deletionTargets: readonly DeletionTarget[];
  readonly deletionTotals: {
    readonly bytes: number;
    readonly files: number;
    readonly transactionDirectories: number;
  };
  readonly revision: Sha256Digest;
}

interface ApplyRetentionDurableResult {
  readonly schemaVersion: typeof RESULT_SCHEMA;
  readonly maintenanceId: string;
  readonly profileId: string;
  readonly outcome: "applied" | "discarded";
  readonly sourceHeadRevision: Sha256Digest;
  readonly targetHeadRevision: Sha256Digest;
  readonly removedBytes: number;
  readonly removedFiles: number;
  readonly removedTransactionDirectories: number;
  readonly completedAt: string;
  readonly revision: Sha256Digest;
}

interface InventoryEntry {
  readonly path: string;
  readonly relativePath: string;
  readonly kind: "file" | "directory";
  readonly size: number;
  readonly device: number;
  readonly inode: number;
  readonly mode: number;
  readonly modifiedMs: number;
  readonly changedMs: number;
  readonly linkCount: number;
}

export interface ApplyRetentionInspection {
  readonly schemaVersion: "zts.apply-retention-inspection.provisional-2";
  readonly profileId: string;
  readonly inspectedAt: string;
  readonly inspectionRevision: Sha256Digest;
  readonly policy: ApplyRetentionPolicy;
  readonly sourceHeadRevision: Sha256Digest;
  readonly action: MaintenanceAction;
  readonly maintenanceId: string | null;
  readonly accountingBytes: number;
  readonly accountingEntries: number;
  readonly maintenancePeakBytes: number;
  readonly maintenancePeakEntries: number;
  readonly targetPlanRevision: Sha256Digest;
  readonly publicationResidueCount: number;
  readonly uncommittedTemporaryCount: number;
  readonly summaryCountBefore: number;
  readonly summaryCountAfter: number;
  readonly fullReceiptCountBefore: number;
  readonly fullReceiptCountAfter: number;
  readonly archiveReceiptCount: number;
  readonly evictSummaryCount: number;
  readonly unfinishedTransactionCount: number;
  readonly reclaimableBytesLowerBound: number;
  readonly reclaimableFileCountLowerBound: number;
  readonly manifestBytesUpperBound: number;
  readonly blockers: readonly string[];
}

export interface ApplyRetentionResult {
  readonly inspection: ApplyRetentionInspection;
  readonly maintenanceId: string;
  readonly outcome: "applied" | "discarded";
  readonly summaryCount: number;
  readonly archivedReceiptCount: number;
  readonly evictedSummaryCount: number;
  readonly removedBytes: number;
  readonly removedFiles: number;
  readonly removedTransactionDirectories: number;
  readonly completedAt: string;
}

export interface ApplyRetentionHooks {
  readonly afterMaintenanceGate?: () => void | Promise<void>;
  readonly afterGenerationBuilt?: () => void | Promise<void>;
  readonly afterManifest?: () => void | Promise<void>;
  readonly afterHeadSwap?: () => void | Promise<void>;
  readonly afterDeletion?: (targetIndex: number) => void | Promise<void>;
}

interface RetentionAnalysis {
  readonly layout: ApplyArtifactLayout;
  readonly inspection: ApplyRetentionInspection;
  readonly head: ApplyReceiptHistoryHead;
  readonly sourceReceiptIds: readonly string[];
  readonly sourceSummaryCount: number;
  readonly targetSummaries: readonly ApplyReceiptSummary[];
  readonly inventory: readonly InventoryEntry[];
  readonly validatedFullReceiptIds: ReadonlySet<string>;
  readonly manifest: ApplyRetentionManifest | null;
  readonly publicationResidues: readonly PublicationResidue[];
  readonly uncommittedTemporaries: readonly PrivateStandaloneTemporaryCandidate[];
}

interface PublicationResidue {
  readonly canonicalPath: string;
  readonly temporaryPath: string;
  readonly device: number;
  readonly inode: number;
}

export class ApplyRetentionBlockedError extends Error {
  readonly inspection: ApplyRetentionInspection;
  constructor(inspection: ApplyRetentionInspection) {
    super(`Apply retention is blocked: ${inspection.blockers.join("; ")}`);
    this.name = "ApplyRetentionBlockedError";
    this.inspection = inspection;
  }
}

export async function inspectApplyStoreRetention(
  profileId: string,
  options: { readonly now?: Date; readonly policy?: ApplyRetentionPolicy } = {}
): Promise<ApplyRetentionInspection> {
  const layout = await readApplyArtifactLayout(profileId);
  const now = validDate(options.now ?? new Date(), "Apply retention inspection time");
  const policy = definePolicy(options.policy ?? DEFAULT_APPLY_RETENTION_POLICY);
  return (await analyzeRetention(layout, profileId, policy, now)).inspection;
}

export async function applyApplyStoreRetention(
  profileId: string,
  options: {
    readonly expectedInspectionRevision: Sha256Digest;
    readonly destructiveConsent: typeof APPLY_RETENTION_DESTRUCTIVE_CONSENT;
    readonly now?: Date;
    readonly policy?: ApplyRetentionPolicy;
    readonly hooks?: ApplyRetentionHooks;
  }
): Promise<ApplyRetentionResult> {
  if (options.destructiveConsent !== APPLY_RETENTION_DESTRUCTIVE_CONSENT) {
    throw new Error("Apply retention requires explicit typed deletion consent");
  }
  if (!isDigest(options.expectedInspectionRevision)) {
    throw new Error("Apply retention requires a canonical reviewed inspection revision");
  }
  const layout = await readApplyArtifactLayout(profileId);
  const now = validDate(options.now ?? new Date(), "Apply retention execution time");
  const policy = definePolicy(options.policy ?? DEFAULT_APPLY_RETENTION_POLICY);
  return withApplyReceiptHistoryMigration(layout, profileId, async (control) => {
    const analysis = await analyzeRetention(layout, profileId, policy, now, control);
    if (analysis.inspection.inspectionRevision !== options.expectedInspectionRevision) {
      throw new Error(
        `Apply retention inspection Drift: expected ${options.expectedInspectionRevision}, current ${analysis.inspection.inspectionRevision}`
      );
    }
    if (analysis.inspection.blockers.length > 0
      && analysis.inspection.action !== "reconcile_publication_residue") {
      throw new ApplyRetentionBlockedError(analysis.inspection);
    }
    if (analysis.uncommittedTemporaries.length > 0
      && analysis.inspection.action !== "reconcile_publication_residue") {
      // The history lock is the Apply-store admission and maintenance owner.
      // A blocker above (notably an unfinished marker) prevents this branch,
      // so no live transaction writer can still own these exact parents.
      await reconcileExactStandaloneTemporaries(analysis.uncommittedTemporaries);
    }
    if (analysis.publicationResidues.length > 0
      && analysis.inspection.action !== "reconcile_publication_residue") {
      const accounting = await readApplyStoreAccounting(layout, profileId);
      if (!accounting?.maintenanceId
        || accounting.maintenanceId !== analysis.inspection.maintenanceId) {
        throw new Error("Apply publication residue lacks the exact maintenance owner required for repair");
      }
      await reconcileExactPublicationResidues(analysis.publicationResidues);
    }
    switch (analysis.inspection.action) {
      case "reconcile_publication_residue":
        return reconcilePublicationResidues(analysis, policy, now);
      case "clear_orphan_gate":
      case "clear_orphan_reservation":
        return clearOrphanAccounting(analysis, now);
      case "discard_prepared_generation":
        return discardPreparedGeneration(analysis, now);
      case "resume_deletions":
        return resumeManifestDeletions(analysis, policy, now, options.hooks);
      case "plan":
        return executeNewRetention(analysis, control, policy, now, options.hooks);
    }
  });
}

async function analyzeRetention(
  layout: ApplyArtifactLayout,
  profileId: string,
  policy: ApplyRetentionPolicy,
  now: Date,
  _control?: ApplyReceiptHistoryControl
): Promise<RetentionAnalysis> {
  const inventory = await inventoryApplyStore(layout, policy.maxInventoryEntries, true);
  const publicationResidues = findPublicationResidues(inventory);
  const uncommittedTemporaries = await findStandaloneTemporaryCandidates(inventory);
  const accountingBytes = inventory.filter((entry) => entry.kind === "file")
    .reduce((sum, entry) => sum + entry.size, 0);
  const accountingEntries = inventory.length;
  const accountingFile = inventory.find((entry) => entry.relativePath === "store-accounting.json");
  const reservedBaselineBytes = accountingBytes
    - (accountingFile?.size ?? 0)
    + APPLY_STORE_ACCOUNTING_MAX_BYTES;
  const reservedBaselineEntries = accountingEntries + Number(!accountingFile);
  const head = await readApplyReceiptHistoryHead(layout, profileId);
  if (!head) throw new Error("Apply Receipt history is not initialized; no retention source head exists");
  const markers = await readApplyUnfinishedMarkers(
    layout,
    profileId,
    async (boundProfileId, planDigest) => (await loadStoredPlan(boundProfileId, planDigest)).plan
  );
  if (markers === null) throw new Error("Apply unfinished index is not initialized");
  const accounting = await readApplyStoreAccounting(layout, profileId);
  const manifest = await readManifest(layout, profileId);
  const blockers: string[] = [];
  if (markers.length > 0) {
    blockers.push(
      `${markers.length} unfinished Apply Transaction${markers.length === 1 ? "" : "s"} must reach a terminal Receipt first; inspect with zts apply recover --json`
    );
  }

  let action: MaintenanceAction = "plan";
  let maintenanceId: string | null = null;
  if (accounting?.activeReservation && markers.length === 0) {
    const segment = safeArtifactSegment(accounting.activeReservation.transactionId);
    if (inventory.some((entry) => entry.relativePath === `transactions${sep}${segment}`)) {
      blockers.push(`Orphan Apply reservation ${accounting.activeReservation.transactionId} has unexpected transaction artifacts`);
    } else {
      action = "clear_orphan_reservation";
      maintenanceId = accounting.activeReservation.transactionId;
    }
  }
  if (accounting?.maintenanceId) {
    maintenanceId = accounting.maintenanceId;
    if (!manifest) {
      action = "clear_orphan_gate";
    } else if (manifest.maintenanceId !== accounting.maintenanceId) {
      blockers.push("Apply retention manifest and accounting gate have different owners");
    } else if (head.revision === manifest.sourceHead.revision) {
      action = "discard_prepared_generation";
    } else if (head.revision === manifest.targetHead.revision) {
      action = "resume_deletions";
    } else {
      blockers.push("Apply retention manifest matches neither the source nor target ready head");
    }
  } else if (manifest) {
    blockers.push("Apply retention manifest exists without its bounded maintenance gate");
  }
  const residueCount = publicationResidues.length + uncommittedTemporaries.length;
  if (residueCount > 0 && action === "plan" && blockers.length === 0) {
    action = "reconcile_publication_residue";
    blockers.push(
      `${residueCount} interrupted private publication or replacement residue${residueCount === 1 ? "" : "s"} must be reconciled under exact store control before retention can be planned`
    );
  }
  if (publicationResidues.length > 0 && action === "clear_orphan_reservation") {
    blockers.push("Interrupted private publication residue cannot be repaired by an orphan transaction reservation");
  }

  const cutoff = now.getTime() - policy.undoWindowDays * DAY_MS;
  const protectedEvictionIds = new Set<string>();
  const retainedBoundaryConsumers = new Set<string>();
  const seenReceiptIds = new Set<string>();
  const pendingCausalConsumers = new Map<string, {
    readonly consumer: ApplyReceiptSummary;
    readonly newestIndex: number;
  }>();
  let causalClosureIssue: string | null = null;
  const sourceScan = await scanApplyReceiptSummaries(layout, profileId, {
    maxEntries: policy.maxSummaryEntries + 50_000,
    retainNewest: policy.maxSummaryEntries,
    onSummary: (summary, newestIndex) => {
      if (newestIndex >= policy.maxSummaryEntries && Date.parse(summary.completedAt) >= cutoff) {
        protectedEvictionIds.add(summary.id);
      }
      if (summary.outcome === "applied" && summary.causalSourceReceiptId !== null) {
        if (summary.causalSourceReceiptId === summary.id) {
          causalClosureIssue ??= `successful Undo ${summary.id} names itself as its causal source`;
        } else if (seenReceiptIds.has(summary.causalSourceReceiptId)) {
          causalClosureIssue ??= `successful Undo ${summary.id} names a causal source that is not older in canonical history`;
        } else if (pendingCausalConsumers.has(summary.causalSourceReceiptId)) {
          causalClosureIssue ??= `multiple successful Undo Receipts consume ${summary.causalSourceReceiptId}`;
        } else {
          pendingCausalConsumers.set(summary.causalSourceReceiptId, { consumer: summary, newestIndex });
        }
      }
      const pending = pendingCausalConsumers.get(summary.id);
      if (pending) {
        const issue = causalSourceIssue(pending.consumer, summary);
        if (issue) causalClosureIssue ??= issue;
        if (!issue
          && pending.newestIndex < policy.maxSummaryEntries
          && newestIndex >= policy.maxSummaryEntries) {
          retainedBoundaryConsumers.add(pending.consumer.id);
        }
        pendingCausalConsumers.delete(summary.id);
      }
      seenReceiptIds.add(summary.id);
    }
  });
  if (!sourceScan) throw new Error("Apply Receipt ready history is unavailable");
  if (pendingCausalConsumers.size > 0) {
    causalClosureIssue ??= `${pendingCausalConsumers.size} successful Undo Receipt${pendingCausalConsumers.size === 1 ? " has" : "s have"} no causal source in canonical history`;
  }
  if (causalClosureIssue) {
    blockers.push(`Apply Receipt history lacks causal closure: ${causalClosureIssue}`);
  }
  const retained = sourceScan.newest.filter((summary) => !retainedBoundaryConsumers.has(summary.id));
  for (const summary of sourceScan.newest) {
    if (retainedBoundaryConsumers.has(summary.id) && Date.parse(summary.completedAt) >= cutoff) {
      protectedEvictionIds.add(summary.id);
    }
  }
  const evictedCount = sourceScan.summaryCount - retained.length;
  if (action === "plan" && protectedEvictionIds.size > 0) {
    blockers.push(
      `${protectedEvictionIds.size} summaries inside the ${policy.undoWindowDays}-day undo window exceed the ${policy.maxSummaryEntries}-summary causally closed bound`
    );
  }
  const targetSummaries = retained.map((summary) => {
    if (summary.fullReceiptAvailability === "archived_summary_only") return summary;
    if (Date.parse(summary.completedAt) >= cutoff) return summary;
    return defineApplyReceiptSummary({
      ...summary,
      fullReceiptAvailability: "archived_summary_only",
      archivedAt: new Date(
        Date.parse(summary.completedAt) + policy.undoWindowDays * DAY_MS
      ).toISOString()
    }, profileId);
  });
  const archiveReceiptCount = retained.filter((summary) =>
    summary.fullReceiptAvailability === "available"
      && Date.parse(summary.completedAt) < cutoff
  ).length;
  const validatedFullReceiptIds = new Set<string>();
  if (action === "plan" && blockers.length === 0) {
    await scanApplyReceiptSummaries(layout, profileId, {
      maxEntries: policy.maxSummaryEntries + 50_000,
      retainNewest: 0,
      collectReceiptIds: false,
      onSummary: async (summary) => {
        if (summary.fullReceiptAvailability !== "available") return;
        await validateTransactionReceiptSummaryForRetention(profileId, summary);
        validatedFullReceiptIds.add(summary.id);
      }
    });
  }
  const calculatedFullAfter = targetSummaries.filter((summary) => summary.fullReceiptAvailability === "available").length;
  const maintenanceReservationByteCount = maintenanceReservationBytes(targetSummaries.length);
  const maintenanceReservationEntryCount = maintenanceReservationEntries(targetSummaries.length);
  const maintenancePeakBytes = reservedBaselineBytes + maintenanceReservationByteCount;
  const maintenancePeakEntries = reservedBaselineEntries + maintenanceReservationEntryCount;
  if (action === "plan" && blockers.length === 0 && maintenancePeakBytes > policy.maxStoreBytes) {
    blockers.push(
      `Apply retention target-generation peak ${maintenancePeakBytes} bytes exceeds its ${policy.maxStoreBytes}-byte store cap`
    );
  }
  const emergencyEntryAccounting = accounting?.schemaVersion === "zts.apply-store-accounting.provisional-4"
    || (accounting?.schemaVersion === "zts.apply-store-accounting.provisional-5"
      && accounting.baselineEntries > APPLY_STORE_MAX_ENTRIES);
  const maintenanceEntryCap = emergencyEntryAccounting
    ? policy.maxInventoryEntries
    : APPLY_STORE_MAX_ENTRIES;
  if (action === "plan" && blockers.length === 0 && maintenancePeakEntries > maintenanceEntryCap) {
    blockers.push(
      `Apply retention target-generation peak ${maintenancePeakEntries} entries exceeds its bounded ${maintenanceEntryCap}-entry maintenance cap`
    );
  }
  const summaryCountBefore = manifest?.sourceSummaryCount ?? sourceScan.summaryCount;
  const summaryCountAfter = manifest?.targetSummaryCount ?? targetSummaries.length;
  const fullBefore = manifest?.sourceFullReceiptCount ?? sourceScan.fullReceiptCount;
  const fullAfter = manifest?.targetFullReceiptCount ?? calculatedFullAfter;
  const sourceNodeDigests = new Set(await readApplyReceiptHistoryNodeDigests(layout, profileId) ?? []);
  const previewGc = action === "plan" && blockers.length === 0
    ? await createDeletionTargets(
        layout,
        sourceScan.receiptIds,
        targetSummaries,
        validatedFullReceiptIds,
        inventory,
        new Set(),
        policy.maxInventoryEntries
      )
    : [];
  const targetPlanRevision = action === "plan" && blockers.length === 0
    ? sha256Canonical({
        sourceHead: head,
        sourceNodeDigests: [...sourceNodeDigests],
        targetSummaries,
        deletionTargets: previewGc
      })
    : sha256Canonical({
        action,
        sourceHeadRevision: head.revision,
        manifestRevision: manifest?.revision ?? null,
        publicationResidue: publicationResidues,
        uncommittedTemporary: uncommittedTemporaries
      });
  const manifestBytesUpperBound = projectedManifestBytes(
    head,
    [...sourceNodeDigests],
    targetSummaries.length,
    previewGc
  );
  if (action === "plan" && blockers.length === 0 && manifestBytesUpperBound > MANIFEST_MAX_BYTES) {
    blockers.push(
      `Apply retention exact manifest needs up to ${manifestBytesUpperBound} bytes, above its ${MANIFEST_MAX_BYTES}-byte bound`
    );
  }
  const inspectionBase = {
    profileId,
    policy,
    sourceHeadRevision: head.revision,
    action,
    maintenanceId,
    accountingBytes,
    accountingEntries,
    maintenancePeakBytes,
    maintenancePeakEntries,
    targetPlanRevision,
    publicationResidueCount: publicationResidues.length,
    uncommittedTemporaryCount: uncommittedTemporaries.length,
    summaryCountBefore,
    summaryCountAfter,
    fullReceiptCountBefore: fullBefore,
    fullReceiptCountAfter: fullAfter,
    archiveReceiptCount: manifest?.archivedReceiptCount ?? archiveReceiptCount,
    evictSummaryCount: manifest?.evictedSummaryCount ?? evictedCount,
    unfinishedTransactionCount: markers.length,
    reclaimableBytesLowerBound: manifest?.deletionTotals.bytes
      ?? previewGc.reduce((sum, target) => sum + target.bytes, 0),
    reclaimableFileCountLowerBound: manifest?.deletionTotals.files
      ?? previewGc.reduce((sum, target) => sum + target.files, 0),
    manifestBytesUpperBound,
    blockers
  } as const;
  const inspectionRevision = sha256Canonical({
    ...inspectionBase,
    manifestRevision: manifest?.revision ?? null,
    accountingRevision: accounting?.revision ?? null,
    inventoryRevision: inventoryRevision(inventory)
  });
  return {
    layout,
    head,
    sourceReceiptIds: sourceScan.receiptIds,
    sourceSummaryCount: sourceScan.summaryCount,
    targetSummaries,
    inventory,
    validatedFullReceiptIds,
    manifest,
    publicationResidues,
    uncommittedTemporaries,
    inspection: {
      schemaVersion: "zts.apply-retention-inspection.provisional-2",
      inspectedAt: now.toISOString(),
      inspectionRevision,
      ...inspectionBase
    }
  };
}

async function ensureCurrentAccountingForMaintenance(
  analysis: RetentionAnalysis,
  now: Date
): Promise<void> {
  const { layout, inspection } = analysis;
  const accounting = await readApplyStoreAccounting(layout, inspection.profileId);
  if (!accounting) {
    await initializeApplyStoreAccountingBaseline(
      layout,
      inspection.profileId,
      inspection.accountingBytes,
      inspection.accountingEntries,
      now
    );
  }
  const current = await readApplyStoreAccounting(layout, inspection.profileId);
  if (!current || current.schemaVersion !== "zts.apply-store-accounting.provisional-5") {
    throw new Error("Apply retention did not establish current entry-aware store accounting");
  }
}

async function beginRetentionMaintenance(
  analysis: RetentionAnalysis,
  maintenanceId: string,
  reservationBytes: number,
  reservationEntries: number,
  policy: ApplyRetentionPolicy,
  now: Date
): Promise<void> {
  const accounting = await readApplyStoreAccounting(
    analysis.layout,
    analysis.inspection.profileId
  );
  if (accounting?.schemaVersion === "zts.apply-store-accounting.provisional-4") {
    await beginLegacyApplyStoreMaintenance(
      analysis.layout,
      analysis.inspection.profileId,
      maintenanceId,
      analysis.inspection.accountingBytes,
      analysis.inspection.accountingEntries,
      reservationBytes,
      reservationEntries,
      analysis.head.revision,
      {
        maxStoreBytes: policy.maxStoreBytes,
        maxStoreEntries: policy.maxInventoryEntries,
        minimumFreeBytes: policy.minimumFreeBytes
      },
      now
    );
    return;
  }
  await ensureCurrentAccountingForMaintenance(analysis, now);
  await beginApplyStoreMaintenance(
    analysis.layout,
    analysis.inspection.profileId,
    maintenanceId,
    reservationBytes,
    reservationEntries,
    analysis.head.revision,
    {
      maxStoreBytes: policy.maxStoreBytes,
      maxStoreEntries: accounting?.baselineEntries !== undefined
        && accounting.baselineEntries > APPLY_STORE_MAX_ENTRIES
        ? policy.maxInventoryEntries
        : APPLY_STORE_MAX_ENTRIES,
      minimumFreeBytes: policy.minimumFreeBytes
    },
    now
  );
}

async function executeNewRetention(
  analysis: RetentionAnalysis,
  control: ApplyReceiptHistoryControl,
  policy: ApplyRetentionPolicy,
  now: Date,
  hooks?: ApplyRetentionHooks
): Promise<ApplyRetentionResult> {
  const { layout, inspection } = analysis;
  const maintenanceId = `retention:${randomUUID()}`;
  const reservationBytes = maintenanceReservationBytes(analysis.targetSummaries.length);
  const reservationEntries = maintenanceReservationEntries(analysis.targetSummaries.length);
  await beginRetentionMaintenance(
    analysis,
    maintenanceId,
    reservationBytes,
    reservationEntries,
    policy,
    now
  );
  await hooks?.afterMaintenanceGate?.();
  const generation = await buildApplyReceiptSummaryGeneration(
    layout,
    inspection.profileId,
    analysis.targetSummaries,
    control
  );
  await hooks?.afterGenerationBuilt?.();
  const inventory = await inventoryApplyStore(layout, policy.maxInventoryEntries, false);
  const targets = await createDeletionTargets(
    layout,
    analysis.sourceReceiptIds,
    analysis.targetSummaries,
    analysis.validatedFullReceiptIds,
    inventory,
    new Set(generation.nodeDigests),
    policy.maxInventoryEntries
  );
  if (targets.length > MAX_DELETION_TARGETS) {
    throw new Error(`Apply retention needs ${targets.length} deletion targets, above its ${MAX_DELETION_TARGETS}-target manifest bound`);
  }
  const sourceNodeDigests = [...(await readApplyReceiptHistoryNodeDigests(
    layout,
    inspection.profileId
  ) ?? [])];
  const exactTargetPlanRevision = sha256Canonical({
    sourceHead: analysis.head,
    sourceNodeDigests,
    targetSummaries: analysis.targetSummaries,
    deletionTargets: targets
  });
  if (exactTargetPlanRevision !== inspection.targetPlanRevision) {
    throw new Error("Apply retention target/GC graph Drifted after its reviewed inspection");
  }
  const manifest = createManifest(
    maintenanceId,
    inspection.profileId,
    analysis.head,
    generation,
    sourceNodeDigests,
    inspection,
    targets,
    now
  );
  await publishManifest(layout, manifest);
  await hooks?.afterManifest?.();
  await swapApplyReceiptHistoryHead(
    layout,
    inspection.profileId,
    analysis.head.revision,
    generation,
    control
  );
  await hooks?.afterHeadSwap?.();
  return finishManifest(layout, manifest, analysis.inspection, policy, now, hooks);
}

async function resumeManifestDeletions(
  analysis: RetentionAnalysis,
  policy: ApplyRetentionPolicy,
  now: Date,
  hooks?: ApplyRetentionHooks
): Promise<ApplyRetentionResult> {
  if (!analysis.manifest) throw new Error("Apply retention resume lacks its manifest");
  return finishManifest(analysis.layout, analysis.manifest, analysis.inspection, policy, now, hooks);
}

async function finishManifest(
  layout: ApplyArtifactLayout,
  manifest: ApplyRetentionManifest,
  inspection: ApplyRetentionInspection,
  policy: ApplyRetentionPolicy,
  now: Date,
  hooks?: ApplyRetentionHooks
): Promise<ApplyRetentionResult> {
  for (let index = 0; index < manifest.deletionTargets.length; index += 1) {
    await reconcileDeletionTarget(layout, manifest.deletionTargets[index]!, policy.maxInventoryEntries);
    await hooks?.afterDeletion?.(index);
  }
  const completedAt = now.toISOString();
  const durable = createDurableResult(manifest, "applied", completedAt);
  await replacePrivateJson(privatePath(layout.root, RESULT_FILENAME), durable);
  await removePrivateFile(privatePath(layout.root, MANIFEST_FILENAME));
  const exact = inventoryAccountingTotals(await inventoryApplyStore(
    layout,
    policy.maxInventoryEntries,
    false
  ));
  await completeApplyStoreMaintenance(
    layout,
    inspection.profileId,
    manifest.maintenanceId,
    exact.bytes,
    exact.entries,
    now
  );
  return resultFromDurable(inspection, manifest, durable);
}

async function discardPreparedGeneration(
  analysis: RetentionAnalysis,
  now: Date,
  policy: ApplyRetentionPolicy = analysis.inspection.policy
): Promise<ApplyRetentionResult> {
  const manifest = analysis.manifest;
  if (!manifest) throw new Error("Prepared Apply retention lacks its manifest");
  for (const digest of manifest.targetNodeDigests) {
    if (!await assertDiscardableTargetNode(analysis.layout, manifest, digest)) continue;
    try {
      await removePrivateFile(privatePath(analysis.layout.receiptHistory, `${digestHex(digest)}.node.json`));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  const durable = createDurableResult(manifest, "discarded", now.toISOString());
  await replacePrivateJson(privatePath(analysis.layout.root, RESULT_FILENAME), durable);
  await removePrivateFile(privatePath(analysis.layout.root, MANIFEST_FILENAME));
  const exact = inventoryAccountingTotals(await inventoryApplyStore(
    analysis.layout,
    policy.maxInventoryEntries,
    false
  ));
  await completeApplyStoreMaintenance(
    analysis.layout,
    analysis.inspection.profileId,
    manifest.maintenanceId,
    exact.bytes,
    exact.entries,
    now
  );
  return resultFromDurable(analysis.inspection, manifest, durable);
}

async function clearOrphanAccounting(
  analysis: RetentionAnalysis,
  now: Date
): Promise<ApplyRetentionResult> {
  const exact = inventoryAccountingTotals(await inventoryApplyStore(
    analysis.layout,
    analysis.inspection.policy.maxInventoryEntries,
    false
  ));
  const accounting = await readApplyStoreAccounting(analysis.layout, analysis.inspection.profileId);
  if (!accounting) {
    await initializeApplyStoreAccountingBaseline(
      analysis.layout,
      analysis.inspection.profileId,
      exact.bytes,
      exact.entries,
      now
    );
  } else if (analysis.inspection.action === "clear_orphan_reservation") {
    await clearOrphanApplyStoreReservation(
      analysis.layout,
      analysis.inspection.profileId,
      analysis.inspection.maintenanceId!,
      exact.bytes,
      exact.entries,
      now
    );
  } else {
    if (accounting.maintenanceSourceHeadRevision !== analysis.head.revision) {
      const result = await readDurableResult(analysis.layout, analysis.inspection.profileId);
      if (!result
        || result.maintenanceId !== accounting.maintenanceId
        || result.targetHeadRevision !== analysis.head.revision) {
        throw new Error("Apply orphan maintenance gate cannot prove whether its ready-head swap committed");
      }
    }
    await completeApplyStoreMaintenance(
      analysis.layout,
      analysis.inspection.profileId,
      accounting.maintenanceId!,
      exact.bytes,
      exact.entries,
      now
    );
  }
  return {
    inspection: analysis.inspection,
    maintenanceId: analysis.inspection.maintenanceId ?? `retention:${randomUUID()}`,
    outcome: "discarded",
    summaryCount: analysis.sourceSummaryCount,
    archivedReceiptCount: 0,
    evictedSummaryCount: 0,
    removedBytes: 0,
    removedFiles: 0,
    removedTransactionDirectories: 0,
    completedAt: now.toISOString()
  };
}

async function reconcilePublicationResidues(
  analysis: RetentionAnalysis,
  policy: ApplyRetentionPolicy,
  now: Date
): Promise<ApplyRetentionResult> {
  if (analysis.publicationResidues.length === 0 && analysis.uncommittedTemporaries.length === 0) {
    throw new Error("Apply private-residue repair has no exact inspected residue");
  }
  const maintenanceId = `retention:${randomUUID()}`;
  await beginRetentionMaintenance(
    analysis,
    maintenanceId,
    maintenanceReservationBytes(0),
    maintenanceReservationEntries(0),
    policy,
    now
  );
  await reconcileExactPublicationResidues(analysis.publicationResidues);
  await reconcileExactStandaloneTemporaries(analysis.uncommittedTemporaries);
  const exact = inventoryAccountingTotals(await inventoryApplyStore(
    analysis.layout,
    policy.maxInventoryEntries,
    false
  ));
  await completeApplyStoreMaintenance(
    analysis.layout,
    analysis.inspection.profileId,
    maintenanceId,
    exact.bytes,
    exact.entries,
    now
  );
  return {
    inspection: analysis.inspection,
    maintenanceId,
    outcome: "discarded",
    summaryCount: analysis.sourceSummaryCount,
    archivedReceiptCount: 0,
    evictedSummaryCount: 0,
    removedBytes: 0,
    removedFiles: 0,
    removedTransactionDirectories: 0,
    completedAt: now.toISOString()
  };
}

async function reconcileExactStandaloneTemporaries(
  residues: readonly PrivateStandaloneTemporaryCandidate[]
): Promise<void> {
  for (const residue of residues) {
    await removePrivateStandaloneTemporaryCandidate(residue);
  }
}

async function reconcileExactPublicationResidues(
  residues: readonly PublicationResidue[]
): Promise<void> {
  for (const residue of residues) {
    const canonical = await lstat(residue.canonicalPath);
    const temporary = await lstat(residue.temporaryPath);
    if (canonical.dev !== residue.device || canonical.ino !== residue.inode
      || temporary.dev !== residue.device || temporary.ino !== residue.inode) {
      throw new Error("Apply publication residue Drifted before exact reconciliation");
    }
    if (!await reconcilePrivatePublication(residue.canonicalPath)) {
      throw new Error("Apply publication residue disappeared before exact reconciliation");
    }
  }
}

async function createDeletionTargets(
  layout: ApplyArtifactLayout,
  sourceReceiptIds: readonly string[],
  targetSummaries: readonly ApplyReceiptSummary[],
  validatedFullReceiptIds: ReadonlySet<string>,
  inventory: readonly InventoryEntry[],
  targetNodeDigests: ReadonlySet<Sha256Digest>,
  maxInventoryEntries: number
): Promise<DeletionTarget[]> {
  const reachable = await collectReachableTargetPaths(
    layout,
    targetSummaries,
    validatedFullReceiptIds,
    inventory
  );
  const sourceSegments = new Set(sourceReceiptIds.map((receiptId) =>
    safeArtifactSegment(transactionIdFromReceiptId(receiptId))
  ));
  const targetAvailableSegments = new Set(targetSummaries
    .filter((summary) => summary.fullReceiptAvailability === "available")
    .map((summary) => safeArtifactSegment(transactionIdFromReceiptId(summary.id))));
  const directoryTargets: DeletionTarget[] = [];
  for (const entry of inventory) {
    if (entry.kind !== "directory"
      || !entry.relativePath.startsWith(`transactions${sep}`)
      || entry.relativePath.slice(`transactions${sep}`.length).includes(sep)) continue;
    const segment = entry.relativePath.slice(`transactions${sep}`.length);
    if (!sourceSegments.has(segment)) throw new Error(`Apply transaction directory has no ready-history owner: ${segment}`);
    if (targetAvailableSegments.has(segment)) continue;
    directoryTargets.push(await directoryDeletionTarget(layout, entry, maxInventoryEntries));
  }
  const directoryRoots = directoryTargets.map((target) => privatePath(layout.root, ...target.relativePath.split(sep)));
  const contentRoots = [
    layout.consents, layout.authorizations, layout.backups, layout.backupManifests,
    layout.preparedImages, layout.recoveries, layout.inverses, layout.journals,
    layout.controls, layout.receipts
  ];
  const fileTargets: DeletionTarget[] = [];
  for (const entry of inventory) {
    if (entry.kind !== "file" || reachable.has(entry.path)) continue;
    if (directoryRoots.some((root) => isInside(entry.path, root))) continue;
    const historyNode = isInside(entry.path, layout.receiptHistory)
      && /[a-f0-9]{64}\.node\.json$/u.test(entry.relativePath);
    if (historyNode) {
      const digest = `sha256:${entry.relativePath.match(/([a-f0-9]{64})\.node\.json$/u)![1]}` as Sha256Digest;
      if (targetNodeDigests.has(digest)) continue;
    }
    const content = contentRoots.some((root) => isInside(entry.path, root));
    if (!content && !historyNode) continue;
    fileTargets.push(fileDeletionTarget(entry));
  }
  return [...directoryTargets, ...fileTargets]
    .sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

async function collectReachableTargetPaths(
  layout: ApplyArtifactLayout,
  targetSummaries: readonly ApplyReceiptSummary[],
  validatedFullReceiptIds: ReadonlySet<string>,
  inventory: readonly InventoryEntry[]
): Promise<ReadonlySet<string>> {
  const byPath = new Map(inventory.map((entry) => [entry.path, entry]));
  const reachable = new Set<string>();
  let followedReferences = 0;
  const visitJson = async (path: string, reference: ArtifactReference, depth = 0): Promise<void> => {
    if (reachable.has(path)) return;
    if (depth > MAX_REACHABILITY_DEPTH) throw new Error("Apply Receipt reachability exceeds its depth bound");
    followedReferences += 1;
    if (followedReferences > MAX_REACHABILITY_REFERENCES) {
      throw new Error("Apply Receipt reachability exceeds its reference bound");
    }
    const entry = byPath.get(path);
    if (!entry || entry.kind !== "file") throw new Error(`Reachable Apply artifact is missing: ${reference.id}`);
    const value = await readPrivateJson(path, artifactReadLimit(reference));
    await validateReferencedJson(layout, reference, value);
    reachable.add(path);
    for (const nested of artifactReferences(reference, value)) {
      const nestedPath = artifactPathForReference(layout, nested, byPath);
      if (nestedPath.endsWith(".json")) await visitJson(nestedPath, nested, depth + 1);
      else {
        await validateReferencedBytes(nestedPath, nested, artifactReadLimit(nested));
        reachable.add(nestedPath);
      }
    }
  };
  for (const summary of targetSummaries) {
    if (summary.fullReceiptAvailability !== "available") continue;
    if (!validatedFullReceiptIds.has(summary.id)) {
      throw new Error(`Validated full Receipt is missing: ${summary.id}`);
    }
    await visitJson(
      artifactObjectPath(layout.receipts, summary.receiptDigest),
      { id: summary.id, digest: summary.receiptDigest }
    );
    const transactionRoot = privatePath(
      layout.transactions,
      safeArtifactSegment(transactionIdFromReceiptId(summary.id))
    );
    for (const entry of inventory) {
      if (entry.kind === "file" && isInside(entry.path, transactionRoot)) reachable.add(entry.path);
    }
  }
  return reachable;
}

function createManifest(
  maintenanceId: string,
  profileId: string,
  sourceHead: ApplyReceiptHistoryHead,
  target: ApplyReceiptHistoryGeneration,
  sourceNodeDigests: readonly Sha256Digest[],
  inspection: ApplyRetentionInspection,
  targets: readonly DeletionTarget[],
  now: Date
): ApplyRetentionManifest {
  const content = {
    schemaVersion: MANIFEST_SCHEMA,
    maintenanceId,
    profileId,
    sourceHead,
    sourceNodeDigests,
    targetHead: target.head,
    targetNodeDigests: target.nodeDigests,
    sourceSummaryCount: inspection.summaryCountBefore,
    targetSummaryCount: inspection.summaryCountAfter,
    sourceFullReceiptCount: inspection.fullReceiptCountBefore,
    targetFullReceiptCount: inspection.fullReceiptCountAfter,
    archivedReceiptCount: inspection.archiveReceiptCount,
    evictedSummaryCount: inspection.evictSummaryCount,
    createdAt: now.toISOString(),
    deletionTargets: targets,
    deletionTotals: {
      bytes: targets.reduce((sum, targetEntry) => sum + targetEntry.bytes, 0),
      files: targets.reduce((sum, targetEntry) => sum + targetEntry.files, 0),
      transactionDirectories: targets.filter((targetEntry) =>
        targetEntry.identity.kind === "transaction_directory"
      ).length
    }
  } as const;
  return { ...content, revision: sha256Canonical(content) };
}

async function publishManifest(layout: ApplyArtifactLayout, manifest: ApplyRetentionManifest): Promise<void> {
  const targets = manifest.deletionTargets.map(defineDeletionTarget);
  validateManifestRelationships(manifest, targets);
  await validateManifestTargetGeneration(layout, manifest, false);
  const bytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  if (bytes.byteLength > MANIFEST_MAX_BYTES) throw new Error("Apply retention manifest exceeds its bounded size");
  await publishPrivateBytes(privatePath(layout.root, MANIFEST_FILENAME), bytes, MANIFEST_MAX_BYTES);
}

async function readManifest(
  layout: ApplyArtifactLayout,
  profileId: string
): Promise<ApplyRetentionManifest | null> {
  let value: unknown;
  try {
    value = await readPrivateJson(privatePath(layout.root, MANIFEST_FILENAME), MANIFEST_MAX_BYTES);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Apply retention manifest must be an object");
  const manifest = value as ApplyRetentionManifest;
  assertKeys(manifest as unknown as Record<string, unknown>, [
    "schemaVersion", "maintenanceId", "profileId", "sourceHead", "sourceNodeDigests", "targetHead",
    "targetNodeDigests", "sourceSummaryCount", "targetSummaryCount",
    "sourceFullReceiptCount", "targetFullReceiptCount",
    "archivedReceiptCount", "evictedSummaryCount", "createdAt", "deletionTargets",
    "deletionTotals", "revision"
  ], "Apply retention manifest");
  if (manifest.schemaVersion !== MANIFEST_SCHEMA
    || !/^retention:[0-9a-f-]{36}$/u.test(manifest.maintenanceId)
    || manifest.profileId !== profileId
    || !isTimestamp(manifest.createdAt)
    || !Array.isArray(manifest.sourceNodeDigests)
    || manifest.sourceNodeDigests.some((digest) => !isDigest(digest))
    || !Array.isArray(manifest.targetNodeDigests)
    || manifest.targetNodeDigests.some((digest) => !isDigest(digest))
    || !Array.isArray(manifest.deletionTargets)
    || manifest.deletionTargets.length > MAX_DELETION_TARGETS
    || !isDigest(manifest.revision)) {
    throw new Error("Apply retention manifest identity is invalid");
  }
  defineApplyReceiptHistoryHead(manifest.sourceHead, profileId);
  defineApplyReceiptHistoryHead(manifest.targetHead, profileId);
  const { revision: _revision, ...content } = manifest;
  if (sha256Canonical(content) !== manifest.revision) throw new Error("Apply retention manifest revision is invalid");
  const targets = manifest.deletionTargets.map(defineDeletionTarget);
  if (!manifest.deletionTotals || typeof manifest.deletionTotals !== "object"
    || Array.isArray(manifest.deletionTotals)) {
    throw new Error("Apply retention manifest deletion totals are invalid");
  }
  assertKeys(manifest.deletionTotals as unknown as Record<string, unknown>, [
    "bytes", "files", "transactionDirectories"
  ], "Apply retention manifest deletion totals");
  if (!safeNonNegative(manifest.deletionTotals.bytes)
    || !safeNonNegative(manifest.deletionTotals.files)
    || !safeNonNegative(manifest.deletionTotals.transactionDirectories)) {
    throw new Error("Apply retention manifest deletion totals are invalid");
  }
  const totals = {
    bytes: targets.reduce((sum, target) => sum + target.bytes, 0),
    files: targets.reduce((sum, target) => sum + target.files, 0),
    transactionDirectories: targets.filter((target) => target.identity.kind === "transaction_directory").length
  };
  if (sha256Canonical(totals) !== sha256Canonical(manifest.deletionTotals)) {
    throw new Error("Apply retention manifest deletion totals are invalid");
  }
  validateManifestRelationships(manifest, targets);
  const currentHead = await readApplyReceiptHistoryHead(layout, profileId);
  if (currentHead?.revision === manifest.sourceHead.revision) {
    const currentSourceDigests = await readApplyReceiptHistoryNodeDigests(layout, profileId);
    if (!currentSourceDigests
      || sha256Canonical(currentSourceDigests) !== sha256Canonical(manifest.sourceNodeDigests)) {
      throw new Error("Apply retention manifest source chain does not match the canonical ready history");
    }
  }
  const targetSummaries = await validateManifestTargetGeneration(
    layout,
    manifest,
    currentHead?.revision === manifest.sourceHead.revision
  );
  if (currentHead?.revision === manifest.targetHead.revision) {
    await validateManifestDeletionSafety(layout, manifest, targetSummaries);
  }
  return manifest;
}

function validateManifestRelationships(
  manifest: ApplyRetentionManifest,
  targets: readonly DeletionTarget[]
): void {
  const removedFullReceiptCount = manifest.sourceFullReceiptCount - manifest.targetFullReceiptCount;
  if (!Number.isSafeInteger(manifest.sourceSummaryCount) || manifest.sourceSummaryCount < 0
    || !Number.isSafeInteger(manifest.targetSummaryCount) || manifest.targetSummaryCount < 0
    || !Number.isSafeInteger(manifest.sourceFullReceiptCount) || manifest.sourceFullReceiptCount < 0
    || !Number.isSafeInteger(manifest.targetFullReceiptCount) || manifest.targetFullReceiptCount < 0
    || !Number.isSafeInteger(manifest.archivedReceiptCount) || manifest.archivedReceiptCount < 0
    || !Number.isSafeInteger(manifest.evictedSummaryCount) || manifest.evictedSummaryCount < 0
    || manifest.sourceSummaryCount !== manifest.sourceHead.entryCount
    || manifest.targetSummaryCount !== manifest.targetHead.entryCount
    || manifest.evictedSummaryCount !== manifest.sourceSummaryCount - manifest.targetSummaryCount
    || manifest.sourceFullReceiptCount > manifest.sourceSummaryCount
    || manifest.targetFullReceiptCount > manifest.targetSummaryCount
    || removedFullReceiptCount < 0
    || manifest.archivedReceiptCount > removedFullReceiptCount
    || removedFullReceiptCount - manifest.archivedReceiptCount > manifest.evictedSummaryCount
    || manifest.archivedReceiptCount > manifest.targetSummaryCount
    || manifest.sourceNodeDigests.length !== manifest.sourceHead.entryCount
    || manifest.targetNodeDigests.length !== manifest.targetHead.entryCount
    || manifest.sourceHead.latestNodeDigest !== (manifest.sourceNodeDigests.at(-1) ?? null)
    || manifest.targetHead.latestNodeDigest !== (manifest.targetNodeDigests.at(-1) ?? null)
    || manifest.sourceHead.generationId === manifest.targetHead.generationId
    || manifest.sourceHead.revision === manifest.targetHead.revision) {
    throw new Error("Apply retention manifest source/target relationship is invalid");
  }
  const source = new Set(manifest.sourceNodeDigests);
  const target = new Set(manifest.targetNodeDigests);
  if (source.size !== manifest.sourceNodeDigests.length
    || target.size !== manifest.targetNodeDigests.length
    || [...target].some((digest) => source.has(digest))) {
    throw new Error("Apply retention source and target generations are not disjoint immutable chains");
  }
  const paths = new Set<string>();
  const orderedPaths = targets.map((targetEntry) => targetEntry.relativePath).sort();
  for (let index = 1; index < orderedPaths.length; index += 1) {
    if (orderedPaths[index]!.startsWith(`${orderedPaths[index - 1]!}${sep}`)) {
      throw new Error("Apply retention manifest contains overlapping deletion targets");
    }
  }
  for (const deletion of targets) {
    if (paths.has(deletion.relativePath)) throw new Error("Apply retention manifest repeats a deletion path");
    paths.add(deletion.relativePath);
    if (deletion.identity.kind === "transaction_directory") {
      const prefix = `transactions${sep}`;
      if (!deletion.relativePath.startsWith(prefix)
        || deletion.relativePath.slice(prefix.length).includes(sep)) {
        throw new Error("Apply retention manifest names an unsafe transaction directory");
      }
    }
    const historyMatch = new RegExp(`^receipt-history\\${sep}([a-f0-9]{64})\\.node\\.json$`, "u")
      .exec(deletion.relativePath);
    if (historyMatch) {
      const digest = `sha256:${historyMatch[1]}` as Sha256Digest;
      if (!source.has(digest) || target.has(digest)) {
        throw new Error("Apply retention manifest names a non-source history node for deletion");
      }
    }
  }
}

async function validateManifestTargetGeneration(
  layout: ApplyArtifactLayout,
  manifest: ApplyRetentionManifest,
  allowMissing: boolean
): Promise<readonly ApplyReceiptSummary[]> {
  let previous: Sha256Digest | null = null;
  const summaries: ApplyReceiptSummary[] = [];
  for (let index = 0; index < manifest.targetNodeDigests.length; index += 1) {
    const digest = manifest.targetNodeDigests[index]!;
    let value: unknown;
    try {
      value = await readPrivateJson(
        privatePath(layout.receiptHistory, `${digestHex(digest)}.node.json`),
        HISTORY_NODE_MAX_BYTES
      );
    } catch (error) {
      if (allowMissing && (error as NodeJS.ErrnoException).code === "ENOENT") {
        previous = digest;
        continue;
      }
      throw error;
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("Apply retention target history node must be an object");
    }
    const node = value as Record<string, unknown>;
    assertKeys(node, [
      "schemaVersion", "profileId", "generationId", "sequence", "previousNodeDigest", "entry"
    ], "Apply retention target history node");
    if (node.schemaVersion !== "zts.apply-receipt-history-node.provisional-4"
      || node.profileId !== manifest.profileId
      || node.generationId !== manifest.targetHead.generationId
      || node.sequence !== index + 1
      || node.previousNodeDigest !== previous
      || sha256Canonical(node) !== digest) {
      throw new Error("Apply retention target history node identity is invalid");
    }
    summaries.push(defineApplyReceiptSummary(node.entry as ApplyReceiptSummary, manifest.profileId));
    previous = digest;
  }
  return summaries;
}

async function validateManifestDeletionSafety(
  layout: ApplyArtifactLayout,
  manifest: ApplyRetentionManifest,
  targetSummaries: readonly ApplyReceiptSummary[]
): Promise<void> {
  const inventory = await inventoryApplyStore(layout, 1_000_000, true);
  const validatedFullReceiptIds = new Set<string>();
  for (const summary of targetSummaries) {
    if (summary.fullReceiptAvailability !== "available") continue;
    await validateTransactionReceiptSummaryForRetention(manifest.profileId, summary);
    validatedFullReceiptIds.add(summary.id);
  }
  const reachable = await collectReachableTargetPaths(
    layout,
    targetSummaries,
    validatedFullReceiptIds,
    inventory
  );
  const availableTransactionRoots = targetSummaries
    .filter((summary) => summary.fullReceiptAvailability === "available")
    .map((summary) => privatePath(
      layout.transactions,
      safeArtifactSegment(transactionIdFromReceiptId(summary.id))
    ));
  for (const deletion of manifest.deletionTargets) {
    const path = pathFromRelative(layout, deletion.relativePath);
    if (reachable.has(path)
      || availableTransactionRoots.some((root) => path === root || isInside(path, root))) {
      throw new Error("Apply retention manifest would delete target-generation reachable state");
    }
  }
}

async function assertDiscardableTargetNode(
  layout: ApplyArtifactLayout,
  manifest: ApplyRetentionManifest,
  digest: Sha256Digest
): Promise<boolean> {
  if (!manifest.targetNodeDigests.includes(digest) || manifest.sourceNodeDigests.includes(digest)) {
    throw new Error("Apply retention refuses to discard a canonical source history node");
  }
  let value: unknown;
  try {
    value = await readPrivateJson(
      privatePath(layout.receiptHistory, `${digestHex(digest)}.node.json`),
      HISTORY_NODE_MAX_BYTES
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)
    || (value as Record<string, unknown>).generationId !== manifest.targetHead.generationId
    || sha256Canonical(value) !== digest) {
    throw new Error("Apply retention prepared target node no longer matches its manifest");
  }
  return true;
}

async function readDurableResult(
  layout: ApplyArtifactLayout,
  profileId: string
): Promise<ApplyRetentionDurableResult | null> {
  let value: unknown;
  try {
    value = await readPrivateJson(privatePath(layout.root, RESULT_FILENAME), RESULT_MAX_BYTES);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Apply retention durable result must be an object");
  }
  const result = value as ApplyRetentionDurableResult;
  assertKeys(result as unknown as Record<string, unknown>, [
    "schemaVersion", "maintenanceId", "profileId", "outcome", "sourceHeadRevision",
    "targetHeadRevision", "removedBytes", "removedFiles", "removedTransactionDirectories",
    "completedAt", "revision"
  ], "Apply retention durable result");
  if (result.schemaVersion !== RESULT_SCHEMA
    || !/^retention:[0-9a-f-]{36}$/u.test(result.maintenanceId)
    || result.profileId !== profileId
    || !["applied", "discarded"].includes(result.outcome)
    || !isDigest(result.sourceHeadRevision)
    || !isDigest(result.targetHeadRevision)
    || !safeNonNegative(result.removedBytes)
    || !safeNonNegative(result.removedFiles)
    || !safeNonNegative(result.removedTransactionDirectories)
    || !isTimestamp(result.completedAt)
    || !isDigest(result.revision)) {
    throw new Error("Apply retention durable result identity is invalid");
  }
  const { revision: _revision, ...content } = result;
  if (sha256Canonical(content) !== result.revision) throw new Error("Apply retention durable result revision is invalid");
  return result;
}

async function reconcileDeletionTarget(
  layout: ApplyArtifactLayout,
  target: DeletionTarget,
  maxEntries: number
): Promise<void> {
  const path = pathFromRelative(layout, target.relativePath);
  let metadata;
  try {
    metadata = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (target.identity.kind === "file") {
    if (!metadata.isFile()
      || metadata.isSymbolicLink()
      || metadata.dev !== target.identity.device
      || metadata.ino !== target.identity.inode
      || metadata.size !== target.identity.size
      || (metadata.mode & 0o777) !== target.identity.mode
      || metadata.mtimeMs !== target.identity.modifiedMs
      || metadata.ctimeMs !== target.identity.changedMs) {
      throw new Error(`Apply retention file target Drifted: ${target.relativePath}`);
    }
    await removePrivateFile(path);
    return;
  }
  const entry: InventoryEntry = {
    path,
    relativePath: target.relativePath,
    kind: "directory",
    size: 0,
    device: metadata.dev,
    inode: metadata.ino,
    mode: metadata.mode & 0o777,
    modifiedMs: metadata.mtimeMs,
    changedMs: metadata.ctimeMs,
    linkCount: metadata.nlink
  };
  const current = await directoryDeletionTarget(layout, entry, maxEntries);
  if (current.identity.kind !== "transaction_directory"
    || !isSafeRemainingTransactionTree(target.identity, current.identity)) {
    throw new Error(`Apply retention directory target Drifted: ${target.relativePath}`);
  }
  const prefix = `transactions${sep}`;
  if (!target.relativePath.startsWith(prefix)) throw new Error("Apply retention only removes transaction subtrees");
  await removePrivateDirectoryTree(
    layout.transactions,
    target.relativePath.slice(prefix.length),
    maxEntries
  );
}

function findPublicationResidues(inventory: readonly InventoryEntry[]): readonly PublicationResidue[] {
  const linked = inventory.filter((entry) => entry.kind === "file" && entry.linkCount === 2);
  const handled = new Set<string>();
  const residues: PublicationResidue[] = [];
  for (const entry of linked) {
    if (handled.has(entry.path)) continue;
    const siblings = linked.filter((candidate) =>
      candidate.device === entry.device && candidate.inode === entry.inode
    );
    const canonical = siblings.find((candidate) =>
      !isPrivateTemporaryBasename(basename(candidate.path))
    );
    const temporary = siblings.find((candidate) =>
      isPrivateTemporaryBasename(basename(candidate.path))
    );
    if (!canonical || !temporary || siblings.length !== 2) {
      throw new Error(`Apply store hardlink residue is not one proof-bound canonical/temp pair: ${entry.relativePath}`);
    }
    residues.push({
      canonicalPath: canonical.path,
      temporaryPath: temporary.path,
      device: entry.device,
      inode: entry.inode
    });
    handled.add(canonical.path);
    handled.add(temporary.path);
  }
  return residues.sort((left, right) => left.canonicalPath.localeCompare(right.canonicalPath));
}

async function findStandaloneTemporaryCandidates(
  inventory: readonly InventoryEntry[]
): Promise<readonly PrivateStandaloneTemporaryCandidate[]> {
  const candidates: PrivateStandaloneTemporaryCandidate[] = [];
  for (const entry of inventory) {
    if (entry.kind !== "file" || entry.linkCount !== 1
      || !isPrivateTemporaryBasename(basename(entry.path))) continue;
    const candidate = await inspectPrivateStandaloneTemporaryCandidate(
      entry.path,
      APPLY_STORE_MAX_BYTES
    );
    if (candidate.device !== entry.device
      || candidate.inode !== entry.inode
      || candidate.size !== entry.size
      || candidate.mode !== entry.mode
      || candidate.modifiedMs !== entry.modifiedMs
      || candidate.changedMs !== entry.changedMs) {
      throw new Error(`Apply standalone temporary Drifted after inventory: ${entry.relativePath}`);
    }
    candidates.push(candidate);
  }
  return candidates.sort((left, right) => left.path.localeCompare(right.path));
}

async function inventoryApplyStore(
  layout: ApplyArtifactLayout,
  maxEntries: number,
  allowPublicationResidue: boolean
): Promise<readonly InventoryEntry[]> {
  const result: InventoryEntry[] = [];
  const visit = async (path: string, depth: number): Promise<void> => {
    if (depth > 64) throw new Error("Apply store exceeds the traversal depth bound");
    for (const entry of (await readdir(path, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (result.length >= maxEntries) throw new Error(`Apply store exceeds the ${maxEntries}-entry inventory bound`);
      const candidate = privatePath(path, entry.name);
      const metadata = await lstat(candidate);
      if (metadata.isSymbolicLink()) throw new Error(`Apply store contains a symbolic link: ${candidate}`);
      if (typeof process.getuid === "function" && metadata.uid !== process.getuid()) throw new Error(`Apply store entry has another owner: ${candidate}`);
      if ((metadata.mode & 0o077) !== 0) throw new Error(`Apply store entry is not owner-private: ${candidate}`);
      if (!metadata.isFile() && !metadata.isDirectory()) throw new Error(`Apply store contains an unsupported entry: ${candidate}`);
      if (metadata.isFile() && entry.name.startsWith(".tmp-")
        && !isPrivateTemporaryBasename(entry.name)) {
        throw new Error(`Apply store contains an unsafe private temporary name: ${candidate}`);
      }
      if (metadata.isFile() && metadata.nlink !== 1 && !(allowPublicationResidue && metadata.nlink === 2)) {
        throw new Error(`Apply store file has an invalid hardlink count: ${candidate}`);
      }
      const item = {
        path: candidate,
        relativePath: relative(layout.root, candidate),
        kind: metadata.isDirectory() ? "directory" as const : "file" as const,
        size: metadata.isFile() ? metadata.size : 0,
        device: metadata.dev,
        inode: metadata.ino,
        mode: metadata.mode & 0o777,
        modifiedMs: metadata.mtimeMs,
        changedMs: metadata.ctimeMs,
        linkCount: metadata.nlink
      };
      result.push(item);
      if (item.kind === "directory") await visit(candidate, depth + 1);
    }
  };
  await visit(layout.root, 0);
  return result;
}

async function directoryDeletionTarget(
  layout: ApplyArtifactLayout,
  root: InventoryEntry,
  maxEntries: number
): Promise<DeletionTarget> {
  const prefix = `transactions${sep}`;
  if (!root.relativePath.startsWith(prefix)) {
    throw new Error("Apply retention only fingerprints transaction subtrees");
  }
  const transactionSegment = root.relativePath.slice(prefix.length);
  if (transactionSegment.length === 0 || transactionSegment.includes(sep)
    || root.path !== privatePath(layout.transactions, transactionSegment)) {
    throw new Error("Apply retention transaction subtree is not one canonical direct child");
  }
  const records: TreeEntryIdentity[] = [];
  let bytes = 0;
  let files = 0;
  let entries = 0;
  const visit = async (path: string): Promise<void> => {
    for (const entry of (await readdir(path, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      entries += 1;
      if (entries > maxEntries) throw new Error(`Transaction subtree exceeds the ${maxEntries}-entry fingerprint bound`);
      const candidate = privatePath(path, entry.name);
      const metadata = await lstat(candidate);
      if (metadata.isSymbolicLink() || (!metadata.isFile() && !metadata.isDirectory())) {
        throw new Error(`Transaction subtree contains an unsafe entry: ${candidate}`);
      }
      if (typeof process.getuid === "function" && metadata.uid !== process.getuid()) {
        throw new Error(`Transaction subtree entry has another owner: ${candidate}`);
      }
      if ((metadata.mode & 0o077) !== 0 || (metadata.isFile() && metadata.nlink !== 1)) {
        throw new Error(`Transaction subtree entry is not one owner-private path: ${candidate}`);
      }
      const record: TreeEntryIdentity = {
        path: relative(root.path, candidate),
        kind: metadata.isDirectory() ? "directory" : "file",
        device: metadata.dev,
        inode: metadata.ino,
        size: metadata.size,
        mode: metadata.mode & 0o777,
        modifiedMs: metadata.mtimeMs,
        changedMs: metadata.ctimeMs
      };
      records.push(record);
      if (metadata.isDirectory()) await visit(candidate);
      else {
        bytes += metadata.size;
        files += 1;
      }
    }
  };
  await visit(root.path);
  return {
    relativePath: root.relativePath,
    bytes,
    files,
    identity: {
      kind: "transaction_directory",
      device: root.device,
      inode: root.inode,
      mode: root.mode,
      modifiedMs: root.modifiedMs,
      changedMs: root.changedMs,
      treeRevision: sha256Canonical(records),
      totalBytes: bytes,
      fileCount: files,
      entryCount: entries,
      treeEntries: records
    }
  };
}

function defineTreeEntryIdentity(value: TreeEntryIdentity): TreeEntryIdentity {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Apply retention transaction tree entry is invalid");
  }
  assertKeys(value as unknown as Record<string, unknown>, [
    "path", "kind", "device", "inode", "size", "mode", "modifiedMs", "changedMs"
  ], "Apply retention transaction tree entry");
  const segments = typeof value.path === "string" ? value.path.split(sep) : [];
  if (segments.length < 1
    || segments.some((segment) => !segment || segment === "." || segment === ".."
      || !/^[A-Za-z0-9._-]+$/u.test(segment))
    || !["file", "directory"].includes(value.kind)
    || !safeNonNegative(value.device)
    || !safeNonNegative(value.inode)
    || !safeNonNegative(value.size)
    || !Number.isSafeInteger(value.mode)
    || value.mode < 0
    || (value.mode & 0o077) !== 0
    || !finiteNonNegative(value.modifiedMs)
    || !finiteNonNegative(value.changedMs)) {
    throw new Error("Apply retention transaction tree entry identity is invalid");
  }
  return value;
}

function isSafeRemainingTransactionTree(
  expected: DirectoryIdentity,
  current: DirectoryIdentity
): boolean {
  if (current.device !== expected.device
    || current.inode !== expected.inode
    || current.mode !== expected.mode
    || current.totalBytes > expected.totalBytes
    || current.fileCount > expected.fileCount
    || current.entryCount > expected.entryCount) return false;
  const expectedByPath = new Map(expected.treeEntries.map((entry) => [entry.path, entry]));
  for (const entry of current.treeEntries) {
    const original = expectedByPath.get(entry.path);
    if (!original
      || original.kind !== entry.kind
      || original.device !== entry.device
      || original.inode !== entry.inode
      || original.mode !== entry.mode) return false;
    if (entry.kind === "file" && (
      original.size !== entry.size
      || original.modifiedMs !== entry.modifiedMs
      || original.changedMs !== entry.changedMs
    )) return false;
  }
  return true;
}

function fileDeletionTarget(entry: InventoryEntry): DeletionTarget {
  return {
    relativePath: entry.relativePath,
    bytes: entry.size,
    files: 1,
    identity: {
      kind: "file",
      device: entry.device,
      inode: entry.inode,
      size: entry.size,
      mode: entry.mode,
      modifiedMs: entry.modifiedMs,
      changedMs: entry.changedMs
    }
  };
}

function defineDeletionTarget(value: DeletionTarget): DeletionTarget {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Apply retention deletion target is invalid");
  }
  assertKeys(value as unknown as Record<string, unknown>, [
    "relativePath", "bytes", "files", "identity"
  ], "Apply retention deletion target");
  const segments = typeof value.relativePath === "string" ? value.relativePath.split(sep) : [];
  if (segments.length !== 2
    || segments.some((segment) => !segment || segment === "." || segment === ".."
      || !/^[A-Za-z0-9._-]+$/u.test(segment))
    || !safeNonNegative(value.bytes)
    || !safeNonNegative(value.files)
    || !value.identity
    || typeof value.identity !== "object"
    || Array.isArray(value.identity)) {
    throw new Error("Apply retention deletion target is invalid");
  }
  if (value.identity.kind === "file") {
    assertKeys(value.identity as unknown as Record<string, unknown>, [
      "kind", "device", "inode", "size", "mode", "modifiedMs", "changedMs"
    ], "Apply retention file identity");
    const allowed = /^(?:consents|authorizations|backup-manifests|recoveries|inverse-plans|journals|controls|receipts)\/[a-f0-9]{64}\.json$/u.test(value.relativePath)
      || /^(?:backups)\/[a-f0-9]{64}\.jsonlz4$/u.test(value.relativePath)
      || /^(?:prepared-images)\/[a-f0-9]{64}\.(?:jsonlz4|bin)$/u.test(value.relativePath)
      || /^receipt-history\/[a-f0-9]{64}\.node\.json$/u.test(value.relativePath);
    if (!allowed
      || !safeNonNegative(value.identity.device)
      || !safeNonNegative(value.identity.inode)
      || !safeNonNegative(value.identity.size)
      || value.identity.size !== value.bytes
      || value.files !== 1
      || !Number.isSafeInteger(value.identity.mode)
      || value.identity.mode < 0
      || (value.identity.mode & 0o077) !== 0
      || !finiteNonNegative(value.identity.modifiedMs)
      || !finiteNonNegative(value.identity.changedMs)) {
      throw new Error("Apply retention file deletion identity is invalid");
    }
  } else if (value.identity.kind === "transaction_directory") {
    assertKeys(value.identity as unknown as Record<string, unknown>, [
      "kind", "device", "inode", "mode", "modifiedMs", "changedMs",
      "treeRevision", "totalBytes", "fileCount", "entryCount", "treeEntries"
    ], "Apply retention transaction directory identity");
    if (segments[0] !== "transactions"
      || !isDigest(value.identity.treeRevision)
      || !safeNonNegative(value.identity.device)
      || !safeNonNegative(value.identity.inode)
      || !Number.isSafeInteger(value.identity.mode)
      || value.identity.mode < 0
      || (value.identity.mode & 0o077) !== 0
      || !finiteNonNegative(value.identity.modifiedMs)
      || !finiteNonNegative(value.identity.changedMs)
      || !safeNonNegative(value.identity.totalBytes)
      || !safeNonNegative(value.identity.fileCount)
      || !safeNonNegative(value.identity.entryCount)
      || !Array.isArray(value.identity.treeEntries)
      || value.identity.treeEntries.length !== value.identity.entryCount
      || value.identity.entryCount < value.identity.fileCount
      || value.identity.totalBytes !== value.bytes
      || value.identity.fileCount !== value.files) {
      throw new Error("Apply retention transaction directory deletion identity is invalid");
    }
    const entries = value.identity.treeEntries.map(defineTreeEntryIdentity);
    if (new Set(entries.map((entry) => entry.path)).size !== entries.length
      || sha256Canonical(entries) !== value.identity.treeRevision) {
      throw new Error("Apply retention transaction directory tree fingerprint is invalid");
    }
  } else {
    throw new Error("Apply retention deletion target kind is invalid");
  }
  return value;
}

async function validateReferencedJson(
  layout: ApplyArtifactLayout,
  reference: ArtifactReference,
  value: unknown
): Promise<void> {
  if (reference.id.startsWith("plan:")) {
    await loadInversePlan(layout, reference);
    return;
  }
  if (reference.id.startsWith("authorization:")) {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Referenced Authorization is invalid");
    const record = value as Record<string, unknown>;
    const { revision: _revision, ...draft } = record;
    if (record.revision !== reference.digest || sha256Canonical(draft) !== reference.digest) {
      throw new Error(`Referenced Authorization content is invalid: ${reference.id}`);
    }
    return;
  }
  if (reference.id.startsWith("journal:")) defineApplyJournal(value);
  if (!reference.id.startsWith("consent:")
    && !reference.id.startsWith("journal:")
    && !reference.id.startsWith("backup:")
    && !reference.id.startsWith("recovery:")
    && !reference.id.startsWith("control:")
    && !reference.id.startsWith("receipt:")) {
    throw new Error(`Unsupported referenced Apply JSON artifact: ${reference.id}`);
  }
  if (sha256Canonical(value) !== reference.digest) {
    throw new Error(`Referenced Apply artifact content does not match ${reference.id}`);
  }
}

async function validateReferencedBytes(
  path: string,
  reference: ArtifactReference,
  maxBytes: number
): Promise<void> {
  const bytes = await readPrivateBytes(path, maxBytes);
  const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}` as Sha256Digest;
  if (digest !== reference.digest) throw new Error(`Referenced Apply binary content does not match ${reference.id}`);
}

function artifactPathForReference(
  layout: ApplyArtifactLayout,
  reference: ArtifactReference,
  inventory: ReadonlyMap<string, InventoryEntry>
): string {
  const candidates: string[] = [];
  if (reference.id.startsWith("consent:")) candidates.push(artifactObjectPath(layout.consents, reference.digest));
  else if (reference.id.startsWith("authorization:")) candidates.push(artifactObjectPath(layout.authorizations, reference.digest));
  else if (reference.id.startsWith("backup-bytes:")) candidates.push(artifactObjectPath(layout.backups, reference.digest, "jsonlz4"));
  else if (reference.id.startsWith("backup:")) candidates.push(artifactObjectPath(layout.backupManifests, reference.digest));
  else if (reference.id.startsWith("prepared-image:")) candidates.push(artifactObjectPath(layout.preparedImages, reference.digest, "jsonlz4"));
  else if (reference.id.startsWith("displaced-writer:")) candidates.push(artifactObjectPath(layout.preparedImages, reference.digest, "jsonlz4"));
  else if (reference.id.startsWith("prepared-fragment:")) candidates.push(artifactObjectPath(layout.preparedImages, reference.digest, "bin"));
  else if (reference.id.startsWith("recovery:")) candidates.push(artifactObjectPath(layout.recoveries, reference.digest));
  else if (reference.id.startsWith("journal:")) candidates.push(artifactObjectPath(layout.journals, reference.digest));
  else if (reference.id.startsWith("control:")) candidates.push(artifactObjectPath(layout.controls, reference.digest));
  else if (reference.id.startsWith("receipt:")) candidates.push(artifactObjectPath(layout.receipts, reference.digest));
  else if (reference.id.startsWith("plan:")) candidates.push(artifactObjectPath(layout.inverses, reference.digest));
  const present = candidates.filter((candidate) => inventory.has(candidate));
  if (present.length > 1) throw new Error(`Apply reference resolves ambiguously: ${reference.id}`);
  if (candidates.length === 0) throw new Error(`Unsupported referenced Apply artifact: ${reference.id}`);
  if (present.length === 0) throw new Error(`Referenced Apply artifact is missing: ${reference.id}`);
  return present[0]!;
}

function artifactReferences(reference: ArtifactReference, value: unknown): ArtifactReference[] {
  // validateReferencedJson has already fully decoded and domain-validated an
  // inverse envelope before reference extraction. Snapshot capability proofs
  // are session-scoped, while inverse source Receipt/Plan bindings are scalar
  // ids and digests. No inverse envelope owns an Apply-store child artifact,
  // so walking its up-to-10k-Entity browser payload is both unnecessary and a
  // denial-of-service risk against the generic bounded graph traversal.
  if (reference.id.startsWith("plan:")) return [];
  const found: ArtifactReference[] = [];
  const pending: Array<{ readonly candidate: unknown; readonly depth: number }> = [
    { candidate: value, depth: 0 }
  ];
  let visited = 0;
  while (pending.length > 0) {
    const { candidate, depth } = pending.pop()!;
    visited += 1;
    if (visited > MAX_REACHABILITY_VALUES) throw new Error("Apply artifact graph exceeds its value bound");
    if (depth > MAX_REACHABILITY_DEPTH) throw new Error("Apply artifact graph exceeds its depth bound");
    if (!candidate || typeof candidate !== "object") continue;
    if (Array.isArray(candidate)) {
      for (const nested of candidate) pending.push({ candidate: nested, depth: depth + 1 });
      continue;
    }
    const record = candidate as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    if ((keys.join(",") === "digest,id" || keys.join(",") === "digest,id,kind")
      && typeof record.id === "string"
      && isDigest(record.digest)) {
      if (isApplyStoreArtifactId(record.id)) {
        found.push({ id: record.id, digest: record.digest });
        if (found.length > MAX_REACHABILITY_REFERENCES) {
          throw new Error("Apply artifact graph exceeds its reference bound");
        }
      } else if (!record.id.startsWith("session:")) {
        throw new Error(`Apply artifact graph contains an unknown evidence reference: ${record.id}`);
      }
      continue;
    }
    for (const nested of Object.values(record)) pending.push({ candidate: nested, depth: depth + 1 });
  }
  return found;
}

function isApplyStoreArtifactId(id: string): boolean {
  return [
    "consent:", "authorization:", "backup-bytes:", "backup:",
    "prepared-image:", "displaced-writer:", "prepared-fragment:", "recovery:", "journal:",
    "control:", "receipt:", "plan:"
  ].some((prefix) => id.startsWith(prefix));
}

function artifactReadLimit(reference: ArtifactReference): number {
  if (reference.id.startsWith("receipt:")) return 4 * MEBIBYTE;
  if (reference.id.startsWith("plan:")) return INVERSE_PLAN_MAX_BYTES;
  if (reference.id.startsWith("backup-bytes:")
    || reference.id.startsWith("prepared-")
    || reference.id.startsWith("displaced-writer:")) {
    return 64 * MEBIBYTE;
  }
  return 16 * MEBIBYTE;
}

function createDurableResult(
  manifest: ApplyRetentionManifest,
  outcome: "applied" | "discarded",
  completedAt: string
): ApplyRetentionDurableResult {
  const content = {
    schemaVersion: RESULT_SCHEMA,
    maintenanceId: manifest.maintenanceId,
    profileId: manifest.profileId,
    outcome,
    sourceHeadRevision: manifest.sourceHead.revision,
    targetHeadRevision: manifest.targetHead.revision,
    removedBytes: outcome === "applied" ? manifest.deletionTotals.bytes : 0,
    removedFiles: outcome === "applied" ? manifest.deletionTotals.files : 0,
    removedTransactionDirectories: outcome === "applied"
      ? manifest.deletionTotals.transactionDirectories
      : 0,
    completedAt
  } as const;
  return { ...content, revision: sha256Canonical(content) };
}

function resultFromDurable(
  inspection: ApplyRetentionInspection,
  manifest: ApplyRetentionManifest,
  durable: ApplyRetentionDurableResult
): ApplyRetentionResult {
  return {
    inspection,
    maintenanceId: durable.maintenanceId,
    outcome: durable.outcome,
    summaryCount: manifest.targetSummaryCount,
    archivedReceiptCount: manifest.archivedReceiptCount,
    evictedSummaryCount: manifest.evictedSummaryCount,
    removedBytes: durable.removedBytes,
    removedFiles: durable.removedFiles,
    removedTransactionDirectories: durable.removedTransactionDirectories,
    completedAt: durable.completedAt
  };
}

function inventoryRevision(inventory: readonly InventoryEntry[]): Sha256Digest {
  return sha256Canonical(inventory
    .filter((entry) => entry.kind === "file"
      && entry.relativePath !== `receipt-history${sep}history.lock`)
    .map((entry) => ({
      path: entry.relativePath,
      size: entry.size,
      device: entry.device,
      inode: entry.inode,
      mode: entry.mode,
      modifiedMs: entry.modifiedMs,
      changedMs: entry.changedMs,
      linkCount: entry.linkCount
    })));
}

function inventoryAccountingTotals(inventory: readonly InventoryEntry[]): {
  readonly bytes: number;
  readonly entries: number;
} {
  const bytes = inventory
    .filter((entry) => entry.kind === "file")
    .reduce((sum, entry) => sum + entry.size, 0);
  if (!Number.isSafeInteger(bytes) || inventory.length > APPLY_RETENTION_MAX_INVENTORY_ENTRIES) {
    throw new Error("Apply retention exact accounting totals exceed the shared store bound");
  }
  return { bytes, entries: inventory.length };
}

function maintenanceReservationBytes(targetSummaryEntries: number): number {
  if (!Number.isSafeInteger(targetSummaryEntries)
    || targetSummaryEntries < 0
    || targetSummaryEntries > APPLY_RETENTION_MAX_TARGET_ENTRIES) {
    throw new Error("Apply maintenance target summary count is invalid");
  }
  const value = targetSummaryEntries * HISTORY_NODE_MAX_BYTES + MAINTENANCE_METADATA_BYTES;
  if (!Number.isSafeInteger(value)) throw new Error("Apply maintenance reservation exceeds safe accounting range");
  return value;
}

function maintenanceReservationEntries(targetSummaryEntries: number): number {
  if (!Number.isSafeInteger(targetSummaryEntries)
    || targetSummaryEntries < 0
    || targetSummaryEntries > APPLY_RETENTION_MAX_TARGET_ENTRIES) {
    throw new Error("Apply maintenance target entry reservation is invalid");
  }
  return targetSummaryEntries + APPLY_RETENTION_FIXED_PEAK_ENTRIES;
}

function projectedManifestBytes(
  sourceHead: ApplyReceiptHistoryHead,
  sourceNodeDigests: readonly Sha256Digest[],
  targetSummaryCount: number,
  deletionTargets: readonly DeletionTarget[]
): number {
  const digestPlaceholder = `sha256:${"0".repeat(64)}` as Sha256Digest;
  const projection = {
    schemaVersion: MANIFEST_SCHEMA,
    maintenanceId: `retention:${"0".repeat(36)}`,
    profileId: sourceHead.profileId,
    sourceHead,
    sourceNodeDigests,
    targetHead: sourceHead,
    targetNodeDigests: Array.from({ length: targetSummaryCount }, () => digestPlaceholder),
    sourceSummaryCount: sourceHead.entryCount,
    targetSummaryCount,
    sourceFullReceiptCount: sourceHead.entryCount,
    targetFullReceiptCount: targetSummaryCount,
    archivedReceiptCount: sourceHead.entryCount,
    evictedSummaryCount: sourceHead.entryCount - targetSummaryCount,
    createdAt: new Date(0).toISOString(),
    deletionTargets,
    deletionTotals: {
      bytes: Number.MAX_SAFE_INTEGER,
      files: Number.MAX_SAFE_INTEGER,
      transactionDirectories: Number.MAX_SAFE_INTEGER
    },
    revision: digestPlaceholder
  };
  return Buffer.byteLength(`${JSON.stringify(projection, null, 2)}\n`, "utf8") + MEBIBYTE;
}

function pathFromRelative(layout: ApplyArtifactLayout, relativePath: string): string {
  const segments = relativePath.split(sep);
  if (segments.length === 0 || segments.some((segment) => !segment)) {
    throw new Error("Apply retention relative path is invalid");
  }
  return privatePath(layout.root, ...segments);
}

function isInside(path: string, root: string): boolean {
  return path.startsWith(`${root}${sep}`);
}

function definePolicy(policy: ApplyRetentionPolicy): ApplyRetentionPolicy {
  if (!Number.isSafeInteger(policy.undoWindowDays)
    || policy.undoWindowDays < APPLY_UNDO_WINDOW_DAYS
    || policy.undoWindowDays > 365) {
    throw new Error(
      `Apply retention undo window must be a whole number from the fixed ${APPLY_UNDO_WINDOW_DAYS}-day Undo window through 365 days`
    );
  }
  if (!Number.isSafeInteger(policy.maxSummaryEntries) || policy.maxSummaryEntries < 1 || policy.maxSummaryEntries > 4_096
    || !Number.isSafeInteger(policy.maxInventoryEntries) || policy.maxInventoryEntries < 100
    || policy.maxInventoryEntries > APPLY_RETENTION_MAX_INVENTORY_ENTRIES
    || !Number.isSafeInteger(policy.maxStoreBytes) || policy.maxStoreBytes < 1
    || policy.maxStoreBytes > APPLY_STORE_MAX_BYTES
    || !Number.isSafeInteger(policy.minimumFreeBytes) || policy.minimumFreeBytes < 0) {
    throw new Error("Apply retention policy is outside its bounded range");
  }
  return Object.freeze({ ...policy });
}

function causalSourceIssue(consumer: ApplyReceiptSummary, source: ApplyReceiptSummary): string | null {
  if (source.outcome !== "applied" || source.causalSourceReceiptId !== null) {
    return `successful Undo ${consumer.id} does not point to an applied forward Receipt`;
  }
  if (consumer.causalSourceReceiptDigest !== source.receiptDigest) {
    return `successful Undo ${consumer.id} has the wrong digest for causal source ${source.id}`;
  }
  return null;
}

function validDate(value: Date, label: string): Date {
  if (!Number.isFinite(value.getTime())) throw new Error(`${label} is invalid`);
  return value;
}

function isTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

function isDigest(value: unknown): value is Sha256Digest {
  return typeof value === "string" && /^sha256:[a-f0-9]{64}$/u.test(value);
}

function safeNonNegative(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function finiteNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function assertKeys(value: Record<string, unknown>, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(`${label} contains unknown or missing fields`);
  }
}
