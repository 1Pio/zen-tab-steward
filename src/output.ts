import { BackupManifest, BackupPruneReceipt, RestoreReceipt } from "./backup.js";
import { ProfileContext } from "./profile.js";
import { SessionSummary, TabSummary } from "./session.js";
import { VERSION } from "./version.js";
import { configPath } from "./paths.js";
import { backupRootForProfile } from "./backup.js";
import { EntityPlan, SortPlan } from "./sort.js";
import { ApplyReceipt, ApplyVerificationReport } from "./apply.js";
import { BridgeInspection, BridgeLiveAttachmentInspection, BridgeLiveMoveReceipt, BridgeLiveReadReceipt, BridgeProbeReceipt } from "./bridge.js";

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
    `Profile: ${context.profile.name} (${context.profile.id})`,
    `Profile path: ${context.profile.path}`,
    `Zen: ${context.running ? "running" : "not running"}`,
    `Session read: available (${summary.source.kind})`,
    `Session file: ${summary.source.path}`,
    `Workspaces: ${summary.workspaceCount}`,
    `Tabs: ${summary.tabCount}`,
    `Pinned: ${summary.pinnedCount}`,
    `Essentials: ${summary.essentialCount}`,
    `Folders/groups: ${summary.folderGroupCount} (${summary.folderCount} folders, ${summary.groupCount} groups)`,
    `Config: ${configPath()}`,
    `Backups: ${backupRootForProfile(context.profile.id)}`,
    `Safe sort apply: ${context.running ? "live backend is gated by bridge checks; offline session backend is unavailable while Zen is running" : "available through offline session backend"}`,
    `Live bridge: ${bridge.liveBackend.status} (${bridge.liveBackend.reason})`,
    "Safety posture: active session-file writes are refused; live moves require the bridge gate; offline writes require Zen closed and a fresh backup",
    "",
    "Blockers:",
    ...blockers.map((blocker) => `  - ${blocker}`),
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
    `Reason: ${bridge.liveBackend.reason}`,
    `Profile path: ${bridge.profilePath}`,
    `Zen: ${bridge.zenRunning ? "running" : "not running"}`,
    `Candidate transport: ${bridge.candidateTransportDetected ? "detected" : "not detected"}`,
    `Privileged transport: ${bridge.candidatePrivilegedTransportDetected ? "detected" : "not detected"}`,
    "",
    "Blockers:",
    ...bridge.blockers.map((blocker) => `  - ${blocker}`)
  ];

  if (bridge.warnings.length > 0) {
    lines.push("", "Warnings:", ...bridge.warnings.map((warning) => `  - ${warning}`));
  }

  if (mode === "doctor") {
    lines.push(
      "",
      "Checks:",
      ...bridge.checks.map((check) => `  - [${check.status}] ${check.label}: ${check.detail}`),
      "",
      "Required launch evidence:",
      ...bridge.requiredLaunchFlags.map((flag) => `  - ${flag}`),
      "",
      "Candidate internal APIs:",
      ...bridge.candidateInternalApis.map((api) => `  - ${api}`),
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
          `    profile: ${process.profilePath ?? "(none)"}`,
          `    profile matched: ${process.profileMatched ? "yes" : "no"}`,
          `    flags: ${flags}`
        );
      }
    }
  }

  if (bridge.suggestedNextCommands.length > 0) {
    lines.push("", "Next:", ...bridge.suggestedNextCommands.map((command) => `  ${command}`));
  }

  return lines.join("\n");
}

