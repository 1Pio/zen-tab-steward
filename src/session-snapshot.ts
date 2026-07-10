import { sha256Canonical } from "./domain/digest.js";
import { createSnapshot } from "./domain/snapshot.js";
import { listTabs } from "./session.js";

import type { ProfileContext } from "./profile.js";
import type { RawZenSession, SessionSummary } from "./session.js";
import type {
  CapabilityEvidence,
  EntityDraft,
  MovementRootRef,
  Snapshot,
  SnapshotDraft,
  Workspace
} from "./domain/snapshot.js";

export interface SessionTabBinding {
  readonly entityRef: MovementRootRef;
  readonly nativeId: string;
  readonly rawIndex: number;
  readonly workspaceId: string;
}

export function snapshotFromSession(
  context: ProfileContext,
  session: RawZenSession,
  summary: SessionSummary,
  capturedAt = new Date()
): Snapshot {
  const capturedAtIso = canonicalTimestamp(capturedAt);
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
    capturedAt: capturedAtIso,
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
      reason: "Closed-session tab moves are supported for tab Movement Roots",
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
    capturedAt: capturedAtIso,
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
      observedAt: capturedAtIso,
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
          protection: tab.protected
            ? { protected: true, reasons: tab.protectionReasons as [string, ...string[]] }
            : { protected: false, reasons: [] },
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

export function sessionTabBindings(
  snapshot: Snapshot,
  session: RawZenSession,
  summary: SessionSummary
): ReadonlyMap<MovementRootRef, SessionTabBinding> {
  const entities = new Map(snapshot.entities.map((entity) => [entity.ref, entity]));
  const bindings = new Map<MovementRootRef, SessionTabBinding>();
  for (const tab of listTabs(session, summary)) {
    if (tab.workspaceId === null) continue;
    const entityRef = tabRef(tab.id, tab.index);
    const entity = entities.get(entityRef);
    if (!entity || entity.kind !== "tab" || entity.nativeId !== tab.id || entity.workspaceId !== tab.workspaceId) {
      throw new Error(`Session tab binding does not match Snapshot Entity ${entityRef}`);
    }
    if (bindings.has(entityRef)) throw new Error(`Session tab binding repeats Snapshot Entity ${entityRef}`);
    bindings.set(entityRef, {
      entityRef,
      nativeId: tab.id,
      rawIndex: tab.index,
      workspaceId: tab.workspaceId
    });
  }
  return bindings;
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

function safeSegment(value: string): string {
  const cleaned = value.trim().replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return cleaned || "unknown";
}

function canonicalTimestamp(value: Date): string {
  if (!Number.isFinite(value.getTime())) throw new Error("Snapshot capture timestamp is invalid");
  return value.toISOString();
}
