import { readJsonLz4 } from "./mozlz4.js";
import { SessionFileSource } from "./profile.js";
import { ZtsConfig } from "./config.js";
import { destinationAllowedByPolicy, workspaceAllowedByPolicy } from "./workspace-policy.js";

export interface RawZenSession {
  spaces?: RawWorkspace[];
  tabs?: RawTab[];
  folders?: RawFolder[];
  groups?: RawGroup[];
  splitViewData?: RawSplitView[];
  [key: string]: unknown;
}

export const SESSION_STRUCTURE_LIMITS = Object.freeze({
  maxTabs: 10_000,
  maxFolders: 2_000,
  maxGroups: 2_000,
  maxSplitViews: 1_000,
  maxEntities: 12_000,
  maxMembersPerMovementRoot: 2_000,
  maxFolderDepth: 32,
  maxNativeIdLength: 512,
  maxNativeIdBytes: 512
});

export interface RawWorkspace {
  uuid?: string;
  name?: string;
  icon?: string;
  hasCollapsedPinnedTabs?: boolean;
  [key: string]: unknown;
}

export interface RawTab {
  entries?: Array<{ url?: string; title?: string; [key: string]: unknown }>;
  index?: number;
  pinned?: boolean;
  hidden?: boolean;
  zenWorkspace?: string;
  zenEssential?: boolean;
  _zenIsActiveTab?: boolean;
  zenSyncId?: string;
  zenGlanceId?: string;
  groupId?: string;
  zenLiveFolderItemId?: string | null;
  [key: string]: unknown;
}

export interface RawFolder {
  id?: string;
  name?: string;
  workspaceId?: string;
  pinned?: boolean;
  collapsed?: boolean;
  splitViewGroup?: boolean;
  parentId?: string | null;
  [key: string]: unknown;
}

export interface RawGroup {
  id?: string;
  name?: string;
  pinned?: boolean;
  splitView?: boolean;
  collapsed?: boolean;
  [key: string]: unknown;
}

export interface RawSplitView {
  groupId?: string;
  tabs?: string[];
  gridType?: unknown;
  layoutTree?: unknown;
  [key: string]: unknown;
}

export const ZEN_SESSION_SCHEMA_FAMILY = "zen-session-v1" as const;

export function detectZenSessionSchemaFamily(session: RawZenSession): typeof ZEN_SESSION_SCHEMA_FAMILY | null {
  return Array.isArray(session.spaces)
    && Array.isArray(session.tabs)
    && Array.isArray(session.folders)
    && Array.isArray(session.groups)
    && Array.isArray(session.splitViewData)
    ? ZEN_SESSION_SCHEMA_FAMILY
    : null;
}

export interface WorkspaceSummary {
  id: string;
  name: string;
  order: number;
  tabCount: number;
  pinnedCount: number;
  essentialCount: number;
  folderCount: number;
  groupCount: number;
  folderGroupCount: number;
  protectedStatus: "none" | "from" | "to" | "from_to";
  defaultInbox: boolean;
  sortableFrom: boolean;
  sortableTo: boolean;
}

export interface SessionSummary {
  source: SessionFileSource;
  workspaceCount: number;
  tabCount: number;
  pinnedCount: number;
  essentialCount: number;
  folderCount: number;
  groupCount: number;
  folderGroupCount: number;
  workspaces: WorkspaceSummary[];
}

export interface TabSummary {
  id: string;
  nativeId: string | null;
  index: number;
  title: string;
  url: string;
  domain: string;
  workspaceId: string | null;
  workspaceName: string | null;
  pinned: boolean;
  essential: boolean;
  grouped: boolean;
  foldered: boolean;
  groupId: string | null;
  folderId: string | null;
  hidden: boolean;
  active: boolean;
  protected: boolean;
  protectionReasons: string[];
}

export async function loadSessionSummary(source: SessionFileSource): Promise<SessionSummary> {
  return summarizeSession(await loadSession(source), source);
}

export async function loadSession(source: SessionFileSource): Promise<RawZenSession> {
  const decoded = await readJsonLz4(source.path);
  return defineRawSession(decoded);
}

export function defineRawSession(value: unknown): RawZenSession {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Zen session JSON is not an object");
  }
  const session = value as RawZenSession;
  assertRawSessionStructure(session);
  return session;
}