export function formatBridgeProbe(receipt: BridgeProbeReceipt, suggestedNextCommands: string[]): string {
  const lines = [
    "Zen live bridge probe",
    `Status: ${receipt.ok ? "verified disposable bridge proof" : "failed"}`,
    `App: ${receipt.appPath}`,
    `Disposable profile: ${receipt.profilePath}`,
    `Port: ${receipt.port}`,
    `WebSocket: ${receipt.websocketUrl ?? "(not discovered)"}`,
    `Process pid: ${receipt.processPid ?? "(not started)"}`,
    `Cleaned up: ${receipt.cleanedUp ? "yes" : "no"}`,
    `Duration: ${receipt.durationMs}ms`,
    "",
    "Boundary:",
    "  This proves only disposable WebDriver BiDi transport, script execution, and Zen chrome object reachability.",
    "  It mutates only the disposable temp profile; it does not attach to the live profile, mutate live tabs, or enable live tab sorting."
  ];

  if (receipt.blockers.length > 0) {
    lines.push("", "Blockers:", ...receipt.blockers.map((blocker) => `  - ${blocker}`));
  }

  if (receipt.warnings.length > 0) {
    lines.push("", "Warnings:", ...receipt.warnings.map((warning) => `  - ${warning}`));
  }

  if (receipt.sessionStatus !== null) {
    lines.push("", "Session status:", `  ${JSON.stringify(receipt.sessionStatus)}`);
  }

  if (receipt.scriptProof !== null) {
    lines.push(
      "",
      "Script proof:",
      `  session: ${receipt.scriptProof.sessionId}`,
      `  content contexts: ${receipt.scriptProof.contentContextCount}`,
      `  chrome contexts: ${receipt.scriptProof.chromeContextCount}`,
      `  chrome URL: ${receipt.scriptProof.chromeUrl ?? "(unknown)"}`,
      `  gZenWorkspaces: ${receipt.scriptProof.zenWorkspacesDetected ? "detected" : "not detected"}`
    );
    if (receipt.scriptProof.workspaceOperation) {
      lines.push(
        `  temp-profile workspace operation: moved disposable tab`,
        `  move: ${receipt.scriptProof.workspaceOperation.beforeWorkspaceId} -> ${receipt.scriptProof.workspaceOperation.afterWorkspaceId}`,
        `  source contains moved tab: ${receipt.scriptProof.workspaceOperation.sourceContainsTab ? "yes" : "no"}`
      );
    }
  }

  if (!receipt.ok && receipt.logTail.length > 0) {
    lines.push("", "Log tail:", ...receipt.logTail.map((line) => `  ${line}`));
  }

  if (suggestedNextCommands.length > 0) {
    lines.push("", "Next:", ...suggestedNextCommands.map((command) => `  ${command}`));
  }

  return lines.join("\n");
}

export function formatBridgeLiveAttachment(liveCheck: BridgeLiveAttachmentInspection): string {
  const lines = [
    "Zen live attachment check",
    `Status: ${liveCheck.attachable ? "attachable" : "refused"}`,
    `Profile path: ${liveCheck.profilePath}`,
    `Zen: ${liveCheck.zenRunning ? "running" : "not running"}`,
    `Server file: ${liveCheck.serverFileExists ? liveCheck.serverFilePath : `${liveCheck.serverFilePath} (missing)`}`,
    `Endpoint: ${liveCheck.endpoint?.websocketUrl ?? "(not available)"}`,
    `Candidate transport: ${liveCheck.candidateTransportDetected ? "detected" : "not detected"}`,
    `Privileged transport: ${liveCheck.candidatePrivilegedTransportDetected ? "detected" : "not detected"}`,
    `Endpoint checked: ${liveCheck.checkedEndpoint ? "yes" : "no"}`,
    "",
    "Boundary:",
    "  This is read-only. It does not move tabs, write Zen state, or enable live sort apply.",
    "",
    "Checks:",
    ...liveCheck.checks.map((check) => `  - [${check.status}] ${check.label}: ${check.detail}`)
  ];

  if (liveCheck.blockers.length > 0) {
    lines.push("", "Blockers:", ...liveCheck.blockers.map((blocker) => `  - ${blocker}`));
  }

  if (liveCheck.warnings.length > 0) {
    lines.push("", "Warnings:", ...liveCheck.warnings.map((warning) => `  - ${warning}`));
  }

  if (liveCheck.sessionStatus !== null) {
    lines.push("", "Session status:", `  ${JSON.stringify(liveCheck.sessionStatus)}`);
  }

  if (liveCheck.suggestedNextCommands.length > 0) {
    lines.push("", "Next:", ...liveCheck.suggestedNextCommands.map((command) => `  ${command}`));
  }

  return lines.join("\n");
}

