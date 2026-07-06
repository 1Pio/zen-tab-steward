import { BackupManifest } from "./backup.js";
import { ProfileContext } from "./profile.js";
import { SessionSummary } from "./session.js";
import { VERSION } from "./version.js";
import { configPath } from "./paths.js";
import { backupRootForProfile } from "./backup.js";
import { SortPlan } from "./sort.js";

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
    : ["Offline apply: not implemented in this tranche", "Live bridge: unavailable"];

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
    "Safe sort apply: unavailable",
    "Safety posture: read and backup only; active session writes are refused",
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
      "  protection: not configured in this tranche",
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

export function formatSortPreview(plan: SortPlan, applyBlockers: string[], suggestedNextCommands: string[]): string {
  const lines = [
    `Sort preview: ${plan.sourceWorkspace.name}`,
    "",
    `Move ${plan.moveCount} entities`,
    `Skip ${plan.skipCount} protected or filtered`,
    `Review ${plan.reviewCount} low-confidence`,
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

  lines.push(
    "Apply refused:",
    ...applyBlockers.map((blocker) => `  - ${blocker}`),
    "",
    "Next:",
    ...suggestedNextCommands.map((command) => `  ${command}`)
  );

  return lines.join("\n");
}
