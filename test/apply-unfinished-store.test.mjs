import assert from "node:assert/strict";
import { mkdtemp, mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { applyArtifactLayout } from "../dist/apply-artifacts.js";
import { createApplyJournal } from "../dist/apply-journal.js";
import {
  APPLY_UNFINISHED_MARKER_MAX_BYTES,
  initializeApplyUnfinishedIndex,
  prepareApplyUnfinishedMarker,
  publishApplyUnfinishedMarker,
  readApplyUnfinishedMarkers
} from "../dist/apply-unfinished-store.js";
import {
  APPLY_TRANSACTION_ARTIFACT_CAP_BYTES,
  APPLY_TRANSACTION_MAX_ARTIFACT_BYTES,
  APPLY_TRANSACTION_RESERVATION_BYTES,
  readApplyStoreAccounting
} from "../dist/apply-store-accounting.js";
import {
  ApplyTransactionSafetyError,
  applyStoredPlanClosedSession
} from "../dist/apply-transaction.js";
import { listApplyRecoveryInspections } from "../dist/apply-recovery.js";
import {
  createApplyAuthorization,
  createPlan,
  createProtectionGrant
} from "../dist/domain/change.js";
import { sha256Canonical } from "../dist/domain/digest.js";
import { createSnapshot } from "../dist/domain/snapshot.js";
import { defineInvocationConsent, INVOCATION_CONSENT_SCHEMA } from "../dist/invocation-consent.js";
import { profileIdForPath } from "../dist/profile.js";

const MEBIBYTE = 1024 * 1024;
const CREATED_AT = "2026-07-11T08:00:00.000Z";
const AUTHORIZED_AT = "2026-07-11T08:01:00.000Z";
const EXPIRES_AT = "2026-07-11T09:00:00.000Z";

test("transaction reservation keeps every finite normal fallback and recovery fan-out slot", () => {
  const caps = APPLY_TRANSACTION_ARTIFACT_CAP_BYTES;
  for (const key of [
    "normalPrimaryControlProof",
    "normalFallbackControlProof",
    "recoveryControlProof",
    "normalPrimaryImmutableJournal",
    "normalFallbackImmutableJournal",
    "recoveryImmutableJournal",
    "normalPreMutationRecoveryDescriptor",
    "recoveryCreatedDescriptor"
  ]) {
    assert.equal(caps[key], 16 * MEBIBYTE, `${key} has its own bounded durable slot`);
  }
  assert.equal(
    Object.values(caps).reduce((total, value) => total + value, 0),
    APPLY_TRANSACTION_MAX_ARTIFACT_BYTES
  );
  assert.equal(APPLY_TRANSACTION_RESERVATION_BYTES, APPLY_TRANSACTION_MAX_ARTIFACT_BYTES);
});

test("unfinished markers above 4 MiB round-trip under the one accounted marker cap", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "zts-unfinished-large-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await withEnvironment({ ZTS_STATE_DIR: join(root, "state") }, async () => {
    const fixture = protectedPlanFixture(
      "profile:large-marker-round-trip",
      "r".repeat(4 * MEBIBYTE + 64 * 1024)
    );
    const transactionId = "apply:00000000-0000-4000-8000-000000000001";
    const bootstrap = markerBootstrap(fixture, transactionId);
    const journal = createApplyJournal({
      transactionId,
      planId: fixture.plan.id,
      planDigest: fixture.plan.digest,
      authorizationRevision: bootstrap.authorization.revision,
      profileId: fixture.plan.profileId,
      targetPathRevision: sha256Canonical({ path: "/fixture/zen-sessions.jsonlz4" })
    }, new Date(AUTHORIZED_AT));
    const prepared = prepareApplyUnfinishedMarker(journal, bootstrap, fixture.plan);

    assert.ok(prepared.byteLength > 4 * MEBIBYTE);
    assert.ok(prepared.byteLength < APPLY_UNFINISHED_MARKER_MAX_BYTES);
    assert.equal(
      APPLY_TRANSACTION_ARTIFACT_CAP_BYTES.unfinishedMarker,
      APPLY_UNFINISHED_MARKER_MAX_BYTES
    );

    const layout = await applyArtifactLayout(fixture.plan.profileId);
    await initializeApplyUnfinishedIndex(layout, fixture.plan.profileId);
    await publishApplyUnfinishedMarker(layout, prepared);
    const markerName = (await readdir(layout.unfinished)).find((entry) => entry !== "index.json");
    assert.ok(markerName);
    assert.equal((await stat(join(layout.unfinished, markerName))).size, prepared.byteLength);

    const markers = await readApplyUnfinishedMarkers(
      layout,
      fixture.plan.profileId,
      async (_profileId, planDigest) => {
        assert.equal(planDigest, fixture.plan.digest);
        return fixture.plan;
      }
    );
    assert.equal(markers?.length, 1);
    assert.equal(markers[0].journal.transactionId, transactionId);
    assert.equal(markers[0].bootstrap.authorization.revision, bootstrap.authorization.revision);
    assert.equal(
      markers[0].bootstrap.authorization.protectionGrants[0].reasons[0].length,
      4 * MEBIBYTE + 64 * 1024
    );
  });
});

