import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { encodeLiteralJsonLz4ForFixture, readJsonLz4 } from "../dist/mozlz4.js";

const fixtureRoots = new Set();

after(async () => {
  await Promise.all([...fixtureRoots].map((root) => rm(root, { recursive: true, force: true })));
});

test("managed recovery relaunches after a hard crash immediately after graceful quit without mutating the session", async () => {
  const fixture = await makeFixture();
  const env = fixtureEnv(fixture);
  const plan = previewPlan(env);
  const beforeBytes = await readFile(fixture.sessionPath);

  const crashed = runManagedApply(fixture, env, plan, "afterManagedQuit", 71);
  assert.equal(crashed.status, 71, `${crashed.stdout}\n${crashed.stderr}`);
  assert.deepEqual(await readFile(fixture.sessionPath), beforeBytes);
  assert.deepEqual(await readController(fixture), {
    phase: "closed",
    quitCount: 1,
    launchCount: 0
  });

  const inspection = inspectOnlyRecovery(env);
  assert.equal(inspection.classification, "before_state_present");
  assert.equal(inspection.recoverable, true);

  const recovered = runManagedRecovery(fixture, env, inspection);
  assert.equal(recovered.status, 0, `${recovered.stdout}\n${recovered.stderr}`);
  const result = JSON.parse(recovered.stdout);
  assert.equal(result.sessionMutated, false);
  assert.equal(result.receipt.outcome, "interrupted");
  assert.equal(result.receipt.mutationAttempted, false);
  assert.ok(result.receipt.operations.every((operation) => operation.status === "not_attempted"));
  assertManagedControlComplete(result.receipt.control);
  assert.deepEqual(await readFile(fixture.sessionPath), beforeBytes);
  assert.deepEqual(await readController(fixture), {
    phase: "relaunched",
    quitCount: 1,
    launchCount: 1
  });
  assert.equal(listRecoveries(env).length, 0);
});

test("managed recovery classifies an exact committed after-state and relaunches without replaying mutation", async () => {
  const fixture = await makeFixture();
  const env = fixtureEnv(fixture);
  const plan = previewPlan(env);

  const crashed = runManagedApply(fixture, env, plan, "afterRelease", 72);
  assert.equal(crashed.status, 72, `${crashed.stdout}\n${crashed.stderr}`);
  assert.deepEqual(await readController(fixture), {
    phase: "closed",
    quitCount: 2,
    launchCount: 1
  });
  const committedBytes = await readFile(fixture.sessionPath);
  const committedStat = await stat(fixture.sessionPath);
  const committed = await readJsonLz4(fixture.sessionPath);
  assert.equal(committed.tabs.find((tab) => tab.zenSyncId === "tab-github")?.zenWorkspace, "w-work");
  assert.equal(committed.tabs.find((tab) => tab.zenSyncId === "tab-docs")?.zenWorkspace, "w-research");

  const inspection = inspectOnlyRecovery(env);
  assert.equal(inspection.classification, "planned_after_present");
  assert.equal(inspection.recoverable, true);

  const recovered = runManagedRecovery(fixture, env, inspection);
  assert.equal(recovered.status, 0, `${recovered.stdout}\n${recovered.stderr}`);
  const result = JSON.parse(recovered.stdout);
  assert.equal(result.sessionMutated, false, "recovery must classify the committed state, not replay it");
  assert.equal(result.receipt.outcome, "applied");
  assert.equal(result.receipt.mutationAttempted, true);
  assert.ok(result.receipt.operations.every((operation) => operation.status === "verified"));
  assertManagedControlComplete(result.receipt.control);
  assert.deepEqual(await readFile(fixture.sessionPath), committedBytes);
  const recoveredStat = await stat(fixture.sessionPath);
  assert.equal(recoveredStat.ino, committedStat.ino);
  assert.equal(recoveredStat.mtimeMs, committedStat.mtimeMs);
  assert.deepEqual(await readController(fixture), {
    phase: "relaunched",
    quitCount: 3,
    launchCount: 3
  });
  assert.equal(listRecoveries(env).length, 0);
});

