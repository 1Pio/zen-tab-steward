import { createSnapshot } from "./domain/snapshot.js";

import type { PlanAction } from "./domain/change.js";
import type { EntityDraft, Snapshot, SnapshotDraft } from "./domain/snapshot.js";

type MoveAction = Extract<PlanAction, { readonly disposition: "move" }>;

/**
 * Reconstructs the one normalized logical state that a preflighted Plan can
 * produce. Adapter capture proof intentionally remains that of the stored
 * before-Snapshot because Snapshot revision excludes it; every Workspace,
 * Entity, Protection, member and structural-closure field remains exact and
 * content addressed.
 */
export function deriveExactPlannedAfterSnapshot(
  beforeSnapshot: Snapshot,
  actions: readonly MoveAction[]
): Snapshot {
  const destinations = new Map(actions.map((action) => [
    action.operation.entityRef,
    action.operation.expectedPostState.workspaceId
  ]));
  const entities: EntityDraft[] = beforeSnapshot.entities.map((entity) => {
    const { revision, ...draft } = entity;
    void revision;
    const destinationWorkspaceId = destinations.get(entity.structuralRootRef);
    return destinationWorkspaceId
      ? { ...draft, workspaceId: destinationWorkspaceId } as EntityDraft
      : draft as EntityDraft;
  });
  const draft = {
    schemaVersion: beforeSnapshot.schemaVersion,
    profile: beforeSnapshot.profile,
    capturedAt: beforeSnapshot.capturedAt,
    authority: beforeSnapshot.authority,
    freshness: beforeSnapshot.freshness,
    provenance: beforeSnapshot.provenance,
    capabilities: beforeSnapshot.capabilities,
    workspaces: beforeSnapshot.workspaces,
    entities
  } as SnapshotDraft;
  return createSnapshot(draft);
}
