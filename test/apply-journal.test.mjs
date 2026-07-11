import assert from "node:assert/strict";
import test from "node:test";
import {
  APPLY_JOURNAL_LIMITS,
  appendApplyJournal,
  bindApplyRecoveryControl,
  createApplyJournal,
  defineApplyJournal
} from "../dist/apply-journal.js";

const DIGEST = `sha256:${"a".repeat(64)}`;
const OTHER_DIGEST = `sha256:${"b".repeat(64)}`;
const TRANSACTION_ID = "apply:00000000-0000-4000-8000-000000000001";

function journal() {
  return createApplyJournal({
    transactionId: TRANSACTION_ID,
    planId: "plan:fixture",
    planDigest: DIGEST,
    authorizationRevision: OTHER_DIGEST,
    profileId: "profile:fixture",
    targetPathRevision: DIGEST
  }, new Date("2026-07-11T00:00:00.000Z"));
}

function fingerprint(overrides = {}) {
  return {
    digest: DIGEST,
    size: 1_024,
    mode: 0o600,
    modifiedMs: 1,
    changedMs: 1,
    device: 1,
    inode: 2,
    ...overrides
  };
}

function lockedJournal() {
  const value = journal();
  appendApplyJournal(value, "locked", {
    lockRevision: DIGEST,
    nativeControlLeaseRevision: OTHER_DIGEST,
    authorizedActionIds: ["move:fixture"]
  }, new Date("2026-07-11T00:00:01.000Z"));
  return value;
}

test("Apply journal accepts a bounded canonical transition", () => {
  const value = lockedJournal();
  appendApplyJournal(value, "preflight_ok", {
    beforeSnapshotRevision: DIGEST,
    expectedAfterSnapshotRevision: OTHER_DIGEST,
    sourceFingerprint: fingerprint(),
    operationCount: 1,
    inversePlanArtifact: { id: "plan:inverse", digest: OTHER_DIGEST }
  }, new Date("2026-07-11T00:00:02.000Z"));

  assert.equal(defineApplyJournal(structuredClone(value)).stage, "preflight_ok");
});

test("Apply journal retains the strict legacy preflight shape for existing provisional-1 Receipts", () => {
  const value = lockedJournal();
  appendApplyJournal(value, "preflight_ok", {
    beforeSnapshotRevision: DIGEST,
    sourceFingerprint: fingerprint(),
    operationCount: 1
  }, new Date("2026-07-11T00:00:02.000Z"));

  assert.equal(defineApplyJournal(structuredClone(value)).stage, "preflight_ok");

  const partiallyUpgraded = structuredClone(value);
  partiallyUpgraded.history.at(-1).evidence.expectedAfterSnapshotRevision = OTHER_DIGEST;
  assert.throws(() => defineApplyJournal(partiallyUpgraded), /unknown or missing fields/);
});

test("Apply journal bounds history during append and untrusted decode", () => {
  const value = journal();
  for (let index = 1; index < APPLY_JOURNAL_LIMITS.maxHistoryEntries; index += 1) {
    appendApplyJournal(value, "recovery_control_acquired", {
      lockRevision: DIGEST,
      nativeControlLeaseRevision: OTHER_DIGEST
    }, new Date(Date.parse("2026-07-11T00:00:00.000Z") + index * 1_000));
  }
  assert.equal(value.history.length, APPLY_JOURNAL_LIMITS.maxHistoryEntries);
  assert.throws(() => appendApplyJournal(value, "recovery_control_acquired", {
    lockRevision: DIGEST,
    nativeControlLeaseRevision: OTHER_DIGEST
  }), /history exceeds/);

  const oversized = structuredClone(value);
  oversized.history.push(structuredClone(oversized.history.at(-1)));
  assert.throws(() => defineApplyJournal(oversized), /history/);
});

test("Apply journal bounds and deduplicates authorized action ids", () => {
  const tooMany = Array.from(
    { length: APPLY_JOURNAL_LIMITS.maxAuthorizedActionIds + 1 },
    (_, index) => `move:${index}`
  );
  assert.throws(() => appendApplyJournal(journal(), "locked", {
    lockRevision: DIGEST,
    nativeControlLeaseRevision: OTHER_DIGEST,
    authorizedActionIds: tooMany
  }), /locked evidence/);
  assert.throws(() => appendApplyJournal(journal(), "locked", {
    lockRevision: DIGEST,
    nativeControlLeaseRevision: OTHER_DIGEST,
    authorizedActionIds: ["move:duplicate", "move:duplicate"]
  }), /locked evidence/);
});

