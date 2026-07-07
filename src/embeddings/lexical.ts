import { FieldWeights, TabEmbedding, TabEmbeddingInput, VectorRecord, WorkspaceEmbedding, WorkspaceProfileInput } from "./provider.js";

export const LEXICAL_PROVIDER_ID = "lexical-v1";
export const LEXICAL_PROVIDER_VERSION = "1";

const STOPWORDS = new Set<string>([
  "the", "a", "an", "and", "or", "of", "to", "in", "on", "for", "for", "with", "by", "is", "are",
  "be", "this", "that", "it", "as", "at", "from", "your", "you", "i", "we", "they", "he", "she",
  "but", "not", "if", "then", "so", "do", "does", "did", "has", "have", "had", "will", "would",
  "can", "could", "should", "new", "page", "view", "html", "htm", "www", "com", "net", "org",
  "http", "https", "amp", "via", "more", "most", "about", "into", "out", "up", "down"
]);

const MIN_TOKEN_LENGTH = 2;
const MAX_TERM_VALUE = 1e6;

export interface LexicalCorpus {
  documentFrequency: Map<string, number>;
  workspaceCount: number;
}

export interface LexicalVector {
  terms: VectorRecord;
  norm: number;
}

export function buildLexicalCorpus(workspaces: WorkspaceProfileInput[]): LexicalCorpus {
  const documentFrequency = new Map<string, number>();
  for (const workspace of workspaces) {
    const terms = new Set<string>();
    for (const term of profileTerms(workspace)) terms.add(term);
    for (const term of terms) documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
  }
  return { documentFrequency, workspaceCount: Math.max(1, workspaces.length) };
}

export function idf(corpus: LexicalCorpus, term: string): number {
  const df = corpus.documentFrequency.get(term) ?? 0;
  return Math.log(1 + corpus.workspaceCount / (1 + df));
}

export function buildTabLexicalVector(input: TabEmbeddingInput, weights: FieldWeights, corpus: LexicalCorpus): LexicalVector {
  const accumulated = new Map<string, number>();
  const description = input.description ?? "";
  const urlParts = parseUrlParts(input.url);

  accumulate(accumulated, "w", tokenize(input.title), weights.title);
  accumulate(accumulated, "g", charNgrams(tokenize(input.title)), weights.title * 0.25);
  accumulate(accumulated, "d", urlParts.siteTokens, weights.domain);
  accumulate(accumulated, "p", urlParts.pathTokens, weights.url * 0.5);
  accumulate(accumulated, "w", tokenize(description), weights.description);
  accumulate(accumulated, "g", charNgrams(tokenize(description)), weights.description * 0.2);
  for (const t of urlParts.siteTokens) {
    accumulate(accumulated, "g", charNgrams([t]), weights.domain * 0.3);
  }

  const terms: VectorRecord = {};
  let norm = 0;
  for (const [term, tf] of accumulated) {
    const weight = tf * idf(corpus, term);
    if (weight <= 0) continue;
    const capped = Math.min(weight, MAX_TERM_VALUE);
    terms[term] = capped;
    norm += capped * capped;
  }
  return { terms, norm: Math.sqrt(norm) };
}

export function buildWorkspaceLexicalVector(profile: WorkspaceProfileInput, weights: FieldWeights, corpus: LexicalCorpus): LexicalVector {
  const accumulated = new Map<string, number>();
  const termLists = profileTermsWithKind(profile, weights);
  for (const { kind, tokens, weight } of termLists) {
    accumulate(accumulated, kind, tokens, weight);
    accumulate(accumulated, "g", charNgrams(tokens), weight * 0.2);
  }

  const terms: VectorRecord = {};
  let norm = 0;
  for (const [term, tf] of accumulated) {
    const weight = tf * idf(corpus, term);
    if (weight <= 0) continue;
    const capped = Math.min(weight, MAX_TERM_VALUE);
    terms[term] = capped;
    norm += capped * capped;
  }
  return { terms, norm: Math.sqrt(norm) };
}

export function cosineSparse(a: LexicalVector, b: LexicalVector): number {
  if (a.norm === 0 || b.norm === 0) return 0;
  const [small, large] = Object.keys(a.terms).length <= Object.keys(b.terms).length ? [a, b] : [b, a];
  let dot = 0;
  for (const [term, value] of Object.entries(small.terms)) {
    const other = large.terms[term];
    if (other !== undefined) dot += value * other;
  }
  return dot / (a.norm * b.norm);
}

export function lexicalHash(input: TabEmbeddingInput): string {
  const parts = [normalize(input.title), normalize(input.url), normalize(input.description ?? "")];
  return fnv1a(parts.join("\u{1f}"));
}

interface ProfileTerm {
  kind: string;
  tokens: string[];
  weight: number;
}

