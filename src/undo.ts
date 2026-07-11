import { readApplyArtifactLayout } from "./apply-artifacts.js";
import {
  applyStoredPlanClosedSession,
  findTransactionReceipt,
  inversePlanReplayability
} from "./apply-transaction.js";
import { reduceApplyReceiptUndoLineage } from "./apply-receipt-store.js";
import { effectiveConfigRevision } from "./config.js";
import { sha256Canonical } from "./domain/digest.js";
import { loadInversePlan } from "./inverse-plan-store.js";
import { loadStoredPlan, publishDetachedPlanObject } from "./plans.js";
import { captureSessionSnapshot } from "./session-snapshot.js";
import { applyUndoWindowExpiresAt } from "./apply-policy.js";
import {
  inverseTemplateBindingBlockers,
  materializeReceiptUndoPlan
} from "./undo-lineage.js";

import type { ApplyStoredPlanOptions, ApplyTransactionOutcome } from "./apply-transaction.js";
import type { ApplyReceiptSummary } from "./apply-receipt-store.js";
import type { ZtsConfig } from "./config.js";
import type { Plan, Receipt } from "./domain/change.js";
import type { Sha256Digest } from "./domain/digest.js";
import type { ArtifactReference, Snapshot } from "./domain/snapshot.js";
import type { StoredPlan } from "./plans.js";
import type { ProfileContext } from "./profile.js";

const UNDO_HISTORY_SCAN_LIMIT = 50_000;

export interface UndoInspection {
  readonly sourceReceipt: Receipt;
  readonly sourceReceiptPath: string;
  readonly sourceReceiptSelector: string;
  readonly inverseSnapshot: Snapshot | null;
  readonly inversePlan: Plan | null;
  readonly undoPlan: Plan | null;
  readonly inversePlanArtifact: ArtifactReference | null;
  readonly currentSnapshot: Snapshot;
  readonly currentSnapshotRevision: Sha256Digest;
  readonly currentSnapshotAuthority: Snapshot["authority"];
  readonly currentSnapshotFreshness: Snapshot["freshness"];
  readonly causalConsumer: ApplyReceiptSummary | null;
  readonly supersedingReceipt: ApplyReceiptSummary | null;
  readonly undoWindowExpiresAt: string;
  readonly drift: {
    readonly detected: boolean;
    readonly acceptUnrelatedDriftRequested: boolean;
    readonly rebased: boolean;
    readonly templateSnapshotRevision: Sha256Digest | null;
  };
  readonly eligible: boolean;
  readonly blockers: readonly string[];
}

export interface UndoInspectionOptions {
  /**
   * Rebinds the exact inverse Operations to the current Snapshot only when
   * every affected entity and precondition still validates. Whole-Snapshot
   * drift remains a hard failure unless this is explicitly requested.
   */
  readonly acceptUnrelatedDrift?: boolean;
}

export interface UndoApplyResult {
  readonly inspection: UndoInspection;
  readonly detachedPlan: StoredPlan;
  readonly transaction: ApplyTransactionOutcome;
}

export type UndoApplyHooks = Pick<
  ApplyStoredPlanOptions,
  | "afterSafetyCheck"
  | "afterUnfinishedMarker"
  | "afterAtomicSwap"
  | "afterReceiptObject"
  | "afterHistoryHead"
  | "afterStoreSettlement"
> & UndoInspectionOptions;

export class UndoBlockedError extends Error {
  readonly inspection: UndoInspection;

  constructor(inspection: UndoInspection) {
    super(inspection.blockers.join("; ") || "Undo is not eligible");
    this.name = "UndoBlockedError";
    this.inspection = inspection;
  }
}

export class UndoSelectionError extends Error {
  readonly code: "UNDO_NOT_FOUND" | "UNDO_NO_CANDIDATE";

  constructor(code: "UNDO_NOT_FOUND" | "UNDO_NO_CANDIDATE", message: string) {
    super(message);
    this.name = "UndoSelectionError";
    this.code = code;
  }
}

