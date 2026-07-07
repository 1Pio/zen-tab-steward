#!/usr/bin/env node
import { Command } from "commander";
import { applySortPlanOffline, listApplyReceipts, offlineApplyBlockers, verifyApplyReceipt } from "./apply.js";
import { createBackup, listBackups, restoreBackup } from "./backup.js";
import { addDomainRuleInContents, getConfigValue, loadConfig, saveConfigContents, setConfigValueInContents, ZtsConfig } from "./config.js";
import { envelope, formatApplyReceiptList, formatApplyVerification, formatBackup, formatBackupList, formatRestore, formatReview, formatSortDryRun, formatSortPreview, formatStatus, formatTabs, formatWorkspaces, printJson } from "./output.js";
import { discoverProfileContext } from "./profile.js";
import { listTabs, loadSession, loadSessionSummary, summarizeSession, withWorkspacePolicy } from "./session.js";
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
      const loadedConfig = await loadConfig();
      const summary = withWorkspacePolicy(await loadSessionSummary(context.sessionFile), loadedConfig.config);
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
      const loadedConfig = await loadConfig();
      const summary = withWorkspacePolicy(await loadSessionSummary(context.sessionFile), loadedConfig.config);
      if (options.json) {
        printJson(envelope("workspaces", { profile: context.profile, zenRunning: context.running, workspaces: summary.workspaces }));
      } else {
        process.stdout.write(`${formatWorkspaces(summary)}\n`);
      }
    });
  });

program
  .command("tabs")
  .description("List Zen tabs with workspace and protection metadata")
  .argument("[workspace]", "optional workspace name or id filter")
  .option("--workspace <workspace>", "workspace name or id filter")
  .option("--json", "print stable JSON output")
  .action(async (workspaceArgument: string | undefined, options: JsonOption & { workspace?: string }) => {
    await runCommand("tabs", options, async () => {
      const context = await discoverProfileContext();
      const loadedConfig = await loadConfig();
      const session = await loadSession(context.sessionFile);
      const summary = withWorkspacePolicy(summarizeSession(session, context.sessionFile), loadedConfig.config);
      const workspace = options.workspace ?? workspaceArgument;
      const tabs = listTabs(session, summary, workspace);
      if (options.json) {
        printJson(envelope("tabs", { profile: context.profile, zenRunning: context.running, workspace: workspace ?? null, tabs }));
      } else {
        process.stdout.write(`${formatTabs(tabs)}\n`);
      }
    });
  });

program
  .command("apply")
  .description("List or verify offline sort apply receipts")
  .argument("[action]", "list or verify")
  .argument("[receipt-id]", "apply receipt id for verify")
  .option("--json", "print stable JSON output")
  .action(async (action: string | undefined, receiptId: string | undefined, options: JsonOption) => {
    const selectedAction = action ?? "list";

    if (selectedAction === "list") {
      await runCommand("apply list", options, async () => {
        const context = await discoverProfileContext();
        const receipts = await listApplyReceipts(context.profile.id);
        if (options.json) {
          printJson(envelope("apply list", { profile: context.profile, receipts }));
        } else {
          process.stdout.write(`${formatApplyReceiptList(receipts)}\n`);
        }
      });
      return;
    }

    if (selectedAction === "verify") {
      await runCommand("apply verify", options, async () => {
        const context = await discoverProfileContext();
        if (!receiptId) throw new Error("Apply receipt id is required");
        const report = await verifyApplyReceipt(context, receiptId);
        const ok = report.verification.ok;
        if (options.json) {
          printJson(envelope("apply verify", { profile: context.profile, report }, { ok, blockers: report.verification.blockers }));
        } else {
          process.stdout.write(`${formatApplyVerification(report)}\n`);
        }
        process.exitCode = ok ? 0 : 2;
      });
      return;
    }

    const message = `unknown apply action '${selectedAction}'`;
    if (options.json) {
      printJson(envelope("apply", { action: selectedAction }, { ok: false, blockers: [message], suggestedNextCommands: ["zts apply list", "zts apply verify <receipt-id>"] }));
    } else {
      process.stderr.write(`zts: ${message}\n`);
    }
    process.exitCode = 1;
  });

