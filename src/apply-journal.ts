import { sha256Canonical } from "./domain/digest.js";

import type { Sha256Digest } from "./domain/digest.js";
import type { ArtifactReference } from "./domain/snapshot.js";
import type { JsonLz4Fingerprint } from "./mozlz4.js";

export const APPLY_JOURNAL_SCHEMA = "zts.apply-journal.provisional-1" as const;

export const APPLY_JOURNAL_LIMITS = Object.freeze({
  maxHistoryEntries: 64,
  maxAuthorizedActionIds: 500,
  maxIdentityBytes: 4_096,
  maxIssueCodeBytes: 256,
  maxMessageBytes: 64 * 1024,
  maxFingerprintBytes: 64 * 1024 * 1024
});

export type ApplyJournalStage =
  | "initialized"
  | "locked"
  | "preflight_ok"
  | "backup_published"
  | "write_prepared"
  | "write_committed"
  | "verified"
  | "released"
  | "preflight_blocked"
  | "interrupted"
  | "failure_recorded"
  | "recovery_control_acquired"
  | "recovery_temporary_preserved"
  | "recovery_temporary_closed"
  | "recovery_receipt_prepared"
  | "recovery_complete";

export interface ApplyJournalEvidenceByStage {
  readonly initialized: Readonly<Record<string, never>>;
  readonly locked: {
    readonly lockRevision: Sha256Digest;
    readonly nativeControlLeaseRevision: Sha256Digest;
    readonly authorizedActionIds: readonly [string, ...string[]];
  };
  readonly preflight_ok:
    | {
        /** Strict legacy shape retained for unreleased provisional-1 Receipts. */
        readonly beforeSnapshotRevision: Sha256Digest;
        readonly sourceFingerprint: JsonLz4Fingerprint;
        readonly operationCount: number;
      }
    | {
        readonly beforeSnapshotRevision: Sha256Digest;
        readonly expectedAfterSnapshotRevision: Sha256Digest;
        readonly sourceFingerprint: JsonLz4Fingerprint;
        readonly operationCount: number;
        readonly inversePlanArtifact: ArtifactReference;
      };
  readonly backup_published: {
    readonly backupArtifact: ArtifactReference;
    readonly recoveryArtifact: ArtifactReference;
  };
  readonly write_prepared: {
    readonly backupArtifact: ArtifactReference;
    readonly recoveryArtifact: ArtifactReference;
    readonly temporaryPathRevision: Sha256Digest;
    readonly preparedDigest: Sha256Digest;
  };
  readonly write_committed: {
    readonly backupArtifact: ArtifactReference;
    readonly recoveryArtifact: ArtifactReference;
  };
  readonly verified: {
    readonly afterSnapshotRevision: Sha256Digest;
    readonly afterSourceFingerprint: JsonLz4Fingerprint;
    readonly inversePlanArtifact: ArtifactReference;
  };
  readonly released: {
    readonly releasedAt: string;
    readonly controlArtifact: ArtifactReference;
    readonly receiptId: string;
    readonly inversePlanArtifact: ArtifactReference;
  };
  readonly preflight_blocked: FailureEvidence;
  readonly interrupted: FailureEvidence;
  readonly failure_recorded: {
    readonly controlArtifact: ArtifactReference;
    readonly releaseStatus: "verified" | "unknown";
    readonly releasedAt: string | null;
    readonly receiptId: string;
  };
  readonly recovery_control_acquired: {
    readonly lockRevision: Sha256Digest;
    readonly nativeControlLeaseRevision: Sha256Digest;
  };
  readonly recovery_temporary_preserved: {
    readonly temporaryPathRevision: Sha256Digest;
    readonly preparedArtifact: ArtifactReference;
    readonly completeness: "complete" | "incomplete" | "external_writer";
    readonly preservedAt: string;
  };
  readonly recovery_temporary_closed: {
    readonly temporaryPathRevision: Sha256Digest;
    readonly preparedArtifact: ArtifactReference;
    readonly disposition: "removed" | "observed_absent";
    readonly closedAt: string;
  };
  readonly recovery_receipt_prepared:
    | {
        /** Strict legacy terminal evidence retained for already-written journals. */
        readonly issueCode: string;
        readonly controlArtifact: ArtifactReference;
        readonly recoveryArtifact: ArtifactReference;
        readonly inversePlanArtifact: ArtifactReference | null;
      }
    | {
        readonly issueCode: string;
        readonly controlArtifact: ArtifactReference;
        readonly recoveryArtifact: ArtifactReference;
        readonly inversePlanArtifact: ArtifactReference | null;
        readonly terminalIntentRevision: Sha256Digest;
      };
  readonly recovery_complete: {
    readonly receiptArtifact: ArtifactReference;
    readonly staleLockReleased: boolean;
    readonly recoveryLockReleased: boolean;
  };
}

