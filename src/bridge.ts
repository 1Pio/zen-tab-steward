import { spawn, ChildProcess } from "node:child_process";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { ProfileContext } from "./profile.js";
import { ZenProcess } from "./processes.js";

export type BridgeBackendStatus = "unavailable";
export type BridgeCheckStatus = "pass" | "fail" | "warn";
export type BridgeProcessRole = "browser" | "content" | "gpu" | "utility" | "other";

export interface BridgeFlags {
  remoteDebuggingPort: boolean;
  startDebuggerServer: boolean;
  marionette: boolean;
  remoteAllowHosts: boolean;
  remoteAllowOrigins: boolean;
  remoteAllowSystemAccess: boolean;
}

export interface BridgeProcessSummary {
  pid: number;
  role: BridgeProcessRole;
  profilePath: string | null;
  profileMatched: boolean;
  flags: BridgeFlags;
}

export interface BridgeCheck {
  id: string;
  label: string;
  status: BridgeCheckStatus;
  detail: string;
}

export interface BridgeInspection {
  liveBackend: {
    status: BridgeBackendStatus;
    applySupported: false;
    reason: string;
  };
  zenRunning: boolean;
  profilePath: string;
  candidateTransportDetected: boolean;
  candidatePrivilegedTransportDetected: boolean;
  requiredLaunchFlags: string[];
  candidateInternalApis: string[];
  processes: BridgeProcessSummary[];
  checks: BridgeCheck[];
  warnings: string[];
  blockers: string[];
  suggestedNextCommands: string[];
}

export interface BridgeProbeReceipt {
  ok: boolean;
  startedAt: string;
  durationMs: number;
  appPath: string;
  profilePath: string;
  port: number;
  websocketUrl: string | null;
  processPid: number | null;
  sessionStatus: unknown | null;
  scriptProof: BridgeProbeScriptProof | null;
  warnings: string[];
  blockers: string[];
  logTail: string[];
  cleanedUp: boolean;
}

export interface BridgeProbeScriptProof {
  sessionId: string;
  contentContextCount: number;
  chromeContextCount: number;
  contentContext: string;
  chromeContext: string;
  contentEvaluation: unknown;
  chromeEvaluation: unknown;
  chromeUrl: string | null;
  zenWorkspacesDetected: boolean;
}

export interface BidiSessionStatusSuccess {
  type: "success";
  id: number;
  result: {
    ready: boolean;
    message: string;
  };
}

export interface BridgeProbeOptions {
  appPath?: string;
  timeoutMs?: number;
}

export function inspectBridge(context: ProfileContext): BridgeInspection {
  const processes = context.runningProcesses.map((process) => summarizeBridgeProcess(process, context.profile.path));
  const browserProcesses = processes.filter((process) => process.role === "browser");
  const matchingBrowserProcesses = browserProcesses.filter((process) => process.profileMatched || process.profilePath === null);
  const candidateTransportDetected = matchingBrowserProcesses.some(hasCandidateTransport);
  const candidatePrivilegedTransportDetected = matchingBrowserProcesses.some(
    (process) => hasCandidateTransport(process) && process.flags.remoteAllowSystemAccess
  );

  const blockers = bridgeBlockers(context.running, candidateTransportDetected, candidatePrivilegedTransportDetected);
  const warnings = candidateTransportDetected
    ? ["Remote launch flags are only transport evidence; live apply remains disabled until a client can safely execute and verify Zen chrome code."]
    : [];

  return {
    liveBackend: {
      status: "unavailable",
      applySupported: false,
      reason: "No safe CLI-to-Zen browser-chrome execution client is implemented yet."
    },
    zenRunning: context.running,
    profilePath: context.profile.path,
    candidateTransportDetected,
    candidatePrivilegedTransportDetected,
    requiredLaunchFlags: [
      "--remote-debugging-port or --start-debugger-server",
      "--remote-allow-system-access",
      "--remote-allow-hosts <hosts>",
      "--remote-allow-origins <origins>"
    ],
    candidateInternalApis: [
      "gZenWorkspaces.changeWorkspaceWithID(...)",
      "gZenWorkspaces.saveWorkspace(...)",
      "ZenWindowSync.moveTabsToSyncedWorkspace(...)"
    ],
    processes,
    checks: bridgeChecks(context.running, browserProcesses.length, candidateTransportDetected, candidatePrivilegedTransportDetected),
    warnings,
    blockers,
    suggestedNextCommands: ["zts bridge doctor", "zts sort --preview", "zts status"]
  };
}

