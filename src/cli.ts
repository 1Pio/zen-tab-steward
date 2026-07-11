#!/usr/bin/env node
import { Command, CommanderError } from "commander";
import { BackupSelectionError, createBackup, listBackups, previewBackupRestore, pruneBackups } from "./backup.js";
import { inspectBridge, inspectLiveAttachment, runBridgeLiveReadProof, runBridgeProbe } from "./bridge.js";
import {
  addDomainRuleInContents,
  ConfigChangedError,
  ConfigPermissionsError,
  ConfigValidationError,
  getConfigValue,
  inspectConfigLocation,
  loadConfig,
  saveConfigContents,
  setConfigValueInContents,
  ZtsConfig
} from "./config.js";
import { planDailySort, summarizePlan } from "./daily-sort.js";
import { envelope, formatBackup, formatBackupList, formatBackupPrune, formatBridge, formatBridgeLiveAttachment, formatBridgeLiveRead, formatBridgeProbe, formatStatus, formatTabs, formatWorkspaces, printJson } from "./output.js";
import { PatchInputValidationError, readPatchInput, resolveManualPlanFromInput } from "./manual.js";
import {
  applyStoredPlanClosedSession,
  ApplyReceiptSelectionError,
  ApplyTransactionSafetyError,
  assertSupportedApplyRoute,
  ensureApplyReceiptSummaryHistory,
  listTransactionReceiptPage,
  verifyTransactionReceipt
} from "./apply-transaction.js";
import {
  CLI_BLOCKED_OUTCOME,
  CLI_INTERNAL_ERROR_OUTCOME,
  CLI_INVALID_OUTCOME,
  cliOutcomeForApplyExecutionError,
  cliOutcomeForApplyTransaction,
  cliOutcomeForApplyVerification,
  cliOutcomeForNoMutation,
  cliOutcomeForRecoveryError,
  cliOutcomeForRecoveryResult
} from "./cli-outcome.js";
import { ApplyReceiptCursorError, ApplyReceiptHistoryCorruptionError } from "./apply-receipt-store.js";
import type { CliOutcome } from "./cli-outcome.js";
import {
  ApplyRecoveryBlockedError,
  inspectApplyRecovery,
  listApplyRecoveryInspections,
  recoverApplyTransaction
} from "./apply-recovery.js";
import {
  applyApplyStoreRetention,
  APPLY_RETENTION_DESTRUCTIVE_CONSENT,
  ApplyRetentionBlockedError,
  inspectApplyStoreRetention
} from "./apply-retention.js";
import { readApplyArtifactLayout } from "./apply-artifacts.js";
import { deriveAndStoreSubsetPlan, loadStoredPlan, PlanReuseError } from "./plans.js";
import {
  noMutationApplyOutcome,
  type NoMutationApplyOutcome,
  validateNoMutationApply
} from "./no-changes.js";
import { discoverProfileContext } from "./profile.js";
import { loadSessionSummary, withWorkspacePolicy } from "./session.js";
import { captureSessionSnapshot } from "./session-snapshot.js";
import { classifyRuleForUrl, resolveRuleWorkspace } from "./engines/rules.js";
import { canonicalUrlPattern } from "./url-pattern.js";
import { VERSION } from "./version.js";
import { terminalJson, terminalText } from "./terminal.js";
import { ambiguousWorkspaceMessage, resolveWorkspaceSelector, tabListing, workspaceViews } from "./views.js";
import { applyUndo, inspectUndo, UndoBlockedError, UndoSelectionError } from "./undo.js";
import { createPatchFromAgentDiff, defineAgentDiff } from "./agent-diff.js";
import {
  createDarwinManagedZenPlatform,
  discoverDarwinManagedZenRequest
} from "./darwin-managed-zen.js";
import { runManagedAuthoritativeCapture } from "./managed-authoritative-capture.js";
import type { ManagedCaptureEvidence } from "./managed-authoritative-capture.js";

import type { ManualPlanResult } from "./manual.js";
import type {
  ApplyTransactionOutcome,
  ApplyTransactionResult,
  TransactionReceiptPage,
  TransactionReceiptVerificationReport
} from "./apply-transaction.js";
import type { ApplyRecoveryInspection, ApplyRecoveryResult } from "./apply-recovery.js";
import type { ApplyRetentionInspection, ApplyRetentionResult } from "./apply-retention.js";
import type { DailySortPlanResult } from "./daily-sort.js";
import type { Plan } from "./domain/change.js";
import type { Sha256Digest } from "./domain/digest.js";
import type { Entity, EntityRef, Snapshot } from "./domain/snapshot.js";
import type { UndoInspection } from "./undo.js";

interface JsonOption {
  json?: boolean;
}

class CliInvocationError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "CliInvocationError";
  }
}

const program = new Command();

program
  .name("zts")
  .description("Zen Tab Steward: safe Zen Browser tab and workspace stewardship")
  .version(VERSION)
  .exitOverride()
  .configureOutput({
    writeErr: (text) => {
      if (!jsonDocumentModeRequested()) process.stderr.write(text);
    }
  })
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
      const closedSessionApply = {
        status: context.running ? "blocked_running" as const : "checked_at_apply" as const,
        mutationAuthorityEstablished: false,
        reason: context.running
          ? "Zen is running and may own the Profile"
          : "Native Profile control, primary session source, unfinished transactions, Plan Drift, and expiry are checked atomically at apply time"
      };
      const data = { profile: context.profile, zenRunning: context.running, session: summary, closedSessionApply, bridge };

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
  .argument("[action]", "status, doctor, live-check, live-read, or probe")
  .option("--connect", "for live-check, connect to the discovered local WebDriver BiDi endpoint and run session.status")
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
      printJson(envelope("bridge", { action: selectedAction }, { ok: false, blockers: [message], suggestedNextCommands: ["zts bridge status", "zts bridge doctor", "zts bridge live-check", "zts bridge live-read", "zts bridge probe"] }));
    } else {
      process.stderr.write(`zts: ${terminalData(message)}\n`);
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
      const selectedAction = action ?? "show";

      if (selectedAction === "path") {
        const location = await inspectConfigLocation();
        if (options.json) printJson(envelope("config path", location));
        else process.stdout.write(`${terminalData(location.path)}\n`);
        return;
      }

      const loaded = await loadConfig();

      if (selectedAction === "show") {
        if (options.json) printJson(envelope("config show", loaded));
        else process.stdout.write(`${terminalJson(loaded.config)}\n`);
        return;
      }

      if (selectedAction === "get" && key) {
        const configValue = getConfigValue(loaded.config, key);
        if (options.json) printJson(envelope("config get", { path: loaded.path, key, value: configValue }));
        else process.stdout.write(`${typeof configValue === "object" ? terminalJson(configValue) : terminalData(String(configValue))}\n`);
        return;
      }

      if (selectedAction === "set" && key && value !== undefined) {
        const contents = setConfigValueInContents(loaded.contents, key, value);
        const path = await saveConfigContents(contents, loaded);
        const updated = (await loadConfig()).config;
        if (options.json) printJson(envelope("config set", { path, key, value: getConfigValue(updated, key) }));
        else process.stdout.write(`Set ${terminalData(key)} in ${terminalData(path)}\n`);
        return;
      }

      throw new CliInvocationError("Usage: zts config [path|show|get <key>|set <key> <value>]");
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
        if (!workspace.trim()) throw new CliInvocationError("Destination Workspace cannot be empty");
        const pattern = validatedCliInput(() => canonicalUrlPattern(patternOrUrl));
        const context = await discoverProfileContext();
        const captured = await captureSessionSnapshot(context, loaded.config);
        const resolved = resolveRuleWorkspace(captured.snapshot.workspaces, workspace.trim());
        if (resolved.status === "missing") throw new CliInvocationError(`Destination Workspace not found: ${workspace}`);
        if (resolved.status === "ambiguous") {
          throw new CliInvocationError(
            `Destination Workspace '${workspace}' is ambiguous; use one id: ${resolved.matches.map((match) => match.id).join(", ")}`
          );
        }
        const destination = resolved.workspace;
        const contents = addDomainRuleInContents(loaded.contents, pattern, destination.id);
        const path = await saveConfigContents(contents, loaded);
        if (options.json) printJson(envelope("rules add domain", { path, pattern, workspace: destination }));
        else process.stdout.write(`Added domain rule ${terminalData(pattern)} -> ${terminalData(destination.name)}\n`);
        return;
      }

      if (action === "test" && type) {
        const testInput = patternOrUrl ?? type;
        const domain = validatedCliInput(() => domainFromInput(testInput));
        const configuredMatch = classifyRuleForUrl(testInput, loaded.config.rules.domains);
        const context = await discoverProfileContext();
        const captured = await captureSessionSnapshot(context, loaded.config);
        const resolution = configuredMatch
          ? resolveRuleWorkspace(captured.snapshot.workspaces, configuredMatch.workspaceName)
          : null;
        const destination = resolution?.status === "resolved" ? resolution.workspace : null;
        const match = configuredMatch && destination
          ? {
              ...configuredMatch,
              workspaceSelector: configuredMatch.workspaceName,
              workspaceName: destination.name,
              workspaceId: destination.id
            }
          : null;
        const warnings = configuredMatch && resolution?.status === "missing"
          ? [`Configured rule ${configuredMatch.matchedPattern} names missing Workspace ${configuredMatch.workspaceName}`]
          : configuredMatch && resolution?.status === "ambiguous"
            ? [`Configured rule ${configuredMatch.matchedPattern} names ambiguous Workspace ${configuredMatch.workspaceName}; use one Workspace id`]
            : [];
        if (options.json) printJson(envelope("rules test", {
          input: testInput,
          domain,
          snapshotRevision: captured.snapshot.revision,
          configuredMatch,
          match
        }, { warnings }));
        else process.stdout.write(match
          ? `${terminalData(domain)} -> ${terminalData(match.workspaceName)} (${terminalData(match.matchedPattern)})\n`
          : `${terminalData(domain)} -> review${warnings.length > 0 ? ` (${terminalData(warnings[0])})` : ""}\n`);
        return;
      }

      throw new CliInvocationError("Usage: zts rules [add domain <pattern> <workspace>|test <url-or-domain>]");
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
      const captured = await captureSessionSnapshot(context, loadedConfig.config);
      const workspaces = workspaceViews(captured.snapshot, captured.summary.workspaces);
      const observation = snapshotObservationPresentation(captured.snapshot, captured.context.running);
      if (options.json) {
        printJson(envelope("workspaces", {
          profile: captured.context.profile,
          zenRunning: captured.context.running,
          snapshotRevision: captured.snapshot.revision,
          authority: captured.snapshot.authority,
          freshness: captured.snapshot.freshness,
          capturedAt: captured.snapshot.capturedAt,
          controlRoute: captured.snapshot.provenance.route,
          workspaces
        }, { warnings: snapshotObservationWarnings(observation) }));
      } else {
        process.stdout.write(`${formatWorkspaces(workspaces, observation)}\n`);
      }
    });
  });