test("Apply journal bounds failure evidence before persistence", () => {
  assert.throws(() => appendApplyJournal(journal(), "preflight_blocked", {
    issueCode: "x".repeat(APPLY_JOURNAL_LIMITS.maxIssueCodeBytes + 1),
    message: "blocked",
    mutationStatus: "not_committed",
    backupArtifact: null,
    recoveryArtifact: null,
    inversePlanArtifact: null
  }), /preflight_blocked evidence/);
  assert.throws(() => appendApplyJournal(journal(), "preflight_blocked", {
    issueCode: "fixture_blocked",
    message: "x".repeat(APPLY_JOURNAL_LIMITS.maxMessageBytes + 1),
    mutationStatus: "not_committed",
    backupArtifact: null,
    recoveryArtifact: null,
    inversePlanArtifact: null
  }), /preflight_blocked evidence/);
});

test("Apply journal rejects oversized or extended source fingerprints", () => {
  const oversized = lockedJournal();
  assert.throws(() => appendApplyJournal(oversized, "preflight_ok", {
    beforeSnapshotRevision: DIGEST,
    expectedAfterSnapshotRevision: OTHER_DIGEST,
    sourceFingerprint: fingerprint({ size: APPLY_JOURNAL_LIMITS.maxFingerprintBytes + 1 }),
    operationCount: 1,
    inversePlanArtifact: { id: "plan:inverse", digest: OTHER_DIGEST }
  }), /preflight evidence/);

  const extended = lockedJournal();
  assert.throws(() => appendApplyJournal(extended, "preflight_ok", {
    beforeSnapshotRevision: DIGEST,
    expectedAfterSnapshotRevision: OTHER_DIGEST,
    sourceFingerprint: { ...fingerprint(), injected: true },
    operationCount: 1,
    inversePlanArtifact: { id: "plan:inverse", digest: OTHER_DIGEST }
  }), /preflight evidence/);
});

test("Apply journal rejects non-canonical artifact references", () => {
  const value = lockedJournal();
  appendApplyJournal(value, "preflight_ok", {
    beforeSnapshotRevision: DIGEST,
    expectedAfterSnapshotRevision: OTHER_DIGEST,
    sourceFingerprint: fingerprint(),
    operationCount: 1,
    inversePlanArtifact: { id: "plan:inverse", digest: OTHER_DIGEST }
  });
  assert.throws(() => appendApplyJournal(value, "backup_published", {
    backupArtifact: { id: "backup:fixture", digest: DIGEST, injected: true },
    recoveryArtifact: { id: "recovery:fixture", digest: OTHER_DIGEST }
  }), /backup_published backupArtifact/);
});

test("repeated recovery control binding replaces one final entry without exhausting bounded history", () => {
  const value = journal();
  bindApplyRecoveryControl(value, {
    lockRevision: DIGEST,
    nativeControlLeaseRevision: OTHER_DIGEST
  }, new Date("2026-07-11T00:00:01.000Z"));
  const firstAt = value.history.at(-1).at;
  for (let attempt = 0; attempt < APPLY_JOURNAL_LIMITS.maxHistoryEntries + 8; attempt += 1) {
    bindApplyRecoveryControl(value, {
      lockRevision: attempt % 2 === 0 ? OTHER_DIGEST : DIGEST,
      nativeControlLeaseRevision: attempt % 2 === 0 ? DIGEST : OTHER_DIGEST
    }, new Date(`2026-07-11T00:00:${String((attempt % 50) + 2).padStart(2, "0")}.000Z`));
  }
  assert.equal(value.history.length, 2);
  assert.equal(value.history.at(-1).at, firstAt);
  assert.doesNotThrow(() => defineApplyJournal(value));
});

test("intent-bound prepared recovery evidence can only complete", () => {
  const value = journal();
  bindApplyRecoveryControl(value, {
    lockRevision: DIGEST,
    nativeControlLeaseRevision: OTHER_DIGEST
  }, new Date("2026-07-11T00:00:01.000Z"));
  appendApplyJournal(value, "recovery_receipt_prepared", {
    issueCode: "fixture_recovery",
    controlArtifact: { id: `control:recovery:${TRANSACTION_ID}`, digest: DIGEST },
    recoveryArtifact: { id: `recovery:${TRANSACTION_ID}`, digest: OTHER_DIGEST },
    inversePlanArtifact: null,
    terminalIntentRevision: DIGEST
  }, new Date("2026-07-11T00:00:02.000Z"));
  assert.throws(() => bindApplyRecoveryControl(value, {
    lockRevision: OTHER_DIGEST,
    nativeControlLeaseRevision: DIGEST
  }), /only to recovery_complete/);
  const corrupt = structuredClone(value);
  corrupt.history.push({
    stage: "recovery_control_acquired",
    at: "2026-07-11T00:00:03.000Z",
    evidence: { lockRevision: DIGEST, nativeControlLeaseRevision: OTHER_DIGEST }
  });
  corrupt.stage = "recovery_control_acquired";
  assert.throws(() => defineApplyJournal(corrupt), /only to recovery_complete/);
});
