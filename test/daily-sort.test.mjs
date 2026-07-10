import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { chmod, mkdtemp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { encodeLiteralJsonLz4ForFixture, readJsonLz4, writeJsonLz4 } from "../dist/mozlz4.js";

const execFileAsync = promisify(execFile);

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
  const listed = JSON.parse(list.stdout).data.domainReceipts[0];
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

test("post-commit failure writes an interrupted Receipt with durable recovery evidence", async () => {
  const fixture = await makeDailySortFixture();
  const env = dailySortEnv(fixture);
  const preview = spawnSync(
    "node",
    ["dist/cli.js", "sort", "--all", "--engine", "rules", "--preview", "--json"],
    { env, encoding: "utf8" }
  );
  assert.equal(preview.status, 0, `${preview.stdout}\n${preview.stderr}`);
  const plan = JSON.parse(preview.stdout).data.plan;
  const script = [
    'import { discoverProfileContext } from "./dist/profile.js";',
    'import { loadStoredPlan } from "./dist/plans.js";',
    'import { applyStoredPlanClosedSession } from "./dist/apply-transaction.js";',
    "const context = await discoverProfileContext();",
    `const stored = await loadStoredPlan(context.profile.id, ${JSON.stringify(plan.id)});`,
    "const outcome = await applyStoredPlanClosedSession(context, stored, {",
    `  expectedDigest: ${JSON.stringify(plan.digest)},`,
    '  command: "fixture post-commit failure",',
    '  afterCommit: () => { throw new Error("fixture failure after durable rename"); }',
    "});",
    "process.stdout.write(JSON.stringify(outcome));"
  ].join("\n");
  const run = spawnSync("node", ["--input-type=module", "--eval", script], {
    cwd: process.cwd(),
    env,
    encoding: "utf8"
  });
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
  const outcome = JSON.parse(run.stdout);
  assert.equal(outcome.applied, false);
  assert.match(outcome.blocker, /fixture failure after durable rename/);
  assert.equal(outcome.receipt.outcome, "interrupted");
  assert.equal(outcome.receipt.mutationAttempted, true);
  assert.equal(outcome.receipt.netChanged, null);
  assert.ok(outcome.receipt.backupArtifact);
  assert.ok(outcome.receipt.recoveryArtifact);
  assert.ok(outcome.receipt.operations.every((operation) =>
    operation.status === "failed" && operation.mutationAttempted === true && operation.netChanged === null
  ));

  const list = await execFileAsync("node", ["dist/cli.js", "apply", "list", "--json"], { env });
  const interrupted = JSON.parse(list.stdout).data.domainReceipts.find((receipt) => receipt.id === outcome.receipt.id);
  assert.equal(interrupted.outcome, "interrupted");

  const verify = spawnSync(
    "node",
    ["dist/cli.js", "apply", "verify", outcome.receipt.id, "--json"],
    { env, encoding: "utf8" }
  );
  assert.equal(verify.status, 2, `${verify.stdout}\n${verify.stderr}`);
  const verifyJson = JSON.parse(verify.stdout);
  assert.equal(verifyJson.ok, false);
  assert.equal(verifyJson.data.report.verification.checkedOperations, 0);
  assert.match(verifyJson.blockers.join("\n"), /interrupted.+not a verified successful final state/);
});

async function makeDailySortFixture() {
  const temp = await mkdtemp(join(tmpdir(), "zts-daily-sort-"));
  const appSupportDir = join(temp, "zen");
  const profilePath = join(appSupportDir, "Profiles", "daily.Default");
  const sessionPath = join(profilePath, "zen-sessions.jsonlz4");
  const stateDir = join(temp, "state");
  const binDir = join(temp, "bin");
  const configPath = join(temp, "config.toml");
  await mkdir(join(profilePath, "sessionstore-backups"), { recursive: true });
  await mkdir(binDir, { recursive: true });
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
  ].join("\n"));
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
  ].join("\n"));

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

function actionFor(plan, entityRef) {
  return plan.actions.find((action) =>
    (action.disposition === "move" ? action.operation.entityRef : action.entityRef) === entityRef
  );
}
