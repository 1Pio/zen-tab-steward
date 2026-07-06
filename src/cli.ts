#!/usr/bin/env node
import { Command } from "commander";
import { createBackup, listBackups } from "./backup.js";
import { envelope, formatBackup, formatBackupList, formatStatus, formatWorkspaces, printJson } from "./output.js";
import { discoverProfileContext } from "./profile.js";
import { loadSessionSummary } from "./session.js";
import { VERSION } from "./version.js";

interface JsonOption {
  json?: boolean;
}

const program = new Command();

program
  .name("zts")
  .description("Zen Tab Steward: safe Zen Browser tab and workspace stewardship")
  .version(VERSION)
  .showHelpAfterError()
  .showSuggestionAfterError();

program
  .command("status")
  .description("Report discovered profile, session counts, backend availability, and safety posture")
  .option("--json", "print stable JSON output")
  .action(async (options: JsonOption) => {
    await runCommand("status", options, async () => {
      const context = await discoverProfileContext();
      const summary = await loadSessionSummary(context.sessionFile);
      const data = { profile: context.profile, zenRunning: context.running, session: summary };

      if (options.json) {
        printJson(envelope("status", data, statusEnvelopeOptions(context.running)));
      } else {
        process.stdout.write(`${formatStatus(context, summary)}\n`);
      }
    });
  });

program
  .command("workspaces")
  .description("List Zen workspaces with tab, pinned, essential, folder, and group counts")
  .option("--json", "print stable JSON output")
  .action(async (options: JsonOption) => {
    await runCommand("workspaces", options, async () => {
      const context = await discoverProfileContext();
      const summary = await loadSessionSummary(context.sessionFile);
      if (options.json) {
        printJson(envelope("workspaces", { profile: context.profile, zenRunning: context.running, workspaces: summary.workspaces }));
      } else {
        process.stdout.write(`${formatWorkspaces(summary)}\n`);
      }
    });
  });

program
  .command("backup")
  .description("Create, list, or refuse restore of read-only backups")
  .argument("[action]", "optional action: list or restore")
  .argument("[backup-id]", "backup id for restore")
  .option("--json", "print stable JSON output")
  .action(async (action: string | undefined, backupId: string | undefined, options: JsonOption) => {
    if (action === "list") {
      await runCommand("backup list", options, async () => {
        const context = await discoverProfileContext();
        const backups = await listBackups(context.profile.id);
        if (options.json) {
          printJson(envelope("backup list", { profile: context.profile, backups }));
        } else {
          process.stdout.write(`${formatBackupList(backups)}\n`);
        }
      });
      return;
    }

    if (action === "restore") {
      await runCommand("backup restore", options, async () => {
        const context = await discoverProfileContext();
        const blockers = context.running
          ? ["Restore is refused because Zen is running", "Offline restore is not implemented in this tranche"]
          : ["Offline restore is not implemented in this tranche"];
        const suggestedNextCommands = ["zts backup list", "zts status"];
        if (options.json) {
          printJson(envelope("backup restore", { backupId, profile: context.profile }, { ok: false, blockers, suggestedNextCommands }));
        } else {
          process.stderr.write(`Restore refused for ${backupId ?? "(missing backup id)"}\n${blockers.map((b) => `- ${b}`).join("\n")}\n`);
        }
        process.exitCode = 2;
      });
      return;
    }

    if (action) {
      const message = `unknown backup action '${action}'`;
      if (options.json) {
        printJson(envelope("backup", { action }, { ok: false, blockers: [message], suggestedNextCommands: ["zts backup", "zts backup list"] }));
      } else {
        process.stderr.write(`zts: ${message}\n`);
      }
      process.exitCode = 1;
      return;
    }

    await runCommand("backup", options, async () => {
      const context = await discoverProfileContext();
      const manifest = await createBackup(context, "zts backup");
      if (options.json) {
        printJson(envelope("backup", { manifest }));
      } else {
        process.stdout.write(`${formatBackup(manifest)}\n`);
      }
    });
  });