export function summarizeBridgeProcess(process: ZenProcess, profilePath: string): BridgeProcessSummary {
  const role = processRole(process.args);
  return {
    pid: process.pid,
    role,
    profilePath: process.profilePath ?? null,
    profileMatched: process.profilePath === profilePath || (role === "browser" && process.profilePath === undefined),
    flags: {
      remoteDebuggingPort: hasFlag(process.args, "--remote-debugging-port"),
      startDebuggerServer: hasFlag(process.args, "--start-debugger-server"),
      marionette: hasFlag(process.args, "--marionette"),
      remoteAllowHosts: hasFlag(process.args, "--remote-allow-hosts"),
      remoteAllowOrigins: hasFlag(process.args, "--remote-allow-origins"),
      remoteAllowSystemAccess: hasFlag(process.args, "--remote-allow-system-access")
    }
  };
}

export async function runBridgeProbe(options: BridgeProbeOptions = {}): Promise<BridgeProbeReceipt> {
  const startedAt = new Date();
  const startedMs = Date.now();
  const appPath = options.appPath ?? "/Applications/Zen.app/Contents/MacOS/zen";
  const timeoutMs = options.timeoutMs ?? 8000;
  const probeRoot = await mkdtemp(join(tmpdir(), "zts-bridge-probe-"));
  const profilePath = join(probeRoot, "profile");
  await mkdir(profilePath, { recursive: true });
  const port = await reservePort();
  let child: ChildProcess | null = null;
  let log = "";
  let websocketUrl: string | null = null;
  let sessionStatus: unknown | null = null;
  let scriptProof: BridgeProbeScriptProof | null = null;
  const blockers: string[] = [];
  const spawnErrors: string[] = [];
  let cleanedUp = false;
  let processStopped = true;

  try {
    const args = [
      "--headless",
      "--new-instance",
      "--profile",
      profilePath,
      "--remote-debugging-port",
      String(port),
      "--remote-allow-hosts",
      "127.0.0.1,localhost",
      "--remote-allow-origins",
      "*",
      "--remote-allow-system-access",
      "about:blank"
    ];

    child = spawn(appPath, args, { stdio: ["ignore", "pipe", "pipe"] });
    processStopped = false;
    child.on("error", (error) => {
      const message = `Probe Zen process error: ${error.message}`;
      spawnErrors.push(message);
      log = appendTextLog(log, `${message}\n`);
    });
    child.stdout?.on("data", (chunk) => {
      log = appendLog(log, chunk);
    });
    child.stderr?.on("data", (chunk) => {
      log = appendLog(log, chunk);
    });

    const baseUrl = await waitForBidiBaseUrl(() => log, timeoutMs);
    blockers.push(...spawnErrors);
    if (!baseUrl) {
      blockers.push("Zen did not report a WebDriver BiDi listener before timeout");
    } else {
      websocketUrl = `${baseUrl}/session`;
      const bidiProof = await runBidiScriptProof(websocketUrl, timeoutMs);
      sessionStatus = bidiProof.sessionStatus;
      scriptProof = bidiProof.scriptProof;
      const validationError = validateBidiSessionStatus(sessionStatus);
      if (validationError) blockers.push(validationError);
      const scriptProofError = validateBridgeProbeScriptProof(scriptProof);
      if (scriptProofError) blockers.push(scriptProofError);
    }
  } catch (error) {
    blockers.push(error instanceof Error ? error.message : String(error));
  } finally {
    if (child) processStopped = await stopChild(child);
    if (!processStopped) blockers.push("Probe Zen process did not exit after termination signals");
    try {
      await rm(probeRoot, { recursive: true, force: true });
      cleanedUp = true;
    } catch {
      cleanedUp = false;
      blockers.push("Probe temporary profile could not be removed");
    }
  }

  return {
    ok: blockers.length === 0,
    startedAt: startedAt.toISOString(),
    durationMs: Date.now() - startedMs,
    appPath,
    profilePath,
    port,
    websocketUrl,
    processPid: child?.pid ?? null,
    sessionStatus,
    scriptProof,
    warnings: ["Probe used a disposable headless Zen profile and did not touch the discovered live profile."],
    blockers,
    logTail: tailLines(log, 20),
    cleanedUp
  };
}

