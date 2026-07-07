import { RawTab, RawZenSession, SessionSummary, WorkspaceSummary } from "../session.js";
import { TabEmbeddingInput, WorkspaceProfileInput } from "./provider.js";
import { domainFromUrl, selectedTabEntry } from "../util.js";

const MAX_SAMPLES_PER_WORKSPACE = 24;

export function buildWorkspaceProfiles(
  session: RawZenSession,
  summary: SessionSummary,
  domainRules: Record<string, string>
): WorkspaceProfileInput[] {
  const ruleDomainsByWorkspace = indexRuleDomainsByWorkspace(domainRules);
  return summary.workspaces.map((workspace) => ({
    workspaceId: workspace.id,
    workspaceName: workspace.name,
    aliases: [],
    ruleDomains: ruleDomainsByWorkspace.get(workspace.name.toLowerCase()) ?? [],
    sampleTabs: sampleTabsForWorkspace(session, workspace, summary.workspaces)
  }));
}

export function buildTabEmbeddingInputs(
  session: RawZenSession,
  predicate: (tab: RawTab, index: number) => boolean
): TabEmbeddingInput[] {
  const tabs = Array.isArray(session.tabs) ? session.tabs : [];
  const out: TabEmbeddingInput[] = [];
  tabs.forEach((tab, index) => {
    if (!predicate(tab, index)) return;
    const input = tabToEmbeddingInput(tab, index);
    if (input) out.push(input);
  });
  return out;
}

export function tabToEmbeddingInput(tab: RawTab, index: number): TabEmbeddingInput | null {
  const entry = selectedTabEntry(tab);
  const url = entry?.url ?? (typeof tab.url === "string" ? tab.url : "about:blank");
  if (!url || url === "about:blank" && !entry?.title) return null;
  const title = (entry?.title ?? url) as string;
  const description = extractDescription(tab);
  return {
    entityId: String(tab.zenSyncId ?? tab.zenGlanceId ?? `${tab.zenWorkspace ?? "unknown"}:${index}`),
    title,
    url,
    domain: domainFromUrl(url),
    description
  };
}

function extractDescription(tab: RawTab): string {
  if (typeof tab.description === "string" && tab.description.trim()) return tab.description;
  const entries = Array.isArray(tab.entries) ? tab.entries : [];
  const meta: string[] = [];
  for (const entry of entries) {
    const value = entry;
    if (typeof value.description === "string" && value.description.trim()) meta.push(value.description);
    if (typeof value.searchText === "string" && value.searchText.trim()) meta.push(value.searchText);
  }
  return meta.join(" ").slice(0, 400);
}

function sampleTabsForWorkspace(
  session: RawZenSession,
  workspace: WorkspaceSummary,
  allWorkspaces: WorkspaceSummary[]
): TabEmbeddingInput[] {
  const tabs = Array.isArray(session.tabs) ? session.tabs : [];
  const others = new Set(allWorkspaces.filter((w) => w.id !== workspace.id).map((w) => w.id.toLowerCase()));
  const samples: TabEmbeddingInput[] = [];
  for (let index = 0; index < tabs.length; index += 1) {
    const tab = tabs[index];
    if (!tab || tab.zenWorkspace !== workspace.id) continue;
    if (tab.pinned || tab.zenEssential || tab.groupId || tab.zenLiveFolderItemId) continue;
    const input = tabToEmbeddingInput(tab, index);
    if (!input) continue;
    const domain = input.domain.toLowerCase();
    if (domain && [...others].some((otherId) => domain.includes(otherId))) {
      // weak heuristic only; do not reject on id substring alone
    }
    samples.push(input);
    if (samples.length >= MAX_SAMPLES_PER_WORKSPACE) break;
  }
  return samples;
}

function indexRuleDomainsByWorkspace(domainRules: Record<string, string>): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const [pattern, workspace] of Object.entries(domainRules)) {
    const key = workspace.toLowerCase();
    const list = map.get(key) ?? [];
    list.push(pattern);
    map.set(key, list);
  }
  return map;
}
