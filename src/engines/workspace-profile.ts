import { sha256Canonical } from "../domain/digest.js";
import { movementRootMembers } from "./plan-compiler.js";

import type { EntityRef, Snapshot, Workspace } from "../domain/snapshot.js";
import type { Sha256Digest } from "../domain/digest.js";

export const WORKSPACE_PROFILE_CORPUS_LIMITS = Object.freeze({
  maxMembersPerRoot: 64,
  maxStrongExemplarsPerWorkspace: 24,
  maxWeakExemplarsPerWorkspace: 24,
  maxFieldBytes: 4 * 1024
});

export const WORKSPACE_PROFILE_CORPUS_SCHEMA = "zts.workspace-profile-corpus.provisional-1" as const;

export interface WorkspaceProfileCorpusOptions {
  readonly inboxSelector: string;
  readonly sourceSelectors: readonly string[];
  readonly domainRules: Readonly<Record<string, string>>;
}

export interface BoundedProfileText {
  readonly value: string;
  readonly truncated: boolean;
}

export interface MovementRootProfileSummary {
  readonly entityRef: EntityRef;
  readonly entityRevision: Sha256Digest;
  readonly workspaceId: string;
  readonly memberCount: number;
  readonly members: readonly {
    readonly title: BoundedProfileText;
    readonly url: BoundedProfileText;
  }[];
  readonly primaryDomain: string;
  readonly protectionReasons: readonly string[];
}

export interface CanonicalWorkspaceProfile {
  readonly workspaceId: string;
  readonly name: BoundedProfileText;
  /** Current config has no description/alias/negative-example grammar yet. */
  readonly description: null;
  readonly aliases: readonly [];
  readonly ruleDomains: readonly BoundedProfileText[];
  readonly strongExemplars: readonly MovementRootProfileSummary[];
  readonly weakExemplars: readonly MovementRootProfileSummary[];
  readonly negativeExamples: readonly [];
  readonly ordinaryCurrentRootsIncluded: boolean;
  readonly destinationEligible: boolean;
}

export interface WorkspaceProfileCorpus {
  readonly schemaVersion: typeof WORKSPACE_PROFILE_CORPUS_SCHEMA;
  readonly revision: Sha256Digest;
  readonly inboxWorkspaceId: string | null;
  readonly sourceWorkspaceIds: readonly string[];
  readonly unresolvedRules: readonly {
    readonly pattern: BoundedProfileText;
    readonly workspaceSelector: BoundedProfileText;
    readonly reason: "missing" | "ambiguous";
  }[];
  readonly excludedRoots: readonly {
    readonly entityRef: EntityRef;
    readonly memberCount: number;
    readonly reason: "member_limit";
  }[];
  readonly profiles: readonly CanonicalWorkspaceProfile[];
}

/**
 * Builds the one bounded, revisioned Workspace-profile corpus shared by local
 * ranking Engines. It treats names and exact rules as authored profile input,
 * pinned/essential roots as stronger examples, and ordinary current roots as
 * weak evidence sampled deterministically across domains. Inbox and explicit
 * source Workspaces never learn from their ordinary current contents.
 */
export function buildWorkspaceProfileCorpus(
  snapshot: Snapshot,
  options: WorkspaceProfileCorpusOptions
): WorkspaceProfileCorpus {
  const workspaces = [...snapshot.workspaces].sort((left, right) => compareText(left.id, right.id));
  const lookup = workspaceLookup(workspaces);
  const inboxWorkspaceId = resolveSelector(lookup, options.inboxSelector).workspace?.id ?? null;
  const sourceWorkspaceIds = [...new Set(options.sourceSelectors.flatMap((selector) => {
    const resolved = resolveSelector(lookup, selector);
    return resolved.workspace ? [resolved.workspace.id] : [];
  }))].sort(compareText);
  const sourceOnlyProfiles = new Set([
    ...(inboxWorkspaceId ? [inboxWorkspaceId] : []),
    ...sourceWorkspaceIds
  ]);

  const ruleDomains = new Map<string, BoundedProfileText[]>();
  const unresolvedRules: WorkspaceProfileCorpus["unresolvedRules"][number][] = [];
  for (const [pattern, selector] of Object.entries(options.domainRules).sort(([left], [right]) => compareText(left, right))) {
    const resolved = resolveSelector(lookup, selector);
    if (!resolved.workspace) {
      unresolvedRules.push({
        pattern: boundedText(pattern),
        workspaceSelector: boundedText(selector),
        reason: resolved.status
      });
      continue;
    }
    const values = ruleDomains.get(resolved.workspace.id) ?? [];
    values.push(boundedText(pattern));
    ruleDomains.set(resolved.workspace.id, values);
  }

  const entities = new Map(snapshot.entities.map((entity) => [entity.ref, entity]));
  const completeByWorkspace = new Map<string, MovementRootProfileSummary[]>();
  const excludedRoots: WorkspaceProfileCorpus["excludedRoots"][number][] = [];
  const roots = snapshot.entities
    .filter((entity) => entity.parentRef === null && entity.structuralRootRef === entity.ref)
    .sort((left, right) => compareText(left.ref, right.ref));
  for (const root of roots) {
    const members = movementRootMembers(root, entities);
    if (members.length > WORKSPACE_PROFILE_CORPUS_LIMITS.maxMembersPerRoot) {
      excludedRoots.push({
        entityRef: root.ref,
        memberCount: members.length,
        reason: "member_limit"
      });
      continue;
    }
    const summary: MovementRootProfileSummary = {
      entityRef: root.ref,
      entityRevision: root.revision,
      workspaceId: root.workspaceId,
      memberCount: members.length,
      members: members.map((member) => ({
        title: boundedText(member.title),
        url: boundedText(member.url)
      })),
      primaryDomain: primaryDomain(members.map((member) => member.url)),
      protectionReasons: [...root.protection.reasons]
    };
    const values = completeByWorkspace.get(root.workspaceId) ?? [];
    values.push(summary);
    completeByWorkspace.set(root.workspaceId, values);
  }

  const profiles = workspaces.map((workspace): CanonicalWorkspaceProfile => {
    const rootsForWorkspace = completeByWorkspace.get(workspace.id) ?? [];
    const strong = rootsForWorkspace.filter(isStrongExemplar);
    const weak = rootsForWorkspace.filter((root) => !isStrongExemplar(root));
    const ordinaryCurrentRootsIncluded = !sourceOnlyProfiles.has(workspace.id);
    return {
      workspaceId: workspace.id,
      name: boundedText(workspace.name),
      description: null,
      aliases: [],
      ruleDomains: [...(ruleDomains.get(workspace.id) ?? [])]
        .sort((left, right) => compareText(left.value, right.value)),
      strongExemplars: domainBalanced(
        strong,
        WORKSPACE_PROFILE_CORPUS_LIMITS.maxStrongExemplarsPerWorkspace
      ),
      weakExemplars: ordinaryCurrentRootsIncluded
        ? domainBalanced(weak, WORKSPACE_PROFILE_CORPUS_LIMITS.maxWeakExemplarsPerWorkspace)
        : [],
      negativeExamples: [],
      ordinaryCurrentRootsIncluded,
      // Configured intake/source Workspaces are not learned destinations.
      destinationEligible: !sourceOnlyProfiles.has(workspace.id)
    };
  });
  const content = {
    schemaVersion: WORKSPACE_PROFILE_CORPUS_SCHEMA,
    inboxWorkspaceId,
    sourceWorkspaceIds,
    unresolvedRules,
    excludedRoots,
    profiles
  };
  return deepFreeze({ ...content, revision: sha256Canonical(content) });
}