function bridgeBlockers(zenRunning: boolean, candidateTransportDetected: boolean, candidatePrivilegedTransportDetected: boolean): string[] {
  const blockers = ["Live backend client is not implemented yet"];
  if (!zenRunning) {
    blockers.push("Zen is not running, so no live browser-chrome bridge can be inspected");
    return blockers;
  }
  if (!candidateTransportDetected) {
    blockers.push("Current Zen browser process has no remote debugging, debugger server, or Marionette launch flag");
  }
  if (!candidatePrivilegedTransportDetected) {
    blockers.push("Current Zen browser process has no privileged remote system-access launch flag");
  }
  return blockers;
}

function bridgeChecks(
  zenRunning: boolean,
  browserProcessCount: number,
  candidateTransportDetected: boolean,
  candidatePrivilegedTransportDetected: boolean
): BridgeCheck[] {
  return [
    {
      id: "zen_running",
      label: "Zen running",
      status: zenRunning ? "pass" : "fail",
      detail: zenRunning ? "A Zen process is running." : "No Zen process is running."
    },
    {
      id: "browser_process",
      label: "Browser process",
      status: browserProcessCount > 0 ? "pass" : "fail",
      detail: `${browserProcessCount} browser process${browserProcessCount === 1 ? "" : "es"} found.`
    },
    {
      id: "candidate_transport",
      label: "Remote transport launch flag",
      status: candidateTransportDetected ? "pass" : "fail",
      detail: candidateTransportDetected
        ? "A browser process has a remote debugging, debugger server, or Marionette launch flag."
        : "No browser process has a remote debugging, debugger server, or Marionette launch flag."
    },
    {
      id: "privileged_transport",
      label: "Privileged chrome access flag",
      status: candidatePrivilegedTransportDetected ? "pass" : "fail",
      detail: candidatePrivilegedTransportDetected
        ? "A candidate browser process has --remote-allow-system-access."
        : "No candidate browser process has --remote-allow-system-access."
    },
    {
      id: "live_client",
      label: "Live bridge client",
      status: "fail",
      detail: "No live bridge client is implemented, so live apply is unavailable."
    }
  ];
}

function hasCandidateTransport(process: BridgeProcessSummary): boolean {
  return process.flags.remoteDebuggingPort || process.flags.startDebuggerServer || process.flags.marionette;
}

function processRole(args: string): BridgeProcessRole {
  if (args.includes("/Contents/MacOS/zen")) return "browser";
  if (args.includes("/plugin-container.app/")) return "content";
  if (args.includes("/gpu-helper.app/")) return "gpu";
  if (args.includes(" utility")) return "utility";
  return "other";
}

function hasFlag(args: string, flag: string): boolean {
  return args.split(/\s+/).some((part) => part === flag || part.startsWith(`${flag}=`));
}

export function bidiBaseUrlFromLog(log: string): string | null {
  const matches = [...log.matchAll(/^WebDriver BiDi listening on (ws:\/\/[^\s]+)$/gm)];
  const last = matches.at(-1);
  return last?.[1] ?? null;
}

export function validateBidiSessionStatus(value: unknown): string | null {
  if (!isRecord(value)) return "WebDriver BiDi session.status response was not an object";
  if (value.type !== "success") return "WebDriver BiDi session.status did not return success";
  if (value.id !== 1) return "WebDriver BiDi session.status response id did not match request id";
  if (!isRecord(value.result)) return "WebDriver BiDi session.status response had no result object";
  if (value.result.ready !== true) return "WebDriver BiDi session.status reported not ready";
  if (typeof value.result.message !== "string") return "WebDriver BiDi session.status response had no message string";
  return null;
}

