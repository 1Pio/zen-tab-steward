import { EmbeddingsProvider, FieldWeights, ProviderStatus, TabEmbedding, TabEmbeddingInput, WorkspaceEmbedding, WorkspaceProfileInput } from "./provider.js";

const NEURAL_PROVIDER_ID = "bge-small";
const NEURAL_PROVIDER_VERSION = "1";
const DEFAULT_MODEL = "Xenova/bge-small-en-v1.5";

interface TransformersModule {
  pipeline: (task: string, model: string, options?: { quantized?: boolean }) => Promise<Pipeline>;
  env: { allowLocalModels?: boolean; cacheDir?: string; allowRemoteModels?: boolean };
}

interface Pipeline {
  (texts: string[], options: { pooling: "mean"; normalize: boolean }): Promise<{ data: number[] } & ArrayLike<unknown> & { tolist?: () => number[][] }>;
}

interface LazyTransformers {
  module: TransformersModule | null;
  pipeline: Pipeline | null;
  error: string | null;
}

const lazy = lazyTransformers();

function lazyTransformers() {
  const state: { current: LazyTransformers } = { current: { module: null, pipeline: null, error: null } };
  return {
    get state(): LazyTransformers {
      return state.current;
    },
    async init(model: string, cacheDir: string, allowDownload: boolean): Promise<LazyTransformers> {
      if (state.current.pipeline || state.current.error) return state.current;
      const mod = await loadTransformers();
      if (!mod) {
        state.current = { module: null, pipeline: null, error: "transformers package not installed" };
        return state.current;
      }
      try {
        mod.env.allowRemoteModels = allowDownload;
        mod.env.allowLocalModels = true;
        if (cacheDir) mod.env.cacheDir = cacheDir;
        const pipe = await mod.pipeline("feature-extraction", model, { quantized: true });
        state.current = { module: mod, pipeline: pipe, error: null };
        return state.current;
      } catch (error) {
        state.current = { module: mod, pipeline: null, error: error instanceof Error ? error.message : String(error) };
        return state.current;
      }
    },
    reset(): void {
      state.current = { module: null, pipeline: null, error: null };
    }
  };
}

async function loadTransformers(): Promise<TransformersModule | null> {
  for (const name of ["@huggingface/transformers", "@xenova/transformers"]) {
    try {
      const mod = await import(/* @vite-ignore */ name) as TransformersModule;
      if (mod && typeof mod.pipeline === "function") return mod;
    } catch {
      continue;
    }
  }
  return null;
}

export async function ensureNeuralProvider(options: { model?: string; cacheDir?: string; allowDownload?: boolean }): Promise<LazyTransformers> {
  return lazy.init(options.model ?? DEFAULT_MODEL, options.cacheDir ?? "", Boolean(options.allowDownload));
}

export const neuralProvider: EmbeddingsProvider = {
  id: NEURAL_PROVIDER_ID,
  version: NEURAL_PROVIDER_VERSION,
  kind: "dense",
  requiresInstall: true,

  async status(): Promise<ProviderStatus> {
    return {
      id: NEURAL_PROVIDER_ID,
      available: Boolean(lazy.state.pipeline),
      kind: "dense",
      requiresInstall: true,
      capabilities: { sparse: false, dense: true, denseDimensions: 384 },
      blockers: neuralBlockers(lazy.state),
      detail: lazy.state.pipeline
        ? "local dense embeddings via Transformers.js (bge-small-en-v1.5)"
        : "opt-in neural provider; install with `npm install @huggingface/transformers` then `zts embeddings install bge-small`"
    };
  },

  async embedTabs(inputs: TabEmbeddingInput[], _workspaces: WorkspaceProfileInput[], _weights: FieldWeights): Promise<TabEmbedding[]> {
    const state = lazy.state;
    if (!state.pipeline) throw new Error("neural provider not initialised");
    const texts = inputs.map((input) => embedText(input));
    const vectors = await runPipeline(state.pipeline, texts);
    return inputs.map((input, index) => ({
      entityId: input.entityId,
      hash: "",
      domain: input.domain,
      dense: vectors[index]
    }));
  },

  async embedWorkspaces(inputs: WorkspaceProfileInput[], _weights: FieldWeights): Promise<WorkspaceEmbedding[]> {
    const state = lazy.state;
    if (!state.pipeline) throw new Error("neural provider not initialised");
    const texts = inputs.map((input) => workspaceEmbedText(input));
    const vectors = await runPipeline(state.pipeline, texts);
    return inputs.map((input, index) => ({
      workspaceId: input.workspaceId,
      workspaceName: input.workspaceName,
      dense: vectors[index]
    }));
  }
};

function neuralBlockers(state: LazyTransformers): string[] {
  if (state.pipeline) return [];
  if (state.error === "transformers package not installed") {
    return [
      "Transformers.js is not installed in the zts install directory",
      "run: npm install @huggingface/transformers  (in the zts package directory)",
      "then: zts embeddings install bge-small"
    ];
  }
  if (state.error) return [`neural provider initialisation failed: ${state.error}`];
  return ["neural provider has not been initialised; run `zts embeddings install bge-small`"];
}

function embedText(input: TabEmbeddingInput): string {
  return [input.title, input.domain, input.url, input.description ?? ""].filter(Boolean).join(" ");
}

function workspaceEmbedText(profile: WorkspaceProfileInput): string {
  return [
    profile.workspaceName,
    profile.aliases.join(" "),
    profile.ruleDomains.join(" "),
    profile.sampleTabs.slice(0, 8).map((tab) => tab.title).join(" ")
  ].filter(Boolean).join(" ");
}

async function runPipeline(pipe: Pipeline, texts: string[]): Promise<number[][]> {
  const result = await pipe(texts, { pooling: "mean", normalize: true }) as { tolist?: () => number[][]; data: number[] };
  if (typeof result.tolist === "function") return result.tolist();
  const width = Math.floor(result.data.length / Math.max(1, texts.length));
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += 1) out.push(result.data.slice(i * width, (i + 1) * width));
  return out;
}
