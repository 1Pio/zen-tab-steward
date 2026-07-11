import { createSemanticDecision } from "../domain/change.js";
import { sha256Canonical } from "../domain/digest.js";
import { destinationAllowedByPolicy } from "../workspace-policy.js";
import {
  boundedDataLabel,
  compileSortPlan,
  engineEvidenceText,
  notRequested
} from "./plan-compiler.js";
import {
  buildWorkspaceProfileCorpus,
  WORKSPACE_PROFILE_CORPUS_LIMITS,
  WORKSPACE_PROFILE_CORPUS_SCHEMA
} from "./workspace-profile.js";

import type { Plan, SemanticDecisionEvidence, UnknownDecisionEvidence } from "../domain/change.js";
import type { Entity, EntityMember, EntityRef, Snapshot, Workspace } from "../domain/snapshot.js";
import type { Sha256Digest } from "../domain/digest.js";
import type {
  SortPlanEngine,
  SortPolicyOptions,
  SortProposal,
  SortProposalContext
} from "./plan-compiler.js";
import type {
  CanonicalWorkspaceProfile,
  MovementRootProfileSummary,
  WorkspaceProfileCorpus
} from "./workspace-profile.js";

const LEXICAL_LIMITS = Object.freeze({
  maxMovementRoots: 500,
  maxWorkspaces: 128,
  maxTokensPerField: 96,
  maxTokenBytes: 64,
  maxTermsPerVector: 512,
  maxRankedEvidence: 3
});

const ENGINE_MANIFEST_REVISION = sha256Canonical({
  engine: "lexical",
  implementation: "zts.lexical.provisional-2",
  network: "none",
  dependencies: "node-standard-library-only",
  input: "complete-bounded-movement-root-summary",
  workspaceProfileCorpus: WORKSPACE_PROFILE_CORPUS_SCHEMA,
  profileSignals: "name-rule-domain-strong-protected-weak-domain-balanced",
  profileContamination: "configured-inbox-and-source-weak-exemplars-excluded-source-weak-model-ignored",
  ranking: "bounded-weighted-sparse-cosine",
  allocation: "score-descending-margin-descending-stable-entity",
  tieBreak: "score-descending-workspace-id-code-unit",
  calibration: "uncalibrated-explicit-review-only",
  limits: { lexical: LEXICAL_LIMITS, profileCorpus: WORKSPACE_PROFILE_CORPUS_LIMITS }
});

const LEXICAL_MODEL_REVISION = sha256Canonical({
  kind: "deterministic-lexical",
  manifestRevision: ENGINE_MANIFEST_REVISION
});

const UNCALIBRATED_REVISION = sha256Canonical({
  engine: "lexical",
  status: "uncalibrated",
  automaticApply: "disabled",
  explicitReviewedPlanApply: "required"
});

const STOP_WORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "for", "from", "in", "is", "it",
  "of", "on", "or", "that", "the", "this", "to", "with", "www", "http", "https", "com",
  "net", "org", "html", "htm", "page", "new"
]);

export interface LexicalPlanOptions extends SortPolicyOptions {
  readonly suggestionThreshold: number;
  readonly minimumMargin: number;
  readonly inboxSelector: string;
  readonly domainRules: Readonly<Record<string, string>>;
}

export interface LexicalCandidateScore {
  readonly workspaceId: string;
  readonly workspaceName: string;
  readonly score: number;
}

interface WeightedVector {
  readonly terms: ReadonlyMap<string, number>;
  readonly norm: number;
}

interface ScoringProfile {
  readonly workspace: Workspace;
  readonly canonical: CanonicalWorkspaceProfile;
  readonly trustedVector: WeightedVector;
  readonly fullVector: WeightedVector;
  readonly contributions: ReadonlyMap<EntityRef, {
    readonly vector: WeightedVector;
    readonly trusted: boolean;
    readonly scale: number;
  }>;
}