interface FailureEvidence {
  readonly issueCode: string;
  readonly message: string;
  readonly mutationStatus: "not_committed" | "committed" | "uncertain";
  readonly backupArtifact: ArtifactReference | null;
  readonly recoveryArtifact: ArtifactReference | null;
  readonly inversePlanArtifact: ArtifactReference | null;
}

export type ApplyJournalEntry = {
  readonly [Stage in ApplyJournalStage]: {
    readonly stage: Stage;
    readonly at: string;
    readonly evidence: ApplyJournalEvidenceByStage[Stage];
  }
}[ApplyJournalStage];

export interface ApplyJournal {
  readonly schemaVersion: typeof APPLY_JOURNAL_SCHEMA;
  readonly transactionId: string;
  readonly planId: string;
  readonly planDigest: Sha256Digest;
  readonly authorizationRevision: Sha256Digest;
  readonly profileId: string;
  readonly targetPathRevision: Sha256Digest;
  stage: ApplyJournalStage;
  history: ApplyJournalEntry[];
}

export interface CreateApplyJournalInput {
  readonly transactionId: string;
  readonly planId: string;
  readonly planDigest: Sha256Digest;
  readonly authorizationRevision: Sha256Digest;
  readonly profileId: string;
  readonly targetPathRevision: Sha256Digest;
}

export function createApplyJournal(input: CreateApplyJournalInput, at = new Date()): ApplyJournal {
  const initializedAt = canonicalTimestamp(at.toISOString(), "Apply journal initialized timestamp");
  return defineApplyJournal({
    schemaVersion: APPLY_JOURNAL_SCHEMA,
    ...input,
    stage: "initialized",
    history: [{ stage: "initialized", at: initializedAt, evidence: {} }]
  });
}

export function appendApplyJournal<Stage extends ApplyJournalStage>(
  journal: ApplyJournal,
  stage: Stage,
  evidence: ApplyJournalEvidenceByStage[Stage],
  at = new Date()
): void {
  if (journal.history.length >= APPLY_JOURNAL_LIMITS.maxHistoryEntries) {
    throw new Error(`Apply journal history exceeds ${APPLY_JOURNAL_LIMITS.maxHistoryEntries} entries`);
  }
  const previous = journal.history.at(-1);
  if (previous?.stage === "recovery_receipt_prepared"
    && "terminalIntentRevision" in previous.evidence
    && stage !== "recovery_complete") {
    throw new Error("Intent-bound recovery preparation may transition only to recovery_complete");
  }
  validateTransition(journal.stage, stage);
  validateEvidence(stage, evidence as Readonly<Record<string, unknown>>);
  const timestamp = canonicalTimestamp(at.toISOString(), `Apply journal ${stage} timestamp`);
  if (previous && Date.parse(timestamp) < Date.parse(previous.at)) {
    throw new Error("Apply journal timestamps are not monotonic");
  }
  journal.stage = stage;
  journal.history.push({ stage, at: timestamp, evidence } as ApplyJournalEntry);
}

/**
 * Binds the current recovery controls without allowing crash/retry loops to
 * consume the bounded audit history. Only a final control-acquired entry may
 * be replaced, and its first durable timestamp is preserved. Any intervening
 * audit stage remains immutable and receives at most one later control entry.
 */
export function bindApplyRecoveryControl(
  journal: ApplyJournal,
  evidence: ApplyJournalEvidenceByStage["recovery_control_acquired"],
  at = new Date()
): void {
  validateEvidence("recovery_control_acquired", evidence as Readonly<Record<string, unknown>>);
  const current = journal.history.at(-1);
  if (current?.stage !== "recovery_control_acquired") {
    appendApplyJournal(journal, "recovery_control_acquired", evidence, at);
    return;
  }
  journal.history[journal.history.length - 1] = {
    stage: "recovery_control_acquired",
    at: current.at,
    evidence
  };
  journal.stage = "recovery_control_acquired";
  defineApplyJournal(journal);
}

