import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bidiBaseUrlFromLog, inspectBridge, inspectLiveAttachment, runBridgeLiveMoveProof, runBridgeLiveReadProof, runBridgeProbe, summarizeBridgeProcess, validateBidiSessionStatus, validateBridgeLiveMoveProof, validateBridgeLiveReadProof, validateBridgeProbeScriptProof, validateBridgeProbeWorkspaceOperation } from "../dist/bridge.js";
import { parseZenProcesses } from "../dist/processes.js";

const profilePath = "/Users/main/Library/Application Support/zen/Profiles/4le6r9n3.Default (release)";

test("bridge inspection fails closed when Zen is not running", () => {
  const inspection = inspectBridge(context({ running: false, runningProcesses: [] }));

  assert.equal(inspection.liveBackend.status, "gated");
  assert.equal(inspection.liveBackend.applySupported, true);
  assert.equal(inspection.candidateTransportDetected, false);
  assert.equal(inspection.candidatePrivilegedTransportDetected, false);
  assert.match(inspection.blockers.join("\n"), /requires an attachable Zen bridge/);
  assert.match(inspection.blockers.join("\n"), /not running/);
  assert.equal(inspection.checks.find((check) => check.id === "live_client").status, "warn");
});

test("bridge inspection detects privileged remote launch evidence without treating it as attachment proof", () => {
  const inspection = inspectBridge(context({
    running: true,
    runningProcesses: [
      {
        pid: 42,
        args: `/Applications/Zen.app/Contents/MacOS/zen -profile ${profilePath} --remote-debugging-port=9222 --remote-allow-system-access --remote-allow-hosts localhost --remote-allow-origins http://127.0.0.1:9222`,
        profilePath
      }
    ]
  }));

  assert.equal(inspection.candidateTransportDetected, true);
  assert.equal(inspection.candidatePrivilegedTransportDetected, true);
  assert.equal(inspection.liveBackend.status, "gated");
  assert.equal(inspection.liveBackend.applySupported, true);
  assert.deepEqual(inspection.blockers, ["Live sort apply requires an attachable Zen bridge; run zts bridge live-check --connect for the current gate receipt"]);
  assert.match(inspection.warnings.join("\n"), /Remote launch flags are only transport evidence/);
});

test("bridge inspection offers an opt-in launch hint only when privileged transport is absent", () => {
  const gated = inspectBridge(context({ running: false, runningProcesses: [] }));
  assert.ok(gated.launchHint);
  assert.match(gated.launchHint, /--remote-debugging-port/);
  assert.match(gated.launchHint, /--remote-allow-system-access/);
  assert.match(gated.launchHint, /security-sensitive/);

  const privileged = inspectBridge(context({
    running: true,
    runningProcesses: [
      {
        pid: 42,
        args: `/Applications/Zen.app/Contents/MacOS/zen -profile ${profilePath} --remote-debugging-port=9222 --remote-allow-system-access`,
        profilePath
      }
    ]
  }));
  assert.equal(privileged.launchHint, null);
});

test("bridge process summary ignores content process flags for browser readiness", () => {
  const process = summarizeBridgeProcess({
    pid: 7,
    args: `/Applications/Zen.app/Contents/MacOS/plugin-container.app/Contents/MacOS/plugin-container -profile ${profilePath} --remote-debugging-port 9222 --remote-allow-system-access`,
    profilePath
  }, profilePath);

  assert.equal(process.role, "content");
  assert.equal(process.profileMatched, true);
  assert.equal(process.flags.remoteDebuggingPort, true);
  assert.equal(process.flags.remoteAllowSystemAccess, true);

  const inspection = inspectBridge(context({ running: true, runningProcesses: [{ pid: 7, args: processArgs(), profilePath }] }));
  assert.equal(inspection.candidateTransportDetected, false);
  assert.match(inspection.blockers.join("\n"), /no remote debugging/);
});

