import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { chmod, mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { encodeLiteralJsonLz4ForFixture } from "../dist/mozlz4.js";

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
    "\"framer.com\" = \"Portfolio\"",
    "\"github.com\" = \"Tool Development\"",
    "\"example.org\" = \"Stash\"",
    ""
  ].join("\n"));

  const session = {
    spaces: [
      { uuid: "w-space", name: "Space" },
      { uuid: "w-stash", name: "Stash" },
      { uuid: "w-portfolio", name: "Portfolio" },
      { uuid: "w-tools", name: "Tool Development" }
    ],
    tabs: [
      { zenSyncId: "tab-space-framer", zenWorkspace: "w-space", pinned: false, entries: [{ url: "https://framer.com/project", title: "Framer project" }] },
      { zenSyncId: "tab-space-stash-rule", zenWorkspace: "w-space", pinned: false, entries: [{ url: "https://example.org/private", title: "Would route to Stash" }] },
      { zenSyncId: "tab-stash-github", zenWorkspace: "w-stash", pinned: false, entries: [{ url: "https://github.com/1Pio/private", title: "Protected Stash tab" }] },
      { zenSyncId: "tab-portfolio-github", zenWorkspace: "w-portfolio", pinned: false, entries: [{ url: "https://github.com/1Pio/zen-tab-steward", title: "Cross-workspace rule" }] },
      { zenSyncId: "tab-tools-framer", zenWorkspace: "w-tools", pinned: false, entries: [{ url: "https://framer.com/templates", title: "Another cross-workspace rule" }] }
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
