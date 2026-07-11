import assert from "node:assert/strict";
import test from "node:test";
import {
  bindZenProcessTree,
  captureManagedZenLifecycleBinding,
  parseZenProcessInventory,
  quitManagedZen,
  relaunchManagedZen
} from "../dist/managed-zen-lifecycle.js";

test("managed Zen binds a profileless browser root through its exact-Profile descendants", () => {
  const profilePath = "/Users/main/Library/Application Support/zen/Profiles/4le6r9n3.Default (release)";
  const executablePath = "/Applications/Zen.app/Contents/MacOS/zen";
  const processes = parseZenProcessInventory(`
97897 1 501 Sat Jul 11 16:27:24 2026 ${executablePath}
97914 97897 501 Sat Jul 11 16:27:24 2026 /Applications/Zen.app/Contents/MacOS/plugin-container.app/Contents/MacOS/plugin-container -profile ${profilePath} org.mozilla.machname.1 1 socket
97928 97897 501 Sat Jul 11 16:27:24 2026 /Applications/Zen.app/Contents/MacOS/gpu-helper.app/Contents/MacOS/Zen GPU Helper -profile ${profilePath} org.mozilla.machname.2 2 gpu
300 1 501 Sat Jul 11 16:27:24 2026 node -e "inspect /Applications/Zen.app/Contents/MacOS/ without becoming Zen"
  `);

  const binding = bindZenProcessTree(processes, {
    profilePath,
    executablePath,
    uid: 501
  });

  assert.equal(binding.root.pid, 97897);
  assert.equal(binding.root.ppid, 1);
  assert.equal(binding.root.processStartIdentity, "darwin-ps-lstart-utc:Sat Jul 11 16:27:24 2026");
  assert.deepEqual(binding.processPids, [97897, 97914, 97928]);
  assert.deepEqual(binding.profileEvidencePids, [97914, 97928]);
  assert.match(binding.revision, /^sha256:[a-f0-9]{64}$/u);
});

test("managed Zen gracefully quits one exact binding and restores the same Profile and window shape", async () => {
  const profilePath = "/tmp/zts-managed-profile";
  const executablePath = "/Applications/Zen.app/Contents/MacOS/zen";
  let phase = "initial";
  const calls = [];
  const inventory = (rootPid, childPid, start) => parseZenProcessInventory(`
${rootPid} 1 501 ${start} ${executablePath}
${childPid} ${rootPid} 501 ${start} /Applications/Zen.app/Contents/MacOS/plugin-container.app/Contents/MacOS/plugin-container -profile ${profilePath} org.mozilla.machname.1 1 socket
  `);
  const platform = {
    async listProcesses() {
      if (phase === "closed") return [];
      return phase === "initial"
        ? inventory(100, 101, "Sat Jul 11 16:27:24 2026")
        : inventory(200, 201, "Sat Jul 11 16:28:24 2026");
    },
    async inspectApplication(pid) {
      return {
        pid,
        bundleIdentifier: "app.zen-browser.zen",
        executablePath,
        bundlePath: "/Applications/Zen.app",
        version: "1.19.3b",
        bundleVersion: "126.3.15",
        teamIdentifier: "9V5K9TP787",
        codeDirectoryHash: "8533af",
        executableDevice: 1,
        executableInode: 2,
        executableSize: 3,
        executableModifiedMs: 4
      };
    },
    async inspectWindows(pid) {
      calls.push(["inspectWindows", pid]);
      return [{
        visible: true,
        miniaturized: false,
        bounds: { x: 100, y: 50, width: 1200, height: 900 }
      }];
    },
    async requestGracefulQuit(pid) {
      calls.push(["requestGracefulQuit", pid]);
      phase = "closed";
      return true;
    },
    async launch(application) {
      calls.push(["launch", application.bundlePath, application.profilePath]);
      phase = "relaunched";
    },
    async wait() {}
  };

  const request = {
    profilePath,
    executablePath,
    uid: 501,
    bundleIdentifier: "app.zen-browser.zen"
  };
  const before = await captureManagedZenLifecycleBinding(platform, request);
  const closed = await quitManagedZen(platform, before, { timeoutMs: 100, pollMs: 1 });
  const reopened = await relaunchManagedZen(platform, before, { timeoutMs: 100, pollMs: 1 });

  assert.equal(closed.quit, "verified");
  assert.equal(closed.stateFlush, "pending_native_profile_control");
  assert.equal(reopened.rootPid, 200);
  assert.notEqual(reopened.processStartIdentity, before.processStartIdentity);
  assert.equal(reopened.windowState.revision, before.windowState.revision);
  assert.deepEqual(calls, [
    ["inspectWindows", 100],
    ["inspectWindows", 100],
    ["requestGracefulQuit", 100],
    ["launch", "/Applications/Zen.app", profilePath],
    ["inspectWindows", 200],
    ["inspectWindows", 200]
  ]);
});