export function validateBridgeProbeScriptProof(value: unknown): string | null {
  if (!isRecord(value)) return "WebDriver BiDi script proof was not returned";
  if (typeof value.sessionId !== "string" || value.sessionId.length === 0) return "WebDriver BiDi script proof had no session id";
  if (typeof value.contentContextCount !== "number" || !Number.isInteger(value.contentContextCount) || value.contentContextCount < 1) return "WebDriver BiDi script proof found no content contexts";
  if (typeof value.chromeContextCount !== "number" || !Number.isInteger(value.chromeContextCount) || value.chromeContextCount < 1) return "WebDriver BiDi script proof found no chrome contexts";
  if (typeof value.contentContext !== "string" || value.contentContext.length === 0) return "WebDriver BiDi script proof had no content context id";
  if (typeof value.chromeContext !== "string" || value.chromeContext.length === 0) return "WebDriver BiDi script proof had no chrome context id";
  if (remoteStringValue(value.contentEvaluation, "href") !== "about:blank") {
    return "WebDriver BiDi content script proof did not execute in the disposable content context";
  }
  if (remoteStringValue(value.chromeEvaluation, "href") !== "chrome://browser/content/browser.xhtml") {
    return "WebDriver BiDi chrome script proof did not execute in the Zen browser chrome context";
  }
  if (remoteBooleanValue(value.chromeEvaluation, "hasZenWorkspaces") !== true) {
    return "WebDriver BiDi chrome script proof did not detect gZenWorkspaces";
  }
  if (remoteStringValue(value.chromeEvaluation, "zenWorkspacesType") !== "object") {
    return "WebDriver BiDi chrome script proof did not verify gZenWorkspaces as an object";
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function appendLog(log: string, chunk: Buffer): string {
  return appendTextLog(log, chunk.toString("utf8"));
}

function appendTextLog(log: string, text: string): string {
  const next = log + text;
  return next.length > 64 * 1024 ? next.slice(-64 * 1024) : next;
}

async function reservePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Could not reserve a local TCP port")));
        return;
      }
      const port = address.port;
      server.close(() => resolve(port));
    });
  });
}

async function waitForBidiBaseUrl(readLog: () => string, timeoutMs: number): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const baseUrl = bidiBaseUrlFromLog(readLog());
    if (baseUrl) return baseUrl;
    await sleep(100);
  }
  return bidiBaseUrlFromLog(readLog());
}

async function runBidiScriptProof(
  websocketUrl: string,
  timeoutMs: number
): Promise<{ sessionStatus: unknown; scriptProof: BridgeProbeScriptProof }> {
  const WebSocketConstructor = globalThis.WebSocket;
  if (!WebSocketConstructor) throw new Error("This Node runtime does not provide a WebSocket client");

  return new Promise((resolve, reject) => {
    const ws = new WebSocketConstructor(websocketUrl);
    let nextId = 1;
    const pending = new Map<number, { method: string; resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void }>();
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      ws.close();
      reject(new Error("Timed out waiting for WebDriver BiDi script proof"));
    }, timeoutMs);

    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      ws.close();
      reject(error);
    };
    const finish = (value: { sessionStatus: unknown; scriptProof: BridgeProbeScriptProof }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      ws.close();
      resolve(value);
    };
    const send = (method: string, params: Record<string, unknown> = {}) => {
      const id = nextId++;
      ws.send(JSON.stringify({ id, method, params }));
      return new Promise<Record<string, unknown>>((resolveCommand, rejectCommand) => {
        pending.set(id, { method, resolve: resolveCommand, reject: rejectCommand });
      });
    };

    ws.addEventListener("open", async () => {
      try {
        const sessionStatus = await send("session.status");
        const session = await send("session.new", { capabilities: { alwaysMatch: { webSocketUrl: true } } });
        const sessionId = sessionIdFromSessionNew(session.result);
        const contentTree = await send("browsingContext.getTree");
        const chromeTree = await send("browsingContext.getTree", { "moz:scope": "chrome" });
        const contentContext = firstContextId(contentTree.result, "content");
        const chromeContext = firstContextId(chromeTree.result, "chrome");
        const contentEvaluation = await send("script.evaluate", {
          expression: "(() => ({ href: location.href, title: document.title }))()",
          awaitPromise: false,
          target: { context: contentContext },
          resultOwnership: "none"
        });
        const chromeEvaluation = await send("script.evaluate", {
          expression: "(() => ({ href: location.href, title: document.title, hasZenWorkspaces: typeof gZenWorkspaces !== 'undefined', zenWorkspacesType: typeof gZenWorkspaces }))()",
          awaitPromise: false,
          target: { context: chromeContext },
          resultOwnership: "none"
        });

        try {
          await send("session.end");
        } catch {
          // The process is disposable and will be terminated by the caller.
        }

        finish({
          sessionStatus,
          scriptProof: {
            sessionId,
            contentContextCount: contextCount(contentTree.result),
            chromeContextCount: contextCount(chromeTree.result),
            contentContext,
            chromeContext,
            contentEvaluation: contentEvaluation.result,
            chromeEvaluation: chromeEvaluation.result,
            chromeUrl: remoteStringValue(chromeEvaluation.result, "href"),
            zenWorkspacesDetected: remoteBooleanValue(chromeEvaluation.result, "hasZenWorkspaces") === true
          }
        });
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)));
      }
    });
    ws.addEventListener("message", (event) => {
      let message: unknown;
      try {
        message = JSON.parse(String(event.data));
      } catch {
        fail(new Error("WebDriver BiDi returned non-JSON response"));
        return;
      }
      if (!isRecord(message)) return;
      if (message.type === "event") return;
      if (typeof message.id !== "number") return;
      const command = pending.get(message.id);
      if (!command) return;
      pending.delete(message.id);
      if (message.type === "success") command.resolve(message);
      else command.reject(new Error(`${command.method}: ${String(message.error ?? "error")}: ${String(message.message ?? "unknown error")}`));
    });
    ws.addEventListener("error", () => {
      fail(new Error("WebDriver BiDi WebSocket connection failed"));
    });
  });
}

