import { RawTab, RawZenSession, SessionSummary, WorkspaceSummary } from "./session.js";

export interface SortInputs {
  preview: boolean;
  dryRun: boolean;
  minConfidence: number;
  includePinned: boolean;
  includeEssentials: boolean;
  to: string[];
  notTo: string[];
  only: string[];
  except: string[];
  limit: number | null;
  backend: "auto" | "live" | "session";
  domainRules: Record<string, string>;
  protectedDomains: string[];
}

export type PlanAction = "move" | "skip" | "review" | "blocked";

export interface EntityPlan {
  entityId: string;
  tabIndex: number;
  entityType: "tab";
  title: string;
  url: string;
  domain: string;
  sourceWorkspaceId: string;
  sourceWorkspaceName: string;
  destinationWorkspaceId: string | null;
  destinationWorkspaceName: string | null;
  confidence: number;
  explanation: string;
  action: PlanAction;
  reason: string;
  protectionReasons: string[];
}

export interface DestinationSummary {
  workspaceId: string;
  workspaceName: string;
  entityCount: number;
  tabCount: number;
  domains: string[];
}

export interface SortPlan {
  sourceWorkspace: WorkspaceSummary;
  moveCount: number;
  skipCount: number;
  reviewCount: number;
  blockedCount: number;
  destinationSummaries: DestinationSummary[];
  plannedActions: EntityPlan[];
  skippedActions: EntityPlan[];
  reviewActions: EntityPlan[];
  blockedActions: EntityPlan[];
}

const DOMAIN_RULES: Record<string, string[]> = {
  "Portfolio": ["framer.com", "framer.university", "rpio.dev"],
  "Tool Development": ["github.com", "localhost", "127.0.0.1", "dash.cloudflare.com", "cloudflare.com", "magicpath.ai"],
  "Development": ["github.com", "localhost", "127.0.0.1", "dash.cloudflare.com", "cloudflare.com", "magicpath.ai"],
  "Video": ["youtube.com", "hyperframes.heygen.com"],
  "Travel": ["airbnb.de"]
};

export function planSortPreview(
  session: RawZenSession,
  summary: SessionSummary,
  sourceWorkspace: WorkspaceSummary,
  inputs: SortInputs
): SortPlan {
  const workspaceByName = workspaceLookup(summary.workspaces);
  const domainRules = effectiveDomainRules(inputs.domainRules);
  const tabs = Array.isArray(session.tabs) ? session.tabs : [];
  const plannedActions: EntityPlan[] = [];
  const skippedActions: EntityPlan[] = [];
  const reviewActions: EntityPlan[] = [];
  const blockedActions: EntityPlan[] = [];

  tabs.forEach((tab, index) => {
    if (tab.zenWorkspace !== sourceWorkspace.id) return;
    const entity = describeTab(tab, index, sourceWorkspace);
    if (!sourceWorkspace.sortableFrom) {
      const sourceBlockedReason = sourceWorkspace.protectedStatus === "from" || sourceWorkspace.protectedStatus === "from_to"
        ? "source_workspace_protected"
        : "source_workspace_not_allowed";
      blockedActions.push({
        ...entity,
        action: "blocked",
        reason: sourceBlockedReason,
        confidence: 1,
        explanation: sourceBlockedReason === "source_workspace_protected"
          ? `Source workspace ${sourceWorkspace.name} is protected from sorting`
          : `Source workspace ${sourceWorkspace.name} is not allowed by the active source policy`
      });
      return;
    }

    const blockedReason = protectionBlockReason(entity, inputs);
    if (blockedReason) {
      blockedActions.push({
        ...entity,
        action: "blocked",
        reason: blockedReason,
        confidence: 1,
        explanation: blockedExplanation(blockedReason, entity)
      });
      return;
    }

    const skipReason = protectionSkipReason(tab, entity, inputs);
    if (skipReason) {
      skippedActions.push({
        ...entity,
        action: "skip",
        reason: skipReason,
        confidence: 1,
        explanation: skipReason
      });
      return;
    }

    const classification = classifyByDomain(entity.domain, workspaceByName, domainRules);
    if (!classification) {
      reviewActions.push({
        ...entity,
        action: "review",
        reason: "no_deterministic_rule",
        confidence: 0,
        explanation: "No deterministic domain rule matched an available destination workspace"
      });
      return;
    }

    if (classification.workspace.id === sourceWorkspace.id) {
      skippedActions.push({
        ...entity,
        action: "skip",
        reason: "already_in_destination",
        destinationWorkspaceId: classification.workspace.id,
        destinationWorkspaceName: classification.workspace.name,
        confidence: classification.confidence,
        explanation: `Domain ${entity.domain} already belongs in ${sourceWorkspace.name}`
      });
      return;
    }

    const destinationBlocker = destinationBlockedReason(classification.workspace, inputs);
    if (destinationBlocker) {
      blockedActions.push({
        ...entity,
        action: "blocked",
        reason: destinationBlocker,
        destinationWorkspaceId: classification.workspace.id,
        destinationWorkspaceName: classification.workspace.name,
        confidence: classification.confidence,
        explanation: destinationBlocker === "destination_workspace_protected"
          ? `Destination workspace ${classification.workspace.name} is protected from sorting`
          : `Destination workspace ${classification.workspace.name} is excluded by the active sort policy`
      });
      return;
    }

    if (classification.confidence < inputs.minConfidence) {
      reviewActions.push({
        ...entity,
        action: "review",
        reason: "below_min_confidence",
        destinationWorkspaceId: classification.workspace.id,
        destinationWorkspaceName: classification.workspace.name,
        confidence: classification.confidence,
        explanation: `Domain ${entity.domain} matched ${classification.matchedPattern}, but confidence ${classification.confidence} is below minimum ${inputs.minConfidence}`
      });
      return;
    }

    const moveAction: EntityPlan = {
      ...entity,
      action: "move",
      reason: "domain_rule",
      destinationWorkspaceId: classification.workspace.id,
      destinationWorkspaceName: classification.workspace.name,
      confidence: classification.confidence,
      explanation: `Domain ${entity.domain} matched ${classification.matchedPattern}`
    };

    if (inputs.limit !== null && plannedActions.length >= inputs.limit) {
      reviewActions.push({
        ...moveAction,
        action: "review",
        reason: "over_move_limit",
        explanation: `Domain ${entity.domain} matched ${classification.matchedPattern}, but the planned move limit ${inputs.limit} was reached`
      });
      return;
    }

    plannedActions.push(moveAction);
  });

  return {
    sourceWorkspace,
    moveCount: plannedActions.length,
    skipCount: skippedActions.length,
    reviewCount: reviewActions.length,
    blockedCount: blockedActions.length,
    destinationSummaries: summarizeDestinations(plannedActions),
    plannedActions,
    skippedActions,
    reviewActions,
    blockedActions
  };
}