function domainBalanced(
  roots: readonly MovementRootProfileSummary[],
  limit: number
): readonly MovementRootProfileSummary[] {
  const byDomain = new Map<string, MovementRootProfileSummary[]>();
  for (const root of [...roots].sort((left, right) => compareText(left.entityRef, right.entityRef))) {
    const values = byDomain.get(root.primaryDomain) ?? [];
    values.push(root);
    byDomain.set(root.primaryDomain, values);
  }
  const domains = [...byDomain.keys()].sort(compareText);
  const selected: MovementRootProfileSummary[] = [];
  for (let depth = 0; selected.length < limit; depth += 1) {
    let added = false;
    for (const domain of domains) {
      const root = byDomain.get(domain)?.[depth];
      if (!root) continue;
      selected.push(root);
      added = true;
      if (selected.length >= limit) break;
    }
    if (!added) break;
  }
  return selected;
}

function isStrongExemplar(root: MovementRootProfileSummary): boolean {
  return root.protectionReasons.includes("pinned") || root.protectionReasons.includes("essential");
}

function primaryDomain(urls: readonly string[]): string {
  const domains = urls.flatMap((value) => {
    try {
      return [new URL(value).hostname.toLocaleLowerCase("en-US")];
    } catch {
      return [];
    }
  }).filter(Boolean).sort(compareText);
  return domains[0] ?? "(no-domain)";
}

interface WorkspaceLookup {
  readonly exactIds: ReadonlyMap<string, Workspace>;
  readonly normalized: ReadonlyMap<string, readonly Workspace[]>;
}

function workspaceLookup(workspaces: readonly Workspace[]): WorkspaceLookup {
  const exactIds = new Map<string, Workspace>();
  const normalized = new Map<string, Workspace[]>();
  for (const workspace of workspaces) {
    exactIds.set(workspace.id, workspace);
    for (const key of new Set([normalize(workspace.id), normalize(workspace.name)])) {
      const values = normalized.get(key) ?? [];
      values.push(workspace);
      normalized.set(key, values);
    }
  }
  return { exactIds, normalized };
}

function resolveSelector(
  lookup: WorkspaceLookup,
  selector: string
): { readonly status: "resolved"; readonly workspace: Workspace }
  | { readonly status: "missing" | "ambiguous"; readonly workspace: null } {
  const exact = lookup.exactIds.get(selector);
  if (exact) return { status: "resolved", workspace: exact };
  const candidates = lookup.normalized.get(normalize(selector)) ?? [];
  if (candidates.length === 1) return { status: "resolved", workspace: candidates[0]! };
  return { status: candidates.length === 0 ? "missing" : "ambiguous", workspace: null };
}

function boundedText(value: string): BoundedProfileText {
  const bounded = utf8Prefix(value, WORKSPACE_PROFILE_CORPUS_LIMITS.maxFieldBytes);
  return { value: bounded, truncated: bounded !== value };
}

function utf8Prefix(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  let output = "";
  let used = 0;
  for (const character of value) {
    const bytes = Buffer.byteLength(character, "utf8");
    if (used + bytes > maxBytes) break;
    output += character;
    used += bytes;
  }
  return output;
}

function normalize(value: string): string {
  return value.trim().toLocaleLowerCase("en-US");
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
  }
  return value;
}
