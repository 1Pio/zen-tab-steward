import assert from "node:assert/strict";
import test from "node:test";
import { execFile, spawnSync } from "node:child_process";
import { access, chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { encodeLiteralJsonLz4ForFixture, readJsonLz4 } from "../dist/mozlz4.js";

const execFileAsync = promisify(execFile);

test("CLI smokes cover reads, backup preview, and exact saved-Plan sort apply", async () => {
  const fixture = await makeZenFixture();
  const env = {
    ...process.env,
    HOME: fixture.temp,
    PATH: `${fixture.binDir}:${process.env.PATH ?? ""}`,
    ZTS_ZEN_APP_SUPPORT_DIR: fixture.appSupportDir,
    ZTS_STATE_DIR: fixture.stateDir,
    ZTS_CONFIG_PATH: join(fixture.temp, "config", "zen-tab-steward", "config.toml")
  };

  const help = await execFileAsync("node", ["dist/cli.js", "--help"], { env });
  assert.match(help.stdout, /Zen Tab Steward/);

  const applyHelp = await execFileAsync("node", ["dist/cli.js", "apply", "--help"], { env });
  assert.match(applyHelp.stdout, /--manage-zen/);
  assert.match(applyHelp.stdout, /graceful Zen\s+quit and exact relaunch/);

  const version = await execFileAsync("node", ["dist/cli.js", "--version"], { env });
  assert.match(version.stdout, /^0\.1\.0/);

  const status = await execFileAsync("node", ["dist/cli.js", "status", "--json"], { env });
  const statusJson = JSON.parse(status.stdout);
  assert.equal(statusJson.ok, true);
  assert.equal(statusJson.data.profile.name, "Default");
  assert.equal(statusJson.data.session.workspaceCount, 3);
  assert.equal(statusJson.data.session.tabCount, 4);
  assert.equal(statusJson.data.closedSessionApply.status, "checked_at_apply");
  assert.equal(statusJson.data.closedSessionApply.mutationAuthorityEstablished, false);
  assert.match(statusJson.data.closedSessionApply.reason, /checked atomically at apply time/);

  const bridge = await execFileAsync("node", ["dist/cli.js", "bridge", "status", "--json"], { env });
  const bridgeJson = JSON.parse(bridge.stdout);
  assert.equal(bridgeJson.ok, true);
  assert.equal(bridgeJson.data.bridge.liveBackend.status, "unavailable");
  assert.equal(bridgeJson.data.bridge.liveBackend.applySupported, false);
  assert.match(bridgeJson.data.bridge.liveBackend.reason, /production live tab mutation is unavailable/);

  const bridgeDoctor = await execFileAsync("node", ["dist/cli.js", "bridge", "doctor"], { env });
  assert.match(bridgeDoctor.stdout, /Zen live bridge doctor/);
  assert.match(bridgeDoctor.stdout, /Live backend: unavailable/);
  assert.match(bridgeDoctor.stdout, /Production live mutation/);
  assert.match(bridgeDoctor.stdout, /Required launch evidence/);

  const bridgeLiveCheck = spawnSync("node", ["dist/cli.js", "bridge", "live-check", "--json"], {
    env,
    encoding: "utf8"
  });
  assert.equal(bridgeLiveCheck.status, 2);
  const bridgeLiveCheckJson = JSON.parse(bridgeLiveCheck.stdout);
  assert.equal(bridgeLiveCheckJson.ok, false);
  assert.equal(bridgeLiveCheckJson.data.liveCheck.attachable, false);
  assert.match(bridgeLiveCheckJson.blockers.join("\n"), /No Zen process is running/);

  const bridgeLiveRead = spawnSync("node", ["dist/cli.js", "bridge", "live-read", "--json"], {
    env,
    encoding: "utf8"
  });
  assert.equal(bridgeLiveRead.status, 2);
  const bridgeLiveReadJson = JSON.parse(bridgeLiveRead.stdout);
  assert.equal(bridgeLiveReadJson.ok, false);
  assert.equal(bridgeLiveReadJson.data.receipt.readProof, null);
  assert.match(bridgeLiveReadJson.blockers.join("\n"), /No Zen process is running/);

  const unknownBridge = spawnSync("node", ["dist/cli.js", "bridge", "start", "--json"], {
    env,
    encoding: "utf8"
  });
  assert.equal(unknownBridge.status, 1);
  assert.match(JSON.parse(unknownBridge.stdout).blockers.join("\n"), /unknown bridge action/);

  const invalidProbeTimeout = spawnSync("node", ["dist/cli.js", "bridge", "probe", "--timeout-ms", "1", "--json"], {
    env,
    encoding: "utf8"
  });
  assert.equal(invalidProbeTimeout.status, 1);
  assert.match(JSON.parse(invalidProbeTimeout.stdout).blockers.join("\n"), /timeout-ms/);

  const workspaces = await execFileAsync("node", ["dist/cli.js", "workspaces"], { env });
  assert.match(workspaces.stdout, /Space/);
  assert.match(workspaces.stdout, /Stash/);
  assert.match(workspaces.stdout, /sortable from/);

  const workspacesJsonResult = await execFileAsync("node", ["dist/cli.js", "workspaces", "--json"], { env });
  const workspacesJson = JSON.parse(workspacesJsonResult.stdout);
  assert.match(workspacesJson.data.capturedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(workspacesJson.data.controlRoute, "closed_session");

  const tabs = await execFileAsync("node", ["dist/cli.js", "tabs", "Space", "--json"], { env });
  const tabsJson = JSON.parse(tabs.stdout);
  assert.equal(tabsJson.ok, true);
  assert.match(tabsJson.data.capturedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(tabsJson.data.controlRoute, "closed_session");
  assert.equal(tabsJson.data.tabs.length, 3);
  assert.equal(tabsJson.data.tabs[0].workspace.name, "Space");
  assert.equal(tabsJson.data.tabs[0].workspace.contentTrust, "browser_untrusted");
  assert.equal(tabsJson.data.tabs[0].member.contentTrust, "browser_untrusted");
  assert.equal(tabsJson.data.tabs[0].contentTrust, "browser_untrusted");

  const selectedTabs = await execFileAsync("node", [
    "dist/cli.js", "tabs", "--workspaces", "Space,Stash", "--json"
  ], { env });
  const selectedTabsJson = JSON.parse(selectedTabs.stdout);
  assert.equal(selectedTabsJson.ok, true);
  assert.deepEqual(selectedTabsJson.data.workspaceScope, {
    kind: "selected",
    workspaces: [
      { id: "w1", name: "Space" },
      { id: "w2", name: "Stash" }
    ]
  });
  assert.equal(selectedTabsJson.data.tabs.length, 4);
  assert.equal(selectedTabsJson.data.tabs.every((tab) => ["w1", "w2"].includes(tab.workspace.id)), true);
  assert.equal(selectedTabsJson.data.tabs.every((tab) =>
    typeof tab.entityRef === "string"
      && typeof tab.entityRevision === "string"
      && typeof tab.structuralRootRef === "string"
  ), true);

  const allTabs = await execFileAsync("node", ["dist/cli.js", "tabs", "--all", "--json"], { env });
  const allTabsJson = JSON.parse(allTabs.stdout);
  assert.equal(allTabsJson.ok, true);
  assert.deepEqual(allTabsJson.data.workspaceScope, { kind: "all", workspaces: [] });
  assert.equal(allTabsJson.data.tabs.length, 4);

  const conflictingTabScope = spawnSync("node", [
    "dist/cli.js", "tabs", "Space", "--all", "--json"
  ], { env, encoding: "utf8" });
  assert.equal(conflictingTabScope.status, 1, `${conflictingTabScope.stdout}\n${conflictingTabScope.stderr}`);
  assert.match(JSON.parse(conflictingTabScope.stdout).blockers.join("\n"), /choose one tab scope/iu);

  const snapshot = await execFileAsync("node", ["dist/cli.js", "snapshot", "--json"], { env });
  const snapshotJson = JSON.parse(snapshot.stdout);
  assert.equal(snapshotJson.ok, true);
  assert.equal(snapshotJson.data.snapshot.authority, "authoritative");
  const spaceWorkspace = snapshotJson.data.snapshot.workspaces.find((workspace) => workspace.name === "Space");
  const portfolioWorkspace = snapshotJson.data.snapshot.workspaces.find((workspace) => workspace.name === "Portfolio");
  assert.ok(spaceWorkspace);
  assert.ok(portfolioWorkspace);
  const manualEntity = snapshotJson.data.snapshot.entities.find((entity) =>
    entity.kind === "tab" && entity.workspaceId === spaceWorkspace.id && !entity.protection.protected
  );
  assert.ok(manualEntity);
  const listedManualTab = allTabsJson.data.tabs.find((tab) => tab.entityRef === manualEntity.ref);
  assert.ok(listedManualTab);
  const agentDiff = {
    schemaVersion: "zts.diff.provisional-1",
    snapshotRevision: allTabsJson.data.snapshotRevision,
    moves: [
      {
        entityRef: listedManualTab.entityRef,
        fromWorkspaceId: listedManualTab.workspace.id,
        toWorkspaceId: portfolioWorkspace.id,
        reason: "Move the listed Framer project tab into Portfolio"
      }
    ]
  };
  const diffPlan = spawnSync("node", ["dist/cli.js", "diff", "plan", "--stdin", "--manage-zen", "--json"], {
    env,
    input: JSON.stringify(agentDiff),
    encoding: "utf8"
  });
  assert.equal(diffPlan.status, 0, `${diffPlan.stdout}\n${diffPlan.stderr}`);
  const diffPlanJson = JSON.parse(diffPlan.stdout);
  assert.equal(diffPlanJson.ok, true);
  assert.deepEqual(diffPlanJson.data.managedLifecycle, {
    requested: true,
    performed: false,
    quit: "not_needed",
    relaunch: "not_needed",
    lifecycleBindingRevision: null,
    relaunchedBindingRevision: null
  });
  assert.equal(diffPlanJson.data.patch.snapshotRevision, allTabsJson.data.snapshotRevision);
  assert.equal(diffPlanJson.data.plan.snapshotRevision, allTabsJson.data.snapshotRevision);
  assert.equal(diffPlanJson.data.plan.actions[0].operation.entityRef, listedManualTab.entityRef);
  assert.equal(diffPlanJson.data.plan.actions[0].operation.precondition.sourceWorkspace.workspaceId, listedManualTab.workspace.id);
  assert.equal(diffPlanJson.data.plan.actions[0].operation.expectedPostState.workspaceId, portfolioWorkspace.id);
  assert.match(diffPlanJson.data.plan.digest, /^sha256:[a-f0-9]{64}$/u);
  assert.match(diffPlanJson.suggestedNextCommands[0], /--manage-zen/iu);
  assert.match(diffPlanJson.suggestedNextCommands[0], /zts apply/iu);

  const staleAgentDiff = spawnSync("node", ["dist/cli.js", "diff", "plan", "--stdin", "--json"], {
    env,
    input: JSON.stringify({
      ...agentDiff,
      snapshotRevision: "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"
    }),
    encoding: "utf8"
  });
  assert.equal(staleAgentDiff.status, 1, `${staleAgentDiff.stdout}\n${staleAgentDiff.stderr}`);
  assert.match(JSON.parse(staleAgentDiff.stdout).blockers.join("\n"), /listed Snapshot revision.+does not match current Snapshot/iu);

  const unboundAgentDiff = spawnSync("node", ["dist/cli.js", "diff", "plan", "--stdin", "--json"], {
    env,
    input: JSON.stringify({ schemaVersion: agentDiff.schemaVersion, moves: agentDiff.moves }),
    encoding: "utf8"
  });
  assert.equal(unboundAgentDiff.status, 1, `${unboundAgentDiff.stdout}\n${unboundAgentDiff.stderr}`);
  assert.match(JSON.parse(unboundAgentDiff.stdout).blockers.join("\n"), /snapshotRevision/iu);

  const manualPatch = {
    operations: [
      {
        op: "move",
        entityRef: manualEntity.ref,
        expectedSourceWorkspaceId: spaceWorkspace.id,
        destinationWorkspaceId: portfolioWorkspace.id,
        reason: "Manual exact move from CLI smoke"
      }
    ]
  };
  const manualPlan = spawnSync("node", ["dist/cli.js", "patch", "plan", "-", "--json"], {
    env,
    input: JSON.stringify(manualPatch),
    encoding: "utf8"
  });
  assert.equal(manualPlan.status, 0);
  const manualPlanJson = JSON.parse(manualPlan.stdout);
  assert.equal(manualPlanJson.ok, true);
  assert.equal(manualPlanJson.data.summary.moveCount, 1);
  assert.match(manualPlanJson.suggestedNextCommands[0], /zts plan show/iu);
  assert.equal(manualPlanJson.suggestedNextCommands.some((command) => command.includes("--yes")), false);
  assert.equal(manualPlanJson.data.plan.source.kind, "manual_patch");
  assert.equal(manualPlanJson.data.plan.actions[0].operation.entityRef, manualEntity.ref);
  assert.equal(manualPlanJson.data.plan.actions[0].operation.expectedPostState.workspaceId, portfolioWorkspace.id);

  const patchLiveApply = spawnSync("node", [
    "dist/cli.js",
    "patch",
    "apply",
    "-",
    "--yes",
    "--expect-digest",
    manualPlanJson.data.plan.digest,
    "--backend",
    "live",
    "--json"
  ], {
    env,
    input: JSON.stringify(manualPatch),
    encoding: "utf8"
  });
  assert.equal(patchLiveApply.status, 2, `${patchLiveApply.stdout}\n${patchLiveApply.stderr}`);
  assert.equal(patchLiveApply.stderr, "");
  const liveRouteBlocker = JSON.parse(patchLiveApply.stdout).blockers[0];
  assert.match(liveRouteBlocker, /production live mutation is unavailable.+never falls back/iu);

  const stalePatch = {
    schemaVersion: "zts.patch.provisional-1",
    snapshotRevision: "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
    operations: manualPatch.operations.map((operation) => ({
      ...operation,
      reason: {
        value: operation.reason,
        provenance: "caller_untrusted",
        interpretation: "data_only",
        referencedEntityRefs: [operation.entityRef]
      }
    }))
  };
  const stalePlan = spawnSync("node", ["dist/cli.js", "patch", "plan", "-", "--json"], {
    env,
    input: JSON.stringify(stalePatch),
    encoding: "utf8"
  });
  assert.equal(stalePlan.status, 1);
  assert.match(JSON.parse(stalePlan.stdout).blockers.join("\n"), /exact Snapshot/);

  const backup = await execFileAsync("node", ["dist/cli.js", "backup", "--json"], { env });
  const backupJson = JSON.parse(backup.stdout);
  assert.equal(backupJson.ok, true);
  assert.equal(backupJson.data.manifest.files.length, 3);
  const preSortBackupId = backupJson.data.manifest.id;

  const backupList = await execFileAsync("node", ["dist/cli.js", "backup", "list", "--json"], { env });
  const backupListJson = JSON.parse(backupList.stdout);
  assert.equal(backupListJson.ok, true);
  assert.equal(backupListJson.data.backups.length, 1);

  const backupPruneDryRun = await execFileAsync("node", ["dist/cli.js", "backup", "prune", "--dry-run", "--before", "2999-01-01T00:00:00.000Z", "--json"], { env });
  const backupPruneDryRunJson = JSON.parse(backupPruneDryRun.stdout);
  assert.equal(backupPruneDryRunJson.ok, true);
  assert.equal(backupPruneDryRunJson.data.receipt.dryRun, true);
  assert.equal(backupPruneDryRunJson.data.receipt.prunedCount, 1);

  const backupPruneMissingSelector = spawnSync("node", ["dist/cli.js", "backup", "prune", "--json"], {
    env,
    encoding: "utf8"
  });
  assert.equal(backupPruneMissingSelector.status, 1);
  assert.match(JSON.parse(backupPruneMissingSelector.stdout).blockers.join("\n"), /requires --before/);

  const unmatchedRule = await execFileAsync("node", ["dist/cli.js", "rules", "test", "github.com", "--json"], { env });
  assert.equal(JSON.parse(unmatchedRule.stdout).data.match, null);

  const initialRule = await execFileAsync("node", ["dist/cli.js", "rules", "add", "domain", "framer.com", "Portfolio", "--json"], { env });
  assert.equal(JSON.parse(initialRule.stdout).data.workspace.name, "Portfolio");
  const configuredRule = await execFileAsync("node", ["dist/cli.js", "rules", "test", "https://framer.com/project", "--json"], { env });
  assert.deepEqual(JSON.parse(configuredRule.stdout).data.match, {
    workspaceName: "Portfolio",
    matchedPattern: "framer.com",
    workspaceId: "w3",
    workspaceSelector: "w3"
  });
  const invalidRuleDestination = spawnSync("node", [
    "dist/cli.js", "rules", "add", "domain", "invalid.example", "Missing Workspace", "--json"
  ], { env, encoding: "utf8" });
  assert.equal(invalidRuleDestination.status, 1);
  assert.match(JSON.parse(invalidRuleDestination.stdout).blockers.join("\n"), /Destination Workspace not found/);

  const sort = spawnSync("node", ["dist/cli.js", "sort", "Space", "--preview", "--json"], {
    env,
    encoding: "utf8"
  });
  assert.equal(sort.status, 0);
  const sortJson = JSON.parse(sort.stdout);
  assert.equal(sortJson.ok, true);
  assert.equal(sortJson.data.applied, false);
  assert.equal(sortJson.data.mode, "preview");
  assert.equal(sortJson.data.planResolution, "created");
  assert.equal(sortJson.data.summary.moveCount, 1);
  assert.equal(sortJson.data.summary.protectedCount >= 1, true);
  assert.equal(sortJson.data.plan.source.kind, "engine");
  assert.equal(sortJson.data.plan.actions.some((action) => action.disposition === "move"), true);
  const sortPlanId = sortJson.data.plan.id;
  const sortPlanDigest = sortJson.data.plan.digest;
  assert.match(sortPlanDigest, /^sha256:[a-f0-9]{64}$/);

  const sortDryRunHuman = spawnSync("node", ["dist/cli.js", "sort", "Space", "--dry-run"], {
    env,
    encoding: "utf8"
  });
  assert.equal(sortDryRunHuman.status, 0);
  assert.match(sortDryRunHuman.stdout, /Sort dry run · Space/);
  assert.match(sortDryRunHuman.stdout, new RegExp(sortPlanId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(sortDryRunHuman.stdout, /Reused exact state-bound Plan/);
  assert.match(sortDryRunHuman.stdout, /Actions:/);
  assert.match(sortDryRunHuman.stdout, /decision:/);
  assert.match(sortDryRunHuman.stdout, /policy:/);

  const review = await execFileAsync("node", ["dist/cli.js", "review", sortPlanId, "--json"], { env });
  const reviewJson = JSON.parse(review.stdout);
  assert.equal(reviewJson.ok, true);
  assert.equal(reviewJson.data.plan.digest, sortPlanDigest);
  assert.equal(reviewJson.data.summary.reviewCount, 1);
  const structuredReviewEntity = reviewJson.data.snapshot.entities.find((entity) =>
    entity.kind === "zen_folder" && entity.nativeId === "g1"
  );
  assert.ok(structuredReviewEntity);
  assert.equal(reviewJson.data.attentionActions.some((action) =>
    action.disposition === "review" && action.entityRef === structuredReviewEntity.ref
  ), true);
  assert.equal(reviewJson.data.attentionActions.some((action) => action.disposition === "protected"), true);
  // Reconstruction is truthful now; capability-aware planner disposition for
  // unsupported structured mutation is a separate follow-up.
  assert.equal(reviewJson.data.snapshot.revision, reviewJson.data.plan.snapshotRevision);

  const reviewHuman = await execFileAsync("node", ["dist/cli.js", "review", sortPlanId], { env });
  assert.match(reviewHuman.stdout, /Saved Plan review/);
  assert.match(reviewHuman.stdout, /github\.com/);
  assert.match(reviewHuman.stdout, /decision:/);
  assert.match(reviewHuman.stdout, /policy:/);

  const sortWithKnownFlags = spawnSync(
    "node",
    [
      "dist/cli.js",
      "sort",
      "Space",
      "--preview",
      "--include-pinned",
      "--to",
      "Portfolio,Tool Development",
      "--not-to",
      "Stash",
      "--only",
      "github.com,*.framer.com",
      "--except",
      "youtube.com",
      "--limit",
      "1",
      "--backend",
      "session",
      "--json"
    ],
    { env, encoding: "utf8" }
  );
  assert.equal(sortWithKnownFlags.status, 0);
  const sortWithKnownFlagsJson = JSON.parse(sortWithKnownFlags.stdout);
  assert.equal(sortWithKnownFlagsJson.ok, true);
  assert.equal(sortWithKnownFlagsJson.data.plan.actions.length > 0, true);
  assert.notEqual(sortWithKnownFlagsJson.data.plan.digest, sortPlanDigest);

  const rulesConfidence = spawnSync("node", [
    "dist/cli.js", "sort", "Space", "--preview", "--min-confidence", "0.85", "--json"
  ], { env, encoding: "utf8" });
  assert.equal(rulesConfidence.status, 1);
  assert.match(JSON.parse(rulesConfidence.stdout).blockers.join("\n"), /exact rules have no confidence threshold/);

  const invalidConfidence = spawnSync("node", ["dist/cli.js", "sort", "Space", "--min-confidence", "nope", "--json"], {
    env,
    encoding: "utf8"
  });
  assert.equal(invalidConfidence.status, 1);
  assert.match(JSON.parse(invalidConfidence.stdout).blockers.join("\n"), /min-confidence/);

  const invalidBackend = spawnSync("node", ["dist/cli.js", "sort", "Space", "--backend", "bogus", "--json"], {
    env,
    encoding: "utf8"
  });
  assert.equal(invalidBackend.status, 1);
  assert.match(JSON.parse(invalidBackend.stdout).blockers.join("\n"), /backend/);

  const invalidLimit = spawnSync("node", ["dist/cli.js", "sort", "Space", "--limit", "1.5", "--json"], {
    env,
    encoding: "utf8"
  });
  assert.equal(invalidLimit.status, 1);
  assert.match(JSON.parse(invalidLimit.stdout).blockers.join("\n"), /limit/);

  const limitedSort = spawnSync("node", ["dist/cli.js", "sort", "Space", "--preview", "--limit", "0", "--json"], {
    env,
    encoding: "utf8"
  });
  assert.equal(limitedSort.status, 0);
  const limitedSortJson = JSON.parse(limitedSort.stdout);
  assert.equal(limitedSortJson.data.summary.moveCount, 0);
  assert.equal(limitedSortJson.data.plan.actions.some((action) =>
    action.disposition === "review" && action.candidateDestinationWorkspaceId === portfolioWorkspace.id
  ), true);

  const sortApplyWithoutDigest = spawnSync("node", ["dist/cli.js", "sort", "Space", "--apply", "--yes", "--json"], {
    env,
    encoding: "utf8"
  });
  assert.equal(sortApplyWithoutDigest.status, 1);
  const sortApplyWithoutDigestJson = JSON.parse(sortApplyWithoutDigest.stdout);
  assert.equal(sortApplyWithoutDigestJson.ok, false);
  assert.match(sortApplyWithoutDigestJson.blockers.join("\n"), /requires --expect-digest/);

  const plainSort = spawnSync("node", ["dist/cli.js", "sort", "Space", "--json"], {
    env,
    encoding: "utf8"
  });
  assert.equal(plainSort.status, 0);
  const plainSortJson = JSON.parse(plainSort.stdout);
  assert.equal(plainSortJson.ok, true);
  assert.equal(plainSortJson.data.mode, "preview");
  assert.equal(plainSortJson.data.applied, false);
  assert.equal(plainSortJson.data.plan.digest, sortPlanDigest);
  assert.equal(plainSortJson.data.planResolution, "reused_latest");
  const unchangedSession = await readJsonLz4(join(fixture.profilePath, "zen-sessions.jsonlz4"));
  assert.equal(unchangedSession.tabs[2].zenWorkspace, "w1");

  const unattendedApplyWithoutConsent = spawnSync("node", [
    "dist/cli.js",
    "apply",
    sortPlanId,
    "--expect-digest",
    sortPlanDigest,
    "--json"
  ], {
    env,
    encoding: "utf8"
  });
  assert.equal(unattendedApplyWithoutConsent.status, 2);
  const unattendedApplyWithoutConsentJson = JSON.parse(unattendedApplyWithoutConsent.stdout);
  assert.equal(unattendedApplyWithoutConsentJson.ok, false);
  assert.equal(unattendedApplyWithoutConsentJson.data.applied, false);
  assert.match(unattendedApplyWithoutConsentJson.blockers.join("\n"), /Confirm the exact saved Plan/);
  const stillUnchangedSession = await readJsonLz4(join(fixture.profilePath, "zen-sessions.jsonlz4"));
  assert.equal(stillUnchangedSession.tabs[2].zenWorkspace, "w1");

  const wrongDigestApply = spawnSync("node", [
    "dist/cli.js",
    "apply",
    sortPlanId,
    "--yes",
    "--expect-digest",
    "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
    "--json"
  ], {
    env,
    encoding: "utf8"
  });
  assert.equal(wrongDigestApply.status, 1);
  assert.match(JSON.parse(wrongDigestApply.stdout).blockers.join("\n"), /does not match selected Plan/);
  const unchangedAfterWrongDigest = await readJsonLz4(join(fixture.profilePath, "zen-sessions.jsonlz4"));
  assert.equal(unchangedAfterWrongDigest.tabs[2].zenWorkspace, "w1");

  const savedPlanLiveApply = spawnSync("node", [
    "dist/cli.js", "apply", sortPlanId, "--yes", "--expect-digest", sortPlanDigest, "--backend", "live", "--json"
  ], { env, encoding: "utf8" });
  assert.equal(savedPlanLiveApply.status, 2, `${savedPlanLiveApply.stdout}\n${savedPlanLiveApply.stderr}`);
  assert.equal(savedPlanLiveApply.stderr, "");
  assert.equal(JSON.parse(savedPlanLiveApply.stdout).blockers[0], liveRouteBlocker);

  const sortLiveApply = spawnSync("node", [
    "dist/cli.js", "sort", "Space", "--apply", "--yes", "--expect-digest", sortPlanDigest,
    "--backend", "live", "--json"
  ], { env, encoding: "utf8" });
  assert.equal(sortLiveApply.status, 2, `${sortLiveApply.stdout}\n${sortLiveApply.stderr}`);
  assert.equal(sortLiveApply.stderr, "");
  assert.equal(JSON.parse(sortLiveApply.stdout).blockers[0], liveRouteBlocker);
  assert.equal((await readJsonLz4(join(fixture.profilePath, "zen-sessions.jsonlz4"))).tabs[2].zenWorkspace, "w1");

  const explicitApply = spawnSync("node", [
    "dist/cli.js",
    "sort",
    "Space",
    "--apply",
    "--yes",
    "--expect-digest",
    sortPlanDigest,
    "--json"
  ], {
    env,
    encoding: "utf8"
  });
  assert.equal(explicitApply.status, 0, `${explicitApply.stdout}\n${explicitApply.stderr}`);
  const explicitApplyJson = JSON.parse(explicitApply.stdout);
  assert.equal(explicitApplyJson.ok, true);
  assert.equal(explicitApplyJson.data.applied, true);
  assert.equal(explicitApplyJson.data.plan.id, sortPlanId);
  assert.equal(explicitApplyJson.data.plan.digest, sortPlanDigest);
  assert.equal(explicitApplyJson.data.receipt.planDigest, sortPlanDigest);
  assert.equal(explicitApplyJson.data.summary.moveCount, 1);
  const applyReceiptId = explicitApplyJson.data.receipt.id;
  const appliedSession = await readJsonLz4(join(fixture.profilePath, "zen-sessions.jsonlz4"));
  assert.equal(appliedSession.tabs[2].zenWorkspace, "w3");

  const applyList = await execFileAsync("node", ["dist/cli.js", "apply", "list", "--json"], { env });
  const applyListJson = JSON.parse(applyList.stdout);
  assert.equal(applyListJson.ok, true);
  assert.equal(applyListJson.data.history.kind, "saved_plan");
  assert.equal(applyListJson.data.receipts.length, 1);
  assert.equal(applyListJson.data.receipts[0].id, applyReceiptId);
  assert.equal(applyListJson.data.receipts[0].planDigest, sortPlanDigest);

  const applyVerify = await execFileAsync("node", ["dist/cli.js", "apply", "verify", applyReceiptId, "--json"], { env });
  const applyVerifyJson = JSON.parse(applyVerify.stdout);
  assert.equal(applyVerifyJson.ok, true);
  assert.equal(applyVerifyJson.data.report.verification.checkedOperations, 1);

  const restoreApplied = spawnSync("node", ["dist/cli.js", "backup", "restore", preSortBackupId, "--json"], {
    env,
    encoding: "utf8"
  });
  assert.equal(restoreApplied.status, 2);
  const restoreAppliedJson = JSON.parse(restoreApplied.stdout);
  assert.equal(restoreAppliedJson.ok, false);
  assert.equal(restoreAppliedJson.data.preview.backupId, preSortBackupId);
  assert.equal(restoreAppliedJson.data.preview.executable, false);
  assert.match(restoreAppliedJson.blockers.join("\n"), /production-disabled/);
  const sessionAfterBlockedRestore = await readJsonLz4(join(fixture.profilePath, "zen-sessions.jsonlz4"));
  assert.equal(sessionAfterBlockedRestore.tabs[2].zenWorkspace, "w3");

  const applyVerifyAfterRestore = spawnSync("node", ["dist/cli.js", "apply", "verify", applyReceiptId, "--json"], {
    env,
    encoding: "utf8"
  });
  assert.equal(applyVerifyAfterRestore.status, 0);
  const applyVerifyAfterRestoreJson = JSON.parse(applyVerifyAfterRestore.stdout);
  assert.equal(applyVerifyAfterRestoreJson.ok, true);
  assert.equal(applyVerifyAfterRestoreJson.data.report.verification.mismatchCount, 0);

  const sortWithUnknownFlag = spawnSync("node", ["dist/cli.js", "sort", "Space", "--typo"], {
    env,
    encoding: "utf8"
  });
  assert.equal(sortWithUnknownFlag.status, 1);
  assert.match(sortWithUnknownFlag.stderr, /unknown option '--typo'/);

  const conflictingSortModes = spawnSync("node", ["dist/cli.js", "sort", "Space", "--preview", "--apply", "--yes", "--json"], {
    env,
    encoding: "utf8"
  });
  assert.equal(conflictingSortModes.status, 1);
  assert.match(JSON.parse(conflictingSortModes.stdout).blockers.join("\n"), /cannot be combined/);

  const conflictingReadModes = spawnSync("node", ["dist/cli.js", "sort", "Space", "--preview", "--dry-run", "--json"], {
    env,
    encoding: "utf8"
  });
  assert.equal(conflictingReadModes.status, 1);
  assert.match(JSON.parse(conflictingReadModes.stdout).blockers.join("\n"), /cannot be combined/);

  const yesWithoutApply = spawnSync("node", ["dist/cli.js", "sort", "Space", "--yes", "--json"], {
    env,
    encoding: "utf8"
  });
  assert.equal(yesWithoutApply.status, 1);
  assert.match(JSON.parse(yesWithoutApply.stdout).blockers.join("\n"), /requires --apply/);

  const missingSort = spawnSync(
    "node",
    ["dist/cli.js", "sort", "Missing Workspace", "--preview", "--to", "Portfolio", "--json"],
    {
      env,
      encoding: "utf8"
    }
  );
  assert.equal(missingSort.status, 1);
  const missingSortJson = JSON.parse(missingSort.stdout);
  assert.match(missingSortJson.blockers.join("\n"), /Source workspace not found/);
  assert.deepEqual(missingSortJson.data.inputs.to, ["Portfolio"]);
  assert.equal(missingSortJson.data.inputs.preview, true);

  const restore = spawnSync("node", ["dist/cli.js", "backup", "restore", "missing", "--json"], {
    env,
    encoding: "utf8"
  });
  assert.equal(restore.status, 1);
  assert.equal(JSON.parse(restore.stdout).ok, false);

  const configPath = await execFileAsync("node", ["dist/cli.js", "config", "path"], { env });
  assert.equal(configPath.stdout.trim(), env.ZTS_CONFIG_PATH);

  const configSet = await execFileAsync("node", ["dist/cli.js", "config", "set", "defaults.min_confidence", "0.95", "--json"], { env });
  assert.equal(JSON.parse(configSet.stdout).data.value, 0.95);

  const backendSet = await execFileAsync("node", ["dist/cli.js", "config", "set", "defaults.apply_backend", "session", "--json"], { env });
  assert.equal(JSON.parse(backendSet.stdout).data.value, "session");

  const protectSet = await execFileAsync("node", ["dist/cli.js", "config", "set", "protect.workspaces.from", "Stash", "--json"], { env });
  assert.deepEqual(JSON.parse(protectSet.stdout).data.value, ["Stash"]);

  const sortFromSet = await execFileAsync("node", ["dist/cli.js", "config", "set", "sort.from", "Space", "--json"], { env });
  assert.deepEqual(JSON.parse(sortFromSet.stdout).data.value, ["Space"]);

  await execFileAsync("node", ["dist/cli.js", "config", "set", "sort.not_to", "Portfolio", "--json"], { env });
  const policyWorkspaces = JSON.parse((await execFileAsync(
    "node", ["dist/cli.js", "workspaces", "--json"], { env }
  )).stdout).data.workspaces;
  assert.equal(policyWorkspaces.find((view) => view.workspace.name === "Space").sortableFrom, true);
  assert.equal(policyWorkspaces.find((view) => view.workspace.name === "Portfolio").sortableFrom, false);
  assert.equal(policyWorkspaces.find((view) => view.workspace.name === "Portfolio").sortableTo, false);
  await execFileAsync("node", ["dist/cli.js", "config", "set", "sort.not_to", "", "--json"], { env });

  await execFileAsync("node", ["dist/cli.js", "config", "set", "defaults.inbox", "Stash", "--json"], { env });

  const rulesAdd = await execFileAsync("node", ["dist/cli.js", "rules", "add", "domain", "docs.example.com", "Portfolio", "--json"], { env });
  assert.equal(JSON.parse(rulesAdd.stdout).data.workspace.name, "Portfolio");

  const rulesTest = await execFileAsync("node", ["dist/cli.js", "rules", "test", "https://docs.example.com/page", "--json"], { env });
  assert.equal(JSON.parse(rulesTest.stdout).data.match.workspaceName, "Portfolio");

  const sortWithConfigDefaults = spawnSync("node", ["dist/cli.js", "sort", "Space", "--preview", "--json"], {
    env,
    encoding: "utf8"
  });
  assert.equal(sortWithConfigDefaults.status, 0);
  const sortWithConfigDefaultsJson = JSON.parse(sortWithConfigDefaults.stdout);
  assert.equal(sortWithConfigDefaultsJson.ok, true);
  assert.equal(sortWithConfigDefaultsJson.data.sourceScope.workspaceName, "Space");
  assert.match(sortWithConfigDefaultsJson.data.plan.configRevision, /^sha256:[a-f0-9]{64}$/);

  const sortWithDefaultInbox = spawnSync("node", ["dist/cli.js", "sort", "--preview", "--json"], {
    env,
    encoding: "utf8"
  });
  assert.equal(sortWithDefaultInbox.status, 0);
  assert.equal(JSON.parse(sortWithDefaultInbox.stdout).data.sourceScope.workspaceName, "Stash");
  assert.equal(JSON.parse(sortWithDefaultInbox.stdout).data.plan.actions.some((action) => action.disposition === "protected"), true);
});

test("manual Patch Plan applies only by exact digest through canonical apply history", async () => {
  const fixture = await makeZenFixture();
  const env = {
    ...process.env,
    HOME: fixture.temp,
    PATH: `${fixture.binDir}:${process.env.PATH ?? ""}`,
    ZTS_ZEN_APP_SUPPORT_DIR: fixture.appSupportDir,
    ZTS_STATE_DIR: fixture.stateDir,
    ZTS_CONFIG_PATH: join(fixture.temp, "config", "zen-tab-steward", "config.toml")
  };

  const snapshot = await execFileAsync("node", ["dist/cli.js", "snapshot", "--json"], { env });
  const snapshotJson = JSON.parse(snapshot.stdout);
  const spaceWorkspace = snapshotJson.data.snapshot.workspaces.find((workspace) => workspace.name === "Space");
  const portfolioWorkspace = snapshotJson.data.snapshot.workspaces.find((workspace) => workspace.name === "Portfolio");
  const manualEntity = snapshotJson.data.snapshot.entities.find((entity) =>
    entity.kind === "tab" && entity.workspaceId === spaceWorkspace.id && !entity.protection.protected
  );
  const manualPatch = {
    operations: [
      {
        op: "move",
        entityRef: manualEntity.ref,
        expectedSourceWorkspaceId: spaceWorkspace.id,
        destinationWorkspaceId: portfolioWorkspace.id,
        reason: "Manual exact apply from CLI smoke"
      }
    ]
  };

  const planned = spawnSync("node", ["dist/cli.js", "patch", "plan", "-", "--json"], {
    env,
    input: JSON.stringify(manualPatch),
    encoding: "utf8"
  });
  assert.equal(planned.status, 0, `${planned.stdout}\n${planned.stderr}`);
  const plannedJson = JSON.parse(planned.stdout);
  assert.equal(plannedJson.ok, true);
  assert.equal(plannedJson.data.plan.source.kind, "manual_patch");
  assert.equal(plannedJson.data.summary.moveCount, 1);
  const planId = plannedJson.data.plan.id;
  const planDigest = plannedJson.data.plan.digest;
  assert.match(planDigest, /^sha256:[a-f0-9]{64}$/);

  const missingConsent = spawnSync("node", [
    "dist/cli.js",
    "apply",
    planId,
    "--expect-digest",
    planDigest,
    "--json"
  ], {
    env,
    encoding: "utf8"
  });
  assert.equal(missingConsent.status, 2);
  assert.equal(JSON.parse(missingConsent.stdout).data.applied, false);

  const apply = spawnSync("node", [
    "dist/cli.js",
    "apply",
    planId,
    "--yes",
    "--expect-digest",
    planDigest,
    "--json"
  ], {
    env,
    encoding: "utf8"
  });
  assert.equal(apply.status, 0, `${apply.stdout}\n${apply.stderr}`);
  const applyJson = JSON.parse(apply.stdout);
  assert.equal(applyJson.ok, true);
  assert.equal(applyJson.data.receipt.outcome, "applied");
  assert.equal(applyJson.data.receipt.planId, planId);
  assert.equal(applyJson.data.receipt.planDigest, planDigest);
  assert.equal(applyJson.data.receipt.operations[0].observedWorkspaceId, portfolioWorkspace.id);
  assert.match(applyJson.data.receiptPath, /apply-transactions\/.*\/receipts\/.*\.json$/);

  const receipts = await execFileAsync("node", ["dist/cli.js", "apply", "list", "--json"], { env });
  const receiptsJson = JSON.parse(receipts.stdout);
  assert.equal(receiptsJson.ok, true);
  assert.equal(receiptsJson.data.history.kind, "saved_plan");
  assert.equal(receiptsJson.data.receipts[0].id, applyJson.data.receipt.id);
  assert.equal(receiptsJson.data.receipts[0].operationCount, 1);
  assert.equal(receiptsJson.data.receipts[0].planDigest, planDigest);

  const verification = await execFileAsync("node", ["dist/cli.js", "apply", "verify", applyJson.data.receipt.id, "--json"], { env });
  const verificationJson = JSON.parse(verification.stdout);
  assert.equal(verificationJson.ok, true);
  assert.equal(verificationJson.data.report.verification.checkedOperations, 1);

  const tabs = await execFileAsync("node", ["dist/cli.js", "tabs", "Portfolio", "--json"], { env });
  const tabsJson = JSON.parse(tabs.stdout);
  assert.equal(tabsJson.ok, true);
  assert.equal(tabsJson.data.tabs.some((tab) => tab.member.nativeId === manualEntity.nativeId), true);
});

test("attention-only Plans fail safely without an Apply Transaction while benign no-ops succeed", async () => {
  const fixture = await makeZenFixture();
  const env = {
    ...process.env,
    HOME: fixture.temp,
    PATH: fixture.binDir + ":" + (process.env.PATH ?? ""),
    ZTS_ZEN_APP_SUPPORT_DIR: fixture.appSupportDir,
    ZTS_STATE_DIR: fixture.stateDir,
    ZTS_CONFIG_PATH: join(fixture.temp, "config", "zen-tab-steward", "config.toml")
  };

  const snapshotResult = await execFileAsync("node", ["dist/cli.js", "snapshot", "--json"], { env });
  const snapshot = JSON.parse(snapshotResult.stdout).data.snapshot;
  const entity = snapshot.entities.find((candidate) =>
    candidate.kind === "tab" && candidate.protection.protected
  );
  const destination = snapshot.workspaces.find((workspace) => workspace.id !== entity?.workspaceId);
  assert.ok(entity && destination);
  const patch = {
    operations: [{
      op: "move",
      entityRef: entity.ref,
      expectedSourceWorkspaceId: entity.workspaceId,
      destinationWorkspaceId: destination.id,
      reason: "Request a protected move that has no executable Operation"
    }]
  };
  const planned = spawnSync("node", ["dist/cli.js", "patch", "plan", "-", "--json"], {
    env,
    input: JSON.stringify(patch),
    encoding: "utf8"
  });
  assert.equal(planned.status, 0, planned.stdout + "\n" + planned.stderr);
  const plannedData = JSON.parse(planned.stdout).data;
  assert.equal(plannedData.summary.moveCount, 0);
  assert.equal(plannedData.summary.protectedCount, 1);
  const fakePs = join(fixture.binDir, "ps");
  await writeFile(
    fakePs,
    "#!/bin/sh\nprintf '%s\\n' '123 /Applications/Zen.app/Contents/MacOS/zen --profile "
      + fixture.profilePath
      + "'\n"
  );
  for (const args of [
    ["dist/cli.js", "status"],
    ["dist/cli.js", "workspaces"],
    ["dist/cli.js", "tabs"]
  ]) {
    const humanRead = spawnSync("node", args, { env, encoding: "utf8" });
    assert.equal(humanRead.status, 0, `${humanRead.stdout}\n${humanRead.stderr}`);
    assert.match(humanRead.stdout, /persisted (disk )?observation/iu);
    assert.match(humanRead.stdout, /may be stale while Zen is running/iu);
  }
  for (const command of ["workspaces", "tabs"]) {
    const machineRead = spawnSync("node", ["dist/cli.js", command, "--json"], { env, encoding: "utf8" });
    assert.equal(machineRead.status, 0, `${machineRead.stdout}\n${machineRead.stderr}`);
    assert.match(JSON.parse(machineRead.stdout).warnings.join("\n"), /persisted observation.*may be stale/iu);
  }
  const unavailableLive = spawnSync("node", [
    "dist/cli.js",
    "patch",
    "apply",
    "-",
    "--yes",
    "--expect-digest",
    plannedData.plan.digest,
    "--backend",
    "live",
    "--json"
  ], {
    env,
    input: JSON.stringify(patch),
    encoding: "utf8"
  });
  assert.equal(unavailableLive.status, 2, unavailableLive.stdout + "\n" + unavailableLive.stderr);
  assert.equal(unavailableLive.stderr, "");
  assert.match(
    JSON.parse(unavailableLive.stdout).blockers.join("\n"),
    /production live mutation is unavailable.+never falls back/iu
  );
  await writeFile(fakePs, "#!/bin/sh\nexit 0\n");
  const sessionBefore = await readFile(join(fixture.profilePath, "zen-sessions.jsonlz4"));

  const withoutConsent = spawnSync("node", [
    "dist/cli.js",
    "apply",
    plannedData.plan.id,
    "--expect-digest",
    plannedData.plan.digest,
    "--json"
  ], { env, encoding: "utf8" });
  assert.equal(withoutConsent.status, 2, withoutConsent.stdout + "\n" + withoutConsent.stderr);
  assert.equal(JSON.parse(withoutConsent.stdout).data.applied, false);

  const wrongDigest = spawnSync("node", [
    "dist/cli.js",
    "apply",
    plannedData.plan.id,
    "--yes",
    "--expect-digest",
    "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
    "--json"
  ], { env, encoding: "utf8" });
  assert.equal(wrongDigest.status, 1, wrongDigest.stdout + "\n" + wrongDigest.stderr);
  assert.match(JSON.parse(wrongDigest.stdout).blockers.join("\n"), /does not match selected Plan/u);
  await assert.rejects(access(join(fixture.stateDir, "apply-transactions")), { code: "ENOENT" });

  const applied = spawnSync("node", [
    "dist/cli.js",
    "apply",
    plannedData.plan.id,
    "--yes",
    "--expect-digest",
    plannedData.plan.digest,
    "--json"
  ], { env, encoding: "utf8" });
  assert.equal(applied.status, 2, applied.stdout + "\n" + applied.stderr);
  assert.equal(applied.stderr, "");
  const appliedDocument = JSON.parse(applied.stdout);
  assert.equal(appliedDocument.ok, false);
  assert.equal(appliedDocument.data.plan.digest, plannedData.plan.digest);
  assert.equal(appliedDocument.data.applyOutcome, "attention_required");
  assert.deepEqual(appliedDocument.data.attentionActionIds, [plannedData.plan.actions[0].actionId]);
  assert.equal(appliedDocument.data.applied, false);
  assert.equal(appliedDocument.data.mutationAttempted, false);
  assert.equal(appliedDocument.data.authorization, null);
  assert.equal(appliedDocument.data.receipt, null);
  assert.equal(appliedDocument.data.receiptPath, null);
  assert.equal(appliedDocument.data.summary.moveCount, 0);
  assert.deepEqual(
    await readFile(join(fixture.profilePath, "zen-sessions.jsonlz4")),
    sessionBefore
  );
  await assert.rejects(access(join(fixture.stateDir, "apply-transactions")), { code: "ENOENT" });

  const manualApplied = spawnSync("node", [
    "dist/cli.js",
    "patch",
    "apply",
    "-",
    "--yes",
    "--expect-digest",
    plannedData.plan.digest,
    "--json"
  ], {
    env,
    input: JSON.stringify(patch),
    encoding: "utf8"
  });
  assert.equal(manualApplied.status, 2, manualApplied.stdout + "\n" + manualApplied.stderr);
  assert.equal(manualApplied.stderr, "");
  const manualDocument = JSON.parse(manualApplied.stdout);
  assert.equal(manualDocument.ok, false);
  assert.equal(manualDocument.command, "patch apply");
  assert.equal(manualDocument.data.plan.digest, plannedData.plan.digest);
  assert.equal(manualDocument.data.planResolution, "reused_latest");
  assert.equal(manualDocument.data.applyOutcome, "attention_required");
  assert.deepEqual(manualDocument.data.attentionActionIds, [plannedData.plan.actions[0].actionId]);
  assert.equal(manualDocument.data.applied, false);
  assert.equal(manualDocument.data.mutationAttempted, false);
  assert.equal(manualDocument.data.authorization, null);
  assert.equal(manualDocument.data.receipt, null);
  assert.equal(manualDocument.data.receiptPath, null);
  await assert.rejects(access(join(fixture.stateDir, "apply-transactions")), { code: "ENOENT" });

  const manualHuman = spawnSync("node", [
    "dist/cli.js",
    "patch",
    "apply",
    "-",
    "--yes",
    "--expect-digest",
    plannedData.plan.digest
  ], {
    env,
    input: JSON.stringify(patch),
    encoding: "utf8"
  });
  assert.equal(manualHuman.status, 2, manualHuman.stdout + "\n" + manualHuman.stderr);
  assert.equal(manualHuman.stdout, "");
  assert.match(manualHuman.stderr, /Manual Patch Apply · attention required/u);
  assert.match(manualHuman.stderr, /No Apply Transaction or Receipt was created/u);

  const human = spawnSync("node", [
    "dist/cli.js",
    "apply",
    plannedData.plan.id,
    "--yes",
    "--expect-digest",
    plannedData.plan.digest
  ], { env, encoding: "utf8" });
  assert.equal(human.status, 2, human.stdout + "\n" + human.stderr);
  assert.equal(human.stdout, "");
  assert.match(human.stderr, /Saved Plan Apply · attention required/u);
  assert.match(human.stderr, /No Apply Transaction or Receipt was created/u);

  const benignPatch = { operations: [] };
  const benignPlanned = spawnSync("node", ["dist/cli.js", "patch", "plan", "-", "--json"], {
    env,
    input: JSON.stringify(benignPatch),
    encoding: "utf8"
  });
  assert.equal(benignPlanned.status, 0, benignPlanned.stdout + "\n" + benignPlanned.stderr);
  const benignPlan = JSON.parse(benignPlanned.stdout).data;
  assert.equal(benignPlan.summary.moveCount, 0);
  assert.equal(benignPlan.summary.unchangedCount, 0);
  assert.deepEqual(benignPlan.plan.actions, []);
  const benignApplied = spawnSync("node", [
    "dist/cli.js",
    "apply",
    benignPlan.plan.id,
    "--yes",
    "--expect-digest",
    benignPlan.plan.digest,
    "--json"
  ], { env, encoding: "utf8" });
  assert.equal(benignApplied.status, 0, benignApplied.stdout + "\n" + benignApplied.stderr);
  const benignDocument = JSON.parse(benignApplied.stdout);
  assert.equal(benignDocument.ok, true);
  assert.equal(benignDocument.data.applyOutcome, "no_changes");
  assert.equal(benignDocument.data.receipt, null);
  await assert.rejects(access(join(fixture.stateDir, "apply-transactions")), { code: "ENOENT" });

  const driftedSession = await readJsonLz4(join(fixture.profilePath, "zen-sessions.jsonlz4"));
  driftedSession.tabs.find((tab) => tab.zenSyncId === "tab-framer").zenWorkspace = "w3";
  await writeFile(
    join(fixture.profilePath, "zen-sessions.jsonlz4"),
    encodeLiteralJsonLz4ForFixture(driftedSession)
  );
  const driftedApply = spawnSync("node", [
    "dist/cli.js",
    "apply",
    plannedData.plan.id,
    "--yes",
    "--expect-digest",
    plannedData.plan.digest,
    "--json"
  ], { env, encoding: "utf8" });
  assert.equal(driftedApply.status, 2, driftedApply.stdout + "\n" + driftedApply.stderr);
  const driftedApplyDocument = JSON.parse(driftedApply.stdout);
  assert.equal(driftedApplyDocument.data.outcome.status, "blocked");
  assert.match(driftedApplyDocument.blockers.join("\n"), /exact Snapshot/u);
  await assert.rejects(access(join(fixture.stateDir, "apply-transactions")), { code: "ENOENT" });
});

test("configured never-move policy is canonical Snapshot Protection for manual Patch and rules", async () => {
  const fixture = await makeZenFixture();
  const env = {
    ...process.env,
    HOME: fixture.temp,
    PATH: `${fixture.binDir}:${process.env.PATH ?? ""}`,
    ZTS_ZEN_APP_SUPPORT_DIR: fixture.appSupportDir,
    ZTS_STATE_DIR: fixture.stateDir,
    ZTS_CONFIG_PATH: join(fixture.temp, "config", "zen-tab-steward", "config.toml")
  };
  await execFileAsync(
    "node",
    ["dist/cli.js", "config", "set", "protect.domains.never_move", "framer.com", "--json"],
    { env }
  );
  await execFileAsync(
    "node",
    ["dist/cli.js", "rules", "add", "domain", "framer.com", "Portfolio", "--json"],
    { env }
  );

  const snapshotResult = await execFileAsync("node", ["dist/cli.js", "snapshot", "--json"], { env });
  const snapshot = JSON.parse(snapshotResult.stdout).data.snapshot;
  const source = snapshot.workspaces.find((workspace) => workspace.name === "Space");
  const destination = snapshot.workspaces.find((workspace) => workspace.name === "Portfolio");
  const entity = snapshot.entities.find((candidate) =>
    candidate.members.some((member) => member.url === "https://framer.com/project")
  );
  assert.ok(source && destination && entity);
  assert.equal(entity.protection.protected, true);
  assert.deepEqual(entity.protection.reasons, ["configured_never_move:framer.com"]);

  const patch = {
    operations: [{
      op: "move",
      entityRef: entity.ref,
      expectedSourceWorkspaceId: source.id,
      destinationWorkspaceId: destination.id,
      reason: "Agent-selected exact move"
    }]
  };
  const manual = spawnSync("node", ["dist/cli.js", "patch", "plan", "-", "--json"], {
    env,
    input: JSON.stringify(patch),
    encoding: "utf8"
  });
  assert.equal(manual.status, 0, `${manual.stdout}\n${manual.stderr}`);
  const manualData = JSON.parse(manual.stdout).data;
  assert.equal(manualData.summary.moveCount, 0);
  assert.equal(manualData.summary.protectedCount, 1);
  assert.equal(manualData.plan.actions[0].disposition, "protected");
  assert.equal(manualData.plan.actions[0].entityRef, entity.ref);

  const rules = spawnSync(
    "node",
    ["dist/cli.js", "sort", "Space", "--engine", "rules", "--preview", "--json"],
    { env, encoding: "utf8" }
  );
  assert.equal(rules.status, 0, `${rules.stdout}\n${rules.stderr}`);
  const rulesData = JSON.parse(rules.stdout).data;
  const rulesAction = rulesData.plan.actions.find((action) =>
    (action.disposition === "move" ? action.operation.entityRef : action.entityRef) === entity.ref
  );
  assert.equal(rulesAction.disposition, "protected");
  assert.equal(rulesData.plan.configRevision, manualData.plan.configRevision);
});

test("config path remains available when the config contents are malformed", async () => {
  const fixture = await makeZenFixture();
  const configPath = join(fixture.temp, "config", "zen-tab-steward", "config.toml");
  await mkdir(join(fixture.temp, "config", "zen-tab-steward"), { recursive: true, mode: 0o700 });
  await writeFile(configPath, "[future]\nenabled = true\n", { mode: 0o600 });
  const env = {
    ...process.env,
    HOME: fixture.temp,
    ZTS_CONFIG_PATH: configPath
  };

  const result = spawnSync("node", ["dist/cli.js", "config", "path", "--json"], {
    env,
    encoding: "utf8"
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.deepEqual(JSON.parse(result.stdout).data, { path: configPath, exists: true });
});

test("CLI exit taxonomy separates invalid input, config validation, and internal I/O", async () => {
  const fixture = await makeZenFixture();
  const configPath = join(fixture.temp, "config", "zen-tab-steward", "config.toml");
  const env = {
    ...process.env,
    HOME: fixture.temp,
    PATH: `${fixture.binDir}:${process.env.PATH ?? ""}`,
    ZTS_ZEN_APP_SUPPORT_DIR: fixture.appSupportDir,
    ZTS_STATE_DIR: fixture.stateDir,
    ZTS_CONFIG_PATH: configPath
  };

  for (const args of [
    ["dist/cli.js", "apply", "verify", "--json"],
    ["dist/cli.js", "apply", "verify", "not-a-receipt", "--json"],
    ["dist/cli.js", "apply", "verify", "receipt:apply:00000000-0000-4000-8000-000000000000", "--json"]
  ]) {
    const invalid = spawnSync("node", args, { env, encoding: "utf8" });
    assert.equal(invalid.status, 1, `${invalid.stdout}\n${invalid.stderr}`);
    assert.equal(invalid.stderr, "");
    assert.equal(JSON.parse(invalid.stdout).data.outcome.status, "invalid");
  }

  await mkdir(join(fixture.temp, "config", "zen-tab-steward"), { recursive: true, mode: 0o700 });
  await writeFile(configPath, "[future]\nenabled = true\n", { mode: 0o600 });
  const invalidConfig = spawnSync("node", ["dist/cli.js", "config", "show", "--json"], {
    env, encoding: "utf8"
  });
  assert.equal(invalidConfig.status, 1, `${invalidConfig.stdout}\n${invalidConfig.stderr}`);
  assert.equal(JSON.parse(invalidConfig.stdout).data.outcome.status, "invalid");

  await rm(configPath);
  await mkdir(configPath, { mode: 0o700 });
  const ioFailure = spawnSync("node", ["dist/cli.js", "config", "show", "--json"], {
    env, encoding: "utf8"
  });
  assert.equal(ioFailure.status, 4, `${ioFailure.stdout}\n${ioFailure.stderr}`);
  assert.equal(ioFailure.stderr, "");
  assert.equal(JSON.parse(ioFailure.stdout).data.outcome.status, "internal_error");
});

test("config show never leaks an internal semantic Engine spelling", async () => {
  const fixture = await makeZenFixture();
  const env = {
    ...process.env,
    HOME: fixture.temp,
    ZTS_CONFIG_PATH: join(fixture.temp, "config", "zen-tab-steward", "config.toml")
  };

  const jsonResult = await execFileAsync("node", ["dist/cli.js", "config", "show", "--json"], { env });
  assert.equal(JSON.parse(jsonResult.stdout).data.config.semantic.engine, "bge-small");
  assert.doesNotMatch(jsonResult.stdout, /bge_small/u);

  const humanResult = await execFileAsync("node", ["dist/cli.js", "config", "show"], { env });
  assert.match(humanResult.stdout, /"engine": "bge-small"/u);
  assert.doesNotMatch(humanResult.stdout, /bge_small/u);
});

test("negative Protection flags override configured inclusion for sort", async () => {
  const fixture = await makeZenFixture();
  const env = {
    ...process.env,
    HOME: fixture.temp,
    PATH: `${fixture.binDir}:${process.env.PATH ?? ""}`,
    ZTS_ZEN_APP_SUPPORT_DIR: fixture.appSupportDir,
    ZTS_STATE_DIR: fixture.stateDir,
    ZTS_CONFIG_PATH: join(fixture.temp, "config", "zen-tab-steward", "config.toml")
  };
  await execFileAsync("node", ["dist/cli.js", "config", "set", "defaults.include_pinned", "true", "--json"], { env });
  await execFileAsync("node", ["dist/cli.js", "config", "set", "defaults.include_essentials", "true", "--json"], { env });

  const sort = spawnSync("node", [
    "dist/cli.js", "sort", "Space", "--preview", "--no-include-pinned", "--no-include-essentials", "--json"
  ], { env, encoding: "utf8" });
  assert.equal(sort.status, 0, `${sort.stdout}\n${sort.stderr}`);
  const sortJson = JSON.parse(sort.stdout);
  assert.equal(sortJson.data.summary.protectedCount >= 1, true);
  assert.match(sortJson.suggestedNextCommands[0], /--no-include-pinned/u);
  assert.match(sortJson.suggestedNextCommands[0], /--no-include-essentials/u);

  const internalEngineSpelling = spawnSync("node", [
    "dist/cli.js", "sort", "Space", "--preview", "--engine", "bge_small", "--json"
  ], { env, encoding: "utf8" });
  assert.equal(internalEngineSpelling.status, 1);
  assert.match(JSON.parse(internalEngineSpelling.stdout).blockers.join("\n"), /expected rules, lexical, bge-small, or hybrid/u);
});

test("Workspace selectors prefer exact ids and reject ambiguous names", async () => {
  const fixture = await makeZenFixture({ ambiguousWorkspaces: true });
  const env = {
    ...process.env,
    HOME: fixture.temp,
    PATH: `${fixture.binDir}:${process.env.PATH ?? ""}`,
    ZTS_ZEN_APP_SUPPORT_DIR: fixture.appSupportDir,
    ZTS_STATE_DIR: fixture.stateDir,
    ZTS_CONFIG_PATH: join(fixture.temp, "config", "zen-tab-steward", "config.toml")
  };

  const ambiguousSort = spawnSync("node", ["dist/cli.js", "sort", "Space", "--preview", "--json"], {
    env,
    encoding: "utf8"
  });
  assert.equal(ambiguousSort.status, 1, `${ambiguousSort.stdout}\n${ambiguousSort.stderr}`);
  assert.equal(ambiguousSort.stderr, "");
  assert.match(JSON.parse(ambiguousSort.stdout).blockers.join("\n"), /ambiguous.+use one id: w1, w4/iu);

  const ambiguousTabs = spawnSync("node", ["dist/cli.js", "tabs", "Space", "--json"], {
    env,
    encoding: "utf8"
  });
  assert.equal(ambiguousTabs.status, 1, `${ambiguousTabs.stdout}\n${ambiguousTabs.stderr}`);
  assert.equal(ambiguousTabs.stderr, "");
  assert.match(JSON.parse(ambiguousTabs.stdout).blockers.join("\n"), /ambiguous.+use one id: w1, w4/iu);

  const exactSort = spawnSync("node", ["dist/cli.js", "sort", "w1", "--preview", "--json"], {
    env,
    encoding: "utf8"
  });
  assert.equal(exactSort.status, 0, `${exactSort.stdout}\n${exactSort.stderr}`);
  assert.equal(JSON.parse(exactSort.stdout).data.sourceScope.workspaceId, "w1");

  const exactTabs = spawnSync("node", ["dist/cli.js", "tabs", "w1", "--json"], {
    env,
    encoding: "utf8"
  });
  assert.equal(exactTabs.status, 0, `${exactTabs.stdout}\n${exactTabs.stderr}`);
  const exactTabData = JSON.parse(exactTabs.stdout).data.tabs;
  assert.equal(exactTabData.length > 0, true);
  assert.equal(exactTabData.every((tab) => tab.workspace.id === "w1"), true);
});

test("Commander parser failures use one JSON document and preserve help and version", async () => {
  const fixture = await makeZenFixture();
  const env = {
    ...process.env,
    HOME: fixture.temp,
    PATH: `${fixture.binDir}:${process.env.PATH ?? ""}`,
    ZTS_ZEN_APP_SUPPORT_DIR: fixture.appSupportDir,
    ZTS_STATE_DIR: fixture.stateDir,
    ZTS_CONFIG_PATH: join(fixture.temp, "config", "zen-tab-steward", "config.toml")
  };

  for (const argv of [
    ["dist/cli.js", "sort", "Space", "--typo", "--json"],
    ["dist/cli.js", "sort", "Space", "--limit", "--json"],
    ["dist/cli.js", "not-a-command", "--json"]
  ]) {
    const result = spawnSync("node", argv, { env, encoding: "utf8" });
    assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
    assert.equal(result.stderr, "");
    const document = JSON.parse(result.stdout);
    assert.deepEqual(Object.keys(document), [
      "version",
      "command",
      "ok",
      "data",
      "warnings",
      "blockers",
      "suggestedNextCommands"
    ]);
    assert.equal(document.ok, false);
    assert.equal(document.blockers.length, 1);
    assert.doesNotMatch(`${result.stdout}${result.stderr}`, /\n\s+at\s/u);
  }

  const help = spawnSync("node", ["dist/cli.js", "--help"], { env, encoding: "utf8" });
  assert.equal(help.status, 0, `${help.stdout}\n${help.stderr}`);
  assert.match(help.stdout, /Zen Tab Steward/u);
  assert.equal(help.stderr, "");

  const version = spawnSync("node", ["dist/cli.js", "--version"], { env, encoding: "utf8" });
  assert.equal(version.status, 0, `${version.stdout}\n${version.stderr}`);
  assert.match(version.stdout, /^0\.1\.0/u);
  assert.equal(version.stderr, "");
});

async function makeZenFixture(options = {}) {
  const temp = await mkdtemp(join(tmpdir(), "zts-cli-"));
  const appSupportDir = join(temp, "zen");
  const profilePath = join(appSupportDir, "Profiles", "abc.Default");
  const stateDir = join(temp, "state");
  const binDir = join(temp, "bin");
  await mkdir(join(profilePath, "sessionstore-backups"), { recursive: true });
  await mkdir(binDir, { recursive: true });
  const fakePs = join(binDir, "ps");
  await writeFile(fakePs, "#!/bin/sh\nexit 0\n");
  await chmod(fakePs, 0o755);
  await writeFile(
    join(appSupportDir, "profiles.ini"),
    [
      "[Profile0]",
      "Name=Default",
      "IsRelative=1",
      "Path=Profiles/abc.Default",
      "Default=1",
      ""
    ].join("\n")
  );
  await writeFile(
    join(appSupportDir, "installs.ini"),
    [
      "[Install]",
      "Default=Profiles/abc.Default",
      "Locked=1",
      ""
    ].join("\n")
  );
  const osAbi = process.arch === "arm64" ? "Darwin_aarch64-gcc3" : "Darwin_x86_64-gcc3";
  await writeFile(
    join(profilePath, "compatibility.ini"),
    `[Compatibility]\nLastVersion=1.19.3b_20260315063056/20260315063056\nLastOSABI=${osAbi}\n`
  );

  const spaces = [
      { uuid: "w1", name: "Space" },
      { uuid: "w2", name: "Stash" },
      { uuid: "w3", name: "Portfolio" }
  ];
  if (options.ambiguousWorkspaces) {
    spaces.push(
      { uuid: "w4", name: "Space" },
      // An exact id must win even when another Workspace has that id as its name.
      { uuid: "w5", name: "w1" }
    );
  }

  const session = {
    spaces,
    tabs: [
      { zenSyncId: "tab-example", zenWorkspace: "w1", pinned: true, zenEssential: true, entries: [{ url: "https://example.com", title: "Example" }] },
      { zenSyncId: "tab-github-folder", zenWorkspace: "w1", pinned: false, groupId: "g1", entries: [{ url: "https://github.com", title: "GitHub" }] },
      { zenSyncId: "tab-framer", zenWorkspace: "w1", pinned: false, entries: [{ url: "https://framer.com/project", title: "Framer" }] },
      { zenSyncId: "tab-other", zenWorkspace: "w2", pinned: false, entries: [{ url: "https://example.org", title: "Other" }] }
    ],
    folders: [{ id: "g1", name: "Dev", workspaceId: "w1", pinned: false }],
    groups: [{ id: "g1", name: "Dev", pinned: false }],
    splitViewData: []
  };

  await writeFile(join(profilePath, "zen-sessions.jsonlz4"), encodeLiteralJsonLz4ForFixture(session));
  await writeFile(join(profilePath, "sessionstore-backups", "recovery.jsonlz4"), "recovery");
  await writeFile(join(profilePath, "sessionstore-backups", "previous.jsonlz4"), "previous");
  return { temp, appSupportDir, profilePath, stateDir, binDir };
}