test("managed recovery resumes after crashing with the exact replacement Zen already relaunched", async () => {
  const fixture = await makeFixture();
  const env = fixtureEnv(fixture);
  const plan = previewPlan(env);

  const applyCrash = runManagedApply(fixture, env, plan, "afterRelease", 73);
  assert.equal(applyCrash.status, 73, `${applyCrash.stdout}\n${applyCrash.stderr}`);
  const committedBytes = await readFile(fixture.sessionPath);
  const committedStat = await stat(fixture.sessionPath);
  const firstInspection = inspectOnlyRecovery(env);
  assert.equal(firstInspection.classification, "planned_after_present");

  const recoveryCrash = runManagedRecovery(
    fixture,
    env,
    firstInspection,
    "afterManagedRecoveryRelaunch",
    74
  );
  assert.equal(recoveryCrash.status, 74, `${recoveryCrash.stdout}\n${recoveryCrash.stderr}`);
  assert.deepEqual(await readController(fixture), {
    phase: "relaunched",
    quitCount: 3,
    launchCount: 3
  });
  assert.deepEqual(await readFile(fixture.sessionPath), committedBytes);
  assert.equal(listRecoveries(env).length, 1);

  const retryInspection = inspectOnlyRecovery(env);
  assert.equal(retryInspection.recoverable, true);
  const retried = runManagedRecovery(fixture, env, retryInspection);
  assert.equal(retried.status, 0, `${retried.stdout}\n${retried.stderr}`);
  const result = JSON.parse(retried.stdout);
  assert.equal(result.sessionMutated, false);
  assert.equal(result.receipt.outcome, "applied");
  assert.ok(result.receipt.operations.every((operation) => operation.status === "verified"));
  assertManagedControlComplete(result.receipt.control);
  assert.deepEqual(await readFile(fixture.sessionPath), committedBytes);
  const finalStat = await stat(fixture.sessionPath);
  assert.equal(finalStat.ino, committedStat.ino);
  assert.equal(finalStat.mtimeMs, committedStat.mtimeMs);
  assert.deepEqual(await readController(fixture), {
    phase: "relaunched",
    quitCount: 4,
    launchCount: 4
  });
  assert.equal(listRecoveries(env).length, 0);
  const receipts = listReceipts(env);
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].id, result.receipt.id);
});

test("managed Diff capture restores Zen after a hard crash and never creates a Plan during recovery", async () => {
  const fixture = await makeFixture();
  const env = fixtureEnv(fixture);
  const listed = spawnSync("node", ["dist/cli.js", "tabs", "--all", "--json"], { env, encoding: "utf8" });
  assert.equal(listed.status, 0, `${listed.stdout}\n${listed.stderr}`);
  const data = JSON.parse(listed.stdout).data;
  const tab = data.tabs.find((candidate) => candidate.workspace.id === "w-inbox");
  assert.ok(tab);
  const diff = {
    schemaVersion: "zts.diff.provisional-1",
    snapshotRevision: data.snapshotRevision,
    moves: [{ entityRef: tab.entityRef, fromWorkspaceId: "w-inbox", toWorkspaceId: "w-work", reason: "Crash-safe managed plan" }]
  };

  const crashed = runManagedCapture(fixture, env, diff, "afterQuit", 75);
  assert.equal(crashed.status, 75, `${crashed.stdout}\n${crashed.stderr}`);
  assert.deepEqual(await readController(fixture), { phase: "closed", quitCount: 1, launchCount: 0 });

  const restored = runManagedCapture(fixture, env, diff, null, null, false);
  assert.notEqual(restored.status, 0, `${restored.stdout}\n${restored.stderr}`);
  assert.match(restored.stderr, /restored Zen; rerun/iu);
  assert.deepEqual(await readController(fixture), { phase: "relaunched", quitCount: 1, launchCount: 1 });
  const noPlan = spawnSync("node", ["dist/cli.js", "plan", "show", "latest", "--json"], { env, encoding: "utf8" });
  assert.notEqual(noPlan.status, 0);

  const completed = runManagedCapture(fixture, env, diff);
  assert.equal(completed.status, 0, `${completed.stdout}\n${completed.stderr}`);
  const document = JSON.parse(completed.stdout);
  assert.equal(document.plan.snapshotAuthority, "authoritative");
  assert.equal(document.plan.snapshotRevision, diff.snapshotRevision);
  assert.deepEqual(await readController(fixture), { phase: "relaunched", quitCount: 2, launchCount: 2 });
});

