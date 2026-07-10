import { randomUUID } from "node:crypto";
import { readdir } from "node:fs/promises";
import {
  createApplyAuthorization,
  createPlan,
  createProtectionGrant,
  defineApplyAuthorization,
  definePlan,
  definePlanForSnapshot,
  defineReceipt
} from "./domain/change.js";
import { sha256Canonical } from "./domain/digest.js";
import { loadConfig } from "./config.js";
import {
  readJsonLz4State,
  sameJsonLz4Fingerprint,
  writeJsonLz4Durable
} from "./mozlz4.js";
import { stateDir } from "./paths.js";
import { findSessionFile } from "./profile.js";
import { acquireProfileTransactionLock } from "./profile-lock.js";
import { findZenProcesses } from "./processes.js";
import {
  ensurePrivateDirectory,
  privatePath,
  publishPrivateBytes,
  publishPrivateJson,
  readPrivateJson,
  replacePrivateJson
} from "./private-store.js";
import { defineRawSession, summarizeSession, withWorkspacePolicy } from "./session.js";
import { sessionTabBindings, snapshotFromSession } from "./session-snapshot.js";

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
import { loadStoredPlan, type StoredPlan } from "./plans.js";
import type { ProfileContext } from "./profile.js";
import type { RawZenSession } from "./session.js";

const JOURNAL_SCHEMA = "zts.apply-journal.provisional-1" as const;
const CONSENT_SCHEMA = "zts.invocation-consent.provisional-1" as const;
const BACKUP_SCHEMA = "zts.session-backup.provisional-1" as const;
const RECOVERY_SCHEMA = "zts.apply-recovery.provisional-1" as const;
const CONTROL_SCHEMA = "zts.closed-session-control-proof.provisional-1" as const;

type MoveAction = Extract<PlanAction, { readonly disposition: "move" }>;

export interface ApplyTransactionResult {
  readonly snapshot: Snapshot;
  readonly plan: Plan;
  readonly authorization: ApplyAuthorization;
  readonly receipt: Receipt;
  readonly receiptPath: string;
  readonly applied: true;
  readonly summary: {
    readonly moveCount: number;
  };
  readonly artifacts: readonly ({ readonly kind: string } & ArtifactReference)[];
}

export interface ApplyTransactionBlockedResult {
  readonly snapshot: Snapshot;
  readonly plan: Plan;
  readonly authorization: ApplyAuthorization;
  readonly receipt: Receipt;
  readonly receiptPath: string;
  readonly applied: false;
  readonly blocker: string;
  readonly summary: {
    readonly moveCount: number;
  };
  readonly artifacts: readonly ({ readonly kind: string } & ArtifactReference)[];
}

export type ApplyTransactionOutcome = ApplyTransactionResult | ApplyTransactionBlockedResult;

export interface TransactionReceiptSummary {
  readonly id: string;
  readonly kind: "saved_plan";
  readonly outcome: Receipt["outcome"];
  readonly planId: string;
  readonly planDigest: string;
  readonly completedAt: string;
  readonly operationCount: number;
  readonly receiptPath: string;
}

export interface TransactionReceiptVerificationReport {
  readonly receiptId: string;
  readonly profileId: string;
  readonly receiptPath: string;
  readonly receipt: Receipt;
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
  readonly now?: Date;
  /** Internal orchestration hook used by crash/failure acceptance harnesses. */
  readonly afterCommit?: () => void | Promise<void>;
}

interface ApplyLayout {
  readonly root: string;
  readonly transactions: string;
  readonly consents: string;
  readonly authorizations: string;
  readonly backups: string;
  readonly backupManifests: string;
  readonly recoveries: string;
  readonly inverses: string;
  readonly journals: string;
  readonly controls: string;
  readonly receipts: string;
}

interface JournalHistoryEntry {
  readonly stage: string;
  readonly at: string;
  readonly evidence: Readonly<Record<string, unknown>>;
}

interface MutableJournal {
  readonly schemaVersion: typeof JOURNAL_SCHEMA;
  readonly transactionId: string;
  readonly planId: string;
  readonly planDigest: Sha256Digest;
  readonly authorizationRevision: Sha256Digest;
  readonly profileId: string;
  readonly targetPathRevision: Sha256Digest;
  stage: string;
  history: JournalHistoryEntry[];
}

