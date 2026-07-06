import { RawTab, RawZenSession, SessionSummary, WorkspaceSummary } from "./session.js";

export interface SortInputs {
  preview: boolean;
  dryRun: boolean;
  minConfidence: number;
  includePinned: boolean;
  to: string[];
  notTo: string[];
  only: string[];
  except: string[];
  backend: "auto" | "live" | "session";
}

export type PlanAction = "move" | "skip" | "review";

export interface EntityPlan {
  entityId: string;
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
  destinationSummaries: DestinationSummary[];
  plannedActions: EntityPlan[];
  skippedActions: EntityPlan[];
  reviewActions: EntityPlan[];
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
  const destinationWorkspaces = candidateDestinations(summary.workspaces, sourceWorkspace, inputs);
  const destinationByName = new Map(destinationWorkspaces.map((workspace) => [workspace.name, workspace]));
  const tabs = Array.isArray(session.tabs) ? session.tabs : [];
  const sourceTabs = tabs.filter((tab) => tab.zenWorkspace === sourceWorkspace.id);
  const plannedActions: EntityPlan[] = [];
  const skippedActions: EntityPlan[] = [];
  const reviewActions: EntityPlan[] = [];

  sourceTabs.forEach((tab, index) => {
    const entity = describeTab(tab, index, sourceWorkspace);
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

    const classification = classifyByDomain(entity.domain, destinationByName);
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

    plannedActions.push({
      ...entity,
      action: "move",
      reason: "domain_rule",
      destinationWorkspaceId: classification.workspace.id,
      destinationWorkspaceName: classification.workspace.name,
      confidence: classification.confidence,
      explanation: `Domain ${entity.domain} matched ${classification.matchedPattern}`
    });
  });

  return {
    sourceWorkspace,
    moveCount: plannedActions.length,
    skipCount: skippedActions.length,
    reviewCount: reviewActions.length,
    destinationSummaries: summarizeDestinations(plannedActions),
    plannedActions,
    skippedActions,
    reviewActions
  };
}

function candidateDestinations(
  workspaces: WorkspaceSummary[],
  sourceWorkspace: WorkspaceSummary,
  inputs: SortInputs
): WorkspaceSummary[] {
  const allow = new Set(inputs.to.map(normalizeName));
  const deny = new Set(inputs.notTo.map(normalizeName));
  return workspaces.filter((workspace) => {
    if (workspace.id === sourceWorkspace.id) return false;
    const names = [normalizeName(workspace.name), normalizeName(workspace.id)];
    if (allow.size > 0 && !names.some((name) => allow.has(name))) return false;
    if (names.some((name) => deny.has(name))) return false;
    return true;
  });
}

function describeTab(tab: RawTab, index: number, sourceWorkspace: WorkspaceSummary): Omit<EntityPlan, "action" | "reason" | "confidence" | "explanation"> {
  const entry = selectedEntry(tab);
  const url = entry?.url ?? "about:blank";
  return {
    entityId: String(tab.zenSyncId ?? tab.zenGlanceId ?? `${sourceWorkspace.id}:${index}`),
    entityType: "tab",
    title: entry?.title ?? url,
    url,
    domain: domainForUrl(url),
    sourceWorkspaceId: sourceWorkspace.id,
    sourceWorkspaceName: sourceWorkspace.name,
    destinationWorkspaceId: null,
    destinationWorkspaceName: null
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
  if (tab.zenEssential) return "essential_protected";
  if (tab.pinned && !inputs.includePinned) return "pinned_protected";
  if (tab.groupId || tab.zenLiveFolderItemId) return "grouped_or_foldered_protected";
  if (inputs.except.some((pattern) => matchesPattern(pattern, entity.domain, entity.url))) return "excluded_by_filter";
  if (inputs.only.length > 0 && !inputs.only.some((pattern) => matchesPattern(pattern, entity.domain, entity.url))) return "outside_only_filter";
  return null;
}

function classifyByDomain(domain: string, destinationByName: Map<string, WorkspaceSummary>) {
  for (const [workspaceName, patterns] of Object.entries(DOMAIN_RULES)) {
    const workspace = destinationByName.get(workspaceName);
    if (!workspace) continue;
    const matchedPattern = patterns.find((pattern) => matchesPattern(pattern, domain, `https://${domain}/`));
    if (matchedPattern) return { workspace, matchedPattern, confidence: 0.9 };
  }
  return null;
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
