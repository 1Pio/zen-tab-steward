import { artifactObjectPath } from "./apply-artifacts.js";
import { definePlanForSnapshot } from "./domain/change.js";
import { defineSnapshot } from "./domain/snapshot.js";
import { publishOwnedPrivateBytes, readPrivateJson } from "./private-store.js";

import type { ApplyArtifactLayout } from "./apply-artifacts.js";
import type { Plan } from "./domain/change.js";
import type { ArtifactReference, Snapshot } from "./domain/snapshot.js";

const INVERSE_SCHEMA = "zts.inverse-plan-artifact.provisional-1" as const;
export const INVERSE_PLAN_MAX_BYTES = 128 * 1024 * 1024;

export class InversePlanArtifactLimitError extends Error {
  readonly byteLength: number;

  constructor(byteLength: number) {
    super(
      `Inverse Plan artifact is ${byteLength} bytes and exceeds the coherent ${INVERSE_PLAN_MAX_BYTES}-byte Snapshot/Plan envelope limit`
    );
    this.name = "InversePlanArtifactLimitError";
    this.byteLength = byteLength;
  }
}

interface InversePlanEnvelope {
  readonly schemaVersion: typeof INVERSE_SCHEMA;
  readonly snapshot: Snapshot;
  readonly plan: Plan;
}

export async function publishInversePlan(
  layout: ApplyArtifactLayout,
  snapshot: Snapshot,
  plan: Plan
): Promise<ArtifactReference> {
  definePlanForSnapshot(snapshot, plan);
  const reference = { id: plan.id, digest: plan.digest } as const;
  const envelope: InversePlanEnvelope = {
    schemaVersion: INVERSE_SCHEMA,
    snapshot,
    plan
  };
  const bytes = encodeInversePlanEnvelope(envelope);
  await publishOwnedPrivateBytes(
    artifactObjectPath(layout.inverses, reference.digest),
    bytes,
    INVERSE_PLAN_MAX_BYTES
  );
  return reference;
}

export async function loadInversePlan(
  layout: ApplyArtifactLayout,
  reference: ArtifactReference
): Promise<{ readonly snapshot: Snapshot; readonly plan: Plan }> {
  const value = await readPrivateJson(
    artifactObjectPath(layout.inverses, reference.digest),
    INVERSE_PLAN_MAX_BYTES
  );
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Inverse Plan artifact must be an object");
  }
  const keys = Object.keys(value).sort();
  const expected = ["schemaVersion", "snapshot", "plan"].sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw new Error("Inverse Plan artifact contains unknown or missing fields");
  }
  const envelope = value as InversePlanEnvelope;
  if (envelope.schemaVersion !== INVERSE_SCHEMA) throw new Error("Unsupported inverse Plan artifact schema");
  const snapshot = defineSnapshot(envelope.snapshot);
  const plan = definePlanForSnapshot(snapshot, envelope.plan);
  if (plan.id !== reference.id || plan.digest !== reference.digest) {
    throw new Error("Inverse Plan artifact does not match its reference");
  }
  return { snapshot, plan };
}

function encodeInversePlanEnvelope(envelope: InversePlanEnvelope): Buffer {
  const serialized = JSON.stringify(envelope, null, 2);
  if (serialized === undefined) throw new Error("Inverse Plan artifact cannot be encoded as JSON");
  const bytes = Buffer.from(`${serialized}\n`, "utf8");
  if (bytes.byteLength > INVERSE_PLAN_MAX_BYTES) {
    throw new InversePlanArtifactLimitError(bytes.byteLength);
  }
  return bytes;
}