function describeTab(tab: RawTab, index: number, sourceWorkspace: WorkspaceSummary): Omit<EntityPlan, "action" | "reason" | "confidence" | "explanation"> {
  const entry = selectedEntry(tab);
  const url = entry?.url ?? "about:blank";
  return {
    entityId: String(tab.zenSyncId ?? tab.zenGlanceId ?? `${sourceWorkspace.id}:${index}`),
    tabIndex: index,
    entityType: "tab",
    title: entry?.title ?? url,
    url,
    domain: domainForUrl(url),
    sourceWorkspaceId: sourceWorkspace.id,
    sourceWorkspaceName: sourceWorkspace.name,
    destinationWorkspaceId: null,
    destinationWorkspaceName: null,
    protectionReasons: tabProtectionReasons(tab)
  };
}

function selectedEntry(tab: RawTab) {
  const entries = Array.isArray(tab.entries) ? tab.entries : [];
  if (entries.length === 0) return undefined;
  const rawIndex = typeof tab.index === "number" ? tab.index - 1 : entries.length - 1;
  const index = Math.min(Math.max(rawIndex, 0), entries.length - 1);
  return entries[index];
}

function protectionSkipReason(tab: RawTab, entity: { domain: string; url: string }, inputs: SortInputs): string | null {
  if (tab.zenEssential && !inputs.includeEssentials) return "essential_protected";
  if (tab.pinned && !inputs.includePinned) return "pinned_protected";
  if (tab.groupId || tab.zenLiveFolderItemId) return "grouped_or_foldered_protected";
  if (inputs.except.some((pattern) => matchesPattern(pattern, entity.domain, entity.url))) return "excluded_by_filter";
  if (inputs.only.length > 0 && !inputs.only.some((pattern) => matchesPattern(pattern, entity.domain, entity.url))) return "outside_only_filter";
  return null;
}

function protectionBlockReason(entity: { domain: string; url: string }, inputs: SortInputs): string | null {
  if ((inputs.protectedDomains ?? []).some((pattern) => matchesPattern(pattern, entity.domain, entity.url))) return "domain_protected";
  return null;
}

