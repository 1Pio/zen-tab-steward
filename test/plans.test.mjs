import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { createPlan } from "../dist/domain/change.js";
import { sha256Canonical } from "../dist/domain/digest.js";
import { createSnapshot } from "../dist/domain/snapshot.js";
import {
  DEFAULT_PLAN_STORE_POLICY,
  loadStoredPlan,
  publishDetachedPlanObject,
  resolveOrCreatePlan
} from "../dist/plans.js";

const roots = new Set();

after(async () => {
  await Promise.all([...roots].map((root) => rm(root, { recursive: true, force: true })));
});

test("a Plan interrupted after its request pointer repairs every selector before reuse succeeds", async () => {
  await withPlanStore(async ({ snapshot, now, requestRevision, create }) => {
    await assert.rejects(
      () => resolveOrCreatePlan(
        snapshot,
        requestRevision,
        create,
        now,
        "create_or_reuse",
        DEFAULT_PLAN_STORE_POLICY,
        {
          afterRequestPointerPublication: () => {
            throw new Error("fixture interruption after request pointer");
          }
        }
      ),
      /fixture interruption after request pointer/
    );

    const repaired = await resolveOrCreatePlan(snapshot, requestRevision, create, now);
    assert.equal(repaired.resolution, "reused_latest");
    await assertEverySelectorResolves(repaired.plan.profileId, repaired.plan.id, repaired.plan.digest);
  });
});

test("a Plan interrupted after its object publishes a complete selector set on retry", async () => {
  await withPlanStore(async ({ snapshot, now, requestRevision, create }) => {
    await assert.rejects(
      () => resolveOrCreatePlan(
        snapshot,
        requestRevision,
        create,
        now,
        "create_or_reuse",
        DEFAULT_PLAN_STORE_POLICY,
        {
          afterObjectPublication: () => {
            throw new Error("fixture interruption after Plan object");
          }
        }
      ),
      /fixture interruption after Plan object/
    );

    const completed = await resolveOrCreatePlan(snapshot, requestRevision, create, now);
    assert.equal(completed.resolution, "created");
    await assertEverySelectorResolves(completed.plan.profileId, completed.plan.id, completed.plan.digest);
  });
});

test("a Plan interrupted after its id pointer repairs latest before reuse succeeds", async () => {
  await withPlanStore(async ({ snapshot, now, requestRevision, create }) => {
    await assert.rejects(
      () => resolveOrCreatePlan(
        snapshot,
        requestRevision,
        create,
        now,
        "create_or_reuse",
        DEFAULT_PLAN_STORE_POLICY,
        {
          afterIdPointerPublication: () => {
            throw new Error("fixture interruption after Plan id pointer");
          }
        }
      ),
      /fixture interruption after Plan id pointer/
    );

    const repaired = await resolveOrCreatePlan(snapshot, requestRevision, create, now);
    assert.equal(repaired.resolution, "reused_latest");
    await assertEverySelectorResolves(repaired.plan.profileId, repaired.plan.id, repaired.plan.digest);
  });
});

test("a Plan interrupted after latest publication remains exactly reusable", async () => {
  await withPlanStore(async ({ snapshot, now, requestRevision, create }) => {
    await assert.rejects(
      () => resolveOrCreatePlan(
        snapshot,
        requestRevision,
        create,
        now,
        "create_or_reuse",
        DEFAULT_PLAN_STORE_POLICY,
        {
          afterLatestPointerPublication: () => {
            throw new Error("fixture interruption after latest pointer");
          }
        }
      ),
      /fixture interruption after latest pointer/
    );

    const repaired = await resolveOrCreatePlan(snapshot, requestRevision, create, now);
    assert.equal(repaired.resolution, "reused_latest");
    await assertEverySelectorResolves(repaired.plan.profileId, repaired.plan.id, repaired.plan.digest);
  });
});

