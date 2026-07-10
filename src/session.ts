import { readJsonLz4 } from "./mozlz4.js";
import { SessionFileSource } from "./profile.js";
import { ZtsConfig } from "./config.js";

export interface RawZenSession {
  spaces?: RawWorkspace[];
  tabs?: RawTab[];
  folders?: RawFolder[];
  groups?: RawGroup[];
  [key: string]: unknown;
}

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
  protected: boolean;
  protectionReasons: string[];
}

export async function loadSessionSummary(source: SessionFileSource): Promise<SessionSummary> {
  return summarizeSession(await loadSession(source), source);
}

export async function loadSession(source: SessionFileSource): Promise<RawZenSession> {
  const decoded = await readJsonLz4(source.path);
  return assertRawSession(decoded);
}

export function summarizeSession(session: RawZenSession, source: SessionFileSource): SessionSummary {
  const rawSpaces = Array.isArray(session.spaces) ? session.spaces : [];
  const rawTabs = Array.isArray(session.tabs) ? session.tabs : [];
  const rawFolders = Array.isArray(session.folders) ? session.folders : [];
  const rawGroups = Array.isArray(session.groups) ? session.groups : [];
  const groupWorkspaceIds = inferGroupWorkspaceIds(rawTabs);

  const workspaceIds = new Set<string>();
  for (const space of rawSpaces) if (space.uuid) workspaceIds.add(space.uuid);
  for (const tab of rawTabs) if (tab.zenWorkspace) workspaceIds.add(tab.zenWorkspace);
  for (const folder of rawFolders) if (folder.workspaceId) workspaceIds.add(folder.workspaceId);

  const workspaces = Array.from(workspaceIds).map((id, order) => {
    const rawSpace = rawSpaces.find((space) => space.uuid === id);
    const tabs = rawTabs.filter((tab) => tab.zenWorkspace === id);
    const folders = rawFolders.filter((folder) => folder.workspaceId === id);
    const groups = rawGroups.filter((group) => group.id && groupWorkspaceIds.get(group.id) === id);

    return {
      id,
      name: rawSpace?.name || id,
      order,
      tabCount: tabs.length,
      pinnedCount: tabs.filter((tab) => tab.pinned).length,
      essentialCount: tabs.filter((tab) => tab.zenEssential).length,
      folderCount: folders.length,
      groupCount: groups.length,
      folderGroupCount: folders.length + groups.length,
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
    pinnedCount: rawTabs.filter((tab) => tab.pinned).length,
    essentialCount: rawTabs.filter((tab) => tab.zenEssential).length,
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
  const sortFrom = new Set(config.sort.from.map(normalizeName));
  const sortTo = new Set(config.sort.to.map(normalizeName));
  const sortNotTo = new Set(config.sort.notTo.map(normalizeName));

  return {
    ...summary,
    workspaces: summary.workspaces.map((workspace) => {
      const names = workspaceNameKeys(workspace);
      const protectedFrom = names.some((name) => fromProtected.has(name));
      const protectedTo = names.some((name) => toProtected.has(name));
      const explicitlyAllowedFrom = sortFrom.size === 0 || names.some((name) => sortFrom.has(name));
      const explicitlyAllowedTo = sortTo.size === 0 || names.some((name) => sortTo.has(name));
      const explicitlyDeniedTo = names.some((name) => sortNotTo.has(name));
      return {
        ...workspace,
        protectedStatus: protectedFrom && protectedTo ? "from_to" : protectedFrom ? "from" : protectedTo ? "to" : "none",
        defaultInbox: names.includes(defaultInbox),
        sortableFrom: !protectedFrom && explicitlyAllowedFrom,
        sortableTo: !protectedTo && explicitlyAllowedTo && !explicitlyDeniedTo
      };
    })
  };
}

export function listTabs(session: RawZenSession, summary: SessionSummary, workspaceFilter?: string): TabSummary[] {
  const rawTabs = Array.isArray(session.tabs) ? session.tabs : [];
  const lookup = workspaceFilter ? normalizeName(workspaceFilter) : "";
  const workspaces = new Map(summary.workspaces.map((workspace) => [workspace.id, workspace]));
  return rawTabs
    .map((tab, index) => {
      const workspace = tab.zenWorkspace ? workspaces.get(tab.zenWorkspace) : undefined;
      const entry = selectedEntry(tab);
      const url = entry?.url ?? "about:blank";
      const groupId = typeof tab.groupId === "string" ? tab.groupId : null;
      const folderId = typeof tab.zenLiveFolderItemId === "string" ? tab.zenLiveFolderItemId : null;
      const protectionReasons = tabProtectionReasons(tab);
      return {
        id: String(tab.zenSyncId ?? tab.zenGlanceId ?? `tab:${index}`),
        index,
        title: entry?.title ?? url,
        url,
        domain: domainForUrl(url),
        workspaceId: tab.zenWorkspace ?? null,
        workspaceName: workspace?.name ?? null,
        pinned: Boolean(tab.pinned),
        essential: Boolean(tab.zenEssential),
        grouped: Boolean(groupId),
        foldered: Boolean(folderId),
        groupId,
        folderId,
        hidden: Boolean(tab.hidden),
        protected: protectionReasons.length > 0,
        protectionReasons
      };
    })
    .filter((tab) => {
      if (!lookup) return true;
      return normalizeName(tab.workspaceId ?? "") === lookup || normalizeName(tab.workspaceName ?? "") === lookup;
    });
}

function assertRawSession(value: unknown): RawZenSession {
  if (!value || typeof value !== "object") {
    throw new Error("Zen session JSON is not an object");
  }
  return value as RawZenSession;
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
