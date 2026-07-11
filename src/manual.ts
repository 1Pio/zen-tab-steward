import { open } from "node:fs/promises";
import { createPatch, createPlan, definePatch } from "./domain/change.js";
import { sha256Canonical } from "./domain/digest.js";
import { movementEligibility } from "./domain/snapshot.js";
import { resolveOrCreatePlan } from "./plans.js";
import { effectiveConfigRevision } from "./config.js";
import { destinationAllowedByPolicy, workspaceAllowedByPolicy } from "./workspace-policy.js";

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
import type { ArtifactReference, Protection, Snapshot } from "./domain/snapshot.js";
import type { Sha256Digest } from "./domain/digest.js";
import type { ZtsConfig } from "./config.js";

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

export interface StoredManualPlanResult extends ManualPlanResult {
  readonly planResolution: "created" | "reused_latest";
  readonly requestRevision: Sha256Digest;
  readonly artifact: ArtifactReference;
}

export const PATCH_INPUT_MAX_BYTES = 1024 * 1024;

const PATCH_INPUT_READ_CHUNK_BYTES = 64 * 1024;

export class PatchInputValidationError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "PatchInputValidationError";
  }
}

export async function readPatchInput(path: string): Promise<unknown> {
  let bytes: Buffer;
  try {
    bytes = path === "-" ? await readStdin() : await readPatchFile(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (error instanceof PatchInputValidationError) throw error;
    if (code === "ENOENT" || code === "EISDIR" || code === "ENAMETOOLONG") {
      throw new PatchInputValidationError(error instanceof Error ? error.message : String(error), error);
    }
    throw error;
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new PatchInputValidationError("Patch input is not valid UTF-8");
  }
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new PatchInputValidationError("Patch input is not valid JSON", error);
  }
}

