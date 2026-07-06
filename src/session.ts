import { readJsonLz4 } from "./mozlz4.js";
import { SessionFileSource } from "./profile.js";

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
  protectionStatus: "unconfigured";
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
      protectionStatus: "unconfigured" as const
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

function assertRawSession(value: unknown): RawZenSession {
  if (!value || typeof value !== "object") {
    throw new Error("Zen session JSON is not an object");
  }
  return value as RawZenSession;
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