test("profile-less browser parent process is treated as applicable to the discovered profile", () => {
  const process = summarizeBridgeProcess({
    pid: 9,
    args: "/Applications/Zen.app/Contents/MacOS/zen --remote-debugging-port=9222",
    profilePath: undefined
  }, profilePath);

  assert.equal(process.role, "browser");
  assert.equal(process.profilePath, null);
  assert.equal(process.profileMatched, true);
  assert.equal(process.flags.remoteDebuggingPort, true);
});

test("bridge inspection detects candidate flags from parsed ps output with trailing launch flags", () => {
  const output = `101 /Applications/Zen.app/Contents/MacOS/zen -profile ${profilePath} --remote-debugging-port=9222 --remote-allow-system-access --remote-allow-hosts localhost --remote-allow-origins http://127.0.0.1:9222`;
  const runningProcesses = parseZenProcesses(output);
  const inspection = inspectBridge(context({ running: true, runningProcesses }));

  assert.equal(runningProcesses[0].profilePath, profilePath);
  assert.equal(inspection.candidateTransportDetected, true);
  assert.equal(inspection.candidatePrivilegedTransportDetected, true);
  assert.deepEqual(inspection.blockers, ["Live sort apply requires an attachable Zen bridge; run zts bridge live-check --connect for the current gate receipt"]);
});