function profileTermsWithKind(profile: WorkspaceProfileInput, weights: FieldWeights): ProfileTerm[] {
  const lists: ProfileTerm[] = [];
  lists.push({ kind: "w", tokens: tokenize(profile.workspaceName), weight: 2.4 });
  for (const alias of profile.aliases) {
    lists.push({ kind: "w", tokens: tokenize(alias), weight: 1.6 });
  }
  for (const domain of profile.ruleDomains) {
    const parts = tokenize(domain);
    lists.push({ kind: "d", tokens: parts, weight: 2.2 });
    lists.push({ kind: "w", tokens: parts, weight: 1.2 });
  }
  const samples = profile.sampleTabs.slice(0, 24);
  const sampleWeight = samples.length === 0 ? 0 : Math.max(0.25, 1.6 / samples.length);
  for (const tab of samples) {
    const urlParts = parseUrlParts(tab.url);
    lists.push({ kind: "w", tokens: tokenize(tab.title), weight: sampleWeight * weights.title });
    lists.push({ kind: "d", tokens: urlParts.siteTokens, weight: sampleWeight * weights.domain });
    lists.push({ kind: "p", tokens: urlParts.pathTokens, weight: sampleWeight * weights.url * 0.5 });
    if (tab.description) {
      lists.push({ kind: "w", tokens: tokenize(tab.description), weight: sampleWeight * weights.description });
    }
  }
  return lists;
}

function profileTerms(profile: WorkspaceProfileInput): string[] {
  const terms: string[] = [];
  for (const term of profileTermsWithKind(profile, { title: 1, url: 1, domain: 1, description: 1 })) {
    for (const token of term.tokens) {
      terms.push(`${term.kind}:${token}`);
    }
  }
  return terms;
}

function accumulate(target: Map<string, number>, kind: string, tokens: string[], weight: number): void {
  if (weight <= 0) return;
  const tfMap = new Map<string, number>();
  for (const token of tokens) {
    if (!token) continue;
    tfMap.set(token, (tfMap.get(token) ?? 0) + 1);
  }
  for (const [token, count] of tfMap) {
    const term = `${kind}:${token}`;
    const contribution = weight * (1 + Math.log(count));
    target.set(term, (target.get(term) ?? 0) + contribution);
  }
}

export function tokenize(text: string): string[] {
  if (!text) return [];
  const normalized = normalize(text);
  const out: string[] = [];
  const segments = normalized.split(/[^a-z0-9]+/);
  for (const segment of segments) {
    if (segment.length < MIN_TOKEN_LENGTH) continue;
    if (STOPWORDS.has(segment)) continue;
    if (/^\d+$/.test(segment) && segment.length < 3) continue;
    out.push(segment);
  }
  return out;
}

export function charNgrams(tokens: string[], size = 3): string[] {
  const out: string[] = [];
  for (const token of tokens) {
    if (token.length <= size) {
      out.push(token);
      continue;
    }
    for (let i = 0; i <= token.length - size; i += 1) {
      out.push(token.slice(i, i + size));
    }
  }
  return out;
}

interface UrlParts {
  siteTokens: string[];
  pathTokens: string[];
}

export function parseUrlParts(url: string): UrlParts {
  let parsed: URL | null = null;
  try {
    parsed = new URL(url);
  } catch {
    const fallback = url.toLowerCase();
    const segments = fallback.split(/[^a-z0-9.-]+/).filter(Boolean);
    return { siteTokens: segments, pathTokens: [] };
  }
  const host = parsed.hostname.toLowerCase();
  const siteTokens = host.split(".").filter((segment) => segment && segment !== "www");
  const pathTokens = parsed.pathname
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((segment) => segment.length >= MIN_TOKEN_LENGTH && !STOPWORDS.has(segment));
  return { siteTokens, pathTokens };
}

function normalize(text: string): string {
  return text.toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "");
}

function fnv1a(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export async function embedTabsLexical(
  inputs: TabEmbeddingInput[],
  workspaces: WorkspaceProfileInput[],
  weights: FieldWeights
): Promise<TabEmbedding[]> {
  const corpus = buildLexicalCorpus(workspaces);
  return inputs.map((input) => ({
    entityId: input.entityId,
    hash: lexicalHash(input),
    sparse: buildTabLexicalVector(input, weights, corpus).terms
  }));
}

export async function embedWorkspacesLexical(
  profiles: WorkspaceProfileInput[],
  weights: FieldWeights
): Promise<WorkspaceEmbedding[]> {
  const corpus = buildLexicalCorpus(profiles);
  return profiles.map((profile) => {
    const vector = buildWorkspaceLexicalVector(profile, weights, corpus);
    return {
      workspaceId: profile.workspaceId,
      workspaceName: profile.workspaceName,
      sparse: vector.terms
    };
  });
}

export function sparseVectorNorm(terms: VectorRecord): number {
  let sum = 0;
  for (const value of Object.values(terms)) sum += value * value;
  return Math.sqrt(sum);
}

export function cosineSparseRecords(a: VectorRecord, aNorm: number, b: VectorRecord, bNorm: number): number {
  if (aNorm === 0 || bNorm === 0) return 0;
  const [small, large] = Object.keys(a).length <= Object.keys(b).length ? [a, b] : [b, a];
  let dot = 0;
  for (const [term, value] of Object.entries(small)) {
    const other = large[term];
    if (other !== undefined) dot += value * other;
  }
  return dot / (aNorm * bNorm);
}