export function formatBridgeLiveRead(receipt: BridgeLiveReadReceipt, suggestedNextCommands: string[]): string {
  const lines = [
    "Zen live read proof",
    `Status: ${receipt.ok ? "verified read-only live chrome proof" : "refused"}`,
    `Profile path: ${receipt.profilePath}`,
    `WebSocket: ${receipt.websocketUrl ?? "(not available)"}`,
    `Duration: ${receipt.durationMs}ms`,
    "",
    "Boundary:",
    "  This proves only read-only WebDriver BiDi browser-chrome access for the live profile.",
    "  It does not move tabs, write Zen state, or enable live sort apply."
  ];

  if (receipt.blockers.length > 0) {
    lines.push("", "Blockers:", ...receipt.blockers.map((blocker) => `  - ${blocker}`));
  }

  if (receipt.warnings.length > 0) {
    lines.push("", "Warnings:", ...receipt.warnings.map((warning) => `  - ${warning}`));
  }

  if (receipt.sessionStatus !== null) {
    lines.push("", "Session status:", `  ${JSON.stringify(receipt.sessionStatus)}`);
  }

  if (receipt.readProof !== null) {
    lines.push(
      "",
      "Read proof:",
      `  session: ${receipt.readProof.sessionId}`,
      `  chrome contexts: ${receipt.readProof.chromeContextCount}`,
      `  chrome URL: ${receipt.readProof.chromeUrl ?? "(unknown)"}`,
      `  gZenWorkspaces: ${receipt.readProof.zenWorkspacesDetected ? "detected" : "not detected"}`,
      `  workspace count: ${receipt.readProof.workspaceCount}`,
      `  active workspace: ${receipt.readProof.activeWorkspaceId ?? "(unknown)"}`
    );
  }

  if (suggestedNextCommands.length > 0) {
    lines.push("", "Next:", ...suggestedNextCommands.map((command) => `  ${command}`));
  }

  return lines.join("\n");
}

export function formatBridgeLiveMove(receipt: BridgeLiveMoveReceipt, suggestedNextCommands: string[]): string {
  const lines = [
    "Zen live move proof",
    `Status: ${receipt.ok ? "verified one-tab live move" : "refused"}`,
    `Profile path: ${receipt.profilePath}`,
    `WebSocket: ${receipt.websocketUrl ?? "(not available)"}`,
    `Duration: ${receipt.durationMs}ms`,
    "",
    "Boundary:",
    "  This can move one live tab only with explicit confirmation, exact URL, source workspace, and destination workspace.",
    "  It refuses pinned, essential, grouped, foldered, ambiguous, and unmatched tabs."
  ];

  if (receipt.blockers.length > 0) {
    lines.push("", "Blockers:", ...receipt.blockers.map((blocker) => `  - ${blocker}`));
  }

  if (receipt.warnings.length > 0) {
    lines.push("", "Warnings:", ...receipt.warnings.map((warning) => `  - ${warning}`));
  }

  if (receipt.moveProof !== null) {
    lines.push(
      "",
      "Move proof:",
      `  session: ${receipt.moveProof.sessionId}`,
      `  url: ${receipt.moveProof.requestedUrl}`,
      `  move: ${receipt.moveProof.beforeWorkspaceId} -> ${receipt.moveProof.afterWorkspaceId}`,
      `  requested: ${receipt.moveProof.requestedFromWorkspaceId} -> ${receipt.moveProof.requestedToWorkspaceId}`,
      `  candidates: ${receipt.moveProof.candidateCount}`,
      `  moved: ${receipt.moveProof.moved ? "yes" : "no"}`,
      `  protected: ${receipt.moveProof.protectedReasons.length > 0 ? receipt.moveProof.protectedReasons.join(", ") : "no"}`
    );
  }

  if (suggestedNextCommands.length > 0) {
    lines.push("", "Next:", ...suggestedNextCommands.map((command) => `  ${command}`));
  }

  return lines.join("\n");
}

export function formatWorkspaces(summary: SessionSummary): string {
  const lines = ["Zen workspaces", ""];
  for (const workspace of summary.workspaces) {
    lines.push(
      `${workspace.name}`,
      `  id: ${workspace.id}`,
      `  tabs: ${workspace.tabCount}`,
      `  pinned: ${workspace.pinnedCount}`,
      `  essentials: ${workspace.essentialCount}`,
      `  folders/groups: ${workspace.folderGroupCount} (${workspace.folderCount} folders, ${workspace.groupCount} groups)`,
      `  protected: ${workspace.protectedStatus}`,
      `  default inbox: ${workspace.defaultInbox ? "yes" : "no"}`,
      `  sortable from: ${workspace.sortableFrom ? "yes" : "no"}`,
      `  sortable to: ${workspace.sortableTo ? "yes" : "no"}`,
      ""
    );
  }
  return lines.join("\n").trimEnd();
}

