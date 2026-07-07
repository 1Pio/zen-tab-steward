import assert from "node:assert/strict";
import test from "node:test";
import { inspectBridge, summarizeBridgeProcess } from "../dist/bridge.js";
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
