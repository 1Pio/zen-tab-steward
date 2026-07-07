import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applySortPlanLive, applySortPlanOffline, listApplyReceipts, offlineApplyBlockers, resolveApplyBackend, sortApplyBlockers, verifyApplyReceipt } from "../dist/apply.js";
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
    limit: null,
    backend: "session",
    domainRules: {},
    protectedDomains: []
  });

  assert.equal(plan.moveCount, 1);

  let receipt;
  let receipts;
  let verification;
  let identityVerification;
  let mismatchVerification;
  let appliedWritten;
  try {
    receipt = await applySortPlanOffline(fixture.context, fixture.session, plan, "zts sort Space --backend session");
    receipts = await listApplyReceipts(fixture.context.profile.id);
    await writeFile(join(fixture.stateDir, "applies", fixture.context.profile.id, "damaged--session-apply.json"), "{");
    verification = await verifyApplyReceipt(fixture.context, receipt.id);
    appliedWritten = await readJsonLz4(fixture.context.sessionFile.path);
    await writeFile(fixture.context.sessionFile.path, encodeLiteralJsonLz4ForFixture({
      ...fixture.session,
      tabs: [
        { zenWorkspace: "w2", entries: [{ url: "https://different.example.com", title: "Different" }] },
        fixture.session.tabs[1]
      ]
    }));
    identityVerification = await verifyApplyReceipt(fixture.context, receipt.id);
    await writeFile(fixture.context.sessionFile.path, encodeLiteralJsonLz4ForFixture(fixture.session));
    mismatchVerification = await verifyApplyReceipt(fixture.context, receipt.id);
  } finally {
    if (oldStateDir === undefined) delete process.env.ZTS_STATE_DIR;
    else process.env.ZTS_STATE_DIR = oldStateDir;
  }
  const written = await readJsonLz4(fixture.context.sessionFile.path);

  assert.equal(receipt.moveCount, 1);
  assert.equal(receipt.plannedMoveCount, 1);
  assert.equal(receipt.attemptedMoveCount, 1);
  assert.equal(receipt.succeededMoveCount, 1);
  assert.equal(receipt.failedMoveCount, 0);
  assert.deepEqual(receipt.verification, { ok: true, checkedMoves: 1 });
  assert.match(receipt.receiptPath, /session-apply\.json$/);
  assert.ok(receipt.backupId);
  assert.equal(appliedWritten.tabs[0].zenWorkspace, "w2");
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].id, receipt.id);
  assert.equal(verification.verification.ok, true);
  assert.equal(verification.verification.checkedMoves, 1);
  assert.equal(identityVerification.verification.ok, false);
  assert.equal(identityVerification.verification.mismatches[0].reason, "identity_mismatch");
  assert.equal(mismatchVerification.verification.ok, false);
  assert.equal(mismatchVerification.verification.mismatchCount, 1);
  assert.equal(mismatchVerification.verification.mismatches[0].reason, "workspace_mismatch");
  assert.equal(mismatchVerification.verification.mismatches[0].actualWorkspaceId, "w1");
  assert.equal(written.tabs[0].zenWorkspace, "w1");
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
  assert.deepEqual(offlineApplyBlockers(fixture.context, "live"), ["Live sort apply requires an attachable Zen bridge; run zts bridge live-check --connect for the current gate receipt"]);
  assert.deepEqual(sortApplyBlockers({ ...fixture.context, running: true }, "auto"), []);
  assert.deepEqual(sortApplyBlockers(fixture.context, "live"), ["Live sort apply requires Zen to be running"]);
  assert.deepEqual(
    sortApplyBlockers({ ...fixture.context, running: true, sessionFile: { ...fixture.context.sessionFile, kind: "recovery" } }, "live"),
    ["Live sort apply requires zen-sessions.jsonlz4 as the selected session source"]
  );
  assert.equal(resolveApplyBackend({ ...fixture.context, running: true }, "auto"), "live");
  assert.equal(resolveApplyBackend(fixture.context, "auto"), "session");
});

