import { FieldWeights, ScoredWorkspace, TabEmbedding, WorkspaceEmbedding, WorkspaceProfileInput } from "./provider.js";
import { WorkspaceSummary } from "../session.js";
import { cosineSparseRecords, sparseVectorNorm } from "./lexical.js";

export interface ComponentWeights {
  lexical: number;
  dense: number;
  domain: number;
}

export interface SemanticOptions {
  fieldWeights: FieldWeights;
  componentWeights: ComponentWeights;
  minConfidence: number;
  minMargin: number;
  reviewOnTie: boolean;
  denseAvailable: boolean;
}

export interface SemanticCandidate {
  workspaceId: string;
  workspaceName: string;
  lexicalScore: number;
  denseScore: number;
  domainAffinity: number;
  score: number;
  evidence: string[];
}

export interface SemanticDecision {
  candidates: SemanticCandidate[];
  top: SemanticCandidate | null;
  second: SemanticCandidate | null;
  margin: number;
  score: number;
  move: boolean;
  reason: string;
}

export function scoreTabAgainstWorkspaces(
  tab: TabEmbedding,
  workspaceEmbeddings: WorkspaceEmbedding[],
  workspaceProfiles: WorkspaceProfileInput[],
  workspaceSummaries: WorkspaceSummary[],
  options: SemanticOptions,
  excludeWorkspaceIds: Set<string> = new Set()
): SemanticDecision {
  const candidates: SemanticCandidate[] = [];
  const tabSparse = tab.sparse;
  const tabDense = tab.dense;
  const tabNorm = tabSparse ? sparseVectorNorm(tabSparse) : 0;

  for (const workspaceEmbedding of workspaceEmbeddings) {
    if (excludeWorkspaceIds.has(workspaceEmbedding.workspaceId)) continue;
    const summary = workspaceSummaries.find((w) => w.id === workspaceEmbedding.workspaceId);
    if (!summary || !summary.sortableTo) continue;
    const profile = workspaceProfiles.find((p) => p.workspaceId === workspaceEmbedding.workspaceId);

    const lexicalScore = tabSparse && workspaceEmbedding.sparse
      ? clamp(cosineSparseRecords(tabSparse, tabNorm, workspaceEmbedding.sparse, sparseVectorNorm(workspaceEmbedding.sparse)))
      : 0;
    const denseScore = options.denseAvailable && tabDense && workspaceEmbedding.dense
      ? clamp(dot(tabDense, workspaceEmbedding.dense))
      : 0;
    const domainAffinity = profile ? domainAffinityFor(tab, profile) : 0;
    const score = combine({ lexical: lexicalScore, dense: denseScore, domain: domainAffinity }, options);
    const evidence = explain({ lexicalScore, denseScore, domainAffinity, profile });
    candidates.push({
      workspaceId: workspaceEmbedding.workspaceId,
      workspaceName: workspaceEmbedding.workspaceName,
      lexicalScore: round(lexicalScore),
      denseScore: round(denseScore),
      domainAffinity: round(domainAffinity),
      score: round(score),
      evidence
    });
  }

  candidates.sort((a, b) => b.score - a.score);
  const top = candidates[0] ?? null;
  const second = candidates[1] ?? null;
  const margin = top && second ? top.score - second.score : top ? top.score : 0;

  if (!top) return emptyDecision(candidates, "no_sortable_destination");
  if (top.score < options.minConfidence) {
    return { candidates, top, second, margin, score: top.score, move: false, reason: "below_semantic_min_confidence" };
  }
  if (margin < options.minMargin) {
    return { candidates, top, second, margin, score: top.score, move: false, reason: options.reviewOnTie ? "semantic_tie_review" : "below_semantic_min_margin" };
  }
  return { candidates, top, second, margin, score: top.score, move: true, reason: "semantic_affinity" };
}

export function combine(scores: { lexical: number; dense: number; domain: number }, options: SemanticOptions): number {
  const cw = options.componentWeights;
  const totalWeight = cw.lexical + (options.denseAvailable ? cw.dense : 0) + cw.domain;
  if (totalWeight <= 0) return 0;
  const lexicalW = cw.lexical / totalWeight;
  const domainW = cw.domain / totalWeight;
  const denseW = options.denseAvailable ? cw.dense / totalWeight : 0;
  return scores.lexical * lexicalW + scores.dense * denseW + scores.domain * domainW;
}

function domainAffinityFor(tab: TabEmbedding, profile: WorkspaceProfileInput): number {
  const tabDomain = tab.domain ?? "";
  if (!tabDomain) return 0;
  const normalized = tabDomain.toLowerCase();
  let best = 0;
  const ruleDomains = profile.ruleDomains.map((d) => d.toLowerCase());
  for (const rule of ruleDomains) {
    best = Math.max(best, domainSimilarity(normalized, rule, /*ruleBoost=*/ true));
  }
  for (const sample of profile.sampleTabs) {
    const sampleDomain = (sample.domain ?? "").toLowerCase();
    if (!sampleDomain) continue;
    best = Math.max(best, domainSimilarity(normalized, sampleDomain, false));
  }
  return best;
}

function domainSimilarity(a: string, b: string, ruleBoost: boolean): number {
  if (!a || !b) return 0;
  if (a === b) return ruleBoost ? 1.0 : 0.85;
  const aParts = a.split(".");
  const bParts = b.split(".");
  const aRoot = aParts.slice(-2).join(".");
  const bRoot = bParts.slice(-2).join(".");
  if (aRoot && bRoot && (aRoot === bRoot || aRoot.endsWith(`.${bRoot}`) || bRoot.endsWith(`.${aRoot}`))) {
    return ruleBoost ? 0.7 : 0.5;
  }
  const aTokens = new Set(aParts);
  if (bParts.some((p) => aTokens.has(p) && p.length >= 3)) return 0.25;
  return 0;
}

function explain(input: { lexicalScore: number; denseScore: number; domainAffinity: number; profile?: WorkspaceProfileInput }): string[] {
  const evidence: string[] = [];
  if (input.lexicalScore >= 0.05) evidence.push(`lexical ${input.lexicalScore.toFixed(2)}`);
  if (input.denseScore >= 0.05) evidence.push(`dense ${input.denseScore.toFixed(2)}`);
  if (input.domainAffinity >= 0.05) evidence.push(`domain ${input.domainAffinity.toFixed(2)}`);
  return evidence;
}

function emptyDecision(candidates: SemanticCandidate[], reason: string): SemanticDecision {
  return { candidates, top: null, second: null, margin: 0, score: 0, move: false, reason };
}

function clamp(value: number, low = 0, high = 1): number {
  if (!Number.isFinite(value)) return low;
  return Math.max(low, Math.min(high, value));
}

function dot(a: number[], b: number[]): number {
  const len = Math.min(a.length, b.length);
  let sum = 0;
  for (let i = 0; i < len; i += 1) sum += a[i] * b[i];
  return sum;
}

function round(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round(value * 1000) / 1000;
}

export function toScoredWorkspace(candidate: SemanticCandidate, summary: WorkspaceSummary): ScoredWorkspace {
  return {
    workspace: summary,
    lexicalScore: candidate.lexicalScore,
    denseScore: candidate.denseScore,
    domainAffinity: candidate.domainAffinity,
    score: candidate.score,
    evidence: candidate.evidence
  };
}