program
  .command("tabs")
  .description("List Zen tabs with workspace and protection metadata")
  .argument("[workspace]", "optional workspace name or id filter")
  .option("--workspace <workspace>", "workspace name or id filter")
  .option("--workspaces <workspaces>", "comma-separated workspace names or ids")
  .option("--all", "list tabs from every workspace")
  .option("--json", "print stable JSON output")
  .action(async (
    workspaceArgument: string | undefined,
    options: JsonOption & { workspace?: string; workspaces?: string; all?: boolean }
  ) => {
    await runCommand("tabs", options, async () => {
      const requestedScopes = [
        workspaceArgument === undefined ? null : "workspace argument",
        options.workspace === undefined ? null : "--workspace",
        options.workspaces === undefined ? null : "--workspaces",
        options.all ? "--all" : null
      ].filter((scope): scope is string => scope !== null);
      if (requestedScopes.length > 1) {
        throw new CliInvocationError(
          `Choose one tab scope: workspace argument, --workspace, --workspaces, or --all (received ${requestedScopes.join(", ")})`
        );
      }
      const workspaceSelectors = options.workspaces === undefined
        ? (options.all ? [] : [options.workspace ?? workspaceArgument].filter((value): value is string => value !== undefined))
        : splitCsv(options.workspaces);
      if (options.workspaces !== undefined && workspaceSelectors.length === 0) {
        throw new CliInvocationError("--workspaces requires at least one workspace name or id");
      }
      const context = await discoverProfileContext();
      const loadedConfig = await loadConfig();
      const captured = await captureSessionSnapshot(context, loadedConfig.config);
      const listing = validatedCliInput(() => tabListing(captured.snapshot, workspaceSelectors));
      const observation = snapshotObservationPresentation(captured.snapshot, captured.context.running);
      if (options.json) {
        printJson(envelope("tabs", {
          profile: captured.context.profile,
          zenRunning: captured.context.running,
          snapshotRevision: captured.snapshot.revision,
          authority: captured.snapshot.authority,
          freshness: captured.snapshot.freshness,
          capturedAt: captured.snapshot.capturedAt,
          controlRoute: captured.snapshot.provenance.route,
          workspace: workspaceSelectors.length === 1 ? workspaceSelectors[0] : null,
          workspaceScope: listing.workspaceScope,
          tabs: listing.tabs
        }, { warnings: snapshotObservationWarnings(observation) }));
      } else {
        process.stdout.write(`${formatTabs(listing.tabs, observation)}\n`);
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
      const captured = await captureSessionSnapshot(context, loadedConfig.config);
      const snapshot = captured.snapshot;
      const data = {
        profile: captured.context.profile,
        zenRunning: captured.context.running,
        snapshot
      };
      const warnings = captured.authorityBlocker
        ? [`Snapshot is a persisted observation and cannot be used for apply: ${captured.authorityBlocker}`]
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
      if (selectedAction !== "show") throw new CliInvocationError("Usage: zts plan show [latest|plan-id|plan-digest]");
      const context = await discoverProfileContext();
      const stored = await loadStoredPlan(context.profile.id, selector ?? "latest");
      const expired = Date.parse(stored.plan.expiresAt) <= Date.now();
      const data = {
        profile: context.profile,
        snapshot: stored.snapshot,
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
        process.stdout.write(formatSavedPlan(stored.snapshot, stored.plan, expired));
      }
    });
  });

program
  .command("diff")
  .description("Plan a revision-bound bulk tab movement diff")
  .argument("[action]", "plan")
  .argument("[input]", "Diff JSON path, or - for stdin")
  .option("--stdin", "read Diff JSON from stdin")
  .option("--manage-zen", "gracefully restart Zen to create a current authoritative Diff Plan")
  .option("--json", "print stable JSON output")
  .action(async (
    action: string | undefined,
    input: string | undefined,
    options: JsonOption & { stdin?: boolean; manageZen?: boolean }
  ) => {
    const selectedAction = action ?? "plan";
    await runCommand(`diff ${selectedAction}`, options, async () => {
      if (selectedAction !== "plan") {
        throw new CliInvocationError("Usage: zts diff plan (--stdin | <diff-file>)");
      }
      if (options.stdin && input !== undefined) {
        throw new CliInvocationError("Choose one Diff input: --stdin or a file path");
      }
      const inputPath = options.stdin ? "-" : input;
      if (!inputPath) throw new CliInvocationError("Diff input is required; use --stdin or provide a JSON file path");
      const rawInput = await readPatchInput(inputPath);
      try {
        defineAgentDiff(rawInput);
      } catch (error) {
        throw new PatchInputValidationError(error instanceof Error ? error.message : String(error), error);
      }
      const context = await discoverProfileContext();
      const loadedConfig = await loadConfig();
      let captured;
      let result;
      let managedLifecycle: ManagedCaptureEvidence = {
        requested: Boolean(options.manageZen),
        performed: false,
        quit: "not_needed" as const,
        relaunch: "not_needed" as const,
        lifecycleBindingRevision: null,
        relaunchedBindingRevision: null
      };
      if (options.manageZen) {
        const lifecycleOptions = context.running
          ? await managedLifecycleOptions(context)
          : {
              platform: createDarwinManagedZenPlatform(),
              waitOptions: { timeoutMs: 30_000, pollMs: 250 }
            } as const;
        const managed = await runManagedAuthoritativeCapture(
          context,
          loadedConfig.config,
          lifecycleOptions,
          async (authoritative) => {
            let patch;
            try {
              patch = createPatchFromAgentDiff(authoritative.snapshot, rawInput);
            } catch (error) {
              throw new PatchInputValidationError(error instanceof Error ? error.message : String(error), error);
            }
            return resolveManualPlanFromInput(authoritative.snapshot, patch, loadedConfig.config);
          }
        );
        captured = managed.captured;
        result = managed.value;
        managedLifecycle = managed.lifecycle;
      } else {
        captured = await captureSessionSnapshot(
          context,
          loadedConfig.config,
          options.manageZen ? { requireAuthoritative: true } : undefined
        );
        let patch;
        try {
          patch = createPatchFromAgentDiff(captured.snapshot, rawInput);
        } catch (error) {
          throw new PatchInputValidationError(error instanceof Error ? error.message : String(error), error);
        }
        result = await resolveManualPlanFromInput(captured.snapshot, patch, loadedConfig.config);
      }
      const warnings = result.plan.snapshotAuthority === "authoritative" && result.plan.snapshotFreshness === "current"
        ? []
        : ["Diff Plan was created from a persisted observation and is not executable for apply"];
      const suggestedNextCommands = warnings.length > 0
        ? ["Quit Zen, then rerun the list and Diff Plan journey against a current authoritative Snapshot"]
        : [
            `zts apply ${shellQuote(result.plan.id)} --yes --expect-digest ${shellQuote(result.plan.digest)}${options.manageZen ? " --manage-zen" : ""}`,
            `zts plan show ${shellQuote(result.plan.id)} --json`
          ];
      if (options.json) {
        printJson(envelope("diff plan", {
          profile: captured.context.profile,
          captureZenRunning: captured.context.running,
          zenRunning: managedLifecycle.relaunch === "verified" ? true : captured.context.running,
          managedLifecycle,
          ...result
        }, { warnings, suggestedNextCommands }));
      } else {
        process.stdout.write(formatManualPlanSummary(result, warnings, suggestedNextCommands));
      }
    });
  });

program
  .command("patch")
  .description("Plan exact manual tab moves from a Patch JSON file")
  .argument("[action]", "plan or apply")
  .argument("[patch-file]", "Patch JSON path, or - for stdin")
  .option("--yes", "confirm an unattended apply; required for patch apply")
  .option("--expect-digest <digest>", "required exact reviewed Plan digest for patch apply")
  .option("--backend <backend>", "apply route preference: auto, live, or session")
  .option("--json", "print stable JSON output")
  .action(async (action: string | undefined, patchFile: string | undefined, options: JsonOption & { yes?: boolean; expectDigest?: string; backend?: string }) => {
    const selectedAction = action ?? "plan";
    if (selectedAction !== "plan" && selectedAction !== "apply") {
      const message = `unknown patch action '${selectedAction}'`;
      if (options.json) {
        printJson(envelope("patch", { action: selectedAction }, { ok: false, blockers: [message], suggestedNextCommands: ["zts patch plan <patch-file> --json"] }));
      } else {
        process.stderr.write(`zts: ${terminalData(message)}\n`);
      }
      process.exitCode = 1;
      return;
    }

    if (selectedAction === "plan") {
      await runCommand("patch plan", options, async () => {
        if (!patchFile) throw new CliInvocationError("Patch file is required; use - to read JSON from stdin");
        const context = await discoverProfileContext();
        const loadedConfig = await loadConfig();
        const captured = await captureSessionSnapshot(context, loadedConfig.config);
        const snapshot = captured.snapshot;
        const patchInput = await readPatchInput(patchFile);
        const result = await resolveManualPlanFromInput(snapshot, patchInput, loadedConfig.config);
        const warnings = result.plan.snapshotAuthority === "authoritative" && result.plan.snapshotFreshness === "current"
          ? []
          : ["Patch Plan was created from a persisted observation and is not executable for apply"];
        const suggestedNextCommands = warnings.length > 0
          ? ["Quit Zen, then rerun zts snapshot --json and zts patch plan <patch-file> --json"]
          : [
              `zts plan show ${shellQuote(result.plan.id)}`,
              `zts apply ${shellQuote(result.plan.id)}`,
              "zts snapshot --json"
            ];
        if (options.json) {
          printJson(envelope("patch plan", { profile: captured.context.profile, zenRunning: captured.context.running, ...result }, {
            ok: true,
            warnings,
            suggestedNextCommands
          }));
          process.exitCode = 0;
        } else {
          process.stdout.write(formatManualPlanSummary(result, warnings, suggestedNextCommands));
          process.exitCode = 0;
        }
      });
      return;
    }

    if (selectedAction === "apply") {
      await runCommand("patch apply", options, async () => {
        if (!patchFile) throw new CliInvocationError("Patch file is required; use - to read JSON from stdin");
        if (!options.yes) throw new CliInvocationError("Manual Patch apply requires explicit consent with --yes");
        if (!options.expectDigest) throw new CliInvocationError("Manual Patch apply requires --expect-digest from the reviewed Patch Plan");
        const context = await discoverProfileContext();
        const loadedConfig = await loadConfig();
        const routePreference = validatedApplyBackend(options.backend)
          ?? loadedConfig.config.defaults.applyBackend;
        try {
          assertSupportedApplyRoute(routePreference);
        } catch (error) {
          if (!(error instanceof ApplyTransactionSafetyError)) throw error;
          emitApplySafetyBlocker(
            "patch apply",
            options,
            { profile: context.profile, applied: false },
            error,
            "Manual Patch Apply blocked"
          );
          return;
        }
        const captured = await captureSessionSnapshot(context, loadedConfig.config, { requireAuthoritative: true });
        const patchInput = await readPatchInput(patchFile);
        const planned = await resolveManualPlanFromInput(
          captured.snapshot,
          patchInput,
          loadedConfig.config,
          new Date(),
          "require_existing"
        );
        if (planned.plan.digest !== options.expectDigest) {
          throw new CliInvocationError(`Expected Plan digest ${options.expectDigest} does not match reviewed Patch Plan ${planned.plan.digest}`);
        }
        const noChanges = noMutationApplyOutcome(planned.plan);
        if (noChanges) {
          const validated = validateNoMutationApply(
            captured.snapshot,
            planned.plan,
            options.expectDigest,
            loadedConfig.revision
          );
          emitNoMutationApply(
            "patch apply",
            options,
            "Manual Patch Apply",
            {
              profile: context.profile,
              ...planned,
              artifacts: [{ kind: "plan" as const, ...planned.artifact }]
            },
            validated
          );
          return;
        }
        let result: Awaited<ReturnType<typeof applyStoredPlanClosedSession>>;
        try {
          result = await applyStoredPlanClosedSession(context, planned, {
            expectedDigest: options.expectDigest,
            command: patchCommandForReceipt(selectedAction, patchFile, options),
            routePreference
          });
        } catch (error) {
          emitApplyExecutionFailure(
            "patch apply",
            options,
            { profile: context.profile, plan: planned.plan, applied: false },
            error,
            "Manual Patch Apply"
          );
          return;
        }
        emitApplyTransactionOutcome(
          "patch apply",
          options,
          "Manual Patch Apply",
          { profile: context.profile, ...result },
          result
        );
      });
    }
  });

program
  .command("apply")
  .description("Apply an exact saved Plan, or inspect apply receipts")
  .argument("[action]", "latest, Plan id/digest, list, verify, or recover")
  .argument("[selector]", "receipt id for verify, or transaction id for recover")
  .option("--actions <ids>", "comma-separated executable action ids to derive as an exact subset Plan")
  .option("--yes", "confirm unattended application of the exact Plan")
  .option("--expect-digest <digest>", "required exact Plan digest for unattended mutation")
  .option("--expect-recovery-digest <digest>", "required exact inspected recovery revision for recovery finalization")
  .option("--backend <backend>", "apply route preference: auto, live, or session")
  .option("--manage-zen", "separately authorize a bounded graceful Zen quit and exact relaunch when Zen is open")
  .option("--limit <count>", "maximum saved-Plan Receipts to list (default 50, maximum 500)")
  .option("--cursor <cursor>", "opaque saved-Plan Receipt history cursor")
  .option("--json", "print stable JSON output")
  .action(async (action: string | undefined, receiptId: string | undefined, options: JsonOption & ApplyPlanOptions) => {
    const selectedAction = action ?? "list";
    if (selectedAction === "list") {
      await runCommand("apply list", options, async () => {
        const context = await discoverProfileContext();
        const historyLimit = options.limit === undefined ? 50 : Number(options.limit);
        if (!Number.isSafeInteger(historyLimit) || historyLimit < 1 || historyLimit > 500) {
          throw new CliInvocationError("--limit must be an integer between 1 and 500");
        }
        const savedPlanPage = await listTransactionReceiptPage(context.profile.id, {
          limit: historyLimit,
          ...(options.cursor === undefined ? {} : { cursor: options.cursor })
        });
        if (options.json) {
          printJson(envelope("apply list", {
            profile: context.profile,
            receipts: savedPlanPage.receipts,
            history: { kind: "saved_plan", limit: historyLimit, nextCursor: savedPlanPage.nextCursor }
          }, {
            suggestedNextCommands: savedPlanPage.nextCursor
              ? [`zts apply list --limit ${historyLimit} --cursor ${shellQuote(savedPlanPage.nextCursor)} --json`]
              : []
          }));
        } else {
          const next = savedPlanPage.nextCursor
            ? `\nNext page: zts apply list --limit ${historyLimit} --cursor ${shellQuote(savedPlanPage.nextCursor)}\n`
            : "";
          process.stdout.write(`${formatDomainApplyReceiptList(savedPlanPage.receipts)}${next}`);
        }
      });
      return;
    }

    if (options.limit !== undefined || options.cursor !== undefined) {
      await runCommand(`apply ${selectedAction}`, options, async () => {
        throw new CliInvocationError("--limit and --cursor are only valid with zts apply list");
      });
      return;
    }

    if (selectedAction === "verify") {
      await runCommand("apply verify", options, async () => {
        const context = await discoverProfileContext();
        if (!receiptId) throw new CliInvocationError("Apply receipt id is required");
        const validatedReceiptId = validatedApplyReceiptSelector(receiptId);
        let report: TransactionReceiptVerificationReport;
        try {
          report = await verifyTransactionReceipt(context, validatedReceiptId);
        } catch (error) {
          emitCliExecutionFailure(
            "apply verify",
            options,
            { profile: context.profile, receiptId: validatedReceiptId },
            error,
            "Apply Receipt verification",
            cliOutcomeForCommandBoundary(error),
            ["zts apply list --json", "zts apply recover --json", "zts status --json"]
          );
          return;
        }
        const disposition = cliOutcomeForApplyVerification(report.verification.ok);
        if (options.json) {
          printJson(envelope("apply verify", { profile: context.profile, report, outcome: disposition }, {
            ok: disposition.ok,
            blockers: report.verification.blockers
          }));
        } else {
          process.stdout.write(formatDomainApplyVerification(report));
        }
        process.exitCode = disposition.exitCode;
      });
      return;
    }

    if (selectedAction === "recover") {
      await runCommand("apply recover", options, async () => {
        const context = await discoverProfileContext();
        if (!receiptId) {
          const recoveries = await listApplyRecoveryInspections(context);
          const suggestedNextCommands = recoveries.length > 0
            ? [`zts apply recover ${shellQuote(recoveries[0].transactionId)} --json`]
            : ["zts apply list --json"];
          if (options.json) {
            printJson(envelope("apply recover", {
              profile: context.profile,
              recoveries,
              outcome: cliOutcomeForNoMutation(false)
            }, { suggestedNextCommands }));
          } else {
            process.stdout.write(formatApplyRecoveryList(recoveries));
          }
          return;
        }

        if (!options.yes) {
          const inspection = await inspectApplyRecovery(context, receiptId);
          const exactCommand = [
            "zts apply recover",
            shellQuote(inspection.transactionId),
            "--yes",
            "--expect-recovery-digest",
            inspection.recoveryRevision
          ].join(" ");
          if (options.json) {
            printJson(envelope("apply recover", {
              profile: context.profile,
              inspection,
              recoveryRecorded: false,
              sessionMutated: false,
              outcome: cliOutcomeForNoMutation(false)
            }, {
              warnings: [...inspection.blockers],
              suggestedNextCommands: inspection.recoverable ? [`${exactCommand} --json`] : ["zts status --json"]
            }));
          } else {
            process.stdout.write(formatApplyRecoveryInspection(inspection, exactCommand));
          }
          return;
        }

        const readiness = await inspectApplyRecovery(context, receiptId);
        const alreadyComplete = Boolean(readiness.terminalReceipt && readiness.lock.status === "absent");
        const recoveryConsentBlocker = !options.expectRecoveryDigest
          ? "Apply recovery finalization requires --expect-recovery-digest from an exact inspection"
          : options.expectRecoveryDigest !== readiness.recoveryRevision
            ? `Expected recovery digest ${options.expectRecoveryDigest} does not match current inspection ${readiness.recoveryRevision}`
            : null;
        if (recoveryConsentBlocker || (!readiness.recoverable && !alreadyComplete)) {
          const blocker = recoveryConsentBlocker
            ?? readiness.blockers.join("; ")
            ?? "Apply Transaction is not recoverable";
          const data = { profile: context.profile, inspection: readiness, recoveryRecorded: false, sessionMutated: false };
          const outcome = cliOutcomeForRecoveryError(new ApplyRecoveryBlockedError(blocker));
          if (options.json) {
            printJson(envelope("apply recover", { ...data, outcome }, {
              ok: outcome.ok,
              blockers: [blocker],
              suggestedNextCommands: ["zts status --json", "zts apply recover --json"]
            }));
          } else {
            process.stderr.write(`Apply recovery blocked\n- ${terminalData(blocker)}\n`);
          }
          process.exitCode = outcome.exitCode;
          return;
        }
        let result: ApplyRecoveryResult;
        try {
          result = await recoverApplyTransaction(context, receiptId, {
            expectedRecoveryRevision: options.expectRecoveryDigest!,
            ...(process.platform === "darwin"
              ? {
                  managedLifecycle: {
                    platform: createDarwinManagedZenPlatform(),
                    waitOptions: { timeoutMs: 30_000, pollMs: 250 }
                  }
                }
              : {})
          });
        } catch (error) {
          const data = { profile: context.profile, inspection: readiness, recoveryRecorded: false, sessionMutated: false };
          emitRecoveryExecutionFailure("apply recover", options, data, error, receiptId);
          return;
        }
        const outcome = cliOutcomeForRecoveryResult(result);
        const data = { profile: context.profile, ...result, outcome };
        if (options.json) {
          printJson(envelope("apply recover", data, {
            ok: outcome.ok,
            suggestedNextCommands: ["zts apply list --json", `zts apply verify ${shellQuote(result.receipt.id)} --json`]
          }));
        } else {
          process.stdout.write(formatApplyRecoveryResult(result));
        }
        process.exitCode = outcome.exitCode;
      });
      return;
    }

    await runCommand("apply plan", options, async () => {
      if (receiptId) throw new CliInvocationError("Saved Plan apply accepts one Plan selector");
      const context = await discoverProfileContext();
      const original = await loadStoredPlan(context.profile.id, selectedAction);
      if (original.plan.source.kind === "inverse") {
        const outcome = CLI_INVALID_OUTCOME;
        const blocker = "Receipt-bound inverse Plans cannot be applied directly; use zts undo for the source Receipt";
        const suggestedNextCommands = [
          `zts undo ${shellQuote(original.plan.source.sourceReceiptId)} --preview --json`,
          "zts apply list --json"
        ];
        if (options.json) {
          printJson(envelope("apply plan", {
            profile: context.profile,
            plan: original.plan,
            applied: false,
            outcome
          }, { ok: false, blockers: [blocker], suggestedNextCommands }));
        } else {
          process.stderr.write(`Saved Plan Apply rejected\n- ${terminalData(blocker)}\n\nNext:\n${suggestedNextCommands.map((next) => `  ${terminalData(next)}`).join("\n")}\n`);
        }
        process.exitCode = outcome.exitCode;
        return;
      }
      let selected = original;
        const requestedActionIds = splitCsv(options.actions);
      if (options.actions !== undefined) {
        if (requestedActionIds.length === 0) throw new CliInvocationError("--actions requires at least one action id");
        if (options.yes) throw new CliInvocationError("Selected action apply must first derive a subset Plan, then apply that exact Plan id with --yes");
        const loadedConfig = await loadConfig();
        const captured = await captureSessionSnapshot(context, loadedConfig.config, { requireAuthoritative: true });
        selected = await deriveAndStoreSubsetPlan(captured.snapshot, original.plan, requestedActionIds);
      }
      if (options.yes) {
        if (!options.expectDigest) throw new CliInvocationError("Saved Plan apply requires --expect-digest with the exact Plan digest");
        if (options.expectDigest !== selected.plan.digest) {
          throw new CliInvocationError(`Expected Plan digest ${options.expectDigest} does not match selected Plan ${selected.plan.digest}`);
        }
        const routePreference = validatedApplyBackend(options.backend);
        const noChanges = noMutationApplyOutcome(selected.plan);
        if (noChanges) {
          const loadedConfig = await loadConfig();
          try {
            assertSupportedApplyRoute(routePreference ?? loadedConfig.config.defaults.applyBackend);
          } catch (error) {
            if (!(error instanceof ApplyTransactionSafetyError)) throw error;
            emitApplySafetyBlocker(
              "apply plan",
              options,
              { profile: context.profile, plan: selected.plan, applied: false },
              error,
              "Saved Plan Apply blocked"
            );
            return;
          }
          const captured = await captureSessionSnapshot(context, loadedConfig.config, { requireAuthoritative: true });
          const validated = validateNoMutationApply(
            captured.snapshot,
            selected.plan,
            options.expectDigest,
            loadedConfig.revision
          );
          emitNoMutationApply(
            "apply plan",
            options,
            "Saved Plan Apply",
            {
              profile: context.profile,
              snapshot: selected.snapshot,
              originalPlan: original.plan,
              plan: selected.plan,
              requestRevision: selected.requestRevision,
              summary: summarizePlan(selected.plan),
              artifacts: [{ kind: "plan" as const, ...selected.artifact }]
            },
            validated
          );
          return;
        }
        let result: Awaited<ReturnType<typeof applyStoredPlanClosedSession>>;
        try {
          const managedLifecycle = options.manageZen && context.running
            ? await managedLifecycleOptions(context)
            : undefined;
          result = await applyStoredPlanClosedSession(context, selected, {
            expectedDigest: options.expectDigest,
            command: applyPlanCommandForReceipt(selectedAction, options),
            routePreference,
            ...(managedLifecycle ? { managedLifecycle } : {})
          });
        } catch (error) {
          emitApplyExecutionFailure(
            "apply plan",
            options,
            { profile: context.profile, plan: selected.plan, applied: false },
            error,
            "Saved Plan Apply"
          );
          return;
        }
        const data = {
          profile: context.profile,
          originalPlan: original.plan,
          plan: result.plan,
          authorization: result.authorization,
          receipt: result.receipt,
          receiptPath: result.receiptPath,
          summary: result.summary,
          artifacts: result.artifacts,
          applied: result.applied,
          terminalCleanupRequired: result.terminalCleanupRequired
        };
        emitApplyTransactionOutcome("apply plan", options, "Saved Plan Apply", data, result);
        return;
      }
      const exactCommand = [
        `zts apply ${shellQuote(selected.plan.id)} --yes --expect-digest ${selected.plan.digest}`,
        ...(options.manageZen ? ["--manage-zen"] : [])
      ].join(" ");
      const blocker = selected.plan.derivation.kind === "subset"
        ? `Review and confirm the exact derived Plan ${selected.plan.digest} before mutation`
        : `Confirm the exact saved Plan ${selected.plan.digest} before mutation`;
      const data = {
        profile: context.profile,
        snapshot: selected.snapshot,
        originalPlan: original.plan,
        plan: selected.plan,
        requestRevision: selected.requestRevision,
        artifacts: [{ kind: "plan", ...selected.artifact }],
        applied: false,
        outcome: cliOutcomeForNoMutation(true)
      };
      if (options.json) {
        printJson(envelope("apply plan", data, {
          ok: false,
          blockers: [blocker],
          suggestedNextCommands: [`${exactCommand} --json`, "zts plan show latest --json"]
        }));
      } else {
        process.stdout.write(`${formatSavedPlan(selected.snapshot, selected.plan, false)}\n${blocker}\n\nNext:\n  ${exactCommand}\n`);
      }
      process.exitCode = 2;
    });
  });

program
  .command("undo")
  .description("Preview or apply the exact inverse of an eligible Apply Receipt")
  .argument("[receipt]", "source Apply Receipt id, or latest")
  .option("--preview", "explicitly inspect the exact Undo Plan without writing")
  .option("--yes", "confirm application of the exact reviewed Undo Plan")
  .option("--expect-digest <digest>", "required exact reviewed Undo Plan digest")
  .option("--accept-unrelated-drift", "rebind the exact inverse to current state after every affected Operation still validates")
  .option("--backend <backend>", "apply route preference: auto, live, or session")
  .option("--json", "print stable JSON output")
  .action(async (receipt: string | undefined, options: JsonOption & UndoOptions) => {
    await runCommand("undo", options, async () => {
      if (options.preview && options.yes) throw new CliInvocationError("Undo --preview cannot be combined with --yes");
      if (options.expectDigest && !options.yes) throw new CliInvocationError("Undo --expect-digest requires --yes");
      if (options.yes && !options.expectDigest) {
        throw new CliInvocationError("Undo apply requires --yes and --expect-digest from the exact preview");
      }
      const selector = validatedUndoSelector(receipt ?? "latest");
      const routePreference = validatedApplyBackend(options.backend);
      const context = await discoverProfileContext();
      const loadedConfig = await loadConfig();
      let inspection: UndoInspection;
      try {
        inspection = await inspectUndo(context, loadedConfig.config, selector, new Date(), {
          acceptUnrelatedDrift: options.acceptUnrelatedDrift
        });
      } catch (error) {
        if (error instanceof UndoSelectionError) {
          const outcome = error.code === "UNDO_NOT_FOUND"
            ? CLI_INVALID_OUTCOME
            : cliOutcomeForNoMutation(true);
          emitCliExecutionFailure(
            "undo",
            options,
            { profile: context.profile, selector },
            error,
            "Undo",
            outcome,
            ["zts apply list --json", "zts history list --json", "zts status --json"]
          );
          return;
        }
        emitApplyExecutionFailure(
          "undo",
          options,
          { profile: context.profile, selector },
          error,
          "Undo"
        );
        return;
      }
      if (!inspection.eligible || !inspection.undoPlan) {
        const outcome = cliOutcomeForNoMutation(true);
        const data = { profile: context.profile, inspection, applied: false, outcome };
        if (options.json) {
          printJson(envelope("undo", data, {
            ok: outcome.ok,
            blockers: [...inspection.blockers],
            suggestedNextCommands: inspection.drift.detected && !inspection.drift.acceptUnrelatedDriftRequested
              ? [
                  `zts undo ${shellQuote(inspection.sourceReceipt.id)} --preview --accept-unrelated-drift --json`,
                  "zts status --json"
                ]
              : ["zts status --json", "zts apply list --json"]
          }));
        } else {
          process.stderr.write(formatUndoInspection(inspection, null));
        }
        process.exitCode = outcome.exitCode;
        return;
      }
      const exactCommand = undoApplyCommand(inspection, options);
      if (!options.yes) {
        const explicitPreview = Boolean(options.preview);
        const outcome = cliOutcomeForNoMutation(!explicitPreview);
        const blocker = explicitPreview ? null : "Review and confirm the exact Undo Plan before mutation";
        if (options.json) {
          printJson(envelope("undo", {
            profile: context.profile,
            inspection,
            applied: false,
            outcome
          }, {
            ok: outcome.ok,
            blockers: blocker ? [blocker] : [],
            suggestedNextCommands: [exactCommand + " --json"]
          }));
        } else {
          process.stdout.write(formatUndoInspection(inspection, exactCommand));
        }
        process.exitCode = outcome.exitCode;
        return;
      }
      if (options.expectDigest !== inspection.undoPlan.digest) {
        throw new CliInvocationError(
          `Expected Undo Plan digest ${options.expectDigest} does not match reviewed Plan ${inspection.undoPlan.digest}`
        );
      }
      let applied;
      try {
        applied = await applyUndo(
          context,
          loadedConfig.config,
          selector,
          options.expectDigest,
          exactCommand,
          routePreference,
          new Date(),
          { acceptUnrelatedDrift: options.acceptUnrelatedDrift }
        );
      } catch (error) {
        if (error instanceof UndoBlockedError) {
          const outcome = cliOutcomeForNoMutation(true);
          emitCliExecutionFailure(
            "undo",
            options,
            { profile: context.profile, inspection: error.inspection, applied: false },
            error,
            "Undo",
            outcome,
            ["zts undo --preview --json", "zts status --json"]
          );
          return;
        }
        emitApplyExecutionFailure(
          "undo",
          options,
          { profile: context.profile, inspection, applied: false },
          error,
          "Undo"
        );
        return;
      }
      emitApplyTransactionOutcome(
        "undo",
        options,
        "Undo",
        {
          profile: context.profile,
          sourceReceipt: inspection.sourceReceipt,
          undoPlan: inspection.undoPlan,
          detachedPlanArtifact: applied.detachedPlan.artifact,
          ...applied.transaction
        },
        applied.transaction
      );
    });
  });

program
  .command("history")
  .description("List durable Apply Receipts or retain the bounded private Apply store")
  .argument("[action]", "list or retain")
  .option("--limit <count>", "maximum Receipt summaries to list")
  .option("--cursor <cursor>", "authenticated history continuation cursor")
  .option("--apply", "apply the exact retention inspection instead of previewing")
  .option("--yes", "confirm retention payload deletion; requires --apply")
  .option("--expect-inspection-revision <digest>", "required exact retention preview revision")
  .option("--json", "print stable JSON output")
  .action(async (action: string | undefined, options: JsonOption & HistoryOptions) => {
    const selectedAction = action ?? "list";
    if (selectedAction === "list") {
      await runCommand("history list", options, async () => {
        if (options.apply || options.yes || options.expectInspectionRevision) {
          throw new CliInvocationError("History list does not accept retention mutation flags");
        }
        const context = await discoverProfileContext();
        const limit = historyLimit(options.limit);
        const page = await listTransactionReceiptPage(context.profile.id, {
          limit,
          ...(options.cursor ? { cursor: options.cursor } : {})
        });
        const data = { profile: context.profile, ...page };
        if (options.json) {
          printJson(envelope("history list", data, {
            warnings: page.receipts.some((receipt) => receipt.fullReceiptAvailability === "archived_summary_only")
              ? ["Some full Receipts are archived; their bounded durable summaries remain truthful but verify and undo are unavailable"]
              : [],
            suggestedNextCommands: ["zts history retain --json", "zts apply recover --json"]
          }));
        } else {
          process.stdout.write(formatHistoryList(page));
        }
      });
      return;
    }
    if (selectedAction !== "retain") {
      await runCommand("history", options, async () => {
        throw new CliInvocationError(`Unknown history action '${selectedAction}'; use list or retain`);
      });
      return;
    }
    await runCommand("history retain", options, async () => {
      if (options.yes && !options.apply) throw new CliInvocationError("--yes requires --apply");
      if (options.apply && !options.yes) throw new CliInvocationError("History retention apply requires explicit consent with --apply --yes");
      if (options.apply && !options.expectInspectionRevision) {
        throw new CliInvocationError("History retention apply requires --expect-inspection-revision from a reviewed preview");
      }
      if (options.expectInspectionRevision && !options.apply) {
        throw new CliInvocationError("--expect-inspection-revision requires --apply");
      }
      const context = await discoverProfileContext();
      if (!options.apply) {
        const inspection = await inspectApplyStoreRetention(context.profile.id);
        const data = { profile: context.profile, inspection, applied: false };
        const next = `zts history retain --apply --yes --expect-inspection-revision ${inspection.inspectionRevision}`;
        if (options.json) {
          printJson(envelope("history retain", data, {
            ok: inspection.blockers.length === 0,
            blockers: [...inspection.blockers],
            suggestedNextCommands: inspection.blockers.length === 0
              || inspection.action === "reconcile_publication_residue"
              ? [`${next} --json`]
              : ["zts apply recover --json"]
          }));
        } else {
          process.stdout.write(formatHistoryRetentionInspection(inspection, next));
        }
        if (inspection.blockers.length > 0) process.exitCode = 2;
        return;
      }
      try {
        const layout = await readApplyArtifactLayout(context.profile.id);
        await ensureApplyReceiptSummaryHistory(layout, context.profile.id);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      try {
        const result = await applyApplyStoreRetention(context.profile.id, {
          expectedInspectionRevision: options.expectInspectionRevision!,
          destructiveConsent: APPLY_RETENTION_DESTRUCTIVE_CONSENT
        });
        if (options.json) {
          printJson(envelope("history retain", { profile: context.profile, result, applied: true }, {
            suggestedNextCommands: ["zts history list --json", "zts history retain --json"]
          }));
        } else {
          process.stdout.write(formatHistoryRetentionResult(result));
        }
      } catch (error) {
        if (!(error instanceof ApplyRetentionBlockedError)) throw error;
        const data = { profile: context.profile, inspection: error.inspection, applied: false };
        if (options.json) {
          printJson(envelope("history retain", data, {
            ok: false,
            blockers: [...error.inspection.blockers],
            suggestedNextCommands: ["zts apply recover --json", "zts history retain --json"]
          }));
        } else {
          process.stderr.write(formatHistoryRetentionInspection(error.inspection, null));
        }
        process.exitCode = 2;
      }
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
        const preview = await previewBackupRestore(context, backupId);
        const blockers = [preview.blocker];
        const suggestedNextCommands = ["zts backup list", "zts status"];
        if (options.json) {
          printJson(envelope("backup restore", { profile: context.profile, preview }, {
            ok: false,
            blockers,
            suggestedNextCommands
          }));
        } else {
          process.stderr.write(`${[
            `Restore preview for ${preview.backupId}`,
            ...preview.files.map((file) => `  - ${file.source} (${file.size} bytes, verified backup)`),
            "",
            `Blocked: ${preview.blocker}`
          ].join("\n")}\n`);
        }
        process.exitCode = 2;
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
        process.stderr.write(`zts: ${terminalData(message)}\n`);
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
  .description("Show attention items from one exact saved Plan")
  .argument("[plan-selector]", "latest, Plan id, or Plan digest", "latest")
  .option("--json", "print stable JSON output")
  .action(async (planSelector: string, options: JsonOption) => {
    await runCommand("review", options, async () => {
      const context = await discoverProfileContext();
      const stored = await loadStoredPlan(context.profile.id, planSelector);
      const attentionActions = stored.plan.actions.filter((action) =>
        action.disposition === "review"
        || action.disposition === "protected"
        || action.disposition === "blocked"
      );
      const summary = summarizePlan(stored.plan);
      const data = {
        profile: context.profile,
        selector: planSelector,
        snapshot: stored.snapshot,
        plan: stored.plan,
        requestRevision: stored.requestRevision,
        summary,
        attentionActions,
        artifacts: [{ kind: "plan", ...stored.artifact }]
      };
      const suggestedNextCommands = attentionActions.length > 0
        ? [`zts plan show ${shellQuote(stored.plan.id)}`, "zts rules test <url-or-domain>", "zts rules add domain <domain> <workspace>"]
        : [`zts plan show ${shellQuote(stored.plan.id)}`];

      if (options.json) {
        printJson(envelope("review", data, { suggestedNextCommands }));
      } else {
        process.stdout.write(formatCanonicalReview(stored.snapshot, stored.plan, summary, suggestedNextCommands));
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
  .option("--expect-digest <digest>", "required exact reviewed Plan digest for apply")
  .option("--min-confidence <number>", "minimum confidence required for future apply")
  .option("--include-pinned", "include pinned tabs with an explicit Protection grant")
  .option("--no-include-pinned", "keep pinned tabs protected even when config includes them")
  .option("--include-essentials", "include essentials with an explicit Protection grant")
  .option("--no-include-essentials", "keep essentials protected even when config includes them")
  .option("--to <workspaces>", "comma-separated destination workspace allowlist")
  .option("--not-to <workspaces>", "comma-separated destination workspace denylist")
  .option("--only <patterns>", "comma-separated source URL/domain patterns")
  .option("--except <patterns>", "comma-separated exclusion URL/domain patterns")
  .option("--limit <count>", "maximum number of move actions to plan or apply")
  .option("--backend <backend>", "backend preference: auto, live, or session")
  .option("--json", "print stable JSON output")
  .action(async (sourceWorkspace: string | undefined, options: JsonOption & SortOptions) => {
    await runCommand("sort", options, async () => {
      const discoveredContext = await discoverProfileContext();
      const loadedConfig = await loadConfig();
      const captured = await captureSessionSnapshot(discoveredContext, loadedConfig.config);
      const context = captured.context;
      const summary = captured.summary;
      const sourceResolution = resolveSourceWorkspace(summary, sourceWorkspace, loadedConfig.config.defaults.inbox);
      const source = sourceResolution.status === "resolved" ? sourceResolution.workspace : null;
      const selectedEngine = normalizeEngine(options.engine);
      const inputs = sortInputs(options, loadedConfig.config, selectedEngine);
      const inputError = validateSortMode(options, sourceWorkspace)
        ?? validateSortInputs(inputs)
        ?? (options.minConfidence !== undefined && selectedEngine === "rules"
          ? "--min-confidence applies only to confidence-producing lexical, semantic, or hybrid Engines; exact rules have no confidence threshold"
          : null)
        ?? (selectedEngine === "invalid"
          ? `Unknown Engine '${options.engine}'; expected rules, lexical, bge-small, or hybrid`
          : selectedEngine === "bge_small" || selectedEngine === "hybrid"
            ? `Engine '${options.engine}' is not installed in the production planner yet; explicit Engine selection never falls back`
            : null);
      if (inputError) {
        if (options.json) {
          printJson(envelope("sort", { sourceWorkspace: sourceWorkspace ?? null, inputs }, { ok: false, blockers: [inputError], suggestedNextCommands: ["zts sort --help"] }));
        } else {
          process.stderr.write(`zts: ${terminalData(inputError)}\n`);
        }
        process.exitCode = 1;
        return;
      }
      if (!source && !options.all) {
        const selector = sourceWorkspace ?? loadedConfig.config.defaults.inbox;
        const message = sourceResolution.status === "ambiguous"
          ? ambiguousWorkspaceMessage(selector, sourceResolution.matches)
          : sourceWorkspace
            ? `Source workspace not found: ${sourceWorkspace}`
            : "No source workspace could be resolved";
        const suggestedNextCommands = ["zts workspaces", "zts sort --preview"];
        if (options.json) {
          printJson(envelope("sort", { sourceWorkspace: sourceWorkspace ?? null, inputs }, { ok: false, blockers: [message], suggestedNextCommands }));
        } else {
          process.stderr.write(`zts: ${terminalData(message)}\n`);
        }
        process.exitCode = 1;
        return;
      }

      {
        const sourceScope = options.all
          ? { kind: "all_workspaces" as const }
          : { kind: "workspace" as const, workspaceId: source!.id, workspaceName: source!.name };
        const mode = options.apply ? "apply" : options.dryRun ? "dry-run" : "preview";
        let result: DailySortPlanResult;
        try {
          result = await planDailySort(captured.snapshot, loadedConfig.config, {
            scope: sourceScope.kind === "all_workspaces"
              ? sourceScope
              : { kind: "workspace", workspaceId: sourceScope.workspaceId },
            engine: selectedEngine === "lexical" ? "lexical" : "rules",
            destinationAllowlist: inputs.to,
            destinationDenylist: inputs.notTo,
            only: inputs.only,
            except: inputs.except,
            limit: inputs.limit,
            includePinned: inputs.includePinned,
            includeEssentials: inputs.includeEssentials,
            suggestionThreshold: inputs.minConfidence,
            minimumMargin: loadedConfig.config.semantic.minimumMargin,
            // Explicit CLI apply is authorized separately by exact Plan digest.
            // Automatic-apply intent is reserved for the future configured
            // quick-sort policy and must not split preview/apply Plan identity.
            autoApplyRequested: false,
            planMode: mode === "preview"
              ? "create_or_reuse"
              : mode === "dry-run"
                ? "create_if_missing_require_existing_state"
                : "require_existing"
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
            process.stderr.write(`Sort ${mode} blocked\n- ${terminalData(error.message)}\n\nNext:\n${suggestedNextCommands.map((command) => `  ${terminalData(command)}`).join("\n")}\n`);
          }
          process.exitCode = 2;
          return;
        }
        if (options.apply && options.expectDigest !== result.plan.digest) {
          throw new CliInvocationError(
            `Expected Plan digest ${options.expectDigest} does not match reviewed Sort Plan ${result.plan.digest}`
          );
        }
        if (options.apply) {
          try {
            assertSupportedApplyRoute(inputs.backend);
          } catch (error) {
            if (!(error instanceof ApplyTransactionSafetyError)) throw error;
            emitApplySafetyBlocker(
              "sort",
              options,
              {
                profile: context.profile,
                sourceScope,
                engine: selectedEngine,
                mode,
                plan: result.plan,
                applied: false
              },
              error,
              "Sort apply blocked"
            );
            return;
          }
        }
        if (options.apply && result.summary.moveCount > 0) {
          let applied: Awaited<ReturnType<typeof applyStoredPlanClosedSession>>;
          try {
            applied = await applyStoredPlanClosedSession(context, result, {
              expectedDigest: options.expectDigest!,
              command: sortCommandForReceipt(sourceWorkspace, options),
              routePreference: inputs.backend
            });
          } catch (error) {
            emitApplyExecutionFailure(
              "sort",
              options,
              {
                profile: context.profile,
                sourceScope,
                engine: selectedEngine,
                mode,
                plan: result.plan,
                applied: false
              },
              error,
              "Sort apply"
            );
            return;
          }
          emitApplyTransactionOutcome(
            "sort",
            options,
            "Sort apply",
            {
              profile: context.profile,
              sourceScope,
              engine: selectedEngine,
              mode,
              planResolution: result.planResolution,
              requestRevision: result.requestRevision,
              ...applied
            },
            applied
          );
          return;
        }
        let applyState = options.apply ? noMutationApplyOutcome(result.plan) : null;
        if (options.apply && !applyState) {
          throw new Error("Sort Plan summary disagrees with its executable Operations");
        }
        if (applyState) {
          let current;
          try {
            current = await captureSessionSnapshot(context, loadedConfig.config, { requireAuthoritative: true });
          } catch (error) {
            emitApplySafetyBlocker(
              "sort",
              options,
              {
                profile: context.profile,
                sourceScope,
                engine: selectedEngine,
                mode,
                plan: result.plan,
                applied: false
              },
              new ApplyTransactionSafetyError(error instanceof Error ? error.message : String(error)),
              "Sort apply blocked"
            );
            return;
          }
          applyState = validateNoMutationApply(
            current.snapshot,
            result.plan,
            options.expectDigest!,
            loadedConfig.revision
          );
        }
        const warnings = [
          ...(result.snapshot.authority === "persisted_observation"
            ? ["Zen is running; this Plan is based on a persisted observation and cannot be authorized for apply"]
            : []),
          ...(selectedEngine === "lexical"
            ? ["Lexical suggestions are uncalibrated and never auto-apply; explicitly review and authorize the exact saved Plan or subset"]
            : [])
        ];
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
          ...(applyState ?? { applied: false as const, applyOutcome: "not_requested" as const })
        };
        if (applyState) {
          emitNoMutationApply("sort", options, "Sort apply", data, applyState);
          return;
        }
        if (options.json) {
          printJson(envelope("sort", data, {
            warnings,
            suggestedNextCommands
          }));
        } else {
          process.stdout.write(formatDailySortPlan(result, sourceScope, mode, warnings, [], suggestedNextCommands));
        }
        process.exitCode = 0;
        return;
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
  expectDigest?: string;
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

interface UndoOptions {
  preview?: boolean;
  yes?: boolean;
  expectDigest?: string;
  acceptUnrelatedDrift?: boolean;
  backend?: string;
}

interface SortInputs {
  readonly preview: boolean;
  readonly dryRun: boolean;
  readonly minConfidence: number;
  readonly includePinned: boolean;
  readonly includeEssentials: boolean;
  readonly to: string[];
  readonly notTo: string[];
  readonly only: string[];
  readonly except: string[];
  readonly limit: number | null;
  readonly backend: "auto" | "live" | "session";
  readonly domainRules: Record<string, string>;
  readonly protectedDomains: string[];
}

interface ApplyPlanOptions {
  actions?: string;
  yes?: boolean;
  expectDigest?: string;
  expectRecoveryDigest?: string;
  limit?: string;
  cursor?: string;
  backend?: string;
  manageZen?: boolean;
}

interface BackupOptions {
  before?: string;
  olderThan?: string;
  dryRun?: boolean;
}

interface HistoryOptions {
  limit?: string;
  cursor?: string;
  apply?: boolean;
  yes?: boolean;
  expectInspectionRevision?: Sha256Digest;
}

interface BridgeOptions {
  timeoutMs?: string;
  connect?: boolean;
}

function sortCommandForReceipt(sourceWorkspace: string | undefined, options: SortOptions): string {
  const parts = ["zts", "sort"];
  if (!options.all && sourceWorkspace) parts.push(shellQuote(sourceWorkspace));
  appendSortIntentFlags(parts, options);
  if (options.apply) parts.push("--apply");
  if (options.yes) parts.push("--yes");
  if (options.expectDigest) parts.push("--expect-digest", options.expectDigest);
  return parts.join(" ");
}

function appendSortIntentFlags(parts: string[], options: SortOptions): void {
  if (options.all) parts.push("--all");
  if (options.engine) parts.push("--engine", shellQuote(options.engine));
  if (options.backend) parts.push("--backend", shellQuote(options.backend));
  if (options.minConfidence) parts.push("--min-confidence", shellQuote(options.minConfidence));
  if (options.to) parts.push("--to", shellQuote(options.to));
  if (options.notTo) parts.push("--not-to", shellQuote(options.notTo));
  if (options.only) parts.push("--only", shellQuote(options.only));
  if (options.except) parts.push("--except", shellQuote(options.except));
  if (options.limit) parts.push("--limit", shellQuote(options.limit));
  appendProtectionOverrides(parts, options);
}

function appendProtectionOverrides(parts: string[], options: SortOptions): void {
  if (options.includePinned === true) parts.push("--include-pinned");
  if (options.includePinned === false) parts.push("--no-include-pinned");
  if (options.includeEssentials === true) parts.push("--include-essentials");
  if (options.includeEssentials === false) parts.push("--no-include-essentials");
}

function backupPruneCommand(options: BackupOptions): string {
  const parts = ["zts", "backup", "prune"];
  if (options.before) parts.push("--before", options.before);
  if (options.olderThan) parts.push("--older-than", options.olderThan);
  if (options.dryRun) parts.push("--dry-run");
  return parts.join(" ");
}

function patchCommandForReceipt(
  action: string,
  patchFile: string,
  options: { yes?: boolean; json?: boolean; backend?: string }
): string {
  const parts = ["zts", "patch", action, patchFile];
  if (options.yes) parts.push("--yes");
  if (options.backend) parts.push("--backend", options.backend);
  if (options.json) parts.push("--json");
  return parts.join(" ");
}

function applyPlanCommandForReceipt(selector: string, options: ApplyPlanOptions): string {
  const parts = ["zts", "apply", shellQuote(selector)];
  if (options.yes) parts.push("--yes");
  if (options.expectDigest) parts.push("--expect-digest", options.expectDigest);
  if (options.backend) parts.push("--backend", options.backend);
  if (options.manageZen) parts.push("--manage-zen");
  return parts.join(" ");
}

async function managedLifecycleOptions(context: Awaited<ReturnType<typeof discoverProfileContext>>) {
  const platform = createDarwinManagedZenPlatform();
  const request = await discoverDarwinManagedZenRequest(platform, context.profile.path);
  return {
    platform,
    request,
    waitOptions: { timeoutMs: 30_000, pollMs: 250 }
  } as const;
}

function pruneCutoff(options: BackupOptions): Date {
  if (options.before && options.olderThan) {
    throw new CliInvocationError("Use only one prune selector: --before or --older-than");
  }
  if (options.before) {
    const before = new Date(options.before);
    if (!Number.isFinite(before.getTime())) throw new CliInvocationError("--before must be a valid ISO date");
    return before;
  }
  if (options.olderThan) {
    return new Date(Date.now() - parseDurationMs(options.olderThan));
  }
  throw new CliInvocationError("Backup prune requires --before <iso-date> or --older-than <duration>");
}

function parseDurationMs(value: string): number {
  const match = /^(\d+)(m|h|d)$/.exec(value.trim());
  if (!match) throw new CliInvocationError("--older-than must use a duration such as 30d, 12h, or 45m");
  const amount = Number(match[1]);
  if (amount <= 0) throw new CliInvocationError("--older-than must be greater than zero");
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
    throw new CliInvocationError("--timeout-ms must be a whole number between 1000 and 30000");
  }
  return parsed;
}

function historyLimit(value?: string): number {
  if (value === undefined) return 50;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 500) {
    throw new CliInvocationError("History --limit must be a whole number between 1 and 500");
  }
  return parsed;
}

try {
  await program.parseAsync(process.argv);
} catch (error) {
  if (error instanceof CommanderError) {
    if (error.code !== "commander.helpDisplayed" && error.code !== "commander.version" && jsonDocumentModeRequested()) {
      const message = error.message.replace(/^error:\s*/u, "");
      printJson(envelope(parserCommandName(), { error: message, outcome: CLI_INVALID_OUTCOME }, { ok: false, blockers: [message] }));
    }
    process.exitCode = error.exitCode;
  } else {
    const message = error instanceof Error ? error.message : String(error);
    const outcome = cliOutcomeForCommandBoundary(error);
    if (jsonDocumentModeRequested()) {
      printJson(envelope(parserCommandName(), { error: message, outcome }, { ok: false, blockers: [message] }));
    } else {
      process.stderr.write(`zts: ${terminalData(message)}\n`);
    }
    process.exitCode = outcome.exitCode;
  }
}

async function runCommand(command: string, options: JsonOption, action: () => Promise<void>): Promise<void> {
  // Commander can consume a following option-looking token as the value of a
  // required option (for example `--limit --json`). The raw argv occurrence is
  // still an explicit output-protocol request, so make it authoritative before
  // any action-level validation emits output.
  if (jsonDocumentModeRequested()) options.json = true;
  try {
    await action();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const outcome = cliOutcomeForCommandBoundary(error);
    if (options.json) {
      printJson(envelope(command, { error: message, outcome }, { ok: false, blockers: [message] }));
    } else {
      process.stderr.write(`zts: ${terminalData(message)}\n`);
    }
    process.exitCode = outcome.exitCode;
  }
}

function cliOutcomeForCommandBoundary(error: unknown): CliOutcome {
  if (error instanceof CliInvocationError
    || error instanceof ConfigValidationError
    || error instanceof ConfigPermissionsError
    || error instanceof PatchInputValidationError
    || error instanceof ApplyReceiptSelectionError
    || error instanceof ApplyReceiptCursorError
    || error instanceof BackupSelectionError) {
    return CLI_INVALID_OUTCOME;
  }
  if (error instanceof ConfigChangedError) return CLI_BLOCKED_OUTCOME;
  if (error instanceof ApplyReceiptHistoryCorruptionError) return CLI_INTERNAL_ERROR_OUTCOME;
  if (isNodeSystemError(error)) return CLI_INTERNAL_ERROR_OUTCOME;
  const applyOutcome = cliOutcomeForApplyExecutionError(error);
  return applyOutcome;
}

function isNodeSystemError(error: unknown): boolean {
  return error instanceof Error
    && typeof (error as NodeJS.ErrnoException).code === "string";
}

function emitApplySafetyBlocker<T>(
  command: string,
  options: JsonOption,
  data: T,
  error: ApplyTransactionSafetyError,
  humanHeading: string
): void {
  const outcome = cliOutcomeForApplyExecutionError(error);
  const liveRouteUnavailable = /production live mutation is unavailable/iu.test(error.message);
  const suggestedNextCommands = liveRouteUnavailable
    ? ["zts status --json", "zts bridge status --json"]
    : ["zts apply recover --json", "zts status --json"];
  if (options.json) {
    printJson(envelope(command, { ...data, outcome }, {
      ok: outcome.ok,
      blockers: [error.message],
      suggestedNextCommands
    }));
  } else {
    process.stderr.write(`${humanHeading}\n- ${terminalData(error.message)}\n`);
  }
  process.exitCode = outcome.exitCode;
}

function emitApplyExecutionFailure<T>(
  command: string,
  options: JsonOption,
  data: T,
  error: unknown,
  humanTitle: string
): void {
  emitCliExecutionFailure(
    command,
    options,
    data,
    error,
    humanTitle,
    cliOutcomeForApplyExecutionError(error),
    ["zts apply recover --json", "zts status --json", "zts apply list --json"]
  );
}

function emitRecoveryExecutionFailure<T>(
  command: string,
  options: JsonOption,
  data: T,
  error: unknown,
  selector: string
): void {
  emitCliExecutionFailure(
    command,
    options,
    data,
    error,
    "Apply recovery",
    cliOutcomeForRecoveryError(error),
    [`zts apply recover ${shellQuote(selector)} --json`, "zts apply recover --json", "zts status --json"]
  );
}

function emitCliExecutionFailure<T>(
  command: string,
  options: JsonOption,
  data: T,
  error: unknown,
  humanTitle: string,
  disposition: CliOutcome,
  failureNextCommands: readonly string[]
): void {
  const message = error instanceof Error ? error.message : String(error);
  const suggestedNextCommands = [...failureNextCommands];
  if (options.json) {
    printJson(envelope(command, {
      ...data,
      outcome: disposition,
      error: message
    }, {
      ok: false,
      blockers: [message],
      suggestedNextCommands
    }));
  } else {
    const state = disposition.status === "blocked"
      ? "blocked before mutation"
      : disposition.status === "failed"
        ? "interrupted with uncertain transaction state"
        : "failed unexpectedly";
    process.stderr.write(`${humanTitle} ${state}\n- ${terminalData(message)}\n\nNext:\n${suggestedNextCommands.map((next) => `  ${terminalData(next)}`).join("\n")}\n`);
  }
  process.exitCode = disposition.exitCode;
}

function emitApplyTransactionOutcome<T>(
  command: string,
  options: JsonOption,
  humanTitle: string,
  data: T,
  result: ApplyTransactionOutcome
): void {
  const disposition = cliOutcomeForApplyTransaction(result);
  const blocker = result.applied ? null : result.blocker;
  const verifyCommand = `zts apply verify ${shellQuote(result.receipt.id)} --json`;
  const undoCommand = result.applied && result.plan.source.kind !== "inverse"
    ? `zts undo ${shellQuote(result.receipt.id)} --preview`
    : null;
  const suggestedNextCommands = disposition.status === "succeeded"
    ? [
        ...(result.terminalCleanupRequired ? ["zts apply recover --json"] : []),
        ...(undoCommand ? [undoCommand] : []),
        verifyCommand,
        "zts apply list --json"
      ]
    : disposition.status === "blocked"
      ? [verifyCommand, "zts apply list --json", "zts status --json"]
      : [
          ...(result.terminalCleanupRequired ? ["zts apply recover --json"] : []),
          verifyCommand,
          "zts status --json",
          "zts apply list --json"
        ];
  const warnings = result.terminalCleanupRequired
    ? ["The terminal unfinished marker still requires idempotent recovery cleanup"]
    : [];
  if (options.json) {
    printJson(envelope(command, {
      ...data,
      outcome: disposition
    }, {
      ok: disposition.ok,
      warnings,
      blockers: blocker ? [blocker] : [],
      suggestedNextCommands
    }));
  } else if (result.applied) {
    process.stdout.write(formatSavedPlanApply(result, humanTitle, warnings, suggestedNextCommands));
  } else {
    const state = disposition.status === "blocked"
      ? "blocked before mutation"
      : `did not complete as applied (${terminalData(result.receipt.outcome)})`;
    process.stderr.write(`${humanTitle} ${state}\n- ${terminalData(result.blocker)}\nReceipt: ${terminalData(result.receipt.id)}\n\nNext:\n${suggestedNextCommands.map((next) => `  ${terminalData(next)}`).join("\n")}\n`);
  }
  process.exitCode = disposition.exitCode;
}

function jsonDocumentModeRequested(): boolean {
  return process.argv.slice(2).includes("--json");
}

function parserCommandName(): string {
  return process.argv.slice(2).find((part) => !part.startsWith("-")) ?? "zts";
}

function statusEnvelopeOptions(zenRunning: boolean, bridgeBlockers: string[]) {
  const blockers = zenRunning
    ? ["Offline apply is blocked because Zen is running", ...bridgeBlockers]
    : [];
  return {
    warnings: [
      "Process absence is not mutation authority; closed-session readiness is established only inside Apply Transaction",
      ...(zenRunning
        ? ["Session state is a persisted disk observation and may be stale while Zen is running"]
        : ["Status does not establish Snapshot authority; controlled Snapshot capture and Apply perform that check"]),
      ...(!zenRunning ? bridgeBlockers.map((blocker) => `Live backend: ${blocker}`) : [])
    ],
    blockers,
    suggestedNextCommands: ["zts workspaces", "zts bridge status", "zts sort --preview"]
  };
}

function snapshotObservationPresentation(snapshot: Snapshot, zenRunning: boolean) {
  return {
    zenRunning,
    authority: snapshot.authority,
    freshness: snapshot.freshness
  } as const;
}

function snapshotObservationWarnings(
  observation: ReturnType<typeof snapshotObservationPresentation>
): string[] {
  return observation.authority === "persisted_observation" || observation.freshness !== "current"
    ? [
        `Snapshot is a persisted observation and may be stale${observation.zenRunning ? " while Zen is running" : ""}; mutation requires a fresh authoritative Snapshot`
      ]
    : [];
}

function resolveSourceWorkspace(summary: Awaited<ReturnType<typeof loadSessionSummary>>, input: string | undefined, defaultInbox: string) {
  const lookup = input ?? defaultInbox;
  if (!lookup) {
    const first = summary.workspaces[0];
    return first
      ? { status: "resolved" as const, workspace: first }
      : { status: "missing" as const };
  }
  return resolveWorkspaceSelector(summary.workspaces, lookup);
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

function sortInputs(
  options: SortOptions,
  config: ZtsConfig,
  engine: ReturnType<typeof normalizeEngine>
): SortInputs {
  const statisticalEngine = engine === "lexical" || engine === "bge_small" || engine === "hybrid";
  return {
    preview: Boolean(options.preview),
    dryRun: Boolean(options.dryRun),
    minConfidence: options.minConfidence === undefined
      ? statisticalEngine
        ? config.semantic.suggestionThreshold
        : config.defaults.minConfidence
      : Number(options.minConfidence),
    includePinned: options.includePinned ?? config.defaults.includePinned,
    includeEssentials: options.includeEssentials ?? config.defaults.includeEssentials,
    to: csvOption(options.to, config.sort.to),
    notTo: csvOption(options.notTo, config.sort.notTo),
    only: csvOption(options.only, config.sort.only),
    except: csvOption(options.except, config.sort.except),
    limit: options.limit === undefined
      ? statisticalEngine
        ? config.semantic.maxMoves
        : null
      : Number(options.limit),
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
  if (options.expectDigest && !options.apply) {
    return "--expect-digest requires --apply";
  }
  if (options.apply && !options.yes) {
    return "Sort apply requires explicit consent with --yes";
  }
  if (options.apply && !options.expectDigest) {
    return "Sort apply requires --expect-digest from the reviewed preview";
  }
  return null;
}

function normalizeEngine(engine?: string): "rules" | "lexical" | "bge_small" | "hybrid" | "invalid" {
  if (engine === undefined || engine === "rules") return "rules";
  if (engine === "lexical") return "lexical";
  if (engine === "bge-small") return "bge_small";
  if (engine === "hybrid") return "hybrid";
  return "invalid";
}

function normalizeBackend(backend?: string): SortInputs["backend"] {
  if (backend === undefined || backend === "auto" || backend === "live" || backend === "session") {
    return backend ?? "auto";
  }
  return backend as SortInputs["backend"];
}

function validatedApplyBackend(value?: string): "auto" | "live" | "session" | undefined {
  if (value === undefined) return undefined;
  const backend = normalizeBackend(value);
  if (!(["auto", "live", "session"] as const).includes(backend)) {
    throw new CliInvocationError("--backend must be one of: auto, live, session");
  }
  return backend;
}

function validatedUndoSelector(value: string): string {
  if (value === "latest"
    || /^receipt:apply:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(value)) {
    return value;
  }
  throw new CliInvocationError("Undo Receipt must be 'latest' or a canonical receipt:apply:<uuid> id");
}

function validatedApplyReceiptSelector(value: string): string {
  if (/^receipt:apply:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(value)) {
    return value;
  }
  throw new CliInvocationError("Apply Receipt must be a canonical receipt:apply:<uuid> id");
}

function validatedCliInput<T>(validate: () => T): T {
  try {
    return validate();
  } catch (error) {
    if (error instanceof CliInvocationError) throw error;
    throw new CliInvocationError(error instanceof Error ? error.message : String(error), error);
  }
}

function sortFollowUpCommand(options: SortOptions, sourceWorkspace: string | undefined, mode: "--preview" | "--dry-run"): string {
  const parts = ["zts", "sort"];
  if (!options.all && sourceWorkspace) parts.push(shellQuote(sourceWorkspace));
  appendSortIntentFlags(parts, options);
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
  if (!plan.actions.some((action) => action.disposition === "move")) return commands;
  commands.push(`zts apply ${shellQuote(plan.id)} --yes --expect-digest ${plan.digest}`);
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
  const title = mode === "dry-run"
    ? "Sort dry run"
    : mode === "apply"
      ? blockers.length > 0
        ? "Sort apply · attention required"
        : result.summary.moveCount === 0
        ? "Sort apply · no changes"
        : "Sort apply blocked"
      : "Sort preview";
  const scope = sourceScope.kind === "all_workspaces" ? "all applicable Workspaces" : sourceScope.workspaceName;
  const lines = [
    `${title} · ${terminalData(scope)}`,
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
    mode === "apply" && result.summary.moveCount === 0
      ? blockers.length > 0
        ? "Nothing changed. No Apply Transaction or Receipt was created."
        : "No executable moves were applied."
      : "Nothing changed."
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
      lines.push(...formatPlanActionReasons(action));
    }
  }
  if (warnings.length > 0) lines.push("", "Warnings:", ...warnings.map((warning) => `  - ${terminalData(warning)}`));
  if (blockers.length > 0) lines.push("", "Blockers:", ...blockers.map((blocker) => `  - ${terminalData(blocker)}`));
  if (suggestedNextCommands.length > 0) lines.push("", "Next:", ...suggestedNextCommands.map((command) => `  ${terminalData(command)}`));
  return `${lines.join("\n")}\n`;
}

function formatCanonicalReview(
  snapshot: Snapshot,
  plan: Plan,
  summary: DailySortPlanResult["summary"],
  suggestedNextCommands: readonly string[]
): string {
  const attentionActions = plan.actions.filter((action) =>
    action.disposition === "review"
    || action.disposition === "protected"
    || action.disposition === "blocked"
  );
  const entities = new Map<EntityRef, Entity>(snapshot.entities.map((entity) => [entity.ref, entity]));
  const lines = [
    "Saved Plan review",
    `Plan ${plan.id}`,
    `Digest ${plan.digest}`,
    `Snapshot ${plan.snapshotRevision}`,
    "",
    `Attention ${attentionActions.length}`,
    `Move ${summary.moveCount}`,
    `Protected ${summary.protectedCount}`,
    `Blocked ${summary.blockedCount}`,
    ""
  ];
  if (attentionActions.length === 0) {
    lines.push("No attention items found");
  } else {
    lines.push("Attention items:");
    for (const action of attentionActions) {
      const entityRef = action.disposition === "move" ? action.operation.entityRef : action.entityRef;
      const entity = entities.get(entityRef);
      lines.push(
        `  ${action.actionId}`,
        `    ${entity?.kind ?? "unknown"}: ${terminalData(entity?.title ?? entityRef)}`,
        ...formatPlanActionReasons(action)
      );
      for (const member of entity?.members ?? []) {
        lines.push(`    url: ${terminalData(member.url)}`);
      }
    }
  }
  if (suggestedNextCommands.length > 0) {
    lines.push("", "Next:", ...suggestedNextCommands.map((command) => `  ${terminalData(command)}`));
  }
  return `${lines.join("\n")}\n`;
}

function formatSavedPlan(snapshot: Snapshot, plan: Plan, expired: boolean): string {
  const counts = new Map<string, number>();
  for (const action of plan.actions) counts.set(action.disposition, (counts.get(action.disposition) ?? 0) + 1);
  const entities = new Map<EntityRef, Entity>(snapshot.entities.map((entity) => [entity.ref, entity]));
  const workspaces = new Map(snapshot.workspaces.map((workspace) => [workspace.id, workspace]));
  const lines = [
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
    `Unchanged: ${counts.get("unchanged") ?? 0}`,
    "",
    "Actions:"
  ];
  for (const action of plan.actions) {
    const entityRef = action.disposition === "move" ? action.operation.entityRef : action.entityRef;
    const entity = entities.get(entityRef);
    const destinationId = action.disposition === "move"
      ? action.operation.expectedPostState.workspaceId
      : action.candidateDestinationWorkspaceId;
    const sourceName = entity ? workspaces.get(entity.workspaceId)?.name ?? entity.workspaceId : "(unknown source)";
    const destinationName = destinationId ? workspaces.get(destinationId)?.name ?? destinationId : "(none)";
    lines.push(
      `  ${action.actionId}`,
      `    ${action.disposition} ${terminalData(entity?.title ?? entityRef)}`,
      `    ${terminalData(sourceName)} -> ${terminalData(destinationName)}`,
      ...formatPlanActionReasons(action)
    );
    for (const member of entity?.members ?? []) lines.push(`    url: ${terminalData(member.url)}`);
  }
  return `${lines.join("\n")}\n`;
}

function formatSnapshotSummary(snapshot: Snapshot, warnings: string[], suggestedNextCommands: string[]): string {
  const lines = [
    "Domain Snapshot",
    `Profile: ${terminalData(snapshot.profile.name)} (${terminalData(snapshot.profile.id)})`,
    `Revision: ${snapshot.revision}`,
    `Authority: ${snapshot.authority}`,
    `Freshness: ${snapshot.freshness}`,
    `Control route: ${snapshot.provenance.route}`,
    `Workspaces: ${snapshot.workspaces.length}`,
    `Entities: ${snapshot.entities.length}`,
    "",
    "First entities:",
    ...snapshot.entities.slice(0, 8).map((entity) => `  - ${terminalData(entity.ref)} -> ${terminalData(entity.workspaceId)} (${entity.kind}) ${terminalData(entity.title)}`)
  ];
  if (snapshot.entities.length > 8) lines.push(`  ... ${snapshot.entities.length - 8} more`);
  if (warnings.length > 0) lines.push("", "Warnings:", ...warnings.map((warning) => `  - ${terminalData(warning)}`));
  if (suggestedNextCommands.length > 0) lines.push("", "Next:", ...suggestedNextCommands.map((command) => `  ${terminalData(command)}`));
  return `${lines.join("\n")}\n`;
}

function formatManualPlanSummary(result: ManualPlanResult, warnings: string[], suggestedNextCommands: string[]): string {
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
      lines.push(`  - move ${terminalData(action.operation.entityRef)} -> ${terminalData(action.operation.expectedPostState.workspaceId)}`);
    } else {
      lines.push(`  - ${action.disposition} ${terminalData(action.entityRef)} -> ${terminalData(action.candidateDestinationWorkspaceId ?? "(none)")}`);
      lines.push(...formatPlanActionReasons(action));
    }
  }
  if (result.plan.actions.length > 12) {
    lines.push(
      `  ... ${result.plan.actions.length - 12} more`,
      `  Review every action with: zts plan show ${shellQuote(result.plan.id)}`
    );
  }
  if (warnings.length > 0) lines.push("", "Warnings:", ...warnings.map((warning) => `  - ${terminalData(warning)}`));
  if (suggestedNextCommands.length > 0) lines.push("", "Next:", ...suggestedNextCommands.map((command) => `  ${terminalData(command)}`));
  return `${lines.join("\n")}\n`;
}

function formatPlanActionReasons(action: Plan["actions"][number]): string[] {
  const lines = [`    decision: ${terminalData(action.decision.explanation.value)}`];
  if (action.disposition !== "move") {
    lines.push(`    policy: ${terminalData(action.dispositionReason.value)}`);
  }
  return lines;
}

function undoApplyCommand(inspection: UndoInspection, options: UndoOptions): string {
  if (!inspection.undoPlan) throw new Error("Undo confirmation command requires an eligible reviewed Plan");
  const parts = [
    "zts",
    "undo",
    shellQuote(inspection.sourceReceipt.id),
    "--yes",
    "--expect-digest",
    inspection.undoPlan.digest
  ];
  if (options.backend) parts.push("--backend", options.backend);
  if (options.acceptUnrelatedDrift) parts.push("--accept-unrelated-drift");
  return parts.join(" ");
}

function formatUndoInspection(inspection: UndoInspection, exactCommand: string | null): string {
  const plan = inspection.undoPlan ?? inspection.inversePlan;
  const visibleActions = plan?.actions.slice(0, 12) ?? [];
  const lines = [
    inspection.eligible ? "Undo preview" : "Undo blocked",
    `Source Receipt: ${terminalData(inspection.sourceReceipt.id)}`,
    `Source outcome: ${terminalData(inspection.sourceReceipt.outcome)}`,
    `Source completed: ${terminalData(inspection.sourceReceipt.completedAt)}`,
    `Undo window ends: ${terminalData(inspection.undoWindowExpiresAt)}`,
    `Current Snapshot: ${inspection.currentSnapshotRevision}`,
    `Authority: ${inspection.currentSnapshotAuthority}`,
    `Freshness: ${inspection.currentSnapshotFreshness}`,
    `Restores: ${plan?.actions.length ?? 0} move(s)`,
    ...(plan ? [`Plan: ${terminalData(plan.id)}`, `Digest: ${plan.digest}`] : []),
    "",
    ...visibleActions.map((action) => action.disposition === "move"
      ? `  - ${terminalData(action.operation.entityRef)}: ${terminalData(action.operation.precondition.sourceWorkspace.workspaceId)} -> ${terminalData(action.operation.expectedPostState.workspaceId)}`
      : `  - ${terminalData(action.entityRef)}: ${terminalData(action.disposition)}`),
    ...(plan && plan.actions.length > visibleActions.length
      ? [`  ... ${plan.actions.length - visibleActions.length} more; use --json for full detail`]
      : []),
    "",
    ...(inspection.blockers.length > 0
      ? ["Blockers:", ...inspection.blockers.map((blocker) => `  - ${terminalData(blocker)}`)]
      : ["Read-only preview. Nothing changed."]),
    ...(exactCommand ? ["", "Apply this exact Undo Plan:", `  ${terminalData(exactCommand)}`] : []),
    ""
  ];
  return lines.join("\n");
}

function emitNoMutationApply<T extends { readonly plan: Plan; readonly summary: { readonly moveCount: number } }>(
  command: string,
  options: JsonOption,
  title: string,
  data: T,
  outcome: NoMutationApplyOutcome
): void {
  const attentionRequired = outcome.applyOutcome === "attention_required";
  const disposition = cliOutcomeForNoMutation(attentionRequired);
  const blocker = attentionRequired
    ? `Plan contains ${outcome.attentionActionIds.length} review, protected, or blocked action(s) requiring attention`
    : null;
  if (options.json) {
    printJson(envelope(command, { ...data, ...outcome, outcome: disposition }, {
      ok: disposition.ok,
      blockers: blocker ? [blocker] : [],
      suggestedNextCommands: attentionRequired
        ? [`zts review ${shellQuote(data.plan.id)}`, `zts plan show ${shellQuote(data.plan.id)}`]
        : [`zts plan show ${shellQuote(data.plan.id)}`]
    }));
  } else {
    const rendered = formatNoMutationApply(title, data.plan, data.summary, outcome, blocker);
    (attentionRequired ? process.stderr : process.stdout).write(rendered);
  }
  process.exitCode = disposition.exitCode;
}

function formatNoMutationApply(
  title: string,
  plan: Plan,
  summary: { readonly moveCount: number },
  outcome: NoMutationApplyOutcome,
  blocker: string | null
): string {
  const attentionRequired = outcome.applyOutcome === "attention_required";
  return [
    title + (attentionRequired ? " · attention required" : " · no changes"),
    "Plan: " + plan.id,
    "Digest: " + plan.digest,
    "Executable moves: " + String(summary.moveCount),
    ...(attentionRequired ? ["Attention actions: " + String(outcome.attentionActionIds.length)] : []),
    "",
    blocker ?? "Nothing changed.",
    "No Apply Transaction or Receipt was created.",
    ""
  ].join("\n");
}

function formatSavedPlanApply(
  result: ApplyTransactionResult,
  title = "Saved Plan Apply",
  warnings: readonly string[] = [],
  suggestedNextCommands: readonly string[] = []
): string {
  const visibleOperations = result.receipt.operations.slice(0, 12);
  return `${[
    title,
    `Receipt: ${result.receipt.id}`,
    ...(result.plan.source.kind === "inverse"
      ? [`Undoes: ${terminalData(result.plan.source.sourceReceiptId)}`]
      : []),
    `Plan: ${result.plan.id}`,
    `Digest: ${result.plan.digest}`,
    `Moves: ${result.summary.moveCount}`,
    `Before Snapshot: ${result.receipt.beforeSnapshotRevision}`,
    `After Snapshot: ${result.receipt.afterSnapshotRevision ?? "(none)"}`,
    `Backup: ${result.receipt.backupArtifact?.id ?? "(none)"}`,
    `Terminal cleanup: ${result.terminalCleanupRequired ? "required" : "complete"}`,
    `Receipt file: ${terminalData(result.receiptPath)}`,
    "",
    "Applied:",
    ...visibleOperations.map((operation) => `  - ${terminalData(operation.entityRef)} -> ${terminalData(operation.observedWorkspaceId ?? "(none)")}`),
    ...(result.receipt.operations.length > visibleOperations.length
      ? [`  ... ${result.receipt.operations.length - visibleOperations.length} more; use --json for full detail`]
      : []),
    ...(warnings.length > 0
      ? ["", "Warnings:", ...warnings.map((warning) => `  - ${terminalData(warning)}`)]
      : []),
    ...(suggestedNextCommands.length > 0
      ? ["", "Next:", ...suggestedNextCommands.map((command) => `  ${terminalData(command)}`)]
      : [])
  ].join("\n")}\n`;
}

function formatApplyRecoveryList(recoveries: readonly ApplyRecoveryInspection[]): string {
  if (recoveries.length === 0) return "No Apply Transactions need recovery.\n";
  return `${[
    "Apply Transactions needing recovery",
    ...recoveries.flatMap((recovery) => [
      `  - ${terminalData(recovery.transactionId)} · ${recovery.journalStage} · ${recovery.classification}`,
      `    Plan: ${recovery.planDigest}`,
      `    Lock: ${recovery.lock.status}`,
      `    Next: zts apply recover ${shellQuote(recovery.transactionId)}`
    ])
  ].join("\n")}\n`;
}

function formatApplyRecoveryInspection(
  inspection: ApplyRecoveryInspection,
  exactCommand: string
): string {
  return `${[
    "Apply Transaction recovery inspection",
    `Transaction: ${terminalData(inspection.transactionId)}`,
    `Plan: ${inspection.planDigest}`,
    `Journal stage: ${inspection.journalStage}`,
    `Current state: ${inspection.classification}`,
    `Profile lock: ${inspection.lock.status}`,
    `Recovery claim: ${inspection.recoveryClaim.status}`,
    `Recovery digest: ${inspection.recoveryRevision}`,
    `Recoverable: ${inspection.recoverable ? "yes" : "no"}`,
    "",
    ...(inspection.blockers.length > 0
      ? ["Blockers:", ...inspection.blockers.map((blocker) => `  - ${terminalData(blocker)}`), ""]
      : []),
    ...(inspection.recoverable ? ["Next:", `  ${terminalData(exactCommand)}`] : [])
  ].join("\n")}\n`;
}

function formatApplyRecoveryResult(result: ApplyRecoveryResult): string {
  return `${[
    "Apply Transaction recovery recorded",
    `Transaction: ${terminalData(result.inspection.transactionId)}`,
    `Classification: ${result.inspection.classification}`,
    `Receipt: ${result.receipt.id}`,
    `Outcome: ${result.receipt.outcome}`,
    `Mutation attempted: ${result.receipt.mutationAttempted ? "yes" : "no"}`,
    `Net changed: ${String(result.receipt.netChanged)}`,
    `Recovery changed session bytes: ${result.sessionMutated ? "yes" : "no"}`,
    `Recovery mutation: ${result.recoveryMutation.kind}`,
    `Stale lock released: ${result.staleLockReleased ? "yes" : "no"}`,
    `Recovery lock released: ${result.recoveryLockReleased ? "yes" : "no"}`,
    `Receipt file: ${terminalData(result.receiptPath)}`
  ].join("\n")}\n`;
}

function formatDomainApplyVerification(report: TransactionReceiptVerificationReport): string {
  const lines = [
    "Domain apply receipt verification",
    `Receipt: ${report.receiptId}`,
    `Outcome: ${report.receipt.outcome}`,
    `Plan: ${report.receipt.planId}`,
    `Digest: ${report.receipt.planDigest}`,
    `Operations checked: ${report.verification.checkedOperations}`,
    `Mismatches: ${report.verification.mismatchCount}`,
    `Status: ${report.verification.ok ? "verified" : "blocked"}`
  ];
  if (report.verification.blockers.length > 0) {
    lines.push("", "Blockers:", ...report.verification.blockers.map((blocker) => `  - ${terminalData(blocker)}`));
  }
  if (report.verification.mismatches.length > 0) {
    lines.push("", "Mismatches:", ...report.verification.mismatches.map((mismatch) =>
      `  - ${terminalData(mismatch.actionId)} ${mismatch.reason}: expected ${terminalData(mismatch.expectedWorkspaceId ?? "(none)")}, actual ${terminalData(mismatch.actualWorkspaceId ?? "(none)")}`
    ));
  }
  return `${lines.join("\n")}\n`;
}

function formatDomainApplyReceiptList(receipts: readonly {
  readonly id: string;
  readonly kind: string;
  readonly outcome: string;
  readonly operationCount: number;
  readonly completedAt: string;
}[]): string {
  if (receipts.length === 0) return "No domain apply receipts found\n";
  return `${[
    "Domain apply receipts",
    ...receipts.map((receipt) =>
      `  - ${receipt.id} ${receipt.kind} ${receipt.outcome} (${receipt.operationCount} ops) ${receipt.completedAt}`
    )
  ].join("\n")}\n`;
}

function formatHistoryList(page: TransactionReceiptPage): string {
  if (page.receipts.length === 0) return "No Apply Receipt history found.\n";
  const lines = [
    "Apply Receipt history",
    ...page.receipts.flatMap((receipt) => [
      `  - ${terminalData(receipt.id)} · ${receipt.outcome} · ${receipt.operationCount} operations`,
      `    ${receipt.completedAt} · Plan ${terminalData(receipt.planId)}`,
      ...(receipt.causalSourceReceiptId
        ? [`    Undoes: ${terminalData(receipt.causalSourceReceiptId)}`]
        : []),
      receipt.fullReceiptAvailability === "available"
        ? `    Full Receipt: ${terminalData(receipt.receiptPath ?? "available")}`
        : "    Full Receipt: archived after undo window; summary only"
    ])
  ];
  if (page.nextCursor) {
    lines.push("", "More:", `  zts history list --cursor ${shellQuote(page.nextCursor)}`);
  }
  return `${lines.join("\n")}\n`;
}

function formatHistoryRetentionInspection(
  inspection: ApplyRetentionInspection,
  nextCommand: string | null
): string {
  const lines = [
    "Apply history retention preview",
    `Inspection: ${inspection.inspectionRevision}`,
    `Undo window: ${inspection.policy.undoWindowDays} days`,
    `Store: ${formatByteCount(inspection.accountingBytes)}`,
    `Exact target/GC plan: ${inspection.targetPlanRevision}`,
    `Full Receipts: ${inspection.fullReceiptCountBefore} -> ${inspection.fullReceiptCountAfter}`,
    `Durable summaries: ${inspection.summaryCountBefore} -> ${inspection.summaryCountAfter}`,
    `Archive full Receipts: ${inspection.archiveReceiptCount}`,
    `Evict oldest summaries: ${inspection.evictSummaryCount}`,
    `Bounded manifest: up to ${formatByteCount(inspection.manifestBytesUpperBound)}`,
    `Reclaimable now: at least ${formatByteCount(inspection.reclaimableBytesLowerBound)}`,
    "",
    "Nothing changed."
  ];
  if (inspection.blockers.length > 0) {
    lines.push("", "Blockers:", ...inspection.blockers.map((blocker) => `  - ${terminalData(blocker)}`));
  }
  if (nextCommand && (inspection.blockers.length === 0
    || inspection.action === "reconcile_publication_residue")) {
    lines.push("", "Apply this exact inspection:", `  ${terminalData(nextCommand)}`);
  }
  return `${lines.join("\n")}\n`;
}

function formatHistoryRetentionResult(result: ApplyRetentionResult): string {
  return `${[
    "Apply history retention complete",
    `Maintenance: ${result.maintenanceId}`,
    `Outcome: ${result.outcome}`,
    `Durable summaries: ${result.summaryCount}`,
    `Full Receipts archived: ${result.archivedReceiptCount}`,
    `Oldest summaries evicted: ${result.evictedSummaryCount}`,
    `Removed: ${formatByteCount(result.removedBytes)} in ${result.removedFiles} files`,
    `Transaction directories removed: ${result.removedTransactionDirectories}`,
    `Completed: ${result.completedAt}`
  ].join("\n")}\n`;
}

function formatByteCount(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GiB`;
}

function terminalData(value: string): string {
  return terminalText(value);
}

function formatDomainRules(domainRules: Record<string, string>): string {
  const entries = Object.entries(domainRules).sort(([a], [b]) => a.localeCompare(b));
  if (entries.length === 0) return "No configured domain rules\n";
  return `${entries.map(([pattern, workspace]) => `${terminalData(pattern)} -> ${terminalData(workspace)}`).join("\n")}\n`;
}

function domainFromInput(input: string): string {
  try {
    return new URL(input).hostname.toLowerCase();
  } catch {
    return input.toLowerCase();
  }
}