export function createManualPlanFromInput(
  snapshot: Snapshot,
  patchInput: unknown,
  config: ZtsConfig,
  now = new Date()
): ManualPlanResult {
  let patch: Patch;
  try {
    patch = hasCanonicalPatchEnvelope(patchInput)
      ? definePatch(snapshot, patchInput)
      : createPatch(snapshot, patchInput as PatchDraft);
  } catch (error) {
    throw new PatchInputValidationError(error instanceof Error ? error.message : String(error), error);
  }
  const plan = createManualPlan(snapshot, patch, config, now);
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

export async function resolveManualPlanFromInput(
  snapshot: Snapshot,
  patchInput: unknown,
  config: ZtsConfig,
  now = new Date(),
  policy: "create_or_reuse" | "require_existing" = "create_or_reuse"
): Promise<StoredManualPlanResult> {
  const created = createManualPlanFromInput(snapshot, patchInput, config, now);
  const requestRevision = sha256Canonical({
    kind: "manual_patch",
    patch: created.patch,
    configRevision: created.plan.configRevision
  });
  const resolved = await resolveOrCreatePlan(
    snapshot,
    requestRevision,
    () => created.plan,
    now,
    policy
  );
  return {
    ...created,
    plan: resolved.plan,
    planResolution: resolved.resolution,
    requestRevision,
    artifact: resolved.artifact
  };
}

function createManualPlan(snapshot: Snapshot, patch: Patch, config: ZtsConfig, now: Date): Plan {
  const createdAt = now.toISOString();
  const expiresAt = new Date(Date.parse(createdAt) + 5 * 60 * 1000).toISOString();
  const configRevision = effectiveConfigRevision(config);
  const intentRevision = sha256Canonical(patch);
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
        decision,
        dispositionReason: ztsMessage("Patch Operation no longer resolves inside its bound Snapshot")
      };
    }
    if (entity.workspaceId === operation.destinationWorkspaceId) {
      return {
        actionId,
        disposition: "unchanged",
        entityRef: operation.entityRef,
        candidateDestinationWorkspaceId: operation.destinationWorkspaceId,
        decision,
        dispositionReason: ztsMessage("Entity already belongs to the requested destination Workspace")
      };
    }
    const movement = movementEligibility(snapshot, entity);
    if (!movement.eligible) {
      return {
        actionId,
        disposition: "blocked",
        entityRef: operation.entityRef,
        candidateDestinationWorkspaceId: operation.destinationWorkspaceId,
        decision,
        dispositionReason: ztsMessage(`Entity cannot move through the current Snapshot: ${movement.reason}`)
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
        decision,
        dispositionReason: ztsMessage(protectionDispositionReason(
          entityProtection,
          sourceProtection,
          destinationProtection
        ))
      };
    }
    if (!workspaceAllowedByPolicy(source, config.sort.from)) {
      return {
        actionId,
        disposition: "blocked",
        entityRef: operation.entityRef,
        candidateDestinationWorkspaceId: operation.destinationWorkspaceId,
        decision,
        dispositionReason: ztsMessage(`Source Workspace ${source.name} is outside the configured source policy`)
      };
    }
    if (!destinationAllowedByPolicy(destination, config.sort.to, config.sort.notTo)) {
      return {
        actionId,
        disposition: "blocked",
        entityRef: operation.entityRef,
        candidateDestinationWorkspaceId: operation.destinationWorkspaceId,
        decision,
        dispositionReason: ztsMessage(`Destination Workspace ${destination.name} is outside the configured destination policy`)
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
    id: `plan:manual:${sha256Canonical({ createdAt, intentRevision }).slice("sha256:".length, "sha256:".length + 16)}`,
    configRevision,
    engineManifestRevision: sha256Canonical({ manual: "zts.manual.provisional-1" }),
    createdAt,
    expiresAt,
    derivation: { kind: "original" },
    source: {
      kind: "manual_patch",
      intentRevision
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

function protectionDispositionReason(
  entity: MoveProtectionPrecondition,
  source: MoveProtectionPrecondition,
  destination: MoveProtectionPrecondition
): string {
  const subjects: string[] = [];
  if (entity.protected) subjects.push(`Entity (${entity.reasons.join(", ")})`);
  if (source.protected) subjects.push(`source Workspace (${source.reasons.join(", ")})`);
  if (destination.protected) subjects.push(`destination Workspace (${destination.reasons.join(", ")})`);
  return `Explicit Protection grant required for ${subjects.join("; ")}`;
}

function ztsMessage(value: string): ZtsMessage {
  return { value, provenance: "zts_generated", interpretation: "data_only" };
}

function hasCanonicalPatchEnvelope(value: unknown): value is Patch {
  return Boolean(
    value
    && typeof value === "object"
    && !Array.isArray(value)
    && (
      Object.prototype.hasOwnProperty.call(value, "schemaVersion")
      || Object.prototype.hasOwnProperty.call(value, "snapshotRevision")
    )
  );
}

async function readPatchFile(path: string): Promise<Buffer> {
  const handle = await open(path, "r");
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile()) throw new PatchInputValidationError("Patch input path must be a regular file; use - for stdin");
    assertPatchInputSize(metadata.size);

    const chunks: Buffer[] = [];
    let totalBytes = 0;
    while (true) {
      const readBytes = Math.min(
        PATCH_INPUT_READ_CHUNK_BYTES,
        PATCH_INPUT_MAX_BYTES - totalBytes + 1
      );
      const chunk = Buffer.allocUnsafe(readBytes);
      const result = await handle.read(chunk, 0, readBytes, null);
      if (result.bytesRead === 0) break;
      totalBytes += result.bytesRead;
      assertPatchInputSize(totalBytes);
      chunks.push(chunk.subarray(0, result.bytesRead));
    }
    return Buffer.concat(chunks, totalBytes);
  } finally {
    await handle.close();
  }
}

async function readStdin(): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  for await (const chunk of process.stdin) {
    const byteLength = typeof chunk === "string" ? Buffer.byteLength(chunk) : chunk.byteLength;
    assertPatchInputSize(totalBytes + byteLength);
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    chunks.push(bytes);
    totalBytes += bytes.byteLength;
  }
  return Buffer.concat(chunks, totalBytes);
}

function assertPatchInputSize(byteLength: number): void {
  if (!Number.isSafeInteger(byteLength) || byteLength < 0 || byteLength > PATCH_INPUT_MAX_BYTES) {
    throw new PatchInputValidationError(`Patch input exceeds the ${PATCH_INPUT_MAX_BYTES}-byte limit`);
  }
}