function assertManagedControlComplete(control) {
  assert.equal(control.route, "managed_zen");
  assert.equal(control.quit, "verified");
  assert.equal(control.stateFlush, "verified");
  assert.equal(control.profileRestoration, "verified");
  assert.equal(control.relaunch, "verified");
  assert.equal(control.windowRestoration, "verified");
}

function previewPlan(env) {
  const preview = spawnSync(
    "node",
    ["dist/cli.js", "sort", "--all", "--engine", "rules", "--preview", "--json"],
    { cwd: process.cwd(), env, encoding: "utf8" }
  );
  assert.equal(preview.status, 0, `${preview.stdout}\n${preview.stderr}`);
  const plan = JSON.parse(preview.stdout).data.plan;
  assert.equal(plan.actions.filter((action) => action.disposition === "move").length, 2);
  return plan;
}

function runManagedApply(fixture, env, plan, hook, exitCode) {
  const script = [
    'import { applyStoredPlanClosedSession } from "./dist/apply-transaction.js";',
    'import { discoverProfileContext } from "./dist/profile.js";',
    'import { loadStoredPlan } from "./dist/plans.js";',
    durablePlatformSource(fixture),
    "const discovered = await discoverProfileContext();",
    "const context = { ...discovered, running: true };",
    `const stored = await loadStoredPlan(context.profile.id, ${JSON.stringify(plan.id)});`,
    "await applyStoredPlanClosedSession(context, stored, {",
    `  expectedDigest: ${JSON.stringify(plan.digest)},`,
    `  command: ${JSON.stringify(`managed recovery fixture ${hook}`)},`,
    "  managedLifecycle: { platform, request, waitOptions },",
    `  ${hook}: () => process.exit(${exitCode})`,
    "});"
  ].join("\n");
  return spawnSync("node", ["--input-type=module", "--eval", script], {
    cwd: process.cwd(), env, encoding: "utf8"
  });
}

function inspectOnlyRecovery(env) {
  const script = [
    'import { listApplyRecoveryInspections } from "./dist/apply-recovery.js";',
    'import { discoverProfileContext } from "./dist/profile.js";',
    "console.log(JSON.stringify(await listApplyRecoveryInspections(await discoverProfileContext())));"
  ].join("\n");
  const inspected = spawnSync("node", ["--input-type=module", "--eval", script], {
    cwd: process.cwd(), env, encoding: "utf8"
  });
  assert.equal(inspected.status, 0, `${inspected.stdout}\n${inspected.stderr}`);
  const inspections = JSON.parse(inspected.stdout);
  assert.equal(inspections.length, 1);
  return inspections[0];
}

function listRecoveries(env) {
  const script = [
    'import { listApplyRecoveryInspections } from "./dist/apply-recovery.js";',
    'import { discoverProfileContext } from "./dist/profile.js";',
    "console.log(JSON.stringify(await listApplyRecoveryInspections(await discoverProfileContext())));"
  ].join("\n");
  const listed = spawnSync("node", ["--input-type=module", "--eval", script], {
    cwd: process.cwd(), env, encoding: "utf8"
  });
  assert.equal(listed.status, 0, `${listed.stdout}\n${listed.stderr}`);
  return JSON.parse(listed.stdout);
}

function listReceipts(env) {
  const script = [
    'import { listTransactionReceipts } from "./dist/apply-transaction.js";',
    'import { discoverProfileContext } from "./dist/profile.js";',
    "const context = await discoverProfileContext();",
    "console.log(JSON.stringify(await listTransactionReceipts(context.profile.id)));"
  ].join("\n");
  const listed = spawnSync("node", ["--input-type=module", "--eval", script], {
    cwd: process.cwd(), env, encoding: "utf8"
  });
  assert.equal(listed.status, 0, `${listed.stdout}\n${listed.stderr}`);
  return JSON.parse(listed.stdout);
}

function runManagedRecovery(fixture, env, inspection, hook = null, exitCode = null) {
  const script = [
    'import { recoverApplyTransaction } from "./dist/apply-recovery.js";',
    'import { discoverProfileContext } from "./dist/profile.js";',
    durablePlatformSource(fixture),
    "const context = await discoverProfileContext();",
    "const result = await recoverApplyTransaction(context, "
      + `${JSON.stringify(inspection.transactionId)}, {`,
    `  expectedRecoveryRevision: ${JSON.stringify(inspection.recoveryRevision)},`,
    "  managedLifecycle: { platform, waitOptions },",
    ...(hook === null
      ? []
      : [`  ${hook}: () => process.exit(${exitCode})`]),
    "});",
    "console.log(JSON.stringify(result));"
  ].join("\n");
  return spawnSync("node", ["--input-type=module", "--eval", script], {
    cwd: process.cwd(), env, encoding: "utf8"
  });
}

