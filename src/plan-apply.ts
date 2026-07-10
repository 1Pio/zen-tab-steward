import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createBackup } from "./backup.js";
import {
  createApplyAuthorization,
  createProtectionGrant,
  definePlanForSnapshot,
  defineReceipt
} from "./domain/change.js";
import { sha256Canonical } from "./domain/digest.js";
import { loadConfig } from "./config.js";
import { writeJsonLz4 } from "./mozlz4.js";
import { stateDir } from "./paths.js";
import { ProfileContext } from "./profile.js";
import { acquireProfileTransactionLock } from "./profile-lock.js";
import { loadSession, listTabs, RawZenSession, SessionSummary, summarizeSession, withWorkspacePolicy } from "./session.js";
import { snapshotFromSession } from "./session-snapshot.js";

import type {
  ApplyAuthorization,
  AuthorizableTrustClass,
  MoveProtectionPrecondition,
  Plan,
  PlanAction,
  ProtectionGrant,
  Receipt
} from "./domain/change.js";

export interface SavedPlanApplyResult {
  readonly snapshot: ReturnType<typeof snapshotFromSession>;
  readonly plan: Plan;
  readonly authorization: ApplyAuthorization;
  readonly receipt: Receipt;
  readonly receiptPath: string;
  readonly summary: {
    readonly moveCount: number;
  };
}

type MoveAction = Extract<PlanAction, { readonly disposition: "move" }>;

export async function applySavedPlanOffline(
  context: ProfileContext,
  session: RawZenSession,
  summary: SessionSummary,
  plan: Plan,
  command: string,
  now = new Date()
): Promise<SavedPlanApplyResult> {
  if (context.running) throw new Error("Saved Plan apply requires Zen to be closed; current Snapshot would be a persisted observation");
  if (context.sessionFile.kind !== "zen-sessions") throw new Error("Saved Plan apply requires zen-sessions.jsonlz4 as the selected session source");

  const snapshot = snapshotFromSession(context, session, summary);
  definePlanForSnapshot(snapshot, plan);
  if (Date.parse(plan.expiresAt) <= now.getTime()) throw new Error(`Saved Plan ${plan.digest} has expired; create a fresh preview`);

  const moveActions = plan.actions.filter((action): action is MoveAction => action.disposition === "move");
  if (moveActions.length === 0) throw new Error("Saved Plan has no executable move actions");

  const authorizedAt = now.toISOString();
  const authorization = createApplyAuthorization(snapshot, plan, {
    schemaVersion: "zts.authorization.provisional-1",
    id: `authorization:plan:${shortDigest(plan.digest)}`,
    planId: plan.id,
    planDigest: plan.digest,
    profileId: plan.profileId,
    authorizedAt,
    expiresAt: plan.expiresAt,
    source: {
      kind: "unattended_invocation",
      consentArtifact: {
        id: `consent:plan:${shortDigest(plan.digest)}`,
        digest: plan.digest
      }
    },
    authorizedActionIds: moveActions.map((action) => action.actionId) as [string, ...string[]],
    allowedTrustClasses: allowedTrustClasses(moveActions),
    protectionGrants: protectionGrants(plan, moveActions),
    lifecycle: { kind: "none" },
    wholePlanPreflight: true
  });

  const receiptRoot = join(stateDir(), "applies", safeSegment(context.profile.id));
  await mkdir(receiptRoot, { recursive: true, mode: 0o700 });
  const journalArtifact = {
    id: `journal:plan:${shortDigest(plan.digest)}`,
    digest: sha256Canonical({
      plan: plan.digest,
      authorization: authorization.revision,
      command,
      actions: moveActions.map((action) => action.actionId)
    })
  };
  await writeFile(
    join(receiptRoot, `${safeSegment(journalArtifact.id)}--journal.json`),
    `${JSON.stringify({
      schemaVersion: "zts.saved-plan-apply-journal.provisional-1",
      stage: "authorized",
      planDigest: plan.digest,
      authorizationRevision: authorization.revision,
      command,
      actionIds: moveActions.map((action) => action.actionId)
    }, null, 2)}\n`,
    { encoding: "utf8", mode: 0o600 }
  );

  const nextSession = structuredClone(session);
  const tabs = Array.isArray(nextSession.tabs) ? nextSession.tabs : [];
  const tabSummaries = listTabs(nextSession, summary);
  const entities = new Map(snapshot.entities.map((entity) => [entity.ref, entity]));

  for (const action of moveActions) {
    if (action.operation.entityKind !== "tab") throw new Error(`Saved Plan apply currently supports tab moves only: ${action.actionId}`);
    const entity = entities.get(action.operation.entityRef);
    const tabSummary = tabSummaries.find((tab) => tab.id === entity?.nativeId);
    if (!entity || !tabSummary) throw new Error(`Saved Plan apply cannot find ${action.operation.entityRef} in the current session`);
    const tab = tabs[tabSummary.index];
    if (!tab) throw new Error(`Saved Plan apply cannot find raw tab for ${action.operation.entityRef}`);
    if (tab.zenWorkspace !== action.operation.precondition.sourceWorkspace.workspaceId) {
      throw new Error(`Saved Plan apply found Drift for ${action.operation.entityRef}`);
    }
    tab.zenWorkspace = action.operation.expectedPostState.workspaceId;
  }

  const backup = await createBackup(context, command);
  await writeJsonLz4(context.sessionFile.path, nextSession);
  const afterSnapshot = snapshotFromSession(context, nextSession, summary);
  const afterEntitiesByNativeId = new Map(afterSnapshot.entities.map((entity) => [entity.nativeId, entity]));
  const operations = moveActions.map((action) => {
    const beforeEntity = entities.get(action.operation.entityRef);
    const afterEntity = beforeEntity ? afterEntitiesByNativeId.get(beforeEntity.nativeId) : undefined;
    if (!afterEntity || afterEntity.workspaceId !== action.operation.expectedPostState.workspaceId) {
      throw new Error(`Saved Plan apply verification failed for ${action.operation.entityRef}`);
    }
    return {
      actionId: action.actionId,
      entityRef: action.operation.entityRef,
      observedWorkspaceId: action.operation.expectedPostState.workspaceId,
      status: "verified" as const,
      mutationAttempted: true as const,
      netChanged: true as const,
      issueCodes: []
    };
  }) as unknown as Extract<Receipt, { readonly outcome: "applied" }>["operations"];

  const completedAt = new Date().toISOString();
  const receipt = defineReceipt(snapshot, plan, authorization, {
    schemaVersion: "zts.receipt.provisional-1",
    id: `receipt:plan:${shortDigest(sha256Canonical({ plan: plan.digest, completedAt }))}`,
    planId: plan.id,
    planDigest: plan.digest,
    authorization: {
      id: authorization.id,
      revision: authorization.revision,
      artifact: { id: `authorization:${authorization.id}`, digest: authorization.revision }
    },
    profileId: plan.profileId,
    beforeSnapshotRevision: snapshot.revision,
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
      proof: { id: "control:closed-session:saved-plan-apply", digest: snapshot.provenance.sourceRevision },
      exclusiveControlReleased: "verified"
    },
    backupArtifact: { id: `backup:${backup.id}`, digest: sha256Canonical({ backupId: backup.id }) },
    inversePlanArtifact: {
      id: `inverse:${plan.id}`,
      digest: sha256Canonical(moveActions.map((action) => ({
        entityRef: action.operation.entityRef,
        destinationWorkspaceId: action.operation.inverse.destinationWorkspaceId
      })))
    },
    recoveryArtifact: null,
    operations
  });

  const receiptPath = join(receiptRoot, `${safeSegment(receipt.id)}--domain-apply.json`);
  await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  return { snapshot, plan, authorization, receipt, receiptPath, summary: { moveCount: moveActions.length } };
}