function blockedExplanation(reason: string, entity: { domain: string }): string {
  if (reason === "domain_protected") return `Domain ${entity.domain} is protected by config`;
  return reason;
}

function destinationBlockedReason(workspace: WorkspaceSummary, inputs: SortInputs): string | null {
  if (workspace.protectedStatus === "to" || workspace.protectedStatus === "from_to") return "destination_workspace_protected";
  const names = [normalizeName(workspace.name), normalizeName(workspace.id)];
  const allow = new Set(inputs.to.map(normalizeName));
  const deny = new Set(inputs.notTo.map(normalizeName));
  if (allow.size > 0 && !names.some((name) => allow.has(name))) return "destination_not_allowed";
  if (names.some((name) => deny.has(name))) return "destination_not_allowed";
  if (!workspace.sortableTo) return "destination_not_allowed";
  return null;
}

export function classifyDomainForWorkspace(domain: string, domainRules: Record<string, string>): { workspaceName: string; matchedPattern: string } | null {
  for (const [workspaceName, patterns] of Object.entries(effectiveDomainRules(domainRules))) {
    const matchedPattern = patterns.find((pattern) => matchesPattern(pattern, domain, `https://${domain}/`));
    if (matchedPattern) return { workspaceName, matchedPattern };
  }
  return null;
}

function classifyByDomain(domain: string, destinationByName: Map<string, WorkspaceSummary>, domainRules: Record<string, string[]>) {
  for (const [workspaceName, patterns] of Object.entries(domainRules)) {
    const workspace = destinationByName.get(workspaceName) ?? destinationByName.get(normalizeName(workspaceName));
    if (!workspace) continue;
    const matchedPattern = patterns.find((pattern) => matchesPattern(pattern, domain, `https://${domain}/`));
    if (matchedPattern) return { workspace, matchedPattern, confidence: 0.9 };
  }
  return null;
}

function workspaceLookup(workspaces: WorkspaceSummary[]): Map<string, WorkspaceSummary> {
  const lookup = new Map<string, WorkspaceSummary>();
  for (const workspace of workspaces) {
    lookup.set(workspace.name, workspace);
    lookup.set(workspace.id, workspace);
    lookup.set(normalizeName(workspace.name), workspace);
    lookup.set(normalizeName(workspace.id), workspace);
  }
  return lookup;
}

function tabProtectionReasons(tab: RawTab): string[] {
  const reasons: string[] = [];
  if (tab.pinned) reasons.push("pinned");
  if (tab.zenEssential) reasons.push("essential");
  if (tab.groupId) reasons.push("grouped");
  if (tab.zenLiveFolderItemId) reasons.push("foldered");
  return reasons;
}

function effectiveDomainRules(configRules: Record<string, string>): Record<string, string[]> {
  const rules: Record<string, string[]> = structuredClone(DOMAIN_RULES);
  for (const [pattern, workspaceName] of Object.entries(configRules)) {
    rules[workspaceName] = [...(rules[workspaceName] ?? []), pattern];
  }
  return rules;
}

function summarizeDestinations(actions: EntityPlan[]): DestinationSummary[] {
  const summaries = new Map<string, DestinationSummary>();
  for (const action of actions) {
    if (!action.destinationWorkspaceId || !action.destinationWorkspaceName) continue;
    const key = action.destinationWorkspaceId;
    const existing = summaries.get(key) ?? {
      workspaceId: action.destinationWorkspaceId,
      workspaceName: action.destinationWorkspaceName,
      entityCount: 0,
      tabCount: 0,
      domains: []
    };
    existing.entityCount += 1;
    existing.tabCount += 1;
    if (action.domain && !existing.domains.includes(action.domain)) existing.domains.push(action.domain);
    summaries.set(key, existing);
  }
  return Array.from(summaries.values()).map((summary) => ({
    ...summary,
    domains: summary.domains.sort()
  }));
}

function domainForUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.hostname.toLowerCase();
  } catch {
    return "";
  }
}

function matchesPattern(pattern: string, domain: string, url: string): boolean {
  const normalized = pattern.trim().toLowerCase();
  if (!normalized) return false;
  if (normalized.startsWith("http://") || normalized.startsWith("https://")) {
    return url.toLowerCase().startsWith(normalized);
  }
  if (normalized.startsWith("*.")) {
    const suffix = normalized.slice(2);
    return domain.endsWith(`.${suffix}`);
  }
  if (normalized.startsWith(".")) {
    return domain.endsWith(normalized);
  }
  return domain === normalized || domain.endsWith(`.${normalized}`);
}

function normalizeName(value: string): string {
  return value.trim().toLowerCase();
}
