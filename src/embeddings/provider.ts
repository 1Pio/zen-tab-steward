import { WorkspaceSummary } from "../session.js";

export type EmbeddingProviderKind = "sparse" | "dense" | "hybrid";

export interface FieldWeights {
  title: number;
  url: number;
  domain: number;
  description: number;
}

export interface TabEmbeddingInput {
  entityId: string;
  title: string;
  url: string;
  domain: string;
  description?: string;
}

export interface WorkspaceProfileInput {
  workspaceId: string;
  workspaceName: string;
  aliases: string[];
  ruleDomains: string[];
  sampleTabs: TabEmbeddingInput[];
}

export interface VectorRecord {
  [term: string]: number;
}

export interface TabEmbedding {
  entityId: string;
  hash: string;
  sparse?: VectorRecord;
  dense?: number[];
}

export interface WorkspaceEmbedding {
  workspaceId: string;
  workspaceName: string;
  sparse?: VectorRecord;
  dense?: number[];
}

export interface ProviderCapabilities {
  sparse: boolean;
  dense: boolean;
  denseDimensions: number | null;
}

export interface ProviderStatus {
  id: string;
  available: boolean;
  kind: EmbeddingProviderKind;
  requiresInstall: boolean;
  capabilities: ProviderCapabilities;
  blockers: string[];
  detail: string;
}

export interface EmbeddingsProvider {
  readonly id: string;
  readonly version: string;
  readonly kind: EmbeddingProviderKind;
  readonly requiresInstall: boolean;
  status(): Promise<ProviderStatus>;
  embedTabs(inputs: TabEmbeddingInput[], workspaces: WorkspaceProfileInput[], weights: FieldWeights): Promise<TabEmbedding[]>;
  embedWorkspaces(inputs: WorkspaceProfileInput[], weights: FieldWeights): Promise<WorkspaceEmbedding[]>;
}

export interface ScoredWorkspace {
  workspace: WorkspaceSummary;
  lexicalScore: number;
  denseScore: number;
  domainAffinity: number;
  score: number;
  evidence: string[];
}

export const DEFAULT_FIELD_WEIGHTS: FieldWeights = {
  title: 1.0,
  url: 0.7,
  domain: 1.2,
  description: 0.6
};
