import { createPatch } from "./domain/change.js";
import { assertExactKeys } from "./domain/validation.js";

import type { Patch } from "./domain/change.js";
import type { MovementRootRef, Snapshot } from "./domain/snapshot.js";

export const AGENT_DIFF_SCHEMA_VERSION = "zts.diff.provisional-1" as const;

export interface AgentDiffMove {
  readonly entityRef: MovementRootRef;
  readonly fromWorkspaceId: string;
  readonly toWorkspaceId: string;
  readonly reason: string;
}

export interface AgentDiff {
  readonly schemaVersion: typeof AGENT_DIFF_SCHEMA_VERSION;
  readonly snapshotRevision: string;
  readonly moves: readonly AgentDiffMove[];
}

/**
 * Converts the small agent-facing DTO into the one canonical Patch model.
 * Unlike the legacy Patch draft surface, this seam never derives a Snapshot
 * binding on the caller's behalf.
 */
export function createPatchFromAgentDiff(snapshot: Snapshot, input: unknown): Patch {
  const diff = defineAgentDiff(input);
  if (diff.snapshotRevision !== snapshot.revision) {
    throw new Error(
      `Listed Snapshot revision ${diff.snapshotRevision} does not match current Snapshot ${snapshot.revision}`
    );
  }
  return createPatch(snapshot, {
    operations: diff.moves.map((move) => ({
      op: "move" as const,
      entityRef: move.entityRef,
      expectedSourceWorkspaceId: move.fromWorkspaceId,
      destinationWorkspaceId: move.toWorkspaceId,
      reason: move.reason
    }))
  });
}

export function defineAgentDiff(input: unknown): AgentDiff {
  assertExactKeys(input, ["schemaVersion", "snapshotRevision", "moves"], "Diff");
  const record = input as Record<string, unknown>;
  if (record.schemaVersion !== AGENT_DIFF_SCHEMA_VERSION) {
    throw new Error(`Diff schemaVersion must be ${AGENT_DIFF_SCHEMA_VERSION}`);
  }
  if (typeof record.snapshotRevision !== "string" || record.snapshotRevision.length === 0) {
    throw new Error("Diff snapshotRevision must be a non-empty string");
  }
  if (!Array.isArray(record.moves)) throw new Error("Diff moves must be an array");
  const moves = record.moves.map((value, index): AgentDiffMove => {
    const label = `Diff move ${index + 1}`;
    assertExactKeys(value, ["entityRef", "fromWorkspaceId", "toWorkspaceId", "reason"], label);
    const move = value as Record<string, unknown>;
    return {
      entityRef: requiredString(move.entityRef, `${label} entityRef`) as MovementRootRef,
      fromWorkspaceId: requiredString(move.fromWorkspaceId, `${label} fromWorkspaceId`),
      toWorkspaceId: requiredString(move.toWorkspaceId, `${label} toWorkspaceId`),
      reason: requiredString(move.reason, `${label} reason`)
    };
  });
  return {
    schemaVersion: AGENT_DIFF_SCHEMA_VERSION,
    snapshotRevision: record.snapshotRevision,
    moves
  };
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}
