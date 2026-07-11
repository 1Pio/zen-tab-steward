import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFile, chmod, link, lstat, mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import test, { after } from "node:test";
import { promisify } from "node:util";
import { encodeLiteralJsonLz4ForFixture, readJsonLz4, writeJsonLz4 } from "../dist/mozlz4.js";
import { createPlan } from "../dist/domain/change.js";
import { sha256Canonical } from "../dist/domain/digest.js";
import { APPLY_STORE_ACCOUNTING_MAX_BYTES } from "../dist/apply-store-accounting.js";

const execFileAsync = promisify(execFile);
const dailyFixtureRoots = new Set();

after(async () => {
  await Promise.all([...dailyFixtureRoots].map((root) => rm(root, { recursive: true, force: true })));
});

test("all-workspace preview and dry-run reuse one protected state-bound Plan", async () => {
  const fixture = await makeDailySortFixture();
  const env = {
    ...process.env,
    HOME: fixture.temp,
    PATH: `${fixture.binDir}:${process.env.PATH ?? ""}`,
    ZTS_ZEN_APP_SUPPORT_DIR: fixture.appSupportDir,
    ZTS_STATE_DIR: fixture.stateDir,
    ZTS_CONFIG_PATH: fixture.configPath
  };
  const beforeSession = await readFile(fixture.sessionPath);

  const preview = spawnSync(
    "node",
    ["dist/cli.js", "sort", "--all", "--engine", "rules", "--preview", "--json"],
    { env, encoding: "utf8" }
  );
  assert.equal(preview.status, 0, `${preview.stdout}\n${preview.stderr}`);
  const previewJson = JSON.parse(preview.stdout);

  const dryRun = spawnSync(
    "node",
    ["dist/cli.js", "sort", "--all", "--engine", "rules", "--dry-run", "--json"],
    { env, encoding: "utf8" }
  );
  assert.equal(dryRun.status, 0, `${dryRun.stdout}\n${dryRun.stderr}`);
  const dryRunJson = JSON.parse(dryRun.stdout);

  assert.equal(previewJson.data.mode, "preview");
  assert.equal(dryRunJson.data.mode, "dry-run");
  assert.equal(previewJson.suggestedNextCommands.includes("zts apply latest"), false);
  assert.ok(previewJson.suggestedNextCommands.includes("zts plan show latest"));
  assert.equal(previewJson.data.sourceScope.kind, "all_workspaces");
  assert.equal(previewJson.data.plan.schemaVersion, "zts.plan.provisional-1");
  assert.equal(previewJson.data.plan.source.kind, "engine");
  assert.equal(previewJson.data.plan.source.engine, "rules");
  assert.equal(previewJson.data.plan.digest, dryRunJson.data.plan.digest);
  assert.equal(previewJson.data.plan.id, dryRunJson.data.plan.id);
  assert.deepEqual(previewJson.data.plan.actions, dryRunJson.data.plan.actions);
  assert.equal(dryRunJson.data.planResolution, "reused_latest");

  const actions = previewJson.data.plan.actions;
  const stashEntity = previewJson.data.snapshot.entities.find((entity) => entity.nativeId === "tab-stash-github");
  assert.ok(stashEntity);
  const stashAction = actions.find((action) => {
    const entityRef = action.disposition === "move" ? action.operation.entityRef : action.entityRef;
    return entityRef === stashEntity.ref;
  });
  assert.equal(stashAction?.disposition, "protected");
  assert.equal(
    actions.some((action) => action.disposition === "move" && action.operation.expectedPostState.workspaceId === "w-stash"),
    false
  );
  assert.equal(
    actions.some((action) => action.disposition === "move" && action.operation.precondition.sourceWorkspace.workspaceId === "w-portfolio"),
    true
  );
  assert.equal(
    actions.some((action) => action.disposition === "move" && action.operation.precondition.sourceWorkspace.workspaceId === "w-space"),
    true
  );

  const afterSession = await readFile(fixture.sessionPath);
  assert.deepEqual(afterSession, beforeSession);

  const showLatest = await execFileAsync("node", ["dist/cli.js", "plan", "show", "latest", "--json"], { env });
  const latestJson = JSON.parse(showLatest.stdout);
  assert.equal(latestJson.data.plan.digest, previewJson.data.plan.digest);
  assert.equal(latestJson.suggestedNextCommands.includes("zts apply latest"), false);
  assert.ok(latestJson.suggestedNextCommands.includes("zts sort --all --engine rules --dry-run"));
});

test("an authoritative multi-move Plan applies through one managed quit and relaunch Receipt", async () => {
  const fixture = await makeDailySortFixture();
  const env = dailySortEnv(fixture);
  const plan = previewDailyPlan(env);
  const moveCount = plan.actions.filter((action) => action.disposition === "move").length;
  assert.ok(moveCount >= 2);
  const script = managedApplyEvalScript(fixture, plan);
  const applied = spawnSync("node", ["--input-type=module", "--eval", script], {
    cwd: process.cwd(), env, encoding: "utf8"
  });
  assert.equal(applied.status, 0, `${applied.stdout}\n${applied.stderr}`);
  const document = JSON.parse(applied.stdout);
  assert.equal(document.authorization.lifecycle.kind, "managed_zen");
  assert.match(document.authorization.lifecycle.grantRevision, /^sha256:[a-f0-9]{64}$/u);
  assert.equal(document.receipt.outcome, "applied");
  assert.equal(document.receipt.control.route, "managed_zen");
  assert.equal(document.receipt.control.quit, "verified");
  assert.equal(document.receipt.control.stateFlush, "verified");
  assert.equal(document.receipt.control.profileRestoration, "verified");
  assert.equal(document.receipt.control.relaunch, "verified");
  assert.equal(document.receipt.control.windowRestoration, "verified");
  assert.equal(document.receipt.operations.length, moveCount);
  assert.ok(document.receipt.operations.every((operation) => operation.status === "verified"));
});

test("managed Apply refuses whole-Plan Drift before mutation and still restores Zen", async () => {
  const fixture = await makeDailySortFixture();
  const env = dailySortEnv(fixture);
  const plan = previewDailyPlan(env);
  const moveActions = plan.actions.filter((action) => action.disposition === "move");
  assert.ok(moveActions.length >= 2);
  const shown = spawnSync("node", ["dist/cli.js", "plan", "show", plan.id, "--json"], { env, encoding: "utf8" });
  assert.equal(shown.status, 0, `${shown.stdout}\n${shown.stderr}`);
  const planSnapshot = JSON.parse(shown.stdout).data.snapshot;
  const sourceByNativeId = new Map(moveActions.map((action) => {
    const entity = planSnapshot.entities.find((candidate) => candidate.ref === action.operation.entityRef);
    assert.ok(entity?.nativeId);
    return [entity.nativeId, action.operation.precondition.sourceWorkspace.workspaceId];
  }));
  const drifted = await readJsonLz4(fixture.sessionPath);
  const unrelated = drifted.tabs.find((tab) => !sourceByNativeId.has(tab.zenSyncId));
  assert.ok(unrelated);
  unrelated.entries[0].title = `${unrelated.entries[0].title} drifted`;
  await writeJsonLz4(fixture.sessionPath, drifted);

  const blocked = spawnSync("node", ["--input-type=module", "--eval", managedApplyEvalScript(fixture, plan)], {
    cwd: process.cwd(), env, encoding: "utf8"
  });
  assert.equal(blocked.status, 0, `${blocked.stdout}\n${blocked.stderr}`);
  const document = JSON.parse(blocked.stdout);
  assert.equal(document.receipt.outcome, "blocked");
  assert.equal(document.receipt.control.route, "managed_zen");
  assert.equal(document.receipt.control.quit, "verified");
  assert.equal(document.receipt.control.stateFlush, "verified");
  assert.equal(document.receipt.control.profileRestoration, "verified");
  assert.equal(document.receipt.control.relaunch, "verified");
  assert.equal(document.receipt.control.windowRestoration, "verified");
  assert.ok(document.receipt.operations.every((operation) => operation.status === "not_attempted"));
  const after = await readJsonLz4(fixture.sessionPath);
  for (const [nativeId, sourceWorkspaceId] of sourceByNativeId) {
    assert.equal(after.tabs.find((tab) => tab.zenSyncId === nativeId)?.zenWorkspace, sourceWorkspaceId);
  }
  assert.match(after.tabs.find((tab) => tab.zenSyncId === unrelated.zenSyncId).entries[0].title, /drifted$/u);
});

test("lexical all-workspace preview persists one reviewable Plan reused by dry-run", async () => {
  const fixture = await makeLexicalSortFixture();
  const env = dailySortEnv(fixture);
  const beforeSession = await readFile(fixture.sessionPath);

  const preview = spawnSync(
    "node",
    ["dist/cli.js", "sort", "--all", "--engine", "lexical", "--preview", "--json"],
    { env, encoding: "utf8" }
  );
  assert.equal(preview.status, 0, `${preview.stdout}\n${preview.stderr}`);
  const previewDocument = JSON.parse(preview.stdout);

  const dryRun = spawnSync(
    "node",
    ["dist/cli.js", "sort", "--all", "--engine", "lexical", "--dry-run", "--json"],
    { env, encoding: "utf8" }
  );
  assert.equal(dryRun.status, 0, `${dryRun.stdout}\n${dryRun.stderr}`);
  const dryRunDocument = JSON.parse(dryRun.stdout);

  assert.equal(previewDocument.data.plan.source.kind, "engine");
  assert.equal(previewDocument.data.plan.source.engine, "lexical");
  assert.equal(previewDocument.data.planResolution, "created");
  assert.equal(dryRunDocument.data.planResolution, "reused_latest");
  assert.equal(dryRunDocument.data.plan.id, previewDocument.data.plan.id);
  assert.equal(dryRunDocument.data.plan.digest, previewDocument.data.plan.digest);
  assert.deepEqual(dryRunDocument.data.plan.actions, previewDocument.data.plan.actions);
  assert.equal(
    previewDocument.data.plan.actions.some((action) =>
      action.disposition === "move" && action.decision.engine === "lexical"
    ),
    true,
    JSON.stringify(previewDocument.data.plan.actions, null, 2)
  );
  assert.equal(
    previewDocument.data.plan.actions.find((action) => action.decision.trustClass === "semantic")
      .decision.thresholds.suggestion,
    0.1
  );
  assert.deepEqual(await readFile(fixture.sessionPath), beforeSession);
});

test("lexical dry-run works on first invocation and persists its exact Plan", async () => {
  const fixture = await makeLexicalSortFixture();
  const env = dailySortEnv(fixture);
  const dryRun = spawnSync(
    "node",
    ["dist/cli.js", "sort", "--engine", "lexical", "--dry-run", "--json"],
    { env, encoding: "utf8" }
  );
  assert.equal(dryRun.status, 0, `${dryRun.stdout}\n${dryRun.stderr}`);
  const document = JSON.parse(dryRun.stdout);
  assert.equal(document.data.mode, "dry-run");
  assert.equal(document.data.planResolution, "created");
  assert.equal(document.data.plan.source.engine, "lexical");
  const preview = spawnSync(
    "node",
    ["dist/cli.js", "sort", "--engine", "lexical", "--preview", "--json"],
    { env, encoding: "utf8" }
  );
  assert.equal(preview.status, 0, `${preview.stdout}\n${preview.stderr}`);
  const previewDocument = JSON.parse(preview.stdout);
  assert.equal(previewDocument.data.planResolution, "reused_latest");
  assert.equal(previewDocument.data.plan.id, document.data.plan.id);
  assert.equal(previewDocument.data.plan.digest, document.data.plan.digest);
  const stored = await execFileAsync("node", ["dist/cli.js", "plan", "show", "latest", "--json"], { env });
  assert.equal(JSON.parse(stored.stdout).data.plan.digest, document.data.plan.digest);
});

test("lexical explicit threshold and move cap gate candidates without changing Engine identity", async () => {
  const thresholdFixture = await makeLexicalSortFixture();
  const thresholdRun = spawnSync(
    "node",
    [
      "dist/cli.js", "sort", "--all", "--engine", "lexical", "--min-confidence", "0.99",
      "--preview", "--json"
    ],
    { env: dailySortEnv(thresholdFixture), encoding: "utf8" }
  );
  assert.equal(thresholdRun.status, 0, `${thresholdRun.stdout}\n${thresholdRun.stderr}`);
  const thresholdPlan = JSON.parse(thresholdRun.stdout).data.plan;
  assert.equal(thresholdPlan.source.engine, "lexical");
  assert.equal(thresholdPlan.actions.some((action) => action.disposition === "move"), false);
  assert.ok(thresholdPlan.actions.some((action) =>
    action.decision.trustClass === "semantic"
    && action.decision.thresholds.suggestion === 0.99
  ));

  const capFixture = await makeLexicalSortFixture();
  const capRun = spawnSync(
    "node",
    ["dist/cli.js", "sort", "--all", "--engine", "lexical", "--limit", "0", "--preview", "--json"],
    { env: dailySortEnv(capFixture), encoding: "utf8" }
  );
  assert.equal(capRun.status, 0, `${capRun.stdout}\n${capRun.stderr}`);
  const capPlan = JSON.parse(capRun.stdout).data.plan;
  assert.equal(capPlan.actions.some((action) => action.disposition === "move"), false);
  assert.ok(capPlan.actions.some((action) =>
    action.disposition === "review" && /Move limit 0/iu.test(action.dispositionReason.value)
  ));
});

test("lexical defaults to semantic max_moves and retains the strongest suggestions first", async () => {
  const fixture = await makeLexicalPriorityFixture();
  const env = dailySortEnv(fixture);
  const capped = spawnSync(
    "node",
    ["dist/cli.js", "sort", "--all", "--engine", "lexical", "--preview", "--json"],
    { env, encoding: "utf8" }
  );
  assert.equal(capped.status, 0, `${capped.stdout}\n${capped.stderr}`);
  const cappedPlan = JSON.parse(capped.stdout).data.plan;
  const suggestedCandidates = cappedPlan.actions.filter((action) =>
    action.decision.trustClass === "semantic"
    && action.decision.suggested
    && (action.disposition === "move" || /Move limit 1/iu.test(action.dispositionReason?.value ?? ""))
  );
  const selected = cappedPlan.actions.filter((action) => action.disposition === "move");
  assert.ok(suggestedCandidates.length >= 2);
  assert.equal(selected.length, 1);
  const strongest = [...suggestedCandidates].sort((left, right) =>
    right.decision.score - left.decision.score
    || right.decision.margin - left.decision.margin
    || actionEntityRef(left).localeCompare(actionEntityRef(right), "en-US")
  )[0];
  assert.equal(actionEntityRef(selected[0]), actionEntityRef(strongest));

  const overridden = spawnSync(
    "node",
    ["dist/cli.js", "sort", "--all", "--engine", "lexical", "--limit", "2", "--preview", "--json"],
    { env, encoding: "utf8" }
  );
  assert.equal(overridden.status, 0, `${overridden.stdout}\n${overridden.stderr}`);
  assert.equal(
    JSON.parse(overridden.stdout).data.plan.actions.filter((action) => action.disposition === "move").length,
    2
  );
});

test("an exact reviewed lexical Plan applies through the saved-Plan Receipt spine", async () => {
  const fixture = await makeLexicalSortFixture();
  const env = dailySortEnv(fixture);
  const preview = spawnSync(
    "node",
    ["dist/cli.js", "sort", "--all", "--engine", "lexical", "--preview", "--json"],
    { env, encoding: "utf8" }
  );
  assert.equal(preview.status, 0, `${preview.stdout}\n${preview.stderr}`);
  const plan = JSON.parse(preview.stdout).data.plan;
  const move = plan.actions.find((action) => action.disposition === "move");
  assert.ok(move);
  assert.equal(move.decision.trustClass, "semantic");
  assert.equal(move.decision.autoApply.status, "not_requested");

  const apply = spawnSync(
    "node",
    ["dist/cli.js", "apply", plan.id, "--yes", "--expect-digest", plan.digest, "--json"],
    { env, encoding: "utf8" }
  );
  assert.equal(apply.status, 0, `${apply.stdout}\n${apply.stderr}`);
  const document = JSON.parse(apply.stdout);
  assert.equal(document.data.plan.digest, plan.digest);
  assert.equal(document.data.receipt.outcome, "applied");
  assert.ok(document.data.receipt.operations.some((operation) => operation.actionId === move.actionId));
});

test("Receipt-bound Undo previews read-only, restores the exact logical Snapshot, and records causal history", async () => {
  const fixture = await makeDailySortFixture();
  const env = dailySortEnv(fixture);
  const initialSnapshotRun = spawnSync("node", ["dist/cli.js", "snapshot", "--json"], { env, encoding: "utf8" });
  assert.equal(initialSnapshotRun.status, 0, `${initialSnapshotRun.stdout}\n${initialSnapshotRun.stderr}`);
  const initialSnapshot = JSON.parse(initialSnapshotRun.stdout).data.snapshot;
  const forwardPlan = previewDailyPlan(env);
  const forward = spawnSync("node", [
    "dist/cli.js", "sort", "--all", "--engine", "rules",
    "--apply", "--yes", "--expect-digest", forwardPlan.digest, "--json"
  ], { env, encoding: "utf8" });
  assert.equal(forward.status, 0, `${forward.stdout}\n${forward.stderr}`);
  const forwardDocument = JSON.parse(forward.stdout);
  const forwardReceipt = forwardDocument.data.receipt;
  assert.equal(forwardReceipt.outcome, "applied");
  assert.ok(forwardReceipt.inversePlanArtifact);
  assert.ok(forwardDocument.suggestedNextCommands.includes(`zts undo ${forwardReceipt.id} --preview`));
  const changedSnapshotRun = spawnSync("node", ["dist/cli.js", "snapshot", "--json"], { env, encoding: "utf8" });
  assert.equal(changedSnapshotRun.status, 0, `${changedSnapshotRun.stdout}\n${changedSnapshotRun.stderr}`);
  assert.notEqual(JSON.parse(changedSnapshotRun.stdout).data.snapshot.revision, initialSnapshot.revision);

  const sessionBeforePreview = await readFile(fixture.sessionPath);
  const storeBeforePreview = await snapshotFileTree(fixture.stateDir);
  const preview = spawnSync("node", [
    "dist/cli.js", "undo", forwardReceipt.id, "--preview", "--json"
  ], { env, encoding: "utf8" });
  assert.equal(preview.status, 0, `${preview.stdout}\n${preview.stderr}`);
  assert.equal(preview.stderr, "");
  const previewDocument = JSON.parse(preview.stdout);
  const inspection = previewDocument.data.inspection;
  assert.equal(previewDocument.ok, true);
  assert.equal(inspection.eligible, true);
  assert.equal(inspection.sourceReceipt.id, forwardReceipt.id);
  assert.equal(inspection.inversePlan.source.kind, "inverse");
  assert.equal(inspection.inversePlan.source.sourceReceiptDigest, null);
  assert.equal(inspection.undoPlan.source.kind, "inverse");
  assert.equal(inspection.undoPlan.source.sourceReceiptId, forwardReceipt.id);
  assert.equal(inspection.undoPlan.source.sourceReceiptDigest, sha256Canonical(forwardReceipt));
  assert.equal(inspection.undoPlan.source.inverseTemplateDigest, inspection.inversePlan.digest);
  assert.equal(inspection.undoPlan.actions.length, forwardReceipt.operations.length);
  assert.deepEqual(await readFile(fixture.sessionPath), sessionBeforePreview);
  assert.deepEqual(await snapshotFileTree(fixture.stateDir), storeBeforePreview);

  const undo = spawnSync("node", [
    "dist/cli.js", "undo", forwardReceipt.id,
    "--yes", "--expect-digest", inspection.undoPlan.digest, "--json"
  ], { env, encoding: "utf8" });
  assert.equal(undo.status, 0, `${undo.stdout}\n${undo.stderr}`);
  const undoDocument = JSON.parse(undo.stdout);
  assert.equal(undoDocument.ok, true);
  assert.equal(undoDocument.data.outcome.status, "succeeded");
  assert.equal(undoDocument.data.sourceReceipt.id, forwardReceipt.id);
  assert.equal(undoDocument.data.receipt.outcome, "applied");
  const undoReceipt = undoDocument.data.receipt;

  const restoredSnapshotRun = spawnSync("node", ["dist/cli.js", "snapshot", "--json"], { env, encoding: "utf8" });
  assert.equal(restoredSnapshotRun.status, 0, `${restoredSnapshotRun.stdout}\n${restoredSnapshotRun.stderr}`);
  assert.equal(JSON.parse(restoredSnapshotRun.stdout).data.snapshot.revision, initialSnapshot.revision);

  const verify = spawnSync("node", [
    "dist/cli.js", "apply", "verify", undoReceipt.id, "--json"
  ], { env, encoding: "utf8" });
  assert.equal(verify.status, 0, `${verify.stdout}\n${verify.stderr}`);
  assert.equal(JSON.parse(verify.stdout).data.report.verification.ok, true);

  const history = spawnSync("node", ["dist/cli.js", "apply", "list", "--json"], { env, encoding: "utf8" });
  assert.equal(history.status, 0, `${history.stdout}\n${history.stderr}`);
  const undoSummary = JSON.parse(history.stdout).data.receipts[0];
  assert.equal(undoSummary.id, undoReceipt.id);
  assert.equal(undoSummary.causalSourceReceiptId, forwardReceipt.id);
  assert.equal(undoSummary.causalSourceReceiptDigest, sha256Canonical(forwardReceipt));

  const genericApply = spawnSync("node", [
    "dist/cli.js", "apply", inspection.undoPlan.digest,
    "--yes", "--expect-digest", inspection.undoPlan.digest, "--json"
  ], { env, encoding: "utf8" });
  assert.equal(genericApply.status, 1, `${genericApply.stdout}\n${genericApply.stderr}`);
  const genericApplyDocument = JSON.parse(genericApply.stdout);
  assert.equal(genericApplyDocument.data.outcome.status, "invalid");
  assert.match(genericApplyDocument.blockers.join("\n"), /cannot be applied directly|use zts undo/iu);
  assert.ok(genericApplyDocument.suggestedNextCommands[0].includes(forwardReceipt.id));

  const duplicate = spawnSync("node", [
    "dist/cli.js", "undo", forwardReceipt.id, "--preview", "--json"
  ], { env, encoding: "utf8" });
  assert.equal(duplicate.status, 2, `${duplicate.stdout}\n${duplicate.stderr}`);
  assert.match(JSON.parse(duplicate.stdout).blockers.join("\n"), /already consumed/iu);

  const undoOfUndo = spawnSync("node", ["dist/cli.js", "undo", "latest", "--preview", "--json"], {
    env, encoding: "utf8"
  });
  assert.equal(undoOfUndo.status, 2, `${undoOfUndo.stdout}\n${undoOfUndo.stderr}`);
  assert.match(JSON.parse(undoOfUndo.stdout).blockers.join("\n"), /No causally eligible applied Receipt/iu);
});

test("whole-Snapshot Drift blocks an exact reviewed Undo without changing session bytes", async () => {
  const fixture = await makeDailySortFixture();
  const env = dailySortEnv(fixture);
  const forwardPlan = previewDailyPlan(env);
  const forward = spawnSync("node", [
    "dist/cli.js", "sort", "--all", "--engine", "rules",
    "--apply", "--yes", "--expect-digest", forwardPlan.digest, "--json"
  ], { env, encoding: "utf8" });
  assert.equal(forward.status, 0, `${forward.stdout}\n${forward.stderr}`);
  const receipt = JSON.parse(forward.stdout).data.receipt;
  const preview = spawnSync("node", ["dist/cli.js", "undo", receipt.id, "--preview", "--json"], {
    env, encoding: "utf8"
  });
  assert.equal(preview.status, 0, `${preview.stdout}\n${preview.stderr}`);
  const digest = JSON.parse(preview.stdout).data.inspection.undoPlan.digest;

  const drifted = await readJsonLz4(fixture.sessionPath);
  drifted.tabs.push({
    zenSyncId: "tab-unrelated-undo-drift",
    zenWorkspace: "w-tools",
    pinned: false,
    entries: [{ url: "https://drift.example.test", title: "Unrelated normalized Drift" }]
  });
  await writeJsonLz4(fixture.sessionPath, drifted);
  const bytesBefore = await readFile(fixture.sessionPath);
  const apply = spawnSync("node", [
    "dist/cli.js", "undo", receipt.id, "--yes", "--expect-digest", digest, "--json"
  ], { env, encoding: "utf8" });
  assert.equal(apply.status, 2, `${apply.stdout}\n${apply.stderr}`);
  assert.match(JSON.parse(apply.stdout).blockers.join("\n"), /Whole-Plan Drift/iu);
  assert.deepEqual(await readFile(fixture.sessionPath), bytesBefore);
});

test("explicit Undo drift acceptance rebinds only when every inverse Operation still validates", async () => {
  const fixture = await makeDailySortFixture();
  const env = dailySortEnv(fixture);
  const forwardPlan = previewDailyPlan(env);
  const forward = spawnSync("node", [
    "dist/cli.js", "sort", "--all", "--engine", "rules",
    "--apply", "--yes", "--expect-digest", forwardPlan.digest, "--json"
  ], { env, encoding: "utf8" });
  assert.equal(forward.status, 0, `${forward.stdout}\n${forward.stderr}`);
  const receipt = JSON.parse(forward.stdout).data.receipt;

  const originalPreview = spawnSync("node", [
    "dist/cli.js", "undo", receipt.id, "--preview", "--json"
  ], { env, encoding: "utf8" });
  assert.equal(originalPreview.status, 0, `${originalPreview.stdout}\n${originalPreview.stderr}`);
  const originalPlan = JSON.parse(originalPreview.stdout).data.inspection.undoPlan;

  const drifted = await readJsonLz4(fixture.sessionPath);
  drifted.tabs.push({
    zenSyncId: "tab-unrelated-undo-rebase",
    zenWorkspace: "w-tools",
    pinned: false,
    entries: [{ url: "https://drift.example.test/rebase", title: "Unrelated retained Drift" }]
  });
  await writeJsonLz4(fixture.sessionPath, drifted);
  const bytesBeforePreview = await readFile(fixture.sessionPath);

  const preview = spawnSync("node", [
    "dist/cli.js", "undo", receipt.id, "--preview", "--accept-unrelated-drift", "--json"
  ], { env, encoding: "utf8" });
  assert.equal(preview.status, 0, `${preview.stdout}\n${preview.stderr}`);
  const previewDocument = JSON.parse(preview.stdout);
  const inspection = previewDocument.data.inspection;
  assert.equal(inspection.eligible, true);
  assert.deepEqual(inspection.drift, {
    detected: true,
    acceptUnrelatedDriftRequested: true,
    rebased: true,
    templateSnapshotRevision: originalPlan.snapshotRevision
  });
  assert.notEqual(inspection.undoPlan.digest, originalPlan.digest);
  assert.equal(inspection.undoPlan.snapshotRevision, inspection.currentSnapshotRevision);
  assert.ok(previewDocument.suggestedNextCommands[0].includes("--accept-unrelated-drift"));
  assert.deepEqual(await readFile(fixture.sessionPath), bytesBeforePreview);

  const undo = spawnSync("node", [
    "dist/cli.js", "undo", receipt.id,
    "--yes", "--expect-digest", inspection.undoPlan.digest,
    "--accept-unrelated-drift", "--json"
  ], { env, encoding: "utf8" });
  assert.equal(undo.status, 0, `${undo.stdout}\n${undo.stderr}`);
  const undoDocument = JSON.parse(undo.stdout);
  assert.equal(undoDocument.data.receipt.outcome, "applied");
  assert.equal(undoDocument.data.undoPlan.source.sourceReceiptId, receipt.id);

  const restoredRun = spawnSync("node", ["dist/cli.js", "snapshot", "--json"], {
    env, encoding: "utf8"
  });
  assert.equal(restoredRun.status, 0, `${restoredRun.stdout}\n${restoredRun.stderr}`);
  const restored = JSON.parse(restoredRun.stdout).data.snapshot;
  assert.ok(restored.entities.some((entity) => entity.nativeId === "tab-unrelated-undo-rebase"));
  for (const action of inspection.undoPlan.actions) {
    assert.equal(action.disposition, "move");
    assert.equal(
      restored.entities.find((entity) => entity.ref === action.operation.entityRef)?.workspaceId,
      action.operation.expectedPostState.workspaceId
    );
  }
});

test("Undo mutation admission rejects a digest-claimed materialized Plan whose actions do not exactly reverse its source", async () => {
  const fixture = await makeDailySortFixture();
  const env = dailySortEnv(fixture);
  const forwardPlan = previewDailyPlan(env);
  const forward = spawnSync("node", [
    "dist/cli.js", "sort", "--all", "--engine", "rules",
    "--apply", "--yes", "--expect-digest", forwardPlan.digest, "--json"
  ], { env, encoding: "utf8" });
  assert.equal(forward.status, 0, `${forward.stdout}\n${forward.stderr}`);
  const forwardReceipt = JSON.parse(forward.stdout).data.receipt;
  const preview = spawnSync("node", ["dist/cli.js", "undo", forwardReceipt.id, "--preview", "--json"], {
    env, encoding: "utf8"
  });
  assert.equal(preview.status, 0, `${preview.stdout}\n${preview.stderr}`);
  const inspection = JSON.parse(preview.stdout).data.inspection;
  const bytesBefore = await readFile(fixture.sessionPath);
  const script = [
    'import { discoverProfileContext } from "./dist/profile.js";',
    'import { createPlan } from "./dist/domain/change.js";',
    'import { sha256Canonical } from "./dist/domain/digest.js";',
    'import { publishDetachedPlanObject } from "./dist/plans.js";',
    'import { applyStoredPlanClosedSession } from "./dist/apply-transaction.js";',
    `const snapshot = ${JSON.stringify(inspection.currentSnapshot)};`,
    `const reviewed = ${JSON.stringify(inspection.undoPlan)};`,
    `const receipt = ${JSON.stringify(forwardReceipt)};`,
    'const original = reviewed.actions[0];',
    'const destination = snapshot.workspaces.find((workspace) => workspace.id === "w-stash");',
    'if (!original || original.disposition !== "move" || !destination) throw new Error("fixture cannot tamper Undo Plan");',
    'const rawProtection = destination.protection.destination;',
    'const protection = rawProtection.protected',
    '  ? { ...rawProtection, protectionRevision: sha256Canonical(rawProtection), requiredGrantId: `grant:${original.actionId}:destination` }',
    '  : { ...rawProtection, requiredGrantId: null };',
    'const tamperedAction = { ...original, operation: { ...original.operation,',
    '  precondition: { ...original.operation.precondition, destinationWorkspace: { workspaceId: destination.id, protection } },',
    '  expectedPostState: { workspaceId: destination.id }',
    '} };',
    'const tampered = createPlan(snapshot, {',
    '  schemaVersion: reviewed.schemaVersion, id: reviewed.id, configRevision: reviewed.configRevision,',
    '  engineManifestRevision: reviewed.engineManifestRevision, createdAt: reviewed.createdAt, expiresAt: reviewed.expiresAt,',
    '  derivation: reviewed.derivation, source: reviewed.source, actions: [tamperedAction, ...reviewed.actions.slice(1)]',
    '});',
    'const stored = await publishDetachedPlanObject(snapshot, tampered, sha256Canonical({ fixture: "tampered-undo" }), new Date());',
    'const context = await discoverProfileContext();',
    'await applyStoredPlanClosedSession(context, stored, {',
    '  expectedDigest: tampered.digest, command: "fixture tampered Undo",',
    '  executionIntent: { kind: "undo", sourceReceiptId: receipt.id, sourceReceiptDigest: sha256Canonical(receipt) }',
    '});'
  ].join("\n");
  const rejected = spawnSync("node", ["--input-type=module", "--eval", script], {
    cwd: process.cwd(), env, encoding: "utf8"
  });
  assert.notEqual(rejected.status, 0, `${rejected.stdout}\n${rejected.stderr}`);
  assert.match(rejected.stderr, /exact inverse|materialized Undo Plan|reverse.*source/iu);
  assert.deepEqual(await readFile(fixture.sessionPath), bytesBefore);
});