program
  .command("backup")
  .description("Create, list, or restore backups")
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
        if (context.running) {
          const blockers = ["Restore is refused because Zen is running"];
          const suggestedNextCommands = ["zts backup list", "zts status"];
          if (options.json) {
            printJson(envelope("backup restore", { backupId, profile: context.profile }, { ok: false, blockers, suggestedNextCommands }));
          } else {
            process.stderr.write(`Restore refused for ${backupId ?? "(missing backup id)"}\n${blockers.map((b) => `- ${b}`).join("\n")}\n`);
          }
          process.exitCode = 2;
          return;
        }

        const receipt = await restoreBackup(context, backupId, `zts backup restore ${backupId ?? ""}`.trim());
        if (options.json) {
          printJson(envelope("backup restore", { profile: context.profile, receipt }));
        } else {
          process.stdout.write(`${formatRestore(receipt)}\n`);
        }
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
  .command("review")
  .description("List sort plan items that need human review")
  .argument("[source-workspace]", "source workspace name or id")
  .option("--min-confidence <number>", "minimum confidence required for future apply")
  .option("--include-pinned", "include pinned tabs in review planning")
  .option("--include-essentials", "include essentials in review planning")
  .option("--to <workspaces>", "comma-separated destination workspace allowlist")
  .option("--not-to <workspaces>", "comma-separated destination workspace denylist")
  .option("--only <patterns>", "comma-separated source URL/domain patterns")
  .option("--except <patterns>", "comma-separated exclusion URL/domain patterns")
  .option("--limit <count>", "maximum number of move actions to plan before overflow review")
  .option("--backend <backend>", "backend preference to include in resolved inputs")
  .option("--json", "print stable JSON output")
  .action(async (sourceWorkspace: string | undefined, options: JsonOption & SortOptions) => {
    await runCommand("review", options, async () => {
      const context = await discoverProfileContext();
      const loadedConfig = await loadConfig();
      const session = await loadSession(context.sessionFile);
      const summary = withWorkspacePolicy(summarizeSession(session, context.sessionFile), loadedConfig.config);
      const source = resolveSourceWorkspace(summary, sourceWorkspace, loadedConfig.config.defaults.inbox);
      const inputs = sortInputs(options, loadedConfig.config);
      const inputError = validateSortInputs(inputs);
      if (inputError) {
        if (options.json) {
          printJson(envelope("review", { sourceWorkspace: sourceWorkspace ?? null, inputs }, { ok: false, blockers: [inputError], suggestedNextCommands: ["zts review --help"] }));
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
          printJson(envelope("review", { sourceWorkspace: sourceWorkspace ?? null, inputs }, { ok: false, blockers: [message], suggestedNextCommands }));
        } else {
          process.stderr.write(`zts: ${message}\n`);
        }
        process.exitCode = 1;
        return;
      }

      const plan = planSortPreview(session, summary, source, inputs);
      const data = {
        profile: context.profile,
        zenRunning: context.running,
        sourceWorkspace: source,
        inputs,
        summary: {
          moveCount: plan.moveCount,
          skipCount: plan.skipCount,
          reviewCount: plan.reviewCount,
          blockedCount: plan.blockedCount
        },
        reviewActions: plan.reviewActions
      };
      const suggestedNextCommands = plan.reviewCount > 0
        ? ["zts sort --dry-run", "zts rules test <url-or-domain>", "zts rules add domain <domain> <workspace>"]
        : ["zts sort --preview"];

      if (options.json) {
        printJson(envelope("review", data, { suggestedNextCommands }));
      } else {
        process.stdout.write(`${formatReview(plan, suggestedNextCommands)}\n`);
      }
    });
  });