export function formatTabs(tabs: TabSummary[]): string {
  if (tabs.length === 0) return "No tabs found";
  const lines = ["Zen tabs", ""];
  for (const tab of tabs) {
    lines.push(
      `${tab.title}`,
      `  id: ${tab.id}`,
      `  workspace: ${tab.workspaceName ?? "(unknown)"} (${tab.workspaceId ?? "unknown"})`,
      `  url: ${tab.url}`,
      `  domain: ${tab.domain || "(none)"}`,
      `  pinned: ${tab.pinned ? "yes" : "no"}`,
      `  essential: ${tab.essential ? "yes" : "no"}`,
      `  grouped/foldered: ${tab.grouped || tab.foldered ? "yes" : "no"}`,
      `  protected: ${tab.protected ? tab.protectionReasons.join(", ") : "no"}`,
      ""
    );
  }
  return lines.join("\n").trimEnd();
}

export function formatBackup(manifest: BackupManifest): string {
  return [
    "Backup created",
    `id: ${manifest.id}`,
    `profile: ${manifest.profilePath}`,
    `zen running: ${manifest.zenRunning ? "yes" : "no"}`,
    `files: ${manifest.files.length}`,
    ...manifest.files.map((file) => `  - ${file.backup} (${file.size} bytes)`)
  ].join("\n");
}

export function formatBackupList(manifests: BackupManifest[]): string {
  if (manifests.length === 0) return "No backups found";
  return ["Backups", ...manifests.map((manifest) => `${manifest.id}  ${manifest.files.length} files  ${manifest.profileId}`)].join("\n");
}

export function formatRestore(receipt: RestoreReceipt): string {
  return [
    "Backup restored",
    `id: ${receipt.id}`,
    `restored backup: ${receipt.restoredBackupId}`,
    `safety backup: ${receipt.safetyBackupId}`,
    `profile: ${receipt.profilePath}`,
    `files: ${receipt.files.length}`,
    `receipt: ${receipt.receiptPath}`,
    ...receipt.files.map((file) => `  - ${file.source} (${file.size} bytes, verified)`)
  ].join("\n");
}

export function formatBackupPrune(receipt: BackupPruneReceipt): string {
  const lines = [
    receipt.dryRun ? "Backup prune dry run" : "Backups pruned",
    `before: ${receipt.before}`,
    `matched backups: ${receipt.prunedCount}`,
    `retained backups: ${receipt.retainedCount}`,
    `files: ${receipt.candidates.reduce((count, candidate) => count + candidate.files.length, 0)}`,
    `receipt: ${receipt.receiptPath ?? "not written for dry run"}`
  ];
  for (const candidate of receipt.candidates) {
    lines.push(`  - ${candidate.backupId} (${candidate.files.length} files)`);
  }
  return lines.join("\n");
}

export function formatApplyReceiptList(receipts: ApplyReceipt[]): string {
  if (receipts.length === 0) return "No apply receipts found";
  return [
    "Apply receipts",
    ...receipts.map((receipt) => {
      const planned = receipt.plannedMoveCount ?? receipt.moves.length;
      const succeeded = receipt.succeededMoveCount ?? receipt.moveCount;
      return `${receipt.id}  ${receipt.backend}  ${succeeded}/${planned} moves  ${receipt.profileId}`;
    })
  ].join("\n");
}

export function formatApplyVerification(report: ApplyVerificationReport): string {
  const lines = [
    "Apply verification",
    `receipt: ${report.receiptId}`,
    `profile: ${report.profilePath}`,
    `session file: ${report.sessionFile}`,
    `status: ${report.verification.ok ? "verified" : "mismatch"}`,
    `checked moves: ${report.verification.checkedMoves}`,
    `mismatches: ${report.verification.mismatchCount}`
  ];

  if (report.verification.blockers.length > 0) {
    lines.push("Blockers:", ...report.verification.blockers.map((blocker) => `  - ${blocker}`));
  }

  if (report.verification.mismatches.length > 0) {
    lines.push("Mismatches:");
    for (const mismatch of report.verification.mismatches) {
      lines.push(
        `  - ${mismatch.title}`,
        `    tab index: ${mismatch.tabIndex}`,
        `    expected workspace: ${mismatch.expectedWorkspaceId}`,
        `    actual workspace: ${mismatch.actualWorkspaceId ?? "(missing)"}`,
        `    reason: ${mismatch.reason}`,
        `    url: ${mismatch.url}`
      );
    }
  }

  return lines.join("\n");
}