test("live attachment check refuses when the profile has no BiDi server file", async () => {
  const temp = await mkdtemp(join(tmpdir(), "zts-live-check-missing-"));
  try {
    const inspection = await inspectLiveAttachment(context({
      profilePath: temp,
      running: true,
      runningProcesses: [privilegedBrowserProcess(temp)]
    }));

    assert.equal(inspection.attachable, false);
    assert.equal(inspection.serverFileExists, false);
    assert.match(inspection.blockers.join("\n"), /WebDriverBiDiServer\.json does not exist/);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("live attachment check refuses local server file until session.status is checked", async () => {
  const temp = await mkdtemp(join(tmpdir(), "zts-live-check-pass-"));
  try {
    await writeFile(join(temp, "WebDriverBiDiServer.json"), JSON.stringify({ ws_host: "127.0.0.1", ws_port: 9222 }));
    const inspection = await inspectLiveAttachment(context({
      profilePath: temp,
      running: true,
      runningProcesses: [privilegedBrowserProcess(temp)]
    }));

    assert.equal(inspection.attachable, false);
    assert.equal(inspection.serverFileExists, true);
    assert.equal(inspection.endpoint.websocketUrl, "ws://127.0.0.1:9222/session");
    assert.match(inspection.blockers.join("\n"), /session\.status was not checked/);
    assert.equal(inspection.checks.find((check) => check.id === "local_endpoint").status, "pass");
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("live attachment check passes after connected session.status proof", async () => {
  const temp = await mkdtemp(join(tmpdir(), "zts-live-check-connect-"));
  const originalWebSocket = globalThis.WebSocket;
  try {
    await writeFile(join(temp, "WebDriverBiDiServer.json"), JSON.stringify({ ws_host: "127.0.0.1", ws_port: 9222 }));
    globalThis.WebSocket = FakeWebSocket;
    const inspection = await inspectLiveAttachment(context({
      profilePath: temp,
      running: true,
      runningProcesses: [privilegedBrowserProcess(temp)]
    }), { connect: true, timeoutMs: 1000 });

    assert.equal(inspection.attachable, true);
    assert.deepEqual(inspection.blockers, []);
    assert.equal(inspection.checkedEndpoint, true);
    assert.equal(inspection.checks.find((check) => check.id === "session_status").status, "pass");
  } finally {
    globalThis.WebSocket = originalWebSocket;
    await rm(temp, { recursive: true, force: true });
  }
});

test("live attachment check refuses profile-less browser process evidence", async () => {
  const temp = await mkdtemp(join(tmpdir(), "zts-live-check-profileless-"));
  try {
    await writeFile(join(temp, "WebDriverBiDiServer.json"), JSON.stringify({ ws_host: "127.0.0.1", ws_port: 9222 }));
    const inspection = await inspectLiveAttachment(context({
      profilePath: temp,
      running: true,
      runningProcesses: [{
        pid: 42,
        args: "/Applications/Zen.app/Contents/MacOS/zen --remote-debugging-port=9222 --remote-allow-system-access",
        profilePath: undefined
      }]
    }));

    assert.equal(inspection.attachable, false);
    assert.match(inspection.blockers.join("\n"), /No browser process explicitly matched/);
    assert.equal(inspection.candidateTransportDetected, false);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("live attachment check refuses non-local BiDi endpoints", async () => {
  const temp = await mkdtemp(join(tmpdir(), "zts-live-check-remote-"));
  try {
    await writeFile(join(temp, "WebDriverBiDiServer.json"), JSON.stringify({ ws_host: "0.0.0.0", ws_port: 9222 }));
    const inspection = await inspectLiveAttachment(context({
      profilePath: temp,
      running: true,
      runningProcesses: [privilegedBrowserProcess(temp)]
    }));

    assert.equal(inspection.attachable, false);
    assert.match(inspection.blockers.join("\n"), /not local-only/);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("live attachment check refuses malformed BiDi server files", async () => {
  const temp = await mkdtemp(join(tmpdir(), "zts-live-check-malformed-"));
  try {
    await writeFile(join(temp, "WebDriverBiDiServer.json"), "{not-json");
    const inspection = await inspectLiveAttachment(context({
      profilePath: temp,
      running: true,
      runningProcesses: [privilegedBrowserProcess(temp)]
    }));

    assert.equal(inspection.attachable, false);
    assert.match(inspection.blockers.join("\n"), /not valid JSON/);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("live read proof refuses before the attachment gate passes", async () => {
  const temp = await mkdtemp(join(tmpdir(), "zts-live-read-refuse-"));
  try {
    const receipt = await runBridgeLiveReadProof(context({
      profilePath: temp,
      running: true,
      runningProcesses: [privilegedBrowserProcess(temp)]
    }), { timeoutMs: 1000 });

    assert.equal(receipt.ok, false);
    assert.equal(receipt.readProof, null);
    assert.match(receipt.blockers.join("\n"), /WebDriverBiDiServer\.json does not exist/);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("live read proof validates connected browser-chrome state without mutation", async () => {
  const temp = await mkdtemp(join(tmpdir(), "zts-live-read-pass-"));
  const originalWebSocket = globalThis.WebSocket;
  try {
    await writeFile(join(temp, "WebDriverBiDiServer.json"), JSON.stringify({ ws_host: "127.0.0.1", ws_port: 9222 }));
    globalThis.WebSocket = FakeWebSocket;
    const receipt = await runBridgeLiveReadProof(context({
      profilePath: temp,
      running: true,
      runningProcesses: [privilegedBrowserProcess(temp)]
    }), { timeoutMs: 1000 });

    assert.equal(receipt.ok, true);
    assert.deepEqual(receipt.blockers, []);
    assert.equal(receipt.readProof.chromeUrl, "chrome://browser/content/browser.xhtml");
    assert.equal(receipt.readProof.zenWorkspacesDetected, true);
    assert.equal(receipt.readProof.workspaceCount, 3);
    assert.equal(receipt.readProof.activeWorkspaceId, "workspace-1");
  } finally {
    globalThis.WebSocket = originalWebSocket;
    await rm(temp, { recursive: true, force: true });
  }
});

test("live move proof refuses without explicit confirmation and selectors", async () => {
  const temp = await mkdtemp(join(tmpdir(), "zts-live-move-refuse-"));
  try {
    const receipt = await runBridgeLiveMoveProof(context({
      profilePath: temp,
      running: true,
      runningProcesses: [privilegedBrowserProcess(temp)]
    }), { timeoutMs: 1000 });

    assert.equal(receipt.ok, false);
    assert.equal(receipt.attachment, null);
    assert.equal(receipt.moveProof, null);
    assert.match(receipt.blockers.join("\n"), /confirm-live-move/);
    assert.match(receipt.blockers.join("\n"), /--url/);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("live move proof validates one explicit eligible tab move", async () => {
  const temp = await mkdtemp(join(tmpdir(), "zts-live-move-pass-"));
  const originalWebSocket = globalThis.WebSocket;
  try {
    await writeFile(join(temp, "WebDriverBiDiServer.json"), JSON.stringify({ ws_host: "127.0.0.1", ws_port: 9222 }));
    globalThis.WebSocket = FakeWebSocket;
    const receipt = await runBridgeLiveMoveProof(context({
      profilePath: temp,
      running: true,
      runningProcesses: [privilegedBrowserProcess(temp)]
    }), {
      timeoutMs: 1000,
      confirmLiveMove: true,
      url: "https://example.test",
      fromWorkspaceId: "workspace-1",
      toWorkspaceId: "workspace-2"
    });

    assert.equal(receipt.ok, true);
    assert.deepEqual(receipt.blockers, []);
    assert.equal(receipt.moveProof.requestedUrl, "https://example.test");
    assert.equal(receipt.moveProof.beforeWorkspaceId, "workspace-1");
    assert.equal(receipt.moveProof.afterWorkspaceId, "workspace-2");
    assert.equal(receipt.moveProof.moved, true);
  } finally {
    globalThis.WebSocket = originalWebSocket;
    await rm(temp, { recursive: true, force: true });
  }
});

test("live move proof refuses before mutation when mutation session.status is not ready", async () => {
  const temp = await mkdtemp(join(tmpdir(), "zts-live-move-not-ready-"));
  const originalWebSocket = globalThis.WebSocket;
  try {
    await writeFile(join(temp, "WebDriverBiDiServer.json"), JSON.stringify({ ws_host: "127.0.0.1", ws_port: 9222 }));
    globalThis.WebSocket = FakeNotReadyOnSecondConnectionWebSocket;
    const receipt = await runBridgeLiveMoveProof(context({
      profilePath: temp,
      running: true,
      runningProcesses: [privilegedBrowserProcess(temp)]
    }), {
      timeoutMs: 1000,
      confirmLiveMove: true,
      url: "https://example.test",
      fromWorkspaceId: "workspace-1",
      toWorkspaceId: "workspace-2"
    });

    assert.equal(receipt.ok, false);
    assert.equal(receipt.moveProof, null);
    assert.match(receipt.blockers.join("\n"), /reported not ready/);
    assert.equal(FakeNotReadyOnSecondConnectionWebSocket.scriptEvaluateCount, 0);
  } finally {
    globalThis.WebSocket = originalWebSocket;
    FakeNotReadyOnSecondConnectionWebSocket.connectionCount = 0;
    FakeNotReadyOnSecondConnectionWebSocket.scriptEvaluateCount = 0;
    await rm(temp, { recursive: true, force: true });
  }
});

test("extracts the last WebDriver BiDi listener from probe logs", () => {
  const log = [
    "*** You are running in headless mode.",
    "WebDriver BiDi listening on ws://127.0.0.1:11111",
    "noise",
    "WebDriver BiDi listening on ws://127.0.0.1:22222"
  ].join("\n");

  assert.equal(bidiBaseUrlFromLog(log), "ws://127.0.0.1:22222");
  assert.equal(bidiBaseUrlFromLog("no listener"), null);
});

test("validates WebDriver BiDi session.status success shape", () => {
  assert.equal(validateBidiSessionStatus({ type: "success", id: 1, result: { ready: true, message: "" } }), null);
  assert.match(validateBidiSessionStatus({ type: "error", id: 1, error: "bad" }), /did not return success/);
  assert.match(validateBidiSessionStatus({ type: "success", id: 2, result: { ready: true, message: "" } }), /id did not match/);
  assert.match(validateBidiSessionStatus({ type: "success", id: 1, result: { ready: false, message: "busy" } }), /not ready/);
});

test("validates disposable script proof shape and Zen chrome reachability", () => {
  const proof = {
    sessionId: "session-1",
    contentContextCount: 1,
    chromeContextCount: 1,
    contentContext: "content-1",
    chromeContext: "chrome-1",
    contentEvaluation: remoteObject({ href: "about:blank" }),
    chromeEvaluation: remoteObject({
      href: "chrome://browser/content/browser.xhtml",
      hasZenWorkspaces: true,
      zenWorkspacesType: "object"
    }),
    workspaceOperation: workspaceOperation(),
    chromeUrl: "chrome://browser/content/browser.xhtml",
    zenWorkspacesDetected: true
  };

  assert.equal(validateBridgeProbeScriptProof(proof), null);
  assert.match(validateBridgeProbeScriptProof({ ...proof, contentEvaluation: remoteObject({ href: "chrome://browser/content/browser.xhtml" }) }), /content script proof/);
  assert.match(validateBridgeProbeScriptProof({ ...proof, chromeEvaluation: remoteObject({ href: "about:blank", hasZenWorkspaces: true }) }), /chrome context/);
  assert.match(validateBridgeProbeScriptProof({ ...proof, chromeEvaluation: remoteObject({ href: "chrome://browser/content/browser.xhtml", hasZenWorkspaces: false, zenWorkspacesType: "object" }) }), /gZenWorkspaces/);
  assert.match(validateBridgeProbeScriptProof({ ...proof, chromeEvaluation: remoteObject({ href: "chrome://browser/content/browser.xhtml", hasZenWorkspaces: true, zenWorkspacesType: "function" }) }), /as an object/);
});

test("validates live read proof shape and Zen chrome reachability", () => {
  const proof = {
    sessionId: "session-1",
    chromeContextCount: 1,
    chromeContext: "chrome-1",
    chromeEvaluation: remoteObject({
      href: "chrome://browser/content/browser.xhtml",
      hasZenWorkspaces: true,
      zenWorkspacesType: "object",
      workspaceCount: 3,
      activeWorkspaceId: "workspace-1"
    }),
    chromeUrl: "chrome://browser/content/browser.xhtml",
    zenWorkspacesDetected: true,
    workspaceCount: 3,
    activeWorkspaceId: "workspace-1"
  };

  assert.equal(validateBridgeLiveReadProof(proof), null);
  assert.match(validateBridgeLiveReadProof({ ...proof, chromeEvaluation: remoteObject({ href: "about:blank", hasZenWorkspaces: true, zenWorkspacesType: "object", workspaceCount: 3 }) }), /chrome context/);
  assert.match(validateBridgeLiveReadProof({ ...proof, chromeEvaluation: remoteObject({ href: "chrome://browser/content/browser.xhtml", hasZenWorkspaces: false, zenWorkspacesType: "object", workspaceCount: 3 }) }), /gZenWorkspaces/);
  assert.match(validateBridgeLiveReadProof({ ...proof, chromeEvaluation: remoteObject({ href: "chrome://browser/content/browser.xhtml", hasZenWorkspaces: true, zenWorkspacesType: "object", workspaceCount: 0 }) }), /positive workspace count/);
  assert.match(validateBridgeLiveReadProof({ ...proof, chromeEvaluation: remoteObject({ href: "chrome://browser/content/browser.xhtml", hasZenWorkspaces: true, zenWorkspacesType: "object", workspaceCount: 3, activeWorkspaceId: "" }) }), /active workspace id/);
});

test("validates live move proof shape and protected-tab refusal", () => {
  const proof = liveMoveProof();

  assert.equal(validateBridgeLiveMoveProof(proof), null);
  assert.match(validateBridgeLiveMoveProof({ ...proof, candidateCount: 2 }), /exactly one/);
  assert.match(validateBridgeLiveMoveProof({ ...proof, requestedToWorkspaceId: "workspace-1" }), /same source and destination/);
  assert.match(validateBridgeLiveMoveProof({ ...proof, protectedReasons: ["pinned"], tabPinned: true, moved: false }), /protected tab/);
  assert.match(validateBridgeLiveMoveProof({ ...proof, protectedReasons: ["grouped"], tabGrouped: true, moved: false }), /protected tab/);
  assert.match(validateBridgeLiveMoveProof({ ...proof, protectedReasons: ["foldered"], tabFoldered: true, moved: false }), /protected tab/);
  assert.match(validateBridgeLiveMoveProof({ ...proof, afterWorkspaceId: "workspace-1", moved: false, moveResult: false }), /requested destination/);
});

test("live move proof script checks live grouped and foldered tab property names", async () => {
  const source = await readFile(new URL("../src/bridge.ts", import.meta.url), "utf8");

  assert.match(source, /tab\?\.groupId/);
  assert.match(source, /tab\?\.zenLiveFolderItemId/);
});

test("validates disposable workspace operation proof", () => {
  assert.equal(validateBridgeProbeWorkspaceOperation(workspaceOperation()), null);
  assert.match(validateBridgeProbeWorkspaceOperation({ ...workspaceOperation(), targetWorkspaceId: "source" }), /same source and target/);
  assert.match(validateBridgeProbeWorkspaceOperation({ ...workspaceOperation(), afterWorkspaceId: "target" }), /did not move/);
  assert.match(validateBridgeProbeWorkspaceOperation({ ...workspaceOperation(), tabPinned: true }), /pinned/);
  assert.match(validateBridgeProbeWorkspaceOperation({ ...workspaceOperation(), tabEssential: true }), /essential/);
});

test("bridge probe reports spawn failures as blockers and cleans up temp profile", async () => {
  const receipt = await runBridgeProbe({ appPath: "/definitely/not/zen", timeoutMs: 1000 });

  assert.equal(receipt.ok, false);
  assert.equal(receipt.cleanedUp, true);
  assert.match(receipt.blockers.join("\n"), /Probe Zen process error/);
});

function context(overrides) {
  const selectedProfilePath = overrides.profilePath ?? profilePath;
  return {
    appSupportDir: "/Users/main/Library/Application Support/zen",
    profile: {
      id: overrides.profileId ?? "4le6r9n3.Default (release)",
      name: "Default",
      path: selectedProfilePath,
      isDefault: true,
      fromInstallDefault: true
    },
    running: overrides.running,
    runningProcesses: overrides.runningProcesses,
    sessionFile: {
      kind: "zen-sessions",
      path: `${selectedProfilePath}/zen-sessions.jsonlz4`,
      exists: true,
      size: 100,
      modifiedMs: 1
    }
  };
}

function privilegedBrowserProcess(selectedProfilePath) {
  return {
    pid: 42,
    args: `/Applications/Zen.app/Contents/MacOS/zen -profile ${selectedProfilePath} --remote-debugging-port=9222 --remote-allow-system-access --remote-allow-hosts localhost --remote-allow-origins http://127.0.0.1:9222`,
    profilePath: selectedProfilePath
  };
}

class FakeWebSocket {
  constructor(url) {
    this.url = url;
    this.listeners = new Map();
    this.connectionNumber = typeof this.constructor.connectionCount === "number"
      ? ++this.constructor.connectionCount
      : 0;
    setTimeout(() => this.emit("open", {}), 0);
  }

  addEventListener(type, callback) {
    const callbacks = this.listeners.get(type) ?? [];
    callbacks.push(callback);
    this.listeners.set(type, callbacks);
  }

  send(payload) {
    const request = JSON.parse(payload);
    setTimeout(() => this.emit("message", { data: JSON.stringify(this.responseFor(request)) }), 0);
  }

  close() {}

  responseFor(request) {
    return fakeBidiResponse(request);
  }

  emit(type, event) {
    for (const callback of this.listeners.get(type) ?? []) callback(event);
  }
}

class FakeNotReadyOnSecondConnectionWebSocket extends FakeWebSocket {
  static connectionCount = 0;
  static scriptEvaluateCount = 0;

  responseFor(request) {
    if (request.method === "script.evaluate") FakeNotReadyOnSecondConnectionWebSocket.scriptEvaluateCount += 1;
    if (request.method === "session.status" && this.connectionNumber === 2) {
      return { type: "success", id: request.id, result: { ready: false, message: "not ready" } };
    }
    return fakeBidiResponse(request);
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
    if (String(request.params?.expression ?? "").includes("moveTabToWorkspace")) {
      return {
        type: "success",
        id: request.id,
        result: remoteObject(liveMoveProofRemoteEntries())
      };
    }
    return {
      type: "success",
      id: request.id,
      result: remoteObject({
        href: "chrome://browser/content/browser.xhtml",
        title: "Zen Browser",
        hasZenWorkspaces: true,
        zenWorkspacesType: "object",
        workspaceCount: 3,
        activeWorkspaceId: "workspace-1"
      })
    };
  }
  if (request.method === "session.end") {
    return { type: "success", id: request.id, result: {} };
  }
  return { type: "error", id: request.id, error: "unknown command", message: request.method };
}

function liveMoveProof() {
  return {
    sessionId: "session-1",
    chromeContextCount: 1,
    chromeContext: "chrome-1",
    requestedUrl: "https://example.test",
    requestedFromWorkspaceId: "workspace-1",
    requestedToWorkspaceId: "workspace-2",
    candidateCount: 1,
    protectedReasons: [],
    beforeWorkspaceId: "workspace-1",
    afterWorkspaceId: "workspace-2",
    moved: true,
    moveResult: true,
    tabPinned: false,
    tabEssential: false,
    tabGrouped: false,
    tabFoldered: false,
    reason: "moved"
  };
}

function liveMoveProofRemoteEntries() {
  const proof = liveMoveProof();
  return {
    requestedUrl: proof.requestedUrl,
    requestedFromWorkspaceId: proof.requestedFromWorkspaceId,
    requestedToWorkspaceId: proof.requestedToWorkspaceId,
    candidateCount: proof.candidateCount,
    protectedReasons: proof.protectedReasons,
    beforeWorkspaceId: proof.beforeWorkspaceId,
    afterWorkspaceId: proof.afterWorkspaceId,
    moved: proof.moved,
    moveResult: proof.moveResult,
    tabPinned: proof.tabPinned,
    tabEssential: proof.tabEssential,
    tabGrouped: proof.tabGrouped,
    tabFoldered: proof.tabFoldered,
    reason: proof.reason
  };
}

function processArgs() {
  return `/Applications/Zen.app/Contents/MacOS/plugin-container.app/Contents/MacOS/plugin-container -profile ${profilePath} --remote-debugging-port 9222 --remote-allow-system-access`;
}

function remoteObject(entries) {
  return {
    type: "success",
    result: {
      type: "object",
      value: Object.entries(entries).map(([key, value]) => [
        key,
        remoteValue(value)
      ])
    }
  };
}

function remoteValue(value) {
  if (typeof value === "boolean") return { type: "boolean", value };
  if (typeof value === "number") return { type: "number", value };
  if (Array.isArray(value)) return { type: "array", value: value.map(remoteValue) };
  return { type: "string", value };
}

function workspaceOperation() {
  return {
    initialWorkspaceCount: 1,
    finalWorkspaceCount: 2,
    sourceWorkspaceId: "source",
    targetWorkspaceId: "target",
    beforeWorkspaceId: "target",
    afterWorkspaceId: "source",
    moved: true,
    sourceContainsTab: true,
    targetContainsTab: false,
    tabPinned: false,
    tabEssential: false
  };
}
