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
    `backend: ${report.receipt.backend}`,
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

const CONFIDENCE_SAMPLE_TITLES = 2;
const PREVIEW_DOMAINS_SHOWN = 5;
const PREVIEW_REVIEW_SHOWN = 8;

export interface SortRenderContext {
  plan: SortPlan;
  session: {
    tabCount: number;
    pinnedCount: number;
    essentialCount: number;
    folderGroupCount: number;
  };
  applyBackend: "session" | "live" | null;
  applyReady: boolean;
  applyBlockers: string[];
  suggestedNextCommands: string[];
  applyReceipt?: ApplyReceipt;
}

export function formatSortPreview(ctx: SortRenderContext): string {
  const { plan, session } = ctx;
  const lines: string[] = [];
  const sourceHeader = session.tabCount > 0
    ? `${session.tabCount} tabs · ${session.pinnedCount} pinned · ${session.essentialCount} essential · ${session.folderGroupCount} grouped`
    : "empty workspace";
  lines.push(`Sort preview · ${plan.sourceWorkspace.name}`, sourceHeader, "");

  if (plan.moveCount > 0) {
    const moveGroups = groupPlannedMovesByDestination(plan);
    const totalDestinations = moveGroups.length;
    lines.push(`Will move ${plan.moveCount} ${plural(plan.moveCount, "tab", "tabs")} to ${totalDestinations} ${plural(totalDestinations, "workspace", "workspaces")}`, "");
    for (const group of moveGroups) {
      lines.push(
        `  ${group.workspaceName.padEnd(PREVIEW_NAME_PAD)} ${group.tabCount} ${plural(group.tabCount, "tab", "tabs")}  ${confidenceLabel(group.confidenceMin)}`,
        `  ${formatDomainChips(group.domains)}`,
        ...group.sampleTitles.map((title) => `    · ${truncate(title, 72)}`),
        ...(group.remaining > 0 ? [`    +${group.remaining} more`] : []),
        ""
      );
    }
  } else {
    lines.push("Nothing matches a deterministic destination rule yet.", "Add rules with `zts rules add domain <domain> <workspace>`.", "");
  }

  appendProtectedSummary(lines, plan);
  appendReviewSummary(lines, plan, "preview");
  appendBlockedSummary(lines, plan);
  appendApplyPosture(lines, ctx);
  appendNext(lines, ctx.suggestedNextCommands);
  return lines.join("\n").trimEnd() + "\n";
}

export function formatSortDryRun(ctx: SortRenderContext): string {
  const { plan, session } = ctx;
  const lines: string[] = [];
  lines.push(
    `Sort dry run · ${plan.sourceWorkspace.name}`,
    `${session.tabCount} tabs · ${plan.moveCount} move · ${plan.skipCount} skip · ${plan.reviewCount} review · ${plan.blockedCount} blocked`,
    ""
  );
  appendMoveSection(lines, plan.plannedActions);
  appendActionSection(lines, "Skipped", plan.skippedActions);
  appendActionSection(lines, "Review", plan.reviewActions);
  appendActionSection(lines, "Blocked", plan.blockedActions);
  appendApplyPosture(lines, ctx);
  appendNext(lines, ctx.suggestedNextCommands);
  return lines.join("\n").trimEnd() + "\n";
}

export function formatApplyResult(ctx: SortRenderContext): string {
  const { plan, applyReceipt } = ctx;
  const lines: string[] = [];
  if (!applyReceipt) {
    return formatSortPreview(ctx);
  }
  const planned = applyReceipt.plannedMoveCount ?? applyReceipt.moves.length;
  const succeeded = applyReceipt.succeededMoveCount ?? applyReceipt.moveCount;
  const failed = applyReceipt.failedMoveCount ?? 0;
  const ok = applyReceipt.verification.ok;
  lines.push(
    ok ? `Applied · ${plan.sourceWorkspace.name}` : `Apply incomplete · ${plan.sourceWorkspace.name}`,
    `backend: ${applyReceipt.backend}`,
    `moves: ${succeeded}/${planned} succeeded${failed > 0 ? ` · ${failed} failed` : ""}`,
    `backup: ${applyReceipt.backupId ?? "not needed"}`,
    `receipt: ${applyReceipt.receiptPath}`,
    ""
  );
  if (applyReceipt.moves.length > 0) {
    lines.push("Moved:");
    for (const move of applyReceipt.moves) {
      lines.push(`  · ${truncate(move.title, 64)}`, `    ${move.fromWorkspaceName} -> ${move.toWorkspaceName}  ${truncate(move.url, 70)}`);
    }
    lines.push("");
  }
  if (!ok && ctx.applyBlockers.length > 0) {
    lines.push("Blockers:", ...ctx.applyBlockers.map((blocker) => `  - ${blocker}`), "");
  }
  appendNext(lines, ctx.suggestedNextCommands);
  return lines.join("\n").trimEnd() + "\n";
}