test("live backend applies planned moves with backup, proof, and receipt", async () => {
  const fixture = await makeApplyFixture();
  const oldStateDir = process.env.ZTS_STATE_DIR;
  const originalWebSocket = globalThis.WebSocket;
  process.env.ZTS_STATE_DIR = fixture.stateDir;
  const context = {
    ...fixture.context,
    running: true,
    runningProcesses: [privilegedBrowserProcess(fixture.profilePath)]
  };
  await writeFile(join(fixture.profilePath, "WebDriverBiDiServer.json"), JSON.stringify({ ws_host: "127.0.0.1", ws_port: 9222 }));
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
    limit: null,
    backend: "live",
    domainRules: {},
    protectedDomains: []
  });

  let receipt;
  let receipts;
  let verification;
  try {
    globalThis.WebSocket = FakeLiveApplyWebSocket;
    receipt = await applySortPlanLive(context, plan, "zts sort Space --backend live");
    receipts = await listApplyReceipts(context.profile.id);
    verification = await verifyApplyReceipt(context, receipt.id);
  } finally {
    globalThis.WebSocket = originalWebSocket;
    FakeLiveApplyWebSocket.connectionCount = 0;
    if (oldStateDir === undefined) delete process.env.ZTS_STATE_DIR;
    else process.env.ZTS_STATE_DIR = oldStateDir;
  }
  const written = await readJsonLz4(fixture.context.sessionFile.path);

  assert.equal(receipt.backend, "live");
  assert.match(receipt.receiptPath, /live-apply\.json$/);
  assert.ok(receipt.backupId);
  assert.equal(receipt.moveCount, 1);
  assert.equal(receipt.plannedMoveCount, 1);
  assert.equal(receipt.attemptedMoveCount, 1);
  assert.equal(receipt.succeededMoveCount, 1);
  assert.equal(receipt.failedMoveCount, 0);
  assert.deepEqual(receipt.verification, { ok: true, checkedMoves: 1, blockers: [] });
  assert.equal(receipt.liveProofs.length, 1);
  assert.equal(receipt.liveProofs[0].requestedUrl, "https://framer.com/project");
  assert.equal(receipts[0].id, receipt.id);
  assert.equal(receipts[0].backend, "live");
  assert.equal(verification.verification.ok, false);
  assert.match(verification.verification.blockers.join("\n"), /cannot be reverified from session files/);
  assert.equal(written.tabs[0].zenWorkspace, "w1");
});

test("live backend records guarded move refusal without claiming success", async () => {
  const fixture = await makeApplyFixture();
  const oldStateDir = process.env.ZTS_STATE_DIR;
  const originalWebSocket = globalThis.WebSocket;
  process.env.ZTS_STATE_DIR = fixture.stateDir;
  const context = {
    ...fixture.context,
    running: true,
    runningProcesses: [privilegedBrowserProcess(fixture.profilePath)]
  };
  await writeFile(join(fixture.profilePath, "WebDriverBiDiServer.json"), JSON.stringify({ ws_host: "127.0.0.1", ws_port: 9222 }));
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
    limit: null,
    backend: "live",
    domainRules: {},
    protectedDomains: []
  });

  let receipt;
  try {
    globalThis.WebSocket = FakeBlockedLiveApplyWebSocket;
    receipt = await applySortPlanLive(context, plan, "zts sort Space --backend live");
  } finally {
    globalThis.WebSocket = originalWebSocket;
    FakeBlockedLiveApplyWebSocket.connectionCount = 0;
    if (oldStateDir === undefined) delete process.env.ZTS_STATE_DIR;
    else process.env.ZTS_STATE_DIR = oldStateDir;
  }
  const written = await readJsonLz4(fixture.context.sessionFile.path);

  assert.equal(receipt.backend, "live");
  assert.equal(receipt.verification.ok, false);
  assert.equal(receipt.moveCount, 0);
  assert.equal(receipt.plannedMoveCount, 1);
  assert.equal(receipt.attemptedMoveCount, 1);
  assert.equal(receipt.succeededMoveCount, 0);
  assert.equal(receipt.failedMoveCount, 1);
  assert.equal(receipt.liveProofs.length, 0);
  assert.match(receipt.verification.blockers.join("\n"), /refused protected tab/);
  assert.equal(written.tabs[0].zenWorkspace, "w1");
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