export function formatSortPreview(plan: SortPlan, applyBlockers: string[], suggestedNextCommands: string[], applyReceipt?: ApplyReceipt): string {
  const lines = [
    `Sort preview: ${plan.sourceWorkspace.name}`,
    "",
    `Move ${plan.moveCount} entities`,
    `Skip ${plan.skipCount} protected or filtered`,
    `Review ${plan.reviewCount} needs attention`,
    `Blocked ${plan.blockedCount} unsafe`,
    ""
  ];

  for (const destination of plan.destinationSummaries) {
    lines.push(
      destination.workspaceName,
      `  ${destination.tabCount} tabs`,
      `  ${destination.domains.slice(0, 8).join(", ") || "no domains"}`,
      ""
    );
  }

  if (applyReceipt) {
    const planned = applyReceipt.plannedMoveCount ?? applyReceipt.moves.length;
    const attempted = applyReceipt.attemptedMoveCount ?? applyReceipt.moveCount;
    const succeeded = applyReceipt.succeededMoveCount ?? applyReceipt.moveCount;
    const failed = applyReceipt.failedMoveCount ?? 0;
    lines.push(
      applyReceipt.verification.ok ? "Applied:" : "Apply incomplete:",
      `  backend: ${applyReceipt.backend}`,
      `  moves: ${succeeded}/${planned} succeeded`,
      `  attempted: ${attempted}`,
      `  failed: ${failed}`,
      `  backup: ${applyReceipt.backupId ?? "not needed"}`,
      `  receipt: ${applyReceipt.receiptPath}`
    );
    if (!applyReceipt.verification.ok && applyBlockers.length > 0) {
      lines.push("Blockers:", ...applyBlockers.map((blocker) => `  - ${blocker}`));
    }
  } else if (applyBlockers.length > 0) {
    lines.push(
      "Apply refused:",
      ...applyBlockers.map((blocker) => `  - ${blocker}`)
    );
  } else {
    lines.push("Apply available with selected backend");
  }

  if (suggestedNextCommands.length > 0) {
    lines.push(
      "",
      "Next:",
      ...suggestedNextCommands.map((command) => `  ${command}`)
    );
  }

  return lines.join("\n");
}

export function formatSortDryRun(plan: SortPlan, applyBlockers: string[], suggestedNextCommands: string[]): string {
  const lines = [
    `Sort dry run: ${plan.sourceWorkspace.name}`,
    "",
    `Move ${plan.moveCount} entities`,
    `Skip ${plan.skipCount} protected or filtered`,
    `Review ${plan.reviewCount} needs attention`,
    `Blocked ${plan.blockedCount} unsafe`,
    ""
  ];

  appendActionSection(lines, "Moves", plan.plannedActions);
  appendActionSection(lines, "Skipped", plan.skippedActions);
  appendActionSection(lines, "Review", plan.reviewActions);
  appendActionSection(lines, "Blocked", plan.blockedActions);

  if (applyBlockers.length > 0) {
    lines.push(
      "Apply refused:",
      ...applyBlockers.map((blocker) => `  - ${blocker}`)
    );
  } else {
    lines.push("Apply available with selected backend");
  }

  if (suggestedNextCommands.length > 0) {
    lines.push(
      "",
      "Next:",
      ...suggestedNextCommands.map((command) => `  ${command}`)
    );
  }

  return lines.join("\n");
}

export function formatReview(plan: SortPlan, suggestedNextCommands: string[]): string {
  const lines = [
    `Sort review: ${plan.sourceWorkspace.name}`,
    "",
    `Review ${plan.reviewCount} needs attention`,
    `Move ${plan.moveCount} ready`,
    `Skip ${plan.skipCount} protected or filtered`,
    `Blocked ${plan.blockedCount} unsafe`,
    ""
  ];

  if (plan.reviewActions.length === 0) {
    lines.push("No review items found");
  } else {
    appendActionSection(lines, "Review", plan.reviewActions);
  }

  if (suggestedNextCommands.length > 0) {
    lines.push(
      "",
      "Next:",
      ...suggestedNextCommands.map((command) => `  ${command}`)
    );
  }

  return lines.join("\n").trimEnd();
}

function appendActionSection(lines: string[], heading: string, actions: EntityPlan[]): void {
  if (actions.length === 0) return;
  lines.push(`${heading}:`);
  for (const action of actions) {
    const destination = action.destinationWorkspaceName ? ` -> ${action.destinationWorkspaceName}` : "";
    lines.push(
      `  - [${action.action}] ${action.title}${destination}`,
      `    entity: ${action.entityType}${action.childTabCount > 1 ? ` (${action.childTabCount} tabs)` : ""}`,
      `    url: ${action.url}`,
      ...(action.domains.length > 1 ? [`    domains: ${action.domains.join(", ")}`] : []),
      `    reason: ${action.reason}`,
      `    confidence: ${action.confidence}`,
      `    explanation: ${action.explanation}`
    );
  }
  lines.push("");
}