program
  .command("sort")
  .description("Plan or apply Zen tab sorting")
  .argument("[source-workspace]", "source workspace name or id")
  .option("--preview", "show a glanceable preview without writing")
  .option("--dry-run", "show an operational dry run without writing")
  .option("--apply", "apply planned safe moves with the selected backend")
  .option("--min-confidence <number>", "minimum confidence required for future apply")
  .option("--include-pinned", "include pinned tabs in future sort planning")
  .option("--include-essentials", "include essentials in future sort planning")
  .option("--to <workspaces>", "comma-separated destination workspace allowlist")
  .option("--not-to <workspaces>", "comma-separated destination workspace denylist")
  .option("--only <patterns>", "comma-separated source URL/domain patterns")
  .option("--except <patterns>", "comma-separated exclusion URL/domain patterns")
  .option("--limit <count>", "maximum number of move actions to plan or apply")
  .option("--backend <backend>", "backend preference: auto, live, or session")
  .option("--json", "print stable JSON output")
  .action(async (sourceWorkspace: string | undefined, options: JsonOption & SortOptions) => {
    await runCommand("sort", options, async () => {
      const context = await discoverProfileContext();
      const loadedConfig = await loadConfig();
      const session = await loadSession(context.sessionFile);
      const summary = withWorkspacePolicy(summarizeSession(session, context.sessionFile), loadedConfig.config);
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
      const plan = planSortPreview(session, summary, source, inputs);
      const previewRequested = Boolean(options.preview || options.dryRun);
      const applyBlockers = offlineApplyBlockers(context, inputs.backend);
      const suggestedNextCommands = applyBlockers.length > 0
        ? ["zts sort --preview", "zts status", "zts backup"]
        : ["zts status", "zts backup"];
      const applyRequested = !previewRequested;
      const ok = previewRequested || applyBlockers.length === 0;
      const applyReceipt = applyRequested && applyBlockers.length === 0
        ? await applySortPlanOffline(context, session, plan, sortCommandForReceipt(sourceWorkspace, options))
        : undefined;

      const data = {
        profile: context.profile,
        zenRunning: context.running,
        sourceWorkspace: source,
        inputs,
        plan,
        previewOnly: previewRequested,
        applied: Boolean(applyReceipt),
        applyReceipt: applyReceipt ?? null,
        plannedActions: plan.plannedActions,
        skippedActions: plan.skippedActions,
        reviewActions: plan.reviewActions,
        blockedActions: plan.blockedActions,
        session: {
          workspaceCount: summary.workspaceCount,
          tabCount: summary.tabCount,
          pinnedCount: summary.pinnedCount,
          essentialCount: summary.essentialCount,
          folderGroupCount: summary.folderGroupCount
        }
      };

      if (options.json) {
        printJson(envelope("sort", data, { ok, blockers: applyBlockers, suggestedNextCommands }));
        process.exitCode = ok ? 0 : 2;
      } else {
        process.stdout.write(`${options.dryRun ? formatSortDryRun(plan, applyBlockers, suggestedNextCommands) : formatSortPreview(plan, applyBlockers, suggestedNextCommands, applyReceipt)}\n`);
        process.exitCode = ok ? 0 : 2;
      }
    });
  });

interface SortOptions {
  preview?: boolean;
  dryRun?: boolean;
  apply?: boolean;
  minConfidence?: string;
  includePinned?: boolean;
  includeEssentials?: boolean;
  to?: string;
  notTo?: string;
  only?: string;
  except?: string;
  limit?: string;
  backend?: string;
}

function sortCommandForReceipt(sourceWorkspace: string | undefined, options: SortOptions): string {
  const parts = ["zts", "sort"];
  if (sourceWorkspace) parts.push(sourceWorkspace);
  if (options.apply) parts.push("--apply");
  if (options.backend) parts.push("--backend", options.backend);
  if (options.minConfidence) parts.push("--min-confidence", options.minConfidence);
  if (options.limit) parts.push("--limit", options.limit);
  return parts.join(" ");
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
    : ["Live bridge is unavailable"];
  return {
    warnings: ["Active session writes are refused; offline session writes require Zen closed and a fresh backup"],
    blockers,
    suggestedNextCommands: zenRunning ? ["zts workspaces", "zts backup", "zts sort --preview"] : ["zts workspaces", "zts sort --preview", "zts sort --backend session"]
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

function csvOption(value: string | undefined, fallback: string[]): string[] {
  return value === undefined ? fallback : splitCsv(value);
}

function sortInputs(options: SortOptions, config: ZtsConfig): SortInputs {
  return {
    preview: Boolean(options.preview),
    dryRun: Boolean(options.dryRun),
    minConfidence: options.minConfidence === undefined ? config.defaults.minConfidence : Number(options.minConfidence),
    includePinned: Boolean(options.includePinned) || config.defaults.includePinned,
    includeEssentials: Boolean(options.includeEssentials) || config.defaults.includeEssentials,
    to: csvOption(options.to, config.sort.to),
    notTo: csvOption(options.notTo, config.sort.notTo),
    only: csvOption(options.only, config.sort.only),
    except: csvOption(options.except, config.sort.except),
    limit: options.limit === undefined ? null : Number(options.limit),
    backend: options.backend === undefined ? config.defaults.applyBackend : normalizeBackend(options.backend),
    domainRules: config.rules.domains,
    protectedDomains: config.protect.domains.neverMove
  };
}

function validateSortInputs(inputs: SortInputs): string | null {
  if (!Number.isFinite(inputs.minConfidence) || inputs.minConfidence < 0 || inputs.minConfidence > 1) {
    return "--min-confidence must be a number between 0 and 1";
  }
  if (inputs.backend !== "auto" && inputs.backend !== "live" && inputs.backend !== "session") {
    return "--backend must be one of: auto, live, session";
  }
  if (inputs.limit !== null && (!Number.isInteger(inputs.limit) || inputs.limit < 0)) {
    return "--limit must be a whole number greater than or equal to 0";
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