function sessionIdFromSessionNew(value: unknown): string {
  if (!isRecord(value) || typeof value.sessionId !== "string" || value.sessionId.length === 0) {
    throw new Error("WebDriver BiDi session.new did not return a session id");
  }
  return value.sessionId;
}

function contextCount(value: unknown): number {
  if (!isRecord(value) || !Array.isArray(value.contexts)) return 0;
  return value.contexts.length;
}

function firstContextId(value: unknown, label: string): string {
  if (!isRecord(value) || !Array.isArray(value.contexts)) {
    throw new Error(`WebDriver BiDi ${label} context tree was missing contexts`);
  }
  const context = value.contexts[0];
  if (!isRecord(context) || typeof context.context !== "string" || context.context.length === 0) {
    throw new Error(`WebDriver BiDi ${label} context tree had no usable context id`);
  }
  return context.context;
}

function remoteStringValue(value: unknown, key: string): string | null {
  const entry = remoteObjectEntry(value, key);
  return entry && entry.type === "string" && typeof entry.value === "string" ? entry.value : null;
}

function remoteBooleanValue(value: unknown, key: string): boolean | null {
  const entry = remoteObjectEntry(value, key);
  return entry && entry.type === "boolean" && typeof entry.value === "boolean" ? entry.value : null;
}

function remoteObjectEntry(value: unknown, key: string): Record<string, unknown> | null {
  if (!isRecord(value) || value.type !== "success" || !isRecord(value.result) || !Array.isArray(value.result.value)) return null;
  for (const item of value.result.value) {
    if (!Array.isArray(item) || item.length !== 2) continue;
    if (item[0] === key && isRecord(item[1])) return item[1];
  }
  return null;
}

async function stopChild(child: ChildProcess): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  child.kill("SIGTERM");
  if (await waitForChildExit(child, 1500)) return true;
  child.kill("SIGKILL");
  return waitForChildExit(child, 1500);
}

function waitForChildExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve(child.exitCode !== null || child.signalCode !== null);
    }, timeoutMs);
    const onExit = () => {
      cleanup();
      resolve(true);
    };
    const cleanup = () => {
      clearTimeout(timer);
      child.off("exit", onExit);
    };
    child.once("exit", onExit);
  });
}

function tailLines(text: string, count: number): string[] {
  return text.trim().split(/\r?\n/).filter(Boolean).slice(-count);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