function privilegedBrowserProcess(profilePath) {
  return {
    pid: 42,
    args: `/Applications/Zen.app/Contents/MacOS/zen -profile ${profilePath} --remote-debugging-port=9222 --remote-allow-system-access --remote-allow-hosts localhost --remote-allow-origins http://127.0.0.1:9222`,
    profilePath
  };
}

class FakeLiveApplyWebSocket {
  static connectionCount = 0;

  constructor(url) {
    this.url = url;
    this.connectionNumber = ++FakeLiveApplyWebSocket.connectionCount;
    this.listeners = new Map();
    setTimeout(() => this.emit("open", {}), 0);
  }

  addEventListener(type, callback) {
    const callbacks = this.listeners.get(type) ?? [];
    callbacks.push(callback);
    this.listeners.set(type, callbacks);
  }

  send(payload) {
    const request = JSON.parse(payload);
    setTimeout(() => this.emit("message", { data: JSON.stringify(fakeBidiResponse(request)) }), 0);
  }

  close() {}

  emit(type, event) {
    for (const callback of this.listeners.get(type) ?? []) callback(event);
  }
}

class FakeBlockedLiveApplyWebSocket extends FakeLiveApplyWebSocket {
  static connectionCount = 0;

  constructor(url) {
    super(url);
    this.connectionNumber = ++FakeBlockedLiveApplyWebSocket.connectionCount;
  }

  send(payload) {
    const request = JSON.parse(payload);
    setTimeout(() => this.emit("message", { data: JSON.stringify(fakeBlockedBidiResponse(request)) }), 0);
  }
}

function fakeBidiResponse(request) {
  if (request.method === "session.status") {
    return { type: "success", id: request.id, result: { ready: true, message: "" } };
  }
  if (request.method === "session.new") {
    return { type: "success", id: request.id, result: { sessionId: "session-1" } };
  }
  if (request.method === "browsingContext.getTree") {
    return { type: "success", id: request.id, result: { contexts: [{ context: "chrome-1" }] } };
  }
  if (request.method === "script.evaluate") {
    return {
      type: "success",
      id: request.id,
      result: remoteObject({
        requestedUrl: "https://framer.com/project",
        requestedFromWorkspaceId: "w1",
        requestedToWorkspaceId: "w2",
        candidateCount: 1,
        protectedReasons: [],
        beforeWorkspaceId: "w1",
        afterWorkspaceId: "w2",
        moved: true,
        moveResult: true,
        tabPinned: false,
        tabEssential: false,
        tabGrouped: false,
        tabFoldered: false,
        reason: "moved"
      })
    };
  }
  if (request.method === "session.end") {
    return { type: "success", id: request.id, result: {} };
  }
  return { type: "error", id: request.id, error: "unknown command", message: request.method };
}

function fakeBlockedBidiResponse(request) {
  if (request.method !== "script.evaluate") return fakeBidiResponse(request);
  return {
    type: "success",
    id: request.id,
    result: remoteObject({
      requestedUrl: "https://framer.com/project",
      requestedFromWorkspaceId: "w1",
      requestedToWorkspaceId: "w2",
      candidateCount: 1,
      protectedReasons: ["pinned"],
      beforeWorkspaceId: "w1",
      afterWorkspaceId: "w1",
      moved: false,
      moveResult: false,
      tabPinned: true,
      tabEssential: false,
      tabGrouped: false,
      tabFoldered: false,
      reason: "protected"
    })
  };
}

function remoteObject(entries) {
  return {
    type: "success",
    result: {
      type: "object",
      value: Object.entries(entries).map(([key, value]) => [key, remoteValue(value)])
    }
  };
}

function remoteValue(value) {
  if (typeof value === "boolean") return { type: "boolean", value };
  if (typeof value === "number") return { type: "number", value };
  if (Array.isArray(value)) return { type: "array", value: value.map(remoteValue) };
  return { type: "string", value };
}