export function defineApplyJournal(value: unknown): ApplyJournal {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Apply recovery journal must be an object");
  }
  const journal = value as ApplyJournal;
  assertExactKeys(journal as unknown as Record<string, unknown>, [
    "schemaVersion",
    "transactionId",
    "planId",
    "planDigest",
    "authorizationRevision",
    "profileId",
    "targetPathRevision",
    "stage",
    "history"
  ], "Apply recovery journal");
  if (
    journal.schemaVersion !== APPLY_JOURNAL_SCHEMA
    || !/^apply:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(journal.transactionId)
    || !boundedText(journal.planId, APPLY_JOURNAL_LIMITS.maxIdentityBytes)
    || !boundedText(journal.profileId, APPLY_JOURNAL_LIMITS.maxIdentityBytes)
  ) {
    throw new Error("Apply recovery journal has invalid identity");
  }
  assertDigest(journal.planDigest, "Apply recovery Plan digest");
  assertDigest(journal.authorizationRevision, "Apply recovery Authorization revision");
  assertDigest(journal.targetPathRevision, "Apply recovery target path revision");
  if (!Array.isArray(journal.history) || journal.history.length === 0) {
    throw new Error("Apply recovery journal history is empty");
  }
  if (journal.history.length > APPLY_JOURNAL_LIMITS.maxHistoryEntries) {
    throw new Error(`Apply recovery journal history exceeds ${APPLY_JOURNAL_LIMITS.maxHistoryEntries} entries`);
  }
  let previousStage: ApplyJournalStage | null = null;
  let previousEntry: ApplyJournalEntry | null = null;
  let previousAt = -Infinity;
  for (const rawEntry of journal.history as unknown[]) {
    if (!rawEntry || typeof rawEntry !== "object" || Array.isArray(rawEntry)) {
      throw new Error("Apply recovery journal history entry is invalid");
    }
    const entry = rawEntry as ApplyJournalEntry;
    assertExactKeys(entry as unknown as Record<string, unknown>, ["stage", "at", "evidence"], "Apply journal entry");
    const at = Date.parse(canonicalTimestamp(entry.at, "Apply recovery journal entry timestamp"));
    if (at < previousAt) throw new Error("Apply recovery journal timestamps are not monotonic");
    if (!entry.evidence || typeof entry.evidence !== "object" || Array.isArray(entry.evidence)) {
      throw new Error("Apply recovery journal evidence must be an object");
    }
    if (previousEntry?.stage === "recovery_receipt_prepared"
      && "terminalIntentRevision" in previousEntry.evidence
      && entry.stage !== "recovery_complete") {
      throw new Error("Intent-bound recovery preparation may transition only to recovery_complete");
    }
    validateTransition(previousStage, entry.stage);
    validateEvidence(entry.stage, entry.evidence as Readonly<Record<string, unknown>>);
    previousStage = entry.stage;
    previousEntry = entry;
    previousAt = at;
  }
  if (journal.stage !== journal.history.at(-1)?.stage) {
    throw new Error("Apply recovery journal stage does not match its final history entry");
  }
  assertStableArtifact(journal, "backupArtifact");
  assertStableArtifact(journal, "recoveryArtifact");
  assertStableArtifact(journal, "preparedArtifact");
  assertStableArtifact(journal, "inversePlanArtifact");
  assertTemporaryReconciliationBindings(journal);
  return journal;
}

export function journalEntry<Stage extends ApplyJournalStage>(
  journal: ApplyJournal,
  stage: Stage
): Extract<ApplyJournalEntry, { readonly stage: Stage }> | null {
  return [...journal.history].reverse().find((entry) => entry.stage === stage) as
    Extract<ApplyJournalEntry, { readonly stage: Stage }> | undefined ?? null;
}

export function journalLockRevision(journal: ApplyJournal): Sha256Digest | null {
  return journalEntry(journal, "recovery_control_acquired")?.evidence.lockRevision
    ?? journalEntry(journal, "locked")?.evidence.lockRevision
    ?? null;
}

export function journalBeforeFingerprint(journal: ApplyJournal): JsonLz4Fingerprint | null {
  return journalEntry(journal, "preflight_ok")?.evidence.sourceFingerprint ?? null;
}