export async function inspectUndo(
  context: ProfileContext,
  config: ZtsConfig,
  selector = "latest",
  now = new Date(),
  options: UndoInspectionOptions = {}
): Promise<UndoInspection> {
  const sourceReceiptId = selector === "latest"
    ? await latestUndoCandidateId(context.profile.id, now)
    : selector;
  if (!sourceReceiptId) {
    throw new UndoSelectionError(
      "UNDO_NO_CANDIDATE",
      "No causally eligible applied Receipt with an available inverse Plan is inside the Undo window"
    );
  }
  const found = await findTransactionReceipt(context.profile.id, sourceReceiptId);
  if (!found) {
    throw new UndoSelectionError("UNDO_NOT_FOUND", `Undo source Receipt not found: ${sourceReceiptId}`);
  }
  const sourceReceipt = found.receipt;
  const blockers: string[] = [];
  const undoWindowExpiresAt = applyUndoWindowExpiresAt(sourceReceipt.completedAt);
  if (now.getTime() >= Date.parse(undoWindowExpiresAt)) {
    blockers.push(`Receipt Undo window expired at ${undoWindowExpiresAt}`);
  }
  if (!receiptHasReplayableChange(sourceReceipt)) {
    blockers.push(
      `Receipt outcome ${sourceReceipt.outcome} does not prove a complete changed state that can be undone`
    );
  }
  const sourcePlan = (await loadStoredPlan(context.profile.id, sourceReceipt.planDigest)).plan;
  if (sourcePlan.source.kind === "inverse") {
    blockers.push("Undo-of-Undo is not enabled in the first production Undo contract");
  }
  const layout = await readApplyArtifactLayout(context.profile.id);
  const lineage = await reduceApplyReceiptUndoLineage(
    layout,
    context.profile.id,
    { sourceReceiptId: sourceReceipt.id, maxNodes: UNDO_HISTORY_SCAN_LIMIT }
  );
  const supersedingReceipt = lineage.barrier;
  const causalConsumer = lineage.causalConsumer;
  if (!lineage.source) blockers.push("Receipt is missing from the canonical causal history");
  if (supersedingReceipt) {
    blockers.push(
      causalConsumer?.outcome === "applied"
        ? `Receipt was already consumed by successful Undo Receipt ${causalConsumer.id}`
        : `Receipt was superseded or entered uncertain lineage through ${supersedingReceipt.id} (${supersedingReceipt.outcome})`
    );
  }

  let inverseSnapshot: Snapshot | null = null;
  let inversePlan: Plan | null = null;
  if (!sourceReceipt.inversePlanArtifact) {
    blockers.push("Receipt has no inverse Plan artifact");
  } else {
    const replayability = await inversePlanReplayability(layout, sourceReceipt.inversePlanArtifact);
    if (replayability !== "bound_snapshot") {
      blockers.push(`Receipt inverse Plan is ${replayability} and cannot be safely replayed`);
    } else {
      const inverse = await loadInversePlan(layout, sourceReceipt.inversePlanArtifact);
      inverseSnapshot = inverse.snapshot;
      inversePlan = inverse.plan;
      blockers.push(...inverseTemplateBindingBlockers(sourceReceipt, sourcePlan, inverseSnapshot, inversePlan));
    }
  }

  const captured = await captureSessionSnapshot(context, config);
  const current = captured.snapshot;
  if (current.authority !== "authoritative" || current.freshness !== "current") {
    blockers.push("Undo apply requires Zen to be closed and a current authoritative Snapshot");
  }
  const wholePlanDriftDetected = Boolean(
    inverseSnapshot && current.revision !== inverseSnapshot.revision
  );
  if (wholePlanDriftDetected && !options.acceptUnrelatedDrift) {
    blockers.push(
      `Whole-Plan Drift: inverse Plan binds Snapshot ${inverseSnapshot!.revision}, current Snapshot is ${current.revision}`
    );
  }
  let undoPlan: Plan | null = null;
  if (inversePlan && current.authority === "authoritative" && current.freshness === "current"
    && (!wholePlanDriftDetected || options.acceptUnrelatedDrift)) {
    try {
      undoPlan = materializeReceiptUndoPlan(
        current,
        inversePlan,
        sourceReceipt,
        effectiveConfigRevision(config)
      );
    } catch (error) {
      blockers.push(error instanceof Error ? error.message : String(error));
    }
  }

  return Object.freeze({
    sourceReceipt,
    sourceReceiptPath: found.receiptPath,
    sourceReceiptSelector: selector,
    inverseSnapshot,
    inversePlan,
    undoPlan,
    inversePlanArtifact: sourceReceipt.inversePlanArtifact,
    currentSnapshot: current,
    currentSnapshotRevision: current.revision,
    currentSnapshotAuthority: current.authority,
    currentSnapshotFreshness: current.freshness,
    causalConsumer,
    supersedingReceipt,
    undoWindowExpiresAt,
    drift: Object.freeze({
      detected: wholePlanDriftDetected,
      acceptUnrelatedDriftRequested: options.acceptUnrelatedDrift === true,
      rebased: wholePlanDriftDetected && undoPlan !== null,
      templateSnapshotRevision: inverseSnapshot?.revision ?? null
    }),
    eligible: blockers.length === 0,
    blockers: Object.freeze(blockers)
  });
}

