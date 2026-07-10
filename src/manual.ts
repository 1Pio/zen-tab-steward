import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createBackup } from "./backup.js";
import { createApplyAuthorization, createPatch, createPlan, definePatch, defineReceipt } from "./domain/change.js";
import { sha256Canonical } from "./domain/digest.js";
import { createSnapshot } from "./domain/snapshot.js";
import { writeJsonLz4 } from "./mozlz4.js";
import { stateDir } from "./paths.js";
import { ProfileContext } from "./profile.js";
import { listTabs, RawZenSession, SessionSummary } from "./session.js";

import type {
  AutoApplyEvidence,
  ApplyAuthorization,
  CallerText,
  ManualDecisionEvidence,
  MoveProtectionPrecondition,
  Patch,
  PatchDraft,
  Plan,
  PlanAction,
  Receipt,
  ZtsMessage
} from "./domain/change.js";
import type {
  CapabilityEvidence,
  EntityDraft,
  MovementRootRef,
  Protection,
  Snapshot,
  SnapshotDraft,
  Workspace
} from "./domain/snapshot.js";

export interface ManualPlanResult {
  snapshot: Snapshot;
  patch: Patch;
  plan: Plan;
  summary: {
    moveCount: number;
    protectedCount: number;
    blockedCount: number;
    unchangedCount: number;
  };
}

export interface ManualApplyResult extends ManualPlanResult {
  authorization: ApplyAuthorization;
  receipt: Receipt;
  receiptPath: string;
}

export interface ManualApplyReceiptSummary {
  id: string;
  outcome: Receipt["outcome"];
  planId: string;
  planDigest: string;
  completedAt: string;
  operationCount: number;
  receiptPath: string;
}

export async function readPatchInput(path: string): Promise<unknown> {
  const contents = path === "-" ? await readStdin() : await readFile(path, "utf8");
  return JSON.parse(contents) as unknown;
}