export function assertRawSessionStructure(session: RawZenSession): void {
  const spaces = boundedRecordArray(session.spaces, "spaces", SESSION_STRUCTURE_LIMITS.maxEntities);
  const tabs = boundedRecordArray(session.tabs, "tabs", SESSION_STRUCTURE_LIMITS.maxTabs);
  const folders = boundedRecordArray(session.folders, "folders", SESSION_STRUCTURE_LIMITS.maxFolders);
  const groups = boundedRecordArray(session.groups, "groups", SESSION_STRUCTURE_LIMITS.maxGroups);
  const splitViews = boundedRecordArray(session.splitViewData, "splitViewData", SESSION_STRUCTURE_LIMITS.maxSplitViews);
  if (spaces.length + tabs.length + folders.length + groups.length + splitViews.length > SESSION_STRUCTURE_LIMITS.maxEntities) {
    throw new Error(`Zen session structural record count exceeds ${SESSION_STRUCTURE_LIMITS.maxEntities}`);
  }
  for (const [index, tab] of tabs.entries()) {
    if (tab.entries !== undefined) boundedRecordArray(tab.entries, `tabs[${index}].entries`, SESSION_STRUCTURE_LIMITS.maxTabs);
    assertOptionalIdentifier(tab.zenSyncId, `tabs[${index}].zenSyncId`);
    assertOptionalIdentifier(tab.zenGlanceId, `tabs[${index}].zenGlanceId`);
    assertOptionalIdentifier(tab.zenWorkspace, `tabs[${index}].zenWorkspace`);
    assertOptionalIdentifier(tab.groupId, `tabs[${index}].groupId`);
    assertOptionalIdentifier(tab.zenLiveFolderItemId, `tabs[${index}].zenLiveFolderItemId`);
    assertOptionalBoolean(tab._zenIsActiveTab, `tabs[${index}]._zenIsActiveTab`);
  }
  for (const [index, split] of splitViews.entries()) {
    assertOptionalIdentifier(split.groupId, `splitViewData[${index}].groupId`);
    if (split.tabs !== undefined) {
      boundedIdentifierArray(
        split.tabs,
        `splitViewData[${index}].tabs`,
        SESSION_STRUCTURE_LIMITS.maxMembersPerMovementRoot
      );
    }
  }
}

export function summarizeSession(session: RawZenSession, source: SessionFileSource): SessionSummary {
  const rawSpaces = Array.isArray(session.spaces) ? session.spaces : [];
  const rawTabs = Array.isArray(session.tabs) ? session.tabs : [];
  const rawFolders = Array.isArray(session.folders) ? session.folders : [];
  const rawGroups = Array.isArray(session.groups) ? session.groups : [];
  const groupWorkspaceIds = inferGroupWorkspaceIds(rawTabs);

  const workspaceIds = new Set<string>();
  const spaceById = new Map<string, RawWorkspace>();
  const countsByWorkspace = new Map<string, {
    tabCount: number;
    pinnedCount: number;
    essentialCount: number;
    folderCount: number;
    groupCount: number;
  }>();
  const countsFor = (id: string) => {
    let counts = countsByWorkspace.get(id);
    if (!counts) {
      counts = { tabCount: 0, pinnedCount: 0, essentialCount: 0, folderCount: 0, groupCount: 0 };
      countsByWorkspace.set(id, counts);
    }
    return counts;
  };
  for (const space of rawSpaces) {
    if (!space.uuid) continue;
    workspaceIds.add(space.uuid);
    if (!spaceById.has(space.uuid)) spaceById.set(space.uuid, space);
  }
  let pinnedCount = 0;
  let essentialCount = 0;
  for (const tab of rawTabs) {
    if (tab.pinned) pinnedCount += 1;
    if (tab.zenEssential) essentialCount += 1;
    if (!tab.zenWorkspace) continue;
    workspaceIds.add(tab.zenWorkspace);
    const counts = countsFor(tab.zenWorkspace);
    counts.tabCount += 1;
    if (tab.pinned) counts.pinnedCount += 1;
    if (tab.zenEssential) counts.essentialCount += 1;
  }
  for (const folder of rawFolders) {
    if (!folder.workspaceId) continue;
    workspaceIds.add(folder.workspaceId);
    countsFor(folder.workspaceId).folderCount += 1;
  }
  for (const group of rawGroups) {
    if (!group.id) continue;
    const workspaceId = groupWorkspaceIds.get(group.id);
    if (workspaceId) countsFor(workspaceId).groupCount += 1;
  }

  const workspaces = Array.from(workspaceIds).map((id, order) => {
    const rawSpace = spaceById.get(id);
    const counts = countsFor(id);

    return {
      id,
      name: rawSpace?.name || id,
      order,
      tabCount: counts.tabCount,
      pinnedCount: counts.pinnedCount,
      essentialCount: counts.essentialCount,
      folderCount: counts.folderCount,
      groupCount: counts.groupCount,
      folderGroupCount: counts.folderCount + counts.groupCount,
      protectedStatus: "none" as const,
      defaultInbox: false,
      sortableFrom: true,
      sortableTo: true
    };
  });

  workspaces.sort((a, b) => a.order - b.order);

  return {
    source,
    workspaceCount: workspaces.length,
    tabCount: rawTabs.length,
    pinnedCount,
    essentialCount,
    folderCount: rawFolders.length,
    groupCount: rawGroups.length,
    folderGroupCount: rawFolders.length + rawGroups.length,
    workspaces
  };
}