export function lexicalPlanRequestRevision(
  options: Omit<LexicalPlanOptions, "now">
): Sha256Digest {
  return sha256Canonical({
    engine: "lexical",
    engineManifestRevision: ENGINE_MANIFEST_REVISION,
    scope: options.scope,
    configRevision: options.configRevision,
    sourceAllowlist: [...options.sourceAllowlist],
    destinationAllowlist: [...options.destinationAllowlist],
    destinationDenylist: [...options.destinationDenylist],
    only: [...options.only],
    except: [...options.except],
    includePinned: options.includePinned,
    includeEssentials: options.includeEssentials,
    limit: options.limit,
    autoApplyRequested: options.autoApplyRequested,
    suggestionThreshold: options.suggestionThreshold,
    minimumMargin: options.minimumMargin,
    inboxSelector: options.inboxSelector,
    domainRules: orderedRecord(options.domainRules)
  });
}

export function createLexicalPlan(snapshot: Snapshot, options: LexicalPlanOptions): Plan {
  validateOptions(snapshot, options);
  const corpus = buildWorkspaceProfileCorpus(snapshot, {
    inboxSelector: options.inboxSelector,
    sourceSelectors: options.scope.kind === "workspace" ? [options.scope.workspaceId] : [],
    domainRules: options.domainRules
  });
  const requestRevision = lexicalPlanRequestRevision(options);
  const profiles = buildScoringProfiles(snapshot, corpus);
  const planManifestRevision = sha256Canonical({
    engineManifestRevision: ENGINE_MANIFEST_REVISION,
    profileCorpusRevision: corpus.revision
  });
  const engine: SortPlanEngine = {
    id: "lexical",
    manifestRevision: planManifestRevision,
    requestRevision,
    propose: (context) => lexicalProposal(context, profiles, corpus, options),
    unknownDecision: (entity, message) => unknownDecision(entity, message)
  };
  return compileSortPlan(snapshot, options, engine);
}

function rankLexicalDestinations(
  context: SortProposalContext,
  profiles: ReadonlyMap<string, ScoringProfile>,
  options: Pick<LexicalPlanOptions, "destinationAllowlist" | "destinationDenylist">
): readonly LexicalCandidateScore[] {
  const query = vectorForMembers(context.members, "query");
  return [...profiles.values()]
    .filter(({ workspace, canonical }) =>
      canonical.destinationEligible
      && !workspace.protection.destination.protected
      && destinationAllowedByPolicy(
        workspace,
        options.destinationAllowlist,
        options.destinationDenylist
      )
    )
    .map((profile) => {
      // Ordinary current contents are weak destination evidence, and never
      // reinforce the Entity's current source. Authored names/rules and strong
      // pinned/essential exemplars remain available there.
      const sourceCandidate = profile.workspace.id === context.source.id;
      return {
        workspaceId: profile.workspace.id,
        workspaceName: profile.workspace.name,
        score: roundScore(cosineWithoutRoot(
          query,
          profile,
          sourceCandidate ? profile.trustedVector : profile.fullVector,
          context.entity.ref,
          sourceCandidate
        ))
      };
    })
    .sort((left, right) =>
      right.score - left.score
      || compareText(left.workspaceId, right.workspaceId)
    );
}

function lexicalProposal(
  context: SortProposalContext,
  profiles: ReadonlyMap<string, ScoringProfile>,
  corpus: WorkspaceProfileCorpus,
  options: LexicalPlanOptions
): SortProposal {
  if (context.members.length > WORKSPACE_PROFILE_CORPUS_LIMITS.maxMembersPerRoot) {
    const reason = `Movement Root has ${context.members.length} members; lexical classification requires complete input and the complete-input limit is ${WORKSPACE_PROFILE_CORPUS_LIMITS.maxMembersPerRoot}`;
    return { kind: "none", decision: unknownDecision(context.entity, reason), reason };
  }
  const candidates = rankLexicalDestinations(context, profiles, options);
  const top = candidates[0];
  if (!top) {
    const reason = "No destination Workspace remains after Inbox exclusion, Protection, and destination policy";
    return { kind: "none", decision: unknownDecision(context.entity, reason), reason };
  }
  const second = candidates[1] ?? null;
  const margin = roundScore(second ? top.score - second.score : top.score);
  const destination = profiles.get(top.workspaceId)?.workspace;
  if (!destination) throw new Error(`Lexical candidate ${top.workspaceId} has no Workspace profile`);
  const decision = lexicalDecision(context.entity, candidates, top.score, margin, options, corpus.revision);
  const suggested = top.score > 0 && decision.suggested;
  const reviewReason = top.score <= 0
    ? "Lexical Engine found no bounded token overlap with an eligible Workspace profile"
    : top.score < options.suggestionThreshold
      ? `Top lexical score ${formatScore(top.score)} is below threshold ${formatScore(options.suggestionThreshold)}`
      : margin < options.minimumMargin
        ? `Top lexical margin ${formatScore(margin)} is below minimum ${formatScore(options.minimumMargin)}`
        : "Lexical suggestion requires explicit review of the exact saved Plan";
  return {
    kind: "candidate",
    destination,
    decision,
    suggested,
    reviewReason,
    priority: { score: top.score, margin }
  };
}

