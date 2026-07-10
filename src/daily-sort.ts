import { sha256Canonical } from "./domain/digest.js";
import { createRulesPlan, rulesPlanRequestRevision } from "./engines/rules.js";
import { snapshotFromSession } from "./manual.js";
import { resolveOrCreatePlan } from "./plans.js";

import type { ZtsConfig } from "./config.js";
import type { Plan } from "./domain/change.js";
import type { ArtifactReference, Snapshot } from "./domain/snapshot.js";
import type { RulesPlanOptions, SortScope } from "./engines/rules.js";
import type { ProfileContext } from "./profile.js";
import type { RawZenSession, SessionSummary } from "./session.js";

export interface DailySortRequest {
  readonly scope: SortScope;
  readonly engine: "rules";
  readonly destinationAllowlist: readonly string[];
  readonly destinationDenylist: readonly string[];
  readonly only: readonly string[];
  readonly except: readonly string[];
  readonly limit: number | null;
  readonly includePinned: boolean;
  readonly includeEssentials: boolean;
  readonly autoApplyRequested: boolean;
  readonly planMode: "create_or_reuse" | "require_existing";
}

export interface DailySortPlanResult {
  readonly snapshot: Snapshot;
  readonly plan: Plan;
  readonly planResolution: "created" | "reused_latest";
  readonly requestRevision: string;
  readonly artifact: ArtifactReference;
  readonly summary: {
    readonly moveCount: number;
    readonly reviewCount: number;
    readonly protectedCount: number;
    readonly blockedCount: number;
    readonly unchangedCount: number;
  };
}

export async function planDailySort(
  context: ProfileContext,
  session: RawZenSession,
  summary: SessionSummary,
  config: ZtsConfig,
  request: DailySortRequest,
  now = new Date()
): Promise<DailySortPlanResult> {
  const snapshot = snapshotFromSession(context, session, summary);
  const configRevision = sha256Canonical({
    schemaVersion: "zts.sort-config.provisional-1",
    engine: request.engine,
    rules: orderedRecord(config.rules.domains),
    sourceAllowlist: [...config.sort.from],
    destinationAllowlist: [...request.destinationAllowlist],
    destinationDenylist: [...request.destinationDenylist],
    only: [...request.only],
    except: [...request.except],
    protectedDomains: [...config.protect.domains.neverMove],
    workspaceProtection: {
      from: [...config.protect.workspaces.from],
      to: [...config.protect.workspaces.to]
    },
    includePinned: request.includePinned,
    includeEssentials: request.includeEssentials,
    limit: request.limit
  });
  const rulesOptions: Omit<RulesPlanOptions, "now"> = {
    scope: request.scope,
    configRevision,
    domainRules: config.rules.domains,
    sourceAllowlist: config.sort.from,
    destinationAllowlist: request.destinationAllowlist,
    destinationDenylist: request.destinationDenylist,
    only: request.only,
    except: request.except,
    protectedDomains: config.protect.domains.neverMove,
    limit: request.limit,
    autoApplyRequested: request.autoApplyRequested
  };
  const requestRevision = rulesPlanRequestRevision(rulesOptions);
  const resolved = await resolveOrCreatePlan(
    snapshot,
    requestRevision,
    () => createRulesPlan(snapshot, { ...rulesOptions, now }),
    now,
    request.planMode
  );
  return {
    snapshot,
    plan: resolved.plan,
    planResolution: resolved.resolution,
    requestRevision,
    artifact: resolved.artifact,
    summary: summarizePlan(resolved.plan)
  };
}

function summarizePlan(plan: Plan): DailySortPlanResult["summary"] {
  return {
    moveCount: countDisposition(plan, "move"),
    reviewCount: countDisposition(plan, "review"),
    protectedCount: countDisposition(plan, "protected"),
    blockedCount: countDisposition(plan, "blocked"),
    unchangedCount: countDisposition(plan, "unchanged")
  };
}

function countDisposition(plan: Plan, disposition: Plan["actions"][number]["disposition"]): number {
  return plan.actions.filter((action) => action.disposition === disposition).length;
}

function orderedRecord(value: Readonly<Record<string, string>>): Readonly<Record<string, string>> {
  return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)));
}
