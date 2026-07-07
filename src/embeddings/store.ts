import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { stateDir } from "../paths.js";
import { RawZenSession, SessionSummary } from "../session.js";
import { sanitizePathSegment } from "../util.js";
import { EmbeddingsProvider, FieldWeights, TabEmbedding, WorkspaceEmbedding } from "./provider.js";
import { buildWorkspaceProfiles, buildTabEmbeddingInputs } from "./profile.js";

const INDEX_VERSION = 1;

export interface IndexedTabEmbedding extends TabEmbedding {
  title: string;
  url: string;
}

export interface IndexRecord {
  version: number;
  provider: string;
  providerVersion: string;
  createdAt: string;
  updatedAt: string;
  profileId: string;
  fieldWeights: FieldWeights;
  workspaces: WorkspaceEmbedding[];
  tabs: IndexedTabEmbedding[];
}

export interface IndexBuildReport {
  record: IndexRecord;
  total: number;
  indexed: number;
  reused: number;
  workspaceCount: number;
  path: string;
}

export function indexRootForProfile(profileId: string): string {
  return join(stateDir(), "embeddings", sanitizePathSegment(profileId));
}

export function indexFilePath(profileId: string): string {
  return join(indexRootForProfile(profileId), "index.json");
}

export async function loadIndex(profileId: string): Promise<IndexRecord | null> {
  try {
    const raw = await readFile(indexFilePath(profileId), "utf8");
    const parsed = JSON.parse(raw) as IndexRecord;
    if (parsed.version !== INDEX_VERSION) return null;
    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function removeIndex(profileId: string): Promise<void> {
  await rm(indexRootForProfile(profileId), { recursive: true, force: true });
}

export async function buildIndex(input: {
  profileId: string;
  session: RawZenSession;
  summary: SessionSummary;
  domainRules: Record<string, string>;
  provider: EmbeddingsProvider;
  weights: FieldWeights;
  reuse?: IndexRecord | null;
}): Promise<IndexBuildReport> {
  const profiles = buildWorkspaceProfiles(input.session, input.summary, input.domainRules);
  const workspaces = await input.provider.embedWorkspaces(profiles, input.weights);
  const tabs = buildTabEmbeddingInputs(input.session, () => true);
  const reuseByHash = new Map<string, IndexedTabEmbedding>();
  for (const tab of input.reuse?.tabs ?? []) reuseByHash.set(tab.hash, tab);

  const embeddings = await input.provider.embedTabs(tabs, profiles, input.weights);
  const now = new Date().toISOString();
  const previous = input.reuse;
  const indexedTabs: IndexedTabEmbedding[] = [];
  let indexed = 0;
  let reused = 0;
  for (let i = 0; i < embeddings.length; i += 1) {
    const embedding = embeddings[i];
    const tabInput = tabs[i];
    const cached = reuseByHash.get(embedding.hash);
    if (cached && cached.sparse && embedding.sparse && sameKeys(cached.sparse, embedding.sparse)) {
      indexedTabs.push({ ...cached, title: tabInput.title, url: tabInput.url });
      reused += 1;
    } else {
      indexedTabs.push({
        entityId: embedding.entityId,
        hash: embedding.hash,
        domain: embedding.domain,
        sparse: embedding.sparse,
        dense: embedding.dense,
        title: tabInput.title,
        url: tabInput.url
      });
      indexed += 1;
    }
  }

  const record: IndexRecord = {
    version: INDEX_VERSION,
    provider: input.provider.id,
    providerVersion: input.provider.version,
    createdAt: previous?.createdAt ?? now,
    updatedAt: now,
    profileId: input.profileId,
    fieldWeights: input.weights,
    workspaces,
    tabs: indexedTabs
  };

  const path = indexFilePath(input.profileId);
  await mkdir(indexRootForProfile(input.profileId), { recursive: true });
  await writeFile(path, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  return { record, total: indexedTabs.length, indexed, reused, workspaceCount: workspaces.length, path };
}

export function indexProfileMismatch(record: IndexRecord | null, profileId: string): string | null {
  if (!record) return "no embeddings index found for this profile";
  if (record.profileId !== profileId) return "embeddings index belongs to a different profile";
  return null;
}

function sameKeys(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  for (const key of aKeys) if (!(key in b)) return false;
  return true;
}
