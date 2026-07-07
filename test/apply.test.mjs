import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applySortPlanOffline, offlineApplyBlockers } from "../dist/apply.js";
import { encodeLiteralJsonLz4ForFixture, readJsonLz4 } from "../dist/mozlz4.js";
import { planSortPreview } from "../dist/sort.js";
import { summarizeSession } from "../dist/session.js";

test("offline session backend applies planned moves with backup and receipt", async () => {
  const fixture = await makeApplyFixture();
  const oldStateDir = process.env.ZTS_STATE_DIR;
  process.env.ZTS_STATE_DIR = fixture.stateDir;
  const summary = summarizeSession(fixture.session, fixture.context.sessionFile);
  const plan = planSortPreview(fixture.session, summary, summary.workspaces[0], {
    preview: false,
    dryRun: false,
    minConfidence: 0.8,
    includePinned: false,
    includeEssentials: false,
    to: [],
    notTo: [],
    only: [],
    except: [],
    backend: "session",
    domainRules: {},
    protectedDomains: []
  });

  assert.equal(plan.moveCount, 1);

  let receipt;
  try {
    receipt = await applySortPlanOffline(fixture.context, fixture.session, plan, "zts sort Space --backend session");
  } finally {
    if (oldStateDir === undefined) delete process.env.ZTS_STATE_DIR;
    else process.env.ZTS_STATE_DIR = oldStateDir;
  }
  const written = await readJsonLz4(fixture.context.sessionFile.path);

  assert.equal(receipt.moveCount, 1);
  assert.deepEqual(receipt.verification, { ok: true, checkedMoves: 1 });
  assert.match(receipt.receiptPath, /session-apply\.json$/);
  assert.ok(receipt.backupId);
  assert.equal(written.tabs[0].zenWorkspace, "w2");
  assert.equal(written.tabs[1].zenWorkspace, "w1");
  assert.deepEqual(written.unknown, { preserved: true });
});

test("offline session backend refuses running Zen and non-primary session sources", async () => {
  const fixture = await makeApplyFixture();

  assert.deepEqual(
    offlineApplyBlockers({ ...fixture.context, running: true }, "session"),
    ["Offline session apply is blocked because Zen is running"]
  );
  assert.deepEqual(
    offlineApplyBlockers({ ...fixture.context, sessionFile: { ...fixture.context.sessionFile, kind: "recovery" } }, "session"),
    ["Offline session apply requires zen-sessions.jsonlz4 as the selected session source"]
  );
  assert.deepEqual(offlineApplyBlockers(fixture.context, "live"), ["Live backend is unavailable"]);
});

async function makeApplyFixture() {
  const temp = await mkdtemp(join(tmpdir(), "zts-apply-"));
  const profilePath = join(temp, "Profiles", "abc.Default");
  const stateDir = join(temp, "state");
  await mkdir(profilePath, { recursive: true });
  const sessionFilePath = join(profilePath, "zen-sessions.jsonlz4");
  const session = {
    spaces: [
      { uuid: "w1", name: "Space" },
      { uuid: "w2", name: "Portfolio" }
    ],
    tabs: [
      { zenWorkspace: "w1", entries: [{ url: "https://framer.com/project", title: "Framer" }] },
      { zenWorkspace: "w1", entries: [{ url: "https://example.com/unknown", title: "Unknown" }] }
    ],
    folders: [],
    groups: [],
    unknown: { preserved: true }
  };
  await writeFile(sessionFilePath, encodeLiteralJsonLz4ForFixture(session));

  const context = {
    appSupportDir: temp,
    profile: {
      id: "abc.Default",
      name: "Default",
      path: profilePath,
      isDefault: true,
      fromInstallDefault: true
    },
    running: false,
    runningProcesses: [],
    sessionFile: {
      kind: "zen-sessions",
      path: sessionFilePath,
      exists: true,
      size: 100,
      modifiedMs: 123
    }
  };

  return { temp, profilePath, stateDir, session, context };
}