test("over-cap Apply intent refuses before reservation and produces no recovery transaction", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "zts-unfinished-over-cap-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stateDir = join(root, "state");
  const appSupportDir = join(root, "app-support");
  const profilePath = join(appSupportDir, "Profiles", "fixture.default");
  await mkdir(profilePath, { recursive: true, mode: 0o700 });
  await writeFile(join(appSupportDir, "profiles.ini"), "", { mode: 0o600 });
  const profileId = profileIdForPath(profilePath);

  await withEnvironment({
    ZTS_STATE_DIR: stateDir,
    ZTS_CONFIG_PATH: join(root, "config", "config.toml")
  }, async () => {
    const fixture = protectedPlanFixture(
      profileId,
      "x".repeat(APPLY_UNFINISHED_MARKER_MAX_BYTES + 64 * 1024)
    );
    const context = {
      appSupportDir,
      profile: {
        id: profileId,
        name: "Fixture",
        path: profilePath,
        isDefault: true,
        fromInstallDefault: true
      },
      running: false,
      runningProcesses: [],
      sessionFile: {
        kind: "zen-sessions",
        path: join(profilePath, "zen-sessions.jsonlz4"),
        exists: true,
        size: 0,
        modifiedMs: 0
      }
    };
    const stored = {
      snapshot: fixture.snapshot,
      plan: fixture.plan,
      requestRevision: sha256Canonical({ request: "over-cap" }),
      artifact: { id: fixture.plan.id, digest: fixture.plan.digest }
    };
    let reservationHookReached = false;
    await assert.rejects(
      () => applyStoredPlanClosedSession(context, stored, {
        expectedDigest: fixture.plan.digest,
        command: "fixture over-cap Apply",
        now: new Date(AUTHORIZED_AT),
        afterStoreReservation: () => { reservationHookReached = true; }
      }),
      (error) => error instanceof ApplyTransactionSafetyError
        && /unfinished marker .* exceeds .* transaction limit/iu.test(error.message)
    );
    assert.equal(reservationHookReached, false);

    const layout = await applyArtifactLayout(profileId);
    const accounting = await readApplyStoreAccounting(layout, profileId);
    assert.ok(accounting);
    assert.equal(accounting.activeReservation, null);
    assert.deepEqual(await readApplyUnfinishedMarkers(layout, profileId, async () => fixture.plan), []);
    assert.deepEqual(await readdir(layout.transactions), []);
    assert.deepEqual(await listApplyRecoveryInspections(context), []);
  });
});

