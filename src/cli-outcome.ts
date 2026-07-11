import {
  ApplyTransactionSafetyError,
  ApplyTransactionUncertainError
} from "./apply-transaction.js";
import {
  ApplyRecoveryBlockedError,
  ApplyRecoveryUncertainError
} from "./apply-recovery.js";

import type { ApplyTransactionOutcome } from "./apply-transaction.js";
import type { ApplyRecoveryResult } from "./apply-recovery.js";

export type CliExitCode = 0 | 1 | 2 | 3 | 4;

export type CliOutcome = Readonly<
  | {
      status: "succeeded";
      exitCode: 0;
      ok: true;
      mutationAttempted: boolean;
      changed: boolean;
    }
  | {
      status: "invalid";
      exitCode: 1;
      ok: false;
      mutationAttempted: false;
      changed: false;
    }
  | {
      status: "blocked";
      exitCode: 2;
      ok: false;
      mutationAttempted: false;
      changed: false;
    }
  | {
      status: "failed";
      exitCode: 3;
      ok: false;
      mutationAttempted: boolean | null;
      changed: boolean | null;
    }
  | {
      status: "internal_error";
      exitCode: 4;
      ok: false;
      mutationAttempted: null;
      changed: null;
    }
>;

export const CLI_INVALID_OUTCOME: CliOutcome = Object.freeze({
  status: "invalid",
  exitCode: 1,
  ok: false,
  mutationAttempted: false,
  changed: false
});

export const CLI_BLOCKED_OUTCOME: CliOutcome = Object.freeze({
  status: "blocked",
  exitCode: 2,
  ok: false,
  mutationAttempted: false,
  changed: false
});

export const CLI_INTERNAL_ERROR_OUTCOME: CliOutcome = Object.freeze({
  status: "internal_error",
  exitCode: 4,
  ok: false,
  mutationAttempted: null,
  changed: null
});

export function cliOutcomeForApplyTransaction(outcome: ApplyTransactionOutcome): CliOutcome {
  if (outcome.applied) {
    if (outcome.receipt.outcome !== "applied"
      || !outcome.receipt.mutationAttempted
      || !outcome.receipt.netChanged) return CLI_INTERNAL_ERROR_OUTCOME;
    return Object.freeze({
      status: "succeeded",
      exitCode: 0,
      ok: true,
      mutationAttempted: true,
      changed: true
    });
  }
  if (outcome.receipt.outcome === "blocked") {
    return outcome.receipt.mutationAttempted || outcome.receipt.netChanged
      ? CLI_INTERNAL_ERROR_OUTCOME
      : outcome.failureKind === "safety"
        ? CLI_BLOCKED_OUTCOME
        : CLI_INTERNAL_ERROR_OUTCOME;
  }
  return Object.freeze({
    status: "failed",
    exitCode: 3,
    ok: false,
    mutationAttempted: outcome.receipt.mutationAttempted,
    changed: outcome.receipt.netChanged
  });
}

/** Invocation validation is completed before entering the transaction seam. */
export function cliOutcomeForApplyExecutionError(error: unknown): CliOutcome {
  if (error instanceof ApplyTransactionSafetyError) return CLI_BLOCKED_OUTCOME;
  if (error instanceof ApplyTransactionUncertainError) {
    return Object.freeze({
      status: "failed",
      exitCode: 3,
      ok: false,
      mutationAttempted: null,
      changed: null
    });
  }
  return CLI_INTERNAL_ERROR_OUTCOME;
}

export function cliOutcomeForApplyVerification(ok: boolean): CliOutcome {
  return ok
    ? Object.freeze({
        status: "succeeded",
        exitCode: 0,
        ok: true,
        mutationAttempted: false,
        changed: false
      })
    : Object.freeze({
        status: "failed",
        exitCode: 3,
        ok: false,
        mutationAttempted: null,
        changed: null
      });
}

export function cliOutcomeForRecoveryResult(result: Pick<ApplyRecoveryResult, "sessionMutated">): CliOutcome {
  return Object.freeze({
    status: "succeeded",
    exitCode: 0,
    ok: true,
    mutationAttempted: result.sessionMutated,
    changed: result.sessionMutated
  });
}

export function cliOutcomeForRecoveryError(error: unknown): CliOutcome {
  if (error instanceof ApplyRecoveryBlockedError) return CLI_BLOCKED_OUTCOME;
  if (error instanceof ApplyRecoveryUncertainError) {
    return Object.freeze({
      status: "failed",
      exitCode: 3,
      ok: false,
      mutationAttempted: null,
      changed: null
    });
  }
  return CLI_INTERNAL_ERROR_OUTCOME;
}

export function cliOutcomeForNoMutation(attentionRequired: boolean): CliOutcome {
  return attentionRequired
    ? CLI_BLOCKED_OUTCOME
    : Object.freeze({
        status: "succeeded",
        exitCode: 0,
        ok: true,
        mutationAttempted: false,
        changed: false
      });
}
