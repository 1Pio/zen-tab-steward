import { createPlan } from "../dist/domain/change.js";
import { sha256Canonical } from "../dist/domain/digest.js";
import { createSnapshot } from "../dist/domain/snapshot.js";
import { resolveOrCreatePlan } from "../dist/plans.js";

const now = new Date("2026-07-11T05:00:00.000Z");
const snapshot = snapshotFixture(now, "M".repeat(2 * 1024 * 1024));
let peakHeapBytes = 0;

for (let index = 0; index < 14; index += 1) {
  const requestRevision = sha256Canonical({ kind: "bounded-memory-probe", index });
  await resolveOrCreatePlan(
    snapshot,
    requestRevision,
    () => createPlan(snapshot, {
      schemaVersion: "zts.plan.provisional-1",
      id: `plan:bounded-memory-probe:${index}`,
      configRevision: sha256Canonical({ config: "fixture" }),
      engineManifestRevision: sha256Canonical({ engine: "fixture" }),
      createdAt: new Date(now.getTime() + index).toISOString(),
      expiresAt: new Date(now.getTime() + 5 * 60 * 1000 + index).toISOString(),
      derivation: { kind: "original" },
      source: { kind: "engine", engine: "rules", intentRevision: requestRevision },
      actions: []
    }),
    new Date(now.getTime() + index)
  );
  peakHeapBytes = Math.max(peakHeapBytes, process.memoryUsage().heapUsed);
}

process.stdout.write(`${JSON.stringify({ peakHeapBytes })}\n`);

function snapshotFixture(capturedAt, workspaceName) {
  const profileId = "profile:plan-memory-fixture";
  const platform = "darwin-arm64";
  const zenVersion = "fixture-1";
  const zenBuildId = "fixture-build-1";
  const schemaFamily = "fixture-schema-1";
  const scope = {
    profileId,
    route: "closed_session",
    platform,
    zenVersion,
    zenBuildId,
    schemaFamily,
    entityKind: null
  };
  const proof = (id) => ({
    artifact: { id: `proof:${id}`, digest: sha256Canonical({ proof: id }) },
    source: "runtime_probe",
    capturedAt: capturedAt.toISOString(),
    scope,
    controlSessionId: null,
    processBindingRevision: null
  });
  return createSnapshot({
    schemaVersion: "zts.snapshot.provisional-1",
    profile: { id: profileId, name: "Fixture", contentTrust: "browser_untrusted" },
    capturedAt: capturedAt.toISOString(),
    authority: "authoritative",
    freshness: "current",
    provenance: {
      route: "closed_session",
      sourceRevision: sha256Canonical({ source: "fixture" }),
      platform,
      zenVersion,
      zenBuildId,
      schemaFamily
    },
    capabilities: {
      observedAt: capturedAt.toISOString(),
      evidence: [
        {
          id: "observe.snapshot",
          status: "available",
          reason: "Synthetic observed Snapshot",
          proof: proof("observe")
        },
        {
          id: "profile.exclusive_control",
          status: "available",
          reason: "Synthetic exclusive Profile control",
          proof: proof("control")
        }
      ]
    },
    workspaces: [{
      id: "workspace-fixture",
      name: workspaceName,
      contentTrust: "browser_untrusted",
      position: 0,
      protection: {
        source: { protected: false, reasons: [] },
        destination: { protected: false, reasons: [] }
      }
    }],
    entities: []
  });
}
