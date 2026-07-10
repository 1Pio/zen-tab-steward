#!/usr/bin/env node
import { Command } from "commander";
import { createInterface } from "node:readline/promises";
import { applySortPlanLive, applySortPlanOffline, listApplyReceipts, offlineApplyBlockers, resolveApplyBackend, sortApplyBlockers, verifyApplyReceipt } from "./apply.js";
import { createBackup, listBackups, pruneBackups, restoreBackup } from "./backup.js";
import { inspectBridge, inspectLiveAttachment, runBridgeLiveMoveProof, runBridgeLiveReadProof, runBridgeProbe } from "./bridge.js";
import { addDomainRuleInContents, getConfigValue, loadConfig, saveConfigContents, setConfigValueInContents, ZtsConfig } from "./config.js";
import { planDailySort } from "./daily-sort.js";
import { envelope, formatApplyReceiptList, formatApplyVerification, formatBackup, formatBackupList, formatBackupPrune, formatBridge, formatBridgeLiveAttachment, formatBridgeLiveMove, formatBridgeLiveRead, formatBridgeProbe, formatRestore, formatReview, formatSortDryRun, formatSortPreview, formatStatus, formatTabs, formatWorkspaces, printJson } from "./output.js";
import { applyManualPatchOffline, createManualPlanFromInput, listManualApplyReceipts, readPatchInput } from "./manual.js";
import { applySavedPlanWithProfileLock } from "./plan-apply.js";
import { deriveAndStoreSubsetPlan, loadStoredPlan, PlanReuseError } from "./plans.js";
import { discoverProfileContext } from "./profile.js";
import { listTabs, loadSession, loadSessionSummary, summarizeSession, withWorkspacePolicy } from "./session.js";
import { snapshotFromSession } from "./session-snapshot.js";
import { classifyDomainForWorkspace, planSortPreview, SortInputs } from "./sort.js";
import { VERSION } from "./version.js";

import type { ManualApplyReceiptSummary, ManualApplyResult, ManualPlanResult } from "./manual.js";
import type { SavedPlanApplyResult } from "./plan-apply.js";
import type { DailySortPlanResult } from "./daily-sort.js";
import type { Plan } from "./domain/change.js";
import type { Entity, EntityRef, Snapshot } from "./domain/snapshot.js";

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
      const bridge = inspectBridge(context);
      const data = { profile: context.profile, zenRunning: context.running, session: summary, bridge };

      if (options.json) {
        printJson(envelope("status", data, statusEnvelopeOptions(context.running, bridge.blockers)));
      } else {
        process.stdout.write(`${formatStatus(context, summary, bridge)}\n`);
      }
    });
  });