test("successful tail Undo exposes the previous active forward Receipt to undo latest", async () => {
  const fixture = await makeDailySortFixture();
  const env = dailySortEnv(fixture);
  const initialSnapshot = JSON.parse(spawnSync(
    "node", ["dist/cli.js", "snapshot", "--json"], { env, encoding: "utf8" }
  ).stdout).data.snapshot;
  const firstPlan = previewDailyPlan(env);
  const firstApply = spawnSync("node", [
    "dist/cli.js", "sort", "--all", "--engine", "rules",
    "--apply", "--yes", "--expect-digest", firstPlan.digest, "--json"
  ], { env, encoding: "utf8" });
  assert.equal(firstApply.status, 0, `${firstApply.stdout}\n${firstApply.stderr}`);
  const firstReceipt = JSON.parse(firstApply.stdout).data.receipt;
  const secondReceipt = await planAndApplyManualMove(
    fixture,
    env,
    "tab-space-stash-rule",
    "w-tools"
  );

  const secondPreview = spawnSync("node", ["dist/cli.js", "undo", "latest", "--preview", "--json"], {
    env, encoding: "utf8"
  });
  assert.equal(secondPreview.status, 0, `${secondPreview.stdout}\n${secondPreview.stderr}`);
  const secondInspection = JSON.parse(secondPreview.stdout).data.inspection;
  assert.equal(secondInspection.sourceReceipt.id, secondReceipt.id);
  const secondUndo = spawnSync("node", [
    "dist/cli.js", "undo", "latest", "--yes", "--expect-digest", secondInspection.undoPlan.digest, "--json"
  ], { env, encoding: "utf8" });
  assert.equal(secondUndo.status, 0, `${secondUndo.stdout}\n${secondUndo.stderr}`);

  const firstPreview = spawnSync("node", ["dist/cli.js", "undo", "latest", "--preview", "--json"], {
    env, encoding: "utf8"
  });
  assert.equal(firstPreview.status, 0, `${firstPreview.stdout}\n${firstPreview.stderr}`);
  const firstInspection = JSON.parse(firstPreview.stdout).data.inspection;
  assert.equal(firstInspection.sourceReceipt.id, firstReceipt.id);
  const firstUndo = spawnSync("node", [
    "dist/cli.js", "undo", "latest", "--yes", "--expect-digest", firstInspection.undoPlan.digest, "--json"
  ], { env, encoding: "utf8" });
  assert.equal(firstUndo.status, 0, `${firstUndo.stdout}\n${firstUndo.stderr}`);

  const restored = JSON.parse(spawnSync(
    "node", ["dist/cli.js", "snapshot", "--json"], { env, encoding: "utf8" }
  ).stdout).data.snapshot;
  assert.equal(restored.revision, initialSnapshot.revision);
});

test("Undo rejects malformed selectors and backends as invocation errors", async () => {
  const fixture = await makeDailySortFixture();
  const env = dailySortEnv(fixture);
  for (const args of [
    ["dist/cli.js", "undo", "not-a-receipt", "--preview", "--json"],
    ["dist/cli.js", "undo", "latest", "--preview", "--backend", "remote", "--json"]
  ]) {
    const rejected = spawnSync("node", args, { env, encoding: "utf8" });
    assert.equal(rejected.status, 1, `${rejected.stdout}\n${rejected.stderr}`);
    assert.equal(rejected.stderr, "");
    assert.equal(JSON.parse(rejected.stdout).data.outcome.status, "invalid");
  }
});

test("hard-crashed Undo recovers its detached Plan and publishes one causal applied Receipt", async () => {
  const fixture = await makeDailySortFixture();
  const env = dailySortEnv(fixture);
  const initialSnapshot = JSON.parse(spawnSync(
    "node", ["dist/cli.js", "snapshot", "--json"], { env, encoding: "utf8" }
  ).stdout).data.snapshot;
  const forwardPlan = previewDailyPlan(env);
  const forward = spawnSync("node", [
    "dist/cli.js", "sort", "--all", "--engine", "rules",
    "--apply", "--yes", "--expect-digest", forwardPlan.digest, "--json"
  ], { env, encoding: "utf8" });
  assert.equal(forward.status, 0, `${forward.stdout}\n${forward.stderr}`);
  const forwardReceipt = JSON.parse(forward.stdout).data.receipt;
  const preview = spawnSync("node", ["dist/cli.js", "undo", forwardReceipt.id, "--preview", "--json"], {
    env, encoding: "utf8"
  });
  assert.equal(preview.status, 0, `${preview.stdout}\n${preview.stderr}`);
  const undoPlan = JSON.parse(preview.stdout).data.inspection.undoPlan;
  const script = [
    'import { discoverProfileContext } from "./dist/profile.js";',
    'import { loadConfig } from "./dist/config.js";',
    'import { createPlan } from "./dist/domain/change.js";',
    'import { sha256Canonical } from "./dist/domain/digest.js";',
    'import { applyStoredPlanClosedSession } from "./dist/apply-transaction.js";',
    'import { DEFAULT_PLAN_STORE_POLICY, publishDetachedPlanObject, resolveOrCreatePlan } from "./dist/plans.js";',
    'import { inspectUndo } from "./dist/undo.js";',
    'const context = await discoverProfileContext();',
    'const config = (await loadConfig()).config;',
    `const inspection = await inspectUndo(context, config, ${JSON.stringify(forwardReceipt.id)}, new Date());`,
    'if (!inspection.eligible || !inspection.undoPlan) throw new Error("fixture Undo unexpectedly ineligible");',
    `if (inspection.undoPlan.digest !== ${JSON.stringify(undoPlan.digest)}) throw new Error("fixture Undo digest changed");`,
    'const undoRequestRevision = sha256Canonical({',
    '  kind: "undo", sourceReceiptId: inspection.sourceReceipt.id, inversePlanDigest: inspection.undoPlan.digest',
    '});',
    'const detached = await publishDetachedPlanObject(',
    '  inspection.currentSnapshot, inspection.undoPlan, undoRequestRevision, new Date()',
    ');',
    'const maintenanceAt = new Date(Date.now() + (2 * 24 * 60 * 60 * 1000));',
    'const maintenanceRequest = sha256Canonical({ kind: "detached-admission-gap-gc" });',
    'await applyStoredPlanClosedSession(context, detached, {',
    '  expectedDigest: inspection.undoPlan.digest,',
    '  command: "fixture hard-crash Undo with concurrent Plan GC",',
    '  executionIntent: {',
    '    kind: "undo",',
    '    sourceReceiptId: inspection.sourceReceipt.id,',
    '    sourceReceiptDigest: sha256Canonical(inspection.sourceReceipt)',
    '  },',
    '  afterSafetyCheck: async () => {',
    '    await resolveOrCreatePlan(inspection.currentSnapshot, maintenanceRequest, () => createPlan(',
    '      inspection.currentSnapshot, {',
    '        schemaVersion: "zts.plan.provisional-1",',
    '        id: "plan:detached-admission-gap-gc",',
    '        configRevision: inspection.undoPlan.configRevision,',
    '        engineManifestRevision: inspection.undoPlan.engineManifestRevision,',
    '        createdAt: maintenanceAt.toISOString(),',
    '        expiresAt: new Date(maintenanceAt.getTime() + (5 * 60 * 1000)).toISOString(),',
    '        derivation: { kind: "original" },',
    '        source: { kind: "engine", engine: "rules", intentRevision: maintenanceRequest },',
    '        actions: []',
    '      }',
    '    ), maintenanceAt, "create_or_reuse", {',
    '      ...DEFAULT_PLAN_STORE_POLICY, unreferencedRetentionMs: 0',
    '    });',
    '  },',
    '  afterAtomicSwap: () => process.exit(66)',
    '});'
  ].join("\n");
  const crashed = spawnSync("node", ["--input-type=module", "--eval", script], {
    cwd: process.cwd(), env, encoding: "utf8"
  });
  assert.equal(crashed.status, 66, `${crashed.stdout}\n${crashed.stderr}`);

  const list = spawnSync("node", ["dist/cli.js", "apply", "recover", "--json"], { env, encoding: "utf8" });
  assert.equal(list.status, 0, `${list.stdout}\n${list.stderr}`);
  const candidate = JSON.parse(list.stdout).data.recoveries[0];
  assert.equal(candidate.planId, undoPlan.id);
  const recovered = executeRecovery(env, candidate);
  assert.equal(recovered.status, 0, `${recovered.stdout}\n${recovered.stderr}`);
  const recoveredData = JSON.parse(recovered.stdout).data;
  assert.equal(recoveredData.receipt.outcome, "applied");
  assert.equal(recoveredData.receipt.planDigest, undoPlan.digest);
  assert.equal(recoveredData.receipt.operations.every((operation) => operation.status === "verified"), true);

  const restored = spawnSync("node", ["dist/cli.js", "snapshot", "--json"], { env, encoding: "utf8" });
  assert.equal(restored.status, 0, `${restored.stdout}\n${restored.stderr}`);
  assert.equal(JSON.parse(restored.stdout).data.snapshot.revision, initialSnapshot.revision);
  const verify = spawnSync("node", [
    "dist/cli.js", "apply", "verify", recoveredData.receipt.id, "--json"
  ], { env, encoding: "utf8" });
  assert.equal(verify.status, 0, `${verify.stdout}\n${verify.stderr}`);

  const history = spawnSync("node", ["dist/cli.js", "apply", "list", "--json"], { env, encoding: "utf8" });
  assert.equal(history.status, 0, `${history.stdout}\n${history.stderr}`);
  const summary = JSON.parse(history.stdout).data.receipts[0];
  assert.equal(summary.id, recoveredData.receipt.id);
  assert.equal(summary.causalSourceReceiptId, forwardReceipt.id);
  assert.equal(summary.causalSourceReceiptDigest, sha256Canonical(forwardReceipt));

  const duplicate = spawnSync("node", ["dist/cli.js", "undo", forwardReceipt.id, "--preview", "--json"], {
    env, encoding: "utf8"
  });
  assert.equal(duplicate.status, 2, `${duplicate.stdout}\n${duplicate.stderr}`);
  assert.match(JSON.parse(duplicate.stdout).blockers.join("\n"), /consumed|superseded/iu);
});

test("recovery rejects Undo consent whose source Receipt digest differs from its inverse Plan", async () => {
  const fixture = await makeDailySortFixture();
  const env = dailySortEnv(fixture);
  const forwardPlan = previewDailyPlan(env);
  const forward = spawnSync("node", [
    "dist/cli.js", "sort", "--all", "--engine", "rules",
    "--apply", "--yes", "--expect-digest", forwardPlan.digest, "--json"
  ], { env, encoding: "utf8" });
  assert.equal(forward.status, 0, `${forward.stdout}\n${forward.stderr}`);
  const forwardReceipt = JSON.parse(forward.stdout).data.receipt;
  const preview = spawnSync("node", ["dist/cli.js", "undo", forwardReceipt.id, "--preview", "--json"], {
    env, encoding: "utf8"
  });
  assert.equal(preview.status, 0, `${preview.stdout}\n${preview.stderr}`);
  const undoPlan = JSON.parse(preview.stdout).data.inspection.undoPlan;
  const script = [
    'import { discoverProfileContext } from "./dist/profile.js";',
    'import { loadConfig } from "./dist/config.js";',
    'import { applyUndo } from "./dist/undo.js";',
    'const context = await discoverProfileContext();',
    'const config = (await loadConfig()).config;',
    `await applyUndo(context, config, ${JSON.stringify(forwardReceipt.id)}, ${JSON.stringify(undoPlan.digest)}, "fixture consent-binding crash", undefined, new Date(), {`,
    '  afterUnfinishedMarker: () => process.exit(67)',
    '});'
  ].join("\n");
  const crashed = spawnSync("node", ["--input-type=module", "--eval", script], {
    cwd: process.cwd(), env, encoding: "utf8"
  });
  assert.equal(crashed.status, 67, `${crashed.stdout}\n${crashed.stderr}`);

  const markerPath = await onlyUnfinishedMarkerPath(fixture.stateDir);
  const marker = JSON.parse(await readFile(markerPath, "utf8"));
  assert.equal(marker.bootstrap.consent.purpose.kind, "undo");
  marker.bootstrap.consent.purpose.sourceReceiptDigest = `sha256:${"f".repeat(64)}`;
  rebindMarkerConsentAndAuthorization(marker);
  await writeFile(markerPath, `${JSON.stringify(marker)}\n`);

  const recovery = spawnSync("node", ["dist/cli.js", "apply", "recover", "--json"], {
    env, encoding: "utf8"
  });
  assert.notEqual(recovery.status, 0, `${recovery.stdout}\n${recovery.stderr}`);
  assert.match(
    JSON.parse(recovery.stdout).blockers.join("\n"),
    /Undo invocation consent source Receipt does not match its bound inverse Plan/iu
  );
});

test("review reads one exact saved Plan without recapture or regeneration", async () => {
  const fixture = await makeDailySortFixture();
  const env = dailySortEnv(fixture);
  const plan = previewDailyPlan(env);
  const beforeStore = await snapshotFileTree(fixture.stateDir);
  const changed = await readJsonLz4(fixture.sessionPath);
  changed.tabs.push({
    zenSyncId: "tab-after-review-plan",
    zenWorkspace: "w-space",
    pinned: false,
    entries: [{ url: "https://changed.example.test", title: "Changed after Plan" }]
  });
  await writeJsonLz4(fixture.sessionPath, changed);

  const review = spawnSync("node", ["dist/cli.js", "review", plan.id, "--json"], { env, encoding: "utf8" });
  assert.equal(review.status, 0, `${review.stdout}\n${review.stderr}`);
  const data = JSON.parse(review.stdout).data;
  assert.equal(data.plan.id, plan.id);
  assert.equal(data.plan.digest, plan.digest);
  assert.equal(data.snapshot.revision, plan.snapshotRevision);
  assert.equal(data.snapshot.entities.some((entity) => entity.nativeId === "tab-after-review-plan"), false);
  assert.deepEqual(await snapshotFileTree(fixture.stateDir), beforeStore);
});

test("Plan reuse ignores opaque session rewrites while retaining logical whole-Plan Drift", async () => {
  const fixture = await makeDailySortFixture();
  const env = dailySortEnv(fixture);
  const plan = previewDailyPlan(env);
  const rewritten = await readJsonLz4(fixture.sessionPath);
  rewritten.unrelatedFutureZenState = { savedBy: "normal-reopen", sequence: 2 };
  await writeJsonLz4(fixture.sessionPath, rewritten);

  const dryRun = spawnSync("node", [
    "dist/cli.js", "sort", "--all", "--engine", "rules", "--dry-run", "--json"
  ], { env, encoding: "utf8" });
  assert.equal(dryRun.status, 0, `${dryRun.stdout}\n${dryRun.stderr}`);
  const data = JSON.parse(dryRun.stdout).data;
  assert.equal(data.planResolution, "reused_latest");
  assert.equal(data.plan.id, plan.id);
  assert.equal(data.plan.digest, plan.digest);
  assert.equal(data.plan.snapshotRevision, plan.snapshotRevision);
});

test("zero-move sort apply returns a typed successful no-changes outcome", async () => {
  const fixture = await makeDailySortFixture();
  const env = dailySortEnv(fixture);
  const args = [
    "Space",
    "--engine", "rules",
    "--except", "framer.com,example.org,github.com",
    "--include-pinned",
    "--include-essentials"
  ];
  const preview = spawnSync("node", ["dist/cli.js", "sort", ...args, "--preview", "--json"], {
    env, encoding: "utf8"
  });
  assert.equal(preview.status, 0, `${preview.stdout}\n${preview.stderr}`);
  const plan = JSON.parse(preview.stdout).data.plan;
  assert.equal(JSON.parse(preview.stdout).data.summary.moveCount, 0);
  const wrongDigest = spawnSync("node", [
    "dist/cli.js", "sort", ...args,
    "--apply", "--yes",
    "--expect-digest", "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
    "--json"
  ], { env, encoding: "utf8" });
  assert.equal(wrongDigest.status, 1, `${wrongDigest.stdout}\n${wrongDigest.stderr}`);
  assert.match(JSON.parse(wrongDigest.stdout).blockers.join("\n"), /does not match reviewed Sort Plan/iu);

  const applied = spawnSync("node", [
    "dist/cli.js", "sort", ...args,
    "--apply", "--yes", "--expect-digest", plan.digest, "--json"
  ], { env, encoding: "utf8" });
  assert.equal(applied.status, 0, `${applied.stdout}\n${applied.stderr}`);
  const data = JSON.parse(applied.stdout).data;
  assert.equal(data.applied, false);
  assert.equal(data.applyOutcome, "no_changes");
  assert.equal(data.mutationAttempted, false);
  assert.equal(data.authorization, null);
  assert.equal(data.receipt, null);
  assert.equal(data.receiptPath, null);
  assert.equal(JSON.parse(applied.stdout).ok, true);
  const human = spawnSync("node", [
    "dist/cli.js", "sort", ...args,
    "--apply", "--yes", "--expect-digest", plan.digest
  ], { env, encoding: "utf8" });
  assert.equal(human.status, 0, `${human.stdout}\n${human.stderr}`);
  assert.match(human.stdout, /Sort apply · no changes/);
  assert.doesNotMatch(human.stdout, /Apply blocked|was blocked/iu);
  const history = spawnSync("node", ["dist/cli.js", "apply", "list", "--json"], { env, encoding: "utf8" });
  assert.equal(history.status, 0, `${history.stdout}\n${history.stderr}`);
  assert.deepEqual(JSON.parse(history.stdout).data.receipts, []);
});

test("attention-only sort apply returns a typed safe blocker without an Apply Transaction", async () => {
  const fixture = await makeDailySortFixture();
  const env = dailySortEnv(fixture);
  const args = ["--all", "--engine", "rules", "--only", "no-match.invalid"];
  const preview = spawnSync("node", ["dist/cli.js", "sort", ...args, "--preview", "--json"], {
    env, encoding: "utf8"
  });
  assert.equal(preview.status, 0, `${preview.stdout}\n${preview.stderr}`);
  const previewDocument = JSON.parse(preview.stdout);
  const plan = previewDocument.data.plan;
  assert.equal(previewDocument.data.summary.moveCount, 0);
  assert.ok(
    previewDocument.data.summary.reviewCount
      + previewDocument.data.summary.protectedCount
      + previewDocument.data.summary.blockedCount > 0
  );

  const applied = spawnSync("node", [
    "dist/cli.js", "sort", ...args,
    "--apply", "--yes", "--expect-digest", plan.digest, "--json"
  ], { env, encoding: "utf8" });
  assert.equal(applied.status, 2, `${applied.stdout}\n${applied.stderr}`);
  assert.equal(applied.stderr, "");
  const document = JSON.parse(applied.stdout);
  assert.equal(document.ok, false);
  assert.equal(document.data.applyOutcome, "attention_required");
  assert.ok(document.data.attentionActionIds.length > 0);
  assert.equal(document.data.receipt, null);
  assert.match(document.blockers.join("\n"), /requiring attention/iu);

  const history = spawnSync("node", ["dist/cli.js", "apply", "list", "--json"], { env, encoding: "utf8" });
  assert.equal(history.status, 0, `${history.stdout}\n${history.stderr}`);
  assert.deepEqual(JSON.parse(history.stdout).data.receipts, []);
});

test("zero-move sort apply refuses a persisted-observation Plan while Zen runs", async () => {
  const fixture = await makeDailySortFixture();
  const env = dailySortEnv(fixture);
  await writeFile(
    join(fixture.binDir, "ps"),
    `#!/bin/sh\nprintf '%s\\n' '123 /Applications/Zen.app/Contents/MacOS/zen --profile ${fixture.profilePath}'\n`
  );
  const args = [
    "Space",
    "--engine", "rules",
    "--except", "framer.com,example.org,github.com",
    "--include-pinned",
    "--include-essentials"
  ];
  const preview = spawnSync("node", ["dist/cli.js", "sort", ...args, "--preview", "--json"], {
    env, encoding: "utf8"
  });
  assert.equal(preview.status, 0, `${preview.stdout}\n${preview.stderr}`);
  const plan = JSON.parse(preview.stdout).data.plan;
  assert.equal(plan.snapshotAuthority, "persisted_observation");

  const apply = spawnSync("node", [
    "dist/cli.js", "sort", ...args,
    "--apply", "--yes", "--expect-digest", plan.digest, "--json"
  ], { env, encoding: "utf8" });
  assert.equal(apply.status, 2, `${apply.stdout}\n${apply.stderr}`);
  assert.match(JSON.parse(apply.stdout).blockers.join("\n"), /authoritative Snapshot.*Zen owns/iu);
  await assert.rejects(stat(join(fixture.stateDir, "apply-transactions")), { code: "ENOENT" });
});

test("filtered follow-ups and Receipt provenance preserve every sort intent flag", async () => {
  const fixture = await makeDailySortFixture();
  const env = dailySortEnv(fixture);
  const intentArgs = [
    "--all",
    "--engine", "rules",
    "--backend", "session",
    "--to", "Portfolio Work,Tool Development",
    "--not-to", "Stash",
    "--only", "github.com,framer.com",
    "--except", "https://github.com/1Pio/private",
    "--limit", "1",
    "--no-include-pinned",
    "--include-essentials"
  ];
  const expectedIntent = [
    "zts sort --all --engine rules --backend session",
    "--to 'Portfolio Work,Tool Development' --not-to Stash",
    "--only 'github.com,framer.com' --except https://github.com/1Pio/private",
    "--limit 1 --no-include-pinned --include-essentials"
  ].join(" ");

  const preview = spawnSync(
    "node", ["dist/cli.js", "sort", ...intentArgs, "--preview", "--json"], { env, encoding: "utf8" }
  );
  assert.equal(preview.status, 0, `${preview.stdout}\n${preview.stderr}`);
  const previewJson = JSON.parse(preview.stdout);
  assert.ok(previewJson.suggestedNextCommands.includes(`${expectedIntent} --dry-run`));

  const dryRun = spawnSync(
    "node", ["dist/cli.js", "sort", ...intentArgs, "--dry-run", "--json"], { env, encoding: "utf8" }
  );
  assert.equal(dryRun.status, 0, `${dryRun.stdout}\n${dryRun.stderr}`);
  const dryRunJson = JSON.parse(dryRun.stdout);
  assert.equal(dryRunJson.data.requestRevision, previewJson.data.requestRevision);
  assert.equal(dryRunJson.data.plan.digest, previewJson.data.plan.digest);
  assert.equal(dryRunJson.data.planResolution, "reused_latest");

  const receiptCommand = `${expectedIntent} --apply --yes --expect-digest ${previewJson.data.plan.digest}`;
  const apply = spawnSync("node", [
    "dist/cli.js", "sort", ...intentArgs,
    "--apply", "--yes", "--expect-digest", previewJson.data.plan.digest, "--json"
  ], { env, encoding: "utf8" });
  assert.equal(apply.status, 0, `${apply.stdout}\n${apply.stderr}`);
  const applyJson = JSON.parse(apply.stdout);
  const consent = applyJson.data.artifacts.find((artifact) => artifact.kind === "consent");
  assert.ok(consent);
  const tree = await snapshotFileTree(fixture.stateDir);
  const consentKey = Object.keys(tree).find((path) => path.endsWith(
    `/consents/${consent.digest.slice("sha256:".length)}.json`
  ));
  assert.ok(consentKey);
  const consentValue = JSON.parse(await readFile(join(fixture.stateDir, consentKey), "utf8"));
  assert.equal(consentValue.commandRevision, sha256Canonical({ command: receiptCommand }));
});