export function withWorkspacePolicy(summary: SessionSummary, config: ZtsConfig): SessionSummary {
  const fromProtected = new Set(config.protect.workspaces.from.map(normalizeName));
  const toProtected = new Set(config.protect.workspaces.to.map(normalizeName));
  const defaultInbox = normalizeName(config.defaults.inbox);

  return {
    ...summary,
    workspaces: summary.workspaces.map((workspace) => {
      const names = workspaceNameKeys(workspace);
      const protectedFrom = names.some((name) => fromProtected.has(name));
      const protectedTo = names.some((name) => toProtected.has(name));
      const explicitlyAllowedFrom = workspaceAllowedByPolicy(workspace, config.sort.from);
      const explicitlyAllowedTo = destinationAllowedByPolicy(workspace, config.sort.to, config.sort.notTo);
      return {
        ...workspace,
        protectedStatus: protectedFrom && protectedTo ? "from_to" : protectedFrom ? "from" : protectedTo ? "to" : "none",
        defaultInbox: names.includes(defaultInbox),
        sortableFrom: !protectedFrom && explicitlyAllowedFrom,
        sortableTo: !protectedTo && explicitlyAllowedTo
      };
    })
  };
}

export function listTabs(session: RawZenSession, summary: SessionSummary, workspaceFilter?: string): TabSummary[] {
  const rawTabs = Array.isArray(session.tabs) ? session.tabs : [];
  const lookup = workspaceFilter ? normalizeName(workspaceFilter) : "";
  const workspaces = new Map(summary.workspaces.map((workspace) => [workspace.id, workspace]));
  const candidateNativeIds = rawTabs.map((tab, index) => rawTabNativeId(tab, index));
  const nativeIdCounts = new Map<string, number>();
  for (const nativeId of candidateNativeIds) {
    if (nativeId) nativeIdCounts.set(nativeId, (nativeIdCounts.get(nativeId) ?? 0) + 1);
  }
  return rawTabs
    .map((tab, index) => {
      const workspaceId = optionalIdentifier(tab.zenWorkspace, `tabs[${index}].zenWorkspace`);
      const workspace = workspaceId ? workspaces.get(workspaceId) : undefined;
      const entry = selectedEntry(tab);
      const url = entry?.url ?? "about:blank";
      const groupId = optionalIdentifier(tab.groupId, `tabs[${index}].groupId`);
      const folderId = optionalIdentifier(tab.zenLiveFolderItemId, `tabs[${index}].zenLiveFolderItemId`);
      const protectionReasons = tabProtectionReasons(tab);
      const candidateNativeId = candidateNativeIds[index] ?? null;
      // Only a native value unique within this exact source is mutation-grade
      // identity. Ambiguous or absent values remain visible through an
      // observation-only id and are ineligible for executable Operations.
      const nativeId = candidateNativeId && nativeIdCounts.get(candidateNativeId) === 1
        ? candidateNativeId
        : null;
      return {
        id: nativeId ?? `tab:${index}`,
        nativeId,
        index,
        title: entry?.title ?? url,
        url,
        domain: domainForUrl(url),
        workspaceId,
        workspaceName: workspace?.name ?? null,
        pinned: Boolean(tab.pinned),
        essential: Boolean(tab.zenEssential),
        grouped: Boolean(groupId),
        foldered: Boolean(folderId),
        groupId,
        folderId,
        hidden: Boolean(tab.hidden),
        active: Boolean(tab._zenIsActiveTab),
        protected: protectionReasons.length > 0,
        protectionReasons
      };
    })
    .filter((tab) => {
      if (!lookup) return true;
      return normalizeName(tab.workspaceId ?? "") === lookup || normalizeName(tab.workspaceName ?? "") === lookup;
    });
}

