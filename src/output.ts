import { BackupManifest, BackupPruneReceipt } from "./backup.js";
import { ProfileContext } from "./profile.js";
import { SessionSummary } from "./session.js";
import { VERSION } from "./version.js";
import { configPath } from "./paths.js";
import { backupRootForProfile } from "./backup.js";
import { BridgeInspection, BridgeLiveAttachmentInspection, BridgeLiveReadReceipt, BridgeProbeReceipt } from "./bridge.js";
import { terminalText as t } from "./terminal.js";
import type { TabView, WorkspaceView } from "./views.js";
import type { Snapshot } from "./domain/snapshot.js";

export interface SnapshotObservationPresentation {
  readonly zenRunning: boolean;
  readonly authority: Snapshot["authority"];
  readonly freshness: Snapshot["freshness"];
}

export interface CommandEnvelope<T> {
  version: string;
  command: string;
  ok: boolean;
  data: T;
  warnings: string[];
  blockers: string[];
  suggestedNextCommands: string[];
}

export function envelope<T>(
  command: string,
  data: T,
  options: Partial<Pick<CommandEnvelope<T>, "ok" | "warnings" | "blockers" | "suggestedNextCommands">> = {}
): CommandEnvelope<T> {
  return {
    version: VERSION,
    command,
    ok: options.ok ?? true,
    data,
    warnings: options.warnings ?? [],
    blockers: options.blockers ?? [],
    suggestedNextCommands: options.suggestedNextCommands ?? []
  };
}

export function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

export function formatStatus(context: ProfileContext, summary: SessionSummary, bridge: BridgeInspection): string {
  const blockers = context.running
    ? ["Offline apply: blocked because Zen is running", ...bridge.blockers.map((blocker) => `Live bridge: ${blocker}`)]
    : bridge.blockers.map((blocker) => `Live bridge: ${blocker}`);

  return [
    "Zen Tab Steward status",
    `Version: ${VERSION}`,
    `Profile: ${t(context.profile.name)} (${t(context.profile.id)})`,
    `Profile path: ${t(context.profile.path)}`,
    `Zen: ${context.running ? "running" : "not running"}`,
    `Session read: available (${summary.source.kind})`,
    `Session observation: persisted disk observation${context.running ? "; may be stale while Zen is running" : "; Snapshot authority is established only inside a controlled capture"}`,
    `Session file: ${t(summary.source.path)}`,
    `Workspaces: ${summary.workspaceCount}`,
    `Tabs: ${summary.tabCount}`,
    `Pinned: ${summary.pinnedCount}`,
    `Essentials: ${summary.essentialCount}`,
    `Folders/groups: ${summary.folderGroupCount} (${summary.folderCount} folders, ${summary.groupCount} groups)`,
    `Config: ${t(configPath())}`,
    `Backups: ${t(backupRootForProfile(context.profile.id))}`,
    `Closed-session apply: ${context.running ? "blocked while Zen is running" : "candidate only; native Profile control, primary source, unfinished state, and exact Plan are checked at apply time"}`,
    `Live bridge: ${bridge.liveBackend.status} (${t(bridge.liveBackend.reason)})`,
    "Safety posture: process absence never grants mutation authority; every apply is re-authorized at its mutation boundary",
    "",
    "Blockers:",
    ...(blockers.length > 0 ? blockers.map((blocker) => `  - ${t(blocker)}`) : ["  - none"]),
    "",
    "Next:",
    "  zts workspaces",
    "  zts bridge status",
    "  zts backup",
    "  zts sort --preview"
  ].join("\n");
}

