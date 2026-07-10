import { readFile } from "node:fs/promises";
import { createPatch, createPlan, definePatch } from "./domain/change.js";
import { sha256Canonical } from "./domain/digest.js";
import { createSnapshot } from "./domain/snapshot.js";
import { ProfileContext } from "./profile.js";
import { listTabs, RawZenSession, SessionSummary } from "./session.js";

import type {
  AutoApplyEvidence,
  CallerText,
  ManualDecisionEvidence,
  MoveProtectionPrecondition,
  Patch,
  PatchDraft,
  Plan,
  PlanAction,
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

export async function readPatchInput(path: string): Promise<unknown> {
  const contents = path === "-" ? await readStdin() : await readFile(path, "utf8");
  return JSON.parse(contents) as unknown;
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
    const sourceProtection = moveProtection(source.protection, `grant:${actionId}:source`);
    const destinationProtection = moveProtection(destination.protection, `grant:${actionId}:destination`);
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

function workspaceProtection(status: SessionSummary["workspaces"][number]["protectedStatus"]): Protection {
  if (status === "none") return { protected: false, reasons: [] };
  const reasons = status === "from_to" ? ["protected_source", "protected_destination"] : status === "from" ? ["protected_source"] : ["protected_destination"];
  return { protected: true, reasons: reasons as [string, ...string[]] };
}

function tabRef(tabId: string, index: number): MovementRootRef {
  return `entity:root:tab:${safeSegment(tabId)}:${sha256Canonical({ tabId, index }).slice("sha256:".length, "sha256:".length + 12)}`;
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