program
  .command("sort")
  .description("Preview tab sorting. Apply is refused until a safe backend exists.")
  .argument("[source-workspace]", "source workspace name or id")
  .option("--preview", "show a glanceable preview without writing")
  .option("--dry-run", "show an operational dry run without writing")
  .option("--min-confidence <number>", "minimum confidence required for future apply")
  .option("--include-pinned", "include pinned tabs in future sort planning")
  .option("--to <workspaces>", "comma-separated destination workspace allowlist")
  .option("--not-to <workspaces>", "comma-separated destination workspace denylist")
  .option("--only <patterns>", "comma-separated source URL/domain patterns")
  .option("--except <patterns>", "comma-separated exclusion URL/domain patterns")
  .option("--backend <backend>", "backend preference: auto, live, or session", "auto")
  .option("--json", "print stable JSON output")
  .action(async (sourceWorkspace: string | undefined, options: JsonOption & SortOptions) => {
    await runCommand("sort", options, async () => {
      const context = await discoverProfileContext();
      const summary = await loadSessionSummary(context.sessionFile);
      const source = resolveSourceWorkspace(summary, sourceWorkspace);
      const inputs = sortInputs(options);
      if (!source) {
        const message = sourceWorkspace
          ? `Source workspace not found: ${sourceWorkspace}`
          : "No source workspace could be resolved";
        const suggestedNextCommands = ["zts workspaces", "zts sort --preview"];
        if (options.json) {
          printJson(envelope("sort", { sourceWorkspace: sourceWorkspace ?? null, inputs }, { ok: false, blockers: [message], suggestedNextCommands }));
        } else {
          process.stderr.write(`zts: ${message}\n`);
        }
        process.exitCode = 1;
        return;
      }
      const blockers = ["Sort apply is not implemented in this tranche"];
      if (context.running) blockers.unshift("Zen is running and no live backend is available");
      const suggestedNextCommands = ["zts sort --preview", "zts status", "zts backup"];

      const data = {
        profile: context.profile,
        zenRunning: context.running,
        sourceWorkspace: source,
        inputs,
        previewOnly: true,
        plannedActions: [],
        skippedActions: [],
        session: {
          workspaceCount: summary.workspaceCount,
          tabCount: summary.tabCount,
          pinnedCount: summary.pinnedCount,
          essentialCount: summary.essentialCount,
          folderGroupCount: summary.folderGroupCount
        }
      };

      if (options.json) {
        printJson(envelope("sort", data, { ok: false, blockers, suggestedNextCommands }));
        process.exitCode = 2;
      } else {
        process.stdout.write(
          [
            `Sort preview: ${source.name}`,
            "",
            "Move 0 entities",
            `Skip ${summary.pinnedCount + summary.essentialCount + summary.folderGroupCount} protected or structured items before classification`,
            "",
            "Apply refused:",
            ...blockers.map((blocker) => `  - ${blocker}`),
            "",
            "Next:",
            ...suggestedNextCommands.map((command) => `  ${command}`)
          ].join("\n") + "\n"
        );
        process.exitCode = 2;
      }
    });
  });

interface SortOptions {
  preview?: boolean;
  dryRun?: boolean;
  minConfidence?: string;
  includePinned?: boolean;
  to?: string;
  notTo?: string;
  only?: string;
  except?: string;
  backend?: string;
}

program.parseAsync(process.argv);

async function runCommand(command: string, options: JsonOption, action: () => Promise<void>): Promise<void> {
  try {
    await action();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (options.json) {
      printJson(envelope(command, { error: message }, { ok: false, blockers: [message] }));
    } else {
      process.stderr.write(`zts: ${message}\n`);
    }
    process.exitCode = 1;
  }
}

function statusEnvelopeOptions(zenRunning: boolean) {
  const blockers = zenRunning
    ? ["Offline apply is blocked because Zen is running", "Live bridge is unavailable"]
    : ["Offline apply is not implemented in this tranche", "Live bridge is unavailable"];
  return {
    warnings: ["This tranche is read/backup only and refuses active session writes"],
    blockers,
    suggestedNextCommands: ["zts workspaces", "zts backup", "zts sort --preview"]
  };
}

function resolveSourceWorkspace(summary: Awaited<ReturnType<typeof loadSessionSummary>>, input?: string) {
  if (!input) {
    return summary.workspaces.find((workspace) => workspace.name.toLowerCase() === "space") ?? summary.workspaces[0] ?? null;
  }
  const normalized = input.toLowerCase();
  return summary.workspaces.find((workspace) => workspace.id === input || workspace.name.toLowerCase() === normalized) ?? null;
}

function splitCsv(value?: string): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function sortInputs(options: SortOptions) {
  return {
    preview: Boolean(options.preview),
    dryRun: Boolean(options.dryRun),
    minConfidence: options.minConfidence ?? null,
    includePinned: Boolean(options.includePinned),
    to: splitCsv(options.to),
    notTo: splitCsv(options.notTo),
    only: splitCsv(options.only),
    except: splitCsv(options.except),
    backend: options.backend ?? "auto"
  };
}
