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
