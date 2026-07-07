import {
  EmbeddingsProvider,
  FieldWeights,
  ProviderStatus,
  TabEmbedding,
  TabEmbeddingInput,
  WorkspaceEmbedding,
  WorkspaceProfileInput
} from "./provider.js";
import { LEXICAL_PROVIDER_ID, LEXICAL_PROVIDER_VERSION, embedTabsLexical, embedWorkspacesLexical } from "./lexical.js";

export class LexicalProvider implements EmbeddingsProvider {
  readonly id = LEXICAL_PROVIDER_ID;
  readonly version = LEXICAL_PROVIDER_VERSION;
  readonly kind = "sparse" as const;
  readonly requiresInstall = false;

  async status(): Promise<ProviderStatus> {
    return {
      id: this.id,
      available: true,
      kind: this.kind,
      requiresInstall: false,
      capabilities: { sparse: true, dense: false, denseDimensions: null },
      blockers: [],
      detail: "field-aware lexical sparse embedder (TF-IDF + char n-grams); zero dependencies, offline"
    };
  }

  embedTabs(inputs: TabEmbeddingInput[], workspaces: WorkspaceProfileInput[], weights: FieldWeights): Promise<TabEmbedding[]> {
    return embedTabsLexical(inputs, workspaces, weights);
  }

  embedWorkspaces(inputs: WorkspaceProfileInput[], weights: FieldWeights): Promise<WorkspaceEmbedding[]> {
    return embedWorkspacesLexical(inputs, weights);
  }
}

export const lexicalProvider = new LexicalProvider();