function runManagedCapture(fixture, env, diff, hook = null, exitCode = null, forceRunning = true) {
  const script = [
    'import { runManagedAuthoritativeCapture } from "./dist/managed-authoritative-capture.js";',
    'import { createPatchFromAgentDiff } from "./dist/agent-diff.js";',
    'import { resolveManualPlanFromInput } from "./dist/manual.js";',
    'import { discoverProfileContext } from "./dist/profile.js";',
    'import { loadConfig } from "./dist/config.js";',
    durablePlatformSource(fixture),
    'const discovered = await discoverProfileContext();',
    `const context = { ...discovered, running: ${forceRunning ? "true" : "false"} };`,
    'const loaded = await loadConfig();',
    `const diff = ${JSON.stringify(diff)};`,
    'const result = await runManagedAuthoritativeCapture(context, loaded.config, {',
    '  platform, request, waitOptions,',
    ...(hook === null ? [] : [`  ${hook}: () => process.exit(${exitCode}),`]),
    '}, async (captured) => resolveManualPlanFromInput(captured.snapshot, createPatchFromAgentDiff(captured.snapshot, diff), loaded.config));',
    'console.log(JSON.stringify({ plan: result.value.plan, lifecycle: result.lifecycle }));'
  ].join("\n");
  return spawnSync("node", ["--input-type=module", "--eval", script], {
    cwd: process.cwd(), env, encoding: "utf8"
  });
}

function durablePlatformSource(fixture) {
  return [
    'import { readFileSync, writeFileSync } from "node:fs";',
    'import { parseZenProcessInventory } from "./dist/managed-zen-lifecycle.js";',
    `const controllerPath = ${JSON.stringify(fixture.controllerPath)};`,
    `const profilePath = ${JSON.stringify(fixture.profilePath)};`,
    'const executablePath = "/Applications/Zen.app/Contents/MacOS/zen";',
    'const readController = () => JSON.parse(readFileSync(controllerPath, "utf8"));',
    'const writeController = (state) => writeFileSync(controllerPath, `${JSON.stringify(state)}\\n`, { mode: 0o600 });',
    'const inventory = (rootPid, childPid, second) => parseZenProcessInventory(`',
    '${rootPid} 1 501 Sat Jul 11 16:${second}:24 2026 ${executablePath}',
    '${childPid} ${rootPid} 501 Sat Jul 11 16:${second}:24 2026 /Applications/Zen.app/Contents/MacOS/plugin-container.app/Contents/MacOS/plugin-container -profile ${profilePath} org.mozilla.machname.1 1 socket',
    '`);',
    'const platform = {',
    '  async listProcesses() {',
    '    const state = readController();',
    '    if (state.phase === "closed") return [];',
    '    if (state.phase === "initial") return inventory(100, 101, "27");',
    '    const rootPid = 100 + (state.launchCount * 100);',
    '    return inventory(rootPid, rootPid + 1, String(27 + state.launchCount));',
    '  },',
    '  async inspectApplication(pid) { return {',
    '    pid, bundleIdentifier: "app.zen-browser.zen", executablePath, bundlePath: "/Applications/Zen.app",',
    '    version: "1.19.3b", bundleVersion: "126.3.15", teamIdentifier: "9V5K9TP787",',
    '    codeDirectoryHash: "8533af", executableDevice: 1, executableInode: 2, executableSize: 3, executableModifiedMs: 4',
    '  }; },',
    '  async inspectWindows() { return [{ visible: true, miniaturized: false, bounds: { x: 10, y: 10, width: 1000, height: 800 } }]; },',
    '  async requestGracefulQuit() { const state = readController(); writeController({ ...state, phase: "closed", quitCount: state.quitCount + 1 }); return true; },',
    '  async launch() { const state = readController(); writeController({ ...state, phase: "relaunched", launchCount: state.launchCount + 1 }); },',
    '  async wait() {}',
    '};',
    'const request = { profilePath, executablePath, uid: 501, bundleIdentifier: "app.zen-browser.zen" };',
    'const waitOptions = { timeoutMs: 100, pollMs: 1 };'
  ].join("\n");
}