function rawTabNativeId(tab: RawTab, index: number): string | null {
  const syncId = optionalIdentifier(tab.zenSyncId, `tabs[${index}].zenSyncId`);
  if (syncId) return syncId;
  return optionalIdentifier(tab.zenGlanceId, `tabs[${index}].zenGlanceId`);
}

function selectedEntry(tab: RawTab) {
  const entries = Array.isArray(tab.entries) ? tab.entries : [];
  if (entries.length === 0) return undefined;
  const rawIndex = typeof tab.index === "number" ? tab.index - 1 : entries.length - 1;
  const index = Math.min(Math.max(rawIndex, 0), entries.length - 1);
  return entries[index];
}

function tabProtectionReasons(tab: RawTab): string[] {
  const reasons: string[] = [];
  if (tab.pinned) reasons.push("pinned");
  if (tab.zenEssential) reasons.push("essential");
  if (tab.groupId) reasons.push("grouped");
  if (tab.zenLiveFolderItemId) reasons.push("foldered");
  return reasons;
}

function domainForUrl(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

function inferGroupWorkspaceIds(tabs: RawTab[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const tab of tabs) {
    const groupId = typeof tab.groupId === "string" ? tab.groupId : undefined;
    const workspaceId = typeof tab.zenWorkspace === "string" ? tab.zenWorkspace : undefined;
    if (groupId && workspaceId && !map.has(groupId)) {
      map.set(groupId, workspaceId);
    }
  }
  return map;
}

function workspaceNameKeys(workspace: WorkspaceSummary): string[] {
  return [normalizeName(workspace.id), normalizeName(workspace.name)];
}

function normalizeName(value: string): string {
  return value.trim().toLowerCase();
}

function boundedRecordArray<T>(value: T[] | undefined, label: string, limit: number): T[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`Zen session ${label} must be an array`);
  if (value.length > limit) throw new Error(`Zen session ${label} exceeds the ${limit}-record limit`);
  for (const [index, record] of value.entries()) {
    if (!record || typeof record !== "object" || Array.isArray(record)) {
      throw new Error(`Zen session ${label}[${index}] must be an object`);
    }
  }
  return value;
}

function assertOptionalIdentifier(value: unknown, label: string): void {
  optionalIdentifier(value, label);
}

function assertOptionalBoolean(value: unknown, label: string): void {
  if (value !== undefined && typeof value !== "boolean") throw new Error(`Zen session ${label} must be boolean`);
}

function boundedIdentifierArray(value: unknown, label: string, limit: number): string[] {
  if (!Array.isArray(value)) throw new Error(`Zen session ${label} must be an array`);
  if (value.length > limit) throw new Error(`Zen session ${label} exceeds the ${limit}-member limit`);
  return value.map((item, index) => {
    const id = optionalIdentifier(item, `${label}[${index}]`);
    if (!id) throw new Error(`Zen session ${label}[${index}] is required`);
    return id;
  });
}

function optionalIdentifier(value: unknown, label: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !value.trim()) throw new Error(`Zen session ${label} must be a non-empty string`);
  const normalized = value.trim();
  if (normalized.length > SESSION_STRUCTURE_LIMITS.maxNativeIdLength) {
    throw new Error(`Zen session ${label} exceeds the ${SESSION_STRUCTURE_LIMITS.maxNativeIdLength}-character id limit`);
  }
  if (Buffer.byteLength(normalized, "utf8") > SESSION_STRUCTURE_LIMITS.maxNativeIdBytes) {
    throw new Error(`Zen session ${label} exceeds the ${SESSION_STRUCTURE_LIMITS.maxNativeIdBytes}-byte UTF-8 id limit`);
  }
  return normalized;
}