program
  .command("bridge")
  .description("Inspect the live Zen bridge boundary without changing Zen state")
  .argument("[action]", "status, doctor, live-check, live-read, live-move-proof, or probe")
  .option("--connect", "for live-check, connect to the discovered local WebDriver BiDi endpoint and run session.status")
  .option("--url <url>", "for live-move-proof, exact live tab URL to move")
  .option("--from-workspace <workspace-id>", "for live-move-proof, exact source workspace id")
  .option("--to-workspace <workspace-id>", "for live-move-proof, exact destination workspace id")
  .option("--confirm-live-move", "for live-move-proof, acknowledge that one eligible live tab may be moved")
  .option("--timeout-ms <ms>", "probe timeout in milliseconds")
  .option("--json", "print stable JSON output")
  .action(async (action: string | undefined, options: JsonOption & BridgeOptions) => {
    const selectedAction = action ?? "status";

    if (selectedAction === "status" || selectedAction === "doctor") {
      await runCommand(`bridge ${selectedAction}`, options, async () => {
        const context = await discoverProfileContext();
        const bridge = inspectBridge(context);
        const data = { profile: context.profile, zenRunning: context.running, bridge };
        if (options.json) {
          printJson(envelope(`bridge ${selectedAction}`, data, {
            warnings: bridge.warnings,
            blockers: bridge.blockers,
            suggestedNextCommands: bridge.suggestedNextCommands
          }));
        } else {
          process.stdout.write(`${formatBridge(bridge, selectedAction)}\n`);
        }
      });
      return;
    }

    if (selectedAction === "live-check") {
      await runCommand("bridge live-check", options, async () => {
        const context = await discoverProfileContext();
        const timeoutMs = probeTimeoutMs(options.timeoutMs);
        const liveCheck = await inspectLiveAttachment(context, { connect: Boolean(options.connect), timeoutMs });
        const data = { profile: context.profile, zenRunning: context.running, liveCheck };
        if (options.json) {
          printJson(envelope("bridge live-check", data, {
            ok: liveCheck.attachable,
            warnings: liveCheck.warnings,
            blockers: liveCheck.blockers,
            suggestedNextCommands: liveCheck.suggestedNextCommands
          }));
        } else {
          process.stdout.write(`${formatBridgeLiveAttachment(liveCheck)}\n`);
        }
        process.exitCode = liveCheck.attachable ? 0 : 2;
      });
      return;
    }

    if (selectedAction === "live-read") {
      await runCommand("bridge live-read", options, async () => {
        const context = await discoverProfileContext();
        const timeoutMs = probeTimeoutMs(options.timeoutMs);
        const receipt = await runBridgeLiveReadProof(context, { timeoutMs });
        const suggestedNextCommands = receipt.ok
          ? ["zts bridge live-check --connect --json", "zts sort --preview"]
          : ["zts bridge live-check --connect --json", "zts bridge doctor", "zts bridge probe"];
        if (options.json) {
          printJson(envelope("bridge live-read", { profile: context.profile, zenRunning: context.running, receipt }, {
            ok: receipt.ok,
            warnings: receipt.warnings,
            blockers: receipt.blockers,
            suggestedNextCommands
          }));
        } else {
          process.stdout.write(`${formatBridgeLiveRead(receipt, suggestedNextCommands)}\n`);
        }
        process.exitCode = receipt.ok ? 0 : 2;
      });
      return;
    }

    if (selectedAction === "live-move-proof") {
      await runCommand("bridge live-move-proof", options, async () => {
        const context = await discoverProfileContext();
        const timeoutMs = probeTimeoutMs(options.timeoutMs);
        const receipt = await runBridgeLiveMoveProof(context, {
          timeoutMs,
          url: options.url,
          fromWorkspaceId: options.fromWorkspace,
          toWorkspaceId: options.toWorkspace,
          confirmLiveMove: Boolean(options.confirmLiveMove)
        });
        const suggestedNextCommands = receipt.ok
          ? ["zts bridge live-read --json", "zts sort --preview"]
          : ["zts bridge live-read --json", "zts bridge live-check --connect --json", "zts tabs <workspace> --json"];
        if (options.json) {
          printJson(envelope("bridge live-move-proof", { profile: context.profile, zenRunning: context.running, receipt }, {
            ok: receipt.ok,
            warnings: receipt.warnings,
            blockers: receipt.blockers,
            suggestedNextCommands
          }));
        } else {
          process.stdout.write(`${formatBridgeLiveMove(receipt, suggestedNextCommands)}\n`);
        }
        process.exitCode = receipt.ok ? 0 : 2;
      });
      return;
    }

    if (selectedAction === "probe") {
      await runCommand("bridge probe", options, async () => {
        const timeoutMs = probeTimeoutMs(options.timeoutMs);
        const receipt = await runBridgeProbe({ timeoutMs });
        const suggestedNextCommands = receipt.ok ? ["zts bridge doctor", "zts bridge status"] : ["zts bridge probe --json", "zts bridge doctor"];
        if (options.json) {
          printJson(envelope("bridge probe", { receipt }, {
            ok: receipt.ok,
            warnings: receipt.warnings,
            blockers: receipt.blockers,
            suggestedNextCommands
          }));
        } else {
          process.stdout.write(`${formatBridgeProbe(receipt, suggestedNextCommands)}\n`);
        }
        process.exitCode = receipt.ok ? 0 : 2;
      });
      return;
    }

    const message = `unknown bridge action '${selectedAction}'`;
    if (options.json) {
      printJson(envelope("bridge", { action: selectedAction }, { ok: false, blockers: [message], suggestedNextCommands: ["zts bridge status", "zts bridge doctor", "zts bridge live-check", "zts bridge live-read", "zts bridge live-move-proof", "zts bridge probe"] }));
    } else {
      process.stderr.write(`zts: ${message}\n`);
    }
    process.exitCode = 1;
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
  .command("snapshot")
  .description("Print the normalized domain Snapshot used for exact manual Patch planning")
  .option("--json", "print stable JSON output")
  .action(async (options: JsonOption) => {
    await runCommand("snapshot", options, async () => {
      const context = await discoverProfileContext();
      const loadedConfig = await loadConfig();
      const session = await loadSession(context.sessionFile);
      const summary = withWorkspacePolicy(summarizeSession(session, context.sessionFile), loadedConfig.config);
      const snapshot = snapshotFromSession(context, session, summary);
      const data = {
        profile: context.profile,
        zenRunning: context.running,
        snapshot
      };
      const warnings = context.running
        ? ["Zen is running; this Snapshot is a persisted observation and cannot be used for apply"]
        : [];
      const suggestedNextCommands = ["zts patch plan patch.json --json", "zts tabs --json"];
      if (options.json) {
        printJson(envelope("snapshot", data, { warnings, suggestedNextCommands }));
      } else {
        process.stdout.write(formatSnapshotSummary(snapshot, warnings, suggestedNextCommands));
      }
    });
  });

program
  .command("plan")
  .description("Inspect a saved state-bound Plan")
  .argument("[action]", "show")
  .argument("[selector]", "latest, Plan id, or Plan digest")
  .option("--json", "print stable JSON output")
  .action(async (action: string | undefined, selector: string | undefined, options: JsonOption) => {
    await runCommand("plan", options, async () => {
      const selectedAction = action ?? "show";
      if (selectedAction !== "show") throw new Error("Usage: zts plan show [latest|plan-id|plan-digest]");
      const context = await discoverProfileContext();
      const stored = await loadStoredPlan(context.profile.id, selector ?? "latest");
      const expired = Date.parse(stored.plan.expiresAt) <= Date.now();
      const data = {
        profile: context.profile,
        plan: stored.plan,
        requestRevision: stored.requestRevision,
        artifact: stored.artifact,
        expired
      };
      if (options.json) {
        printJson(envelope("plan show", data, {
          warnings: expired ? ["Saved Plan has expired and cannot be authorized for apply"] : [],
          suggestedNextCommands: expired ? ["zts sort --all --engine rules --preview"] : ["zts sort --all --engine rules --dry-run", "zts plan show latest --json"]
        }));
      } else {
        process.stdout.write(formatSavedPlan(stored.plan, expired));
      }
    });
  });

program
  .command("patch")
  .description("Plan exact manual tab moves from a Patch JSON file")
  .argument("[action]", "plan, apply, or receipts")
  .argument("[patch-file]", "Patch JSON path, or - for stdin")
  .option("--yes", "confirm an unattended apply; required for patch apply")
  .option("--json", "print stable JSON output")
  .action(async (action: string | undefined, patchFile: string | undefined, options: JsonOption & { yes?: boolean }) => {
    const selectedAction = action ?? "plan";
    if (selectedAction !== "plan" && selectedAction !== "apply" && selectedAction !== "receipts") {
      const message = `unknown patch action '${selectedAction}'`;
      if (options.json) {
        printJson(envelope("patch", { action: selectedAction }, { ok: false, blockers: [message], suggestedNextCommands: ["zts patch plan <patch-file> --json", "zts patch apply <patch-file> --yes --json", "zts patch receipts --json"] }));
      } else {
        process.stderr.write(`zts: ${message}\n`);
      }
      process.exitCode = 1;
      return;
    }

    if (selectedAction === "plan") {
      await runCommand("patch plan", options, async () => {
        if (!patchFile) throw new Error("Patch file is required; use - to read JSON from stdin");
        const context = await discoverProfileContext();
        const loadedConfig = await loadConfig();
        const session = await loadSession(context.sessionFile);
        const summary = withWorkspacePolicy(summarizeSession(session, context.sessionFile), loadedConfig.config);
        const snapshot = snapshotFromSession(context, session, summary);
        const patchInput = await readPatchInput(patchFile);
        const result = createManualPlanFromInput(snapshot, patchInput);
        const blockers = result.plan.snapshotAuthority === "authoritative" && result.plan.snapshotFreshness === "current"
          ? []
          : ["Patch Plan was created from a persisted observation and is not executable for apply"];
        const suggestedNextCommands = blockers.length > 0
          ? ["Quit Zen, then rerun zts snapshot --json and zts patch plan <patch-file> --json"]
          : ["zts patch apply <patch-file> --yes", "zts snapshot --json"];
        if (options.json) {
          printJson(envelope("patch plan", { profile: context.profile, zenRunning: context.running, ...result }, {
            ok: blockers.length === 0,
            blockers,
            suggestedNextCommands
          }));
          process.exitCode = blockers.length === 0 ? 0 : 2;
        } else {
          process.stdout.write(formatManualPlanSummary(result, blockers, suggestedNextCommands));
          process.exitCode = blockers.length === 0 ? 0 : 2;
        }
      });
      return;
    }

    if (selectedAction === "apply") {
      await runCommand("patch apply", options, async () => {
        if (!patchFile) throw new Error("Patch file is required; use - to read JSON from stdin");
        if (!options.yes) throw new Error("Manual Patch apply requires explicit consent with --yes");
        const context = await discoverProfileContext();
        const loadedConfig = await loadConfig();
        const session = await loadSession(context.sessionFile);
        const summary = withWorkspacePolicy(summarizeSession(session, context.sessionFile), loadedConfig.config);
        const patchInput = await readPatchInput(patchFile);
        const result = await applyManualPatchOffline(context, session, summary, patchInput, patchCommandForReceipt(selectedAction, patchFile, options));
        const suggestedNextCommands = ["zts patch receipts --json", "zts snapshot --json", "zts backup list"];
        if (options.json) {
          printJson(envelope("patch apply", { profile: context.profile, zenRunning: context.running, ...result }, { suggestedNextCommands }));
        } else {
          process.stdout.write(formatManualApplySummary(result, suggestedNextCommands));
        }
      });
    }

    if (selectedAction === "receipts") {
      await runCommand("patch receipts", options, async () => {
        const context = await discoverProfileContext();
        const receipts = await listManualApplyReceipts(context.profile.id);
        if (options.json) {
          printJson(envelope("patch receipts", { profile: context.profile, receipts }));
        } else {
          process.stdout.write(formatManualReceiptList(receipts));
        }
      });
    }
  });

program
  .command("apply")
  .description("Apply an exact saved Plan, or inspect apply receipts")
  .argument("[action]", "latest, Plan id/digest, list, or verify")
  .argument("[receipt-id]", "apply receipt id for verify")
  .option("--actions <ids>", "comma-separated executable action ids to derive as an exact subset Plan")
  .option("--yes", "confirm unattended application of the exact Plan")
  .option("--expect-digest <digest>", "required exact Plan digest for unattended mutation")
  .option("--json", "print stable JSON output")
  .action(async (action: string | undefined, receiptId: string | undefined, options: JsonOption & ApplyPlanOptions) => {
    const selectedAction = action ?? "list";

    if (selectedAction === "list") {
      await runCommand("apply list", options, async () => {
        const context = await discoverProfileContext();
        const receipts = await listApplyReceipts(context.profile.id);
        const domainReceipts = await listManualApplyReceipts(context.profile.id);
        if (options.json) {
          printJson(envelope("apply list", { profile: context.profile, receipts, domainReceipts }));
        } else {
          process.stdout.write(`${formatApplyReceiptList(receipts)}\n${formatDomainApplyReceiptList(domainReceipts)}`);
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

    await runCommand("apply plan", options, async () => {
      if (receiptId) throw new Error("Saved Plan apply accepts one Plan selector");
      const context = await discoverProfileContext();
      const original = await loadStoredPlan(context.profile.id, selectedAction);
      let selected = original;
      const requestedActionIds = splitCsv(options.actions);
      if (options.actions !== undefined) {
        if (requestedActionIds.length === 0) throw new Error("--actions requires at least one action id");
        if (options.yes) throw new Error("Selected action apply must first derive a subset Plan, then apply that exact Plan id with --yes");
        const loadedConfig = await loadConfig();
        const session = await loadSession(context.sessionFile);
        const summary = withWorkspacePolicy(summarizeSession(session, context.sessionFile), loadedConfig.config);
        const snapshot = snapshotFromSession(context, session, summary);
        selected = await deriveAndStoreSubsetPlan(snapshot, original.plan, requestedActionIds);
      }
      if (options.yes) {
        if (!options.expectDigest) throw new Error("Saved Plan apply requires --expect-digest with the exact Plan digest");
        if (options.expectDigest !== selected.plan.digest) {
          throw new Error(`Expected Plan digest ${options.expectDigest} does not match selected Plan ${selected.plan.digest}`);
        }
        const result = await applySavedPlanWithProfileLock(context, selected.plan, applyPlanCommandForReceipt(selectedAction, options));
        const data = {
          profile: context.profile,
          originalPlan: original.plan,
          plan: result.plan,
          authorization: result.authorization,
          receipt: result.receipt,
          receiptPath: result.receiptPath,
          summary: result.summary,
          applied: true
        };
        if (options.json) {
          printJson(envelope("apply plan", data, { suggestedNextCommands: ["zts backup list --json", "zts plan show latest --json"] }));
        } else {
          process.stdout.write(formatSavedPlanApply(result));
        }
        return;
      }
      const exactCommand = `zts apply ${shellQuote(selected.plan.id)} --yes --expect-digest ${selected.plan.digest}`;
      const blocker = selected.plan.derivation.kind === "subset"
        ? `Review and confirm the exact derived Plan ${selected.plan.digest} before mutation`
        : `Confirm the exact saved Plan ${selected.plan.digest} before mutation`;
      const data = {
        profile: context.profile,
        originalPlan: original.plan,
        plan: selected.plan,
        requestRevision: selected.requestRevision,
        artifacts: [{ kind: "plan", ...selected.artifact }],
        applied: false
      };
      if (options.json) {
        printJson(envelope("apply plan", data, {
          ok: false,
          blockers: [blocker],
          suggestedNextCommands: [`${exactCommand} --json`, "zts plan show latest --json"]
        }));
      } else {
        process.stdout.write(`${formatSavedPlan(selected.plan, false)}\n${blocker}\n\nNext:\n  ${exactCommand}\n`);
      }
      process.exitCode = 2;
    });
  });

program
  .command("backup")
  .description("Create, list, or restore backups")
  .argument("[action]", "optional action: list, restore, or prune")
  .argument("[backup-id]", "backup id for restore")
  .option("--before <iso-date>", "prune backups created before an ISO date")
  .option("--older-than <duration>", "prune backups older than a duration such as 30d, 12h, or 45m")
  .option("--dry-run", "show prune candidates without deleting backup files")
  .option("--json", "print stable JSON output")
  .action(async (action: string | undefined, backupId: string | undefined, options: JsonOption & BackupOptions) => {
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

    if (action === "prune") {
      await runCommand("backup prune", options, async () => {
        const context = await discoverProfileContext();
        const cutoff = pruneCutoff(options);
        const receipt = await pruneBackups(context.profile.id, cutoff, Boolean(options.dryRun), backupPruneCommand(options));
        if (options.json) {
          printJson(envelope("backup prune", { profile: context.profile, receipt }));
        } else {
          process.stdout.write(`${formatBackupPrune(receipt)}\n`);
        }
      });
      return;
    }

    if (action) {
      const message = `unknown backup action '${action}'`;
      if (options.json) {
        printJson(envelope("backup", { action }, { ok: false, blockers: [message], suggestedNextCommands: ["zts backup", "zts backup list", "zts backup prune --dry-run --older-than 30d"] }));
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

      const plan = planSortPreview(session, summary, source!, inputs);
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
  .option("--all", "sort from every applicable source Workspace")
  .option("--engine <engine>", "sorting Engine: rules, lexical, bge-small, or hybrid")
  .option("--preview", "show a glanceable preview without writing")
  .option("--dry-run", "show an operational dry run without writing")
  .option("--apply", "apply planned safe moves with the selected backend")
  .option("--yes", "confirm an unattended apply; requires --apply")
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
      const productionPlanRequested = Boolean(options.all || options.engine);
      const selectedEngine = normalizeEngine(options.engine);
      const inputError = validateSortMode(options, sourceWorkspace)
        ?? validateSortInputs(inputs)
        ?? (productionPlanRequested && selectedEngine !== "rules"
          ? selectedEngine === "invalid"
            ? `Unknown Engine '${options.engine}'; expected rules, lexical, bge-small, or hybrid`
            : `Engine '${options.engine}' is not installed in the production planner yet; explicit Engine selection never falls back`
          : null);
      if (inputError) {
        if (options.json) {
          printJson(envelope("sort", { sourceWorkspace: sourceWorkspace ?? null, inputs }, { ok: false, blockers: [inputError], suggestedNextCommands: ["zts sort --help"] }));
        } else {
          process.stderr.write(`zts: ${inputError}\n`);
        }
        process.exitCode = 1;
        return;
      }
      if (!source && !options.all) {
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

      if (productionPlanRequested) {
        const sourceScope = options.all
          ? { kind: "all_workspaces" as const }
          : { kind: "workspace" as const, workspaceId: source!.id, workspaceName: source!.name };
        const mode = options.apply ? "apply" : options.dryRun ? "dry-run" : "preview";
        let result: DailySortPlanResult;
        try {
          result = await planDailySort(context, session, summary, loadedConfig.config, {
            scope: sourceScope.kind === "all_workspaces"
              ? sourceScope
              : { kind: "workspace", workspaceId: sourceScope.workspaceId },
            engine: "rules",
            destinationAllowlist: inputs.to,
            destinationDenylist: inputs.notTo,
            only: inputs.only,
            except: inputs.except,
            limit: inputs.limit,
            includePinned: inputs.includePinned,
            includeEssentials: inputs.includeEssentials,
            autoApplyRequested: Boolean(options.apply),
            planMode: mode === "preview" ? "create_or_reuse" : "require_existing"
          });
        } catch (error) {
          if (!(error instanceof PlanReuseError)) throw error;
          const stored = error.storedPlan;
          const planResolution = error.code === "PLAN_SNAPSHOT_DRIFT"
            ? "blocked_snapshot_drift"
            : error.code === "PLAN_EXPIRED"
              ? "blocked_expired"
              : "blocked_preview_required";
          const data = {
            profile: context.profile,
            zenRunning: context.running,
            sourceScope,
            engine: selectedEngine,
            mode,
            plan: stored?.plan ?? null,
            planResolution,
            requestRevision: stored?.requestRevision ?? null,
            currentSnapshotRevision: error.currentSnapshotRevision,
            artifacts: stored ? [{ kind: "plan", ...stored.artifact }] : [],
            applied: false
          };
          const suggestedNextCommands = [sortFollowUpCommand(options, sourceWorkspace, "--preview"), "zts plan show latest"];
          if (options.json) {
            printJson(envelope("sort", data, { ok: false, blockers: [error.message], suggestedNextCommands }));
          } else {
            process.stderr.write(`Sort ${mode} blocked\n- ${error.message}\n\nNext:\n${suggestedNextCommands.map((command) => `  ${command}`).join("\n")}\n`);
          }
          process.exitCode = 2;
          return;
        }
        const applyBlockers = options.apply
          ? ["Engine Plan apply is not enabled yet; the exact Plan was preserved without mutation"]
          : [];
        const warnings = result.snapshot.authority === "persisted_observation"
          ? ["Zen is running; this Plan is based on a persisted observation and cannot be authorized for apply"]
          : [];
        const suggestedNextCommands = dailySortNextCommands(options, sourceWorkspace, mode, result.plan);
        const data = {
          profile: context.profile,
          zenRunning: context.running,
          sourceScope,
          engine: selectedEngine,
          mode,
          snapshot: result.snapshot,
          plan: result.plan,
          planResolution: result.planResolution,
          requestRevision: result.requestRevision,
          summary: result.summary,
          artifacts: [{ kind: "plan", ...result.artifact }],
          applied: false
        };
        if (options.json) {
          printJson(envelope("sort", data, {
            ok: applyBlockers.length === 0,
            warnings,
            blockers: applyBlockers,
            suggestedNextCommands
          }));
        } else {
          process.stdout.write(formatDailySortPlan(result, sourceScope, mode, warnings, applyBlockers, suggestedNextCommands));
        }
        process.exitCode = applyBlockers.length === 0 ? 0 : 2;
        return;
      }

      const plan = planSortPreview(session, summary, source!, inputs);
      const applyRequested = Boolean(options.apply);
      const previewRequested = !applyRequested;
      const applyRequestedWithMoves = applyRequested && plan.moveCount > 0;
      let applyBlockers = applyRequested && plan.moveCount === 0
        ? []
        : previewRequested
          ? offlineApplyBlockers(context, inputs.backend)
          : sortApplyBlockers(context, inputs.backend);
      let applyReceipt = undefined;
      let resolvedBackend: "session" | "live" = resolveApplyBackend(context, inputs.backend);
      if (applyRequestedWithMoves && applyBlockers.length === 0) {
        const consent = await requestSortApplyConsent(plan.moveCount, resolvedBackend, options);
        if (!consent.granted && consent.blocker) applyBlockers.push(consent.blocker);
      }
      if (applyRequestedWithMoves && applyBlockers.length === 0) {
        resolvedBackend = resolveApplyBackend(context, inputs.backend);
        if (resolvedBackend === "live") {
          const liveCheck = await inspectLiveAttachment(context, { connect: true });
          if (!liveCheck.attachable) {
            applyBlockers = liveCheck.blockers;
          } else {
            applyReceipt = await applySortPlanLive(context, plan, sortCommandForReceipt(sourceWorkspace, options));
          }
        } else {
          applyReceipt = await applySortPlanOffline(context, session, plan, sortCommandForReceipt(sourceWorkspace, options));
        }
        if (applyReceipt && !applyReceipt.verification.ok) applyBlockers = applyReceipt.verification.blockers ?? ["Apply verification failed"];
      }
      const suggestedNextCommands = applyBlockers.length > 0
        ? ["zts sort --preview", "zts status", resolvedBackend === "live" ? "zts bridge live-check --connect --json" : "zts backup"]
        : previewRequested
          ? ["zts sort --apply", "zts status"]
          : ["zts status", "zts backup"];
      const ok = previewRequested || applyBlockers.length === 0;

      const data = {
        profile: context.profile,
        zenRunning: context.running,
        sourceWorkspace: source,
        inputs,
        plan,
        mode: applyRequested ? "apply" : options.dryRun ? "dry-run" : "preview",
        previewOnly: previewRequested,
        noChanges: applyRequested && plan.moveCount === 0,
        applied: Boolean(applyReceipt?.verification.ok),
        applyReceiptWritten: Boolean(applyReceipt),
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
        process.stdout.write(`${options.dryRun ? formatSortDryRun(plan, applyBlockers, suggestedNextCommands) : formatSortPreview(plan, applyBlockers, suggestedNextCommands, applyReceipt, applyRequested)}\n`);
        process.exitCode = ok ? 0 : 2;
      }
    });
  });

interface SortOptions {
  all?: boolean;
  engine?: string;
  preview?: boolean;
  dryRun?: boolean;
  apply?: boolean;
  yes?: boolean;
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

interface ApplyPlanOptions {
  actions?: string;
  yes?: boolean;
  expectDigest?: string;
}

interface BackupOptions {
  before?: string;
  olderThan?: string;
  dryRun?: boolean;
}

interface BridgeOptions {
  timeoutMs?: string;
  connect?: boolean;
  url?: string;
  fromWorkspace?: string;
  toWorkspace?: string;
  confirmLiveMove?: boolean;
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

function backupPruneCommand(options: BackupOptions): string {
  const parts = ["zts", "backup", "prune"];
  if (options.before) parts.push("--before", options.before);
  if (options.olderThan) parts.push("--older-than", options.olderThan);
  if (options.dryRun) parts.push("--dry-run");
  return parts.join(" ");
}

function patchCommandForReceipt(action: string, patchFile: string, options: { yes?: boolean; json?: boolean }): string {
  const parts = ["zts", "patch", action, patchFile];
  if (options.yes) parts.push("--yes");
  if (options.json) parts.push("--json");
  return parts.join(" ");
}

function applyPlanCommandForReceipt(selector: string, options: ApplyPlanOptions): string {
  const parts = ["zts", "apply", shellQuote(selector)];
  if (options.yes) parts.push("--yes");
  if (options.expectDigest) parts.push("--expect-digest", options.expectDigest);
  return parts.join(" ");
}

function pruneCutoff(options: BackupOptions): Date {
  if (options.before && options.olderThan) {
    throw new Error("Use only one prune selector: --before or --older-than");
  }
  if (options.before) {
    const before = new Date(options.before);
    if (!Number.isFinite(before.getTime())) throw new Error("--before must be a valid ISO date");
    return before;
  }
  if (options.olderThan) {
    return new Date(Date.now() - parseDurationMs(options.olderThan));
  }
  throw new Error("Backup prune requires --before <iso-date> or --older-than <duration>");
}

function parseDurationMs(value: string): number {
  const match = /^(\d+)(m|h|d)$/.exec(value.trim());
  if (!match) throw new Error("--older-than must use a duration such as 30d, 12h, or 45m");
  const amount = Number(match[1]);
  if (amount <= 0) throw new Error("--older-than must be greater than zero");
  const unit = match[2];
  const multipliers: Record<string, number> = {
    m: 60 * 1000,
    h: 60 * 60 * 1000,
    d: 24 * 60 * 60 * 1000
  };
  return amount * multipliers[unit];
}

function probeTimeoutMs(value?: string): number {
  if (value === undefined) return 8000;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1000 || parsed > 30000) {
    throw new Error("--timeout-ms must be a whole number between 1000 and 30000");
  }
  return parsed;
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

function statusEnvelopeOptions(zenRunning: boolean, bridgeBlockers: string[]) {
  const blockers = zenRunning
    ? ["Offline apply is blocked because Zen is running", ...bridgeBlockers]
    : bridgeBlockers;
  return {
    warnings: ["Active session writes are refused; offline session writes require Zen closed and a fresh backup"],
    blockers,
    suggestedNextCommands: zenRunning ? ["zts workspaces", "zts bridge status", "zts backup", "zts sort --preview"] : ["zts workspaces", "zts bridge status", "zts sort --backend session"]
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

function validateSortMode(options: SortOptions, sourceWorkspace?: string): string | null {
  if (options.all && sourceWorkspace) {
    return "--all cannot be combined with a source Workspace argument";
  }
  if (options.apply && (options.preview || options.dryRun)) {
    return "--apply cannot be combined with --preview or --dry-run";
  }
  if (options.preview && options.dryRun) {
    return "--preview cannot be combined with --dry-run";
  }
  if (options.yes && !options.apply) {
    return "--yes requires --apply";
  }
  return null;
}

function normalizeEngine(engine?: string): "rules" | "lexical" | "bge_small" | "hybrid" | "invalid" {
  if (engine === undefined || engine === "rules") return "rules";
  if (engine === "lexical") return "lexical";
  if (engine === "bge-small" || engine === "bge_small") return "bge_small";
  if (engine === "hybrid") return "hybrid";
  return "invalid";
}

async function requestSortApplyConsent(
  moveCount: number,
  backend: "session" | "live",
  options: SortOptions & JsonOption
): Promise<{ granted: boolean; blocker: string | null }> {
  if (options.yes) return { granted: true, blocker: null };
  if (options.json) {
    return {
      granted: false,
      blocker: "JSON apply requires explicit unattended consent with --apply --yes"
    };
  }
  if (!process.stdin.isTTY || !process.stderr.isTTY) {
    return {
      granted: false,
      blocker: "Unattended apply requires explicit consent with --apply --yes"
    };
  }

  const prompt = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = await prompt.question(`Apply ${moveCount} planned move${moveCount === 1 ? "" : "s"} using ${backend}? [y/N] `);
    const granted = answer.trim().toLowerCase() === "y" || answer.trim().toLowerCase() === "yes";
    return {
      granted,
      blocker: granted ? null : "Apply cancelled; no changes were made"
    };
  } finally {
    prompt.close();
  }
}

function normalizeBackend(backend?: string): SortInputs["backend"] {
  if (backend === undefined || backend === "auto" || backend === "live" || backend === "session") {
    return backend ?? "auto";
  }
  return backend as SortInputs["backend"];
}

function sortFollowUpCommand(options: SortOptions, sourceWorkspace: string | undefined, mode: "--preview" | "--dry-run"): string {
  const parts = ["zts", "sort"];
  if (!options.all && sourceWorkspace) parts.push(shellQuote(sourceWorkspace));
  if (options.all) parts.push("--all");
  if (options.engine) parts.push("--engine", shellQuote(options.engine));
  parts.push(mode);
  return parts.join(" ");
}

function dailySortNextCommands(
  options: SortOptions,
  sourceWorkspace: string | undefined,
  mode: "preview" | "dry-run" | "apply",
  plan: Plan
): string[] {
  const commands = mode === "preview"
    ? [sortFollowUpCommand(options, sourceWorkspace, "--dry-run"), "zts plan show latest"]
    : ["zts plan show latest"];
  if (plan.snapshotAuthority !== "authoritative" || plan.snapshotFreshness !== "current") {
    commands.push(`Quit Zen, then rerun ${sortFollowUpCommand(options, sourceWorkspace, "--preview")}`);
    return commands;
  }
  commands.push("Plan apply is not enabled for Engine Plans yet; use zts patch apply for exact manual Patch apply");
  return commands;
}

function shellQuote(value: string): string {
  return /^[A-Za-z0-9_./:=@+-]+$/.test(value) ? value : `'${value.replace(/'/g, `'"'"'`)}'`;
}

function formatDailySortPlan(
  result: DailySortPlanResult,
  sourceScope: { readonly kind: "all_workspaces" } | { readonly kind: "workspace"; readonly workspaceId: string; readonly workspaceName: string },
  mode: "preview" | "dry-run" | "apply",
  warnings: readonly string[],
  blockers: readonly string[],
  suggestedNextCommands: readonly string[]
): string {
  const title = mode === "dry-run" ? "Sort dry run" : mode === "apply" ? "Sort apply blocked" : "Sort preview";
  const scope = sourceScope.kind === "all_workspaces" ? "all applicable Workspaces" : sourceScope.workspaceName;
  const lines = [
    `${title} · ${scope}`,
    `Plan ${result.plan.id}`,
    `Digest ${result.plan.digest}`,
    `${result.planResolution === "created" ? "Saved" : "Reused"} exact state-bound Plan`,
    "",
    `Move       ${result.summary.moveCount}`,
    `Review     ${result.summary.reviewCount}`,
    `Protected  ${result.summary.protectedCount}`,
    `Blocked    ${result.summary.blockedCount}`,
    `Unchanged  ${result.summary.unchangedCount}`,
    "",
    "Nothing changed."
  ];
  if (mode === "dry-run") {
    lines.push("", "Actions:");
    const entities = new Map<EntityRef, Entity>(result.snapshot.entities.map((entity) => [entity.ref, entity]));
    const workspaces = new Map(result.snapshot.workspaces.map((workspace) => [workspace.id, workspace]));
    for (const action of result.plan.actions) {
      const entityRef = action.disposition === "move" ? action.operation.entityRef : action.entityRef;
      const entity = entities.get(entityRef);
      const destinationId = action.disposition === "move"
        ? action.operation.expectedPostState.workspaceId
        : action.candidateDestinationWorkspaceId;
      const sourceName = entity ? workspaces.get(entity.workspaceId)?.name ?? entity.workspaceId : "(unknown source)";
      const destinationName = destinationId ? workspaces.get(destinationId)?.name ?? destinationId : "(none)";
      const title = entity ? terminalData(entity.title) : entityRef;
      const origin = entity?.members[0]?.url ? domainFromInput(entity.members[0].url) : "";
      lines.push(`  ${action.actionId}`);
      lines.push(`    ${action.disposition} ${title}`);
      lines.push(`    ${terminalData(sourceName)} -> ${terminalData(destinationName)}${origin ? ` · ${terminalData(origin)}` : ""}`);
      lines.push(`    ${terminalData(action.decision.explanation.value)}`);
    }
  }
  if (warnings.length > 0) lines.push("", "Warnings:", ...warnings.map((warning) => `  - ${warning}`));
  if (blockers.length > 0) lines.push("", "Blockers:", ...blockers.map((blocker) => `  - ${blocker}`));
  if (suggestedNextCommands.length > 0) lines.push("", "Next:", ...suggestedNextCommands.map((command) => `  ${command}`));
  return `${lines.join("\n")}\n`;
}

function formatSavedPlan(plan: Plan, expired: boolean): string {
  const counts = new Map<string, number>();
  for (const action of plan.actions) counts.set(action.disposition, (counts.get(action.disposition) ?? 0) + 1);
  return `${[
    "Saved Plan",
    `Plan: ${plan.id}`,
    `Digest: ${plan.digest}`,
    `Snapshot: ${plan.snapshotRevision}`,
    `Authority: ${plan.snapshotAuthority}`,
    `Expires: ${plan.expiresAt}${expired ? " (expired)" : ""}`,
    `Move: ${counts.get("move") ?? 0}`,
    `Review: ${counts.get("review") ?? 0}`,
    `Protected: ${counts.get("protected") ?? 0}`,
    `Blocked: ${counts.get("blocked") ?? 0}`,
    `Unchanged: ${counts.get("unchanged") ?? 0}`
  ].join("\n")}\n`;
}

function formatSnapshotSummary(snapshot: Snapshot, warnings: string[], suggestedNextCommands: string[]): string {
  const lines = [
    "Domain Snapshot",
    `Profile: ${snapshot.profile.name} (${snapshot.profile.id})`,
    `Revision: ${snapshot.revision}`,
    `Authority: ${snapshot.authority}`,
    `Freshness: ${snapshot.freshness}`,
    `Control route: ${snapshot.provenance.route}`,
    `Workspaces: ${snapshot.workspaces.length}`,
    `Entities: ${snapshot.entities.length}`,
    "",
    "First entities:",
    ...snapshot.entities.slice(0, 8).map((entity) => `  - ${entity.ref} -> ${entity.workspaceId} (${entity.kind}) ${terminalData(entity.title)}`)
  ];
  if (snapshot.entities.length > 8) lines.push(`  ... ${snapshot.entities.length - 8} more`);
  if (warnings.length > 0) lines.push("", "Warnings:", ...warnings.map((warning) => `  - ${warning}`));
  if (suggestedNextCommands.length > 0) lines.push("", "Next:", ...suggestedNextCommands.map((command) => `  ${command}`));
  return `${lines.join("\n")}\n`;
}

function formatManualPlanSummary(result: ManualPlanResult, blockers: string[], suggestedNextCommands: string[]): string {
  const lines = [
    "Manual Patch Plan",
    `Plan: ${result.plan.id}`,
    `Digest: ${result.plan.digest}`,
    `Snapshot: ${result.plan.snapshotRevision}`,
    `Authority: ${result.plan.snapshotAuthority}`,
    `Freshness: ${result.plan.snapshotFreshness}`,
    `Moves: ${result.summary.moveCount}`,
    `Protected: ${result.summary.protectedCount}`,
    `Blocked: ${result.summary.blockedCount}`,
    `Unchanged: ${result.summary.unchangedCount}`
  ];
  for (const action of result.plan.actions.slice(0, 12)) {
    if (action.disposition === "move") {
      lines.push(`  - move ${action.operation.entityRef} -> ${action.operation.expectedPostState.workspaceId}`);
    } else {
      lines.push(`  - ${action.disposition} ${action.entityRef} -> ${action.candidateDestinationWorkspaceId ?? "(none)"}`);
    }
  }
  if (result.plan.actions.length > 12) lines.push(`  ... ${result.plan.actions.length - 12} more`);
  if (blockers.length > 0) lines.push("", "Blockers:", ...blockers.map((blocker) => `  - ${blocker}`));
  if (suggestedNextCommands.length > 0) lines.push("", "Next:", ...suggestedNextCommands.map((command) => `  ${command}`));
  return `${lines.join("\n")}\n`;
}

function formatManualApplySummary(result: ManualApplyResult, suggestedNextCommands: string[]): string {
  const lines = [
    "Manual Patch Apply",
    `Receipt: ${result.receipt.id}`,
    `Plan: ${result.plan.id}`,
    `Moves: ${result.summary.moveCount}`,
    `Before Snapshot: ${result.receipt.beforeSnapshotRevision}`,
    `After Snapshot: ${result.receipt.afterSnapshotRevision ?? "(none)"}`,
    `Backup: ${result.receipt.backupArtifact?.id ?? "(none)"}`,
    `Receipt file: ${result.receiptPath}`,
    "",
    "Applied:",
    ...result.receipt.operations.map((operation) => `  - ${operation.entityRef} -> ${operation.observedWorkspaceId}`)
  ];
  if (suggestedNextCommands.length > 0) lines.push("", "Next:", ...suggestedNextCommands.map((command) => `  ${command}`));
  return `${lines.join("\n")}\n`;
}

function formatSavedPlanApply(result: SavedPlanApplyResult): string {
  return `${[
    "Saved Plan Apply",
    `Receipt: ${result.receipt.id}`,
    `Plan: ${result.plan.id}`,
    `Digest: ${result.plan.digest}`,
    `Moves: ${result.summary.moveCount}`,
    `Before Snapshot: ${result.receipt.beforeSnapshotRevision}`,
    `After Snapshot: ${result.receipt.afterSnapshotRevision ?? "(none)"}`,
    `Backup: ${result.receipt.backupArtifact?.id ?? "(none)"}`,
    `Receipt file: ${result.receiptPath}`,
    "",
    "Applied:",
    ...result.receipt.operations.map((operation) => `  - ${operation.entityRef} -> ${operation.observedWorkspaceId}`)
  ].join("\n")}\n`;
}

function formatManualReceiptList(receipts: ManualApplyReceiptSummary[]): string {
  return formatDomainApplyReceiptList(receipts);
}

function formatDomainApplyReceiptList(receipts: ManualApplyReceiptSummary[]): string {
  if (receipts.length === 0) return "No domain apply receipts found\n";
  return `${[
    "Domain apply receipts",
    ...receipts.map((receipt) =>
      `  - ${receipt.id} ${receipt.kind} ${receipt.outcome} (${receipt.operationCount} ops) ${receipt.completedAt}`
    )
  ].join("\n")}\n`;
}

function terminalData(value: string): string {
  return value.replace(/[\u001B\u009B][[()\]#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, "")
    .replace(/[\u0000-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
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
