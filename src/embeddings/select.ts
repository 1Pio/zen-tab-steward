import { ZtsConfig } from "../config.js";
import { EmbeddingsProvider } from "./provider.js";
import { lexicalProvider } from "./lexical-provider.js";
import { ensureNeuralProvider, neuralProvider } from "./neural-provider.js";

export interface ResolvedProvider {
  provider: EmbeddingsProvider;
  denseAvailable: boolean;
  blockers: string[];
}

export async function resolveProvider(config: ZtsConfig): Promise<ResolvedProvider> {
  const provider = config.embeddings.provider;
  if (provider === "built-in") {
    return { provider: lexicalProvider, denseAvailable: false, blockers: [] };
  }

  // bge-small / hybrid need the optional Transformers.js neural provider.
  if (config.embeddings.allowDownload || config.embeddings.provider !== "built-in") {
    await ensureNeuralProvider({
      model: config.embeddings.model,
      cacheDir: config.embeddings.cacheDir,
      allowDownload: config.embeddings.allowDownload
    });
  }
  const status = await neuralProvider.status();
  if (!status.available) {
    return {
      provider: lexicalProvider,
      denseAvailable: false,
      blockers: status.blockers.length > 0 ? status.blockers : ["neural provider is not ready"]
    };
  }
  if (provider === "bge-small") {
    return { provider: neuralProvider, denseAvailable: true, blockers: [] };
  }
  // hybrid: combine lexical + dense is handled at scoring time via denseAvailable flag;
  // the lexical provider still produces sparse vectors used alongside dense.
  return { provider: neuralProvider, denseAvailable: true, blockers: [] };
}

