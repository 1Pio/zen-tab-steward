#!/usr/bin/env node
import { Command } from "commander";
import { createBackup, listBackups } from "./backup.js";
import { addDomainRuleInContents, getConfigValue, loadConfig, saveConfigContents, setConfigValueInContents, ZtsConfig } from "./config.js";
import { envelope, formatBackup, formatBackupList, formatSortPreview, formatStatus, formatWorkspaces, printJson } from "./output.js";
import { discoverProfileContext } from "./profile.js";
import { loadSession, loadSessionSummary, summarizeSession } from "./session.js";
import { classifyDomainForWorkspace, planSortPreview, SortInputs } from "./sort.js";
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
  .command("config")
  .description("Inspect or update the user-owned zts config")
  .argument("[action]", "path, show, get, or set")
  .argument("[key]", "config key for get/set")
  .argument("[value]", "config value for set")
  .option("--json", "print stable JSON output")
  .action(async (action: string | undefined, key: string | undefined, value: string | undefined, options: JsonOption) => {
    await runCommand("config", options, async () => {
      const loaded = await loadConfig();
      const selectedAction = action ?? "show";

      if (selectedAction === "path") {
        if (options.json) printJson(envelope("config path", { path: loaded.path, exists: loaded.exists }));
        else process.stdout.write(`${loaded.path}\n`);
        return;
      }

      if (selectedAction === "show") {
        if (options.json) printJson(envelope("config show", loaded));
        else process.stdout.write(`${JSON.stringify(loaded.config, null, 2)}\n`);
        return;
      }

      if (selectedAction === "get" && key) {
        const configValue = getConfigValue(loaded.config, key);
        if (options.json) printJson(envelope("config get", { path: loaded.path, key, value: configValue }));
        else process.stdout.write(`${String(configValue)}\n`);
        return;
      }

      if (selectedAction === "set" && key && value !== undefined) {
        const contents = setConfigValueInContents(loaded.contents, key, value);
        const path = await saveConfigContents(contents);
        const updated = (await loadConfig()).config;
        if (options.json) printJson(envelope("config set", { path, key, value: getConfigValue(updated, key) }));
        else process.stdout.write(`Set ${key} in ${path}\n`);
        return;
      }

      throw new Error("Usage: zts config [path|show|get <key>|set <key> <value>]");
    });
  });