export function journalPreparedDigest(journal: ApplyJournal): Sha256Digest | null {
  return journalEntry(journal, "write_prepared")?.evidence.preparedDigest ?? null;
}

export function journalCommitStageSeen(journal: ApplyJournal): boolean {
  return journal.history.some((entry) =>
    ["write_committed", "verified", "released"].includes(entry.stage)
    || (entry.stage === "interrupted" && entry.evidence.mutationStatus === "committed")
  );
}

export function journalArtifactReference(journal: ApplyJournal, key: string): ArtifactReference | null {
  for (const entry of [...journal.history].reverse()) {
    const value = (entry.evidence as unknown as Record<string, unknown>)[key];
    if (isArtifactReference(value)) return value;
  }
  return null;
}

function validateTransition(previous: ApplyJournalStage | null, next: unknown): asserts next is ApplyJournalStage {
  const allowed: Readonly<Record<string, readonly ApplyJournalStage[]>> = {
    "<start>": ["initialized"],
    initialized: ["locked", "preflight_blocked", "recovery_control_acquired", "recovery_receipt_prepared"],
    locked: ["preflight_ok", "preflight_blocked", "recovery_control_acquired", "recovery_receipt_prepared"],
    preflight_ok: ["backup_published", "preflight_blocked", "recovery_control_acquired", "recovery_receipt_prepared"],
    backup_published: ["write_prepared", "preflight_blocked", "recovery_control_acquired", "recovery_receipt_prepared"],
    write_prepared: ["write_committed", "preflight_blocked", "interrupted", "recovery_control_acquired", "recovery_temporary_preserved", "recovery_receipt_prepared"],
    write_committed: ["verified", "interrupted", "recovery_control_acquired", "recovery_receipt_prepared"],
    verified: ["released", "interrupted", "recovery_control_acquired", "recovery_receipt_prepared"],
    released: ["interrupted", "recovery_control_acquired", "recovery_receipt_prepared"],
    preflight_blocked: ["failure_recorded", "recovery_control_acquired", "recovery_receipt_prepared"],
    interrupted: ["failure_recorded", "recovery_control_acquired", "recovery_receipt_prepared"],
    failure_recorded: ["recovery_control_acquired", "recovery_receipt_prepared", "recovery_complete"],
    recovery_control_acquired: ["recovery_control_acquired", "recovery_temporary_preserved", "recovery_temporary_closed", "recovery_receipt_prepared", "recovery_complete"],
    recovery_temporary_preserved: ["recovery_control_acquired", "recovery_temporary_closed"],
    recovery_temporary_closed: ["recovery_control_acquired", "recovery_receipt_prepared"],
    recovery_receipt_prepared: ["recovery_control_acquired", "recovery_receipt_prepared", "recovery_complete"],
    recovery_complete: []
  };
  const from = previous ?? "<start>";
  if (typeof next !== "string" || !allowed[from]?.includes(next as ApplyJournalStage)) {
    throw new Error(`Apply recovery journal has invalid stage transition ${from} -> ${String(next)}`);
  }
}

