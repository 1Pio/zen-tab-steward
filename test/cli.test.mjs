import assert from "node:assert/strict";
import test from "node:test";
import { execFile, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { encodeLiteralJsonLz4ForFixture, readJsonLz4 } from "../dist/mozlz4.js";

const execFileAsync = promisify(execFile);

test("CLI smokes cover help, version, status, workspaces, tabs, backup, and offline sort apply", async () => {
  const fixture = await makeZenFixture();
  const env = {
    ...process.env,
    ZTS_ZEN_APP_SUPPORT_DIR: fixture.appSupportDir,
    ZTS_STATE_DIR: fixture.stateDir,
    ZTS_CONFIG_PATH: join(fixture.temp, "config.toml")
  };

  const help = await execFileAsync("node", ["dist/cli.js", "--help"], { env });
  assert.match(help.stdout, /Zen Tab Steward/);

  const version = await execFileAsync("node", ["dist/cli.js", "--version"], { env });
  assert.match(version.stdout, /^0\.1\.0/);

  const status = await execFileAsync("node", ["dist/cli.js", "status", "--json"], { env });
  const statusJson = JSON.parse(status.stdout);
  assert.equal(statusJson.ok, true);
  assert.equal(statusJson.data.profile.name, "Default");
  assert.equal(statusJson.data.session.workspaceCount, 3);
  assert.equal(statusJson.data.session.tabCount, 4);

  const bridge = await execFileAsync("node", ["dist/cli.js", "bridge", "status", "--json"], { env });
  const bridgeJson = JSON.parse(bridge.stdout);
  assert.equal(bridgeJson.ok, true);
  assert.equal(bridgeJson.data.bridge.liveBackend.status, "unavailable");
  assert.match(bridgeJson.blockers.join("\n"), /not implemented/);

  const bridgeDoctor = await execFileAsync("node", ["dist/cli.js", "bridge", "doctor"], { env });
  assert.match(bridgeDoctor.stdout, /Zen live bridge doctor/);
  assert.match(bridgeDoctor.stdout, /Live backend: unavailable/);
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

  const tabs = await execFileAsync("node", ["dist/cli.js", "tabs", "Space", "--json"], { env });
  const tabsJson = JSON.parse(tabs.stdout);
  assert.equal(tabsJson.ok, true);
  assert.equal(tabsJson.data.tabs.length, 3);
  assert.equal(tabsJson.data.tabs[0].workspaceName, "Space");

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

  const sort = spawnSync("node", ["dist/cli.js", "sort", "Space", "--dry-run", "--json"], {
    env,
    encoding: "utf8"
  });
  assert.equal(sort.status, 0);
  const sortJson = JSON.parse(sort.stdout);
  assert.equal(sortJson.ok, true);
  assert.equal(sortJson.data.applied, false);
  assert.equal(sortJson.data.plan.moveCount, 1);
  assert.equal(sortJson.data.plan.skipCount, 1);
  assert.equal(sortJson.data.plan.reviewActions.some((action) => action.entityType === "group" && action.reason === "structured_entity_review"), true);

  const sortDryRunHuman = spawnSync("node", ["dist/cli.js", "sort", "Space", "--dry-run"], {
    env,
    encoding: "utf8"
  });
  assert.equal(sortDryRunHuman.status, 0);
  assert.match(sortDryRunHuman.stdout, /Sort dry run: Space/);
  assert.match(sortDryRunHuman.stdout, /Moves:/);
  assert.match(sortDryRunHuman.stdout, /reason: domain_rule/);
  assert.match(sortDryRunHuman.stdout, /Skipped:/);

  const review = await execFileAsync("node", ["dist/cli.js", "review", "Space", "--json"], { env });
  const reviewJson = JSON.parse(review.stdout);
  assert.equal(reviewJson.ok, true);
  assert.equal(reviewJson.data.summary.reviewCount, 1);
  assert.equal(reviewJson.data.reviewActions[0].entityType, "group");
  assert.equal(reviewJson.data.reviewActions[0].reason, "structured_entity_review");

  const reviewHuman = await execFileAsync("node", ["dist/cli.js", "review", "Space"], { env });
  assert.match(reviewHuman.stdout, /Sort review: Space/);
  assert.match(reviewHuman.stdout, /entity: group/);

  const sortWithKnownFlags = spawnSync(
    "node",
    [
      "dist/cli.js",
      "sort",
      "Space",
      "--preview",
      "--min-confidence",
      "0.85",
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
  assert.deepEqual(sortWithKnownFlagsJson.data.inputs.to, ["Portfolio", "Tool Development"]);
  assert.deepEqual(sortWithKnownFlagsJson.data.inputs.notTo, ["Stash"]);
  assert.equal(sortWithKnownFlagsJson.data.inputs.minConfidence, 0.85);
  assert.equal(sortWithKnownFlagsJson.data.inputs.limit, 1);
  assert.equal(sortWithKnownFlagsJson.data.inputs.backend, "session");

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

  const limitedSort = spawnSync("node", ["dist/cli.js", "sort", "Space", "--dry-run", "--limit", "0", "--json"], {
    env,
    encoding: "utf8"
  });
  assert.equal(limitedSort.status, 0);
  const limitedSortJson = JSON.parse(limitedSort.stdout);
  assert.equal(limitedSortJson.data.plan.moveCount, 0);
  assert.equal(limitedSortJson.data.plan.reviewActions.some((action) => action.reason === "over_move_limit"), true);

  const plainSort = spawnSync("node", ["dist/cli.js", "sort", "Space", "--json"], {
    env,
    encoding: "utf8"
  });
  assert.equal(plainSort.status, 0);
  const plainSortJson = JSON.parse(plainSort.stdout);
  assert.equal(plainSortJson.ok, true);
  assert.equal(plainSortJson.data.applied, true);
  assert.equal(plainSortJson.data.applyReceipt.moveCount, 1);
  const applyReceiptId = plainSortJson.data.applyReceipt.id;
  const appliedSession = await readJsonLz4(join(fixture.profilePath, "zen-sessions.jsonlz4"));
  assert.equal(appliedSession.tabs[2].zenWorkspace, "w3");

  const applyList = await execFileAsync("node", ["dist/cli.js", "apply", "list", "--json"], { env });
  const applyListJson = JSON.parse(applyList.stdout);
  assert.equal(applyListJson.ok, true);
  assert.equal(applyListJson.data.receipts.length, 1);
  assert.equal(applyListJson.data.receipts[0].id, applyReceiptId);

  const applyVerify = await execFileAsync("node", ["dist/cli.js", "apply", "verify", applyReceiptId, "--json"], { env });
  const applyVerifyJson = JSON.parse(applyVerify.stdout);
  assert.equal(applyVerifyJson.ok, true);
  assert.equal(applyVerifyJson.data.report.verification.checkedMoves, 1);

  const restoreApplied = await execFileAsync("node", ["dist/cli.js", "backup", "restore", preSortBackupId, "--json"], { env });
  const restoreAppliedJson = JSON.parse(restoreApplied.stdout);
  assert.equal(restoreAppliedJson.ok, true);
  assert.equal(restoreAppliedJson.data.receipt.restoredBackupId, preSortBackupId);
  assert.ok(restoreAppliedJson.data.receipt.safetyBackupId);
  const restoredSession = await readJsonLz4(join(fixture.profilePath, "zen-sessions.jsonlz4"));
  assert.equal(restoredSession.tabs[2].zenWorkspace, "w1");

  const applyVerifyAfterRestore = spawnSync("node", ["dist/cli.js", "apply", "verify", applyReceiptId, "--json"], {
    env,
    encoding: "utf8"
  });
  assert.equal(applyVerifyAfterRestore.status, 2);
  const applyVerifyAfterRestoreJson = JSON.parse(applyVerifyAfterRestore.stdout);
  assert.equal(applyVerifyAfterRestoreJson.ok, false);
  assert.equal(applyVerifyAfterRestoreJson.data.report.verification.mismatchCount, 1);
  assert.equal(applyVerifyAfterRestoreJson.data.report.verification.mismatches[0].actualWorkspaceId, "w1");

  const sortWithUnknownFlag = spawnSync("node", ["dist/cli.js", "sort", "Space", "--typo"], {
    env,
    encoding: "utf8"
  });
  assert.equal(sortWithUnknownFlag.status, 1);
  assert.match(sortWithUnknownFlag.stderr, /unknown option '--typo'/);

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
  assert.equal(configPath.stdout.trim(), join(fixture.temp, "config.toml"));

  const configSet = await execFileAsync("node", ["dist/cli.js", "config", "set", "defaults.min_confidence", "0.95", "--json"], { env });
  assert.equal(JSON.parse(configSet.stdout).data.value, 0.95);

  const backendSet = await execFileAsync("node", ["dist/cli.js", "config", "set", "defaults.apply_backend", "session", "--json"], { env });
  assert.equal(JSON.parse(backendSet.stdout).data.value, "session");

  const protectSet = await execFileAsync("node", ["dist/cli.js", "config", "set", "protect.workspaces.from", "Stash", "--json"], { env });
  assert.deepEqual(JSON.parse(protectSet.stdout).data.value, ["Stash"]);

  const sortFromSet = await execFileAsync("node", ["dist/cli.js", "config", "set", "sort.from", "Space", "--json"], { env });
  assert.deepEqual(JSON.parse(sortFromSet.stdout).data.value, ["Space"]);

  await execFileAsync("node", ["dist/cli.js", "config", "set", "defaults.inbox", "Stash", "--json"], { env });

  const rulesAdd = await execFileAsync("node", ["dist/cli.js", "rules", "add", "domain", "docs.example.com", "Research", "--json"], { env });
  assert.equal(JSON.parse(rulesAdd.stdout).data.workspace, "Research");

  const rulesTest = await execFileAsync("node", ["dist/cli.js", "rules", "test", "https://docs.example.com/page", "--json"], { env });
  assert.equal(JSON.parse(rulesTest.stdout).data.match.workspaceName, "Research");

  const sortWithConfigDefaults = spawnSync("node", ["dist/cli.js", "sort", "Space", "--preview", "--json"], {
    env,
    encoding: "utf8"
  });
  assert.equal(sortWithConfigDefaults.status, 0);
  const sortWithConfigDefaultsJson = JSON.parse(sortWithConfigDefaults.stdout);
  assert.equal(sortWithConfigDefaultsJson.data.inputs.backend, "session");
  assert.equal(sortWithConfigDefaultsJson.data.inputs.minConfidence, 0.95);

  const sortWithDefaultInbox = spawnSync("node", ["dist/cli.js", "sort", "--preview", "--json"], {
    env,
    encoding: "utf8"
  });
  assert.equal(sortWithDefaultInbox.status, 0);
  assert.equal(JSON.parse(sortWithDefaultInbox.stdout).data.sourceWorkspace.name, "Stash");
  assert.equal(JSON.parse(sortWithDefaultInbox.stdout).data.plan.blockedActions[0].reason, "source_workspace_protected");
});

async function makeZenFixture() {
  const temp = await mkdtemp(join(tmpdir(), "zts-cli-"));
  const appSupportDir = join(temp, "zen");
  const profilePath = join(appSupportDir, "Profiles", "abc.Default");
  const stateDir = join(temp, "state");
  await mkdir(join(profilePath, "sessionstore-backups"), { recursive: true });
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

  const session = {
    spaces: [
      { uuid: "w1", name: "Space" },
      { uuid: "w2", name: "Stash" },
      { uuid: "w3", name: "Portfolio" }
    ],
    tabs: [
      { zenWorkspace: "w1", pinned: true, zenEssential: true, entries: [{ url: "https://example.com", title: "Example" }] },
      { zenWorkspace: "w1", pinned: false, groupId: "g1", entries: [{ url: "https://github.com", title: "GitHub" }] },
      { zenWorkspace: "w1", pinned: false, entries: [{ url: "https://framer.com/project", title: "Framer" }] },
      { zenWorkspace: "w2", pinned: false, entries: [{ url: "https://example.org", title: "Other" }] }
    ],
    folders: [{ id: "g1", name: "Dev", workspaceId: "w1", pinned: false }],
    groups: [{ id: "g1", name: "Dev", pinned: false }],
    splitViewData: []
  };

  await writeFile(join(profilePath, "zen-sessions.jsonlz4"), encodeLiteralJsonLz4ForFixture(session));
  await writeFile(join(profilePath, "sessionstore-backups", "recovery.jsonlz4"), "recovery");
  await writeFile(join(profilePath, "sessionstore-backups", "previous.jsonlz4"), "previous");
  return { temp, appSupportDir, profilePath, stateDir };
}
