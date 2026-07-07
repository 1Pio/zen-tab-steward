import { RawFolder, RawGroup, RawTab, RawZenSession, SessionSummary, WorkspaceSummary } from "./session.js";

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
  tabIndices: number[];
  childTabCount: number;
  entityType: "tab" | "folder" | "group";
  title: string;
  url: string;
  urls: string[];
  domain: string;
  domains: string[];
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
  const folders = Array.isArray(session.folders) ? session.folders : [];
  const groups = Array.isArray(session.groups) ? session.groups : [];
  const plannedActions: EntityPlan[] = [];
  const skippedActions: EntityPlan[] = [];
  const reviewActions: EntityPlan[] = [];
  const blockedActions: EntityPlan[] = [];
  const emittedStructuredEntities = new Set<string>();

  tabs.forEach((tab, index) => {
    if (tab.zenWorkspace !== sourceWorkspace.id) return;
    const structuredKey = structuredEntityKey(tab);
    if (structuredKey) {
      if (!emittedStructuredEntities.has(structuredKey)) {
        emittedStructuredEntities.add(structuredKey);
        const structuredEntity = describeStructuredEntity(tabs, folders, groups, structuredKey, sourceWorkspace, index);
        classifyStructuredEntity(
          structuredEntity,
          sourceWorkspace,
          workspaceByName,
          domainRules,
          inputs,
          skippedActions,
          reviewActions,
          blockedActions
        );
      }
      return;
    }
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
  const domain = domainForUrl(url);
  return {
    entityId: String(tab.zenSyncId ?? tab.zenGlanceId ?? `${sourceWorkspace.id}:${index}`),
    tabIndex: index,
    tabIndices: [index],
    childTabCount: 1,
    entityType: "tab",
    title: entry?.title ?? url,
    url,
    urls: [url],
    domain,
    domains: domain ? [domain] : [],
    sourceWorkspaceId: sourceWorkspace.id,
    sourceWorkspaceName: sourceWorkspace.name,
    destinationWorkspaceId: null,
    destinationWorkspaceName: null,
    protectionReasons: tabProtectionReasons(tab)
  };
}

function classifyStructuredEntity(
  entity: Omit<EntityPlan, "action" | "reason" | "confidence" | "explanation">,
  sourceWorkspace: WorkspaceSummary,
  destinationByName: Map<string, WorkspaceSummary>,
  domainRules: Record<string, string[]>,
  inputs: SortInputs,
  skippedActions: EntityPlan[],
  reviewActions: EntityPlan[],
  blockedActions: EntityPlan[]
): void {
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

  if (inputs.except.some((pattern) => entityMatchesPattern(entity, pattern))) {
    skippedActions.push({
      ...entity,
      action: "skip",
      reason: "excluded_by_filter",
      confidence: 1,
      explanation: "Structured entity contains a tab excluded by the active filter"
    });
    return;
  }

  if (inputs.only.length > 0 && !entity.urls.every((url) => inputs.only.some((pattern) => matchesPattern(pattern, domainForUrl(url), url)))) {
    reviewActions.push({
      ...entity,
      action: "review",
      reason: "outside_only_filter",
      confidence: 1,
      explanation: "Structured entity contains tabs outside the active only filter"
    });
    return;
  }

  if ((inputs.protectedDomains ?? []).some((pattern) => entityMatchesPattern(entity, pattern))) {
    blockedActions.push({
      ...entity,
      action: "blocked",
      reason: "domain_protected",
      confidence: 1,
      explanation: "Structured entity contains a protected domain"
    });
    return;
  }

  const destination = classifyStructuredDestination(entity.domains, destinationByName, domainRules);
  if (!destination) {
    reviewActions.push({
      ...entity,
      action: "review",
      reason: "structured_entity_review",
      confidence: 0,
      explanation: `${entityLabel(entity)} has ${entity.childTabCount} tabs and needs review before any grouped/foldered move is enabled`
    });
    return;
  }
  const destinationBlocker = destinationBlockedReason(destination.workspace, inputs);
  if (destinationBlocker) {
    blockedActions.push({
      ...entity,
      action: "blocked",
      reason: destinationBlocker,
      destinationWorkspaceId: destination.workspace.id,
      destinationWorkspaceName: destination.workspace.name,
      confidence: destination.confidence,
      explanation: destinationBlocker === "destination_workspace_protected"
        ? `Destination workspace ${destination.workspace.name} is protected from sorting`
        : `Destination workspace ${destination.workspace.name} is excluded by the active sort policy`
    });
    return;
  }

  reviewActions.push({
    ...entity,
    action: "review",
    reason: "structured_entity_review",
    destinationWorkspaceId: destination.workspace.id,
    destinationWorkspaceName: destination.workspace.name,
    confidence: destination.confidence,
    explanation: `${entityLabel(entity)} has ${entity.childTabCount} tabs and appears to match ${destination.workspace.name}, but grouped/foldered apply is not enabled yet`
  });
}

function describeStructuredEntity(
  tabs: RawTab[],
  folders: RawFolder[],
  groups: RawGroup[],
  key: string,
  sourceWorkspace: WorkspaceSummary,
  firstIndex: number
): Omit<EntityPlan, "action" | "reason" | "confidence" | "explanation"> {
  const [type, id] = key.split(":", 2) as ["folder" | "group", string];
  const members = tabs
    .map((tab, index) => ({ tab, index }))
    .filter(({ tab }) => tab.zenWorkspace === sourceWorkspace.id && structuredEntityKey(tab) === key);
  const memberSummaries = members.map(({ tab, index }) => ({ ...tabSummaryFields(tab), index }));
  const domains = Array.from(new Set(memberSummaries.map((member) => member.domain).filter(Boolean))).sort();
  const urls = Array.from(new Set(memberSummaries.map((member) => member.url)));
  const representative = memberSummaries[0] ?? {
    title: `${type} ${id}`,
    url: "about:blank",
    domain: "",
    index: firstIndex
  };
  const folder = type === "folder" ? folders.find((item) => item.id === id) : undefined;
  const group = type === "group" ? groups.find((item) => item.id === id) : undefined;
  const displayName = folder?.name ?? group?.name ?? `${type} ${id}`;
  const protectionReasons = structuredProtectionReasons(members.map(({ tab }) => tab), type);

  return {
    entityId: `${type}:${id}`,
    tabIndex: representative.index,
    tabIndices: members.map((member) => member.index),
    childTabCount: members.length,
    entityType: type,
    title: displayName,
    url: representative.url,
    urls,
    domain: representative.domain,
    domains,
    sourceWorkspaceId: sourceWorkspace.id,
    sourceWorkspaceName: sourceWorkspace.name,
    destinationWorkspaceId: null,
    destinationWorkspaceName: null,
    protectionReasons
  };
}

function structuredEntityKey(tab: RawTab): string | null {
  if (typeof tab.zenLiveFolderItemId === "string" && tab.zenLiveFolderItemId) return `folder:${tab.zenLiveFolderItemId}`;
  if (typeof tab.groupId === "string" && tab.groupId) return `group:${tab.groupId}`;
  return null;
}

function tabSummaryFields(tab: RawTab): { title: string; url: string; domain: string } {
  const entry = selectedEntry(tab);
  const url = entry?.url ?? "about:blank";
  return {
    title: entry?.title ?? url,
    url,
    domain: domainForUrl(url)
  };
}

function structuredProtectionReasons(tabs: RawTab[], type: "folder" | "group"): string[] {
  const reasons = new Set<string>([type === "folder" ? "foldered" : "grouped"]);
  for (const tab of tabs) {
    for (const reason of tabProtectionReasons(tab)) reasons.add(reason);
  }
  return Array.from(reasons);
}

function classifyStructuredDestination(
  domains: string[],
  destinationByName: Map<string, WorkspaceSummary>,
  domainRules: Record<string, string[]>
): { workspace: WorkspaceSummary; confidence: number } | null {
  if (domains.length === 0) return null;
  const matches = domains.map((domain) => classifyByDomain(domain, destinationByName, domainRules));
  if (matches.some((match) => !match)) return null;
  const classifiedMatches = matches as NonNullable<ReturnType<typeof classifyByDomain>>[];
  if (classifiedMatches.length === 0) return null;
  const firstWorkspaceId = classifiedMatches[0].workspace.id;
  if (!classifiedMatches.every((match) => match.workspace.id === firstWorkspaceId)) return null;
  return { workspace: classifiedMatches[0].workspace, confidence: Math.min(...classifiedMatches.map((match) => match.confidence)) };
}

function entityMatchesPattern(entity: Pick<EntityPlan, "domains" | "url" | "urls">, pattern: string): boolean {
  return entity.domains.some((domain) => matchesPattern(pattern, domain, `https://${domain}/`))
    || entity.urls.some((url) => matchesPattern(pattern, domainForUrl(url), url))
    || matchesPattern(pattern, domainForUrl(entity.url), entity.url);
}

function entityLabel(entity: Pick<EntityPlan, "entityType">): string {
  return entity.entityType === "folder" ? "Folder" : "Group";
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