function validateEvidence(stage: ApplyJournalStage, evidence: Readonly<Record<string, unknown>>): void {
  switch (stage) {
    case "initialized":
      assertExactKeys(evidence, [], stage);
      return;
    case "locked":
      assertExactKeys(evidence, ["lockRevision", "nativeControlLeaseRevision", "authorizedActionIds"], stage);
      if (!isDigest(evidence.lockRevision)
        || !isDigest(evidence.nativeControlLeaseRevision)
        || !Array.isArray(evidence.authorizedActionIds)
        || evidence.authorizedActionIds.length === 0
        || evidence.authorizedActionIds.length > APPLY_JOURNAL_LIMITS.maxAuthorizedActionIds
        || new Set(evidence.authorizedActionIds).size !== evidence.authorizedActionIds.length
        || evidence.authorizedActionIds.some((value) =>
          !boundedText(value, APPLY_JOURNAL_LIMITS.maxIdentityBytes))) {
        throw new Error("Apply recovery locked evidence is invalid");
      }
      return;
    case "preflight_ok":
      if (Object.hasOwn(evidence, "expectedAfterSnapshotRevision")
        || Object.hasOwn(evidence, "inversePlanArtifact")) {
        assertExactKeys(evidence, [
          "beforeSnapshotRevision",
          "expectedAfterSnapshotRevision",
          "sourceFingerprint",
          "operationCount",
          "inversePlanArtifact"
        ], stage);
        assertArtifacts(evidence, ["inversePlanArtifact"], stage);
        if (!isDigest(evidence.expectedAfterSnapshotRevision)) {
          throw new Error("Apply recovery preflight expected after-Snapshot is invalid");
        }
      } else {
        assertExactKeys(evidence, ["beforeSnapshotRevision", "sourceFingerprint", "operationCount"], stage);
      }
      if (!isDigest(evidence.beforeSnapshotRevision)
        || !isFingerprint(evidence.sourceFingerprint)
        || !Number.isSafeInteger(evidence.operationCount)
        || (evidence.operationCount as number) < 1
        || (evidence.operationCount as number) > APPLY_JOURNAL_LIMITS.maxAuthorizedActionIds) {
        throw new Error("Apply recovery preflight evidence is invalid");
      }
      return;
    case "backup_published":
    case "write_committed":
      assertExactKeys(evidence, ["backupArtifact", "recoveryArtifact"], stage);
      assertArtifacts(evidence, ["backupArtifact", "recoveryArtifact"], stage);
      return;
    case "write_prepared":
      assertExactKeys(evidence, ["backupArtifact", "recoveryArtifact", "temporaryPathRevision", "preparedDigest"], stage);
      assertArtifacts(evidence, ["backupArtifact", "recoveryArtifact"], stage);
      if (!isDigest(evidence.temporaryPathRevision) || !isDigest(evidence.preparedDigest)) {
        throw new Error("Apply recovery write-prepared evidence is invalid");
      }
      return;
    case "verified":
      assertExactKeys(evidence, ["afterSnapshotRevision", "afterSourceFingerprint", "inversePlanArtifact"], stage);
      assertArtifacts(evidence, ["inversePlanArtifact"], stage);
      if (!isDigest(evidence.afterSnapshotRevision) || !isFingerprint(evidence.afterSourceFingerprint)) {
        throw new Error("Apply recovery verification evidence is invalid");
      }
      return;
    case "released":
      assertExactKeys(evidence, ["releasedAt", "controlArtifact", "receiptId", "inversePlanArtifact"], stage);
      assertArtifacts(evidence, ["controlArtifact", "inversePlanArtifact"], stage);
      assertReceiptId(evidence.receiptId);
      canonicalTimestamp(evidence.releasedAt, "Apply recovery release timestamp");
      return;
    case "preflight_blocked":
    case "interrupted":
      assertExactKeys(evidence, [
        "issueCode", "message", "mutationStatus", "backupArtifact", "recoveryArtifact", "inversePlanArtifact"
      ], stage);
      if (!boundedText(evidence.issueCode, APPLY_JOURNAL_LIMITS.maxIssueCodeBytes)
        || !boundedText(evidence.message, APPLY_JOURNAL_LIMITS.maxMessageBytes)
        || !(["not_committed", "committed", "uncertain"] as const).includes(
          evidence.mutationStatus as "not_committed" | "committed" | "uncertain"
        )) {
        throw new Error(`Apply recovery ${stage} evidence is invalid`);
      }
      for (const key of ["backupArtifact", "recoveryArtifact", "inversePlanArtifact"] as const) {
        if (evidence[key] !== null && !isArtifactReference(evidence[key])) {
          throw new Error(`Apply recovery ${stage} ${key} is invalid`);
        }
      }
      return;
    case "failure_recorded":
      assertExactKeys(evidence, ["controlArtifact", "releaseStatus", "releasedAt", "receiptId"], stage);
      assertArtifacts(evidence, ["controlArtifact"], stage);
      assertReceiptId(evidence.receiptId);
      if (!(["verified", "unknown"] as const).includes(evidence.releaseStatus as "verified" | "unknown")) {
        throw new Error("Apply recovery failure release status is invalid");
      }
      if (evidence.releaseStatus === "verified") {
        canonicalTimestamp(evidence.releasedAt, "Apply recovery failure release timestamp");
      } else if (evidence.releasedAt !== null) {
        throw new Error("Apply recovery unknown release status cannot include a release timestamp");
      }
      return;
    case "recovery_control_acquired":
      assertExactKeys(evidence, ["lockRevision", "nativeControlLeaseRevision"], stage);
      if (!isDigest(evidence.lockRevision) || !isDigest(evidence.nativeControlLeaseRevision)) {
        throw new Error("Apply recovery control revision is invalid");
      }
      return;
    case "recovery_receipt_prepared":
      if (Object.hasOwn(evidence, "terminalIntentRevision")) {
        assertExactKeys(evidence, [
          "issueCode", "controlArtifact", "recoveryArtifact", "inversePlanArtifact", "terminalIntentRevision"
        ], stage);
        if (!isDigest(evidence.terminalIntentRevision)) {
          throw new Error("Apply recovery terminal intent revision is invalid");
        }
      } else {
        assertExactKeys(evidence, ["issueCode", "controlArtifact", "recoveryArtifact", "inversePlanArtifact"], stage);
      }
      if (!boundedText(evidence.issueCode, APPLY_JOURNAL_LIMITS.maxIssueCodeBytes)) {
        throw new Error("Apply recovery receipt-prepared issue code is invalid");
      }
      assertArtifacts(evidence, ["controlArtifact", "recoveryArtifact"], stage);
      if (evidence.inversePlanArtifact !== null && !isArtifactReference(evidence.inversePlanArtifact)) {
        throw new Error("Apply recovery receipt-prepared inverse artifact is invalid");
      }
      return;
    case "recovery_temporary_preserved":
      assertExactKeys(evidence, ["temporaryPathRevision", "preparedArtifact", "completeness", "preservedAt"], stage);
      assertArtifacts(evidence, ["preparedArtifact"], stage);
      if (!isDigest(evidence.temporaryPathRevision)
        || !["complete", "incomplete", "external_writer"].includes(evidence.completeness as string)) {
        throw new Error("Apply recovery preserved temporary evidence is invalid");
      }
      canonicalTimestamp(evidence.preservedAt, "Apply recovery temporary preservation timestamp");
      return;
    case "recovery_temporary_closed":
      assertExactKeys(evidence, ["temporaryPathRevision", "preparedArtifact", "disposition", "closedAt"], stage);
      assertArtifacts(evidence, ["preparedArtifact"], stage);
      if (!isDigest(evidence.temporaryPathRevision)
        || !["removed", "observed_absent"].includes(evidence.disposition as string)) {
        throw new Error("Apply recovery closed temporary evidence is invalid");
      }
      canonicalTimestamp(evidence.closedAt, "Apply recovery temporary closure timestamp");
      return;
    case "recovery_complete":
      assertExactKeys(evidence, ["receiptArtifact", "staleLockReleased", "recoveryLockReleased"], stage);
      assertArtifacts(evidence, ["receiptArtifact"], stage);
      if (typeof evidence.staleLockReleased !== "boolean" || typeof evidence.recoveryLockReleased !== "boolean") {
        throw new Error("Apply recovery completion evidence is invalid");
      }
      return;
  }
}