test("managed Zen relaunch waits past a transient browser root before accepting restoration", async () => {
  const profilePath = "/tmp/zts-managed-stable-profile";
  const executablePath = "/Applications/Zen.app/Contents/MacOS/zen";
  let phase = "initial";
  let relaunchedReads = 0;
  const inventory = (rootPid, childPid, second) => parseZenProcessInventory(`
${rootPid} 1 501 Sat Jul 11 16:${second}:24 2026 ${executablePath}
${childPid} ${rootPid} 501 Sat Jul 11 16:${second}:24 2026 /Applications/Zen.app/Contents/MacOS/plugin-container.app/Contents/MacOS/plugin-container -profile ${profilePath} org.mozilla.machname.1 1 socket
  `);
  const platform = {
    async listProcesses() {
      if (phase === "initial") return inventory(100, 101, "27");
      if (phase === "closed") return [];
      relaunchedReads += 1;
      return relaunchedReads <= 1 ? inventory(200, 201, "28") : inventory(300, 301, "29");
    },
    async inspectApplication(pid) {
      return {
        pid,
        bundleIdentifier: "app.zen-browser.zen",
        executablePath,
        bundlePath: "/Applications/Zen.app",
        version: "1.19.3b",
        bundleVersion: "126.3.15",
        teamIdentifier: "9V5K9TP787",
        codeDirectoryHash: "8533af",
        executableDevice: 1,
        executableInode: 2,
        executableSize: 3,
        executableModifiedMs: 4
      };
    },
    async inspectWindows() {
      return [{ visible: true, miniaturized: false, bounds: { x: 10, y: 10, width: 1000, height: 800 } }];
    },
    async requestGracefulQuit() {
      phase = "closed";
      return true;
    },
    async launch() {
      phase = "relaunched";
    },
    async wait() {}
  };
  const request = {
    profilePath,
    executablePath,
    uid: 501,
    bundleIdentifier: "app.zen-browser.zen"
  };

  const before = await captureManagedZenLifecycleBinding(platform, request);
  await quitManagedZen(platform, before, { timeoutMs: 100, pollMs: 1 });
  const reopened = await relaunchManagedZen(platform, before, { timeoutMs: 100, pollMs: 1 });

  assert.equal(reopened.rootPid, 300);
});

test("managed Zen does not claim closure while an originally bound profileless descendant survives", async () => {
  const profilePath = "/tmp/zts-managed-surviving-descendant-profile";
  const executablePath = "/Applications/Zen.app/Contents/MacOS/zen";
  let read = 0;
  const original = parseZenProcessInventory(`
100 1 501 Sat Jul 11 16:27:24 2026 ${executablePath}
101 100 501 Sat Jul 11 16:27:24 2026 /Applications/Zen.app/Contents/MacOS/plugin-container.app/Contents/MacOS/plugin-container -profile ${profilePath} org.mozilla.socket
102 100 501 Sat Jul 11 16:27:24 2026 /Applications/Zen.app/Contents/MacOS/gpu-helper.app/Contents/MacOS/gpu-helper gpu
  `);
  const platform = {
    async listProcesses() {
      read += 1;
      if (read <= 2) return original;
      return read === 3 ? [original[2]] : [];
    },
    async inspectApplication(pid) {
      return {
        pid,
        bundleIdentifier: "app.zen-browser.zen",
        executablePath,
        bundlePath: "/Applications/Zen.app",
        version: "1.19.3b",
        bundleVersion: "126.3.15",
        teamIdentifier: "9V5K9TP787",
        codeDirectoryHash: "8533af",
        executableDevice: 1,
        executableInode: 2,
        executableSize: 3,
        executableModifiedMs: 4
      };
    },
    async inspectWindows() {
      return [{ visible: true, miniaturized: false, bounds: { x: 0, y: 0, width: 1000, height: 800 } }];
    },
    async requestGracefulQuit() { return true; },
    async launch() {},
    async wait() {}
  };
  const before = await captureManagedZenLifecycleBinding(platform, {
    profilePath,
    executablePath,
    uid: 501,
    bundleIdentifier: "app.zen-browser.zen"
  });

  const closed = await quitManagedZen(platform, before, { timeoutMs: 100, pollMs: 1 });

  assert.equal(closed.quit, "verified");
  assert.equal(read, 4, "closure must wait for every originally bound process identity");
});