export async function applyStoredPlanClosedSession(
  initialContext: ProfileContext,
  stored: StoredPlan,
  options: ApplyStoredPlanOptions
): Promise<ApplyTransactionOutcome> {
  const plan = stored.plan;
  if (options.expectedDigest !== plan.digest) {
    throw new Error(`Expected Plan digest ${options.expectedDigest} does not match selected Plan ${plan.digest}`);
  }
  definePlanForSnapshot(stored.snapshot, plan);
  if (plan.snapshotAuthority !== "authoritative" || plan.snapshotFreshness !== "current") {
    throw new Error("Saved Plan apply requires a Plan created from a current authoritative Snapshot");
  }
  const authorizedAt = canonicalTimestamp(options.now ?? new Date());
  if (Date.parse(plan.expiresAt) <= Date.parse(authorizedAt)) {
    throw new Error(`Saved Plan ${plan.digest} expired at ${plan.expiresAt}; create a fresh preview`);
  }
  if (initialContext.profile.id !== plan.profileId) throw new Error("Selected Plan belongs to a different Zen Profile");
  const moveActions = executableActions(plan);
  const transactionId = `apply:${randomUUID()}`;
  const receiptId = `receipt:${transactionId}`;
  const layout = await applyLayout(plan.profileId);
  const transactionRoot = await ensurePrivateDirectory(layout.transactions, safeSegment(transactionId));
  const journalPath = privatePath(transactionRoot, "journal.json");

  const consent = {
    schemaVersion: CONSENT_SCHEMA,
    transactionId,
    planId: plan.id,
    planDigest: plan.digest,
    confirmedDigest: options.expectedDigest,
    confirmedAt: authorizedAt,
    commandRevision: sha256Canonical({ command: options.command })
  };
  const consentArtifact = artifact(`consent:${transactionId}`, sha256Canonical(consent));
  await publishPrivateJson(objectPath(layout.consents, consentArtifact.digest, "json"), consent);

  const authorization = createAuthorization(stored.snapshot, plan, moveActions, consentArtifact, transactionId, authorizedAt);
  const authorizationArtifact = artifact(authorization.id, authorization.revision);
  await publishPrivateJson(objectPath(layout.authorizations, authorization.revision, "json"), authorization);

  const lock = await acquireProfileTransactionLock(initialContext.profile, options.command, new Date(authorizedAt));
  let lockReleased = false;
  let lockReleaseAttempted = false;
  let mutationCommitted = false;
  let observedSnapshot = stored.snapshot;
  let backupArtifact: ArtifactReference | null = null;
  let recoveryArtifact: ArtifactReference | null = null;
  let inversePlanArtifact: ArtifactReference | null = null;
  const processChecks: Array<Readonly<Record<string, unknown>>> = [];
  const journal: MutableJournal = {
    schemaVersion: JOURNAL_SCHEMA,
    transactionId,
    planId: plan.id,
    planDigest: plan.digest,
    authorizationRevision: authorization.revision,
    profileId: plan.profileId,
    targetPathRevision: sha256Canonical({ path: initialContext.sessionFile.path }),
    stage: "locked",
    history: []
  };
  const updateJournal = async (stage: string, evidence: Readonly<Record<string, unknown>> = {}) => {
    journal.stage = stage;
    journal.history.push({ stage, at: new Date().toISOString(), evidence });
    await replacePrivateJson(journalPath, journal);
  };

  try {
    await updateJournal("locked", {
      lockRevision: lock.artifactRevision,
      authorizedActionIds: authorization.authorizedActionIds
    });
    const loadedConfig = await loadConfig();
    const currentContext = await refreshTargetContext(initialContext);
    processChecks.push(processCheck("after_lock", currentContext));
    assertClosedSessionRoute(currentContext);
    const beforeState = await readJsonLz4State(currentContext.sessionFile.path);
    const beforeSession = defineRawSession(beforeState.value);
    const beforeSummary = withWorkspacePolicy(
      summarizeSession(beforeSession, currentContext.sessionFile),
      loadedConfig.config
    );
    const beforeSnapshot = snapshotFromSession(currentContext, beforeSession, beforeSummary);
    observedSnapshot = beforeSnapshot;
    definePlanForSnapshot(beforeSnapshot, plan);
    const bindings = preflightOperations(beforeSnapshot, beforeSession, beforeSummary, moveActions);
    await updateJournal("preflight_ok", {
      beforeSnapshotRevision: beforeSnapshot.revision,
      sourceFingerprint: beforeState.fingerprint,
      operationCount: moveActions.length
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
      beforeCommit: async (prepared) => {
        await updateJournal("write_prepared", {
          backupArtifact,
          recoveryArtifact,
          temporaryPathRevision: sha256Canonical({ path: prepared.temporaryPath }),
          preparedDigest: prepared.encodedDigest
        });
        const finalContext = await refreshTargetContext(initialContext);
        processChecks.push(processCheck("before_commit", finalContext));
        assertClosedSessionRoute(finalContext);
        const finalState = await readJsonLz4State(finalContext.sessionFile.path);
        if (!sameJsonLz4Fingerprint(beforeState.fingerprint, finalState.fingerprint)) {
          throw new Error("Whole-Plan preflight failed: Zen session file Drift was detected before commit");
        }
        const finalSession = defineRawSession(finalState.value);
        const finalSummary = withWorkspacePolicy(
          summarizeSession(finalSession, finalContext.sessionFile),
          loadedConfig.config
        );
        const finalSnapshot = snapshotFromSession(finalContext, finalSession, finalSummary);
        definePlanForSnapshot(finalSnapshot, plan);
        preflightOperations(finalSnapshot, finalSession, finalSummary, moveActions);
      },
      onCommitted: () => {
        mutationCommitted = true;
      }
    });
    await updateJournal("write_committed", { backupArtifact, recoveryArtifact });
    await options.afterCommit?.();

    const verificationContext = await refreshTargetContext(initialContext);
    processChecks.push(processCheck("after_commit", verificationContext));
    assertClosedSessionRoute(verificationContext);
    const afterState = await readJsonLz4State(verificationContext.sessionFile.path);
    const afterSession = defineRawSession(afterState.value);
    const afterSummary = withWorkspacePolicy(
      summarizeSession(afterSession, verificationContext.sessionFile),
      loadedConfig.config
    );
    const afterSnapshot = snapshotFromSession(verificationContext, afterSession, afterSummary);
    observedSnapshot = afterSnapshot;
    const operations = verifyOperations(afterSnapshot, moveActions);
    const inversePlan = createInversePlan(afterSnapshot, plan, moveActions, new Date());
    inversePlanArtifact = artifact(inversePlan.id, inversePlan.digest);
    await publishPrivateJson(objectPath(layout.inverses, inversePlan.digest, "json"), inversePlan);
    await updateJournal("verified", {
      afterSnapshotRevision: afterSnapshot.revision,
      afterSourceFingerprint: afterState.fingerprint,
      inversePlanArtifact
    });

    lockReleaseAttempted = true;
    const released = await lock.release();
    lockReleased = true;
    const controlProof = {
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
      control: {
        route: "closed_session",
        proof: controlArtifact,
        exclusiveControlReleased: "verified"
      },
      backupArtifact,
      inversePlanArtifact,
      recoveryArtifact: null,
      operations
    });
    const receiptArtifact = artifact(receipt.id, sha256Canonical(receipt));
    const receiptPath = objectPath(layout.receipts, receiptArtifact.digest, "json");
    await publishPrivateJson(receiptPath, receipt);
    return {
      snapshot: beforeSnapshot,
      plan,
      authorization,
      receipt,
      receiptPath,
      applied: true,
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
    const issueCode = mutationCommitted ? "apply_interrupted" : classifyPreflightIssue(blocker);
    try {
      await updateJournal(mutationCommitted ? "interrupted" : "preflight_blocked", {
        issueCode,
        message: blocker,
        mutationCommitted,
        backupArtifact,
        recoveryArtifact,
        inversePlanArtifact
      });
      let releasedAt: string | null = null;
      let releaseStatus: "verified" | "unknown" = "unknown";
      if (!lockReleaseAttempted) {
        lockReleaseAttempted = true;
        try {
          const released = await lock.release();
          releasedAt = released.releasedAt;
          releaseStatus = "verified";
          lockReleased = true;
        } catch {
          releaseStatus = "unknown";
        }
      }
      const controlProof = {
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
        zenProcessChecks: processChecks,
        failure: { issueCode, message: blocker, mutationCommitted }
      };
      const controlArtifact = artifact(`control:${transactionId}`, sha256Canonical(controlProof));
      await publishPrivateJson(objectPath(layout.controls, controlArtifact.digest, "json"), controlProof);
      await updateJournal("failure_recorded", {
        controlArtifact,
        releaseStatus,
        releasedAt,
        receiptId
      });
      const finalJournal = structuredClone(journal);
      const journalArtifact = artifact(`journal:${transactionId}`, sha256Canonical(finalJournal));
      await publishPrivateJson(objectPath(layout.journals, journalArtifact.digest, "json"), finalJournal);
      const completedAt = new Date().toISOString();
      const operations = mutationCommitted
        ? moveActions.map((action) => ({
            actionId: action.actionId,
            entityRef: action.operation.entityRef,
            observedWorkspaceId: observedSnapshot.entities.find((entity) => entity.ref === action.operation.entityRef)?.workspaceId ?? null,
            status: "failed" as const,
            mutationAttempted: true as const,
            netChanged: null,
            issueCodes: [issueCode] as [string]
          }))
        : moveActions.map((action) => ({
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
          severity: "error" as const,
          message: ztsMessage(blocker),
          actionId: null
        }],
        control: {
          route: "closed_session" as const,
          proof: controlArtifact,
          exclusiveControlReleased: releaseStatus
        }
      };
      const receipt = mutationCommitted
        ? defineReceipt(stored.snapshot, plan, authorization, {
            ...common,
            outcome: "interrupted",
            mutationAttempted: true,
            netChanged: null,
            afterSnapshotRevision: null,
            backupArtifact: requiredArtifact(backupArtifact, "Interrupted Receipt backup"),
            inversePlanArtifact,
            recoveryArtifact: requiredArtifact(recoveryArtifact, "Interrupted Receipt recovery"),
            operations: operations as unknown as Extract<Receipt, { readonly outcome: "interrupted" }>["operations"]
          })
        : defineReceipt(stored.snapshot, plan, authorization, {
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
      const receiptArtifact = artifact(receipt.id, sha256Canonical(receipt));
      const receiptPath = objectPath(layout.receipts, receiptArtifact.digest, "json");
      await publishPrivateJson(receiptPath, receipt);
      return {
        snapshot: observedSnapshot,
        plan,
        authorization,
        receipt,
        receiptPath,
        applied: false,
        blocker,
        summary: { moveCount: moveActions.length },
        artifacts: [
          { kind: "consent", ...consentArtifact },
          { kind: "authorization", ...authorizationArtifact },
          ...(backupArtifact ? [{ kind: "backup", ...backupArtifact }] : []),
          ...(inversePlanArtifact ? [{ kind: "inverse_plan", ...inversePlanArtifact }] : []),
          { kind: "journal", ...journalArtifact },
          { kind: "control_proof", ...controlArtifact },
          { kind: "receipt", ...receiptArtifact }
        ]
      };
    } catch (recordingError) {
      throw new AggregateError(
        [error, recordingError],
        mutationCommitted
          ? `Apply changed the session but durable failure recording was incomplete; use recovery artifact ${recoveryArtifact?.id ?? "(unavailable)"}`
          : "Apply was blocked before mutation, and its blocked Receipt could not be published"
      );
    }
  } finally {
    if (!lockReleased && !lockReleaseAttempted) await lock.release();
  }
}

export async function listTransactionReceipts(profileId: string): Promise<TransactionReceiptSummary[]> {
  const layout = await applyLayout(profileId);
  const entries = (await readdir(layout.receipts)).filter((entry) => entry.endsWith(".json")).sort().reverse();
  const receipts: TransactionReceiptSummary[] = [];
  for (const entry of entries) {
    const receiptPath = privatePath(layout.receipts, entry);
    const receipt = await loadTransactionReceiptAt(profileId, receiptPath, entry);
    receipts.push({
      id: receipt.id,
      kind: "saved_plan",
      outcome: receipt.outcome,
      planId: receipt.planId,
      planDigest: receipt.planDigest,
      completedAt: receipt.completedAt,
      operationCount: receipt.operations.length,
      receiptPath
    });
  }
  receipts.sort((left, right) => right.completedAt.localeCompare(left.completedAt));
  return receipts;
}

export async function verifyTransactionReceipt(
  context: ProfileContext,
  session: RawZenSession,
  summary: ReturnType<typeof summarizeSession>,
  receiptId: string
): Promise<TransactionReceiptVerificationReport> {
  const found = await findTransactionReceipt(context.profile.id, receiptId);
  if (!found) throw new Error(`Transaction apply receipt not found: ${receiptId}`);
  const blockers: string[] = [];
  if (context.running) blockers.push("Transaction receipt verification requires Zen to be closed for an authoritative Snapshot");
  if (found.receipt.profileId !== context.profile.id) blockers.push("Transaction receipt belongs to a different Profile");
  if (found.receipt.outcome !== "applied" && found.receipt.outcome !== "compensated") {
    blockers.push(`Receipt outcome ${found.receipt.outcome} is not a verified successful final state`);
  }
  const snapshot = snapshotFromSession(context, session, summary);
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
    verification: {
      ok: blockers.length === 0 && mismatches.length === 0,
      checkedOperations,
      mismatchCount: mismatches.length,
      blockers,
      mismatches
    }
  };
}

async function findTransactionReceipt(
  profileId: string,
  receiptId: string
): Promise<{ readonly receipt: Receipt; readonly receiptPath: string } | null> {
  const layout = await applyLayout(profileId);
  const entries = (await readdir(layout.receipts)).filter((entry) => entry.endsWith(".json"));
  for (const entry of entries) {
    const receiptPath = privatePath(layout.receipts, entry);
    const receipt = await loadTransactionReceiptAt(profileId, receiptPath, entry);
    if (receipt.id === receiptId) return { receipt, receiptPath };
  }
  return null;
}

async function loadTransactionReceiptAt(profileId: string, receiptPath: string, filename: string): Promise<Receipt> {
  const value = await readPrivateJson(receiptPath);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Transaction Receipt must be an object");
  const receipt = value as Receipt;
  const expectedFilename = `${digestHex(sha256Canonical(receipt))}.json`;
  if (filename !== expectedFilename) throw new Error("Transaction Receipt filename does not match its content digest");
  if (receipt.profileId !== profileId) throw new Error("Transaction Receipt Profile does not match its store");
  const stored = await loadStoredPlan(profileId, receipt.planDigest);
  const layout = await applyLayout(profileId);
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
    const inverseValue = await readPrivateJson(objectPath(layout.inverses, defined.inversePlanArtifact.digest, "json"));
    const inverse = definePlan(inverseValue as Plan);
    if (inverse.id !== defined.inversePlanArtifact.id || inverse.digest !== defined.inversePlanArtifact.digest) {
      throw new Error("Transaction inverse Plan artifact does not match its Receipt reference");
    }
  }
  return defined;
}