function lexicalDecision(
  entity: Entity,
  candidates: readonly LexicalCandidateScore[],
  score: number,
  margin: number,
  options: Pick<LexicalPlanOptions, "suggestionThreshold" | "minimumMargin">,
  profileRevision: Sha256Digest
): SemanticDecisionEvidence {
  const visible = candidates.slice(0, LEXICAL_LIMITS.maxRankedEvidence);
  const ranking = visible.map((candidate, index) =>
    `${index + 1}. ${boundedDataLabel(candidate.workspaceName)} [${boundedDataLabel(candidate.workspaceId)}] ${formatScore(candidate.score)}`
  ).join("; ");
  return createSemanticDecision({
    engine: "lexical",
    explanation: engineEvidenceText(
      `Bounded lexical ranking (profile ${shortDigest(profileRevision)}): ${ranking}`,
      entity
    ),
    score,
    margin,
    thresholds: {
      suggestion: options.suggestionThreshold,
      autoApply: 1,
      minimumMargin: options.minimumMargin
    },
    modelRevision: sha256Canonical({
      lexicalModelRevision: LEXICAL_MODEL_REVISION,
      profileCorpusRevision: profileRevision
    }),
    calibrationRevision: UNCALIBRATED_REVISION,
    autoApplyRequested: false
  });
}

function unknownDecision(entity: Entity, message: string): UnknownDecisionEvidence {
  const explanation = engineEvidenceText(message, entity);
  return {
    engine: "lexical",
    trustClass: "unknown",
    explanation,
    evidenceRevision: sha256Canonical(explanation),
    autoApply: notRequested("Lexical automatic apply is disabled until calibration evidence exists")
  };
}

function buildScoringProfiles(
  snapshot: Snapshot,
  corpus: WorkspaceProfileCorpus
): ReadonlyMap<string, ScoringProfile> {
  const workspaces = new Map(snapshot.workspaces.map((workspace) => [workspace.id, workspace]));
  const profiles = new Map<string, ScoringProfile>();
  for (const canonical of corpus.profiles) {
    const workspace = workspaces.get(canonical.workspaceId);
    if (!workspace) throw new Error(`Workspace profile ${canonical.workspaceId} is outside the Snapshot`);
    const trusted = mutableTextVector(canonical.name.value, 4);
    for (const rule of canonical.ruleDomains) addProfileRule(trusted, rule.value, 3.2);
    const contributions = new Map<EntityRef, {
      vector: WeightedVector;
      trusted: boolean;
      scale: number;
    }>();
    const strongScale = canonical.strongExemplars.length === 0
      ? 0
      : 1.35 / Math.sqrt(canonical.strongExemplars.length);
    for (const exemplar of canonical.strongExemplars) {
      const vector = vectorForSummary(exemplar);
      addScaledVector(trusted, vector, strongScale);
      contributions.set(exemplar.entityRef, { vector, trusted: true, scale: strongScale });
    }
    const full = new Map(trusted);
    const weakScale = canonical.weakExemplars.length === 0
      ? 0
      : 0.28 / Math.sqrt(canonical.weakExemplars.length);
    for (const exemplar of canonical.weakExemplars) {
      const vector = vectorForSummary(exemplar);
      addScaledVector(full, vector, weakScale);
      contributions.set(exemplar.entityRef, { vector, trusted: false, scale: weakScale });
    }
    profiles.set(canonical.workspaceId, {
      workspace,
      canonical,
      trustedVector: finalizeVector(trusted),
      fullVector: finalizeVector(full),
      contributions
    });
  }
  return profiles;
}