export function formatBridge(bridge: BridgeInspection, mode: "status" | "doctor"): string {
  const lines = [
    mode === "doctor" ? "Zen live bridge doctor" : "Zen live bridge status",
    `Live backend: ${bridge.liveBackend.status}`,
    `Apply supported: ${bridge.liveBackend.applySupported ? "yes" : "no"}`,
    `Reason: ${t(bridge.liveBackend.reason)}`,
    `Profile path: ${t(bridge.profilePath)}`,
    `Zen: ${bridge.zenRunning ? "running" : "not running"}`,
    `Candidate transport: ${bridge.candidateTransportDetected ? "detected" : "not detected"}`,
    `Privileged transport: ${bridge.candidatePrivilegedTransportDetected ? "detected" : "not detected"}`,
    "",
    "Blockers:",
    ...bridge.blockers.map((blocker) => `  - ${t(blocker)}`)
  ];

  if (bridge.warnings.length > 0) {
    lines.push("", "Warnings:", ...bridge.warnings.map((warning) => `  - ${t(warning)}`));
  }

  if (mode === "doctor") {
    lines.push(
      "",
      "Checks:",
      ...bridge.checks.map((check) => `  - [${check.status}] ${t(check.label)}: ${t(check.detail)}`),
      "",
      "Required launch evidence:",
      ...bridge.requiredLaunchFlags.map((flag) => `  - ${t(flag)}`),
      "",
      "Candidate internal APIs:",
      ...bridge.candidateInternalApis.map((api) => `  - ${t(api)}`),
      "",
      "Processes:"
    );

    if (bridge.processes.length === 0) {
      lines.push("  - none");
    } else {
      for (const process of bridge.processes) {
        const flags = Object.entries(process.flags)
          .filter(([, enabled]) => enabled)
          .map(([name]) => name)
          .join(", ") || "no bridge flags";
        lines.push(
          `  - pid ${process.pid} ${process.role}`,
          `    profile: ${t(process.profilePath ?? "(none)")}`,
          `    profile matched: ${process.profileMatched ? "yes" : "no"}`,
          `    flags: ${t(flags)}`
        );
      }
    }
  }

  if (bridge.suggestedNextCommands.length > 0) {
    lines.push("", "Next:", ...bridge.suggestedNextCommands.map((command) => `  ${t(command)}`));
  }

  return lines.join("\n");
}

export function formatBridgeProbe(receipt: BridgeProbeReceipt, suggestedNextCommands: string[]): string {
  const lines = [
    "Zen live bridge probe",
    `Status: ${receipt.ok ? "verified disposable bridge proof" : "failed"}`,
    `App: ${t(receipt.appPath)}`,
    `Disposable profile: ${t(receipt.profilePath)}`,
    `Port: ${receipt.port}`,
    `WebSocket: ${t(receipt.websocketUrl ?? "(not discovered)")}`,
    `Process pid: ${receipt.processPid ?? "(not started)"}`,
    `Cleaned up: ${receipt.cleanedUp ? "yes" : "no"}`,
    `Duration: ${receipt.durationMs}ms`,
    "",
    "Boundary:",
    "  This proves only disposable WebDriver BiDi transport, script execution, and Zen chrome object reachability.",
    "  It mutates only the disposable temp profile; it does not attach to the live profile, mutate live tabs, or enable live tab sorting."
  ];

  if (receipt.blockers.length > 0) {
    lines.push("", "Blockers:", ...receipt.blockers.map((blocker) => `  - ${t(blocker)}`));
  }

  if (receipt.warnings.length > 0) {
    lines.push("", "Warnings:", ...receipt.warnings.map((warning) => `  - ${t(warning)}`));
  }

  if (receipt.sessionStatus !== null) {
    lines.push("", "Session status:", `  ${t(JSON.stringify(receipt.sessionStatus))}`);
  }

  if (receipt.scriptProof !== null) {
    lines.push(
      "",
      "Script proof:",
      `  session: ${t(receipt.scriptProof.sessionId)}`,
      `  content contexts: ${receipt.scriptProof.contentContextCount}`,
      `  chrome contexts: ${receipt.scriptProof.chromeContextCount}`,
      `  chrome URL: ${t(receipt.scriptProof.chromeUrl ?? "(unknown)")}`,
      `  gZenWorkspaces: ${receipt.scriptProof.zenWorkspacesDetected ? "detected" : "not detected"}`
    );
    if (receipt.scriptProof.workspaceOperation) {
      lines.push(
        `  temp-profile workspace operation: moved disposable tab`,
        `  move: ${t(receipt.scriptProof.workspaceOperation.beforeWorkspaceId)} -> ${t(receipt.scriptProof.workspaceOperation.afterWorkspaceId)}`,
        `  source contains moved tab: ${receipt.scriptProof.workspaceOperation.sourceContainsTab ? "yes" : "no"}`
      );
    }
  }

  if (!receipt.ok && receipt.logTail.length > 0) {
    lines.push("", "Log tail:", ...receipt.logTail.map((line) => `  ${t(line)}`));
  }

  if (suggestedNextCommands.length > 0) {
    lines.push("", "Next:", ...suggestedNextCommands.map((command) => `  ${t(command)}`));
  }

  return lines.join("\n");
}

