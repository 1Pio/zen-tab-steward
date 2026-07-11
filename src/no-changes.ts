import { definePlanForSnapshot } from "./domain/change.js";
import { ApplyTransactionSafetyError } from "./apply-transaction.js";

import type { Plan } from "./domain/change.js";
import type { Sha256Digest } from "./domain/digest.js";
import type { Snapshot } from "./domain/snapshot.js";

export interface NoChangesApplyOutcome {
  readonly applyOutcome: "no_changes";
  readonly applied: false;
  readonly mutationAttempted: false;
  readonly authorization: null;
  readonly receipt: null;
  readonly receiptPath: null;
}

export interface AttentionRequiredApplyOutcome {
  readonly applyOutcome: "attention_required";
  readonly applied: false;
  readonly mutationAttempted: false;
  readonly authorization: null;
  readonly receipt: null;
  readonly receiptPath: null;
  readonly attentionActionIds: readonly string[];
}

export type NoMutationApplyOutcome = NoChangesApplyOutcome | AttentionRequiredApplyOutcome;

export function noMutationApplyOutcome(plan: Plan): NoMutationApplyOutcome | null {
  if (plan.actions.some((action) => action.disposition === "move")) return null;
  const attentionActionIds = plan.actions
    .filter((action) => action.disposition === "review"
      || action.disposition === "protected"
      || action.disposition === "blocked")
    .map((action) => action.actionId);
  if (attentionActionIds.length > 0) {
    return Object.freeze({
      applyOutcome: "attention_required",
      applied: false,
      mutationAttempted: false,
      authorization: null,
      receipt: null,
      receiptPath: null,
      attentionActionIds: Object.freeze(attentionActionIds)
    });
  }
  return Object.freeze({
    applyOutcome: "no_changes",
    applied: false,
    mutationAttempted: false,
    authorization: null,
    receipt: null,
    receiptPath: null
  });
}

export function validateNoMutationApply(
  snapshot: Snapshot,
  plan: Plan,
  expectedDigest: string,
  configRevision: Sha256Digest,
  now = new Date()
): NoMutationApplyOutcome {
  if (expectedDigest !== plan.digest) {
    throw new Error("Expected Plan digest " + expectedDigest + " does not match selected Plan " + plan.digest);
  }
  const outcome = noMutationApplyOutcome(plan);
  if (!outcome) throw new Error("Plan " + plan.id + " contains executable move Operations");
  try {
    definePlanForSnapshot(snapshot, plan);
  } catch (error) {
    throw new ApplyTransactionSafetyError(error instanceof Error ? error.message : String(error));
  }
  if (plan.snapshotAuthority !== "authoritative" || plan.snapshotFreshness !== "current") {
    throw new ApplyTransactionSafetyError("Saved Plan apply requires a Plan created from a current authoritative Snapshot");
  }
  if (plan.configRevision !== configRevision) {
    throw new ApplyTransactionSafetyError(
      "Whole-Plan preflight failed: effective config revision "
      + configRevision
      + " does not match Plan "
      + plan.configRevision
    );
  }
  if (Date.parse(plan.expiresAt) <= now.getTime()) {
    throw new ApplyTransactionSafetyError("Saved Plan " + plan.digest + " expired at " + plan.expiresAt + "; create a fresh preview");
  }
  return outcome;
}