async function makeFixture() {
  const temp = await mkdtemp(join(tmpdir(), "zts-managed-recovery-"));
  fixtureRoots.add(temp);
  const appSupportDir = join(temp, "zen");
  const profilePath = join(appSupportDir, "Profiles", "managed.Default");
  const sessionPath = join(profilePath, "zen-sessions.jsonlz4");
  const stateDir = join(temp, "state");
  const binDir = join(temp, "bin");
  const configPath = join(temp, "config", "zen-tab-steward", "config.toml");
  const controllerPath = join(temp, "managed-controller.json");
  await mkdir(join(profilePath, "sessionstore-backups"), { recursive: true });
  await mkdir(binDir, { recursive: true });
  await mkdir(join(temp, "config", "zen-tab-steward"), { recursive: true, mode: 0o700 });
  const fakePs = join(binDir, "ps");
  await writeFile(fakePs, "#!/bin/sh\nexit 0\n");
  await chmod(fakePs, 0o755);
  await writeFile(join(appSupportDir, "profiles.ini"), [
    "[Profile0]", "Name=Managed", "IsRelative=1", "Path=Profiles/managed.Default", "Default=1", ""
  ].join("\n"));
  await writeFile(join(appSupportDir, "installs.ini"), [
    "[Install]", "Default=Profiles/managed.Default", "Locked=1", ""
  ].join("\n"), { mode: 0o600 });
  const osAbi = process.arch === "arm64" ? "Darwin_aarch64-gcc3" : "Darwin_x86_64-gcc3";
  await writeFile(
    join(profilePath, "compatibility.ini"),
    `[Compatibility]\nLastVersion=1.19.3b_20260315063056/20260315063056\nLastOSABI=${osAbi}\n`
  );
  await writeFile(configPath, [
    "[defaults]", 'inbox = "Inbox"', "min_confidence = 0.8", "include_pinned = false",
    "include_essentials = false", 'apply_backend = "auto"', "",
    "[sort]", "from = []", "to = []", "not_to = []", "only = []", "except = []", "",
    "[protect.workspaces]", "from = []", "to = []", "",
    "[protect.domains]", "never_move = []", "",
    "[rules.domains]", '"github.com" = "Work"', '"developer.mozilla.org" = "Research"', ""
  ].join("\n"), { mode: 0o600 });
  await writeFile(sessionPath, encodeLiteralJsonLz4ForFixture({
    spaces: [
      { uuid: "w-inbox", name: "Inbox" },
      { uuid: "w-work", name: "Work" },
      { uuid: "w-research", name: "Research" }
    ],
    tabs: [
      { zenSyncId: "tab-github", zenWorkspace: "w-inbox", pinned: false, entries: [{ url: "https://github.com/example/project", title: "Project" }] },
      { zenSyncId: "tab-docs", zenWorkspace: "w-inbox", pinned: false, entries: [{ url: "https://developer.mozilla.org/docs/Web/API", title: "Web API docs" }] }
    ],
    folders: [], groups: [], splitViewData: []
  }));
  await writeFile(join(profilePath, "sessionstore-backups", "recovery.jsonlz4"), "recovery");
  await writeFile(join(profilePath, "sessionstore-backups", "previous.jsonlz4"), "previous");
  await writeFile(controllerPath, `${JSON.stringify({ phase: "initial", quitCount: 0, launchCount: 0 })}\n`, { mode: 0o600 });
  return { temp, appSupportDir, profilePath, sessionPath, stateDir, binDir, configPath, controllerPath };
}

function fixtureEnv(fixture) {
  return {
    ...process.env,
    HOME: fixture.temp,
    PATH: `${fixture.binDir}:${process.env.PATH ?? ""}`,
    ZTS_ZEN_APP_SUPPORT_DIR: fixture.appSupportDir,
    ZTS_STATE_DIR: fixture.stateDir,
    ZTS_CONFIG_PATH: fixture.configPath
  };
}

async function readController(fixture) {
  return JSON.parse(await readFile(fixture.controllerPath, "utf8"));
}