test("Plan-store inventory validates large envelopes under a bounded heap", async () => {
  const root = await mkdtemp(join(tmpdir(), "zts-plan-memory-"));
  roots.add(root);
  const probe = spawnSync(
    process.execPath,
    ["--max-old-space-size=64", "test/plan-store-memory-probe.mjs"],
    {
      cwd: process.cwd(),
      env: { ...process.env, ZTS_STATE_DIR: join(root, "state") },
      encoding: "utf8",
      timeout: 30_000,
      maxBuffer: 1024 * 1024
    }
  );
  assert.equal(probe.status, 0, `${probe.stdout}\n${probe.stderr}`);
  const report = JSON.parse(probe.stdout);
  assert.equal(Number.isSafeInteger(report.peakHeapBytes), true);
  assert.equal(report.peakHeapBytes < 64 * 1024 * 1024, true);
});

test("a complete reused Plan does not republish already coherent pointers", async () => {
  await withPlanStore(async ({ snapshot, now, requestRevision, create }) => {
    const created = await resolveOrCreatePlan(snapshot, requestRevision, create, now);
    const reused = await resolveOrCreatePlan(
      snapshot,
      requestRevision,
      create,
      now,
      "create_or_reuse",
      DEFAULT_PLAN_STORE_POLICY,
      {
        afterIdPointerPublication: () => {
          throw new Error("coherent id pointer was unexpectedly replaced");
        },
        afterLatestPointerPublication: () => {
          throw new Error("coherent latest pointer was unexpectedly replaced");
        }
      }
    );
    assert.equal(reused.resolution, "reused_latest");
    assert.equal(reused.plan.digest, created.plan.digest);
  });
});

test("Plan store control removes exact prelink and pre-rename temporaries while reads remain non-mutating", async () => {
  await withPlanStore(async ({ snapshot, now, requestRevision, create, state }) => {
    const created = await resolveOrCreatePlan(snapshot, requestRevision, create, now);
    const profilesRoot = join(state, "plans");
    const profileSegments = await readdir(profilesRoot);
    assert.equal(profileSegments.length, 1);
    const planRoot = join(profilesRoot, profileSegments[0]);
    const latestPath = join(planRoot, "latest.json");
    const objectCrash = [
      'import { publishPrivateBytes } from "./dist/private-store.js";',
      `await publishPrivateBytes(${JSON.stringify(join(planRoot, "objects", `${"f".repeat(64)}.json`))}, Buffer.from("uncommitted Plan object"), 1024, { afterTemporaryWrite: () => process.exit(95) });`
    ].join("\n");
    const pointerCrash = [
      'import { replacePrivateBytes } from "./dist/private-store.js";',
      `await replacePrivateBytes(${JSON.stringify(latestPath)}, Buffer.from(${JSON.stringify('{"schemaVersion":"never-committed"}\n')}), 16384, { beforeRename: () => process.exit(96) });`
    ].join("\n");
    for (const [script, status] of [[objectCrash, 95], [pointerCrash, 96]]) {
      const crashed = spawnSync(process.execPath, ["--input-type=module", "--eval", script], {
        cwd: process.cwd(),
        env: { ...process.env, ZTS_STATE_DIR: state },
        encoding: "utf8"
      });
      assert.equal(crashed.status, status, `${crashed.stdout}\n${crashed.stderr}`);
    }
    assert.equal((await readdir(join(planRoot, "objects"))).some((entry) => entry.startsWith(".tmp-")), true);
    assert.equal((await readdir(planRoot)).some((entry) => entry.startsWith(".tmp-")), true);

    assert.equal((await loadStoredPlan(snapshot.profile.id, "latest")).plan.digest, created.plan.digest);
    assert.equal((await readdir(planRoot)).some((entry) => entry.startsWith(".tmp-")), true,
      "read-only Plan load must not delete replacement residue");

    const reused = await resolveOrCreatePlan(snapshot, requestRevision, create, now);
    assert.equal(reused.plan.digest, created.plan.digest);
    assert.equal((await readdir(join(planRoot, "objects"))).some((entry) => entry.startsWith(".tmp-")), false);
    assert.equal((await readdir(planRoot)).some((entry) => entry.startsWith(".tmp-")), false);
  });
});