program
  .command("rules")
  .description("Inspect or update deterministic routing rules")
  .argument("[action]", "add or test")
  .argument("[type]", "rule type, currently domain")
  .argument("[patternOrUrl]", "domain pattern for add, URL/domain for test")
  .argument("[workspace]", "destination workspace for add")
  .option("--json", "print stable JSON output")
  .action(async (action: string | undefined, type: string | undefined, patternOrUrl: string | undefined, workspace: string | undefined, options: JsonOption) => {
    await runCommand("rules", options, async () => {
      const loaded = await loadConfig();

      if (!action) {
        if (options.json) printJson(envelope("rules", { path: loaded.path, domainRules: loaded.config.rules.domains }));
        else process.stdout.write(formatDomainRules(loaded.config.rules.domains));
        return;
      }

      if (action === "add" && type === "domain" && patternOrUrl && workspace) {
        const contents = addDomainRuleInContents(loaded.contents, patternOrUrl, workspace);
        const path = await saveConfigContents(contents);
        if (options.json) printJson(envelope("rules add domain", { path, pattern: patternOrUrl, workspace }));
        else process.stdout.write(`Added domain rule ${patternOrUrl} -> ${workspace}\n`);
        return;
      }

      if (action === "test" && type) {
        const testInput = patternOrUrl ?? type;
        const domain = domainFromInput(testInput);
        const match = classifyDomainForWorkspace(domain, loaded.config.rules.domains);
        if (options.json) printJson(envelope("rules test", { input: testInput, domain, match }));
        else process.stdout.write(match ? `${domain} -> ${match.workspaceName} (${match.matchedPattern})\n` : `${domain} -> review\n`);
        return;
      }

      throw new Error("Usage: zts rules [add domain <pattern> <workspace>|test <url-or-domain>]");
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
  .option("--backend <backend>", "backend preference: auto, live, or session")
  .option("--json", "print stable JSON output")
  .action(async (sourceWorkspace: string | undefined, options: JsonOption & SortOptions) => {
    await runCommand("sort", options, async () => {
      const context = await discoverProfileContext();
      const loadedConfig = await loadConfig();
      const session = await loadSession(context.sessionFile);
      const summary = summarizeSession(session, context.sessionFile);
      const source = resolveSourceWorkspace(summary, sourceWorkspace, loadedConfig.config.defaults.inbox);
      const inputs = sortInputs(options, loadedConfig.config);
      const inputError = validateSortInputs(inputs);
      if (inputError) {
        if (options.json) {
          printJson(envelope("sort", { sourceWorkspace: sourceWorkspace ?? null, inputs }, { ok: false, blockers: [inputError], suggestedNextCommands: ["zts sort --help"] }));
        } else {
          process.stderr.write(`zts: ${inputError}\n`);
        }
        process.exitCode = 1;
        return;
      }
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
      const plan = planSortPreview(session, summary, source, inputs);
      const previewRequested = Boolean(options.preview || options.dryRun);
      const ok = previewRequested;

      const data = {
        profile: context.profile,
        zenRunning: context.running,
        sourceWorkspace: source,
        inputs,
        plan,
        previewOnly: true,
        plannedActions: plan.plannedActions,
        skippedActions: plan.skippedActions,
        reviewActions: plan.reviewActions,
        session: {
          workspaceCount: summary.workspaceCount,
          tabCount: summary.tabCount,
          pinnedCount: summary.pinnedCount,
          essentialCount: summary.essentialCount,
          folderGroupCount: summary.folderGroupCount
        }
      };

      if (options.json) {
        printJson(envelope("sort", data, { ok, blockers, suggestedNextCommands }));
        process.exitCode = ok ? 0 : 2;
      } else {
        process.stdout.write(`${formatSortPreview(plan, blockers, suggestedNextCommands)}\n`);
        process.exitCode = ok ? 0 : 2;
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

function resolveSourceWorkspace(summary: Awaited<ReturnType<typeof loadSessionSummary>>, input: string | undefined, defaultInbox: string) {
  const lookup = input ?? defaultInbox;
  if (!lookup) return summary.workspaces[0] ?? null;
  const normalized = lookup.toLowerCase();
  return summary.workspaces.find((workspace) => workspace.id === lookup || workspace.name.toLowerCase() === normalized) ?? null;
}

function splitCsv(value?: string): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function sortInputs(options: SortOptions, config: ZtsConfig): SortInputs {
  return {
    preview: Boolean(options.preview),
    dryRun: Boolean(options.dryRun),
    minConfidence: options.minConfidence === undefined ? config.defaults.minConfidence : Number(options.minConfidence),
    includePinned: Boolean(options.includePinned) || config.defaults.includePinned,
    to: splitCsv(options.to),
    notTo: splitCsv(options.notTo),
    only: splitCsv(options.only),
    except: splitCsv(options.except),
    backend: options.backend === undefined ? config.defaults.applyBackend : normalizeBackend(options.backend),
    domainRules: config.rules.domains
  };
}

function validateSortInputs(inputs: SortInputs): string | null {
  if (!Number.isFinite(inputs.minConfidence) || inputs.minConfidence < 0 || inputs.minConfidence > 1) {
    return "--min-confidence must be a number between 0 and 1";
  }
  if (inputs.backend !== "auto" && inputs.backend !== "live" && inputs.backend !== "session") {
    return "--backend must be one of: auto, live, session";
  }
  return null;
}

function normalizeBackend(backend?: string): SortInputs["backend"] {
  if (backend === undefined || backend === "auto" || backend === "live" || backend === "session") {
    return backend ?? "auto";
  }
  return backend as SortInputs["backend"];
}

function formatDomainRules(domainRules: Record<string, string>): string {
  const entries = Object.entries(domainRules).sort(([a], [b]) => a.localeCompare(b));
  if (entries.length === 0) return "No configured domain rules\n";
  return `${entries.map(([pattern, workspace]) => `${pattern} -> ${workspace}`).join("\n")}\n`;
}

function domainFromInput(input: string): string {
  try {
    return new URL(input).hostname.toLowerCase();
  } catch {
    return input.toLowerCase();
  }
}
