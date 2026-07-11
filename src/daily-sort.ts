import { effectiveConfigRevision } from "./config.js";
import { createLexicalPlan, lexicalPlanRequestRevision } from "./engines/lexical.js";
import { createRulesPlan, rulesPlanRequestRevision } from "./engines/rules.js";
import { resolveOrCreatePlan } from "./plans.js";

import type { ZtsConfig } from "./config.js";
import type { Plan } from "./domain/change.js";
import type { ArtifactReference, Snapshot } from "./domain/snapshot.js";
import type { Sha256Digest } from "./domain/digest.js";
import type { LexicalPlanOptions } from "./engines/lexical.js";
import type { RulesPlanOptions } from "./engines/rules.js";
import type { SortScope } from "./engines/plan-compiler.js";

export interface DailySortRequest {
  readonly scope: SortScope;
  readonly engine: "rules" | "lexical";
  readonly destinationAllowlist: readonly string[];
  readonly destinationDenylist: readonly string[];
  readonly only: readonly string[];
  readonly except: readonly string[];
  readonly limit: number | null;
  readonly includePinned: boolean;
  readonly includeEssentials: boolean;
  readonly suggestionThreshold: number;
  readonly minimumMargin: number;
  readonly autoApplyRequested: boolean;
  readonly planMode: "create_or_reuse" | "create_if_missing_require_existing_state" | "require_existing";
}

export interface DailySortPlanResult {
  readonly snapshot: Snapshot;
  readonly plan: Plan;
  readonly planResolution: "created" | "reused_latest";
  readonly requestRevision: Sha256Digest;
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
  snapshot: Snapshot,
  config: ZtsConfig,
  request: DailySortRequest,
  now = new Date()
): Promise<DailySortPlanResult> {
  const configRevision = effectiveConfigRevision(config);
  const commonOptions = {
    scope: request.scope,
    configRevision,
    sourceAllowlist: config.sort.from,
    destinationAllowlist: request.destinationAllowlist,
    destinationDenylist: request.destinationDenylist,
    only: request.only,
    except: request.except,
    includePinned: request.includePinned,
    includeEssentials: request.includeEssentials,
    limit: request.limit,
    autoApplyRequested: request.autoApplyRequested
  };
  const engineOptions = request.engine === "rules"
    ? {
        ...commonOptions,
        domainRules: config.rules.domains
      } satisfies Omit<RulesPlanOptions, "now">
    : {
        ...commonOptions,
        suggestionThreshold: request.suggestionThreshold,
        minimumMargin: request.minimumMargin,
        inboxSelector: config.defaults.inbox,
        domainRules: config.rules.domains
      } satisfies Omit<LexicalPlanOptions, "now">;
  const requestRevision = request.engine === "rules"
    ? rulesPlanRequestRevision(engineOptions as Omit<RulesPlanOptions, "now">)
    : lexicalPlanRequestRevision(engineOptions as Omit<LexicalPlanOptions, "now">);
  const resolved = await resolveOrCreatePlan(
    snapshot,
    requestRevision,
    () => request.engine === "rules"
      ? createRulesPlan(snapshot, { ...(engineOptions as Omit<RulesPlanOptions, "now">), now })
      : createLexicalPlan(snapshot, { ...(engineOptions as Omit<LexicalPlanOptions, "now">), now }),
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

export function summarizePlan(plan: Plan): DailySortPlanResult["summary"] {
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
