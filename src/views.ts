import type { Entity, EntityMember, Snapshot, Workspace } from "./domain/snapshot.js";
import type { WorkspaceSummary } from "./session.js";

export interface WorkspaceView {
  readonly workspace: Workspace;
  readonly defaultInbox: boolean;
  readonly sortableFrom: boolean;
  readonly sortableTo: boolean;
  readonly rootEntityCount: number;
  readonly tabCount: number;
  readonly pinnedCount: number;
  readonly essentialCount: number;
  readonly folderCount: number;
  readonly groupCount: number;
  readonly splitViewCount: number;
}

export interface TabView {
  readonly entityRef: string;
  readonly entityRevision: string;
  readonly entityKind: Entity["kind"];
  readonly structuralRootRef: string;
  readonly workspace: Workspace;
  readonly entityTitle: string;
  readonly contentTrust: "browser_untrusted";
  readonly protection: Entity["protection"];
  readonly member: EntityMember;
}

export type WorkspaceSelectorResolution<T extends { readonly id: string; readonly name: string }> =
  | { readonly status: "resolved"; readonly workspace: T }
  | { readonly status: "missing" }
  | { readonly status: "ambiguous"; readonly matches: readonly T[] };

export function workspaceViews(
  snapshot: Snapshot,
  policyWorkspaces: readonly WorkspaceSummary[]
): readonly WorkspaceView[] {
  const policy = new Map(policyWorkspaces.map((workspace) => [workspace.id, workspace]));
  if (policy.size !== snapshot.workspaces.length) {
    throw new Error("Workspace policy summary does not match the Snapshot");
  }
  return snapshot.workspaces.map((workspace) => {
    const workspacePolicy = policy.get(workspace.id);
    if (!workspacePolicy || workspacePolicy.name !== workspace.name) {
      throw new Error(`Workspace policy is missing exact Snapshot Workspace ${workspace.id}`);
    }
    const entities = snapshot.entities.filter((entity) => entity.workspaceId === workspace.id);
    const members = entities.flatMap((entity) => entity.members);
    return {
      workspace,
      defaultInbox: workspacePolicy.defaultInbox,
      sortableFrom: workspacePolicy.sortableFrom,
      sortableTo: workspacePolicy.sortableTo,
      rootEntityCount: entities.filter((entity) => entity.parentRef === null).length,
      tabCount: members.length,
      pinnedCount: members.filter((member) => member.pinned).length,
      essentialCount: members.filter((member) => member.essential).length,
      folderCount: entities.filter((entity) => entity.kind === "zen_folder").length,
      groupCount: entities.filter((entity) => entity.kind === "tab_group").length,
      splitViewCount: entities.filter((entity) => entity.kind === "split_view").length
    };
  });
}

export function tabViews(snapshot: Snapshot, workspaceSelector?: string): readonly TabView[] {
  const resolution = workspaceSelector
    ? resolveWorkspaceSelector(snapshot.workspaces, workspaceSelector)
    : null;
  if (resolution?.status === "missing") throw new Error(`Workspace not found: ${workspaceSelector}`);
  if (resolution?.status === "ambiguous") {
    throw new Error(ambiguousWorkspaceMessage(workspaceSelector!, resolution.matches));
  }
  const workspace = resolution?.status === "resolved" ? resolution.workspace : null;
  const workspaces = new Map(snapshot.workspaces.map((candidate) => [candidate.id, candidate]));
  const result: TabView[] = [];
  for (const entity of snapshot.entities) {
    if (workspace && entity.workspaceId !== workspace.id) continue;
    const entityWorkspace = workspaces.get(entity.workspaceId);
    if (!entityWorkspace) throw new Error(`Entity ${entity.ref} references a missing Workspace`);
    for (const member of entity.members) {
      result.push({
        entityRef: entity.ref,
        entityRevision: entity.revision,
        entityKind: entity.kind,
        structuralRootRef: entity.structuralRootRef,
        workspace: entityWorkspace,
        entityTitle: entity.title,
        contentTrust: entity.contentTrust,
        protection: entity.protection,
        member
      });
    }
  }
  return result;
}

export function resolveWorkspaceSelector<T extends { readonly id: string; readonly name: string }>(
  workspaces: readonly T[],
  selector: string
): WorkspaceSelectorResolution<T> {
  const exactSelector = selector.trim();
  const exactId = workspaces.find((workspace) => workspace.id === exactSelector);
  if (exactId) return { status: "resolved", workspace: exactId };

  const normalized = normalize(selector);
  const matches = workspaces.filter((workspace) => normalize(workspace.name) === normalized);
  if (matches.length === 0) return { status: "missing" };
  if (matches.length > 1) return { status: "ambiguous", matches };
  return { status: "resolved", workspace: matches[0]! };
}

export function ambiguousWorkspaceMessage(
  selector: string,
  matches: readonly { readonly id: string }[]
): string {
  return `Workspace '${selector}' is ambiguous; use one id: ${matches.map((workspace) => workspace.id).join(", ")}`;
}

function normalize(value: string): string {
  return value.trim().toLowerCase();
}
