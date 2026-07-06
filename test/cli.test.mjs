import assert from "node:assert/strict";
import test from "node:test";
import { execFile, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { encodeLiteralJsonLz4ForFixture } from "../dist/mozlz4.js";

const execFileAsync = promisify(execFile);

test("CLI smokes cover help, version, status, workspaces, backup, and sort refusal", async () => {
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
  assert.equal(statusJson.data.session.workspaceCount, 2);
  assert.equal(statusJson.data.session.tabCount, 3);

  const workspaces = await execFileAsync("node", ["dist/cli.js", "workspaces"], { env });
  assert.match(workspaces.stdout, /Space/);
  assert.match(workspaces.stdout, /Stash/);

  const backup = await execFileAsync("node", ["dist/cli.js", "backup", "--json"], { env });
  const backupJson = JSON.parse(backup.stdout);
  assert.equal(backupJson.ok, true);
  assert.equal(backupJson.data.manifest.files.length, 3);

  const backupList = await execFileAsync("node", ["dist/cli.js", "backup", "list", "--json"], { env });
  const backupListJson = JSON.parse(backupList.stdout);
  assert.equal(backupListJson.ok, true);
  assert.equal(backupListJson.data.backups.length, 1);

  const sort = spawnSync("node", ["dist/cli.js", "sort", "Space", "--dry-run", "--json"], {
    env,
    encoding: "utf8"
  });
  assert.equal(sort.status, 0);
  const sortJson = JSON.parse(sort.stdout);
  assert.equal(sortJson.ok, true);
  assert.match(sortJson.blockers.join("\n"), /Sort apply is not implemented/);
  assert.equal(sortJson.data.plan.moveCount, 0);
  assert.equal(sortJson.data.plan.skipCount, 2);

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

  const plainSort = spawnSync("node", ["dist/cli.js", "sort", "Space", "--json"], {
    env,
    encoding: "utf8"
  });
  assert.equal(plainSort.status, 2);
  assert.equal(JSON.parse(plainSort.stdout).ok, false);

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
  assert.equal(restore.status, 2);
  assert.equal(JSON.parse(restore.stdout).ok, false);

  const configPath = await execFileAsync("node", ["dist/cli.js", "config", "path"], { env });
  assert.equal(configPath.stdout.trim(), join(fixture.temp, "config.toml"));

  const configSet = await execFileAsync("node", ["dist/cli.js", "config", "set", "defaults.min_confidence", "0.95", "--json"], { env });
  assert.equal(JSON.parse(configSet.stdout).data.value, 0.95);

  const backendSet = await execFileAsync("node", ["dist/cli.js", "config", "set", "defaults.apply_backend", "session", "--json"], { env });
  assert.equal(JSON.parse(backendSet.stdout).data.value, "session");

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
      { uuid: "w2", name: "Stash" }
    ],
    tabs: [
      { zenWorkspace: "w1", pinned: true, zenEssential: true, entries: [{ url: "https://example.com", title: "Example" }] },
      { zenWorkspace: "w1", pinned: false, groupId: "g1", entries: [{ url: "https://github.com", title: "GitHub" }] },
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