test("Plan retention expires unreferenced previews but preserves Apply-referenced truth", async () => {
  const fixture = await makeDailySortFixture();
  const env = dailySortEnv(fixture);
  const initialPlan = previewDailyPlan(env);
  const applied = spawnSync("node", [
    "dist/cli.js", "apply", initialPlan.id, "--yes", "--expect-digest", initialPlan.digest, "--json"
  ], { env, encoding: "utf8" });
  assert.equal(applied.status, 0, `${applied.stdout}\n${applied.stderr}`);
  const receiptId = JSON.parse(applied.stdout).data.receipt.id;
  const previous = new Map();
  for (const key of ["HOME", "PATH", "ZTS_ZEN_APP_SUPPORT_DIR", "ZTS_STATE_DIR", "ZTS_CONFIG_PATH"]) {
    previous.set(key, process.env[key]);
    process.env[key] = env[key];
  }
  try {
    const { createPlan } = await import("../dist/domain/change.js");
    const {
      DEFAULT_PLAN_STORE_POLICY,
      loadStoredPlan,
      resolveOrCreatePlan
    } = await import("../dist/plans.js");
    const stored = await loadStoredPlan(initialPlan.profileId, initialPlan.digest);
    const baseTime = Date.parse(stored.plan.createdAt) + (2 * 24 * 60 * 60 * 1000);
    for (let index = 0; index < 5; index += 1) {
      // Every prior unreferenced Plan must be past its immutable executable
      // lifetime before a later publication may collect it for capacity.
      const now = new Date(baseTime + (index * 10 * 60 * 1_000));
      const requestRevision = sha256Canonical({ kind: "retention-fixture", index });
      await resolveOrCreatePlan(
        stored.snapshot,
        requestRevision,
        () => createPlan(stored.snapshot, {
          schemaVersion: "zts.plan.provisional-1",
          id: `plan:retention-fixture:${index}`,
          configRevision: stored.plan.configRevision,
          engineManifestRevision: stored.plan.engineManifestRevision,
          createdAt: now.toISOString(),
          expiresAt: new Date(now.getTime() + 5 * 60 * 1000).toISOString(),
          derivation: { kind: "original" },
          source: { kind: "engine", engine: "rules", intentRevision: requestRevision },
          actions: stored.plan.actions
        }),
        now,
        "create_or_reuse",
        {
          ...DEFAULT_PLAN_STORE_POLICY,
          maxObjects: 2,
          unreferencedRetentionMs: 0
        }
      );
    }
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
  const [profileStore] = await readdir(join(fixture.stateDir, "plans"));
  const objectRoot = join(fixture.stateDir, "plans", profileStore, "objects");
  const objects = (await readdir(objectRoot)).filter((entry) => entry.endsWith(".json"));
  assert.equal(objects.length, 2);
  assert.equal(objects.includes(`${initialPlan.digest.slice("sha256:".length)}.json`), true);
  const verify = spawnSync("node", ["dist/cli.js", "apply", "verify", receiptId, "--json"], { env, encoding: "utf8" });
  assert.equal(verify.status, 0, `${verify.stdout}\n${verify.stderr}`);
});

test("Plan-store control reconciles proof-bound and owner-bound residue but rejects unsafe temps", async () => {
  const fixture = await makeDailySortFixture();
  const env = dailySortEnv(fixture);
  const initialPlan = previewDailyPlan(env);
  const [profileStore] = await readdir(join(fixture.stateDir, "plans"));
  const planRoot = join(fixture.stateDir, "plans", profileStore);
  const objectRoot = join(planRoot, "objects");
  const objectPath = join(objectRoot, `${initialPlan.digest.slice("sha256:".length)}.json`);
  const residue = join(objectRoot, `.tmp-${randomUUID()}.artifact`);
  await link(objectPath, residue);
  assert.equal((await stat(objectPath)).nlink, 2);

  const reconciled = spawnSync(
    "node",
    ["dist/cli.js", "sort", "--all", "--engine", "rules", "--limit", "1", "--preview", "--json"],
    { env, encoding: "utf8" }
  );
  assert.equal(reconciled.status, 0, `${reconciled.stdout}\n${reconciled.stderr}`);
  await assert.rejects(() => lstat(residue), /ENOENT/);
  assert.equal((await stat(objectPath)).nlink, 1);

  const standalone = join(planRoot, "requests", `.tmp-${randomUUID()}.artifact`);
  await writeFile(standalone, "interrupted pointer publication", { mode: 0o600 });
  const converged = spawnSync(
    "node",
    ["dist/cli.js", "sort", "--all", "--engine", "rules", "--limit", "2", "--preview", "--json"],
    { env, encoding: "utf8" }
  );
  assert.equal(converged.status, 0, `${converged.stdout}\n${converged.stderr}`);
  await assert.rejects(() => lstat(standalone), /ENOENT/);

  const unsafe = join(planRoot, "requests", `.tmp-${randomUUID()}.artifact`);
  await writeFile(unsafe, "unsafe pointer residue", { mode: 0o600 });
  await chmod(unsafe, 0o644);
  const blocked = spawnSync(
    "node",
    ["dist/cli.js", "sort", "--all", "--engine", "rules", "--limit", "3", "--preview", "--json"],
    { env, encoding: "utf8" }
  );
  assert.equal(blocked.status, 4, `${blocked.stdout}\n${blocked.stderr}`);
  assert.equal(JSON.parse(blocked.stdout).data.outcome.status, "internal_error");
  assert.match(`${blocked.stdout}\n${blocked.stderr}`, /Private artifact permissions are not owner-only/);
  assert.equal(await readFile(unsafe, "utf8"), "unsafe pointer residue");
});

test("Plan-store inventory rejects unexpected root entries and dangling pointers", async () => {
  const rootFixture = await makeDailySortFixture();
  const rootEnv = dailySortEnv(rootFixture);
  previewDailyPlan(rootEnv);
  const [rootProfileStore] = await readdir(join(rootFixture.stateDir, "plans"));
  const planRoot = join(rootFixture.stateDir, "plans", rootProfileStore);
  const unexpected = join(planRoot, "foreign.bin");
  await writeFile(unexpected, "foreign", { mode: 0o600 });
  const rootBlocked = spawnSync(
    "node",
    ["dist/cli.js", "sort", "--all", "--engine", "rules", "--limit", "1", "--preview", "--json"],
    { env: rootEnv, encoding: "utf8" }
  );
  assert.equal(rootBlocked.status, 4, `${rootBlocked.stdout}\n${rootBlocked.stderr}`);
  assert.equal(JSON.parse(rootBlocked.stdout).data.outcome.status, "internal_error");
  assert.match(`${rootBlocked.stdout}\n${rootBlocked.stderr}`, /Plan store root contains an unexpected entry/);
  assert.equal(await readFile(unexpected, "utf8"), "foreign");

  const pointerFixture = await makeDailySortFixture();
  const pointerEnv = dailySortEnv(pointerFixture);
  const plan = previewDailyPlan(pointerEnv);
  const [pointerProfileStore] = await readdir(join(pointerFixture.stateDir, "plans"));
  const pointerRoot = join(pointerFixture.stateDir, "plans", pointerProfileStore);
  await rm(join(pointerRoot, "objects", `${plan.digest.slice("sha256:".length)}.json`));
  const pointerBlocked = spawnSync(
    "node",
    ["dist/cli.js", "sort", "--all", "--engine", "rules", "--limit", "1", "--preview", "--json"],
    { env: pointerEnv, encoding: "utf8" }
  );
  assert.equal(pointerBlocked.status, 4, `${pointerBlocked.stdout}\n${pointerBlocked.stderr}`);
  assert.equal(JSON.parse(pointerBlocked.stdout).data.outcome.status, "internal_error");
  assert.match(`${pointerBlocked.stdout}\n${pointerBlocked.stderr}`, /Plan pointer references a missing object/);
});

test("Plan retention fails closed when Apply reference indexing is absent", async () => {
  const fixture = await makeDailySortFixture();
  const env = dailySortEnv(fixture);
  const initialPlan = previewDailyPlan(env);
  const applied = spawnSync("node", [
    "dist/cli.js", "apply", initialPlan.id, "--yes", "--expect-digest", initialPlan.digest, "--json"
  ], { env, encoding: "utf8" });
  assert.equal(applied.status, 0, `${applied.stdout}\n${applied.stderr}`);
  const applyRoot = join(fixture.stateDir, "apply-transactions");
  const [applyProfileStore] = await readdir(applyRoot);
  await rm(join(applyRoot, applyProfileStore, "unfinished", "index.json"));

  const previous = new Map();
  for (const key of ["HOME", "PATH", "ZTS_ZEN_APP_SUPPORT_DIR", "ZTS_STATE_DIR", "ZTS_CONFIG_PATH"]) {
    previous.set(key, process.env[key]);
    process.env[key] = env[key];
  }
  try {
    const { createPlan } = await import("../dist/domain/change.js");
    const { DEFAULT_PLAN_STORE_POLICY, loadStoredPlan, resolveOrCreatePlan } = await import("../dist/plans.js");
    const stored = await loadStoredPlan(initialPlan.profileId, initialPlan.digest);
    const now = new Date(Date.parse(stored.plan.createdAt) + (2 * 24 * 60 * 60 * 1000));
    const requestRevision = sha256Canonical({ kind: "missing-apply-index" });
    await assert.rejects(
      () => resolveOrCreatePlan(
        stored.snapshot,
        requestRevision,
        () => createPlan(stored.snapshot, {
          schemaVersion: "zts.plan.provisional-1",
          id: "plan:missing-apply-index",
          configRevision: stored.plan.configRevision,
          engineManifestRevision: stored.plan.engineManifestRevision,
          createdAt: now.toISOString(),
          expiresAt: new Date(now.getTime() + 5 * 60 * 1000).toISOString(),
          derivation: { kind: "original" },
          source: { kind: "engine", engine: "rules", intentRevision: requestRevision },
          actions: stored.plan.actions
        }),
        now,
        "create_or_reuse",
        { ...DEFAULT_PLAN_STORE_POLICY, maxObjects: 1, unreferencedRetentionMs: 0 }
      ),
      /Apply unfinished index is absent/
    );
    await loadStoredPlan(initialPlan.profileId, initialPlan.digest);
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("valid large Snapshots publish their inverse before mutation above the old 16 MiB ceiling", async () => {
  const fixture = await makeDailySortFixture();
  const env = dailySortEnv(fixture);
  const session = await readJsonLz4(fixture.sessionPath);
  session.tabs[0].entries[0].title = "L".repeat(9 * 1024 * 1024);
  await writeJsonLz4(fixture.sessionPath, session);
  const preview = spawnSync(
    "node", ["dist/cli.js", "sort", "--all", "--engine", "rules", "--preview", "--json"],
    { env, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }
  );
  assert.equal(preview.status, 0, `${preview.stdout.slice(0, 2_000)}\n${preview.stderr}`);
  const plan = JSON.parse(preview.stdout).data.plan;
  const [profileStore] = await readdir(join(fixture.stateDir, "plans"));
  const objectPath = join(
    fixture.stateDir,
    "plans",
    profileStore,
    "objects",
    `${plan.digest.slice("sha256:".length)}.json`
  );
  assert.ok((await stat(objectPath)).size > 16 * 1024 * 1024);

  const apply = spawnSync(
    "node",
    ["dist/cli.js", "apply", plan.id, "--yes", "--expect-digest", plan.digest, "--json"],
    { env, encoding: "utf8", maxBuffer: 128 * 1024 * 1024 }
  );
  assert.equal(apply.status, 0, `${apply.stdout.slice(0, 2_000)}\n${apply.stderr}`);
  const receipt = JSON.parse(apply.stdout).data.receipt;
  assert.equal(receipt.outcome, "applied");
  assert.ok(receipt.inversePlanArtifact);
  const [applyProfileStore] = await readdir(join(fixture.stateDir, "apply-transactions"));
  const inversePath = join(
    fixture.stateDir,
    "apply-transactions",
    applyProfileStore,
    "inverse-plans",
    `${receipt.inversePlanArtifact.digest.slice("sha256:".length)}.json`
  );
  assert.ok((await stat(inversePath)).size > 16 * 1024 * 1024);
  const journal = JSON.parse(await readFile(join(
    fixture.stateDir,
    "apply-transactions",
    applyProfileStore,
    "journals",
    `${receipt.journalArtifact.digest.slice("sha256:".length)}.json`
  ), "utf8"));
  assert.deepEqual(
    journal.history.find((entry) => entry.stage === "preflight_ok").evidence.inversePlanArtifact,
    receipt.inversePlanArtifact
  );
});

test("recovery scan is read-only when no transaction store exists", async () => {
  const fixture = await makeDailySortFixture();
  const env = dailySortEnv(fixture);
  const before = await readFile(fixture.sessionPath);
  const scan = spawnSync("node", ["dist/cli.js", "apply", "recover", "--json"], {
    env,
    encoding: "utf8"
  });
  assert.equal(scan.status, 0, `${scan.stdout}\n${scan.stderr}`);
  assert.deepEqual(JSON.parse(scan.stdout).data.recoveries, []);
  assert.deepEqual(await readFile(fixture.sessionPath), before);
  await assert.rejects(() => readdir(fixture.stateDir), /ENOENT/);
});

test("legacy recovery directory discovery fails closed at its bounded scan limit", async () => {
  const fixture = await makeDailySortFixture();
  const env = dailySortEnv(fixture);
  const plan = previewDailyPlan(env);
  const previous = new Map();
  for (const key of ["HOME", "PATH", "ZTS_ZEN_APP_SUPPORT_DIR", "ZTS_STATE_DIR", "ZTS_CONFIG_PATH"]) {
    previous.set(key, process.env[key]);
    process.env[key] = env[key];
  }
  try {
    const { applyArtifactLayout } = await import("../dist/apply-artifacts.js");
    const layout = await applyArtifactLayout(plan.profileId);
    for (let index = 0; index < 513; index += 1) {
      await mkdir(join(layout.transactions, `legacy-${String(index).padStart(4, "0")}`));
    }
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
  const recover = spawnSync("node", ["dist/cli.js", "apply", "recover", "--json"], { env, encoding: "utf8" });
  assert.equal(recover.status, 4, `${recover.stdout}\n${recover.stderr}`);
  assert.equal(JSON.parse(recover.stdout).data.outcome.status, "internal_error");
  assert.match(JSON.parse(recover.stdout).blockers.join("\n"), /legacy apply recovery.*exceeds 512 entries/iu);
});

test("dry-run preserves the previewed Plan and fails closed after Snapshot Drift", async () => {
  const fixture = await makeDailySortFixture();
  const env = {
    ...process.env,
    HOME: fixture.temp,
    PATH: `${fixture.binDir}:${process.env.PATH ?? ""}`,
    ZTS_ZEN_APP_SUPPORT_DIR: fixture.appSupportDir,
    ZTS_STATE_DIR: fixture.stateDir,
    ZTS_CONFIG_PATH: fixture.configPath
  };
  const command = ["dist/cli.js", "sort", "--all", "--engine", "rules"];
  const preview = spawnSync("node", [...command, "--preview", "--json"], { env, encoding: "utf8" });
  assert.equal(preview.status, 0, `${preview.stdout}\n${preview.stderr}`);
  const previewJson = JSON.parse(preview.stdout);

  const changedSession = await readJsonLz4(fixture.sessionPath);
  changedSession.tabs.push({
    zenSyncId: "tab-after-preview",
    zenWorkspace: "w-space",
    pinned: false,
    entries: [{ url: "https://github.com/1Pio/new", title: "Opened after preview" }]
  });
  await writeJsonLz4(fixture.sessionPath, changedSession);

  const dryRun = spawnSync("node", [...command, "--dry-run", "--json"], { env, encoding: "utf8" });
  assert.equal(dryRun.status, 2, `${dryRun.stdout}\n${dryRun.stderr}`);
  const dryRunJson = JSON.parse(dryRun.stdout);
  assert.equal(dryRunJson.ok, false);
  assert.equal(dryRunJson.data.plan.digest, previewJson.data.plan.digest);
  assert.equal(dryRunJson.data.planResolution, "blocked_snapshot_drift");
  assert.match(dryRunJson.blockers.join("\n"), /Snapshot Drift/);

  const latest = await execFileAsync("node", ["dist/cli.js", "plan", "show", "latest", "--json"], { env });
  assert.equal(JSON.parse(latest.stdout).data.plan.digest, previewJson.data.plan.digest);
});

test("Apply Transaction rejects effective config drift during whole-Plan preflight", async () => {
  const fixture = await makeDailySortFixture();
  const env = dailySortEnv(fixture);
  const plan = previewDailyPlan(env);
  const beforeSession = await readFile(fixture.sessionPath);
  const initialConfig = await readFile(fixture.configPath, "utf8");
  await writeFile(
    fixture.configPath,
    initialConfig.replace("never_move = []", 'never_move = ["framer.com"]')
  );

  const apply = spawnSync(
    "node",
    ["dist/cli.js", "apply", plan.id, "--yes", "--expect-digest", plan.digest, "--json"],
    { env, encoding: "utf8" }
  );
  assert.equal(apply.status, 2, `${apply.stdout}\n${apply.stderr}`);
  const data = JSON.parse(apply.stdout).data;
  assert.equal(data.applied, false);
  assert.equal(data.receipt.outcome, "blocked");
  assert.equal(data.receipt.mutationAttempted, false);
  assert.ok(data.receipt.operations.every((operation) => operation.status === "not_attempted"));
  assert.match(JSON.parse(apply.stdout).blockers.join("\n"), /effective config Drift.+whole-Plan preflight/i);
  assert.deepEqual(await readFile(fixture.sessionPath), beforeSession);
});

test("canonical Apply honors live-only route policy and requires an explicit session override", async () => {
  const fixture = await makeDailySortFixture();
  const env = dailySortEnv(fixture);
  const config = (await readFile(fixture.configPath, "utf8")).replace(
    'apply_backend = "auto"',
    'apply_backend = "live"'
  );
  await writeFile(fixture.configPath, config, { mode: 0o600 });
  const plan = previewDailyPlan(env);
  const before = await readFile(fixture.sessionPath);
  const blocked = spawnSync("node", [
    "dist/cli.js", "apply", plan.id, "--yes", "--expect-digest", plan.digest, "--json"
  ], { env, encoding: "utf8" });
  assert.equal(blocked.status, 2, `${blocked.stdout}\n${blocked.stderr}`);
  assert.match(JSON.parse(blocked.stdout).blockers.join("\n"), /configured as live|never falls back/iu);
  assert.deepEqual(await readFile(fixture.sessionPath), before);

  const explicit = spawnSync("node", [
    "dist/cli.js", "apply", plan.id, "--yes", "--expect-digest", plan.digest,
    "--backend", "session", "--json"
  ], { env, encoding: "utf8" });
  assert.equal(explicit.status, 0, `${explicit.stdout}\n${explicit.stderr}`);
  assert.equal(JSON.parse(explicit.stdout).data.applied, true);
});

test("Apply Transaction rechecks config after preflight at the final mutation boundary", async () => {
  const fixture = await makeDailySortFixture();
  const env = dailySortEnv(fixture);
  const plan = previewDailyPlan(env);
  const beforeSession = await readFile(fixture.sessionPath);
  const initialConfig = await readFile(fixture.configPath, "utf8");
  const changedConfig = initialConfig.replace("never_move = []", 'never_move = ["framer.com"]');
  const script = [
    'import { readdir, writeFile } from "node:fs/promises";',
    'import { discoverProfileContext } from "./dist/profile.js";',
    'import { readApplyArtifactLayout } from "./dist/apply-artifacts.js";',
    'import { loadStoredPlan } from "./dist/plans.js";',
    'import { applyStoredPlanClosedSession } from "./dist/apply-transaction.js";',
    "const context = await discoverProfileContext();",
    `const stored = await loadStoredPlan(context.profile.id, ${JSON.stringify(plan.id)});`,
    'const failAfterProvingInverse = async () => {',
    '  const layout = await readApplyArtifactLayout(context.profile.id);',
    '  const inverses = await readdir(layout.inverses);',
    '  if (inverses.length !== 1) throw new Error("inverse was not durable before commit");',
    `  await writeFile(${JSON.stringify(fixture.configPath)}, ${JSON.stringify(changedConfig)});`,
    '};',
    "const result = await applyStoredPlanClosedSession(context, stored, {",
    `  expectedDigest: ${JSON.stringify(plan.digest)},`,
    '  command: "fixture config race",',
    '  beforeCommit: failAfterProvingInverse',
    "});",
    "process.stdout.write(JSON.stringify(result));"
  ].join("\n");
  const apply = spawnSync("node", ["--input-type=module", "--eval", script], {
    cwd: process.cwd(),
    env,
    encoding: "utf8"
  });
  assert.equal(apply.status, 0, `${apply.stdout}\n${apply.stderr}`);
  const result = JSON.parse(apply.stdout);
  assert.equal(result.applied, false);
  assert.equal(result.failureKind, "safety");
  assert.equal(result.receipt.outcome, "blocked");
  assert.equal(result.receipt.mutationAttempted, false);
  assert.equal(result.receipt.inversePlanArtifact, null);
  assert.ok(result.receipt.operations.every((operation) => operation.status === "not_attempted"));
  assert.match(result.blocker, /effective config Drift.+final mutation boundary/i);
  const inverseArtifact = result.artifacts.find((artifact) => artifact.kind === "inverse_plan");
  assert.ok(inverseArtifact);
  const [applyProfileStore] = await readdir(join(fixture.stateDir, "apply-transactions"));
  const finalJournal = JSON.parse(await readFile(join(
    fixture.stateDir,
    "apply-transactions",
    applyProfileStore,
    "journals",
    `${result.receipt.journalArtifact.digest.slice("sha256:".length)}.json`
  ), "utf8"));
  const preflight = finalJournal.history.find((entry) => entry.stage === "preflight_ok");
  assert.deepEqual(preflight.evidence.inversePlanArtifact, {
    id: inverseArtifact.id,
    digest: inverseArtifact.digest
  });
  assert.ok(preflight.evidence.expectedAfterSnapshotRevision);
  assert.deepEqual(await readFile(fixture.sessionPath), beforeSession);
});

test("unexpected post-marker config I/O faults remain internal exit 4 despite a truthful blocked Receipt", async () => {
  const fixture = await makeDailySortFixture();
  const env = dailySortEnv(fixture);
  const plan = previewDailyPlan(env);
  const beforeSession = await readFile(fixture.sessionPath);
  const script = [
    'import { chmod } from "node:fs/promises";',
    'import { discoverProfileContext } from "./dist/profile.js";',
    'import { loadStoredPlan } from "./dist/plans.js";',
    'import { applyStoredPlanClosedSession } from "./dist/apply-transaction.js";',
    'import { cliOutcomeForApplyTransaction } from "./dist/cli-outcome.js";',
    'const context = await discoverProfileContext();',
    `const stored = await loadStoredPlan(context.profile.id, ${JSON.stringify(plan.id)});`,
    'const result = await applyStoredPlanClosedSession(context, stored, {',
    `  expectedDigest: ${JSON.stringify(plan.digest)},`,
    '  command: "fixture unexpected config I/O fault",',
    `  beforeCommit: () => chmod(${JSON.stringify(fixture.configPath)}, 0o000)`,
    '});',
    'process.stdout.write(JSON.stringify({ result, disposition: cliOutcomeForApplyTransaction(result) }));'
  ].join("\n");
  const applied = spawnSync("node", ["--input-type=module", "--eval", script], {
    cwd: process.cwd(), env, encoding: "utf8"
  });
  await chmod(fixture.configPath, 0o600);
  assert.equal(applied.status, 0, `${applied.stdout}\n${applied.stderr}`);
  const data = JSON.parse(applied.stdout);
  assert.equal(data.result.applied, false);
  assert.equal(data.result.failureKind, "internal");
  assert.equal(data.result.receipt.outcome, "blocked");
  assert.equal(data.result.receipt.mutationAttempted, false);
  assert.equal(data.disposition.status, "internal_error");
  assert.equal(data.disposition.exitCode, 4);
  assert.deepEqual(await readFile(fixture.sessionPath), beforeSession);
});

test("Apply Transaction atomically restores a session writer racing its final commit", async () => {
  const fixture = await makeDailySortFixture();
  const env = dailySortEnv(fixture);
  const plan = previewDailyPlan(env);
  const racedSession = await readJsonLz4(fixture.sessionPath);
  racedSession.tabs.push({
    zenSyncId: "tab-raced-at-commit",
    zenWorkspace: "w-space",
    pinned: false,
    entries: [{ url: "https://writer.example.test", title: "Concurrent writer" }]
  });
  const script = [
    'import { discoverProfileContext } from "./dist/profile.js";',
    'import { loadStoredPlan } from "./dist/plans.js";',
    'import { applyStoredPlanClosedSession } from "./dist/apply-transaction.js";',
    'import { writeJsonLz4 } from "./dist/mozlz4.js";',
    "const context = await discoverProfileContext();",
    `const stored = await loadStoredPlan(context.profile.id, ${JSON.stringify(plan.id)});`,
    "const result = await applyStoredPlanClosedSession(context, stored, {",
    `  expectedDigest: ${JSON.stringify(plan.digest)},`,
    '  command: "fixture atomic session race",',
    `  afterSourceValidation: () => writeJsonLz4(${JSON.stringify(fixture.sessionPath)}, ${JSON.stringify(racedSession)})`,
    "});",
    "process.stdout.write(JSON.stringify(result));"
  ].join("\n");
  const apply = spawnSync("node", ["--input-type=module", "--eval", script], {
    cwd: process.cwd(),
    env,
    encoding: "utf8"
  });
  assert.equal(apply.status, 0, `${apply.stdout}\n${apply.stderr}`);
  const result = JSON.parse(apply.stdout);
  assert.equal(result.applied, false);
  assert.equal(result.failureKind, "safety");
  assert.equal(result.receipt.outcome, "blocked");
  assert.equal(result.receipt.mutationAttempted, false);
  assert.ok(result.receipt.operations.every((operation) => operation.status === "not_attempted"));
  assert.match(result.blocker, /atomic commit.+Drift|Drift.+atomic commit/i);
  assert.deepEqual(await readJsonLz4(fixture.sessionPath), racedSession);
});

test("explicit pinned and essential inclusion creates Protection-bound move Operations", async () => {
  const fixture = await makeDailySortFixture();
  const env = {
    ...process.env,
    HOME: fixture.temp,
    PATH: `${fixture.binDir}:${process.env.PATH ?? ""}`,
    ZTS_ZEN_APP_SUPPORT_DIR: fixture.appSupportDir,
    ZTS_STATE_DIR: fixture.stateDir,
    ZTS_CONFIG_PATH: fixture.configPath
  };
  const base = ["dist/cli.js", "sort", "--all", "--engine", "rules", "--preview", "--json"];
  const defaultPreview = spawnSync("node", base, { env, encoding: "utf8" });
  assert.equal(defaultPreview.status, 0, `${defaultPreview.stdout}\n${defaultPreview.stderr}`);
  const defaultJson = JSON.parse(defaultPreview.stdout);
  const pinnedRef = defaultJson.data.snapshot.entities.find((entity) => entity.nativeId === "tab-pinned-github").ref;
  const essentialRef = defaultJson.data.snapshot.entities.find((entity) => entity.nativeId === "tab-essential-framer").ref;
  assert.equal(actionFor(defaultJson.data.plan, pinnedRef).disposition, "protected");
  assert.equal(actionFor(defaultJson.data.plan, essentialRef).disposition, "protected");

  const includedPreview = spawnSync(
    "node",
    [...base.slice(0, -1), "--include-pinned", "--include-essentials", "--json"],
    { env, encoding: "utf8" }
  );
  assert.equal(includedPreview.status, 0, `${includedPreview.stdout}\n${includedPreview.stderr}`);
  const includedJson = JSON.parse(includedPreview.stdout);
  for (const ref of [pinnedRef, essentialRef]) {
    const action = actionFor(includedJson.data.plan, ref);
    assert.equal(action.disposition, "move");
    assert.equal(action.operation.precondition.entityProtection.protected, true);
    assert.match(action.operation.precondition.entityProtection.requiredGrantId, /^grant:/);
  }
});

test("human dry-run renders a useful complete diff for the exact previewed Plan", async () => {
  const fixture = await makeDailySortFixture();
  const env = {
    ...process.env,
    HOME: fixture.temp,
    PATH: `${fixture.binDir}:${process.env.PATH ?? ""}`,
    ZTS_ZEN_APP_SUPPORT_DIR: fixture.appSupportDir,
    ZTS_STATE_DIR: fixture.stateDir,
    ZTS_CONFIG_PATH: fixture.configPath
  };
  const base = ["dist/cli.js", "sort", "--all", "--engine", "rules"];
  const preview = spawnSync("node", [...base, "--preview"], { env, encoding: "utf8" });
  assert.equal(preview.status, 0, `${preview.stdout}\n${preview.stderr}`);
  assert.match(preview.stdout, /Sort preview · all applicable Workspaces/);
  assert.match(preview.stdout, /Nothing changed\./);

  const dryRun = spawnSync("node", [...base, "--dry-run"], { env, encoding: "utf8" });
  assert.equal(dryRun.status, 0, `${dryRun.stdout}\n${dryRun.stderr}`);
  assert.match(dryRun.stdout, /Framer project/);
  assert.match(dryRun.stdout, /Space -> Portfolio Work/);
  assert.match(dryRun.stdout, /framer\.com/);
  assert.match(dryRun.stdout, /protected.+Would route to Stash/i);

  const scopedPreview = spawnSync(
    "node",
    ["dist/cli.js", "sort", "Tool Development", "--engine", "rules", "--preview", "--json"],
    { env, encoding: "utf8" }
  );
  assert.equal(scopedPreview.status, 0, `${scopedPreview.stdout}\n${scopedPreview.stderr}`);
  assert.equal(
    JSON.parse(scopedPreview.stdout).suggestedNextCommands[0],
    "zts sort 'Tool Development' --engine rules --dry-run"
  );
});

test("selected apply actions derive and persist a new exact Plan before consent", async () => {
  const fixture = await makeDailySortFixture();
  const env = {
    ...process.env,
    HOME: fixture.temp,
    PATH: `${fixture.binDir}:${process.env.PATH ?? ""}`,
    ZTS_ZEN_APP_SUPPORT_DIR: fixture.appSupportDir,
    ZTS_STATE_DIR: fixture.stateDir,
    ZTS_CONFIG_PATH: fixture.configPath
  };
  const beforeSession = await readFile(fixture.sessionPath);
  const preview = spawnSync(
    "node",
    ["dist/cli.js", "sort", "--all", "--engine", "rules", "--preview", "--json"],
    { env, encoding: "utf8" }
  );
  assert.equal(preview.status, 0, `${preview.stdout}\n${preview.stderr}`);
  const previewJson = JSON.parse(preview.stdout);
  const selectedActionIds = previewJson.data.plan.actions
    .filter((action) => action.disposition === "move")
    .slice(0, 2)
    .map((action) => action.actionId);
  assert.equal(selectedActionIds.length, 2);

  const derive = spawnSync(
    "node",
    ["dist/cli.js", "apply", "latest", "--actions", selectedActionIds.join(","), "--json"],
    { env, encoding: "utf8" }
  );
  assert.equal(derive.status, 2, `${derive.stdout}\n${derive.stderr}`);
  const deriveJson = JSON.parse(derive.stdout);
  assert.equal(deriveJson.ok, false);
  assert.equal(deriveJson.data.applied, false);
  assert.equal(deriveJson.data.originalPlan.digest, previewJson.data.plan.digest);
  assert.notEqual(deriveJson.data.plan.digest, previewJson.data.plan.digest);
  assert.equal(deriveJson.data.plan.derivation.kind, "subset");
  assert.equal(deriveJson.data.plan.derivation.parentPlanDigest, previewJson.data.plan.digest);
  assert.deepEqual(deriveJson.data.plan.derivation.selectedActionIds, selectedActionIds);
  assert.deepEqual(deriveJson.data.plan.actions.map((action) => action.actionId), selectedActionIds);
  assert.match(deriveJson.blockers.join("\n"), /confirm the exact derived Plan/i);

  const stored = await execFileAsync("node", ["dist/cli.js", "plan", "show", deriveJson.data.plan.id, "--json"], { env });
  assert.equal(JSON.parse(stored.stdout).data.plan.digest, deriveJson.data.plan.digest);
  assert.deepEqual(await readFile(fixture.sessionPath), beforeSession);
});

test("exact confirmed subset Plan applies only its selected Operations and writes a domain Receipt", async () => {
  const fixture = await makeDailySortFixture();
  const env = {
    ...process.env,
    HOME: fixture.temp,
    PATH: `${fixture.binDir}:${process.env.PATH ?? ""}`,
    ZTS_ZEN_APP_SUPPORT_DIR: fixture.appSupportDir,
    ZTS_STATE_DIR: fixture.stateDir,
    ZTS_CONFIG_PATH: fixture.configPath
  };
  const preview = spawnSync(
    "node",
    ["dist/cli.js", "sort", "--all", "--engine", "rules", "--preview", "--json"],
    { env, encoding: "utf8" }
  );
  assert.equal(preview.status, 0, `${preview.stdout}\n${preview.stderr}`);
  const previewJson = JSON.parse(preview.stdout);
  const moveActions = previewJson.data.plan.actions.filter((action) => action.disposition === "move");
  const selectedActionIds = moveActions.slice(0, 2).map((action) => action.actionId);
  const unselectedAction = moveActions[2];
  assert.equal(selectedActionIds.length, 2);
  assert.ok(unselectedAction);

  const derive = spawnSync(
    "node",
    ["dist/cli.js", "apply", "latest", "--actions", selectedActionIds.join(","), "--json"],
    { env, encoding: "utf8" }
  );
  assert.equal(derive.status, 2, `${derive.stdout}\n${derive.stderr}`);
  const derivedPlan = JSON.parse(derive.stdout).data.plan;
  const apply = spawnSync(
    "node",
    [
      "dist/cli.js",
      "apply",
      derivedPlan.id,
      "--yes",
      "--expect-digest",
      derivedPlan.digest,
      "--json"
    ],
    { env, encoding: "utf8" }
  );
  assert.equal(apply.status, 0, `${apply.stdout}\n${apply.stderr}`);
  const applyJson = JSON.parse(apply.stdout);
  assert.equal(applyJson.ok, true);
  assert.equal(applyJson.data.applied, true);
  assert.equal(applyJson.data.plan.digest, derivedPlan.digest);
  assert.equal(applyJson.data.authorization.planDigest, derivedPlan.digest);
  assert.deepEqual(applyJson.data.authorization.authorizedActionIds, selectedActionIds);
  assert.equal(applyJson.data.receipt.outcome, "applied");
  assert.equal(applyJson.data.receipt.planDigest, derivedPlan.digest);
  assert.deepEqual(applyJson.data.receipt.operations.map((operation) => operation.actionId), selectedActionIds);
  assert.ok(applyJson.data.receipt.backupArtifact);
  assert.ok(applyJson.data.receipt.inversePlanArtifact);

  const afterSession = await readJsonLz4(fixture.sessionPath);
  const entities = new Map(previewJson.data.snapshot.entities.map((entity) => [entity.ref, entity]));
  for (const action of derivedPlan.actions) {
    const nativeId = entities.get(action.operation.entityRef).nativeId;
    const rawTab = afterSession.tabs.find((tab) => tab.zenSyncId === nativeId);
    assert.equal(rawTab.zenWorkspace, action.operation.expectedPostState.workspaceId);
  }
  const unselectedNativeId = entities.get(unselectedAction.operation.entityRef).nativeId;
  const unselectedTab = afterSession.tabs.find((tab) => tab.zenSyncId === unselectedNativeId);
  assert.equal(unselectedTab.zenWorkspace, unselectedAction.operation.precondition.sourceWorkspace.workspaceId);

  const list = await execFileAsync("node", ["dist/cli.js", "apply", "list", "--json"], { env });
  const listed = JSON.parse(list.stdout).data.receipts[0];
  assert.equal(listed.id, applyJson.data.receipt.id);
  assert.equal(listed.kind, "saved_plan");
  assert.equal(listed.planDigest, derivedPlan.digest);

  const verify = await execFileAsync("node", ["dist/cli.js", "apply", "verify", applyJson.data.receipt.id, "--json"], { env });
  const verifyJson = JSON.parse(verify.stdout);
  assert.equal(verifyJson.ok, true);
  assert.equal(verifyJson.data.report.receipt.planDigest, derivedPlan.digest);
  assert.equal(verifyJson.data.report.verification.checkedOperations, selectedActionIds.length);
  assert.equal(verifyJson.data.report.verification.mismatchCount, 0);
});

test("missing unfinished/history indexes fail closed without rewriting canonical Receipt locators", async () => {
  const fixture = await makeDailySortFixture();
  const env = dailySortEnv(fixture);
  const initialPlan = previewDailyPlan(env);
  const firstAction = initialPlan.actions.find((action) => action.disposition === "move");
  const derive = spawnSync("node", [
    "dist/cli.js", "apply", initialPlan.id, "--actions", firstAction.actionId, "--json"
  ], { env, encoding: "utf8" });
  assert.equal(derive.status, 2, `${derive.stdout}\n${derive.stderr}`);
  const firstPlan = JSON.parse(derive.stdout).data.plan;
  const firstApply = spawnSync("node", [
    "dist/cli.js", "apply", firstPlan.id, "--yes", "--expect-digest", firstPlan.digest, "--json"
  ], { env, encoding: "utf8" });
  assert.equal(firstApply.status, 0, `${firstApply.stdout}\n${firstApply.stderr}`);
  const firstReceipt = JSON.parse(firstApply.stdout).data.receipt;
  const transactionSegment = firstReceipt.id.slice("receipt:".length).replace(/[^A-Za-z0-9._-]+/gu, "-");
  const tree = await snapshotFileTree(fixture.stateDir);
  const pointerKey = Object.keys(tree).find((path) =>
    path.endsWith(`/transactions/${transactionSegment}/receipt-pointer.json`)
  );
  const intentKey = Object.keys(tree).find((path) =>
    path.endsWith(`/transactions/${transactionSegment}/receipt-intent.json`)
  );
  const indexKey = Object.keys(tree).find((path) => path.endsWith("/unfinished/index.json"));
  const historyHeadKey = Object.keys(tree).find((path) => path.endsWith("/receipt-history/head.json"));
  const inverseKey = Object.keys(tree).find((path) =>
    path.endsWith(`/inverse-plans/${firstReceipt.inversePlanArtifact.digest.slice("sha256:".length)}.json`)
  );
  assert.ok(pointerKey && intentKey && indexKey && historyHeadKey && inverseKey);
  const inverseEnvelope = JSON.parse(await readFile(join(fixture.stateDir, inverseKey), "utf8"));
  await writeFile(join(fixture.stateDir, inverseKey), `${JSON.stringify(inverseEnvelope.plan, null, 2)}\n`);
  await rm(join(fixture.stateDir, indexKey));
  await rm(join(fixture.stateDir, historyHeadKey, ".."), { recursive: true });

  const secondPlan = previewDailyPlan(env);
  const secondApply = spawnSync("node", [
    "dist/cli.js", "apply", secondPlan.id, "--yes", "--expect-digest", secondPlan.digest, "--json"
  ], { env, encoding: "utf8" });
  assert.equal(secondApply.status, 2, `${secondApply.stdout}\n${secondApply.stderr}`);
  assert.match(
    JSON.parse(secondApply.stdout).blockers.join("\n"),
    /automatic legacy or missing-head migration is disabled/iu
  );
  await assert.doesNotReject(() => readFile(join(fixture.stateDir, pointerKey)));
  await assert.doesNotReject(() => readFile(join(fixture.stateDir, intentKey)));
  await assert.rejects(() => readFile(join(fixture.stateDir, indexKey)), /ENOENT/);

  const verify = spawnSync("node", [
    "dist/cli.js", "apply", "verify", firstReceipt.id, "--json"
  ], { env, encoding: "utf8" });
  assert.equal(verify.status, 0, `${verify.stdout}\n${verify.stderr}`);
  assert.equal(JSON.parse(verify.stdout).data.report.inversePlanReplayability, "legacy_unbound");
  const list = spawnSync("node", ["dist/cli.js", "apply", "list", "--json"], { env, encoding: "utf8" });
  assert.equal(list.status, 2, `${list.stdout}\n${list.stderr}`);
  assert.equal(JSON.parse(list.stdout).data.outcome.status, "blocked");
  assert.match(JSON.parse(list.stdout).blockers.join("\n"), /no complete ready head/iu);
});

test("missing ready history head blocks Apply and cursor reads without implicit rebuild", async () => {
  const fixture = await makeDailySortFixture();
  const env = dailySortEnv(fixture);
  const initial = previewDailyPlan(env);
  const firstAction = initial.actions.find((action) => action.disposition === "move");
  const derive = spawnSync("node", [
    "dist/cli.js", "apply", initial.id, "--actions", firstAction.actionId, "--json"
  ], { env, encoding: "utf8" });
  assert.equal(derive.status, 2, `${derive.stdout}\n${derive.stderr}`);
  const firstPlan = JSON.parse(derive.stdout).data.plan;
  const firstApply = spawnSync("node", [
    "dist/cli.js", "apply", firstPlan.id, "--yes", "--expect-digest", firstPlan.digest, "--json"
  ], { env, encoding: "utf8" });
  assert.equal(firstApply.status, 0, `${firstApply.stdout}\n${firstApply.stderr}`);
  const firstReceipt = JSON.parse(firstApply.stdout).data.receipt;

  const staleApply = spawnSync("node", [
    "dist/cli.js", "apply", firstPlan.id, "--yes", "--expect-digest", firstPlan.digest, "--json"
  ], { env, encoding: "utf8" });
  assert.equal(staleApply.status, 2, `${staleApply.stdout}\n${staleApply.stderr}`);
  const staleReceipt = JSON.parse(staleApply.stdout).data.receipt;
  assert.equal(staleReceipt.outcome, "blocked");

  const beforeRebuildPage = JSON.parse(spawnSync(
    "node", ["dist/cli.js", "apply", "list", "--limit", "1", "--json"], { env, encoding: "utf8" }
  ).stdout);
  assert.equal(beforeRebuildPage.data.receipts.length, 1);
  assert.ok(beforeRebuildPage.data.history.nextCursor);
  const stableCursor = beforeRebuildPage.data.history.nextCursor;

  const tree = await snapshotFileTree(fixture.stateDir);
  const headKey = Object.keys(tree).find((path) => path.endsWith("/receipt-history/head.json"));
  assert.ok(headKey);
  await rm(join(fixture.stateDir, headKey));

  const next = previewDailyPlan(env);
  const nextAction = next.actions.find((action) => action.disposition === "move");
  assert.ok(nextAction);
  const deriveNext = spawnSync("node", [
    "dist/cli.js", "apply", next.id, "--actions", nextAction.actionId, "--json"
  ], { env, encoding: "utf8" });
  assert.equal(deriveNext.status, 2, `${deriveNext.stdout}\n${deriveNext.stderr}`);
  const nextPlan = JSON.parse(deriveNext.stdout).data.plan;
  const nextApply = spawnSync("node", [
    "dist/cli.js", "apply", nextPlan.id, "--yes", "--expect-digest", nextPlan.digest, "--json"
  ], { env, encoding: "utf8" });
  assert.equal(nextApply.status, 2, `${nextApply.stdout}\n${nextApply.stderr}`);
  assert.match(JSON.parse(nextApply.stdout).blockers.join("\n"), /missing-head migration is disabled/iu);

  const resumed = spawnSync("node", [
    "dist/cli.js", "apply", "list", "--limit", "1", "--cursor", stableCursor, "--json"
  ], { env, encoding: "utf8" });
  assert.equal(resumed.status, 2, `${resumed.stdout}\n${resumed.stderr}`);
  assert.equal(JSON.parse(resumed.stdout).data.outcome.status, "blocked");
  assert.equal(resumed.stderr, "");
  assert.match(JSON.parse(resumed.stdout).blockers.join("\n"), /no complete ready head/iu);

  const all = spawnSync(
    "node", ["dist/cli.js", "apply", "list", "--limit", "10", "--json"], { env, encoding: "utf8" }
  );
  assert.equal(all.status, 2, `${all.stdout}\n${all.stderr}`);
  assert.equal(JSON.parse(all.stdout).data.outcome.status, "blocked");
  assert.match(JSON.parse(all.stdout).blockers.join("\n"), /no complete ready head/iu);
  const after = await snapshotFileTree(fixture.stateDir);
  assert.equal(Object.keys(after).some((path) => path.endsWith("/receipt-history/head.json")), false);
  assert.ok(firstReceipt.id && staleReceipt.id);
});

test("concurrent fresh-store bootstraps serialize accounting, unfinished index, and ready history", async () => {
  const fixture = await makeDailySortFixture();
  const env = dailySortEnv(fixture);
  const plan = previewDailyPlan(env);

  const previous = new Map();
  for (const key of ["HOME", "PATH", "ZTS_ZEN_APP_SUPPORT_DIR", "ZTS_STATE_DIR", "ZTS_CONFIG_PATH"]) {
    previous.set(key, process.env[key]);
    process.env[key] = env[key];
  }
  try {
    const { applyArtifactLayout } = await import("../dist/apply-artifacts.js");
    const { ensureApplyReceiptSummaryHistory, listTransactionReceipts } = await import("../dist/apply-transaction.js");
    const layout = await applyArtifactLayout(plan.profileId);
    let releaseFirst;
    let firstOwnsMigration;
    const firstOwns = new Promise((resolve) => { firstOwnsMigration = resolve; });
    const firstMayContinue = new Promise((resolve) => { releaseFirst = resolve; });
    const first = ensureApplyReceiptSummaryHistory(layout, plan.profileId, {
      afterMigrationLock: async () => {
        firstOwnsMigration();
        await firstMayContinue;
      }
    });
    await firstOwns;
    let secondSettled = false;
    const second = ensureApplyReceiptSummaryHistory(layout, plan.profileId).finally(() => {
      secondSettled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(secondSettled, false);
    releaseFirst();
    await Promise.all([first, second]);

    const history = await listTransactionReceipts(plan.profileId, { limit: 10 });
    assert.deepEqual(history, []);
    const after = await snapshotFileTree(fixture.stateDir);
    assert.equal(Object.keys(after).some((path) => path.endsWith("/receipt-history/history.lock")), true);
    assert.equal(Object.keys(after).some((path) => path.endsWith("/receipt-history/head.json")), true);
    assert.equal(Object.keys(after).some((path) => path.endsWith("/unfinished/index.json")), true);
    assert.equal(Object.keys(after).some((path) => path.endsWith("/store-accounting.json")), true);
    assert.equal(Object.keys(after).filter((path) => path.endsWith(".node.json")).length, 0);
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }

  const apply = spawnSync("node", [
    "dist/cli.js", "apply", plan.id, "--yes", "--expect-digest", plan.digest, "--json"
  ], { env, encoding: "utf8" });
  assert.equal(apply.status, 0, `${apply.stdout}\n${apply.stderr}`);
});

test("fresh bootstrap resumes an exact accounting rebase after all artifacts are durable", async () => {
  const fixture = await makeDailySortFixture();
  const env = dailySortEnv(fixture);
  const plan = previewDailyPlan(env);
  const previous = new Map();
  for (const key of ["HOME", "PATH", "ZTS_ZEN_APP_SUPPORT_DIR", "ZTS_STATE_DIR", "ZTS_CONFIG_PATH"]) {
    previous.set(key, process.env[key]);
    process.env[key] = env[key];
  }
  try {
    const { applyArtifactLayout } = await import("../dist/apply-artifacts.js");
    const {
      ensureApplyReceiptSummaryHistory
    } = await import("../dist/apply-transaction.js");
    const {
      readApplyStoreAccounting
    } = await import("../dist/apply-store-accounting.js");
    const layout = await applyArtifactLayout(plan.profileId);
    await assert.rejects(
      ensureApplyReceiptSummaryHistory(layout, plan.profileId, {
        afterFreshBootstrapArtifacts: () => {
          throw new Error("fixture crash before exact bootstrap rebase");
        }
      }),
      /fixture crash before exact bootstrap rebase/
    );
    const conservative = await readApplyStoreAccounting(layout, plan.profileId);
    assert.ok(conservative);
    assert.ok(conservative.baselineBytes > 16 * 1024 * 1024);

    await ensureApplyReceiptSummaryHistory(layout, plan.profileId);
    const rebased = await readApplyStoreAccounting(layout, plan.profileId);
    assert.ok(rebased);
    const tree = await snapshotFileTree(fixture.stateDir);
    const accountingKey = Object.keys(tree).find((key) => key.endsWith("/store-accounting.json"));
    assert.ok(accountingKey);
    const applyRoot = dirname(accountingKey);
    const entries = Object.entries(tree).filter(([key]) =>
      key !== `${applyRoot}/` && key.startsWith(`${applyRoot}/`)
    );
    const accountingBytes = Buffer.from(tree[accountingKey], "base64").byteLength;
    const exactBytes = entries.reduce((total, [, value]) =>
      value === "directory" ? total : total + Buffer.from(value, "base64").byteLength, 0
    ) - accountingBytes + APPLY_STORE_ACCOUNTING_MAX_BYTES;
    assert.equal(rebased.baselineBytes, exactBytes);
    assert.equal(rebased.baselineEntries, entries.length);
    assert.ok(rebased.baselineBytes < conservative.baselineBytes);

    await ensureApplyReceiptSummaryHistory(layout, plan.profileId);
    assert.deepEqual(await readApplyStoreAccounting(layout, plan.profileId), rebased);
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("fresh bootstrap reconciles an exact unfinished-index publication residue", async () => {
  const fixture = await makeDailySortFixture();
  const env = dailySortEnv(fixture);
  const plan = previewDailyPlan(env);
  const crashScript = [
    'import { applyArtifactLayout } from "./dist/apply-artifacts.js";',
    'import { initializeApplyUnfinishedIndex } from "./dist/apply-unfinished-store.js";',
    `const layout = await applyArtifactLayout(${JSON.stringify(plan.profileId)});`,
    `await initializeApplyUnfinishedIndex(layout, ${JSON.stringify(plan.profileId)}, {`,
    '  afterLink: () => process.exit(67)',
    '});'
  ].join("\n");
  const crashed = spawnSync("node", ["--input-type=module", "--eval", crashScript], {
    cwd: process.cwd(), env, encoding: "utf8"
  });
  assert.equal(crashed.status, 67, `${crashed.stdout}\n${crashed.stderr}`);
  const before = await snapshotFileTree(fixture.stateDir);
  assert.equal(Object.keys(before).some((path) => path.endsWith("/unfinished/index.json")), true);
  assert.equal(Object.keys(before).some((path) => /\/unfinished\/\.tmp-.*\.artifact$/u.test(path)), true);

  const apply = spawnSync("node", [
    "dist/cli.js", "apply", plan.id, "--yes", "--expect-digest", plan.digest, "--json"
  ], { env, encoding: "utf8" });
  assert.equal(apply.status, 0, `${apply.stdout}\n${apply.stderr}`);
  const after = await snapshotFileTree(fixture.stateDir);
  assert.equal(Object.keys(after).some((path) => /\/unfinished\/\.tmp-/u.test(path)), false);
});

test("Receipt publication and recovery remain live beyond the former 4096-node lookup boundary", async () => {
  const fixture = await makeDailySortFixture();
  const env = dailySortEnv(fixture);
  const plan = previewDailyPlan(env);
  const setup = [
    'import { lstat, opendir } from "node:fs/promises";',
    'import { applyArtifactLayout } from "./dist/apply-artifacts.js";',
    'import { sha256Canonical } from "./dist/domain/digest.js";',
    'import { initializeApplyUnfinishedIndex } from "./dist/apply-unfinished-store.js";',
    'import { initializeApplyStoreAccountingBaseline } from "./dist/apply-store-accounting.js";',
    'import {',
    '  beginApplyReceiptHistoryMigration,',
    '  buildApplyReceiptSummaryGeneration,',
    '  readApplyReceiptHistoryHead,',
    '  swapApplyReceiptHistoryHead,',
    '  withApplyReceiptHistoryMigration',
    '} from "./dist/apply-receipt-store.js";',
    `const profileId = ${JSON.stringify(plan.profileId)};`,
    'const layout = await applyArtifactLayout(profileId);',
    'const completedAt = "2020-01-01T00:00:00.000Z";',
    'const summaries = Array.from({ length: 4097 }, (_, index) => ({',
    '  id: `receipt:apply:00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`,',
    '  kind: "saved_plan", outcome: "blocked", planId: `historical:${index}:${"x".repeat(10_000)}`,',
    '  planDigest: sha256Canonical({ plan: index }), causalSourceReceiptId: null, causalSourceReceiptDigest: null, profileId, completedAt, operationCount: 1,',
    '  inversePlanReplayability: "none", receiptDigest: sha256Canonical({ receipt: index }),',
    '  fullReceiptAvailability: "archived_summary_only", archivedAt: completedAt',
    '})).reverse();',
    'await beginApplyReceiptHistoryMigration(layout, profileId);',
    'await withApplyReceiptHistoryMigration(layout, profileId, async (control) => {',
    '  const source = await readApplyReceiptHistoryHead(layout, profileId);',
    '  const target = await buildApplyReceiptSummaryGeneration(layout, profileId, summaries, control);',
    '  await swapApplyReceiptHistoryHead(layout, profileId, source.revision, target, control);',
    '});',
    'await initializeApplyUnfinishedIndex(layout, profileId);',
    'let baselineBytes = 0;',
    'let baselineEntries = 0;',
    'const measure = async (directory) => {',
    '  const handle = await opendir(directory);',
    '  try {',
    '    for await (const entry of handle) {',
    '      baselineEntries += 1;',
    '      const path = `${directory}/${entry.name}`;',
    '      const metadata = await lstat(path);',
    '      if (metadata.isDirectory()) await measure(path);',
    '      else baselineBytes += metadata.size;',
    '    }',
    '  } finally {',
    '    await handle.close().catch(() => undefined);',
    '  }',
    '};',
    'await measure(layout.root);',
    'await initializeApplyStoreAccountingBaseline(',
    '  layout, profileId, baselineBytes, baselineEntries, new Date(completedAt)',
    ');'
  ].join("\n");
  const seeded = spawnSync("node", ["--input-type=module", "--eval", setup], {
    cwd: process.cwd(), env, encoding: "utf8", timeout: 120_000
  });
  assert.equal(seeded.status, 0, `${seeded.stdout}\n${seeded.stderr}`);
  assert.equal(crashDailyApply(env, plan, "afterUnfinishedMarker", 58).status, 58);

  const memoryProbe = [
    'import { applyArtifactLayout } from "./dist/apply-artifacts.js";',
    'import { scanApplyReceiptSummaries } from "./dist/apply-receipt-store.js";',
    `const layout = await applyArtifactLayout(${JSON.stringify(plan.profileId)});`,
    `const result = await scanApplyReceiptSummaries(layout, ${JSON.stringify(plan.profileId)}, {`,
    '  maxEntries: 5000, retainNewest: 8',
    '});',
    'console.log(JSON.stringify({ count: result.summaryCount, retained: result.newest.length }));'
  ].join("\n");
  const boundedScan = spawnSync("node", [
    "--max-old-space-size=32", "--input-type=module", "--eval", memoryProbe
  ], { cwd: process.cwd(), env, encoding: "utf8", timeout: 30_000 });
  assert.equal(boundedScan.status, 0, `${boundedScan.stdout}\n${boundedScan.stderr}`);
  assert.deepEqual(JSON.parse(boundedScan.stdout), { count: 4097, retained: 8 });

  const listed = spawnSync("node", ["dist/cli.js", "apply", "recover", "--json"], {
    env, encoding: "utf8", timeout: 30_000
  });
  assert.equal(listed.status, 0, `${listed.stdout}\n${listed.stderr}`);
  const candidate = JSON.parse(listed.stdout).data.recoveries[0];
  const execute = executeRecovery(env, candidate);
  assert.equal(execute.status, 0, `${execute.stdout}\n${execute.stderr}`);
  const data = JSON.parse(execute.stdout).data;
  assert.equal(data.receipt.outcome, "interrupted");
  assert.deepEqual(JSON.parse(spawnSync(
    "node", ["dist/cli.js", "apply", "recover", "--json"], { env, encoding: "utf8" }
  ).stdout).data.recoveries, []);
  const latest = spawnSync("node", ["dist/cli.js", "apply", "list", "--limit", "1", "--json"], {
    env, encoding: "utf8"
  });
  assert.equal(latest.status, 0, `${latest.stdout}\n${latest.stderr}`);
  assert.equal(JSON.parse(latest.stdout).data.receipts[0].id, data.receipt.id);
});

test("markerless Receipt lookup requires ready-history reachability and complete payload closure", async () => {
  const orphanFixture = await makeDailySortFixture();
  const orphanEnv = dailySortEnv(orphanFixture);
  const orphanPlan = previewDailyPlan(orphanEnv);
  const orphanApply = spawnSync("node", [
    "dist/cli.js", "apply", orphanPlan.id, "--yes", "--expect-digest", orphanPlan.digest, "--json"
  ], { env: orphanEnv, encoding: "utf8" });
  assert.equal(orphanApply.status, 0, `${orphanApply.stdout}\n${orphanApply.stderr}`);
  const orphanReceipt = JSON.parse(orphanApply.stdout).data.receipt;
  const orphanTree = await snapshotFileTree(orphanFixture.stateDir);
  const orphanHeadKey = Object.keys(orphanTree).find((path) => path.endsWith("/receipt-history/head.json"));
  assert.ok(orphanHeadKey);
  const orphanHead = JSON.parse(await readFile(join(orphanFixture.stateDir, orphanHeadKey), "utf8"));
  orphanHead.entryCount = 0;
  orphanHead.latestNodeDigest = null;
  orphanHead.latestTransactionId = null;
  orphanHead.latestReceiptDigest = null;
  const { revision: _orphanRevision, ...orphanHeadContent } = orphanHead;
  orphanHead.revision = sha256Canonical(orphanHeadContent);
  await writeFile(join(orphanFixture.stateDir, orphanHeadKey), `${JSON.stringify(orphanHead, null, 2)}\n`);
  const orphanVerify = spawnSync(
    "node", ["dist/cli.js", "apply", "verify", orphanReceipt.id, "--json"], { env: orphanEnv, encoding: "utf8" }
  );
  assert.equal(orphanVerify.status, 4, `${orphanVerify.stdout}\n${orphanVerify.stderr}`);
  assert.equal(orphanVerify.stderr, "");
  const orphanVerifyOutput = JSON.parse(orphanVerify.stdout);
  assert.equal(orphanVerifyOutput.data.outcome.status, "internal_error");
  assert.match(orphanVerifyOutput.blockers.join("\n"), /not reachable from ready history/iu);

  const missingFixture = await makeDailySortFixture();
  const missingEnv = dailySortEnv(missingFixture);
  const missingPlan = previewDailyPlan(missingEnv);
  const missingApply = spawnSync("node", [
    "dist/cli.js", "apply", missingPlan.id, "--yes", "--expect-digest", missingPlan.digest, "--json"
  ], { env: missingEnv, encoding: "utf8" });
  assert.equal(missingApply.status, 0, `${missingApply.stdout}\n${missingApply.stderr}`);
  const missingReceipt = JSON.parse(missingApply.stdout).data.receipt;
  const missingSegment = missingReceipt.id.slice("receipt:".length).replace(/[^A-Za-z0-9._-]+/gu, "-");
  const missingTree = await snapshotFileTree(missingFixture.stateDir);
  const missingTransactionKey = Object.keys(missingTree).find((path) =>
    path.endsWith(`/transactions/${missingSegment}/`)
  );
  assert.ok(missingTransactionKey);
  await rm(join(missingFixture.stateDir, missingTransactionKey), { recursive: true });
  const missingVerify = spawnSync(
    "node", ["dist/cli.js", "apply", "verify", missingReceipt.id, "--json"], { env: missingEnv, encoding: "utf8" }
  );
  assert.equal(missingVerify.status, 4, `${missingVerify.stdout}\n${missingVerify.stderr}`);
  assert.equal(missingVerify.stderr, "");
  const missingVerifyOutput = JSON.parse(missingVerify.stdout);
  assert.equal(missingVerifyOutput.data.outcome.status, "internal_error");
  assert.match(missingVerifyOutput.blockers.join("\n"), /ready Apply Receipt.*missing.*transaction directory/iu);
});

test("history corruption fails closed and cursors are authenticated", async () => {
  const firstFixture = await makeDailySortFixture();
  const firstEnv = dailySortEnv(firstFixture);
  const firstPlan = previewDailyPlan(firstEnv);
  const firstApply = spawnSync("node", [
    "dist/cli.js", "apply", firstPlan.id, "--yes", "--expect-digest", firstPlan.digest, "--json"
  ], { env: firstEnv, encoding: "utf8" });
  assert.equal(firstApply.status, 0, `${firstApply.stdout}\n${firstApply.stderr}`);
  const firstTree = await snapshotFileTree(firstFixture.stateDir);
  const nodeKey = Object.keys(firstTree).find((path) => path.endsWith(".node.json"));
  const headKey = Object.keys(firstTree).find((path) => path.endsWith("/receipt-history/head.json"));
  assert.ok(nodeKey && headKey);
  const node = JSON.parse(await readFile(join(firstFixture.stateDir, nodeKey), "utf8"));
  const head = JSON.parse(await readFile(join(firstFixture.stateDir, headKey), "utf8"));
  const originalHead = structuredClone(head);
  assert.match(head.generationId, /^historygen:[a-f0-9]{64}$/);
  assert.match(head.cursorHmacSecret, /^[a-f0-9]{64}$/);
  assert.equal(node.generationId, head.generationId);
  const originalNode = structuredClone(node);
  node.padding = "x".repeat(20 * 1024);
  await writeFile(join(firstFixture.stateDir, nodeKey), `${JSON.stringify(node, null, 2)}\n`);
  const corruptedNodeTree = await snapshotFileTree(firstFixture.stateDir);
  const corruptedNodeList = spawnSync(
    "node", ["dist/cli.js", "apply", "list", "--json"], { env: firstEnv, encoding: "utf8" }
  );
  assert.equal(corruptedNodeList.status, 4, `${corruptedNodeList.stdout}\n${corruptedNodeList.stderr}`);
  const corruptedNodeOutput = JSON.parse(corruptedNodeList.stdout);
  assert.equal(corruptedNodeOutput.data.outcome.status, "internal_error");
  assert.match(corruptedNodeOutput.blockers.join("\n"), /history node|read limit|unknown or missing fields/iu);
  assert.deepEqual(await snapshotFileTree(firstFixture.stateDir), corruptedNodeTree);

  await writeFile(join(firstFixture.stateDir, nodeKey), `${JSON.stringify(originalNode, null, 2)}\n`);
  head.cursorHmacSecret = "not-a-secret";
  await writeFile(join(firstFixture.stateDir, headKey), `${JSON.stringify(head, null, 2)}\n`);
  const corruptedHeadTree = await snapshotFileTree(firstFixture.stateDir);
  const corruptedHeadList = spawnSync(
    "node", ["dist/cli.js", "apply", "list", "--json"], { env: firstEnv, encoding: "utf8" }
  );
  assert.equal(corruptedHeadList.status, 4, `${corruptedHeadList.stdout}\n${corruptedHeadList.stderr}`);
  const corruptedHeadOutput = JSON.parse(corruptedHeadList.stdout);
  assert.equal(corruptedHeadOutput.data.outcome.status, "internal_error");
  assert.match(corruptedHeadOutput.blockers.join("\n"), /history head|invalid/iu);
  assert.deepEqual(await snapshotFileTree(firstFixture.stateDir), corruptedHeadTree);

  const foreignHead = { ...originalHead, profileId: "profile:foreign-fixture" };
  const { revision: _foreignRevision, ...foreignContent } = foreignHead;
  foreignHead.revision = sha256Canonical(foreignContent);
  await writeFile(join(firstFixture.stateDir, headKey), `${JSON.stringify(foreignHead, null, 2)}\n`);
  const foreignHeadList = spawnSync(
    "node", ["dist/cli.js", "apply", "list", "--json"], { env: firstEnv, encoding: "utf8" }
  );
  assert.equal(foreignHeadList.status, 4, `${foreignHeadList.stdout}\n${foreignHeadList.stderr}`);
  const foreignHeadOutput = JSON.parse(foreignHeadList.stdout);
  assert.equal(foreignHeadOutput.data.outcome.status, "internal_error");
  assert.match(foreignHeadOutput.blockers.join("\n"), /different Profile/iu);

  const cursorFixture = await makeDailySortFixture();
  const cursorEnv = dailySortEnv(cursorFixture);
  const cursorPlan = previewDailyPlan(cursorEnv);
  const cursorApply = spawnSync("node", [
    "dist/cli.js", "apply", cursorPlan.id, "--yes", "--expect-digest", cursorPlan.digest, "--json"
  ], { env: cursorEnv, encoding: "utf8" });
  assert.equal(cursorApply.status, 0, `${cursorApply.stdout}\n${cursorApply.stderr}`);
  const cursorBlockedApply = spawnSync("node", [
    "dist/cli.js", "apply", cursorPlan.id, "--yes", "--expect-digest", cursorPlan.digest, "--json"
  ], { env: cursorEnv, encoding: "utf8" });
  assert.equal(cursorBlockedApply.status, 2, `${cursorBlockedApply.stdout}\n${cursorBlockedApply.stderr}`);
  const cursorList = JSON.parse(spawnSync(
    "node", ["dist/cli.js", "apply", "list", "--limit", "1", "--json"], { env: cursorEnv, encoding: "utf8" }
  ).stdout);
  const directCursor = cursorList.data.history.nextCursor;
  assert.match(directCursor, /^ztsrh4\./);

  const forgedCursor = `${directCursor.slice(0, -1)}${directCursor.endsWith("0") ? "1" : "0"}`;
  const forged = spawnSync("node", [
    "dist/cli.js", "apply", "list", "--limit", "1", "--cursor", forgedCursor, "--json"
  ], { env: cursorEnv, encoding: "utf8" });
  assert.equal(forged.status, 1, `${forged.stdout}\n${forged.stderr}`);
  assert.equal(forged.stderr, "");
  assert.match(JSON.parse(forged.stdout).blockers.join("\n"), /cursor authentication is invalid/);

  const otherFixture = await makeDailySortFixture();
  const otherEnv = dailySortEnv(otherFixture);
  const otherPlan = previewDailyPlan(otherEnv);
  const otherApply = spawnSync("node", [
    "dist/cli.js", "apply", otherPlan.id, "--yes", "--expect-digest", otherPlan.digest, "--json"
  ], { env: otherEnv, encoding: "utf8" });
  assert.equal(otherApply.status, 0, `${otherApply.stdout}\n${otherApply.stderr}`);
  const crossProfile = spawnSync("node", [
    "dist/cli.js", "apply", "list", "--limit", "1", "--cursor", directCursor, "--json"
  ], { env: otherEnv, encoding: "utf8" });
  assert.equal(crossProfile.status, 1, `${crossProfile.stdout}\n${crossProfile.stderr}`);
  assert.equal(crossProfile.stderr, "");
  assert.match(JSON.parse(crossProfile.stdout).blockers.join("\n"), /another Profile/);
});

test("Receipt publication rejects oversized canonical content before touching its transaction artifacts", async () => {
  const fixture = await makeDailySortFixture();
  const env = dailySortEnv(fixture);
  const plan = previewDailyPlan(env);
  const apply = spawnSync("node", [
    "dist/cli.js", "apply", plan.id, "--yes", "--expect-digest", plan.digest, "--json"
  ], { env, encoding: "utf8" });
  assert.equal(apply.status, 0, `${apply.stdout}\n${apply.stderr}`);
  const receipt = JSON.parse(apply.stdout).data.receipt;
  const transactionSegment = receipt.id.slice("receipt:".length).replace(/[^A-Za-z0-9._-]+/gu, "-");
  const tree = await snapshotFileTree(fixture.stateDir);
  const transactionRootKey = Object.keys(tree).find((path) =>
    path.endsWith(`/transactions/${transactionSegment}/`)
  );
  assert.ok(transactionRootKey);

  const previous = new Map();
  for (const key of ["HOME", "PATH", "ZTS_ZEN_APP_SUPPORT_DIR", "ZTS_STATE_DIR", "ZTS_CONFIG_PATH"]) {
    previous.set(key, process.env[key]);
    process.env[key] = env[key];
  }
  try {
    const { readApplyArtifactLayout } = await import("../dist/apply-artifacts.js");
    const { publishApplyReceipt } = await import("../dist/apply-receipt-store.js");
    const layout = await readApplyArtifactLayout(plan.profileId);
    const oversized = {
      ...receipt,
      unexpectedPadding: "x".repeat((16 * 1024 * 1024) + 1)
    };
    await assert.rejects(
      () => publishApplyReceipt(
        layout,
        join(fixture.stateDir, transactionRootKey),
        oversized,
        { inversePlanReplayability: "bound_snapshot", causalSourceReceiptId: null, causalSourceReceiptDigest: null }
      ),
      /Apply Receipt exceeds the 16777216-byte write limit/
    );
    assert.deepEqual(await snapshotFileTree(fixture.stateDir), tree);
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("missing history plus missing transaction journal fails closed without implicit repair", async () => {
  const fixture = await makeDailySortFixture();
  const env = dailySortEnv(fixture);
  const plan = previewDailyPlan(env);
  const apply = spawnSync("node", [
    "dist/cli.js", "apply", plan.id, "--yes", "--expect-digest", plan.digest, "--json"
  ], { env, encoding: "utf8" });
  assert.equal(apply.status, 0, `${apply.stdout}\n${apply.stderr}`);
  const tree = await snapshotFileTree(fixture.stateDir);
  const historyDirectoryKey = Object.keys(tree).find((path) => path.endsWith("/receipt-history/"));
  const journalKey = Object.keys(tree).find((path) => path.includes("/transactions/") && path.endsWith("/journal.json"));
  assert.ok(historyDirectoryKey && journalKey);
  await rm(join(fixture.stateDir, historyDirectoryKey), { recursive: true });
  await rm(join(fixture.stateDir, journalKey));

  const list = spawnSync("node", ["dist/cli.js", "apply", "list", "--json"], { env, encoding: "utf8" });
  assert.equal(list.status, 2, `${list.stdout}\n${list.stderr}`);
  assert.equal(JSON.parse(list.stdout).data.outcome.status, "blocked");
  assert.match(JSON.parse(list.stdout).blockers.join("\n"), /no complete ready head.*migration is disabled/iu);
  const after = await snapshotFileTree(fixture.stateDir);
  const headKey = Object.keys(after).find((path) => path.endsWith("/receipt-history/head.json"));
  assert.equal(headKey, undefined, "failed migration must not publish a ready head");
  assert.equal(Object.keys(after).some((path) => path.endsWith(".node.json")), false);
});

test("missing history plus malformed transaction journal fails closed without implicit repair", async () => {
  const fixture = await makeDailySortFixture();
  const env = dailySortEnv(fixture);
  const plan = previewDailyPlan(env);
  const apply = spawnSync("node", [
    "dist/cli.js", "apply", plan.id, "--yes", "--expect-digest", plan.digest, "--json"
  ], { env, encoding: "utf8" });
  assert.equal(apply.status, 0, `${apply.stdout}\n${apply.stderr}`);
  const receipt = JSON.parse(apply.stdout).data.receipt;
  const tree = await snapshotFileTree(fixture.stateDir);
  const historyDirectoryKey = Object.keys(tree).find((path) => path.endsWith("/receipt-history/"));
  const journalKey = Object.keys(tree).find((path) => path.includes("/transactions/") && path.endsWith("/journal.json"));
  assert.ok(historyDirectoryKey && journalKey);
  await rm(join(fixture.stateDir, historyDirectoryKey), { recursive: true });
  await writeFile(join(fixture.stateDir, journalKey), `${JSON.stringify({
    transactionId: receipt.id.slice("receipt:".length),
    profileId: receipt.profileId
  })}\n`);

  const list = spawnSync("node", ["dist/cli.js", "apply", "list", "--json"], { env, encoding: "utf8" });
  assert.equal(list.status, 2, `${list.stdout}\n${list.stderr}`);
  assert.equal(JSON.parse(list.stdout).data.outcome.status, "blocked");
  assert.match(JSON.parse(list.stdout).blockers.join("\n"), /no complete ready head.*migration is disabled/iu);
  const after = await snapshotFileTree(fixture.stateDir);
  const headKey = Object.keys(after).find((path) => path.endsWith("/receipt-history/head.json"));
  assert.equal(headKey, undefined, "failed migration must not publish a ready head");
  assert.equal(Object.keys(after).some((path) => path.endsWith(".node.json")), false);
});

test("history pagination flags are rejected outside apply list without stack output", async () => {
  const fixture = await makeDailySortFixture();
  const env = dailySortEnv(fixture);
  const run = spawnSync(
    "node", ["dist/cli.js", "apply", "latest", "--limit", "1", "--json"], { env, encoding: "utf8" }
  );
  assert.equal(run.status, 1, `${run.stdout}\n${run.stderr}`);
  assert.equal(run.stderr, "");
  const output = JSON.parse(run.stdout);
  assert.equal(output.ok, false);
  assert.match(output.blockers.join("\n"), /only valid with zts apply list/);
});

test("saved Plan apply requires exact digest consent before creating a transaction", async () => {
  const fixture = await makeDailySortFixture();
  const env = dailySortEnv(fixture);
  const preview = spawnSync(
    "node",
    ["dist/cli.js", "sort", "--all", "--engine", "rules", "--preview", "--json"],
    { env, encoding: "utf8" }
  );
  assert.equal(preview.status, 0, `${preview.stdout}\n${preview.stderr}`);
  const before = await readFile(fixture.sessionPath);

  const missing = spawnSync("node", ["dist/cli.js", "apply", "latest", "--yes", "--json"], {
    env,
    encoding: "utf8"
  });
  assert.equal(missing.status, 1, `${missing.stdout}\n${missing.stderr}`);
  assert.match(JSON.parse(missing.stdout).blockers.join("\n"), /requires --expect-digest/);

  const wrong = spawnSync(
    "node",
    ["dist/cli.js", "apply", "latest", "--yes", "--expect-digest", `sha256:${"0".repeat(64)}`, "--json"],
    { env, encoding: "utf8" }
  );
  assert.equal(wrong.status, 1, `${wrong.stdout}\n${wrong.stderr}`);
  assert.match(JSON.parse(wrong.stdout).blockers.join("\n"), /does not match selected Plan/);
  assert.deepEqual(await readFile(fixture.sessionPath), before);
  await assert.rejects(() => readdir(join(fixture.stateDir, "apply-transactions")), /ENOENT/);
});

test("confirmed saved Plan apply fails the whole Plan on Snapshot Drift", async () => {
  const fixture = await makeDailySortFixture();
  const env = dailySortEnv(fixture);
  const preview = spawnSync(
    "node",
    ["dist/cli.js", "sort", "--all", "--engine", "rules", "--preview", "--json"],
    { env, encoding: "utf8" }
  );
  assert.equal(preview.status, 0, `${preview.stdout}\n${preview.stderr}`);
  const previewJson = JSON.parse(preview.stdout);
  const selected = previewJson.data.plan.actions.filter((action) => action.disposition === "move").slice(0, 2);
  const derive = spawnSync(
    "node",
    ["dist/cli.js", "apply", "latest", "--actions", selected.map((action) => action.actionId).join(","), "--json"],
    { env, encoding: "utf8" }
  );
  assert.equal(derive.status, 2, `${derive.stdout}\n${derive.stderr}`);
  const derivedPlan = JSON.parse(derive.stdout).data.plan;

  const drifted = await readJsonLz4(fixture.sessionPath);
  const firstNativeId = previewJson.data.snapshot.entities.find(
    (entity) => entity.ref === selected[0].operation.entityRef
  ).nativeId;
  drifted.tabs.find((tab) => tab.zenSyncId === firstNativeId).zenWorkspace = "w-stash";
  await writeJsonLz4(fixture.sessionPath, drifted);
  const beforeApply = await readFile(fixture.sessionPath);

  const apply = spawnSync(
    "node",
    ["dist/cli.js", "apply", derivedPlan.id, "--yes", "--expect-digest", derivedPlan.digest, "--json"],
    { env, encoding: "utf8" }
  );
  assert.equal(apply.status, 2, `${apply.stdout}\n${apply.stderr}`);
  assert.match(JSON.parse(apply.stdout).blockers.join("\n"), /exact Snapshot|bound to the supplied exact Snapshot/);
  assert.deepEqual(await readFile(fixture.sessionPath), beforeApply);
});

test("closed-session transaction refuses when Zen starts before confirmed apply", async () => {
  const fixture = await makeDailySortFixture();
  const env = dailySortEnv(fixture);
  const preview = spawnSync(
    "node",
    ["dist/cli.js", "sort", "--all", "--engine", "rules", "--preview", "--json"],
    { env, encoding: "utf8" }
  );
  assert.equal(preview.status, 0, `${preview.stdout}\n${preview.stderr}`);
  const plan = JSON.parse(preview.stdout).data.plan;
  const before = await readFile(fixture.sessionPath);
  await writeFile(
    join(fixture.binDir, "ps"),
    `#!/bin/sh\nprintf '%s\\n' '4242 /Applications/Zen.app/Contents/MacOS/zen --profile ${fixture.profilePath}'\n`
  );

  const apply = spawnSync(
    "node",
    ["dist/cli.js", "apply", plan.id, "--yes", "--expect-digest", plan.digest, "--json"],
    { env, encoding: "utf8" }
  );
  assert.equal(apply.status, 2, `${apply.stdout}\n${apply.stderr}`);
  assert.match(JSON.parse(apply.stdout).blockers.join("\n"), /Zen owns or may own the target Profile/);
  assert.deepEqual(await readFile(fixture.sessionPath), before);
});

test("pre-durability failure after an accepted swap stays unfinished until residue-bound recovery", async () => {
  const fixture = await makeDailySortFixture();
  const env = dailySortEnv(fixture);
  const plan = previewDailyPlan(env);
  const before = await readFile(fixture.sessionPath);
  const failed = failDailyApplyAtHook(env, plan, "afterRename");
  assert.notEqual(failed.status, 0, `${failed.stdout}\n${failed.stderr}`);
  assert.match(failed.stderr, /commit outcome is uncertain|requires zts apply recover/iu);
  assert.notDeepEqual(await readFile(fixture.sessionPath), before);

  const tree = await snapshotFileTree(fixture.stateDir);
  assert.equal(Object.keys(tree).some((path) => path.includes("/receipts/") && path.endsWith(".json")), false);
  assert.equal(Object.keys(tree).some((path) => path.includes("/unfinished/") && path.endsWith(".json") && !path.endsWith("index.json")), true);
  assert.equal((await readdir(fixture.profilePath)).filter((entry) => entry.endsWith(".jsonlz4.tmp")).length, 1);

  const listed = spawnSync("node", ["dist/cli.js", "apply", "recover", "--json"], { env, encoding: "utf8" });
  assert.equal(listed.status, 0, `${listed.stdout}\n${listed.stderr}`);
  const candidate = JSON.parse(listed.stdout).data.recoveries[0];
  assert.equal(candidate.classification, "planned_after_present");
  assert.ok(candidate.atomicResidue);
  assert.equal(candidate.terminalReceipt, null);

  const execute = executeRecovery(env, candidate);
  assert.equal(execute.status, 0, `${execute.stdout}\n${execute.stderr}`);
  const recovered = JSON.parse(execute.stdout).data;
  assert.equal(recovered.receipt.outcome, "applied");
  assert.equal(recovered.receipt.mutationAttempted, true);
  assert.equal(recovered.receipt.netChanged, true);
  assert.ok(recovered.receipt.inversePlanArtifact);
  assert.ok(recovered.receipt.operations.every((operation) => operation.status === "verified"));
  assert.equal(recovered.sessionMutated, false);
  assert.equal((await readdir(fixture.profilePath)).some((entry) => entry.endsWith(".jsonlz4.tmp")), false);

  const undo = spawnSync("node", ["dist/cli.js", "undo", recovered.receipt.id, "--preview", "--json"], {
    env, encoding: "utf8"
  });
  assert.equal(undo.status, 0, `${undo.stdout}\n${undo.stderr}`);
  assert.equal(JSON.parse(undo.stdout).data.inspection.eligible, true);
});

test("final directory-sync failure without residue stays unfinished until exact after-state recovery", async () => {
  const fixture = await makeDailySortFixture();
  const env = dailySortEnv(fixture);
  const plan = previewDailyPlan(env);
  const before = await readFile(fixture.sessionPath);
  const failed = failDailyApplyAtHook(env, plan, "beforeFinalDirectorySync");
  assert.notEqual(failed.status, 0, `${failed.stdout}\n${failed.stderr}`);
  assert.match(failed.stderr, /commit outcome is uncertain|requires zts apply recover/iu);
  assert.notDeepEqual(await readFile(fixture.sessionPath), before);
  assert.equal((await readdir(fixture.profilePath)).some((entry) => entry.endsWith(".jsonlz4.tmp")), false);

  const tree = await snapshotFileTree(fixture.stateDir);
  assert.equal(Object.keys(tree).some((path) => path.includes("/receipts/") && path.endsWith(".json")), false);
  assert.equal(Object.keys(tree).some((path) => path.includes("/unfinished/") && path.endsWith(".json") && !path.endsWith("index.json")), true);

  const listed = spawnSync("node", ["dist/cli.js", "apply", "recover", "--json"], { env, encoding: "utf8" });
  assert.equal(listed.status, 0, `${listed.stdout}\n${listed.stderr}`);
  const candidate = JSON.parse(listed.stdout).data.recoveries[0];
  assert.equal(candidate.classification, "planned_after_present");
  assert.equal(candidate.atomicResidue, null);
  assert.equal(candidate.terminalReceipt, null);

  const execute = executeRecovery(env, candidate);
  assert.equal(execute.status, 0, `${execute.stdout}\n${execute.stderr}`);
  const recovered = JSON.parse(execute.stdout).data;
  assert.equal(recovered.receipt.outcome, "applied");
  assert.equal(recovered.receipt.mutationAttempted, true);
  assert.equal(recovered.receipt.netChanged, true);
  assert.ok(recovered.receipt.inversePlanArtifact);
  assert.ok(recovered.receipt.operations.every((operation) => operation.status === "verified"));
  assert.equal(recovered.sessionMutated, false);
  assert.deepEqual(JSON.parse(spawnSync(
    "node", ["dist/cli.js", "apply", "recover", "--json"], { env, encoding: "utf8" }
  ).stdout).data.recoveries, []);
});

test("hard-crash recovery is inspect-first, finalizes an exact Receipt, and releases only its stale lock", async () => {
  const fixture = await makeDailySortFixture();
  const env = dailySortEnv(fixture);
  const preview = spawnSync(
    "node",
    ["dist/cli.js", "sort", "--all", "--engine", "rules", "--preview", "--json"],
    { env, encoding: "utf8" }
  );
  assert.equal(preview.status, 0, `${preview.stdout}\n${preview.stderr}`);
  const plan = JSON.parse(preview.stdout).data.plan;
  const crashScript = [
    'import { discoverProfileContext } from "./dist/profile.js";',
    'import { loadStoredPlan } from "./dist/plans.js";',
    'import { applyStoredPlanClosedSession } from "./dist/apply-transaction.js";',
    "const context = await discoverProfileContext();",
    `const stored = await loadStoredPlan(context.profile.id, ${JSON.stringify(plan.id)});`,
    "await applyStoredPlanClosedSession(context, stored, {",
    `  expectedDigest: ${JSON.stringify(plan.digest)},`,
    '  command: "fixture hard crash after commit",',
    "  afterCommit: () => process.exit(86)",
    "});"
  ].join("\n");
  const crashed = spawnSync("node", ["--input-type=module", "--eval", crashScript], {
    cwd: process.cwd(),
    env,
    encoding: "utf8"
  });
  assert.equal(crashed.status, 86, `${crashed.stdout}\n${crashed.stderr}`);
  const committedSession = await readFile(fixture.sessionPath);

  const beforeListTree = await snapshotFileTree(fixture.stateDir);
  const list = spawnSync("node", ["dist/cli.js", "apply", "recover", "--json"], { env, encoding: "utf8" });
  assert.equal(list.status, 0, `${list.stdout}\n${list.stderr}`);
  const listJson = JSON.parse(list.stdout);
  assert.equal(listJson.data.recoveries.length, 1);
  const recovery = listJson.data.recoveries[0];
  assert.equal(recovery.classification, "planned_after_present");
  assert.equal(recovery.lock.status, "stale");
  assert.equal(recovery.terminalReceipt, null);
  assert.deepEqual(await snapshotFileTree(fixture.stateDir), beforeListTree);
  assert.deepEqual(await readFile(fixture.sessionPath), committedSession);

  const inspect = spawnSync(
    "node",
    ["dist/cli.js", "apply", "recover", recovery.transactionId, "--json"],
    { env, encoding: "utf8" }
  );
  assert.equal(inspect.status, 0, `${inspect.stdout}\n${inspect.stderr}`);
  const inspectJson = JSON.parse(inspect.stdout);
  assert.equal(inspectJson.ok, true);
  assert.equal(inspectJson.data.inspection.recoverable, true);
  assert.equal(inspectJson.blockers.length, 0);
  assert.match(inspectJson.suggestedNextCommands[0], /--expect-recovery-digest sha256:/);
  assert.deepEqual(await snapshotFileTree(fixture.stateDir), beforeListTree);

  const missingDigest = spawnSync(
    "node",
    ["dist/cli.js", "apply", "recover", recovery.transactionId, "--yes", "--json"],
    { env, encoding: "utf8" }
  );
  assert.equal(missingDigest.status, 2, `${missingDigest.stdout}\n${missingDigest.stderr}`);
  assert.match(JSON.parse(missingDigest.stdout).blockers.join("\n"), /requires --expect-recovery-digest/);
  assert.deepEqual(await snapshotFileTree(fixture.stateDir), beforeListTree);

  const wrongDigest = spawnSync(
    "node",
    [
      "dist/cli.js",
      "apply",
      "recover",
      recovery.transactionId,
      "--yes",
      "--expect-recovery-digest",
      `sha256:${"0".repeat(64)}`,
      "--json"
    ],
    { env, encoding: "utf8" }
  );
  assert.equal(wrongDigest.status, 2, `${wrongDigest.stdout}\n${wrongDigest.stderr}`);
  assert.match(JSON.parse(wrongDigest.stdout).blockers.join("\n"), /does not match current inspection/);
  assert.deepEqual(await snapshotFileTree(fixture.stateDir), beforeListTree);

  const execute = spawnSync(
    "node",
    [
      "dist/cli.js",
      "apply",
      "recover",
      recovery.transactionId,
      "--yes",
      "--expect-recovery-digest",
      recovery.recoveryRevision,
      "--json"
    ],
    { env, encoding: "utf8" }
  );
  assert.equal(execute.status, 0, `${execute.stdout}\n${execute.stderr}`);
  const executeJson = JSON.parse(execute.stdout);
  assert.equal(executeJson.ok, true);
  assert.equal(executeJson.data.recoveryRecorded, true);
  assert.equal(executeJson.data.sessionMutated, false);
  assert.equal(executeJson.data.staleLockReleased, true);
  assert.equal(executeJson.data.receipt.outcome, "applied");
  assert.equal(executeJson.data.receipt.mutationAttempted, true);
  assert.equal(executeJson.data.receipt.netChanged, true);
  assert.ok(executeJson.data.receipt.operations.every((operation) => operation.status === "verified"));
  assert.deepEqual(await readFile(fixture.sessionPath), committedSession);

  const after = spawnSync("node", ["dist/cli.js", "apply", "recover", "--json"], { env, encoding: "utf8" });
  assert.equal(after.status, 0, `${after.stdout}\n${after.stderr}`);
  assert.equal(JSON.parse(after.stdout).data.recoveries.length, 0);
  assert.deepEqual(await readdir(join(fixture.stateDir, "locks")), []);

  const repeated = spawnSync(
    "node",
    [
      "dist/cli.js",
      "apply",
      "recover",
      recovery.transactionId,
      "--yes",
      "--expect-recovery-digest",
      JSON.parse(spawnSync(
        "node",
        ["dist/cli.js", "apply", "recover", recovery.transactionId, "--json"],
        { env, encoding: "utf8" }
      ).stdout).data.inspection.recoveryRevision,
      "--json"
    ],
    { env, encoding: "utf8" }
  );
  assert.equal(repeated.status, 0, `${repeated.stdout}\n${repeated.stderr}`);
  const repeatedJson = JSON.parse(repeated.stdout);
  assert.equal(repeatedJson.data.alreadyComplete, true);
  assert.equal(repeatedJson.data.receipt.id, executeJson.data.receipt.id);
});

test("hard-crash recovery refuses applied classification after config-derived Protection drift", async () => {
  const fixture = await makeDailySortFixture();
  const env = dailySortEnv(fixture);
  const plan = previewDailyPlan(env);
  assert.equal(crashDailyApply(env, plan, "afterCommit", 86).status, 86);
  const committedSession = await readFile(fixture.sessionPath);

  const config = await readFile(fixture.configPath, "utf8");
  assert.match(config, /never_move = \[\]/u);
  await writeFile(
    fixture.configPath,
    config.replace('never_move = []', 'never_move = ["github.com"]'),
    { mode: 0o600 }
  );

  const list = spawnSync("node", ["dist/cli.js", "apply", "recover", "--json"], { env, encoding: "utf8" });
  assert.equal(list.status, 0, `${list.stdout}\n${list.stderr}`);
  const candidate = JSON.parse(list.stdout).data.recoveries[0];
  assert.equal(candidate.classification, "planned_after_present");

  const execute = executeRecovery(env, candidate);
  assert.equal(execute.status, 0, `${execute.stdout}\n${execute.stderr}`);
  const data = JSON.parse(execute.stdout).data;
  assert.equal(data.receipt.outcome, "interrupted");
  assert.equal(data.receipt.afterSnapshotRevision, null);
  assert.equal(data.receipt.inversePlanArtifact, null);
  assert.equal(data.receipt.issues[0].code, "hard_crash_state_uncertain");
  assert.deepEqual(await readFile(fixture.sessionPath), committedSession);
});

test("hard crash before rename recovers as not attempted without changing the session", async () => {
  const fixture = await makeDailySortFixture();
  const env = dailySortEnv(fixture);
  const preview = spawnSync(
    "node",
    ["dist/cli.js", "sort", "--all", "--engine", "rules", "--preview", "--json"],
    { env, encoding: "utf8" }
  );
  assert.equal(preview.status, 0, `${preview.stdout}\n${preview.stderr}`);
  const plan = JSON.parse(preview.stdout).data.plan;
  const before = await readFile(fixture.sessionPath);
  const crashScript = [
    'import { discoverProfileContext } from "./dist/profile.js";',
    'import { loadStoredPlan } from "./dist/plans.js";',
    'import { applyStoredPlanClosedSession } from "./dist/apply-transaction.js";',
    "const context = await discoverProfileContext();",
    `const stored = await loadStoredPlan(context.profile.id, ${JSON.stringify(plan.id)});`,
    "await applyStoredPlanClosedSession(context, stored, {",
    `  expectedDigest: ${JSON.stringify(plan.digest)},`,
    '  command: "fixture hard crash before rename",',
    "  beforeCommit: () => process.exit(85)",
    "});"
  ].join("\n");
  const crashed = spawnSync("node", ["--input-type=module", "--eval", crashScript], {
    cwd: process.cwd(),
    env,
    encoding: "utf8"
  });
  assert.equal(crashed.status, 85, `${crashed.stdout}\n${crashed.stderr}`);
  assert.deepEqual(await readFile(fixture.sessionPath), before);
  const preparedTemps = (await readdir(fixture.profilePath)).filter((entry) => entry.endsWith(".jsonlz4.tmp"));
  assert.equal(preparedTemps.length, 1);
  assert.equal((await stat(join(fixture.profilePath, preparedTemps[0]))).mode & 0o777, 0o600);

  const list = spawnSync("node", ["dist/cli.js", "apply", "recover", "--json"], { env, encoding: "utf8" });
  assert.equal(list.status, 0, `${list.stdout}\n${list.stderr}`);
  const candidate = JSON.parse(list.stdout).data.recoveries[0];
  assert.equal(candidate.journalStage, "write_prepared");
  assert.equal(candidate.classification, "before_state_present");
  assert.equal(candidate.lock.status, "stale");

  const afterPreserve = crashApplyRecovery(env, candidate, "afterTemporaryPreserved", 83);
  assert.equal(afterPreserve.status, 83, `${afterPreserve.stdout}\n${afterPreserve.stderr}`);
  assert.equal((await readdir(fixture.profilePath)).some((entry) => entry.endsWith(".jsonlz4.tmp")), true);
  const preservedList = spawnSync("node", ["dist/cli.js", "apply", "recover", "--json"], { env, encoding: "utf8" });
  assert.equal(preservedList.status, 0, `${preservedList.stdout}\n${preservedList.stderr}`);
  const preserved = JSON.parse(preservedList.stdout).data.recoveries[0];
  assert.equal(preserved.journalStage, "recovery_temporary_preserved");

  const afterUnlink = crashApplyRecovery(env, preserved, "afterTemporaryUnlinked", 82);
  assert.equal(afterUnlink.status, 82, `${afterUnlink.stdout}\n${afterUnlink.stderr}`);
  assert.equal((await readdir(fixture.profilePath)).some((entry) => entry.endsWith(".jsonlz4.tmp")), false);
  const unlinkedList = spawnSync("node", ["dist/cli.js", "apply", "recover", "--json"], { env, encoding: "utf8" });
  assert.equal(unlinkedList.status, 0, `${unlinkedList.stdout}\n${unlinkedList.stderr}`);
  const unlinked = JSON.parse(unlinkedList.stdout).data.recoveries[0];
  assert.equal(unlinked.journalStage, "recovery_temporary_preserved");

  const execute = spawnSync(
    "node",
    [
      "dist/cli.js",
      "apply",
      "recover",
      unlinked.transactionId,
      "--yes",
      "--expect-recovery-digest",
      unlinked.recoveryRevision,
      "--json"
    ],
    { env, encoding: "utf8" }
  );
  assert.equal(execute.status, 0, `${execute.stdout}\n${execute.stderr}`);
  const executeData = JSON.parse(execute.stdout).data;
  const receipt = executeData.receipt;
  assert.equal(receipt.outcome, "interrupted");
  assert.equal(receipt.mutationAttempted, false);
  assert.equal(receipt.netChanged, false);
  assert.ok(receipt.operations.every((operation) => operation.status === "not_attempted"));
  assert.ok(executeData.artifacts.some((artifact) => artifact.kind === "prepared_image"));
  assert.equal((await readdir(fixture.profilePath)).some((entry) => entry.endsWith(".jsonlz4.tmp")), false);
  assert.deepEqual(await readFile(fixture.sessionPath), before);
  assert.deepEqual(await readdir(join(fixture.stateDir, "locks")), []);
});

test("crash after write intent but before temp creation is recoverable without orphan state", async () => {
  const fixture = await makeDailySortFixture();
  const env = dailySortEnv(fixture);
  const plan = previewDailyPlan(env);
  const before = await readFile(fixture.sessionPath);
  assert.equal(crashDailyApply(env, plan, "afterWriteIntent", 81).status, 81);
  assert.deepEqual(await readFile(fixture.sessionPath), before);
  assert.equal((await readdir(fixture.profilePath)).some((entry) => entry.endsWith(".jsonlz4.tmp")), false);

  const list = spawnSync("node", ["dist/cli.js", "apply", "recover", "--json"], { env, encoding: "utf8" });
  assert.equal(list.status, 0, `${list.stdout}\n${list.stderr}`);
  const candidate = JSON.parse(list.stdout).data.recoveries[0];
  assert.equal(candidate.journalStage, "write_prepared");
  assert.equal(candidate.classification, "before_state_present");
  const execute = executeRecovery(env, candidate);
  assert.equal(execute.status, 0, `${execute.stdout}\n${execute.stderr}`);
  const data = JSON.parse(execute.stdout).data;
  assert.equal(data.receipt.mutationAttempted, false);
  assert.equal(data.artifacts.some((artifact) => artifact.kind.startsWith("prepared_")), false);
  assert.deepEqual(await readFile(fixture.sessionPath), before);
});

test("crash during temp creation preserves an incomplete fragment before cleanup", async () => {
  const fixture = await makeDailySortFixture();
  const env = dailySortEnv(fixture);
  const plan = previewDailyPlan(env);
  const before = await readFile(fixture.sessionPath);
  assert.equal(crashDailyApply(env, plan, "afterTemporaryCreated", 80).status, 80);
  assert.deepEqual(await readFile(fixture.sessionPath), before);
  assert.equal((await readdir(fixture.profilePath)).filter((entry) => entry.endsWith(".jsonlz4.tmp")).length, 1);

  const list = spawnSync("node", ["dist/cli.js", "apply", "recover", "--json"], { env, encoding: "utf8" });
  assert.equal(list.status, 0, `${list.stdout}\n${list.stderr}`);
  const execute = executeRecovery(env, JSON.parse(list.stdout).data.recoveries[0]);
  assert.equal(execute.status, 0, `${execute.stdout}\n${execute.stderr}`);
  const data = JSON.parse(execute.stdout).data;
  assert.equal(data.receipt.mutationAttempted, false);
  assert.ok(data.artifacts.some((artifact) => artifact.kind === "prepared_fragment"));
  assert.equal((await readdir(fixture.profilePath)).some((entry) => entry.endsWith(".jsonlz4.tmp")), false);
  assert.deepEqual(await readFile(fixture.sessionPath), before);
});

test("hard-crash recovery refuses while Zen may own the Profile and preserves the stale lock", async () => {
  const fixture = await makeDailySortFixture();
  const env = dailySortEnv(fixture);
  const preview = spawnSync(
    "node",
    ["dist/cli.js", "sort", "--all", "--engine", "rules", "--preview", "--json"],
    { env, encoding: "utf8" }
  );
  assert.equal(preview.status, 0, `${preview.stdout}\n${preview.stderr}`);
  const plan = JSON.parse(preview.stdout).data.plan;
  const crashScript = [
    'import { discoverProfileContext } from "./dist/profile.js";',
    'import { loadStoredPlan } from "./dist/plans.js";',
    'import { applyStoredPlanClosedSession } from "./dist/apply-transaction.js";',
    "const context = await discoverProfileContext();",
    `const stored = await loadStoredPlan(context.profile.id, ${JSON.stringify(plan.id)});`,
    "await applyStoredPlanClosedSession(context, stored, {",
    `  expectedDigest: ${JSON.stringify(plan.digest)},`,
    '  command: "fixture crash before Zen restart",',
    "  afterCommit: () => process.exit(84)",
    "});"
  ].join("\n");
  const crashed = spawnSync("node", ["--input-type=module", "--eval", crashScript], {
    cwd: process.cwd(), env, encoding: "utf8"
  });
  assert.equal(crashed.status, 84, `${crashed.stdout}\n${crashed.stderr}`);
  await writeFile(
    join(fixture.binDir, "ps"),
    `#!/bin/sh\nprintf '%s\\n' '4242 /Applications/Zen.app/Contents/MacOS/zen --profile ${fixture.profilePath}'\n`
  );
  const before = await snapshotFileTree(fixture.stateDir);
  const list = spawnSync("node", ["dist/cli.js", "apply", "recover", "--json"], { env, encoding: "utf8" });
  assert.equal(list.status, 0, `${list.stdout}\n${list.stderr}`);
  const candidate = JSON.parse(list.stdout).data.recoveries[0];
  assert.equal(candidate.classification, "blocked_zen_running");
  assert.equal(candidate.lock.status, "stale");
  assert.equal(candidate.recoverable, false);
  assert.deepEqual(await snapshotFileTree(fixture.stateDir), before);

  const execute = spawnSync(
    "node",
    [
      "dist/cli.js",
      "apply",
      "recover",
      candidate.transactionId,
      "--yes",
      "--expect-recovery-digest",
      candidate.recoveryRevision,
      "--json"
    ],
    { env, encoding: "utf8" }
  );
  assert.equal(execute.status, 2, `${execute.stdout}\n${execute.stderr}`);
  assert.match(JSON.parse(execute.stdout).blockers.join("\n"), /requires Zen to be closed/);
  assert.deepEqual(await snapshotFileTree(fixture.stateDir), before);
  assert.equal((await readdir(join(fixture.stateDir, "locks"))).length, 1);
});

test("exact prepared residue proves external Drift happened before commit and records Operations not attempted", async () => {
  const fixture = await makeDailySortFixture();
  const env = dailySortEnv(fixture);
  const plan = previewDailyPlan(env);
  assert.equal(crashDailyApply(env, plan, "beforeCommit", 81).status, 81);
  const drifted = await readJsonLz4(fixture.sessionPath);
  drifted.externalDriftMarker = "changed outside zts before commit proof";
  await writeJsonLz4(fixture.sessionPath, drifted);
  const driftedBytes = await readFile(fixture.sessionPath);

  const list = spawnSync("node", ["dist/cli.js", "apply", "recover", "--json"], { env, encoding: "utf8" });
  assert.equal(list.status, 0, `${list.stdout}\n${list.stderr}`);
  const candidate = JSON.parse(list.stdout).data.recoveries[0];
  assert.equal(candidate.classification, "external_drift");
  assert.equal(candidate.recoverable, true);
  assert.deepEqual(candidate.blockers, []);

  const execute = executeRecovery(env, candidate);
  assert.equal(execute.status, 0, `${execute.stdout}\n${execute.stderr}`);
  const data = JSON.parse(execute.stdout).data;
  assert.equal(data.receipt.outcome, "interrupted");
  assert.equal(data.receipt.mutationAttempted, false);
  assert.equal(data.receipt.netChanged, false);
  assert.equal(data.receipt.issues[0].code, "hard_crash_external_drift_before_commit");
  assert.ok(data.receipt.operations.every((operation) =>
    operation.status === "not_attempted"
    && operation.issueCodes.includes("hard_crash_external_drift_before_commit")
  ));
  assert.deepEqual(await readFile(fixture.sessionPath), driftedBytes);
  assert.equal((await readdir(join(fixture.stateDir, "locks"))).length, 0);
});

test("a crash after inverse publication remains a before-state recovery with no Receipt-bound inverse", async () => {
  const fixture = await makeDailySortFixture();
  const env = dailySortEnv(fixture);
  const plan = previewDailyPlan(env);
  const before = await readFile(fixture.sessionPath);
  assert.equal(crashDailyApply(env, plan, "beforeCommit", 82).status, 82);

  const list = spawnSync("node", ["dist/cli.js", "apply", "recover", "--json"], {
    env,
    encoding: "utf8"
  });
  assert.equal(list.status, 0, `${list.stdout}\n${list.stderr}`);
  const candidate = JSON.parse(list.stdout).data.recoveries[0];
  assert.equal(candidate.classification, "before_state_present");
  assert.equal(candidate.recoverable, true);
  const journal = JSON.parse(await readFile(candidate.journalPath, "utf8"));
  const preflight = journal.history.find((entry) => entry.stage === "preflight_ok");
  assert.ok(preflight?.evidence.inversePlanArtifact);
  const inversePath = Object.keys(await snapshotFileTree(fixture.stateDir)).find((path) =>
    path.endsWith(`/inverse-plans/${preflight.evidence.inversePlanArtifact.digest.slice("sha256:".length)}.json`)
  );
  assert.ok(inversePath);

  const execute = executeRecovery(env, candidate);
  assert.equal(execute.status, 0, `${execute.stdout}\n${execute.stderr}`);
  const data = JSON.parse(execute.stdout).data;
  assert.equal(data.receipt.outcome, "interrupted");
  assert.equal(data.receipt.mutationAttempted, false);
  assert.equal(data.receipt.inversePlanArtifact, null);
  assert.ok(data.artifacts.some((artifact) =>
    artifact.kind === "inverse_plan"
    && artifact.id === preflight.evidence.inversePlanArtifact.id
    && artifact.digest === preflight.evidence.inversePlanArtifact.digest
  ));
  assert.deepEqual(await readFile(fixture.sessionPath), before);
});

test("recovery records unknown operation results after proven commit plus external Drift", async () => {
  const fixture = await makeDailySortFixture();
  const env = dailySortEnv(fixture);
  const plan = previewDailyPlan(env);
  assert.equal(crashDailyApply(env, plan, "afterCommit", 80).status, 80);
  const drifted = await readJsonLz4(fixture.sessionPath);
  drifted.externalDriftMarker = "changed outside zts after commit";
  await writeJsonLz4(fixture.sessionPath, drifted);
  const driftedBytes = await readFile(fixture.sessionPath);

  const list = spawnSync("node", ["dist/cli.js", "apply", "recover", "--json"], { env, encoding: "utf8" });
  assert.equal(list.status, 0, `${list.stdout}\n${list.stderr}`);
  const candidate = JSON.parse(list.stdout).data.recoveries[0];
  assert.equal(candidate.classification, "external_drift");
  assert.equal(candidate.recoverable, true);

  const execute = executeRecovery(env, candidate);
  assert.equal(execute.status, 0, `${execute.stdout}\n${execute.stderr}`);
  const data = JSON.parse(execute.stdout).data;
  assert.equal(data.receipt.outcome, "interrupted");
  assert.equal(data.receipt.mutationAttempted, true);
  assert.equal(data.receipt.netChanged, null);
  assert.ok(data.receipt.operations.every((operation) =>
    operation.status === "failed"
    && operation.netChanged === null
    && operation.issueCodes.includes("hard_crash_external_drift")
  ));
  assert.equal(data.staleLockReleased, true);
  assert.deepEqual(await readFile(fixture.sessionPath), driftedBytes);
});

test("a dead recovery claim is superseded without duplicating its terminal Receipt", async () => {
  const fixture = await makeDailySortFixture();
  const env = dailySortEnv(fixture);
  const plan = previewDailyPlan(env);
  assert.equal(crashDailyApply(env, plan, "afterCommit", 79).status, 79);
  const initialList = spawnSync("node", ["dist/cli.js", "apply", "recover", "--json"], { env, encoding: "utf8" });
  assert.equal(initialList.status, 0, `${initialList.stdout}\n${initialList.stderr}`);
  const initial = JSON.parse(initialList.stdout).data.recoveries[0];
  const recoveryCrashScript = [
    'import { discoverProfileContext } from "./dist/profile.js";',
    'import { recoverApplyTransaction } from "./dist/apply-recovery.js";',
    "const context = await discoverProfileContext();",
    `await recoverApplyTransaction(context, ${JSON.stringify(initial.transactionId)}, {`,
    `  expectedRecoveryRevision: ${JSON.stringify(initial.recoveryRevision)},`,
    "  afterReceipt: () => process.exit(78)",
    "});"
  ].join("\n");
  const recoveryCrash = spawnSync("node", ["--input-type=module", "--eval", recoveryCrashScript], {
    cwd: process.cwd(), env, encoding: "utf8"
  });
  assert.equal(recoveryCrash.status, 78, `${recoveryCrash.stdout}\n${recoveryCrash.stderr}`);

  const afterCrash = spawnSync("node", ["dist/cli.js", "apply", "recover", "--json"], { env, encoding: "utf8" });
  assert.equal(afterCrash.status, 0, `${afterCrash.stdout}\n${afterCrash.stderr}`);
  const candidate = JSON.parse(afterCrash.stdout).data.recoveries[0];
  assert.equal(candidate.terminalReceipt.outcome, "applied");
  assert.equal(candidate.terminalReceipt.control.exclusiveControlReleased, "verified");
  assert.equal(candidate.lock.status, "absent");
  assert.equal(candidate.recoveryClaim.status, "stale");
  assert.equal(candidate.recoverable, true);

  const releaseWitness = join(fixture.temp, "terminal-recovery-release.json");
  const finalizeScript = [
    'import { writeFile } from "node:fs/promises";',
    'import { join } from "node:path";',
    'import { discoverProfileContext } from "./dist/profile.js";',
    'import { recoverApplyTransaction } from "./dist/apply-recovery.js";',
    'import { acquireExclusiveFileControl } from "./dist/exclusive-control.js";',
    'import { inspectProfileTransactionLock } from "./dist/profile-lock.js";',
    "const context = await discoverProfileContext();",
    `const result = await recoverApplyTransaction(context, ${JSON.stringify(candidate.transactionId)}, {`,
    `  expectedRecoveryRevision: ${JSON.stringify(candidate.recoveryRevision)},`,
    "  afterControlReleased: async () => {",
    '    const native = await acquireExclusiveFileControl(join(context.profile.path, ".parentlock"), "terminal recovery release witness", { timeoutSeconds: 0, fileKind: "native_profile" });',
    "    await native.release();",
    "    const ztsLock = await inspectProfileTransactionLock(context.profile);",
    '    if (ztsLock.status !== "absent") throw new Error(`zts Profile lock remained ${ztsLock.status}`);',
    `    await writeFile(${JSON.stringify(releaseWitness)}, JSON.stringify({ nativeAvailable: true, ztsLock: ztsLock.status }));`,
    "  }",
    "});",
    "process.stdout.write(JSON.stringify(result));"
  ].join("\n");
  const execute = spawnSync("node", ["--input-type=module", "--eval", finalizeScript], {
    cwd: process.cwd(), env, encoding: "utf8"
  });
  assert.equal(execute.status, 0, `${execute.stdout}\n${execute.stderr}`);
  const data = JSON.parse(execute.stdout);
  assert.equal(data.alreadyComplete, true);
  assert.equal(data.staleLockReleased, false);
  assert.equal(data.receipt.id, candidate.terminalReceipt.id);
  assert.deepEqual(JSON.parse(await readFile(releaseWitness, "utf8")), {
    nativeAvailable: true,
    ztsLock: "absent"
  });
  const tree = await snapshotFileTree(fixture.stateDir);
  assert.equal(Object.keys(tree).filter((path) => path.includes("/receipts/") && path.endsWith(".json")).length, 1);
  assert.equal(Object.keys(tree).some((path) => path.endsWith("recovery-claim.json")), false);
  const beforeRepeatedAccounting = assertExactApplyStoreAccounting(tree);

  const repeatedInspectionRun = spawnSync(
    "node",
    ["dist/cli.js", "apply", "recover", candidate.transactionId, "--json"],
    { env, encoding: "utf8" }
  );
  assert.equal(
    repeatedInspectionRun.status,
    0,
    `${repeatedInspectionRun.stdout}\n${repeatedInspectionRun.stderr}`
  );
  const repeatedInspection = JSON.parse(repeatedInspectionRun.stdout).data.inspection;
  const repeated = executeRecovery(env, repeatedInspection);
  assert.equal(repeated.status, 0, `${repeated.stdout}\n${repeated.stderr}`);
  assert.equal(JSON.parse(repeated.stdout).data.alreadyComplete, true);

  const afterRepeatedTree = await snapshotFileTree(fixture.stateDir);
  assert.equal(
    Object.keys(afterRepeatedTree).filter((path) =>
      path.includes("/receipts/") && path.endsWith(".json")
    ).length,
    1
  );
  assert.equal(
    Object.keys(afterRepeatedTree).some((path) => path.endsWith("recovery-claim.json")),
    false
  );
  assert.deepEqual(assertExactApplyStoreAccounting(afterRepeatedTree), beforeRepeatedAccounting);
});

test("a crash immediately after Profile lock acquisition remains discoverable and recoverable", async () => {
  const fixture = await makeDailySortFixture();
  const env = dailySortEnv(fixture);
  const plan = previewDailyPlan(env);
  const before = await readFile(fixture.sessionPath);
  assert.equal(crashDailyApply(env, plan, "afterLock", 77).status, 77);

  const list = spawnSync("node", ["dist/cli.js", "apply", "recover", "--json"], { env, encoding: "utf8" });
  assert.equal(list.status, 0, `${list.stdout}\n${list.stderr}`);
  const candidate = JSON.parse(list.stdout).data.recoveries[0];
  assert.equal(candidate.journalStage, "initialized");
  assert.equal(candidate.classification, "before_state_present");
  assert.equal(candidate.lock.status, "stale");
  assert.equal(candidate.lock.transactionId, candidate.transactionId);

  const execute = executeRecovery(env, candidate);
  assert.equal(execute.status, 0, `${execute.stdout}\n${execute.stderr}`);
  const data = JSON.parse(execute.stdout).data;
  assert.equal(data.receipt.mutationAttempted, false);
  assert.equal(data.receipt.netChanged, false);
  assert.equal(data.receipt.control.exclusiveControlReleased, "verified");
  assert.ok(data.receipt.operations.every((operation) => operation.status === "not_attempted"));
  assert.equal(data.staleLockReleased, true);
  const stateTree = await snapshotFileTree(fixture.stateDir);
  const controlKey = Object.keys(stateTree).find((path) => path.endsWith(
    `/controls/${data.receipt.control.proof.digest.slice("sha256:".length)}.json`
  ));
  const journalKey = Object.keys(stateTree).find((path) => path.endsWith(
    `/journals/${data.receipt.journalArtifact.digest.slice("sha256:".length)}.json`
  ));
  assert.ok(controlKey && journalKey);
  const controlProof = JSON.parse(await readFile(join(fixture.stateDir, controlKey), "utf8"));
  const immutableJournal = JSON.parse(await readFile(join(fixture.stateDir, journalKey), "utf8"));
  assert.equal(controlProof.exclusiveControlReleased, "verified");
  assert.equal(controlProof.nativeProfileControl.released, true);
  assert.ok(
    controlProof.ztsProfileControl.staleLockReleased
    || controlProof.ztsProfileControl.recoveryLockReleased
  );
  assert.equal(immutableJournal.stage, "recovery_receipt_prepared");
  assert.deepEqual(
    immutableJournal.history.at(-1).evidence.controlArtifact,
    data.receipt.control.proof
  );
  assert.deepEqual(await readFile(fixture.sessionPath), before);
});

test("uncertain native-control release leaves no terminal Receipt and recovery publishes verified closure", async () => {
  const fixture = await makeDailySortFixture();
  const env = dailySortEnv(fixture);
  const plan = previewDailyPlan(env);
  const script = [
    'import { rename, writeFile } from "node:fs/promises";',
    'import { join } from "node:path";',
    'import { discoverProfileContext } from "./dist/profile.js";',
    'import { loadStoredPlan } from "./dist/plans.js";',
    'import { applyStoredPlanClosedSession } from "./dist/apply-transaction.js";',
    'const context = await discoverProfileContext();',
    `const stored = await loadStoredPlan(context.profile.id, ${JSON.stringify(plan.id)});`,
    'await applyStoredPlanClosedSession(context, stored, {',
    `  expectedDigest: ${JSON.stringify(plan.digest)},`,
    '  command: "fixture uncertain native release",',
    '  afterCommit: async () => {',
    '    const canonical = join(context.profile.path, ".parentlock");',
    '    await rename(canonical, join(context.profile.path, ".parentlock-displaced"));',
    '    await writeFile(canonical, "", { mode: 0o600 });',
    '  }',
    '});'
  ].join("\n");
  const failed = spawnSync("node", ["--input-type=module", "--eval", script], {
    cwd: process.cwd(), env, encoding: "utf8"
  });
  assert.notEqual(failed.status, 0, `${failed.stdout}\n${failed.stderr}`);
  assert.match(failed.stderr, /control release is uncertain|requires zts apply recover/iu);

  const beforeRecoveryTree = await snapshotFileTree(fixture.stateDir);
  assert.equal(
    Object.keys(beforeRecoveryTree).some((path) => path.includes("/receipts/") && path.endsWith(".json")),
    false,
    "uncertain release must not become an immutable terminal Receipt"
  );
  const list = spawnSync("node", ["dist/cli.js", "apply", "recover", "--json"], { env, encoding: "utf8" });
  assert.equal(list.status, 0, `${list.stdout}\n${list.stderr}`);
  const candidate = JSON.parse(list.stdout).data.recoveries[0];
  assert.equal(candidate.terminalReceipt, null);

  const execute = executeRecovery(env, candidate);
  assert.equal(execute.status, 0, `${execute.stdout}\n${execute.stderr}`);
  const recovered = JSON.parse(execute.stdout).data.receipt;
  assert.equal(recovered.outcome, "applied");
  assert.equal(recovered.control.exclusiveControlReleased, "verified");
  assert.deepEqual(JSON.parse(spawnSync(
    "node", ["dist/cli.js", "apply", "recover", "--json"], { env, encoding: "utf8" }
  ).stdout).data.recoveries, []);
});

test("hard crash after an atomic swap restores the exact writer raced at the commit boundary", async () => {
  const fixture = await makeDailySortFixture();
  const env = dailySortEnv(fixture);
  const plan = previewDailyPlan(env);
  const external = await readJsonLz4(fixture.sessionPath);
  external.externalWriter = "must survive interrupted zts swap";
  const script = [
    'import { discoverProfileContext } from "./dist/profile.js";',
    'import { loadStoredPlan } from "./dist/plans.js";',
    'import { applyStoredPlanClosedSession } from "./dist/apply-transaction.js";',
    'import { writeJsonLz4 } from "./dist/mozlz4.js";',
    'const context = await discoverProfileContext();',
    `const stored = await loadStoredPlan(context.profile.id, ${JSON.stringify(plan.id)});`,
    'await applyStoredPlanClosedSession(context, stored, {',
    `  expectedDigest: ${JSON.stringify(plan.digest)},`,
    '  command: "fixture atomic-swap crash",',
    `  afterSourceValidation: () => writeJsonLz4(${JSON.stringify(fixture.sessionPath)}, ${JSON.stringify(external)}),`,
    '  afterAtomicSwap: () => process.exit(65)',
    '});'
  ].join("\n");
  const crashed = spawnSync("node", ["--input-type=module", "--eval", script], {
    cwd: process.cwd(), env, encoding: "utf8"
  });
  assert.equal(crashed.status, 65, `${crashed.stdout}\n${crashed.stderr}`);
  assert.notEqual((await readJsonLz4(fixture.sessionPath)).externalWriter, external.externalWriter);

  const list = spawnSync("node", ["dist/cli.js", "apply", "recover", "--json"], { env, encoding: "utf8" });
  assert.equal(list.status, 0, `${list.stdout}\n${list.stderr}`);
  const candidate = JSON.parse(list.stdout).data.recoveries[0];
  assert.equal(candidate.classification, "planned_after_present");
  const interruptedRecovery = failApplyRecovery(env, candidate, "afterAtomicRecoveryReconciliation");
  assert.notEqual(interruptedRecovery.status, 0, `${interruptedRecovery.stdout}\n${interruptedRecovery.stderr}`);
  assert.match(interruptedRecovery.stderr, /recovery may have changed the session/iu);
  assert.equal((await readJsonLz4(fixture.sessionPath)).externalWriter, external.externalWriter);
  const refreshedList = spawnSync("node", ["dist/cli.js", "apply", "recover", "--json"], { env, encoding: "utf8" });
  assert.equal(refreshedList.status, 0, `${refreshedList.stdout}\n${refreshedList.stderr}`);
  const refreshedCandidate = JSON.parse(refreshedList.stdout).data.recoveries[0];
  const execute = executeRecovery(env, refreshedCandidate);
  assert.equal(execute.status, 0, `${execute.stdout}\n${execute.stderr}`);
  const data = JSON.parse(execute.stdout).data;
  assert.equal(data.receipt.outcome, "interrupted");
  assert.equal(data.receipt.mutationAttempted, false);
  assert.equal(data.receipt.netChanged, false);
  assert.equal(data.receipt.control.exclusiveControlReleased, "verified");
  assert.equal(data.receipt.issues[0].code, "hard_crash_external_drift_before_commit");
  assert.equal(data.sessionMutated, false);
  assert.equal(data.recoveryMutation.kind, "none");
  assert.deepEqual(
    data.recoveryMutation.beforeFingerprint,
    data.recoveryMutation.afterFingerprint
  );
  assert.ok(data.receipt.operations.every((operation) =>
    operation.status === "not_attempted"
    && operation.mutationAttempted === false
    && operation.netChanged === false
    && operation.issueCodes.includes("hard_crash_external_drift_before_commit")
  ));
  assert.equal((await readJsonLz4(fixture.sessionPath)).externalWriter, external.externalWriter);
  assert.ok(data.artifacts.some((artifact) => artifact.kind === "prepared_image"));
});

test("indeterminate atomic helper outcome stays unfinished until residue-bound recovery", async () => {
  const fixture = await makeDailySortFixture();
  const env = dailySortEnv(fixture);
  const plan = previewDailyPlan(env);
  const firstWriter = await readJsonLz4(fixture.sessionPath);
  firstWriter.externalWriter = "first writer displaced by the uncertain swap";
  const secondWriter = structuredClone(firstWriter);
  secondWriter.externalWriter = "second writer remains canonical";
  const firstPath = join(fixture.profilePath, "first-writer.jsonlz4");
  const secondPath = join(fixture.profilePath, "second-writer.jsonlz4");
  const script = [
    'import { rename, writeFile } from "node:fs/promises";',
    'import { discoverProfileContext } from "./dist/profile.js";',
    'import { loadStoredPlan } from "./dist/plans.js";',
    'import { applyStoredPlanClosedSession } from "./dist/apply-transaction.js";',
    'import { encodeJsonLz4Buffer } from "./dist/mozlz4.js";',
    'const context = await discoverProfileContext();',
    `const stored = await loadStoredPlan(context.profile.id, ${JSON.stringify(plan.id)});`,
    'await applyStoredPlanClosedSession(context, stored, {',
    `  expectedDigest: ${JSON.stringify(plan.digest)},`,
    '  command: "fixture indeterminate atomic helper outcome",',
    '  afterSourceValidation: async () => {',
    `    await writeFile(${JSON.stringify(firstPath)}, encodeJsonLz4Buffer(${JSON.stringify(firstWriter)}));`,
    `    await rename(${JSON.stringify(firstPath)}, ${JSON.stringify(fixture.sessionPath)});`,
    '  },',
    '  afterAtomicSwap: async () => {',
    `    await writeFile(${JSON.stringify(secondPath)}, encodeJsonLz4Buffer(${JSON.stringify(secondWriter)}));`,
    `    await rename(${JSON.stringify(secondPath)}, ${JSON.stringify(fixture.sessionPath)});`,
    '  }',
    '});'
  ].join("\n");
  const failed = spawnSync("node", ["--input-type=module", "--eval", script], {
    cwd: process.cwd(), env, encoding: "utf8"
  });
  assert.notEqual(failed.status, 0, `${failed.stdout}\n${failed.stderr}`);
  assert.match(failed.stderr, /Atomic session commit outcome is uncertain|requires zts apply recover/iu);
  assert.deepEqual(await readJsonLz4(fixture.sessionPath), secondWriter);
  const beforeRecovery = await snapshotFileTree(fixture.stateDir);
  assert.equal(Object.keys(beforeRecovery).some((path) => path.includes("/receipts/") && path.endsWith(".json")), false);
  assert.equal(Object.keys(beforeRecovery).some((path) => path.includes("/unfinished/") && path.endsWith(".json") && !path.endsWith("index.json")), true);

  const listed = spawnSync("node", ["dist/cli.js", "apply", "recover", "--json"], { env, encoding: "utf8" });
  assert.equal(listed.status, 0, `${listed.stdout}\n${listed.stderr}`);
  const candidate = JSON.parse(listed.stdout).data.recoveries[0];
  assert.ok(candidate.atomicResidue);
  const execute = executeRecovery(env, candidate);
  assert.equal(execute.status, 0, `${execute.stdout}\n${execute.stderr}`);
  const data = JSON.parse(execute.stdout).data;
  assert.equal(data.receipt.outcome, "interrupted");
  assert.equal(data.receipt.mutationAttempted, true);
  assert.equal(data.receipt.netChanged, null);
  assert.equal(data.receipt.issues[0].code, "hard_crash_commit_overwritten");
  assert.equal(data.sessionMutated, false);
  assert.equal(data.recoveryMutation.kind, "none");
  assert.deepEqual(await readJsonLz4(fixture.sessionPath), secondWriter);
  const displacedWriter = data.artifacts.find((artifact) => artifact.kind === "displaced_writer");
  assert.ok(displacedWriter);
  assert.equal((await readdir(fixture.profilePath)).some((entry) => entry.endsWith(".jsonlz4.tmp")), false);

  const retentionPreview = spawnSync("node", ["dist/cli.js", "history", "retain", "--json"], {
    env,
    encoding: "utf8"
  });
  assert.equal(retentionPreview.status, 0, `${retentionPreview.stdout}\n${retentionPreview.stderr}`);
  const retentionInspection = JSON.parse(retentionPreview.stdout).data.inspection;
  assert.deepEqual(retentionInspection.blockers, []);
  const retentionApply = spawnSync("node", [
    "dist/cli.js",
    "history",
    "retain",
    "--apply",
    "--yes",
    "--expect-inspection-revision",
    retentionInspection.inspectionRevision,
    "--json"
  ], { env, encoding: "utf8" });
  assert.equal(retentionApply.status, 0, `${retentionApply.stdout}\n${retentionApply.stderr}`);
  assert.equal(JSON.parse(retentionApply.stdout).data.result.outcome, "applied");
  const retainedTree = await snapshotFileTree(fixture.stateDir);
  assert.ok(Object.keys(retainedTree).some((path) =>
    path.endsWith(`/prepared-images/${displacedWriter.digest.slice("sha256:".length)}.jsonlz4`)
  ));
});

test("recovery consent digest binds the exact journal-owned atomic residue", async () => {
  const fixture = await makeDailySortFixture();
  const env = dailySortEnv(fixture);
  const plan = previewDailyPlan(env);
  const before = await readFile(fixture.sessionPath);
  assert.equal(crashDailyApply(env, plan, "beforeCommit", 63).status, 63);
  const listed = spawnSync("node", ["dist/cli.js", "apply", "recover", "--json"], { env, encoding: "utf8" });
  assert.equal(listed.status, 0, `${listed.stdout}\n${listed.stderr}`);
  const candidate = JSON.parse(listed.stdout).data.recoveries[0];
  assert.ok(candidate.atomicResidue);
  const changedResidue = await readJsonLz4(fixture.sessionPath);
  changedResidue.residueChangedAfterInspection = true;
  await writeJsonLz4(candidate.atomicResidue.path, changedResidue);

  const stale = executeRecovery(env, candidate);
  assert.equal(stale.status, 2, `${stale.stdout}\n${stale.stderr}`);
  assert.match(JSON.parse(stale.stdout).blockers.join("\n"), /inspection changed|does not match current inspection/iu);
  assert.deepEqual(await readFile(fixture.sessionPath), before);
  const refreshed = JSON.parse(spawnSync(
    "node", ["dist/cli.js", "apply", "recover", "--json"], { env, encoding: "utf8" }
  ).stdout).data.recoveries[0];
  assert.notEqual(refreshed.recoveryRevision, candidate.recoveryRevision);
  assert.notDeepEqual(refreshed.atomicResidue.fingerprint, candidate.atomicResidue.fingerprint);
});

test("hard crash after a clean atomic swap accepts only the exact displaced before-source", async () => {
  const fixture = await makeDailySortFixture();
  const env = dailySortEnv(fixture);
  const plan = previewDailyPlan(env);
  const crashed = crashDailyApply(env, plan, "afterAtomicSwap", 64);
  assert.equal(crashed.status, 64, `${crashed.stdout}\n${crashed.stderr}`);
  const candidate = JSON.parse(spawnSync(
    "node", ["dist/cli.js", "apply", "recover", "--json"], { env, encoding: "utf8" }
  ).stdout).data.recoveries[0];
  assert.equal(candidate.classification, "planned_after_present");
  const execute = executeRecovery(env, candidate);
  assert.equal(execute.status, 0, `${execute.stdout}\n${execute.stderr}`);
  const receipt = JSON.parse(execute.stdout).data.receipt;
  assert.equal(receipt.mutationAttempted, true);
  assert.equal(receipt.netChanged, true);
  assert.equal(receipt.control.exclusiveControlReleased, "verified");
  assert.ok(receipt.operations.every((operation) => operation.status === "verified"));
});

test("prepared-image recovery bounds Profile scans and concurrent file growth", async (t) => {
  await t.test("Profile directory scan", async () => {
    const fixture = await makeDailySortFixture();
    const env = dailySortEnv(fixture);
    const plan = previewDailyPlan(env);
    assert.equal(crashDailyApply(env, plan, "beforeCommit", 67).status, 67);
    const candidate = JSON.parse(spawnSync(
      "node", ["dist/cli.js", "apply", "recover", "--json"], { env, encoding: "utf8" }
    ).stdout).data.recoveries[0];
    const profileEntries = await readdir(fixture.profilePath);
    const previous = new Map();
    for (const key of ["HOME", "PATH", "ZTS_ZEN_APP_SUPPORT_DIR", "ZTS_STATE_DIR", "ZTS_CONFIG_PATH"]) {
      previous.set(key, process.env[key]);
      process.env[key] = env[key];
    }
    try {
      const { discoverProfileContext } = await import("../dist/profile.js");
      const { recoverApplyTransaction } = await import("../dist/apply-recovery.js");
      await assert.rejects(
        async () => recoverApplyTransaction(await discoverProfileContext(), candidate.transactionId, {
          expectedRecoveryRevision: candidate.recoveryRevision,
          profileScanEntryLimit: profileEntries.length - 1
        }),
        /prepared temporary scan exceeds .* Profile entries/iu
      );
    } finally {
      for (const [key, value] of previous) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
    const after = JSON.parse(spawnSync(
      "node", ["dist/cli.js", "apply", "recover", "--json"], { env, encoding: "utf8" }
    ).stdout).data.recoveries;
    assert.equal(after.length, 1);
    assert.equal(after[0].terminalReceipt, null);
  });

  await t.test("growth after bounded pre-stat", async () => {
    const fixture = await makeDailySortFixture();
    const env = dailySortEnv(fixture);
    const plan = previewDailyPlan(env);
    assert.equal(crashDailyApply(env, plan, "beforeCommit", 66).status, 66);
    const candidate = JSON.parse(spawnSync(
      "node", ["dist/cli.js", "apply", "recover", "--json"], { env, encoding: "utf8" }
    ).stdout).data.recoveries[0];
    const temporaryName = (await readdir(fixture.profilePath)).find((entry) => /^\.zts-.*\.jsonlz4\.tmp$/u.test(entry));
    assert.ok(temporaryName);
    const temporaryPath = join(fixture.profilePath, temporaryName);
    const initialBytes = (await stat(temporaryPath)).size;
    const previous = new Map();
    for (const key of ["HOME", "PATH", "ZTS_ZEN_APP_SUPPORT_DIR", "ZTS_STATE_DIR", "ZTS_CONFIG_PATH"]) {
      previous.set(key, process.env[key]);
      process.env[key] = env[key];
    }
    try {
      const { discoverProfileContext } = await import("../dist/profile.js");
      const { recoverApplyTransaction } = await import("../dist/apply-recovery.js");
      let grew = false;
      await assert.rejects(
        async () => recoverApplyTransaction(await discoverProfileContext(), candidate.transactionId, {
          expectedRecoveryRevision: candidate.recoveryRevision,
          preparedTemporaryReadLimitBytes: initialBytes,
          afterPreparedTemporaryStat: async (path) => {
            assert.equal(path.endsWith(`/${temporaryName}`), true);
            if (!grew) {
              grew = true;
              await appendFile(path, "x");
            }
          }
        }),
        /prepared temporary image exceeds the read limit while being read/iu
      );
      assert.equal(grew, true);
    } finally {
      for (const [key, value] of previous) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
    const tree = await snapshotFileTree(fixture.stateDir);
    assert.equal(Object.keys(tree).some((path) => path.includes("/receipts/") && path.endsWith(".json")), false);
    assert.equal(Object.keys(tree).some((path) => path.includes("/unfinished/") && path.endsWith(".json") && !path.endsWith("index.json")), true);
  });
});

test("marker-only recovery refuses an existing transaction root whose canonical journal is missing", async () => {
  const fixture = await makeDailySortFixture();
  const env = dailySortEnv(fixture);
  const plan = previewDailyPlan(env);
  assert.equal(crashDailyApply(env, plan, "afterUnfinishedMarker", 76).status, 76);

  const [profileStore] = await readdir(join(fixture.stateDir, "apply-transactions"));
  assert.ok(profileStore);
  const applyRoot = join(fixture.stateDir, "apply-transactions", profileStore);
  const unfinishedRoot = join(applyRoot, "unfinished");
  const markerName = (await readdir(unfinishedRoot)).find((entry) =>
    entry.startsWith("apply-") && entry.endsWith(".json")
  );
  assert.ok(markerName);
  const marker = JSON.parse(await readFile(join(unfinishedRoot, markerName), "utf8"));
  const transactionRoot = join(
    applyRoot,
    "transactions",
    marker.journal.transactionId.replace(/[^A-Za-z0-9._-]+/gu, "-")
  );
  await mkdir(transactionRoot, { mode: 0o700 });
  const beforeTree = await snapshotFileTree(fixture.stateDir);
  const beforeSession = await readFile(fixture.sessionPath);

  const listed = spawnSync(
    "node", ["dist/cli.js", "apply", "recover", "--json"], { env, encoding: "utf8" }
  );
  assert.equal(listed.status, 4, `${listed.stdout}\n${listed.stderr}`);
  const document = JSON.parse(listed.stdout);
  assert.match(
    document.blockers.join("\n"),
    /transaction directory exists.*canonical journal is missing.*explicit repair/iu
  );
  assert.deepEqual(await snapshotFileTree(fixture.stateDir), beforeTree);
  assert.deepEqual(await readFile(fixture.sessionPath), beforeSession);
});

test("unfinished index recovers a crash before the transaction journal pointer exists", async () => {
  const fixture = await makeDailySortFixture();
  const env = dailySortEnv(fixture);
  const plan = previewDailyPlan(env);
  const before = await readFile(fixture.sessionPath);
  assert.equal(crashDailyApply(env, plan, "afterUnfinishedMarker", 77).status, 77);

  const [profileStore] = await readdir(join(fixture.stateDir, "apply-transactions"));
  assert.ok(profileStore);
  const unfinishedRoot = join(fixture.stateDir, "apply-transactions", profileStore, "unfinished");
  const markerName = (await readdir(unfinishedRoot)).find((entry) => entry.startsWith("apply-") && entry.endsWith(".json"));
  assert.ok(markerName);
  const markerPath = join(unfinishedRoot, markerName);
  const publicationTemporary = join(unfinishedRoot, `.tmp-${randomUUID()}.artifact`);
  await link(markerPath, publicationTemporary);
  assert.equal((await lstat(markerPath)).nlink, 2);

  const list = spawnSync("node", ["dist/cli.js", "apply", "recover", "--json"], { env, encoding: "utf8" });
  assert.equal(list.status, 0, `${list.stdout}\n${list.stderr}`);
  assert.equal((await lstat(markerPath)).nlink, 2, "read-only recovery inspection must not reconcile durable residue");
  assert.equal((await lstat(publicationTemporary)).nlink, 2);
  const candidate = JSON.parse(list.stdout).data.recoveries[0];
  assert.equal(
    markerName,
    `${candidate.transactionId.replace(/[^A-Za-z0-9._-]+/gu, "-")}.json`,
    "recovery transaction identity must resolve the durable marker path"
  );
  assert.equal(candidate.journalStage, "initialized");
  assert.equal(candidate.lock.status, "absent");
  assert.equal(candidate.classification, "before_state_present");
  const execute = executeRecovery(env, candidate);
  assert.equal(execute.status, 0, `${execute.stdout}\n${execute.stderr}`);
  const data = JSON.parse(execute.stdout).data;
  assert.equal(data.receipt.mutationAttempted, false);
  assert.equal(data.recoveryLockReleased, true);
  assert.deepEqual(await readFile(fixture.sessionPath), before);
  await assert.rejects(lstat(markerPath), /ENOENT/);
  await assert.rejects(lstat(publicationTemporary), /ENOENT/);
  assert.deepEqual(JSON.parse(spawnSync(
    "node", ["dist/cli.js", "apply", "recover", "--json"], { env, encoding: "utf8" }
  ).stdout).data.recoveries, []);
});

test("unfinished post-release transaction blocks another apply until recovery holds replacement control", async () => {
  const fixture = await makeDailySortFixture();
  const env = dailySortEnv(fixture);
  const plan = previewDailyPlan(env);
  assert.equal(crashDailyApply(env, plan, "afterRelease", 76).status, 76);
  const committed = await readFile(fixture.sessionPath);
  assert.deepEqual(await readdir(join(fixture.stateDir, "locks")), []);

  const contender = spawnSync("node", [
    "dist/cli.js",
    "apply",
    plan.id,
    "--yes",
    "--expect-digest",
    plan.digest,
    "--json"
  ], { env, encoding: "utf8" });
  assert.equal(contender.status, 2, `${contender.stdout}\n${contender.stderr}`);
  assert.match(JSON.parse(contender.stdout).blockers.join("\n"), /Unfinished Apply Transaction/);
  assert.deepEqual(await readFile(fixture.sessionPath), committed);

  const list = spawnSync("node", ["dist/cli.js", "apply", "recover", "--json"], { env, encoding: "utf8" });
  assert.equal(list.status, 0, `${list.stdout}\n${list.stderr}`);
  const candidate = JSON.parse(list.stdout).data.recoveries[0];
  assert.equal(candidate.lock.status, "absent");
  assert.equal(candidate.classification, "planned_after_present");
  const verifiedJournal = JSON.parse(await readFile(candidate.journalPath, "utf8"));
  const originalInverse = verifiedJournal.history.find((entry) => entry.stage === "verified").evidence.inversePlanArtifact;
  const execute = executeRecovery(env, candidate);
  assert.equal(execute.status, 0, `${execute.stdout}\n${execute.stderr}`);
  const data = JSON.parse(execute.stdout).data;
  assert.equal(data.recoveryLockReleased, true);
  assert.equal(data.staleLockReleased, false);
  assert.deepEqual(data.receipt.inversePlanArtifact, originalInverse);
  assert.deepEqual(await readFile(fixture.sessionPath), committed);
  assert.deepEqual(await readdir(join(fixture.stateDir, "locks")), []);
});

test("recovery rejects a valid same-Snapshot inverse that does not exactly reverse its source Plan", async () => {
  const fixture = await makeDailySortFixture();
  const env = dailySortEnv(fixture);
  const plan = previewDailyPlan(env);
  assert.equal(crashDailyApply(env, plan, "afterRelease", 76).status, 76);
  const committedSession = await readFile(fixture.sessionPath);

  const initialList = spawnSync("node", ["dist/cli.js", "apply", "recover", "--json"], {
    env,
    encoding: "utf8"
  });
  assert.equal(initialList.status, 0, `${initialList.stdout}\n${initialList.stderr}`);
  const initial = JSON.parse(initialList.stdout).data.recoveries[0];
  const journal = JSON.parse(await readFile(initial.journalPath, "utf8"));
  const verified = journal.history.find((entry) => entry.stage === "verified");
  assert.ok(verified?.evidence.inversePlanArtifact);
  const originalReference = verified.evidence.inversePlanArtifact;
  const tree = await snapshotFileTree(fixture.stateDir);
  const originalKey = Object.keys(tree).find((path) =>
    path.endsWith(`/inverse-plans/${originalReference.digest.slice("sha256:".length)}.json`)
  );
  assert.ok(originalKey);
  const originalPath = join(fixture.stateDir, originalKey);
  const envelope = JSON.parse(await readFile(originalPath, "utf8"));
  assert.ok(envelope.plan.actions.length > 1);
  const substitutedPlan = createPlan(envelope.snapshot, {
    schemaVersion: envelope.plan.schemaVersion,
    id: envelope.plan.id,
    configRevision: envelope.plan.configRevision,
    engineManifestRevision: envelope.plan.engineManifestRevision,
    createdAt: envelope.plan.createdAt,
    expiresAt: envelope.plan.expiresAt,
    derivation: envelope.plan.derivation,
    source: envelope.plan.source,
    actions: envelope.plan.actions.slice(0, -1)
  });
  const substitutedReference = { id: substitutedPlan.id, digest: substitutedPlan.digest };
  const substitutedPath = join(
    dirname(originalPath),
    `${substitutedPlan.digest.slice("sha256:".length)}.json`
  );
  await writeFile(substitutedPath, `${JSON.stringify({
    schemaVersion: envelope.schemaVersion,
    snapshot: envelope.snapshot,
    plan: substitutedPlan
  })}\n`, { mode: 0o600 });
  await rm(originalPath);
  for (const entry of journal.history) {
    if (entry.evidence.inversePlanArtifact) entry.evidence.inversePlanArtifact = substitutedReference;
  }
  await writeFile(initial.journalPath, `${JSON.stringify(journal)}\n`, { mode: 0o600 });

  const refreshedList = spawnSync("node", ["dist/cli.js", "apply", "recover", "--json"], {
    env,
    encoding: "utf8"
  });
  assert.equal(refreshedList.status, 0, `${refreshedList.stdout}\n${refreshedList.stderr}`);
  const candidate = JSON.parse(refreshedList.stdout).data.recoveries[0];
  const execute = executeRecovery(env, candidate);
  assert.equal(execute.status, 4, `${execute.stdout}\n${execute.stderr}`);
  assert.match(
    JSON.parse(execute.stdout).blockers.join("\n"),
    /does not exactly reverse its recovered source Plan and Operations/iu
  );
  assert.deepEqual(await readFile(fixture.sessionPath), committedSession);
  const afterTree = await snapshotFileTree(fixture.stateDir);
  assert.equal(Object.keys(afterTree).some((path) => path.includes("/receipts/") && path.endsWith(".json")), false);
});

test("replacement Profile lock crash before journal binding remains recoverable", async () => {
  const fixture = await makeDailySortFixture();
  const env = dailySortEnv(fixture);
  const plan = previewDailyPlan(env);
  assert.equal(crashDailyApply(env, plan, "afterRelease", 76).status, 76);
  const initial = JSON.parse(spawnSync(
    "node", ["dist/cli.js", "apply", "recover", "--json"], { env, encoding: "utf8" }
  ).stdout).data.recoveries[0];
  assert.equal(initial.lock.status, "absent");
  const failed = failApplyRecovery(env, initial, "afterProfileLockBound");
  assert.equal(failed.status, 1, `${failed.stdout}\n${failed.stderr}`);
  const secondAttempt = JSON.parse(spawnSync(
    "node", ["dist/cli.js", "apply", "recover", "--json"], { env, encoding: "utf8" }
  ).stdout).data.recoveries[0];
  assert.equal(secondAttempt.journalStage, "recovery_control_acquired");
  assert.equal(secondAttempt.lock.status, "absent");
  const crashed = crashApplyRecovery(env, secondAttempt, "afterProfileLockAcquired", 75);
  assert.equal(crashed.status, 75, `${crashed.stdout}\n${crashed.stderr}`);

  const afterCrash = spawnSync("node", ["dist/cli.js", "apply", "recover", "--json"], { env, encoding: "utf8" });
  assert.equal(afterCrash.status, 0, `${afterCrash.stdout}\n${afterCrash.stderr}`);
  const candidate = JSON.parse(afterCrash.stdout).data.recoveries[0];
  assert.equal(candidate.lock.status, "stale");
  assert.equal(candidate.classification, "planned_after_present");
  assert.equal(candidate.recoverable, true);
  const execute = executeRecovery(env, candidate);
  assert.equal(execute.status, 0, `${execute.stdout}\n${execute.stderr}`);
  assert.equal(JSON.parse(execute.stdout).data.staleLockReleased, true);
  assert.deepEqual(JSON.parse(spawnSync(
    "node", ["dist/cli.js", "apply", "recover", "--json"], { env, encoding: "utf8" }
  ).stdout).data.recoveries, []);
});

test("terminal Receipt crash before marker removal remains listed for idempotent cleanup", async () => {
  const fixture = await makeDailySortFixture();
  const env = dailySortEnv(fixture);
  const plan = previewDailyPlan(env);
  assert.equal(crashDailyApply(env, plan, "afterReceipt", 75).status, 75);

  const list = spawnSync("node", ["dist/cli.js", "apply", "recover", "--json"], { env, encoding: "utf8" });
  assert.equal(list.status, 0, `${list.stdout}\n${list.stderr}`);
  const candidate = JSON.parse(list.stdout).data.recoveries[0];
  assert.equal(candidate.terminalReceipt.outcome, "applied");
  assert.equal(candidate.lock.status, "absent");
  assert.equal(candidate.recoverable, true);
  const execute = executeRecovery(env, candidate);
  assert.equal(execute.status, 0, `${execute.stdout}\n${execute.stderr}`);
  assert.equal(JSON.parse(execute.stdout).data.alreadyComplete, true);
  const after = spawnSync("node", ["dist/cli.js", "apply", "recover", "--json"], { env, encoding: "utf8" });
  assert.equal(after.status, 0, `${after.stdout}\n${after.stderr}`);
  assert.deepEqual(JSON.parse(after.stdout).data.recoveries, []);
});

test("Receipt object crash before pointer is repaired before terminal marker cleanup", async () => {
  const fixture = await makeDailySortFixture();
  const env = dailySortEnv(fixture);
  const plan = previewDailyPlan(env);
  assert.equal(crashDailyApply(env, plan, "afterReceiptObject", 74).status, 74);
  const list = spawnSync("node", ["dist/cli.js", "apply", "recover", "--json"], { env, encoding: "utf8" });
  assert.equal(list.status, 0, `${list.stdout}\n${list.stderr}`);
  const candidate = JSON.parse(list.stdout).data.recoveries[0];
  assert.equal(candidate.terminalReceipt.outcome, "applied");
  const pointerPath = join(candidate.journalPath, "..", "receipt-pointer.json");
  await assert.rejects(() => readFile(pointerPath), /ENOENT/);

  const execute = executeRecovery(env, candidate);
  assert.equal(execute.status, 0, `${execute.stdout}\n${execute.stderr}`);
  assert.equal(JSON.parse(execute.stdout).data.alreadyComplete, true);
  await assert.doesNotReject(() => readFile(pointerPath));
  assert.deepEqual(JSON.parse(spawnSync(
    "node", ["dist/cli.js", "apply", "recover", "--json"], { env, encoding: "utf8" }
  ).stdout).data.recoveries, []);
});

test("history intent and head crash boundaries reconcile before terminal marker cleanup", async (t) => {
  for (const [hook, exitCode] of [["afterHistoryIntent", 69], ["afterHistoryHead", 68]]) {
    await t.test(hook, async () => {
      const fixture = await makeDailySortFixture();
      const env = dailySortEnv(fixture);
      const plan = previewDailyPlan(env);
      const crash = crashDailyApply(env, plan, hook, exitCode);
      assert.equal(crash.status, exitCode, `${crash.stdout}\n${crash.stderr}`);
      const recoveries = spawnSync(
        "node", ["dist/cli.js", "apply", "recover", "--json"], { env, encoding: "utf8" }
      );
      assert.equal(recoveries.status, 0, `${recoveries.stdout}\n${recoveries.stderr}`);
      const candidate = JSON.parse(recoveries.stdout).data.recoveries[0];
      assert.equal(candidate.terminalReceipt.outcome, "applied");
      const execute = executeRecovery(env, candidate);
      assert.equal(execute.status, 0, `${execute.stdout}\n${execute.stderr}`);
      const history = spawnSync(
        "node", ["dist/cli.js", "apply", "list", "--limit", "10", "--json"], { env, encoding: "utf8" }
      );
      assert.equal(history.status, 0, `${history.stdout}\n${history.stderr}`);
      assert.deepEqual(
        JSON.parse(history.stdout).data.receipts.map((receipt) => receipt.id),
        [candidate.terminalReceipt.id]
      );
      const afterTree = await snapshotFileTree(fixture.stateDir);
      assert.equal(Object.keys(afterTree).some((path) => path.endsWith("/receipt-history/history.lock")), true);
      assert.equal(Object.keys(afterTree).some((path) => path.includes("/unfinished/") && path.endsWith(".json") && !path.endsWith("index.json")), false);
    });
  }
});

test("active recovery claim blocks duplicate finalization after control release and before Receipt publication", async () => {
  const fixture = await makeDailySortFixture();
  const env = dailySortEnv(fixture);
  const plan = previewDailyPlan(env);
  assert.equal(crashDailyApply(env, plan, "afterCommit", 73).status, 73);
  const candidate = JSON.parse(spawnSync(
    "node", ["dist/cli.js", "apply", "recover", "--json"], { env, encoding: "utf8" }
  ).stdout).data.recoveries[0];
  const previous = new Map();
  for (const key of ["HOME", "PATH", "ZTS_ZEN_APP_SUPPORT_DIR", "ZTS_STATE_DIR", "ZTS_CONFIG_PATH"]) {
    previous.set(key, process.env[key]);
    process.env[key] = env[key];
  }
  try {
    const { discoverProfileContext } = await import("../dist/profile.js");
    const {
      ApplyRecoveryBlockedError,
      inspectApplyRecovery,
      listApplyRecoveryInspections,
      recoverApplyTransaction
    } = await import("../dist/apply-recovery.js");
    const context = await discoverProfileContext();
    let reachedControlRelease;
    let allowCompletion;
    const controlReleased = new Promise((resolve) => { reachedControlRelease = resolve; });
    const completionGate = new Promise((resolve) => { allowCompletion = resolve; });
    const first = recoverApplyTransaction(context, candidate.transactionId, {
      expectedRecoveryRevision: candidate.recoveryRevision,
      afterControlReleased: async () => {
        reachedControlRelease();
        await completionGate;
      }
    });
    await controlReleased;
    const during = await inspectApplyRecovery(await discoverProfileContext(), candidate.transactionId);
    assert.equal(during.terminalReceipt, null, "no terminal Receipt may predate proven control release");
    assert.equal(during.lock.status, "absent");
    assert.equal(during.recoveryClaim.status, "active");
    await assert.rejects(
      async () => recoverApplyTransaction(await discoverProfileContext(), candidate.transactionId, {
        expectedRecoveryRevision: during.recoveryRevision
      }),
      (error) => error instanceof ApplyRecoveryBlockedError && /already owns/.test(error.message)
    );
    allowCompletion();
    await first;
    assert.deepEqual(await listApplyRecoveryInspections(await discoverProfileContext()), []);
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("terminal recovery intent replays every publication crash without reacquiring browser controls", async (t) => {
  for (const [hook, exitCode] of [
    ["afterTerminalIntent", 107],
    ["afterRecoveryControlProof", 108],
    ["afterRecoveryFinalJournal", 109],
    ["beforeRecoveryReceiptIntent", 110]
  ]) {
    await t.test(hook, async () => {
      const fixture = await makeDailySortFixture();
      const env = dailySortEnv(fixture);
      const plan = previewDailyPlan(env);
      assert.equal(crashDailyApply(env, plan, "afterCommit", 72).status, 72);
      const initialRun = spawnSync(
        "node", ["dist/cli.js", "apply", "recover", "--json"], { env, encoding: "utf8" }
      );
      assert.equal(initialRun.status, 0, `${initialRun.stdout}\n${initialRun.stderr}`);
      const initial = JSON.parse(initialRun.stdout).data.recoveries[0];
      const crashed = crashApplyRecovery(env, initial, hook, exitCode);
      assert.equal(crashed.status, exitCode, `${crashed.stdout}\n${crashed.stderr}`);

      // Durable terminal intent owns replay now. Make the session unreadable
      // to prove inspection/completion does not recapture or reacquire it.
      await writeFile(fixture.sessionPath, "Zen reopened after terminal intent");
      const replayRun = spawnSync(
        "node", ["dist/cli.js", "apply", "recover", "--json"], { env, encoding: "utf8" }
      );
      assert.equal(replayRun.status, 0, `${replayRun.stdout}\n${replayRun.stderr}`);
      const replay = JSON.parse(replayRun.stdout).data.recoveries[0];
      assert.equal(replay.terminalReceipt, null);
      assert.equal(replay.lock.status, "absent");
      assert.equal(replay.recoverable, true);
      const completed = executeRecovery(env, replay);
      assert.equal(completed.status, 0, `${completed.stdout}\n${completed.stderr}`);
      assert.deepEqual(JSON.parse(spawnSync(
        "node", ["dist/cli.js", "apply", "recover", "--json"], { env, encoding: "utf8" }
      ).stdout).data.recoveries, []);

      const tree = await snapshotFileTree(fixture.stateDir);
      assert.equal(Object.keys(tree).filter((path) => path.endsWith("recovery-terminal-intent.json")).length, 1);
      const controlPaths = Object.keys(tree).filter((path) => path.includes("/controls/") && path.endsWith(".json"));
      const recoveryControls = [];
      for (const path of controlPaths) {
        const value = JSON.parse(await readFile(join(fixture.stateDir, path), "utf8"));
        if (value.schemaVersion === "zts.closed-session-recovery-control.provisional-1") recoveryControls.push(path);
      }
      assert.equal(recoveryControls.length, 1);
      const immutableJournals = [];
      for (const path of Object.keys(tree).filter((item) => item.includes("/journals/") && item.endsWith(".json"))) {
        const value = JSON.parse(await readFile(join(fixture.stateDir, path), "utf8"));
        if (value.stage === "recovery_receipt_prepared") immutableJournals.push(value);
      }
      assert.equal(immutableJournals.length, 1);
      assert.equal(
        typeof immutableJournals[0].history.at(-1).evidence.terminalIntentRevision,
        "string"
      );
      assert.equal(Object.keys(tree).filter((path) => path.includes("/receipts/") && path.endsWith(".json")).length, 1);
    });
  }
});

test("terminal artifact oversize preflight leaves every terminal publication absent and retryable", async () => {
  const fixture = await makeDailySortFixture();
  const env = dailySortEnv(fixture);
  const plan = previewDailyPlan(env);
  assert.equal(crashDailyApply(env, plan, "afterCommit", 106).status, 106);
  const listed = spawnSync(
    "node", ["dist/cli.js", "apply", "recover", "--json"], { env, encoding: "utf8" }
  );
  assert.equal(listed.status, 0, `${listed.stdout}\n${listed.stderr}`);
  let candidate = JSON.parse(listed.stdout).data.recoveries[0];
  for (const [limits, errorPattern] of [
    [{ controlProofMaxBytes: 1 }, /Recovery terminal control proof exceeds the 1-byte write limit/iu],
    [{ finalJournalMaxBytes: 1 }, /Recovery terminal immutable journal exceeds the 1-byte write limit/iu],
    [{ terminalIntentMaxBytes: 1 }, /Recovery terminal intent exceeds the 1-byte write limit/iu]
  ]) {
    const script = [
      'import { discoverProfileContext } from "./dist/profile.js";',
      'import { recoverApplyTransaction } from "./dist/apply-recovery.js";',
      "const context = await discoverProfileContext();",
      `await recoverApplyTransaction(context, ${JSON.stringify(candidate.transactionId)}, {`,
      `  expectedRecoveryRevision: ${JSON.stringify(candidate.recoveryRevision)},`,
      `  terminalArtifactPreflightLimits: ${JSON.stringify(limits)}`,
      "});"
    ].join("\n");
    const rejected = spawnSync("node", ["--input-type=module", "--eval", script], {
      cwd: process.cwd(), env, encoding: "utf8"
    });
    assert.equal(rejected.status, 1, `${rejected.stdout}\n${rejected.stderr}`);
    assert.match(rejected.stderr, errorPattern);

    const tree = await snapshotFileTree(fixture.stateDir);
    assert.equal(Object.keys(tree).some((path) => path.endsWith("recovery-terminal-intent.json")), false);
    const recoveryControlProofs = [];
    for (const path of Object.keys(tree).filter((item) => item.includes("/controls/") && item.endsWith(".json"))) {
      const value = JSON.parse(await readFile(join(fixture.stateDir, path), "utf8"));
      if (value.schemaVersion === "zts.closed-session-recovery-control.provisional-1") {
        recoveryControlProofs.push(path);
      }
    }
    assert.deepEqual(recoveryControlProofs, []);
    assert.equal(Object.keys(tree).some((path) => path.includes("/journals/")
      && path.endsWith(".json")
      && JSON.parse(Buffer.from(tree[path], "base64").toString("utf8")).stage === "recovery_receipt_prepared"), false);
    assert.equal(Object.keys(tree).some((path) => path.includes("/receipts/") && path.endsWith(".json")), false);

    const retryList = spawnSync(
      "node", ["dist/cli.js", "apply", "recover", "--json"], { env, encoding: "utf8" }
    );
    assert.equal(retryList.status, 0, `${retryList.stdout}\n${retryList.stderr}`);
    candidate = JSON.parse(retryList.stdout).data.recoveries[0];
  }
  const completed = executeRecovery(env, candidate);
  assert.equal(completed.status, 0, `${completed.stdout}\n${completed.stderr}`);
});

test("recovery-created descriptor bytes remain deterministic across repeated pre-terminal crashes", async () => {
  const fixture = await makeDailySortFixture();
  const env = dailySortEnv(fixture);
  const plan = previewDailyPlan(env);
  assert.equal(crashDailyApply(env, plan, "afterLock", 105).status, 105);
  const initialList = spawnSync(
    "node", ["dist/cli.js", "apply", "recover", "--json"], { env, encoding: "utf8" }
  );
  assert.equal(initialList.status, 0, `${initialList.stdout}\n${initialList.stderr}`);
  const initial = JSON.parse(initialList.stdout).data.recoveries[0];
  const firstCrash = crashApplyRecovery(env, initial, "afterRecoveryDescriptor", 104);
  assert.equal(firstCrash.status, 104, `${firstCrash.stdout}\n${firstCrash.stderr}`);
  const afterFirst = await snapshotFileTree(fixture.stateDir);
  const firstDescriptors = Object.keys(afterFirst).filter((path) =>
    path.includes("/recoveries/") && path.endsWith(".json")
  );
  assert.equal(firstDescriptors.length, 1);

  const secondList = spawnSync(
    "node", ["dist/cli.js", "apply", "recover", "--json"], { env, encoding: "utf8" }
  );
  assert.equal(secondList.status, 0, `${secondList.stdout}\n${secondList.stderr}`);
  const second = JSON.parse(secondList.stdout).data.recoveries[0];
  const secondCrash = crashApplyRecovery(env, second, "afterRecoveryDescriptor", 103);
  assert.equal(secondCrash.status, 103, `${secondCrash.stdout}\n${secondCrash.stderr}`);
  const afterSecond = await snapshotFileTree(fixture.stateDir);
  assert.deepEqual(
    Object.keys(afterSecond).filter((path) => path.includes("/recoveries/") && path.endsWith(".json")),
    firstDescriptors
  );
  assert.equal(afterSecond[firstDescriptors[0]], afterFirst[firstDescriptors[0]]);

  const retryList = spawnSync(
    "node", ["dist/cli.js", "apply", "recover", "--json"], { env, encoding: "utf8" }
  );
  assert.equal(retryList.status, 0, `${retryList.stdout}\n${retryList.stderr}`);
  const completed = executeRecovery(env, JSON.parse(retryList.stdout).data.recoveries[0]);
  assert.equal(completed.status, 0, `${completed.stdout}\n${completed.stderr}`);
});

test("legacy recovery-created inverse bytes remain deterministic across repeated pre-terminal crashes", async () => {
  const fixture = await makeDailySortFixture();
  const env = dailySortEnv(fixture);
  const plan = previewDailyPlan(env);
  assert.equal(crashDailyApply(env, plan, "afterCommit", 102).status, 102);
  const initialList = spawnSync(
    "node", ["dist/cli.js", "apply", "recover", "--json"], { env, encoding: "utf8" }
  );
  assert.equal(initialList.status, 0, `${initialList.stdout}\n${initialList.stderr}`);
  const initial = JSON.parse(initialList.stdout).data.recoveries[0];
  const journal = JSON.parse(await readFile(initial.journalPath, "utf8"));
  const preflight = journal.history.find((entry) => entry.stage === "preflight_ok");
  assert.ok(preflight?.evidence.inversePlanArtifact);
  delete preflight.evidence.expectedAfterSnapshotRevision;
  delete preflight.evidence.inversePlanArtifact;
  await writeFile(initial.journalPath, `${JSON.stringify(journal, null, 2)}\n`, { mode: 0o600 });

  const legacyList = spawnSync(
    "node", ["dist/cli.js", "apply", "recover", "--json"], { env, encoding: "utf8" }
  );
  assert.equal(legacyList.status, 0, `${legacyList.stdout}\n${legacyList.stderr}`);
  const legacy = JSON.parse(legacyList.stdout).data.recoveries[0];
  const before = await snapshotFileTree(fixture.stateDir);
  const beforeInversePaths = new Set(Object.keys(before).filter((path) =>
    path.includes("/inverse-plans/") && path.endsWith(".json")
  ));
  const firstCrash = crashApplyRecovery(env, legacy, "afterRecoveryInverse", 101);
  assert.equal(firstCrash.status, 101, `${firstCrash.stdout}\n${firstCrash.stderr}`);
  const afterFirst = await snapshotFileTree(fixture.stateDir);
  const firstInversePaths = Object.keys(afterFirst).filter((path) =>
    path.includes("/inverse-plans/") && path.endsWith(".json")
  );
  const recoveryCreated = firstInversePaths.filter((path) => !beforeInversePaths.has(path));
  assert.equal(recoveryCreated.length, 1);

  const secondList = spawnSync(
    "node", ["dist/cli.js", "apply", "recover", "--json"], { env, encoding: "utf8" }
  );
  assert.equal(secondList.status, 0, `${secondList.stdout}\n${secondList.stderr}`);
  const second = JSON.parse(secondList.stdout).data.recoveries[0];
  const secondCrash = crashApplyRecovery(env, second, "afterRecoveryInverse", 100);
  assert.equal(secondCrash.status, 100, `${secondCrash.stdout}\n${secondCrash.stderr}`);
  const afterSecond = await snapshotFileTree(fixture.stateDir);
  assert.deepEqual(
    Object.keys(afterSecond).filter((path) => path.includes("/inverse-plans/") && path.endsWith(".json")),
    firstInversePaths
  );
  assert.equal(afterSecond[recoveryCreated[0]], afterFirst[recoveryCreated[0]]);

  const retryList = spawnSync(
    "node", ["dist/cli.js", "apply", "recover", "--json"], { env, encoding: "utf8" }
  );
  assert.equal(retryList.status, 0, `${retryList.stdout}\n${retryList.stderr}`);
  const completed = executeRecovery(env, JSON.parse(retryList.stdout).data.recoveries[0]);
  assert.equal(completed.status, 0, `${completed.stdout}\n${completed.stderr}`);
  assert.equal(
    JSON.parse(completed.stdout).data.receipt.inversePlanArtifact.digest.slice("sha256:".length),
    recoveryCreated[0].match(/\/inverse-plans\/([a-f0-9]{64})\.json$/u)?.[1]
  );
});

test("crash after durable recovery completion cannot strand its marker", async () => {
  const fixture = await makeDailySortFixture();
  const env = dailySortEnv(fixture);
  const plan = previewDailyPlan(env);
  assert.equal(crashDailyApply(env, plan, "afterCommit", 72).status, 72);
  const initial = JSON.parse(spawnSync(
    "node", ["dist/cli.js", "apply", "recover", "--json"], { env, encoding: "utf8" }
  ).stdout).data.recoveries[0];
  const crashed = crashApplyRecovery(env, initial, "afterRecoveryComplete", 71);
  assert.equal(crashed.status, 71, `${crashed.stdout}\n${crashed.stderr}`);
  const afterCrash = spawnSync("node", ["dist/cli.js", "apply", "recover", "--json"], { env, encoding: "utf8" });
  assert.equal(afterCrash.status, 0, `${afterCrash.stdout}\n${afterCrash.stderr}`);
  const candidate = JSON.parse(afterCrash.stdout).data.recoveries[0];
  assert.equal(candidate.journalStage, "recovery_complete");
  assert.equal(candidate.lock.status, "absent");
  assert.equal(candidate.recoveryClaim.status, "stale");
  const execute = executeRecovery(env, candidate);
  assert.equal(execute.status, 0, `${execute.stdout}\n${execute.stderr}`);
  assert.equal(JSON.parse(execute.stdout).data.alreadyComplete, true);
  assert.deepEqual(JSON.parse(spawnSync(
    "node", ["dist/cli.js", "apply", "recover", "--json"], { env, encoding: "utf8" }
  ).stdout).data.recoveries, []);
});

test("settled terminal markers resume idempotently after a crash before unlink", async (t) => {
  await t.test("normal Apply cleanup", async () => {
    const fixture = await makeDailySortFixture();
    const env = dailySortEnv(fixture);
    const plan = previewDailyPlan(env);
    const crashed = crashDailyApply(env, plan, "afterStoreSettlement", 62);
    assert.equal(crashed.status, 62, `${crashed.stdout}\n${crashed.stderr}`);
    const listed = spawnSync("node", ["dist/cli.js", "apply", "recover", "--json"], { env, encoding: "utf8" });
    assert.equal(listed.status, 0, `${listed.stdout}\n${listed.stderr}`);
    const candidate = JSON.parse(listed.stdout).data.recoveries[0];
    assert.equal(candidate.terminalReceipt.outcome, "applied");
    const execute = executeRecovery(env, candidate);
    assert.equal(execute.status, 0, `${execute.stdout}\n${execute.stderr}`);
    assert.equal(JSON.parse(execute.stdout).data.alreadyComplete, true);
    assert.deepEqual(JSON.parse(spawnSync(
      "node", ["dist/cli.js", "apply", "recover", "--json"], { env, encoding: "utf8" }
    ).stdout).data.recoveries, []);
  });

  await t.test("hard-crash recovery cleanup", async () => {
    const fixture = await makeDailySortFixture();
    const env = dailySortEnv(fixture);
    const plan = previewDailyPlan(env);
    assert.equal(crashDailyApply(env, plan, "afterCommit", 61).status, 61);
    const initial = JSON.parse(spawnSync(
      "node", ["dist/cli.js", "apply", "recover", "--json"], { env, encoding: "utf8" }
    ).stdout).data.recoveries[0];
    const crashed = crashApplyRecovery(env, initial, "afterStoreSettlement", 60);
    assert.equal(crashed.status, 60, `${crashed.stdout}\n${crashed.stderr}`);
    const listed = spawnSync("node", ["dist/cli.js", "apply", "recover", "--json"], { env, encoding: "utf8" });
    assert.equal(listed.status, 0, `${listed.stdout}\n${listed.stderr}`);
    const candidate = JSON.parse(listed.stdout).data.recoveries[0];
    assert.equal(candidate.terminalReceipt.outcome, "applied");
    const execute = executeRecovery(env, candidate);
    assert.equal(execute.status, 0, `${execute.stdout}\n${execute.stderr}`);
    assert.equal(JSON.parse(execute.stdout).data.alreadyComplete, true);
    assert.deepEqual(JSON.parse(spawnSync(
      "node", ["dist/cli.js", "apply", "recover", "--json"], { env, encoding: "utf8" }
    ).stdout).data.recoveries, []);
  });
});

test("a stale marker-only recovery inspection cannot regress the progressed journal", async () => {
  const fixture = await makeDailySortFixture();
  const env = dailySortEnv(fixture);
  const plan = previewDailyPlan(env);
  assert.equal(crashDailyApply(env, plan, "afterUnfinishedMarker", 59).status, 59);
  const listed = spawnSync(
    "node", ["dist/cli.js", "apply", "recover", "--json"], { env, encoding: "utf8" }
  );
  assert.equal(listed.status, 0, `${listed.stdout}\n${listed.stderr}`);
  const recoveries = JSON.parse(listed.stdout).data.recoveries;
  assert.equal(recoveries.length, 1);
  const candidate = recoveries[0];
  const previous = new Map();
  for (const key of ["HOME", "PATH", "ZTS_ZEN_APP_SUPPORT_DIR", "ZTS_STATE_DIR", "ZTS_CONFIG_PATH"]) {
    previous.set(key, process.env[key]);
    process.env[key] = env[key];
  }
  try {
    const { discoverProfileContext } = await import("../dist/profile.js");
    const { ApplyRecoveryBlockedError, recoverApplyTransaction } = await import("../dist/apply-recovery.js");
    let inspected;
    let resume;
    const inspectionReached = new Promise((resolve) => { inspected = resolve; });
    const resumeGate = new Promise((resolve) => { resume = resolve; });
    const staleAttempt = recoverApplyTransaction(await discoverProfileContext(), candidate.transactionId, {
      expectedRecoveryRevision: candidate.recoveryRevision,
      afterInitialInspection: async () => {
        inspected();
        await resumeGate;
      }
    });
    await inspectionReached;
    const winner = await recoverApplyTransaction(await discoverProfileContext(), candidate.transactionId, {
      expectedRecoveryRevision: candidate.recoveryRevision
    });
    assert.equal(winner.recoveryRecorded, true);
    const journalAfterWinner = await readFile(candidate.journalPath);
    resume();
    await assert.rejects(
      () => staleAttempt,
      (error) => error instanceof ApplyRecoveryBlockedError && /marker changed|inspect recovery again/iu.test(error.message)
    );
    assert.deepEqual(await readFile(candidate.journalPath), journalAfterWinner);
    assert.deepEqual(JSON.parse(spawnSync(
      "node", ["dist/cli.js", "apply", "recover", "--json"], { env, encoding: "utf8" }
    ).stdout).data.recoveries, []);
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("pre-path-identity unfinished safety state blocks mutation after Profile id migration", async () => {
  const fixture = await makeDailySortFixture();
  const env = dailySortEnv(fixture);
  const plan = previewDailyPlan(env);
  const legacyTransactionId = "apply:00000000-0000-4000-8000-000000000001";
  const setup = [
    'import { applyArtifactLayout } from "./dist/apply-artifacts.js";',
    'import { ensurePrivateDirectory, privatePath, replacePrivateJson } from "./dist/private-store.js";',
    'const layout = await applyArtifactLayout("daily.Default");',
    `const root = await ensurePrivateDirectory(layout.transactions, ${JSON.stringify("apply-00000000-0000-4000-8000-000000000001")});`,
    `await replacePrivateJson(privatePath(root, "journal.json"), { transactionId: ${JSON.stringify(legacyTransactionId)}, profileId: "daily.Default" });`
  ].join("\n");
  const setupRun = spawnSync("node", ["--input-type=module", "--eval", setup], {
    cwd: process.cwd(), env, encoding: "utf8"
  });
  assert.equal(setupRun.status, 0, `${setupRun.stdout}\n${setupRun.stderr}`);

  const apply = spawnSync("node", [
    "dist/cli.js",
    "apply",
    plan.id,
    "--yes",
    "--expect-digest",
    plan.digest,
    "--json"
  ], { env, encoding: "utf8" });
  assert.equal(apply.status, 2, `${apply.stdout}\n${apply.stderr}`);
  assert.match(JSON.parse(apply.stdout).blockers.join("\n"), /Pre-path-identity zts safety state blocks mutation/);
});

test("pre-path-identity unfinished state under a configured symlink alias blocks mutation", async () => {
  const fixture = await makeDailySortFixture();
  const legacyAlias = await configureLegacyProfileAlias(fixture, "alias.Default");
  const env = dailySortEnv(fixture);
  const plan = previewDailyPlan(env);
  const legacyTransactionId = "apply:00000000-0000-4000-8000-000000000002";
  const setup = [
    'import { applyArtifactLayout } from "./dist/apply-artifacts.js";',
    'import { ensurePrivateDirectory, privatePath, replacePrivateJson } from "./dist/private-store.js";',
    'const layout = await applyArtifactLayout("alias.Default");',
    `const root = await ensurePrivateDirectory(layout.transactions, ${JSON.stringify("apply-00000000-0000-4000-8000-000000000002")});`,
    `await replacePrivateJson(privatePath(root, "journal.json"), { transactionId: ${JSON.stringify(legacyTransactionId)}, profileId: "alias.Default" });`
  ].join("\n");
  const setupRun = spawnSync("node", ["--input-type=module", "--eval", setup], {
    cwd: process.cwd(), env, encoding: "utf8"
  });
  assert.equal(setupRun.status, 0, `${setupRun.stdout}\n${setupRun.stderr}`);

  const apply = spawnSync("node", [
    "dist/cli.js", "apply", plan.id, "--yes", "--expect-digest", plan.digest, "--json"
  ], { env, encoding: "utf8" });
  assert.equal(apply.status, 2, `${apply.stdout}\n${apply.stderr}`);
  assert.match(JSON.parse(apply.stdout).blockers.join("\n"), /Pre-path-identity zts safety state blocks mutation/);
  assert.notEqual(legacyAlias, fixture.profilePath);
});

test("pre-path-identity lock under a configured symlink alias blocks mutation", async () => {
  const fixture = await makeDailySortFixture();
  const legacyAlias = await configureLegacyProfileAlias(fixture, "locked-alias.Default");
  const env = dailySortEnv(fixture);
  const plan = previewDailyPlan(env);
  const setup = [
    'import { sha256Canonical } from "./dist/domain/digest.js";',
    'import { ensurePrivateDirectory, privatePath, replacePrivateJson } from "./dist/private-store.js";',
    'import { stateDir } from "./dist/paths.js";',
    `const digest = sha256Canonical({ profileId: "locked-alias.Default", profilePath: ${JSON.stringify(legacyAlias)} }).slice("sha256:".length);`,
    'const root = await ensurePrivateDirectory(stateDir(), "locks");',
    'await replacePrivateJson(privatePath(root, `profile-${digest}.json`), { legacyFixture: true });'
  ].join("\n");
  const setupRun = spawnSync("node", ["--input-type=module", "--eval", setup], {
    cwd: process.cwd(), env, encoding: "utf8"
  });
  assert.equal(setupRun.status, 0, `${setupRun.stdout}\n${setupRun.stderr}`);

  const apply = spawnSync("node", [
    "dist/cli.js", "apply", plan.id, "--yes", "--expect-digest", plan.digest, "--json"
  ], { env, encoding: "utf8" });
  assert.equal(apply.status, 2, `${apply.stdout}\n${apply.stderr}`);
  assert.match(JSON.parse(apply.stdout).blockers.join("\n"), /Pre-path-identity zts Profile lock blocks mutation/);
});

test("invalid and foreign Profile locks remain untouched by recovery", async (t) => {
  await t.test("invalid lock", async () => {
    const fixture = await makeDailySortFixture();
    const env = dailySortEnv(fixture);
    const plan = previewDailyPlan(env);
    assert.equal(crashDailyApply(env, plan, "afterCommit", 75).status, 75);
    const initial = JSON.parse(spawnSync(
      "node",
      ["dist/cli.js", "apply", "recover", "--json"],
      { env, encoding: "utf8" }
    ).stdout).data.recoveries[0];
    await writeFile(initial.lock.lockPath, "{\n");
    const list = spawnSync("node", ["dist/cli.js", "apply", "recover", "--json"], { env, encoding: "utf8" });
    assert.equal(list.status, 0, `${list.stdout}\n${list.stderr}`);
    const candidate = JSON.parse(list.stdout).data.recoveries[0];
    assert.equal(candidate.classification, "blocked_invalid_lock");
    assert.equal(candidate.lock.status, "invalid");
    const before = await snapshotFileTree(fixture.stateDir);
    const execute = executeRecovery(env, candidate);
    assert.equal(execute.status, 2, `${execute.stdout}\n${execute.stderr}`);
    assert.deepEqual(await snapshotFileTree(fixture.stateDir), before);
  });

  await t.test("foreign stale lock", async () => {
    const fixture = await makeDailySortFixture();
    const env = dailySortEnv(fixture);
    const plan = previewDailyPlan(env);
    assert.equal(crashDailyApply(env, plan, "afterCommit", 74).status, 74);
    const initial = JSON.parse(spawnSync(
      "node",
      ["dist/cli.js", "apply", "recover", "--json"],
      { env, encoding: "utf8" }
    ).stdout).data.recoveries[0];
    const foreignLock = JSON.parse(await readFile(initial.lock.lockPath, "utf8"));
    foreignLock.transactionId = "apply:00000000-0000-4000-8000-000000000000";
    await writeFile(initial.lock.lockPath, `${JSON.stringify(foreignLock, null, 2)}\n`);
    const list = spawnSync("node", ["dist/cli.js", "apply", "recover", "--json"], { env, encoding: "utf8" });
    assert.equal(list.status, 0, `${list.stdout}\n${list.stderr}`);
    const candidate = JSON.parse(list.stdout).data.recoveries[0];
    assert.equal(candidate.classification, "blocked_lock_mismatch");
    const before = await snapshotFileTree(fixture.stateDir);
    const execute = executeRecovery(env, candidate);
    assert.equal(execute.status, 2, `${execute.stdout}\n${execute.stderr}`);
    assert.deepEqual(await snapshotFileTree(fixture.stateDir), before);
  });
});

test("malformed journal transitions fail closed without releasing the Profile lock", async () => {
  const fixture = await makeDailySortFixture();
  const env = dailySortEnv(fixture);
  const plan = previewDailyPlan(env);
  assert.equal(crashDailyApply(env, plan, "afterCommit", 73).status, 73);
  const initial = JSON.parse(spawnSync(
    "node",
    ["dist/cli.js", "apply", "recover", "--json"],
    { env, encoding: "utf8" }
  ).stdout).data.recoveries[0];
  const journal = JSON.parse(await readFile(initial.journalPath, "utf8"));
  journal.stage = "invented_success";
  journal.history.push({ stage: "invented_success", at: new Date().toISOString(), evidence: {} });
  await writeFile(initial.journalPath, `${JSON.stringify(journal, null, 2)}\n`);
  const beforeLock = await readFile(initial.lock.lockPath);

  const list = spawnSync("node", ["dist/cli.js", "apply", "recover", "--json"], { env, encoding: "utf8" });
  assert.equal(list.status, 4, `${list.stdout}\n${list.stderr}`);
  assert.equal(JSON.parse(list.stdout).data.outcome.status, "internal_error");
  assert.match(JSON.parse(list.stdout).blockers.join("\n"), /invalid stage transition|unknown stage/);
  assert.deepEqual(await readFile(initial.lock.lockPath), beforeLock);
});

test("temporary preservation evidence must remain bound to write preparation", async () => {
  const fixture = await makeDailySortFixture();
  const env = dailySortEnv(fixture);
  const plan = previewDailyPlan(env);
  assert.equal(crashDailyApply(env, plan, "beforeCommit", 72).status, 72);
  const initial = JSON.parse(spawnSync(
    "node", ["dist/cli.js", "apply", "recover", "--json"], { env, encoding: "utf8" }
  ).stdout).data.recoveries[0];
  assert.equal(crashApplyRecovery(env, initial, "afterTemporaryPreserved", 71).status, 71);
  const journal = JSON.parse(await readFile(initial.journalPath, "utf8"));
  const preservation = journal.history.find((entry) => entry.stage === "recovery_temporary_preserved");
  preservation.evidence.temporaryPathRevision = `sha256:${"0".repeat(64)}`;
  await writeFile(initial.journalPath, `${JSON.stringify(journal, null, 2)}\n`);
  const lockBefore = await readFile(initial.lock.lockPath);

  const list = spawnSync("node", ["dist/cli.js", "apply", "recover", "--json"], { env, encoding: "utf8" });
  assert.equal(list.status, 4, `${list.stdout}\n${list.stderr}`);
  assert.equal(JSON.parse(list.stdout).data.outcome.status, "internal_error");
  assert.match(JSON.parse(list.stdout).blockers.join("\n"), /does not match write preparation/);
  assert.deepEqual(await readFile(initial.lock.lockPath), lockBefore);
});

test("missing backup bytes block recovery before Receipt publication or lock release", async () => {
  const fixture = await makeDailySortFixture();
  const env = dailySortEnv(fixture);
  const plan = previewDailyPlan(env);
  assert.equal(crashDailyApply(env, plan, "afterCommit", 72).status, 72);
  const list = spawnSync("node", ["dist/cli.js", "apply", "recover", "--json"], { env, encoding: "utf8" });
  assert.equal(list.status, 0, `${list.stdout}\n${list.stderr}`);
  const candidate = JSON.parse(list.stdout).data.recoveries[0];
  const backupPath = Object.keys(await snapshotFileTree(fixture.stateDir))
    .find((path) => path.includes("/backups/") && path.endsWith(".jsonlz4"));
  assert.ok(backupPath);
  await rm(join(fixture.stateDir, backupPath));
  const lockBefore = await readFile(candidate.lock.lockPath);

  const execute = executeRecovery(env, candidate);
  assert.equal(execute.status, 4, `${execute.stdout}\n${execute.stderr}`);
  const failure = JSON.parse(execute.stdout);
  assert.equal(failure.data.outcome.status, "internal_error");
  assert.equal(failure.data.outcome.mutationAttempted, null);
  assert.match(failure.blockers.join("\n"), /ENOENT/);
  assert.deepEqual(await readFile(candidate.lock.lockPath), lockBefore);
  const tree = await snapshotFileTree(fixture.stateDir);
  assert.equal(Object.keys(tree).some((path) => path.includes("/receipts/") && path.endsWith(".json")), false);
});

test("concurrent recovery finalizers publish exactly one terminal Receipt", async () => {
  const fixture = await makeDailySortFixture();
  const env = dailySortEnv(fixture);
  const plan = previewDailyPlan(env);
  assert.equal(crashDailyApply(env, plan, "afterCommit", 71).status, 71);
  const list = spawnSync("node", ["dist/cli.js", "apply", "recover", "--json"], { env, encoding: "utf8" });
  assert.equal(list.status, 0, `${list.stdout}\n${list.stderr}`);
  const candidate = JSON.parse(list.stdout).data.recoveries[0];
  const results = await Promise.all([
    executeRecoveryAsync(env, candidate),
    executeRecoveryAsync(env, candidate)
  ]);
  assert.equal(results.filter((result) => result.status === 0).length, 1, JSON.stringify(results));
  assert.equal(results.filter((result) => result.status === 2).length, 1, JSON.stringify(results));
  const tree = await snapshotFileTree(fixture.stateDir);
  assert.equal(Object.keys(tree).filter((path) => path.includes("/receipts/") && path.endsWith(".json")).length, 1);
  assert.equal(Object.keys(tree).some((path) => path.endsWith("recovery-claim.json")), false);
});

test("unfinished index keeps recovery admission independent of terminal history size", async () => {
  const fixture = await makeDailySortFixture();
  const env = dailySortEnv(fixture);
  const plan = previewDailyPlan(env);
  const setup = [
    'import { mkdir, writeFile } from "node:fs/promises";',
    'import { applyArtifactLayout } from "./dist/apply-artifacts.js";',
    'import { beginApplyReceiptHistoryMigration, completeApplyReceiptHistoryMigration } from "./dist/apply-receipt-store.js";',
    'import { initializeApplyUnfinishedIndex } from "./dist/apply-unfinished-store.js";',
    `const layout = await applyArtifactLayout(${JSON.stringify(plan.profileId)});`,
    `await beginApplyReceiptHistoryMigration(layout, ${JSON.stringify(plan.profileId)});`,
    `await completeApplyReceiptHistoryMigration(layout, ${JSON.stringify(plan.profileId)});`,
    `await initializeApplyUnfinishedIndex(layout, ${JSON.stringify(plan.profileId)});`,
    "for (let index = 0; index < 500; index += 1) {",
    "  const root = `${layout.transactions}/historical-${String(index).padStart(4, '0')}`;",
    "  await mkdir(root, { mode: 0o700 });",
    "  await writeFile(`${root}/journal.json`, '{corrupt terminal history', { mode: 0o600 });",
    "}"
  ].join("\n");
  const setupRun = spawnSync("node", ["--input-type=module", "--eval", setup], {
    cwd: process.cwd(), env, encoding: "utf8"
  });
  assert.equal(setupRun.status, 0, `${setupRun.stdout}\n${setupRun.stderr}`);

  const started = Date.now();
  const recover = spawnSync("node", ["dist/cli.js", "apply", "recover", "--json"], { env, encoding: "utf8" });
  const durationMs = Date.now() - started;
  assert.equal(recover.status, 0, `${recover.stdout}\n${recover.stderr}`);
  assert.deepEqual(JSON.parse(recover.stdout).data.recoveries, []);
  assert.ok(durationMs < 5_000, `indexed recovery scan took ${durationMs}ms`);

});

test("unfinished receipt lookup never scans unrelated corrupt Receipt history", async () => {
  const fixture = await makeDailySortFixture();
  const env = dailySortEnv(fixture);
  const plan = previewDailyPlan(env);
  assert.equal(crashDailyApply(env, plan, "afterCommit", 70).status, 70);
  const setup = [
    'import { writeFile } from "node:fs/promises";',
    'import { applyArtifactLayout } from "./dist/apply-artifacts.js";',
    `const layout = await applyArtifactLayout(${JSON.stringify(plan.profileId)});`,
    "for (let index = 0; index < 500; index += 1) {",
    "  await writeFile(`${layout.receipts}/${String(index).padStart(4, '0')}.json`, '{corrupt unrelated receipt', { mode: 0o600 });",
    "}"
  ].join("\n");
  const setupRun = spawnSync("node", ["--input-type=module", "--eval", setup], {
    cwd: process.cwd(), env, encoding: "utf8"
  });
  assert.equal(setupRun.status, 0, `${setupRun.stdout}\n${setupRun.stderr}`);

  const started = Date.now();
  const list = spawnSync("node", ["dist/cli.js", "apply", "recover", "--json"], { env, encoding: "utf8" });
  const durationMs = Date.now() - started;
  assert.equal(list.status, 0, `${list.stdout}\n${list.stderr}`);
  const recoveries = JSON.parse(list.stdout).data.recoveries;
  assert.equal(recoveries.length, 1);
  assert.equal(recoveries[0].transactionId.startsWith("apply:"), true);
  assert.ok(durationMs < 5_000, `unfinished lookup took ${durationMs}ms`);
});

test("under-lock sole-marker admission serializes concurrent applies", async () => {
  const fixture = await makeDailySortFixture();
  const env = dailySortEnv(fixture);
  const plan = previewDailyPlan(env);
  const previous = new Map();
  for (const key of ["HOME", "PATH", "ZTS_ZEN_APP_SUPPORT_DIR", "ZTS_STATE_DIR", "ZTS_CONFIG_PATH"]) {
    previous.set(key, process.env[key]);
    process.env[key] = env[key];
  }
  try {
    const { discoverProfileContext } = await import("../dist/profile.js");
    const { loadStoredPlan } = await import("../dist/plans.js");
    const { applyStoredPlanClosedSession, listTransactionReceipts } = await import("../dist/apply-transaction.js");
    const { listApplyRecoveryInspections } = await import("../dist/apply-recovery.js");
    const context = await discoverProfileContext();
    const stored = await loadStoredPlan(context.profile.id, plan.id);
    let firstRegistered;
    let releaseFirst;
    const registered = new Promise((resolve) => { firstRegistered = resolve; });
    const firstMayContinue = new Promise((resolve) => { releaseFirst = resolve; });
    const firstPromise = applyStoredPlanClosedSession(context, stored, {
      expectedDigest: plan.digest,
      command: "concurrent fixture A",
      afterUnfinishedMarker: async () => {
        firstRegistered();
        await firstMayContinue;
      }
    });
    await registered;
    let secondSettled = false;
    const secondPromise = applyStoredPlanClosedSession(context, stored, {
      expectedDigest: plan.digest,
      command: "concurrent fixture B"
    }).then(
      (result) => ({ result, error: null }),
      (error) => ({ result: null, error })
    ).finally(() => { secondSettled = true; });
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(secondSettled, false, "contender must wait for the persistent history control");
    releaseFirst();
    const first = await firstPromise;
    assert.equal(first.applied, true);
    const contender = await secondPromise;
    assert.equal(contender.result, null);
    assert.match(String(contender.error), /Unfinished Apply Transaction/);
    const history = await listTransactionReceipts(context.profile.id, { limit: 10 });
    assert.equal(history.length, 1);
    assert.equal(history[0].id, first.receipt.id);
    assert.deepEqual(await listApplyRecoveryInspections(await discoverProfileContext()), []);
    assert.deepEqual(await readdir(join(fixture.stateDir, "locks")), []);
    const verify = spawnSync(
      "node",
      ["dist/cli.js", "apply", "verify", first.receipt.id, "--json"],
      { env, encoding: "utf8" }
    );
    assert.equal(verify.status, 0, `${verify.stdout}\n${verify.stderr}`);
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

function previewDailyPlan(env) {
  const preview = spawnSync(
    "node",
    ["dist/cli.js", "sort", "--all", "--engine", "rules", "--preview", "--json"],
    { env, encoding: "utf8" }
  );
  assert.equal(preview.status, 0, `${preview.stdout}\n${preview.stderr}`);
  return JSON.parse(preview.stdout).data.plan;
}

function crashDailyApply(env, plan, hook, exitCode) {
  const script = [
    'import { discoverProfileContext } from "./dist/profile.js";',
    'import { loadStoredPlan } from "./dist/plans.js";',
    'import { applyStoredPlanClosedSession } from "./dist/apply-transaction.js";',
    "const context = await discoverProfileContext();",
    `const stored = await loadStoredPlan(context.profile.id, ${JSON.stringify(plan.id)});`,
    "await applyStoredPlanClosedSession(context, stored, {",
    `  expectedDigest: ${JSON.stringify(plan.digest)},`,
    `  command: ${JSON.stringify(`fixture crash at ${hook}`)},`,
    `  ${hook}: () => process.exit(${exitCode})`,
    "});"
  ].join("\n");
  return spawnSync("node", ["--input-type=module", "--eval", script], {
    cwd: process.cwd(), env, encoding: "utf8"
  });
}

function failDailyApplyAtHook(env, plan, hook) {
  const script = [
    'import { discoverProfileContext } from "./dist/profile.js";',
    'import { loadStoredPlan } from "./dist/plans.js";',
    'import { applyStoredPlanClosedSession } from "./dist/apply-transaction.js";',
    "const context = await discoverProfileContext();",
    `const stored = await loadStoredPlan(context.profile.id, ${JSON.stringify(plan.id)});`,
    "await applyStoredPlanClosedSession(context, stored, {",
    `  expectedDigest: ${JSON.stringify(plan.digest)},`,
    `  command: ${JSON.stringify(`fixture failure at ${hook}`)},`,
    `  ${hook}: () => { throw new Error(${JSON.stringify(`fixture failure at ${hook}`)}); }`,
    "});"
  ].join("\n");
  return spawnSync("node", ["--input-type=module", "--eval", script], {
    cwd: process.cwd(), env, encoding: "utf8"
  });
}

async function onlyUnfinishedMarkerPath(stateDir) {
  const tree = await snapshotFileTree(stateDir);
  const matches = Object.keys(tree).filter((path) =>
    path.includes("/unfinished/") && path.endsWith(".json") && !path.endsWith("/index.json")
  );
  assert.equal(matches.length, 1, `expected one unfinished marker, observed ${matches.join(", ")}`);
  return join(stateDir, matches[0]);
}

function rebindMarkerConsentAndAuthorization(marker) {
  const consentArtifact = {
    id: `consent:${marker.journal.transactionId}`,
    digest: sha256Canonical(marker.bootstrap.consent)
  };
  const { revision: _priorRevision, ...authorizationDraft } = marker.bootstrap.authorization;
  authorizationDraft.source = {
    ...authorizationDraft.source,
    consentArtifact
  };
  const revision = sha256Canonical(authorizationDraft);
  marker.bootstrap.consentArtifact = consentArtifact;
  marker.bootstrap.authorization = { ...authorizationDraft, revision };
  marker.bootstrap.authorizationArtifact = {
    id: authorizationDraft.id,
    digest: revision
  };
  marker.journal.authorizationRevision = revision;
}

function crashApplyRecovery(env, inspection, hook, exitCode) {
  const script = [
    'import { discoverProfileContext } from "./dist/profile.js";',
    'import { recoverApplyTransaction } from "./dist/apply-recovery.js";',
    "const context = await discoverProfileContext();",
    `await recoverApplyTransaction(context, ${JSON.stringify(inspection.transactionId)}, {`,
    `  expectedRecoveryRevision: ${JSON.stringify(inspection.recoveryRevision)},`,
    `  ${hook}: () => process.exit(${exitCode})`,
    "});"
  ].join("\n");
  return spawnSync("node", ["--input-type=module", "--eval", script], {
    cwd: process.cwd(), env, encoding: "utf8"
  });
}

function failApplyRecovery(env, inspection, hook) {
  const script = [
    'import { discoverProfileContext } from "./dist/profile.js";',
    'import { recoverApplyTransaction } from "./dist/apply-recovery.js";',
    "const context = await discoverProfileContext();",
    `await recoverApplyTransaction(context, ${JSON.stringify(inspection.transactionId)}, {`,
    `  expectedRecoveryRevision: ${JSON.stringify(inspection.recoveryRevision)},`,
    `  ${hook}: () => { throw new Error("fixture recovery failure at ${hook}"); }`,
    "});"
  ].join("\n");
  return spawnSync("node", ["--input-type=module", "--eval", script], {
    cwd: process.cwd(), env, encoding: "utf8"
  });
}

function executeRecovery(env, inspection) {
  return spawnSync("node", [
    "dist/cli.js",
    "apply",
    "recover",
    inspection.transactionId,
    "--yes",
    "--expect-recovery-digest",
    inspection.recoveryRevision,
    "--json"
  ], { env, encoding: "utf8" });
}

async function executeRecoveryAsync(env, inspection) {
  const args = [
    "dist/cli.js",
    "apply",
    "recover",
    inspection.transactionId,
    "--yes",
    "--expect-recovery-digest",
    inspection.recoveryRevision,
    "--json"
  ];
  try {
    const result = await execFileAsync("node", args, { env, encoding: "utf8" });
    return { status: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    return {
      status: Number(error.code),
      stdout: String(error.stdout ?? ""),
      stderr: String(error.stderr ?? "")
    };
  }
}

async function planAndApplyManualMove(fixture, env, nativeId, destinationWorkspaceId) {
  const snapshotRun = spawnSync("node", ["dist/cli.js", "snapshot", "--json"], { env, encoding: "utf8" });
  assert.equal(snapshotRun.status, 0, `${snapshotRun.stdout}\n${snapshotRun.stderr}`);
  const snapshot = JSON.parse(snapshotRun.stdout).data.snapshot;
  const entity = snapshot.entities.find((candidate) => candidate.nativeId === nativeId);
  assert.ok(entity, `missing fixture Entity ${nativeId}`);
  const patchPath = join(fixture.temp, `patch-${nativeId}-${randomUUID()}.json`);
  await writeFile(patchPath, `${JSON.stringify({
    operations: [{
      op: "move",
      entityRef: entity.ref,
      expectedSourceWorkspaceId: entity.workspaceId,
      destinationWorkspaceId,
      reason: "Exercise causal Undo stack reduction"
    }]
  })}\n`);
  const preview = spawnSync("node", ["dist/cli.js", "patch", "plan", patchPath, "--json"], {
    env, encoding: "utf8"
  });
  assert.equal(preview.status, 0, `${preview.stdout}\n${preview.stderr}`);
  const plan = JSON.parse(preview.stdout).data.plan;
  const applied = spawnSync("node", [
    "dist/cli.js", "patch", "apply", patchPath,
    "--yes", "--expect-digest", plan.digest, "--json"
  ], { env, encoding: "utf8" });
  assert.equal(applied.status, 0, `${applied.stdout}\n${applied.stderr}`);
  return JSON.parse(applied.stdout).data.receipt;
}

function managedApplyEvalScript(fixture, plan) {
  const executablePath = "/Applications/Zen.app/Contents/MacOS/zen";
  return [
    'import { applyStoredPlanClosedSession } from "./dist/apply-transaction.js";',
    'import { parseZenProcessInventory } from "./dist/managed-zen-lifecycle.js";',
    'import { discoverProfileContext } from "./dist/profile.js";',
    'import { loadStoredPlan } from "./dist/plans.js";',
    'let phase = "initial";',
    `const profilePath = ${JSON.stringify(fixture.profilePath)};`,
    `const executablePath = ${JSON.stringify(executablePath)};`,
    'const inventory = (rootPid, childPid, second) => parseZenProcessInventory(`',
    '${rootPid} 1 501 Sat Jul 11 16:${second}:24 2026 ${executablePath}',
    '${childPid} ${rootPid} 501 Sat Jul 11 16:${second}:24 2026 /Applications/Zen.app/Contents/MacOS/plugin-container.app/Contents/MacOS/plugin-container -profile ${profilePath} org.mozilla.machname.1 1 socket',
    '`);',
    'const platform = {',
    '  async listProcesses() {',
    '    if (phase === "closed") return [];',
    '    return phase === "initial" ? inventory(100, 101, "27") : inventory(200, 201, "28");',
    '  },',
    '  async inspectApplication(pid) { return {',
    '    pid, bundleIdentifier: "app.zen-browser.zen", executablePath, bundlePath: "/Applications/Zen.app",',
    '    version: "1.19.3b", bundleVersion: "126.3.15", teamIdentifier: "9V5K9TP787",',
    '    codeDirectoryHash: "8533af", executableDevice: 1, executableInode: 2, executableSize: 3, executableModifiedMs: 4',
    '  }; },',
    '  async inspectWindows() { return [{ visible: true, miniaturized: false, bounds: { x: 10, y: 10, width: 1000, height: 800 } }]; },',
    '  async requestGracefulQuit() { phase = "closed"; return true; },',
    '  async launch() { phase = "relaunched"; },',
    '  async wait() {}',
    '};',
    'const discovered = await discoverProfileContext();',
    'const context = { ...discovered, running: true };',
    `const stored = await loadStoredPlan(context.profile.id, ${JSON.stringify(plan.id)});`,
    'const result = await applyStoredPlanClosedSession(context, stored, {',
    `  expectedDigest: ${JSON.stringify(plan.digest)},`,
    '  command: "fixture managed multi-move Apply",',
    '  managedLifecycle: {',
    '    platform,',
    '    request: { profilePath, executablePath, uid: 501, bundleIdentifier: "app.zen-browser.zen" },',
    '    waitOptions: { timeoutMs: 100, pollMs: 1 }',
    '  }',
    '});',
    'console.log(JSON.stringify({ authorization: result.authorization, receipt: result.receipt }));'
  ].join("\n");
}

async function makeDailySortFixture() {
  const temp = await mkdtemp(join(tmpdir(), "zts-daily-sort-"));
  dailyFixtureRoots.add(temp);
  const appSupportDir = join(temp, "zen");
  const profilePath = join(appSupportDir, "Profiles", "daily.Default");
  const sessionPath = join(profilePath, "zen-sessions.jsonlz4");
  const stateDir = join(temp, "state");
  const binDir = join(temp, "bin");
  const configPath = join(temp, "config", "zen-tab-steward", "config.toml");
  await mkdir(join(profilePath, "sessionstore-backups"), { recursive: true });
  await mkdir(binDir, { recursive: true });
  await mkdir(join(temp, "config", "zen-tab-steward"), { recursive: true, mode: 0o700 });
  const fakePs = join(binDir, "ps");
  await writeFile(fakePs, "#!/bin/sh\nexit 0\n");
  await chmod(fakePs, 0o755);
  await writeFile(join(appSupportDir, "profiles.ini"), [
    "[Profile0]",
    "Name=Daily",
    "IsRelative=1",
    "Path=Profiles/daily.Default",
    "Default=1",
    ""
  ].join("\n"));
  await writeFile(join(appSupportDir, "installs.ini"), [
    "[Install]",
    "Default=Profiles/daily.Default",
    "Locked=1",
    ""
  ].join("\n"), { mode: 0o600 });
  await writeFile(join(profilePath, "compatibility.ini"), supportedCompatibilityIni());
  await writeFile(configPath, [
    "[defaults]",
    "inbox = \"Space\"",
    "min_confidence = 0.8",
    "include_pinned = false",
    "include_essentials = false",
    "apply_backend = \"auto\"",
    "",
    "[sort]",
    "from = []",
    "to = []",
    "not_to = []",
    "only = []",
    "except = []",
    "",
    "[protect.workspaces]",
    "from = [\"Stash\"]",
    "to = [\"Stash\", \"Space\"]",
    "",
    "[protect.domains]",
    "never_move = []",
    "",
    "[rules.domains]",
    "\"framer.com\" = \"Portfolio Work\"",
    "\"github.com\" = \"Tool Development\"",
    "\"example.org\" = \"Stash\"",
    ""
  ].join("\n"), { mode: 0o600 });

  const session = {
    spaces: [
      { uuid: "w-space", name: "Space" },
      { uuid: "w-stash", name: "Stash" },
      { uuid: "w-portfolio", name: "Portfolio Work" },
      { uuid: "w-tools", name: "Tool Development" }
    ],
    tabs: [
      { zenSyncId: "tab-space-framer", zenWorkspace: "w-space", pinned: false, entries: [{ url: "https://framer.com/project", title: "Framer project" }] },
      { zenSyncId: "tab-space-stash-rule", zenWorkspace: "w-space", pinned: false, entries: [{ url: "https://example.org/private", title: "Would route to Stash" }] },
      { zenSyncId: "tab-stash-github", zenWorkspace: "w-stash", pinned: false, entries: [{ url: "https://github.com/1Pio/private", title: "Protected Stash tab" }] },
      { zenSyncId: "tab-portfolio-github", zenWorkspace: "w-portfolio", pinned: false, entries: [{ url: "https://github.com/1Pio/zen-tab-steward", title: "Cross-workspace rule" }] },
      { zenSyncId: "tab-tools-framer", zenWorkspace: "w-tools", pinned: false, entries: [{ url: "https://framer.com/templates", title: "Another cross-workspace rule" }] },
      { zenSyncId: "tab-pinned-github", zenWorkspace: "w-space", pinned: true, entries: [{ url: "https://github.com/1Pio/pinned", title: "Pinned development tab" }] },
      { zenSyncId: "tab-essential-framer", zenWorkspace: "w-space", pinned: false, zenEssential: true, entries: [{ url: "https://framer.com/essential", title: "Essential portfolio tab" }] }
    ],
    folders: [],
    groups: [],
    splitViewData: []
  };
  await writeFile(sessionPath, encodeLiteralJsonLz4ForFixture(session));
  await writeFile(join(profilePath, "sessionstore-backups", "recovery.jsonlz4"), "recovery");
  await writeFile(join(profilePath, "sessionstore-backups", "previous.jsonlz4"), "previous");
  return { temp, appSupportDir, profilePath, sessionPath, stateDir, binDir, configPath };
}

async function makeLexicalSortFixture() {
  const fixture = await makeDailySortFixture();
  await writeFile(fixture.configPath, [
    "[defaults]",
    "inbox = \"Inbox\"",
    "min_confidence = 0.77",
    "include_pinned = false",
    "include_essentials = false",
    "apply_backend = \"auto\"",
    "",
    "[sort]",
    "from = []",
    "to = []",
    "not_to = []",
    "only = []",
    "except = []",
    "",
    "[semantic]",
    "enabled = false",
    "engine = \"lexical\"",
    "suggestion_threshold = 0.10",
    "auto_apply = false",
    "auto_apply_threshold = 0.95",
    "minimum_margin = 0.05",
    "max_moves = 10",
    "",
    "[protect.workspaces]",
    "from = [\"Stash\"]",
    "to = [\"Stash\"]",
    "",
    "[protect.domains]",
    "never_move = []",
    "",
    "[rules.domains]",
    ""
  ].join("\n"), { mode: 0o600 });
  await writeFile(fixture.sessionPath, encodeLiteralJsonLz4ForFixture({
    spaces: [
      { uuid: "w-inbox", name: "Inbox" },
      { uuid: "w-development", name: "Development" },
      { uuid: "w-research", name: "Research" },
      { uuid: "w-stash", name: "Stash" }
    ],
    tabs: [
      {
        zenSyncId: "tab-sort-typescript",
        zenWorkspace: "w-inbox",
        pinned: false,
        entries: [{
          url: "https://github.com/microsoft/TypeScript/issues/123",
          title: "TypeScript compiler API issue"
        }]
      },
      {
        zenSyncId: "tab-development-node",
        zenWorkspace: "w-development",
        pinned: false,
        entries: [{ url: "https://nodejs.org/api/typescript.html", title: "Node TypeScript API documentation" }]
      },
      {
        zenSyncId: "tab-development-code",
        zenWorkspace: "w-development",
        pinned: false,
        entries: [{ url: "https://github.com/nodejs/node", title: "JavaScript runtime development repository" }]
      },
      {
        zenSyncId: "tab-research-paper",
        zenWorkspace: "w-research",
        pinned: false,
        entries: [{ url: "https://arxiv.org/abs/1706.03762", title: "Machine learning transformer research paper" }]
      },
      {
        zenSyncId: "tab-stash-typescript",
        zenWorkspace: "w-stash",
        pinned: false,
        entries: [{ url: "https://typescriptlang.org/private", title: "Protected TypeScript stash" }]
      }
    ],
    folders: [],
    groups: [],
    splitViewData: []
  }));
  return fixture;
}

async function makeLexicalPriorityFixture() {
  const fixture = await makeLexicalSortFixture();
  const session = await readJsonLz4(fixture.sessionPath);
  session.tabs.unshift({
    zenSyncId: "tab-sort-research",
    zenWorkspace: "w-inbox",
    pinned: false,
    entries: [{
      url: "https://arxiv.org/abs/1706.03762",
      title: "Machine learning transformer research paper"
    }]
  });
  await writeFile(fixture.sessionPath, encodeLiteralJsonLz4ForFixture(session));
  const config = await readFile(fixture.configPath, "utf8");
  await writeFile(
    fixture.configPath,
    config
      .replace("suggestion_threshold = 0.10", "suggestion_threshold = 0.01")
      .replace("minimum_margin = 0.05", "minimum_margin = 0.0")
      .replace("max_moves = 10", "max_moves = 1"),
    { mode: 0o600 }
  );
  return fixture;
}

function supportedCompatibilityIni() {
  const osAbi = process.arch === "arm64" ? "Darwin_aarch64-gcc3" : "Darwin_x86_64-gcc3";
  return `[Compatibility]\nLastVersion=1.19.3b_20260315063056/20260315063056\nLastOSABI=${osAbi}\n`;
}

async function configureLegacyProfileAlias(fixture, name) {
  const alias = join(fixture.appSupportDir, "Profiles", name);
  await symlink(fixture.profilePath, alias);
  await writeFile(join(fixture.appSupportDir, "profiles.ini"), [
    "[Profile0]",
    "Name=Daily alias",
    "IsRelative=0",
    `Path=${alias}`,
    "Default=1",
    ""
  ].join("\n"));
  return alias;
}

function dailySortEnv(fixture) {
  return {
    ...process.env,
    HOME: fixture.temp,
    PATH: `${fixture.binDir}:${process.env.PATH ?? ""}`,
    ZTS_ZEN_APP_SUPPORT_DIR: fixture.appSupportDir,
    ZTS_STATE_DIR: fixture.stateDir,
    ZTS_CONFIG_PATH: fixture.configPath
  };
}

async function snapshotFileTree(root, current = root, result = {}) {
  const entries = await readdir(current, { withFileTypes: true });
  for (const entry of entries) {
    const path = join(current, entry.name);
    const key = relative(root, path);
    if (entry.isDirectory()) {
      result[`${key}/`] = "directory";
      await snapshotFileTree(root, path, result);
    } else {
      result[key] = (await readFile(path)).toString("base64");
    }
  }
  return result;
}

function assertExactApplyStoreAccounting(tree) {
  const accountingKey = Object.keys(tree).find((key) => key.endsWith("/store-accounting.json"));
  assert.ok(accountingKey, "Apply store accounting file is present in the state snapshot");
  const applyRoot = dirname(accountingKey);
  const applyEntries = Object.entries(tree).filter(([key]) =>
    key !== `${applyRoot}/` && key.startsWith(`${applyRoot}/`)
  );
  const accountingBytes = Buffer.from(tree[accountingKey], "base64").byteLength;
  const exactStoreBytes = applyEntries.reduce((total, [, value]) =>
    value === "directory" ? total : total + Buffer.from(value, "base64").byteLength, 0
  ) - accountingBytes + APPLY_STORE_ACCOUNTING_MAX_BYTES;
  const accounting = JSON.parse(Buffer.from(tree[accountingKey], "base64").toString("utf8"));
  assert.equal(accounting.schemaVersion, "zts.apply-store-accounting.provisional-5");
  assert.equal(accounting.activeReservation, null);
  assert.ok(accounting.settledMarkerCredit);
  assert.equal(
    applyEntries.some(([key, value]) =>
      value !== "directory"
      && key.startsWith(`${applyRoot}/unfinished/`)
      && !key.endsWith("/index.json")
    ),
    false
  );
  assert.equal(
    accounting.baselineBytes - accounting.settledMarkerCredit.bytes,
    exactStoreBytes
  );
  assert.equal(
    accounting.baselineEntries - accounting.settledMarkerCredit.entries,
    applyEntries.length,
    `Apply entry ledger mismatch:\n${applyEntries.map(([key]) => key).join("\n")}`
  );
  return {
    effectiveBytes: exactStoreBytes,
    effectiveEntries: applyEntries.length,
    baselineBytes: accounting.baselineBytes,
    baselineEntries: accounting.baselineEntries,
    revision: accounting.revision
  };
}

function actionFor(plan, entityRef) {
  return plan.actions.find((action) =>
    (action.disposition === "move" ? action.operation.entityRef : action.entityRef) === entityRef
  );
}

function actionEntityRef(action) {
  return action.disposition === "move" ? action.operation.entityRef : action.entityRef;
}