export async function listManualApplyReceipts(profileId: string): Promise<ManualApplyReceiptSummary[]> {
  const root = join(stateDir(), "applies", safeSegment(profileId));
  try {
    const entries = await readdir(root);
    const receiptFiles = entries.filter((entry) => entry.endsWith("--domain-apply.json")).sort().reverse();
    const receipts: ManualApplyReceiptSummary[] = [];
    for (const receiptFile of receiptFiles) {
      const receiptPath = join(root, receiptFile);
      const receipt = JSON.parse(await readFile(receiptPath, "utf8")) as Receipt;
      receipts.push({
        id: receipt.id,
        outcome: receipt.outcome,
        planId: receipt.planId,
        planDigest: receipt.planDigest,
        completedAt: receipt.completedAt,
        operationCount: receipt.operations.length,
        receiptPath
      });
    }
    return receipts;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

export function snapshotFromSession(context: ProfileContext, session: RawZenSession, summary: SessionSummary): Snapshot {
  const capturedAt = new Date().toISOString();
  const route = context.running ? "persisted_session" : "closed_session";
  const sourceRevision = sha256Canonical({
    kind: context.sessionFile.kind,
    modifiedMs: context.sessionFile.modifiedMs,
    size: context.sessionFile.size,
    session
  });
  const scope = {
    profileId: context.profile.id,
    route,
    platform: `${process.platform}-${process.arch}`,
    zenVersion: "unknown",
    zenBuildId: null,
    schemaFamily: context.sessionFile.kind,
    entityKind: null
  } as const;
  const observeProof = {
    artifact: { id: `session:${context.sessionFile.kind}:source`, digest: sourceRevision },
    source: "runtime_probe" as const,
    capturedAt,
    scope,
    controlSessionId: null,
    processBindingRevision: null
  };
  const evidence: CapabilityEvidence[] = [
    {
      id: "observe.snapshot",
      status: "available",
      reason: context.running
        ? "Read persisted Zen session state while Zen may have newer in-memory state"
        : "Read Zen session state while Zen was not running",
      proof: observeProof
    }
  ];
  if (!context.running && context.sessionFile.kind === "zen-sessions") {
    evidence.push({
      id: "profile.exclusive_control",
      status: "available",
      reason: "Zen was not running for the selected Profile",
      proof: { ...observeProof, artifact: { id: "session:closed-profile:exclusive-control", digest: sourceRevision } }
    });
    evidence.push({
      id: "move.tab",
      status: "available",
      reason: "Closed-session tab moves are supported for unprotected tab Movement Roots",
      proof: {
        ...observeProof,
        artifact: { id: "session:closed-profile:move-tab", digest: sourceRevision },
        scope: { ...scope, entityKind: "tab" }
      }
    });
  }

  const draft = {
    schemaVersion: "zts.snapshot.provisional-1",
    profile: {
      id: context.profile.id,
      name: context.profile.name,
      contentTrust: "browser_untrusted"
    },
    capturedAt,
    authority: context.running ? "persisted_observation" : "authoritative",
    freshness: context.running ? "possibly_stale" : "current",
    provenance: {
      route,
      sourceRevision,
      platform: scope.platform,
      zenVersion: scope.zenVersion,
      zenBuildId: scope.zenBuildId,
      schemaFamily: scope.schemaFamily
    },
    capabilities: {
      observedAt: capturedAt,
      evidence: evidence as [CapabilityEvidence, ...CapabilityEvidence[]]
    },
    workspaces: summary.workspaces.map((workspace): Workspace => ({
      id: workspace.id,
      name: workspace.name,
      contentTrust: "browser_untrusted",
      position: workspace.order,
      protection: workspaceProtection(workspace.protectedStatus)
    })),
    entities: listTabs(session, summary)
      .filter((tab) => tab.workspaceId !== null)
      .map((tab): EntityDraft => {
        const ref = tabRef(tab.id, tab.index);
        return {
          ref,
          kind: "tab",
          nativeId: tab.id,
          parentRef: null,
          childRefs: [],
          structuralRootRef: ref,
          workspaceId: tab.workspaceId ?? "",
          title: tab.title,
          contentTrust: "browser_untrusted",
          protection: tab.protected ? { protected: true, reasons: tab.protectionReasons as [string, ...string[]] } : { protected: false, reasons: [] },
          members: [
            {
              nativeId: tab.id,
              title: tab.title,
              url: tab.url,
              contentTrust: "browser_untrusted",
              pinned: tab.pinned,
              essential: tab.essential,
              hidden: tab.hidden,
              active: false
            }
          ]
        };
      })
  } as SnapshotDraft;
  return createSnapshot(draft);
}

export function createManualPlanFromInput(snapshot: Snapshot, patchInput: unknown): ManualPlanResult {
  const patch = isFullPatch(patchInput)
    ? definePatch(snapshot, patchInput)
    : createPatch(snapshot, patchInput as PatchDraft);
  const plan = createManualPlan(snapshot, patch);
  const moveCount = plan.actions.filter((action) => action.disposition === "move").length;
  const protectedCount = plan.actions.filter((action) => action.disposition === "protected").length;
  const blockedCount = plan.actions.filter((action) => action.disposition === "blocked").length;
  const unchangedCount = plan.actions.filter((action) => action.disposition === "unchanged").length;
  return {
    snapshot,
    patch,
    plan,
    summary: { moveCount, protectedCount, blockedCount, unchangedCount }
  };
}

export async function applyManualPatchOffline(
  context: ProfileContext,
  session: RawZenSession,
  summary: SessionSummary,
  patchInput: unknown,
  command: string
): Promise<ManualApplyResult> {
  if (context.running) throw new Error("Manual Patch apply requires Zen to be closed; current Snapshot would be a persisted observation");
  if (context.sessionFile.kind !== "zen-sessions") throw new Error("Manual Patch apply requires zen-sessions.jsonlz4 as the selected session source");

  const snapshot = snapshotFromSession(context, session, summary);
  const result = createManualPlanFromInput(snapshot, patchInput);
  const moveActions = result.plan.actions.filter((action): action is Extract<PlanAction, { readonly disposition: "move" }> =>
    action.disposition === "move"
  );
  if (moveActions.length === 0) throw new Error("Manual Patch apply has no executable move actions");

  const authorizedAt = new Date().toISOString();
  const authorization = createApplyAuthorization(snapshot, result.plan, {
    schemaVersion: "zts.authorization.provisional-1",
    id: `authorization:manual:${shortDigest(result.plan.digest)}`,
    planId: result.plan.id,
    planDigest: result.plan.digest,
    profileId: result.plan.profileId,
    authorizedAt,
    expiresAt: result.plan.expiresAt,
    source: {
      kind: "unattended_invocation",
      consentArtifact: {
        id: `consent:manual:${shortDigest(result.plan.digest)}`,
        digest: result.plan.digest
      }
    },
    authorizedActionIds: moveActions.map((action) => action.actionId) as [string, ...string[]],
    allowedTrustClasses: ["manual_exact"],
    protectionGrants: [],
    lifecycle: { kind: "none" },
    wholePlanPreflight: true
  });
  const receiptRoot = join(stateDir(), "applies", safeSegment(context.profile.id));
  await mkdir(receiptRoot, { recursive: true, mode: 0o700 });
  const journalArtifact = {
    id: `journal:manual:${shortDigest(result.plan.digest)}`,
    digest: sha256Canonical({ plan: result.plan.digest, authorization: authorization.revision, patch: result.patch.snapshotRevision })
  };
  await writeFile(
    join(receiptRoot, `${safeSegment(journalArtifact.id)}--journal.json`),
    `${JSON.stringify({
      schemaVersion: "zts.manual-apply-journal.provisional-1",
      stage: "authorized",
      planDigest: result.plan.digest,
      authorizationRevision: authorization.revision,
      patch: result.patch
    }, null, 2)}\n`,
    { encoding: "utf8", mode: 0o600 }
  );

  const nextSession = structuredClone(session);
  const tabs = Array.isArray(nextSession.tabs) ? nextSession.tabs : [];
  const tabSummaries = listTabs(nextSession, summary);
  const entities = new Map(snapshot.entities.map((entity) => [entity.ref, entity]));
  for (const action of moveActions) {
    const entity = entities.get(action.operation.entityRef);
    const tabSummary = tabSummaries.find((tab) => tab.id === entity?.nativeId);
    if (!entity || !tabSummary) throw new Error(`Manual Patch apply cannot find ${action.operation.entityRef} in the current session`);
    const tab = tabs[tabSummary.index];
    if (!tab) throw new Error(`Manual Patch apply cannot find raw tab for ${action.operation.entityRef}`);
    if (tab.zenWorkspace !== action.operation.precondition.sourceWorkspace.workspaceId) {
      throw new Error(`Manual Patch apply found Drift for ${action.operation.entityRef}`);
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
      throw new Error(`Manual Patch apply verification failed for ${action.operation.entityRef}`);
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
  });
  const receiptOperations = operations as unknown as Extract<Receipt, { readonly outcome: "applied" }>["operations"];

  const completedAt = new Date().toISOString();
  const receipt = defineReceipt(snapshot, result.plan, authorization, {
    schemaVersion: "zts.receipt.provisional-1",
    id: `receipt:manual:${shortDigest(sha256Canonical({ plan: result.plan.digest, completedAt }))}`,
    planId: result.plan.id,
    planDigest: result.plan.digest,
    authorization: {
      id: authorization.id,
      revision: authorization.revision,
      artifact: { id: `authorization:${authorization.id}`, digest: authorization.revision }
    },
    profileId: result.plan.profileId,
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
      proof: { id: "control:closed-session:manual-apply", digest: snapshot.provenance.sourceRevision },
      exclusiveControlReleased: "verified"
    },
    backupArtifact: { id: `backup:${backup.id}`, digest: sha256Canonical({ backupId: backup.id }) },
    inversePlanArtifact: {
      id: `inverse:${result.plan.id}`,
      digest: sha256Canonical(moveActions.map((action) => ({
        entityRef: action.operation.entityRef,
        destinationWorkspaceId: action.operation.inverse.destinationWorkspaceId
      })))
    },
    recoveryArtifact: null,
    operations: receiptOperations
  });

  const receiptPath = join(receiptRoot, `${safeSegment(receipt.id)}--domain-apply.json`);
  await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  return { ...result, authorization, receipt, receiptPath };
}

function createManualPlan(snapshot: Snapshot, patch: Patch): Plan {
  const createdAt = new Date().toISOString();
  const expiresAt = new Date(Date.parse(createdAt) + 5 * 60 * 1000).toISOString();
  const entities = new Map(snapshot.entities.map((entity) => [entity.ref, entity]));
  const workspaces = new Map(snapshot.workspaces.map((workspace) => [workspace.id, workspace]));
  const actions = patch.operations.map((operation, index): PlanAction => {
    const entity = entities.get(operation.entityRef);
    const source = entity ? workspaces.get(operation.expectedSourceWorkspaceId) : undefined;
    const destination = workspaces.get(operation.destinationWorkspaceId);
    const actionId = `manual-${String(index + 1).padStart(4, "0")}`;
    const decision = manualDecision(operation.reason);
    if (!entity || !source || !destination) {
      return {
        actionId,
        disposition: "blocked",
        entityRef: operation.entityRef,
        candidateDestinationWorkspaceId: operation.destinationWorkspaceId,
        decision
      };
    }
    if (entity.workspaceId === operation.destinationWorkspaceId) {
      return {
        actionId,
        disposition: "unchanged",
        entityRef: operation.entityRef,
        candidateDestinationWorkspaceId: operation.destinationWorkspaceId,
        decision
      };
    }
    const entityProtection = moveProtection(entity.protection, `grant:${actionId}:entity`);
    const sourceProtection = moveProtection(source.protection.source, `grant:${actionId}:source`);
    const destinationProtection = moveProtection(destination.protection.destination, `grant:${actionId}:destination`);
    if (entityProtection.protected || sourceProtection.protected || destinationProtection.protected) {
      return {
        actionId,
        disposition: "protected",
        entityRef: operation.entityRef,
        candidateDestinationWorkspaceId: operation.destinationWorkspaceId,
        decision
      };
    }
    return {
      actionId,
      disposition: "move",
      operation: {
        op: "move",
        entityRef: operation.entityRef,
        entityKind: entity.kind,
        precondition: {
          entityRevision: entity.revision,
          entityProtection,
          sourceWorkspace: {
            workspaceId: source.id,
            protection: sourceProtection
          },
          destinationWorkspace: {
            workspaceId: destination.id,
            protection: destinationProtection
          }
        },
        expectedPostState: {
          workspaceId: destination.id
        },
        inverse: {
          op: "move",
          destinationWorkspaceId: source.id
        }
      },
      decision
    };
  });
  return createPlan(snapshot, {
    schemaVersion: "zts.plan.provisional-1",
    id: `plan:manual:${sha256Canonical({ createdAt, patchRevision: patch.snapshotRevision }).slice("sha256:".length, "sha256:".length + 16)}`,
    configRevision: sha256Canonical({ source: "manual-patch-defaults" }),
    engineManifestRevision: sha256Canonical({ manual: "zts.manual.provisional-1" }),
    createdAt,
    expiresAt,
    derivation: { kind: "original" },
    source: {
      kind: "manual_patch",
      intentRevision: sha256Canonical(patch)
    },
    actions
  });
}

function manualDecision(explanation: CallerText): ManualDecisionEvidence {
  return {
    engine: "manual",
    trustClass: "manual_exact",
    explanation,
    evidenceRevision: sha256Canonical(explanation),
    autoApply: {
      status: "not_requested",
      requested: false,
      eligible: false,
      reason: ztsMessage("Manual Patch creates exact Plan actions but does not request automatic apply")
    } satisfies AutoApplyEvidence
  };
}

function moveProtection(protection: Protection, grantId: string): MoveProtectionPrecondition {
  if (!protection.protected) return { protected: false, reasons: [], requiredGrantId: null };
  return {
    protected: true,
    reasons: protection.reasons,
    protectionRevision: sha256Canonical(protection),
    requiredGrantId: grantId
  };
}

function workspaceProtection(status: SessionSummary["workspaces"][number]["protectedStatus"]): Workspace["protection"] {
  return {
    source: status === "from" || status === "from_to"
      ? { protected: true, reasons: ["protected_source"] }
      : { protected: false, reasons: [] },
    destination: status === "to" || status === "from_to"
      ? { protected: true, reasons: ["protected_destination"] }
      : { protected: false, reasons: [] }
  };
}

function tabRef(tabId: string, index: number): MovementRootRef {
  return `entity:root:tab:${safeSegment(tabId)}:${sha256Canonical({ tabId, index }).slice("sha256:".length, "sha256:".length + 12)}`;
}

function shortDigest(digest: string): string {
  return digest.startsWith("sha256:") ? digest.slice("sha256:".length, "sha256:".length + 16) : safeSegment(digest).slice(0, 16);
}

function safeSegment(value: string): string {
  const cleaned = value.trim().replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return cleaned || "unknown";
}

function ztsMessage(value: string): ZtsMessage {
  return { value, provenance: "zts_generated", interpretation: "data_only" };
}

function isFullPatch(value: unknown): value is Patch {
  return Boolean(value && typeof value === "object" && (value as { schemaVersion?: unknown }).schemaVersion === "zts.patch.provisional-1");
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}