export function formatBridgeLiveAttachment(liveCheck: BridgeLiveAttachmentInspection): string {
  const lines = [
    "Zen live attachment check",
    `Status: ${liveCheck.attachable ? "attachable" : "refused"}`,
    `Profile path: ${t(liveCheck.profilePath)}`,
    `Zen: ${liveCheck.zenRunning ? "running" : "not running"}`,
    `Server file: ${t(liveCheck.serverFileExists ? liveCheck.serverFilePath : `${liveCheck.serverFilePath} (missing)`)}`,
    `Endpoint: ${t(liveCheck.endpoint?.websocketUrl ?? "(not available)")}`,
    `Candidate transport: ${liveCheck.candidateTransportDetected ? "detected" : "not detected"}`,
    `Privileged transport: ${liveCheck.candidatePrivilegedTransportDetected ? "detected" : "not detected"}`,
    `Endpoint checked: ${liveCheck.checkedEndpoint ? "yes" : "no"}`,
    "",
    "Boundary:",
    "  This is read-only. It does not move tabs, write Zen state, or enable live sort apply.",
    "",
    "Checks:",
    ...liveCheck.checks.map((check) => `  - [${check.status}] ${t(check.label)}: ${t(check.detail)}`)
  ];

  if (liveCheck.blockers.length > 0) {
    lines.push("", "Blockers:", ...liveCheck.blockers.map((blocker) => `  - ${t(blocker)}`));
  }

  if (liveCheck.warnings.length > 0) {
    lines.push("", "Warnings:", ...liveCheck.warnings.map((warning) => `  - ${t(warning)}`));
  }

  if (liveCheck.sessionStatus !== null) {
    lines.push("", "Session status:", `  ${t(JSON.stringify(liveCheck.sessionStatus))}`);
  }

  if (liveCheck.suggestedNextCommands.length > 0) {
    lines.push("", "Next:", ...liveCheck.suggestedNextCommands.map((command) => `  ${t(command)}`));
  }

  return lines.join("\n");
}

export function formatBridgeLiveRead(receipt: BridgeLiveReadReceipt, suggestedNextCommands: string[]): string {
  const lines = [
    "Zen live read proof",
    `Status: ${receipt.ok ? "verified read-only live chrome proof" : "refused"}`,
    `Profile path: ${t(receipt.profilePath)}`,
    `WebSocket: ${t(receipt.websocketUrl ?? "(not available)")}`,
    `Duration: ${receipt.durationMs}ms`,
    "",
    "Boundary:",
    "  This proves only read-only WebDriver BiDi browser-chrome access for the live profile.",
    "  It does not move tabs, write Zen state, or enable live sort apply."
  ];

  if (receipt.blockers.length > 0) {
    lines.push("", "Blockers:", ...receipt.blockers.map((blocker) => `  - ${t(blocker)}`));
  }

  if (receipt.warnings.length > 0) {
    lines.push("", "Warnings:", ...receipt.warnings.map((warning) => `  - ${t(warning)}`));
  }

  if (receipt.sessionStatus !== null) {
    lines.push("", "Session status:", `  ${t(JSON.stringify(receipt.sessionStatus))}`);
  }

  if (receipt.readProof !== null) {
    lines.push(
      "",
      "Read proof:",
      `  session: ${t(receipt.readProof.sessionId)}`,
      `  chrome contexts: ${receipt.readProof.chromeContextCount}`,
      `  chrome URL: ${t(receipt.readProof.chromeUrl ?? "(unknown)")}`,
      `  gZenWorkspaces: ${receipt.readProof.zenWorkspacesDetected ? "detected" : "not detected"}`,
      `  workspace count: ${receipt.readProof.workspaceCount}`,
      `  active workspace: ${t(receipt.readProof.activeWorkspaceId ?? "(unknown)")}`
    );
  }

  if (suggestedNextCommands.length > 0) {
    lines.push("", "Next:", ...suggestedNextCommands.map((command) => `  ${t(command)}`));
  }

  return lines.join("\n");
}

