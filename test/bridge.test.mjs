import assert from "node:assert/strict";
import test from "node:test";
import { bidiBaseUrlFromLog, inspectBridge, runBridgeProbe, summarizeBridgeProcess, validateBidiSessionStatus, validateBridgeProbeScriptProof, validateBridgeProbeWorkspaceOperation } from "../dist/bridge.js";
import { parseZenProcesses } from "../dist/processes.js";

const profilePath = "/Users/main/Library/Application Support/zen/Profiles/4le6r9n3.Default (release)";

test("bridge inspection fails closed when Zen is not running", () => {
  const inspection = inspectBridge(context({ running: false, runningProcesses: [] }));

  assert.equal(inspection.liveBackend.status, "unavailable");
  assert.equal(inspection.liveBackend.applySupported, false);
  assert.equal(inspection.candidateTransportDetected, false);
  assert.equal(inspection.candidatePrivilegedTransportDetected, false);
  assert.match(inspection.blockers.join("\n"), /not implemented/);
  assert.match(inspection.blockers.join("\n"), /not running/);
  assert.equal(inspection.checks.find((check) => check.id === "live_client").status, "fail");
});

test("bridge inspection detects privileged remote launch evidence without enabling live apply", () => {
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
  assert.equal(inspection.liveBackend.status, "unavailable");
  assert.equal(inspection.liveBackend.applySupported, false);
  assert.deepEqual(inspection.blockers, ["Live backend client is not implemented yet"]);
  assert.match(inspection.warnings.join("\n"), /Remote launch flags are only transport evidence/);
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
  assert.deepEqual(inspection.blockers, ["Live backend client is not implemented yet"]);
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
  return {
    appSupportDir: "/Users/main/Library/Application Support/zen",
    profile: {
      id: "4le6r9n3.Default (release)",
      name: "Default",
      path: profilePath,
      isDefault: true,
      fromInstallDefault: true
    },
    running: overrides.running,
    runningProcesses: overrides.runningProcesses,
    sessionFile: {
      kind: "zen-sessions",
      path: `${profilePath}/zen-sessions.jsonlz4`,
      exists: true,
      size: 100,
      modifiedMs: 1
    }
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
        typeof value === "boolean" ? { type: "boolean", value } : { type: "string", value }
      ])
    }
  };
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
