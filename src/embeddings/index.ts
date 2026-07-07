import { ProfileContext } from "../profile.js";
import { RawZenSession, SessionSummary, WorkspaceSummary } from "../session.js";
import { FieldWeights, EmbeddingsProvider, TabEmbeddingInput, WorkspaceEmbedding, WorkspaceProfileInput } from "./provider.js";
import { buildTabEmbeddingInputs, buildWorkspaceProfiles } from "./profile.js";
import { scoreTabAgainstWorkspaces, SemanticCandidate, SemanticDecision, SemanticOptions } from "./score.js";

export interface SemanticContext {
  context: ProfileContext;
  session: RawZenSession;
  summary: SessionSummary;
  domainRules: Record<string, string>;
  provider: EmbeddingsProvider;
  options: SemanticOptions;
}

export interface SemanticMatchReport {
  entityId: string;
  decision: SemanticDecision;
}

export interface SemanticBatchReport {
  candidates: Array<{ entityId: string; candidates: SemanticCandidate[] }>;
  ready: boolean;
}

export async function buildWorkspaceEmbeddings(input: {
  session: RawZenSession;
  summary: SessionSummary;
  domainRules: Record<string, string>;
  provider: EmbeddingsProvider;
  weights: FieldWeights;
}): Promise<{ profiles: WorkspaceProfileInput[]; workspaces: WorkspaceEmbedding[] }> {
  const profiles = buildWorkspaceProfiles(input.session, input.summary, input.domainRules);
  const workspaces = await input.provider.embedWorkspaces(profiles, input.weights);
  return { profiles, workspaces };
}

export async function scoreTabsSemantically(input: {
  session: RawZenSession;
  summary: SessionSummary;
  domainRules: Record<string, string>;
  provider: EmbeddingsProvider;
  weights: FieldWeights;
  options: SemanticOptions;
  tabs: TabEmbeddingInput[];
  sourceWorkspaceId?: string;
}): Promise<Map<string, SemanticDecision>> {
  const { profiles, workspaces } = await buildWorkspaceEmbeddings({
    session: input.session,
    summary: input.summary,
    domainRules: input.domainRules,
    provider: input.provider,
    weights: input.weights
  });
  const exclude = new Set<string>(input.sourceWorkspaceId ? [input.sourceWorkspaceId] : []);
  const embeddings = await input.provider.embedTabs(input.tabs, profiles, input.weights);
  const results = new Map<string, SemanticDecision>();
  for (const embedding of embeddings) {
    const decision = scoreTabAgainstWorkspaces(embedding, workspaces, profiles, input.summary.workspaces, input.options, exclude);
    results.set(embedding.entityId, decision);
  }
  return results;
}

export function defaultSemanticOptions(denseAvailable: boolean, config: { minConfidence: number; minMargin: number; reviewOnTie: boolean }): SemanticOptions {
  return {
    fieldWeights: { title: 1, url: 0.7, domain: 1.2, description: 0.6 },
    componentWeights: { lexical: 0.45, dense: 0.4, domain: 0.15 },
    minConfidence: config.minConfidence,
    minMargin: config.minMargin,
    reviewOnTie: config.reviewOnTie,
    denseAvailable
  };
}

export function candidateForWorkspace(summaries: WorkspaceSummary[], workspaceId: string): WorkspaceSummary | undefined {
  return summaries.find((w) => w.id === workspaceId);
}

export type { SemanticCandidate, SemanticDecision };