export function formatReview(plan: SortPlan, suggestedNextCommands: string[]): string {
  const lines = [
    `Sort review · ${plan.sourceWorkspace.name}`,
    "",
    `Review ${plan.reviewCount} needs attention · ${plan.moveCount} ready to move · ${plan.skipCount} protected · ${plan.blockedCount} blocked`,
    ""
  ];

  if (plan.reviewActions.length === 0) {
    lines.push("No review items found.", "");
  } else {
    appendReviewDetail(lines, plan.reviewActions);
  }

  appendNext(lines, suggestedNextCommands);
  return lines.join("\n").trimEnd() + "\n";
}

interface PlannedMoveGroup {
  workspaceName: string;
  tabCount: number;
  domains: string[];
  confidenceMin: number;
  sampleTitles: string[];
  remaining: number;
}

const PREVIEW_NAME_PAD = 24;

function groupPlannedMovesByDestination(plan: SortPlan): PlannedMoveGroup[] {
  const byWorkspace = new Map<string, PlannedMoveGroup>();
  for (const action of plan.plannedActions) {
    const key = action.destinationWorkspaceId ?? "(unknown)";
    const existing = byWorkspace.get(key) ?? {
      workspaceName: action.destinationWorkspaceName ?? "(unknown)",
      tabCount: 0,
      domains: [],
      confidenceMin: action.confidence,
      sampleTitles: [],
      remaining: 0
    };
    existing.tabCount += action.childTabCount;
    existing.confidenceMin = Math.min(existing.confidenceMin, action.confidence);
    for (const domain of action.domains) {
      if (domain && !existing.domains.includes(domain)) existing.domains.push(domain);
    }
    if (existing.sampleTitles.length < CONFIDENCE_SAMPLE_TITLES) {
      existing.sampleTitles.push(action.title);
    } else {
      existing.remaining += 1;
    }
    byWorkspace.set(key, existing);
  }
  return Array.from(byWorkspace.values()).map((group) => ({
    ...group,
    domains: group.domains.sort(),
    remaining: group.tabCount - group.sampleTitles.length
  }));
}

function appendMoveSection(lines: string[], actions: EntityPlan[]): void {
  if (actions.length === 0) return;
  lines.push("Moves:");
  const byDestination = new Map<string, EntityPlan[]>();
  for (const action of actions) {
    const key = action.destinationWorkspaceId ?? "(unknown)";
    const list = byDestination.get(key) ?? [];
    list.push(action);
    byDestination.set(key, list);
  }
  for (const [key, list] of byDestination) {
    const destination = list[0]?.destinationWorkspaceName ?? key;
    lines.push(`  -> ${destination}:`);
    for (const action of list) {
      lines.push(
        `     · ${truncate(action.title, 68)}  [${action.entityType}${action.childTabCount > 1 ? ` ${action.childTabCount} tabs` : ""}]`,
        `       url: ${action.url}`,
        `       reason: ${action.reason}`,
        `       confidence: ${action.confidence}`,
        `       explanation: ${action.explanation}`
      );
    }
  }
  lines.push("");
}