export async function applySavedPlanWithProfileLock(
  context: ProfileContext,
  plan: Plan,
  command: string,
  now = new Date()
): Promise<SavedPlanApplyResult> {
  if (context.running) throw new Error("Saved Plan apply requires Zen to be closed; current Snapshot would be a persisted observation");
  const lock = await acquireProfileTransactionLock(context.profile, command, now);
  try {
    const loadedConfig = await loadConfig();
    const session = await loadSession(context.sessionFile);
    const summary = withWorkspacePolicy(summarizeSession(session, context.sessionFile), loadedConfig.config);
    return await applySavedPlanOffline(context, session, summary, plan, command, now);
  } finally {
    await lock.release();
  }
}

function allowedTrustClasses(moveActions: readonly MoveAction[]): [AuthorizableTrustClass, ...AuthorizableTrustClass[]] {
  const values = [...new Set(moveActions.map((action) => action.decision.trustClass))];
  if (values.some((value) => value === "unknown")) throw new Error("Saved Plan contains unknown-trust move actions");
  return values as [AuthorizableTrustClass, ...AuthorizableTrustClass[]];
}

function protectionGrants(plan: Plan, moveActions: readonly MoveAction[]): ProtectionGrant[] {
  const grants: ProtectionGrant[] = [];
  for (const action of moveActions) {
    maybeGrant(grants, plan, action, action.operation.precondition.entityProtection, {
      kind: "entity",
      entityRef: action.operation.entityRef
    });
    maybeGrant(grants, plan, action, action.operation.precondition.sourceWorkspace.protection, {
      kind: "workspace",
      workspaceId: action.operation.precondition.sourceWorkspace.workspaceId,
      participation: "source"
    });
    maybeGrant(grants, plan, action, action.operation.precondition.destinationWorkspace.protection, {
      kind: "workspace",
      workspaceId: action.operation.precondition.destinationWorkspace.workspaceId,
      participation: "destination"
    });
  }
  return grants;
}

function maybeGrant(
  grants: ProtectionGrant[],
  plan: Plan,
  action: MoveAction,
  protection: MoveProtectionPrecondition,
  subject: ProtectionGrant["subject"]
): void {
  if (!protection.protected) return;
  const base = {
    id: protection.requiredGrantId,
    planDigest: plan.digest,
    actionId: action.actionId,
    protectionRevision: protection.protectionRevision,
    reasons: protection.reasons,
    issuedBy: "invocation" as const
  };
  const grant = subject.kind === "entity"
    ? createProtectionGrant({ ...base, subject })
    : createProtectionGrant({ ...base, subject });
  grants.push(grant);
}

function shortDigest(digest: string): string {
  return digest.startsWith("sha256:") ? digest.slice("sha256:".length, "sha256:".length + 16) : safeSegment(digest).slice(0, 16);
}

function safeSegment(value: string): string {
  const cleaned = value.trim().replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return cleaned || "unknown";
}