export function formatWorkspaces(
  views: readonly WorkspaceView[],
  observation: SnapshotObservationPresentation
): string {
  const lines = ["Zen workspaces", ...formatObservation(observation), ""];
  for (const view of views) {
    const workspace = view.workspace;
    lines.push(
      `${t(workspace.name)}`,
      `  id: ${t(workspace.id)}`,
      `  root entities: ${view.rootEntityCount}`,
      `  tabs: ${view.tabCount}`,
      `  pinned: ${view.pinnedCount}`,
      `  essentials: ${view.essentialCount}`,
      `  folders/groups/splits: ${view.folderCount}/${view.groupCount}/${view.splitViewCount}`,
      `  default inbox: ${view.defaultInbox ? "yes" : "no"}`,
      `  sortable from: ${view.sortableFrom
        ? "yes"
        : workspace.protection.source.protected
          ? `no (${t(workspace.protection.source.reasons.join(", "))})`
          : "no (outside configured source policy)"}`,
      `  sortable to: ${view.sortableTo
        ? "yes"
        : workspace.protection.destination.protected
          ? `no (${t(workspace.protection.destination.reasons.join(", "))})`
          : "no (outside configured destination policy)"}`,
      ""
    );
  }
  return lines.join("\n").trimEnd();
}

export function formatTabs(
  tabs: readonly TabView[],
  observation: SnapshotObservationPresentation
): string {
  const lines = ["Zen tabs", ...formatObservation(observation), ""];
  if (tabs.length === 0) return [...lines, "No tabs found"].join("\n");
  for (const tab of tabs) {
    lines.push(
      `${t(tab.member.title)}`,
      `  native id: ${t(tab.member.nativeId ?? "(none)")}`,
      `  entity: ${t(tab.entityRef)} (${tab.entityKind})`,
      `  movement root: ${t(tab.structuralRootRef)}`,
      `  workspace: ${t(tab.workspace.name)} (${t(tab.workspace.id)})`,
      `  url: ${t(tab.member.url)}`,
      `  pinned: ${tab.member.pinned ? "yes" : "no"}`,
      `  essential: ${tab.member.essential ? "yes" : "no"}`,
      `  hidden: ${tab.member.hidden ? "yes" : "no"}`,
      `  active: ${tab.member.active ? "yes" : "no"}`,
      `  protected: ${tab.protection.protected ? t(tab.protection.reasons.join(", ")) : "no"}`,
      ""
    );
  }
  return lines.join("\n").trimEnd();
}

function formatObservation(observation: SnapshotObservationPresentation): string[] {
  const authority = observation.authority === "persisted_observation"
    ? "persisted observation"
    : observation.authority;
  const freshness = observation.freshness.replaceAll("_", " ");
  return [
    `Snapshot: ${authority} · ${freshness}`,
    ...(observation.authority === "persisted_observation" || observation.freshness !== "current"
      ? [`Warning: persisted observation may be stale${observation.zenRunning ? " while Zen is running" : ""}; mutation requires a fresh authoritative Snapshot.`]
      : [])
  ];
}

export function formatBackup(manifest: BackupManifest): string {
  return [
    "Backup created",
    `id: ${t(manifest.id)}`,
    `profile: ${t(manifest.profilePath)}`,
    `zen running: ${manifest.zenRunning ? "yes" : "no"}`,
    `files: ${manifest.files.length}`,
    ...manifest.files.map((file) => `  - ${t(file.backup)} (${file.size} bytes)`)
  ].join("\n");
}

export function formatBackupList(manifests: BackupManifest[]): string {
  if (manifests.length === 0) return "No backups found";
  return ["Backups", ...manifests.map((manifest) => `${t(manifest.id)}  ${manifest.files.length} files  ${t(manifest.profileId)}`)].join("\n");
}

export function formatBackupPrune(receipt: BackupPruneReceipt): string {
  const lines = [
    receipt.dryRun ? "Backup prune dry run" : "Backups pruned",
    `before: ${t(receipt.before)}`,
    `matched backups: ${receipt.prunedCount}`,
    `retained backups: ${receipt.retainedCount}`,
    `files: ${receipt.candidates.reduce((count, candidate) => count + candidate.files.length, 0)}`,
    `receipt: ${t(receipt.receiptPath ?? "not written for dry run")}`
  ];
  for (const candidate of receipt.candidates) {
    lines.push(`  - ${t(candidate.backupId)} (${candidate.files.length} files)`);
  }
  return lines.join("\n");
}