test("an aged detached Plan remains retained until its executable lifetime expires", async () => {
  const root = await mkdtemp(join(tmpdir(), "zts-plan-detached-age-"));
  roots.add(root);
  const previousStateDir = process.env.ZTS_STATE_DIR;
  process.env.ZTS_STATE_DIR = join(root, "state");
  try {
    const publishedAt = new Date();
    const sourceCompletedAt = new Date(publishedAt.getTime() - (7 * 24 * 60 * 60 * 1000));
    const maintenanceAt = new Date(publishedAt.getTime() + (2 * 24 * 60 * 60 * 1000));
    const snapshot = snapshotFixture(sourceCompletedAt);
    const oldRequest = sha256Canonical({ kind: "old-detached-undo" });
    const oldPlan = createPlan(snapshot, {
      schemaVersion: "zts.plan.provisional-1",
      id: "plan:detached-old-semantic-time",
      configRevision: sha256Canonical({ config: "fixture" }),
      engineManifestRevision: sha256Canonical({ engine: "fixture" }),
      createdAt: sourceCompletedAt.toISOString(),
      expiresAt: new Date(sourceCompletedAt.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString(),
      derivation: { kind: "original" },
      source: { kind: "engine", engine: "rules", intentRevision: oldRequest },
      actions: []
    });
    const detached = await publishDetachedPlanObject(snapshot, oldPlan, oldRequest, publishedAt);

    const currentRequest = sha256Canonical({ kind: "maintenance-trigger" });
    await resolveOrCreatePlan(snapshot, currentRequest, () => createPlan(snapshot, {
      schemaVersion: "zts.plan.provisional-1",
      id: "plan:maintenance-trigger",
      configRevision: sha256Canonical({ config: "fixture" }),
      engineManifestRevision: sha256Canonical({ engine: "fixture" }),
      createdAt: maintenanceAt.toISOString(),
      expiresAt: new Date(maintenanceAt.getTime() + 5 * 60 * 1000).toISOString(),
      derivation: { kind: "original" },
      source: { kind: "engine", engine: "rules", intentRevision: currentRequest },
      actions: []
    }), maintenanceAt, "create_or_reuse", {
      ...DEFAULT_PLAN_STORE_POLICY,
      unreferencedRetentionMs: 0
    });

    assert.equal((await loadStoredPlan(snapshot.profile.id, detached.plan.digest)).plan.digest, detached.plan.digest);
  } finally {
    if (previousStateDir === undefined) delete process.env.ZTS_STATE_DIR;
    else process.env.ZTS_STATE_DIR = previousStateDir;
  }
});

async function withPlanStore(run) {
  const root = await mkdtemp(join(tmpdir(), "zts-plan-publication-"));
  roots.add(root);
  const previousStateDir = process.env.ZTS_STATE_DIR;
  const state = join(root, "state");
  process.env.ZTS_STATE_DIR = state;
  try {
    const now = new Date("2026-07-11T05:00:00.000Z");
    const snapshot = snapshotFixture(now);
    const requestRevision = sha256Canonical({ kind: "plan-publication-fixture" });
    const create = () => createPlan(snapshot, {
      schemaVersion: "zts.plan.provisional-1",
      id: "plan:publication-fixture",
      configRevision: sha256Canonical({ config: "fixture" }),
      engineManifestRevision: sha256Canonical({ engine: "fixture" }),
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + 5 * 60 * 1000).toISOString(),
      derivation: { kind: "original" },
      source: { kind: "engine", engine: "rules", intentRevision: requestRevision },
      actions: []
    });
    await run({ snapshot, now, requestRevision, create, state });
  } finally {
    if (previousStateDir === undefined) delete process.env.ZTS_STATE_DIR;
    else process.env.ZTS_STATE_DIR = previousStateDir;
  }
}

async function assertEverySelectorResolves(profileId, planId, digest) {
  const [byId, latest, byDigest] = await Promise.all([
    loadStoredPlan(profileId, planId),
    loadStoredPlan(profileId, "latest"),
    loadStoredPlan(profileId, digest)
  ]);
  assert.equal(byId.plan.digest, digest);
  assert.equal(latest.plan.digest, digest);
  assert.equal(byDigest.plan.digest, digest);
}

function snapshotFixture(now) {
  const profileId = "profile:plan-publication-fixture";
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
    capturedAt: now.toISOString(),
    scope,
    controlSessionId: null,
    processBindingRevision: null
  });
  return createSnapshot({
    schemaVersion: "zts.snapshot.provisional-1",
    profile: { id: profileId, name: "Fixture", contentTrust: "browser_untrusted" },
    capturedAt: now.toISOString(),
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
      observedAt: now.toISOString(),
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
      name: "Fixture",
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