async function assertJsonArtifact(root: string, reference: ArtifactReference): Promise<void> {
  const value = await readPrivateJson(objectPath(root, reference.digest, "json"));
  if (sha256Canonical(value) !== reference.digest) {
    throw new Error(`Transaction artifact ${reference.id} does not match its Receipt digest`);
  }
}

function createAuthorization(
  snapshot: Snapshot,
  plan: Plan,
  moveActions: readonly MoveAction[],
  consentArtifact: ArtifactReference,
  transactionId: string,
  authorizedAt: string
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
    lifecycle: { kind: "none" },
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
  if (exclusive?.status !== "available") throw new Error("Closed-session apply lacks current exclusive Profile capability proof");
  if (moveTab?.status !== "available") throw new Error("Closed-session apply lacks current tab-move capability proof");
  const bindings = sessionTabBindings(snapshot, session, summary);
  const entities = new Map(snapshot.entities.map((entity) => [entity.ref, entity]));
  for (const action of moveActions) {
    if (action.operation.entityKind !== "tab") {
      throw new Error(`Closed-session apply does not yet support ${action.operation.entityKind} Operation ${action.actionId}`);
    }
    const entity = entities.get(action.operation.entityRef);
    const binding = bindings.get(action.operation.entityRef);
    if (!entity || !binding || entity.nativeId !== binding.nativeId) {
      throw new Error(`Whole-Plan preflight cannot bind ${action.operation.entityRef} to one exact native tab`);
    }
    if (binding.workspaceId !== action.operation.precondition.sourceWorkspace.workspaceId) {
      throw new Error(`Whole-Plan preflight found source Workspace Drift for ${action.operation.entityRef}`);
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

function createInversePlan(
  afterSnapshot: Snapshot,
  appliedPlan: Plan,
  moveActions: readonly MoveAction[],
  now: Date
): Plan {
  const createdAt = canonicalTimestamp(now);
  const expiresAt = new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString();
  const entities = new Map(afterSnapshot.entities.map((entity) => [entity.ref, entity]));
  const workspaces = new Map(afterSnapshot.workspaces.map((workspace) => [workspace.id, workspace]));
  const actions = moveActions.map((appliedAction, index): PlanAction => {
    const entity = entities.get(appliedAction.operation.entityRef);
    const source = entity ? workspaces.get(entity.workspaceId) : undefined;
    const destination = workspaces.get(appliedAction.operation.inverse.destinationWorkspaceId);
    if (!entity || entity.parentRef !== null || !source || !destination) {
      throw new Error(`Cannot construct inverse Operation for ${appliedAction.actionId}`);
    }
    const actionId = `inverse-${String(index + 1).padStart(4, "0")}:${appliedAction.actionId}`;
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
    id: `plan:inverse:${safeSegment(appliedPlan.id)}:${shortDigest(appliedPlan.digest)}`,
    configRevision: sha256Canonical({ inverseOfPlan: appliedPlan.digest }),
    engineManifestRevision: sha256Canonical({ inverseAdapter: "zts.closed-session.provisional-1" }),
    createdAt,
    expiresAt,
    derivation: { kind: "original" },
    source: {
      kind: "manual_patch",
      intentRevision: sha256Canonical({
        inverseOfPlan: appliedPlan.digest,
        operations: moveActions.map((action) => action.operation.inverse)
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
  const running = runningProcesses.some((candidate) =>
    candidate.profilePath === initial.profile.path || candidate.profilePath === undefined
  );
  return {
    ...initial,
    running,
    runningProcesses,
    sessionFile: await findSessionFile(initial.profile.path)
  };
}

function assertClosedSessionRoute(context: ProfileContext): void {
  if (context.running) throw new Error("Closed-session Apply Transaction is blocked because Zen owns or may own the target Profile");
  if (context.sessionFile.kind !== "zen-sessions") {
    throw new Error("Closed-session Apply Transaction requires zen-sessions.jsonlz4 as the authoritative source");
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

async function applyLayout(profileId: string): Promise<ApplyLayout> {
  const profileKey = `profile-${digestHex(sha256Canonical({ profileId }))}`;
  const root = await ensurePrivateDirectory(stateDir(), "apply-transactions", profileKey);
  return {
    root,
    transactions: await ensurePrivateDirectory(root, "transactions"),
    consents: await ensurePrivateDirectory(root, "consents"),
    authorizations: await ensurePrivateDirectory(root, "authorizations"),
    backups: await ensurePrivateDirectory(root, "backups"),
    backupManifests: await ensurePrivateDirectory(root, "backup-manifests"),
    recoveries: await ensurePrivateDirectory(root, "recoveries"),
    inverses: await ensurePrivateDirectory(root, "inverse-plans"),
    journals: await ensurePrivateDirectory(root, "journals"),
    controls: await ensurePrivateDirectory(root, "controls"),
    receipts: await ensurePrivateDirectory(root, "receipts")
  };
}

function objectPath(root: string, digest: Sha256Digest, extension: string): string {
  return privatePath(root, `${digestHex(digest)}.${extension}`);
}

function artifact(id: string, digest: Sha256Digest): ArtifactReference {
  return { id, digest };
}

function digestHex(digest: Sha256Digest): string {
  return digest.slice("sha256:".length);
}

function shortDigest(digest: Sha256Digest): string {
  return digestHex(digest).slice(0, 16);
}

function safeSegment(value: string): string {
  const cleaned = value.trim().replace(/[^A-Za-z0-9._-]+/gu, "-").replace(/^-+|-+$/gu, "");
  return cleaned || "unknown";
}

function canonicalTimestamp(value: Date): string {
  if (!Number.isFinite(value.getTime())) throw new Error("Apply Transaction timestamp is invalid");
  return value.toISOString();
}

function processCheck(label: string, context: ProfileContext): Readonly<Record<string, unknown>> {
  const applicablePids = context.runningProcesses
    .filter((candidate) => candidate.profilePath === context.profile.path || candidate.profilePath === undefined)
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

function requiredArtifact(value: ArtifactReference | null, label: string): ArtifactReference {
  if (!value) throw new Error(`${label} is unavailable`);
  return value;
}

function ztsMessage(value: string): ZtsMessage {
  return { value, provenance: "zts_generated", interpretation: "data_only" };
}
