import assert from "node:assert/strict";
import test from "node:test";

import {
  CLI_INVALID_OUTCOME,
  cliOutcomeForApplyExecutionError,
  cliOutcomeForApplyTransaction,
  cliOutcomeForApplyVerification,
  cliOutcomeForNoMutation,
  cliOutcomeForRecoveryError,
  cliOutcomeForRecoveryResult
} from "../dist/cli-outcome.js";
import {
  ApplyTransactionSafetyError,
  ApplyTransactionUncertainError
} from "../dist/apply-transaction.js";
import {
  ApplyRecoveryBlockedError,
  ApplyRecoveryUncertainError
} from "../dist/apply-recovery.js";

test("Apply CLI contract distinguishes success, safe refusal, and mutation uncertainty", () => {
  assert.deepEqual(
    cliOutcomeForApplyTransaction({ applied: true, receipt: { outcome: "applied", mutationAttempted: true, netChanged: true } }),
    { status: "succeeded", exitCode: 0, ok: true, mutationAttempted: true, changed: true }
  );
  assert.deepEqual(
    cliOutcomeForApplyTransaction({
      applied: false,
      failureKind: "safety",
      receipt: { outcome: "blocked", mutationAttempted: false, netChanged: false }
    }),
    { status: "blocked", exitCode: 2, ok: false, mutationAttempted: false, changed: false }
  );
  assert.deepEqual(
    cliOutcomeForApplyTransaction({
      applied: false,
      failureKind: "internal",
      receipt: { outcome: "blocked", mutationAttempted: false, netChanged: false }
    }),
    { status: "internal_error", exitCode: 4, ok: false, mutationAttempted: null, changed: null }
  );
  for (const [outcome, netChanged] of [
    ["interrupted", null],
    ["partial", null],
    ["compensated", false],
    ["compensation_failed", null],
    ["verification_failed", null]
  ]) {
    assert.deepEqual(
      cliOutcomeForApplyTransaction({ applied: false, receipt: { outcome, mutationAttempted: true, netChanged } }),
      { status: "failed", exitCode: 3, ok: false, mutationAttempted: true, changed: netChanged }
    );
  }
});

test("CLI outcome contract reserves distinct invocation, safety, failure, and internal exits", () => {
  assert.deepEqual(CLI_INVALID_OUTCOME, {
    status: "invalid", exitCode: 1, ok: false, mutationAttempted: false, changed: false
  });
  assert.deepEqual(
    cliOutcomeForApplyExecutionError(new ApplyTransactionSafetyError("safe refusal")),
    { status: "blocked", exitCode: 2, ok: false, mutationAttempted: false, changed: false }
  );
  assert.deepEqual(
    cliOutcomeForApplyExecutionError(new ApplyTransactionUncertainError("needs recovery")),
    { status: "failed", exitCode: 3, ok: false, mutationAttempted: null, changed: null }
  );
  assert.deepEqual(
    cliOutcomeForApplyExecutionError(new Error("unexpected I/O")),
    { status: "internal_error", exitCode: 4, ok: false, mutationAttempted: null, changed: null }
  );
  assert.deepEqual(cliOutcomeForApplyVerification(true), {
    status: "succeeded", exitCode: 0, ok: true, mutationAttempted: false, changed: false
  });
  assert.deepEqual(
    cliOutcomeForApplyVerification(false),
    { status: "failed", exitCode: 3, ok: false, mutationAttempted: null, changed: null }
  );
  assert.deepEqual(cliOutcomeForNoMutation(false), {
    status: "succeeded", exitCode: 0, ok: true, mutationAttempted: false, changed: false
  });
  assert.deepEqual(cliOutcomeForNoMutation(true), {
    status: "blocked", exitCode: 2, ok: false, mutationAttempted: false, changed: false
  });
});

test("recovery outcomes describe the recovery command rather than its historical Receipt", () => {
  assert.deepEqual(cliOutcomeForRecoveryResult({ sessionMutated: false }), {
    status: "succeeded", exitCode: 0, ok: true, mutationAttempted: false, changed: false
  });
  assert.deepEqual(cliOutcomeForRecoveryResult({ sessionMutated: true }), {
    status: "succeeded", exitCode: 0, ok: true, mutationAttempted: true, changed: true
  });
  assert.deepEqual(cliOutcomeForRecoveryError(new ApplyRecoveryBlockedError("drift")), {
    status: "blocked", exitCode: 2, ok: false, mutationAttempted: false, changed: false
  });
  assert.deepEqual(cliOutcomeForRecoveryError(new ApplyRecoveryUncertainError("cleanup")), {
    status: "failed", exitCode: 3, ok: false, mutationAttempted: null, changed: null
  });
  assert.deepEqual(cliOutcomeForRecoveryError(new Error("bad durable bytes")), {
    status: "internal_error", exitCode: 4, ok: false, mutationAttempted: null, changed: null
  });
});