function appendActionSection(lines: string[], heading: string, actions: EntityPlan[]): void {
  if (actions.length === 0) return;
  lines.push(`${heading}:`);
  for (const action of actions) {
    const destination = action.destinationWorkspaceName ? ` -> ${action.destinationWorkspaceName}` : "";
    lines.push(
      `  - [${action.action}] ${truncate(action.title, 68)}${destination}`,
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

function appendReviewDetail(lines: string[], actions: EntityPlan[]): void {
  lines.push("Review:");
  for (const action of actions) {
    const entity = action.entityType === "tab" ? "tab" : `${action.entityType} (${action.childTabCount} tabs)`;
    const destination = action.destinationWorkspaceName ? ` -> ${action.destinationWorkspaceName}?` : " -> no rule";
    const confidence = action.confidence > 0 ? ` conf ${action.confidence}` : "";
    lines.push(`  · ${truncate(action.title, 56)}  [${entity}]${destination}${confidence}`);
  }
  lines.push("");
}

function appendProtectedSummary(lines: string[], plan: SortPlan): void {
  if (plan.skipCount === 0) return;
  const byReason = new Map<string, number>();
  for (const action of plan.skippedActions) {
    byReason.set(action.reason, (byReason.get(action.reason) ?? 0) + 1);
  }
  const chips = Array.from(byReason.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([reason, count]) => `${count} ${humanSkipReason(reason)}`);
  lines.push(`Protected · ${plan.skipCount}`, `  ${chips.join(" · ")}`, "");
}

function appendReviewSummary(lines: string[], plan: SortPlan, _mode: "preview"): void {
  if (plan.reviewCount === 0) return;
  lines.push(`Needs review · ${plan.reviewCount}`);
  const shown = plan.reviewActions.slice(0, PREVIEW_REVIEW_SHOWN);
  for (const action of shown) {
    const entity = action.entityType === "tab" ? "tab" : `${action.entityType} ${action.childTabCount} tabs`;
    const destination = action.destinationWorkspaceName ? `-> ${action.destinationWorkspaceName}?` : "-> no rule";
    const confidence = action.confidence > 0 ? ` conf ${action.confidence}` : "";
    lines.push(`  · ${truncate(action.title, 54)}  [${entity}] ${destination}${confidence}`);
  }
  const remaining = plan.reviewCount - shown.length;
  if (remaining > 0) {
    lines.push(`  +${remaining} more  —  zts sort ${plan.sourceWorkspace.name} --dry-run`);
  }
  lines.push("");
}

function appendBlockedSummary(lines: string[], plan: SortPlan): void {
  if (plan.blockedCount === 0) return;
  const byReason = new Map<string, number>();
  for (const action of plan.blockedActions) {
    byReason.set(action.reason, (byReason.get(action.reason) ?? 0) + 1);
  }
  const chips = Array.from(byReason.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([reason, count]) => `${count} ${humanBlockReason(reason)}`);
  lines.push(`Blocked · ${plan.blockedCount}`, `  ${chips.join(" · ")}`, "");
}

function appendApplyPosture(lines: string[], ctx: SortRenderContext): void {
  if (ctx.applyReceipt) {
    return;
  }
  if (ctx.applyReady) {
    const backend = ctx.applyBackend ?? "auto";
    lines.push(`Apply ready · ${backend} backend. A backup is written before any change.`, "");
    return;
  }
  if (ctx.applyBlockers.length > 0) {
    lines.push("Apply not ready:");
    for (const blocker of ctx.applyBlockers) lines.push(`  - ${blocker}`);
    lines.push("");
  }
}

function appendNext(lines: string[], suggestedNextCommands: string[]): void {
  if (suggestedNextCommands.length === 0) return;
  lines.push("Next:");
  for (const command of suggestedNextCommands) lines.push(`  ${command}`);
  lines.push("");
}

function confidenceLabel(confidence: number): string {
  if (confidence >= 0.85) return `conf ${confidence.toFixed(2)} high`;
  if (confidence >= 0.6) return `conf ${confidence.toFixed(2)} med`;
  return `conf ${confidence.toFixed(2)} low`;
}

function formatDomainChips(domains: string[]): string {
  const visible = domains.slice(0, PREVIEW_DOMAINS_SHOWN);
  const more = domains.length - visible.length;
  const text = visible.length > 0 ? visible.join(" · ") : "no domains";
  return more > 0 ? `${text} · +${more}` : text;
}

function humanSkipReason(reason: string): string {
  switch (reason) {
    case "essential_protected": return "essential";
    case "pinned_protected": return "pinned";
    case "grouped_or_foldered_protected": return "grouped";
    case "excluded_by_filter": return "excluded";
    case "outside_only_filter": return "outside --only";
    case "already_in_destination": return "already home";
    default: return reason;
  }
}

function humanBlockReason(reason: string): string {
  switch (reason) {
    case "domain_protected": return "protected domain";
    case "source_workspace_protected": return "source protected";
    case "source_workspace_not_allowed": return "source not allowed";
    case "destination_workspace_protected": return "destination protected";
    case "destination_not_allowed": return "destination not allowed";
    default: return reason;
  }
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max - 1)}…`;
}

function plural(count: number, singular: string, pluralForm: string): string {
  return count === 1 ? singular : pluralForm;
}