function assertStableArtifact(journal: ApplyJournal, key: string): void {
  const bindings = new Set<string>();
  for (const entry of journal.history) {
    const value = (entry.evidence as unknown as Record<string, unknown>)[key];
    if (isArtifactReference(value)) bindings.add(`${value.id}:${value.digest}`);
  }
  if (bindings.size > 1) throw new Error(`Apply recovery journal changes its ${key} binding`);
}

function assertTemporaryReconciliationBindings(journal: ApplyJournal): void {
  const prepared = journalEntry(journal, "write_prepared");
  const preservedEntries = journal.history.filter((entry) => entry.stage === "recovery_temporary_preserved");
  const closedEntries = journal.history.filter((entry) => entry.stage === "recovery_temporary_closed");
  if (preservedEntries.length > 1 || closedEntries.length > 1) {
    throw new Error("Apply recovery journal repeats temporary reconciliation evidence");
  }
  const preserved = preservedEntries[0];
  const closed = closedEntries[0];
  if (preserved) {
    if (!prepared || preserved.evidence.temporaryPathRevision !== prepared.evidence.temporaryPathRevision) {
      throw new Error("Apply recovery preserved temporary does not match write preparation");
    }
    const expectedId = preserved.evidence.completeness === "complete"
      ? `prepared-image:${journal.transactionId}`
      : preserved.evidence.completeness === "external_writer"
        ? `displaced-writer:${journal.transactionId}`
        : `prepared-fragment:${journal.transactionId}`;
    if (preserved.evidence.preparedArtifact.id !== expectedId) {
      throw new Error("Apply recovery preserved temporary artifact id is invalid");
    }
    if (preserved.evidence.completeness === "complete"
      && preserved.evidence.preparedArtifact.digest !== prepared.evidence.preparedDigest) {
      throw new Error("Apply recovery preserved image does not match the prepared digest");
    }
    if (preserved.evidence.completeness !== "complete"
      && preserved.evidence.preparedArtifact.digest === prepared.evidence.preparedDigest) {
      throw new Error("Apply recovery non-plan residue cannot match the complete prepared digest");
    }
  }
  if (closed) {
    if (!preserved
      || closed.evidence.temporaryPathRevision !== preserved.evidence.temporaryPathRevision
      || closed.evidence.preparedArtifact.id !== preserved.evidence.preparedArtifact.id
      || closed.evidence.preparedArtifact.digest !== preserved.evidence.preparedArtifact.digest) {
      throw new Error("Apply recovery temporary closure does not match preserved evidence");
    }
  }
  if (preserved && !closed && journal.history.some((entry) => entry.stage === "recovery_receipt_prepared")) {
    throw new Error("Apply recovery Receipt was prepared before temporary reconciliation closed");
  }
}

