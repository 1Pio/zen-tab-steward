import { applyUndoWindowExpiresAt } from "./apply-policy.js";
import { createPlan, definePlanForSnapshot } from "./domain/change.js";
import { sha256Canonical } from "./domain/digest.js";

import type { Plan, Receipt } from "./domain/change.js";
import type { Sha256Digest } from "./domain/digest.js";
import type { Snapshot } from "./domain/snapshot.js";

export class UndoLineageBindingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UndoLineageBindingError";
  }
}

/** One current-format identity shared by inverse creation and exact replay validation. */
export function inverseTemplateActionId(
  sourcePlanDigest: Sha256Digest,
  sourceActionId: string,
  inverseIndex: number
): string {
  if (!Number.isSafeInteger(inverseIndex) || inverseIndex < 0) {
    throw new Error("Inverse template action index must be a non-negative safe integer");
  }
  return `action:inverse:${sha256Canonical({
    sourcePlanDigest,
    sourceActionId,
    inverseIndex
  }).slice("sha256:".length)}`;
}

/**
 * Validates the immutable inverse template against the exact successful
 * Receipt and forward Plan that created it. This is deliberately pure so the
 * preview path and the mutation seam share one reverse-operation contract.
 */
export function inverseTemplateBindingBlockers(
  receipt: Receipt,
  sourcePlan: Plan,
  snapshot: Snapshot,
  template: Plan
): readonly string[] {
  const blockers: string[] = [];
  try {
    definePlanForSnapshot(snapshot, template);
  } catch (error) {
    blockers.push(`Inverse template is not bound to its stored Snapshot: ${errorMessage(error)}`);
    return Object.freeze(blockers);
  }
  if (receipt.outcome !== "applied") {
    blockers.push(`Receipt outcome ${receipt.outcome} is not a completely applied change`);
  }
  if (sourcePlan.id !== receipt.planId || sourcePlan.digest !== receipt.planDigest) {
    blockers.push("Source Plan does not match the exact source Receipt");
  }
  if (!receipt.inversePlanArtifact
    || receipt.inversePlanArtifact.id !== template.id
    || receipt.inversePlanArtifact.digest !== template.digest) {
    blockers.push("Inverse template does not match the source Receipt artifact reference");
  }
  if (template.source.kind !== "inverse"
    || template.source.sourceReceiptId !== receipt.id
    || template.source.sourceReceiptDigest !== null
    || template.source.inverseTemplateDigest !== null
    || template.source.sourcePlanId !== receipt.planId
    || template.source.sourcePlanDigest !== receipt.planDigest) {
    blockers.push("Inverse template source does not bind the exact Receipt and source Plan");
  }
  if (receipt.afterSnapshotRevision !== snapshot.revision) {
    blockers.push("Inverse template Snapshot does not match the source Receipt after-Snapshot");
  }
  if (template.actions.length !== receipt.operations.length) {
    blockers.push("Inverse template does not cover every source Receipt Operation");
    return Object.freeze(blockers);
  }

  const sourceActions = new Map(sourcePlan.actions.map((action) => [action.actionId, action]));
  const reversed = [...receipt.operations].reverse();
  for (let index = 0; index < template.actions.length; index += 1) {
    const action = template.actions[index];
    const operation = reversed[index];
    const sourceAction = operation ? sourceActions.get(operation.actionId) : undefined;
    const expectedActionId = operation
      ? inverseTemplateActionId(sourcePlan.digest, operation.actionId, index)
      : null;
    if (!action || action.disposition !== "move" || !operation
      || !sourceAction || sourceAction.disposition !== "move"
      || operation.status !== "verified"
      || action.actionId !== expectedActionId
      || action.operation.entityRef !== operation.entityRef
      || action.operation.entityKind !== sourceAction.operation.entityKind
      || action.operation.precondition.sourceWorkspace.workspaceId !== operation.observedWorkspaceId
      || operation.observedWorkspaceId !== sourceAction.operation.expectedPostState.workspaceId) {
      blockers.push("Inverse template Operation order or source binding does not exactly reverse the source Receipt");
      return Object.freeze(blockers);
    }
    if (action.operation.expectedPostState.workspaceId
      !== sourceAction.operation.precondition.sourceWorkspace.workspaceId
      || action.operation.inverse.destinationWorkspaceId
      !== sourceAction.operation.expectedPostState.workspaceId) {
      blockers.push("Inverse template destination does not restore the source Plan Operation");
      return Object.freeze(blockers);
    }
  }
  return Object.freeze(blockers);
}

export function assertInverseTemplateBinding(
  receipt: Receipt,
  sourcePlan: Plan,
  snapshot: Snapshot,
  template: Plan
): void {
  const blockers = inverseTemplateBindingBlockers(receipt, sourcePlan, snapshot, template);
  if (blockers.length > 0) throw new UndoLineageBindingError(blockers.join("; "));
}

/** Materializes the only executable Undo Plan permitted for this lineage. */
export function materializeReceiptUndoPlan(
  snapshot: Snapshot,
  template: Plan,
  sourceReceipt: Receipt,
  configRevision: Sha256Digest
): Plan {
  if (sourceReceipt.outcome !== "applied"
    || template.source.kind !== "inverse"
    || !sourceReceipt.inversePlanArtifact
    || sourceReceipt.inversePlanArtifact.digest !== template.digest) {
    throw new UndoLineageBindingError(
      "Undo Plan materialization requires an applied Receipt and its exact inverse template"
    );
  }
  const sourceReceiptDigest = sha256Canonical(sourceReceipt);
  const intentRevision = sha256Canonical({
    kind: "undo",
    sourceReceiptId: sourceReceipt.id,
    sourceReceiptDigest,
    sourcePlanId: sourceReceipt.planId,
    sourcePlanDigest: sourceReceipt.planDigest,
    inverseTemplateDigest: template.digest,
    configRevision
  });
  return createPlan(snapshot, {
    schemaVersion: "zts.plan.provisional-1",
    id: `plan:undo:${intentRevision.slice("sha256:".length, "sha256:".length + 20)}`,
    configRevision,
    engineManifestRevision: sha256Canonical({ undo: "zts.undo.provisional-1" }),
    createdAt: sourceReceipt.completedAt,
    expiresAt: applyUndoWindowExpiresAt(sourceReceipt.completedAt),
    derivation: { kind: "original" },
    source: {
      kind: "inverse",
      sourceReceiptId: sourceReceipt.id,
      sourceReceiptDigest,
      inverseTemplateDigest: template.digest,
      sourcePlanId: sourceReceipt.planId,
      sourcePlanDigest: sourceReceipt.planDigest,
      intentRevision
    },
    actions: template.actions
  });
}

/**
 * Recomputes the executable Plan and compares its canonical digest. Call this
 * at admission and again while exclusive control is held immediately before
 * mutation.
 */
export function assertMaterializedUndoPlanBinding(
  templateSnapshot: Snapshot,
  executionSnapshot: Snapshot,
  template: Plan,
  sourceReceipt: Receipt,
  sourcePlan: Plan,
  materializedPlan: Plan
): void {
  assertInverseTemplateBinding(sourceReceipt, sourcePlan, templateSnapshot, template);
  const expected = materializeReceiptUndoPlan(
    executionSnapshot,
    template,
    sourceReceipt,
    materializedPlan.configRevision
  );
  if (expected.digest !== materializedPlan.digest) {
    throw new UndoLineageBindingError(
      "Materialized Undo Plan is not the exact inverse of its source Receipt"
    );
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