function mutableTextVector(value: string, weight: number): Map<string, number> {
  const terms = new Map<string, number>();
  const tokens = tokenizeBounded(value);
  addTokens(terms, "word", tokens, weight);
  addTokens(terms, "gram", charTrigrams(tokens), weight * 0.0875);
  return terms;
}

function addProfileRule(target: Map<string, number>, value: string, weight: number): void {
  const url = urlTokens(value.replace(/^\*\./u, ""));
  const fallback = tokenizeBounded(value);
  const host = url.host.length > 0 ? url.host : fallback;
  addTokens(target, "host", host, weight);
  addTokens(target, "word", host, weight * 0.6);
}

function vectorForSummary(summary: MovementRootProfileSummary): WeightedVector {
  return vectorForMembers(
    summary.members.map((member) => ({ title: member.title.value, url: member.url.value })),
    "profile"
  );
}

function vectorForMembers(
  members: readonly Pick<EntityMember, "title" | "url">[],
  purpose: "query" | "profile"
): WeightedVector {
  if (members.length > WORKSPACE_PROFILE_CORPUS_LIMITS.maxMembersPerRoot) {
    throw new Error(`Lexical vector input exceeds the complete-input limit ${WORKSPACE_PROFILE_CORPUS_LIMITS.maxMembersPerRoot}`);
  }
  const terms = new Map<string, number>();
  for (const member of members) {
    const titleTokens = tokenizeBounded(member.title);
    const url = urlTokens(member.url);
    const fieldScale = purpose === "query" ? 1 : 0.72;
    addTokens(terms, "word", titleTokens, 2 * fieldScale);
    addTokens(terms, "gram", charTrigrams(titleTokens), 0.2 * fieldScale);
    addTokens(terms, "host", url.host, 3 * fieldScale);
    addTokens(terms, "word", url.host, 1.1 * fieldScale);
    addTokens(terms, "word", url.path, 0.65 * fieldScale);
  }
  return finalizeVector(terms);
}

function tokenizeBounded(value: string): string[] {
  const bounded = utf8Prefix(value, WORKSPACE_PROFILE_CORPUS_LIMITS.maxFieldBytes)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/gu, "")
    .toLocaleLowerCase("en-US");
  const tokens: string[] = [];
  for (const segment of bounded.split(/[^\p{L}\p{N}]+/u)) {
    if (tokens.length >= LEXICAL_LIMITS.maxTokensPerField) break;
    if (segment.length < 2 || STOP_WORDS.has(segment)) continue;
    const token = utf8Prefix(segment, LEXICAL_LIMITS.maxTokenBytes);
    if (!token || (/^\d+$/u.test(token) && token.length < 3)) continue;
    tokens.push(token);
  }
  return tokens;
}

function urlTokens(value: string): { readonly host: string[]; readonly path: string[] } {
  const bounded = utf8Prefix(value, WORKSPACE_PROFILE_CORPUS_LIMITS.maxFieldBytes);
  try {
    const parsed = new URL(bounded.includes("://") ? bounded : `https://${bounded}`);
    return { host: tokenizeBounded(parsed.hostname), path: tokenizeBounded(parsed.pathname) };
  } catch {
    return { host: [], path: tokenizeBounded(bounded) };
  }
}

function charTrigrams(tokens: readonly string[]): string[] {
  const grams: string[] = [];
  for (const token of tokens) {
    if (grams.length >= LEXICAL_LIMITS.maxTokensPerField) break;
    if (token.length <= 3) {
      grams.push(token);
      continue;
    }
    const maxForToken = Math.min(token.length - 2, 12);
    for (let index = 0; index < maxForToken; index += 1) {
      if (grams.length >= LEXICAL_LIMITS.maxTokensPerField) break;
      grams.push(token.slice(index, index + 3));
    }
  }
  return grams;
}

function addTokens(target: Map<string, number>, namespace: string, tokens: readonly string[], weight: number): void {
  const counts = new Map<string, number>();
  for (const token of tokens) counts.set(token, (counts.get(token) ?? 0) + 1);
  for (const [token, count] of counts) {
    const key = `${namespace}:${token}`;
    target.set(key, (target.get(key) ?? 0) + weight * (1 + Math.log(count)));
  }
}