function assertArtifacts(evidence: Readonly<Record<string, unknown>>, keys: readonly string[], stage: string): void {
  for (const key of keys) {
    if (!isArtifactReference(evidence[key])) throw new Error(`Apply recovery ${stage} ${key} is invalid`);
  }
}

function assertReceiptId(value: unknown): void {
  if (typeof value !== "string"
    || !/^receipt:apply:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)) {
    throw new Error("Apply recovery Receipt id is invalid");
  }
}

function assertExactKeys(value: Readonly<Record<string, unknown>>, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const sorted = [...expected].sort();
  if (actual.length !== sorted.length || actual.some((key, index) => key !== sorted[index])) {
    throw new Error(`${label} contains unknown or missing fields`);
  }
}

function isArtifactReference(value: unknown): value is ArtifactReference {
  return Boolean(value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value as object).length === 2
    && Object.hasOwn(value as object, "id")
    && Object.hasOwn(value as object, "digest")
    && boundedText((value as { id?: unknown }).id, APPLY_JOURNAL_LIMITS.maxIdentityBytes)
    && isDigest((value as { digest?: unknown }).digest));
}

function isFingerprint(value: unknown): value is JsonLz4Fingerprint {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value).sort();
  const expected = ["digest", "size", "mode", "modifiedMs", "changedMs", "device", "inode"].sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) return false;
  const candidate = value as Partial<JsonLz4Fingerprint>;
  return isDigest(candidate.digest)
    && Number.isSafeInteger(candidate.size)
    && (candidate.size as number) >= 0
    && (candidate.size as number) <= APPLY_JOURNAL_LIMITS.maxFingerprintBytes
    && Number.isSafeInteger(candidate.mode)
    && (candidate.mode as number) >= 0
    && (candidate.mode as number) <= 0o7777
    && [candidate.modifiedMs, candidate.changedMs]
      .every((entry) => typeof entry === "number" && Number.isFinite(entry) && entry >= 0)
    && [candidate.device, candidate.inode]
      .every((entry) => Number.isSafeInteger(entry) && (entry as number) >= 0);
}

function boundedText(value: unknown, maxBytes: number): value is string {
  return typeof value === "string"
    && value.trim().length > 0
    && Buffer.byteLength(value, "utf8") <= maxBytes;
}

function isDigest(value: unknown): value is Sha256Digest {
  return typeof value === "string" && /^sha256:[a-f0-9]{64}$/u.test(value);
}

function assertDigest(value: string, label: string): asserts value is Sha256Digest {
  if (!isDigest(value)) throw new Error(`${label} must be a canonical SHA-256 digest`);
}

function canonicalTimestamp(value: unknown, label: string): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new Error(`${label} must be a canonical timestamp`);
  }
  const canonical = new Date(value).toISOString();
  if (canonical !== value) throw new Error(`${label} must use canonical ISO-8601 form`);
  return canonical;
}

export function applyJournalRevision(journal: ApplyJournal): Sha256Digest {
  return sha256Canonical(defineApplyJournal(structuredClone(journal)));
}