function protectedPlanFixture(profileId, reason) {
  const scope = {
    profileId,
    route: "closed_session",
    platform: "darwin-arm64",
    zenVersion: "fixture-1",
    zenBuildId: "fixture-build-1",
    schemaFamily: "fixture-schema-1",
    entityKind: null
  };
  const proof = (id, entityKind = null) => ({
    artifact: { id: `proof:${id}`, digest: sha256Canonical({ proof: id }) },
    source: "runtime_probe",
    capturedAt: CREATED_AT,
    scope: { ...scope, entityKind },
    controlSessionId: null,
    processBindingRevision: null
  });
  const snapshot = createSnapshot({
    schemaVersion: "zts.snapshot.provisional-1",
    profile: { id: profileId, name: "Fixture", contentTrust: "browser_untrusted" },
    capturedAt: CREATED_AT,
    authority: "authoritative",
    freshness: "current",
    provenance: {
      route: "closed_session",
      sourceRevision: sha256Canonical({ source: "fixture" }),
      platform: scope.platform,
      zenVersion: scope.zenVersion,
      zenBuildId: scope.zenBuildId,
      schemaFamily: scope.schemaFamily
    },
    capabilities: {
      observedAt: CREATED_AT,
      evidence: [
        {
          id: "profile.exclusive_control",
          status: "available",
          reason: "Synthetic exclusive closed-Profile fixture",
          proof: proof("exclusive")
        },
        {
          id: "observe.snapshot",
          status: "available",
          reason: "Synthetic closed Snapshot",
          proof: proof("observe")
        },
        {
          id: "move.tab",
          status: "available",
          reason: "Synthetic closed-session tab movement fixture",
          proof: proof("move-tab", "tab")
        }
      ]
    },
    workspaces: [
      {
        id: "workspace-inbox",
        name: "Inbox",
        contentTrust: "browser_untrusted",
        position: 0,
        protection: {
          source: { protected: false, reasons: [] },
          destination: { protected: false, reasons: [] }
        }
      },
      {
        id: "workspace-research",
        name: "Research",
        contentTrust: "browser_untrusted",
        position: 1,
        protection: {
          source: { protected: false, reasons: [] },
          destination: { protected: false, reasons: [] }
        }
      }
    ],
    entities: [{
      ref: "entity:root:tab-1",
      kind: "tab",
      nativeId: "tab-1",
      parentRef: null,
      childRefs: [],
      structuralRootRef: "entity:root:tab-1",
      workspaceId: "workspace-inbox",
      title: "Protected fixture tab",
      contentTrust: "browser_untrusted",
      members: [{
        nativeId: "tab-1",
        title: "Protected fixture tab",
        url: "https://fixture.example.test/tab/1",
        contentTrust: "browser_untrusted",
        pinned: true,
        essential: false,
        hidden: false,
        active: true
      }],
      protection: { protected: true, reasons: [reason] }
    }]
  });
  const entity = snapshot.entities[0];
  const protectionRevision = sha256Canonical(entity.protection);
  const plan = createPlan(snapshot, {
    schemaVersion: "zts.plan.provisional-1",
    id: "plan:protected-marker-fixture",
    configRevision: sha256Canonical({ config: "fixture" }),
    engineManifestRevision: sha256Canonical({ engine: "manual" }),
    createdAt: CREATED_AT,
    expiresAt: EXPIRES_AT,
    derivation: { kind: "original" },
    source: { kind: "manual_patch", intentRevision: sha256Canonical({ intent: "fixture" }) },
    actions: [{
      actionId: "action:move-protected-tab",
      disposition: "move",
      operation: {
        op: "move",
        entityRef: entity.ref,
        entityKind: entity.kind,
        precondition: {
          entityRevision: entity.revision,
          entityProtection: {
            protected: true,
            reasons: [reason],
            protectionRevision,
            requiredGrantId: "grant:move-protected-tab"
          },
          sourceWorkspace: {
            workspaceId: "workspace-inbox",
            protection: { protected: false, reasons: [], requiredGrantId: null }
          },
          destinationWorkspace: {
            workspaceId: "workspace-research",
            protection: { protected: false, reasons: [], requiredGrantId: null }
          }
        },
        expectedPostState: { workspaceId: "workspace-research" },
        inverse: { op: "move", destinationWorkspaceId: "workspace-inbox" }
      },
      decision: {
        engine: "manual",
        trustClass: "manual_exact",
        explanation: {
          value: "Exact user-authored Patch",
          provenance: "caller_untrusted",
          interpretation: "data_only",
          referencedEntityRefs: [entity.ref]
        },
        evidenceRevision: sha256Canonical({ evidence: "manual" }),
        autoApply: {
          status: "not_requested",
          requested: false,
          eligible: false,
          reason: {
            value: "Manual apply uses exact authorization",
            provenance: "zts_generated",
            interpretation: "data_only"
          }
        }
      }
    }]
  });
  return { snapshot, plan, reason, protectionRevision };
}

function markerBootstrap(fixture, transactionId) {
  const consent = defineInvocationConsent({
    schemaVersion: INVOCATION_CONSENT_SCHEMA,
    transactionId,
    planId: fixture.plan.id,
    planDigest: fixture.plan.digest,
    confirmedDigest: fixture.plan.digest,
    confirmedAt: AUTHORIZED_AT,
    commandRevision: sha256Canonical({ command: "fixture apply" }),
    purpose: { kind: "apply" }
  }, {
    transactionId,
    planId: fixture.plan.id,
    planDigest: fixture.plan.digest,
    planSource: fixture.plan.source
  });
  const consentArtifact = {
    id: `consent:${transactionId}`,
    digest: sha256Canonical(consent)
  };
  const protectionGrant = createProtectionGrant({
    id: "grant:move-protected-tab",
    planDigest: fixture.plan.digest,
    actionId: "action:move-protected-tab",
    protectionRevision: fixture.protectionRevision,
    reasons: [fixture.reason],
    issuedBy: "invocation",
    subject: { kind: "entity", entityRef: "entity:root:tab-1" }
  });
  const authorization = createApplyAuthorization(fixture.snapshot, fixture.plan, {
    schemaVersion: "zts.authorization.provisional-1",
    id: `authorization:${transactionId}`,
    planId: fixture.plan.id,
    planDigest: fixture.plan.digest,
    profileId: fixture.plan.profileId,
    authorizedAt: AUTHORIZED_AT,
    expiresAt: EXPIRES_AT,
    source: { kind: "unattended_invocation", consentArtifact },
    authorizedActionIds: ["action:move-protected-tab"],
    allowedTrustClasses: ["manual_exact"],
    protectionGrants: [protectionGrant],
    lifecycle: { kind: "none" },
    wholePlanPreflight: true
  });
  return {
    consent,
    consentArtifact,
    authorization,
    authorizationArtifact: { id: authorization.id, digest: authorization.revision }
  };
}

async function withEnvironment(overrides, run) {
  const prior = new Map();
  for (const [key, value] of Object.entries(overrides)) {
    prior.set(key, process.env[key]);
    process.env[key] = value;
  }
  try {
    return await run();
  } finally {
    for (const [key, value] of prior) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}