function addScaledVector(target: Map<string, number>, vector: WeightedVector, scale: number): void {
  for (const [term, value] of vector.terms) target.set(term, (target.get(term) ?? 0) + value * scale);
}

function finalizeVector(terms: ReadonlyMap<string, number>): WeightedVector {
  const selected = [...terms.entries()]
    .filter(([, value]) => Number.isFinite(value) && value > 0)
    .sort((left, right) => right[1] - left[1] || compareText(left[0], right[0]))
    .slice(0, LEXICAL_LIMITS.maxTermsPerVector)
    .sort((left, right) => compareText(left[0], right[0]));
  let squared = 0;
  for (const [, value] of selected) squared += value * value;
  return { terms: new Map(selected), norm: Math.sqrt(squared) };
}

function cosineWithoutRoot(
  query: WeightedVector,
  profile: ScoringProfile,
  base: WeightedVector,
  excludedRootRef: EntityRef,
  trustedOnly: boolean
): number {
  if (query.norm === 0) return 0;
  const contribution = profile.contributions.get(excludedRootRef);
  const subtract = contribution && (!trustedOnly || contribution.trusted) ? contribution : null;
  if (!subtract) return cosine(query, base);
  let profileSquared = 0;
  for (const [term, value] of base.terms) {
    const adjusted = Math.max(0, value - (subtract.vector.terms.get(term) ?? 0) * subtract.scale);
    profileSquared += adjusted * adjusted;
  }
  const profileNorm = Math.sqrt(profileSquared);
  if (profileNorm === 0) return 0;
  let dot = 0;
  for (const [term, queryValue] of query.terms) {
    const adjusted = Math.max(
      0,
      (base.terms.get(term) ?? 0) - (subtract.vector.terms.get(term) ?? 0) * subtract.scale
    );
    dot += queryValue * adjusted;
  }
  return clamp(dot / (query.norm * profileNorm));
}

function cosine(left: WeightedVector, right: WeightedVector): number {
  if (left.norm === 0 || right.norm === 0) return 0;
  let dot = 0;
  const [small, large] = left.terms.size <= right.terms.size
    ? [left.terms, right.terms]
    : [right.terms, left.terms];
  for (const [term, value] of small) dot += value * (large.get(term) ?? 0);
  return clamp(dot / (left.norm * right.norm));
}

function validateOptions(snapshot: Snapshot, options: LexicalPlanOptions): void {
  const roots = snapshot.entities.filter((entity) => entity.parentRef === null && entity.structuralRootRef === entity.ref);
  if (roots.length > LEXICAL_LIMITS.maxMovementRoots) {
    throw new Error(`Lexical Engine supports at most ${LEXICAL_LIMITS.maxMovementRoots} Movement Roots per Plan`);
  }
  if (snapshot.workspaces.length > LEXICAL_LIMITS.maxWorkspaces) {
    throw new Error(`Lexical Engine supports at most ${LEXICAL_LIMITS.maxWorkspaces} Workspaces per Plan`);
  }
  if (!Number.isFinite(options.suggestionThreshold) || options.suggestionThreshold < 0 || options.suggestionThreshold > 1) {
    throw new Error("Lexical suggestion threshold must be between 0 and 1");
  }
  if (!Number.isFinite(options.minimumMargin) || options.minimumMargin < 0 || options.minimumMargin > 1) {
    throw new Error("Lexical minimum margin must be between 0 and 1");
  }
  if (options.autoApplyRequested) {
    throw new Error("Lexical automatic apply is unavailable until calibration evidence is recorded; review and explicitly apply the exact Plan instead");
  }
}

function utf8Prefix(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  let result = "";
  let used = 0;
  for (const character of value) {
    const bytes = Buffer.byteLength(character, "utf8");
    if (used + bytes > maxBytes) break;
    result += character;
    used += bytes;
  }
  return result;
}

function orderedRecord(value: Readonly<Record<string, string>>): Readonly<Record<string, string>> {
  return Object.fromEntries(Object.entries(value).sort(([left], [right]) => compareText(left, right)));
}

function roundScore(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round(clamp(value) * 1_000_000) / 1_000_000;
}

function clamp(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function formatScore(value: number): string {
  return value.toFixed(3);
}

function shortDigest(digest: string): string {
  return digest.slice("sha256:".length, "sha256:".length + 12);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