export async function applyUndo(
  context: ProfileContext,
  config: ZtsConfig,
  selector: string,
  expectedDigest: string,
  command: string,
  routePreference?: "auto" | "live" | "session",
  now = new Date(),
  hooks: UndoApplyHooks = {}
): Promise<UndoApplyResult> {
  const inspection = await inspectUndo(context, config, selector, now, hooks);
  if (!inspection.eligible || !inspection.inverseSnapshot || !inspection.undoPlan) {
    throw new UndoBlockedError(inspection);
  }
  if (expectedDigest !== inspection.undoPlan.digest) {
    throw new Error(
      `Expected inverse Plan digest ${expectedDigest} does not match reviewed Undo Plan ${inspection.undoPlan.digest}`
    );
  }
  const requestRevision = sha256Canonical({
    kind: "undo",
    sourceReceiptId: inspection.sourceReceipt.id,
    inversePlanDigest: inspection.undoPlan.digest
  });
  const detachedPlan = await publishDetachedPlanObject(
    inspection.currentSnapshot,
    inspection.undoPlan,
    requestRevision,
    now
  );
  const transaction = await applyStoredPlanClosedSession(context, detachedPlan, {
    ...hooks,
    expectedDigest,
    command,
    ...(routePreference === undefined ? {} : { routePreference }),
    now,
    executionIntent: {
      kind: "undo",
      sourceReceiptId: inspection.sourceReceipt.id,
      sourceReceiptDigest: sha256Canonical(inspection.sourceReceipt)
    }
  });
  return { inspection, detachedPlan, transaction };
}

function receiptHasReplayableChange(receipt: Receipt): boolean {
  return receipt.outcome === "applied";
}

async function latestUndoCandidateId(profileId: string, now: Date): Promise<string | null> {
  let layout;
  try {
    layout = await readApplyArtifactLayout(profileId);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const lineage = await reduceApplyReceiptUndoLineage(layout, profileId, {
    maxNodes: UNDO_HISTORY_SCAN_LIMIT
  });
  const candidate = lineage.activeForward;
  if (!candidate || lineage.barrier
    || candidate.fullReceiptAvailability !== "available"
    || candidate.inversePlanReplayability !== "bound_snapshot"
    || now.getTime() >= Date.parse(applyUndoWindowExpiresAt(candidate.completedAt))) {
    return null;
  }
  return candidate.id;
}
