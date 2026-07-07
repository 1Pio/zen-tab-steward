import { BackupManifest, RestoreReceipt } from "./backup.js";
import { ProfileContext } from "./profile.js";
import { SessionSummary, TabSummary } from "./session.js";
import { VERSION } from "./version.js";
import { configPath } from "./paths.js";
import { backupRootForProfile } from "./backup.js";
import { EntityPlan, SortPlan } from "./sort.js";
import { ApplyReceipt, ApplyVerificationReport } from "./apply.js";

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

export function formatStatus(context: ProfileContext, summary: SessionSummary): string {
  const blockers = context.running
    ? ["Offline apply: blocked because Zen is running", "Live bridge: unavailable"]
    : ["Live bridge: unavailable"];

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
    `Safe sort apply: ${context.running ? "unavailable while Zen is running" : "available through offline session backend"}`,
    "Safety posture: active session writes are refused; offline session writes require Zen closed and a fresh backup",
    "",
    "Blockers:",
    ...blockers.map((blocker) => `  - ${blocker}`),
    "",
    "Next:",
    "  zts workspaces",
    "  zts backup",
    "  zts sort --preview"
  ].join("\n");
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

export function formatApplyReceiptList(receipts: ApplyReceipt[]): string {
  if (receipts.length === 0) return "No apply receipts found";
  return [
    "Apply receipts",
    ...receipts.map((receipt) => `${receipt.id}  ${receipt.backend}  ${receipt.moveCount} moves  ${receipt.profileId}`)
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
    lines.push(
      "Applied:",
      `  backend: ${applyReceipt.backend}`,
      `  moves: ${applyReceipt.moveCount}`,
      `  backup: ${applyReceipt.backupId ?? "not needed"}`,
      `  receipt: ${applyReceipt.receiptPath}`
    );
  } else if (applyBlockers.length > 0) {
    lines.push(
      "Apply refused:",
      ...applyBlockers.map((blocker) => `  - ${blocker}`)
    );
  } else {
    lines.push("Apply available: session backend");
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
    lines.push("Apply available: session backend");
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
