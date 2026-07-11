import { createPlan } from "../domain/change.js";
import { sha256Canonical } from "../domain/digest.js";
import { movementEligibility } from "../domain/snapshot.js";
import { urlMatchesAnyPattern, urlPatternSpecificity } from "../url-pattern.js";
import { destinationAllowedByPolicy, workspaceAllowedByPolicy } from "../workspace-policy.js";

import type {
  AutoApplyEvidence,
  DecisionEvidence,
  MoveProtectionPrecondition,
  Plan,
  PlanAction,
  RuleDecisionEvidence,
  UnknownDecisionEvidence,
  ZtsMessage
} from "../domain/change.js";
import type {
  Entity,
  EntityMember,
  EntityRef,
  MovementRootRef,
  Protection,
  Snapshot,
  Workspace
} from "../domain/snapshot.js";
import type { MovementEligibility } from "../domain/snapshot.js";
import type { Sha256Digest } from "../domain/digest.js";

const ENGINE_MANIFEST_REVISION = sha256Canonical({
  engine: "rules",
  implementation: "zts.rules.provisional-2",
  matching: "url-domain-subdomain-tld-specificity",
  entityInput: "complete-ordered-movement-root-closure",
  executionPolicy: "current-capability-aware"
});
const PLAN_TTL_MS = 5 * 60 * 1000;

export type SortScope =
  | { readonly kind: "all_workspaces" }
  | { readonly kind: "workspace"; readonly workspaceId: string };

export interface RulesPlanOptions {
  readonly scope: SortScope;
  readonly configRevision: Sha256Digest;
  readonly domainRules: Readonly<Record<string, string>>;
  readonly sourceAllowlist: readonly string[];
  readonly destinationAllowlist: readonly string[];
  readonly destinationDenylist: readonly string[];
  readonly only: readonly string[];
  readonly except: readonly string[];
  readonly includePinned: boolean;
  readonly includeEssentials: boolean;
  readonly limit: number | null;
  readonly autoApplyRequested: boolean;
  readonly now?: Date;
}

export interface RuleMatch {
  readonly workspaceName: string;
  readonly matchedPattern: string;
}

export type RuleWorkspaceResolution =
  | { readonly status: "resolved"; readonly workspace: Workspace }
  | { readonly status: "missing"; readonly matches: readonly [] }
  | { readonly status: "ambiguous"; readonly matches: readonly Workspace[] };

/**
 * The single deterministic URL/domain matcher used by both planning and the
 * `rules test` explanation surface. It intentionally knows no default routes:
 * only the caller's exact configured rules participate.
 */
export function classifyRuleForUrl(
  urlOrDomain: string,
  domainRules: Readonly<Record<string, string>>
): RuleMatch | null {
  const candidates = Object.entries(domainRules)
    .map(([pattern, workspaceName]) => ({
      pattern,
      workspaceName,
      score: urlPatternSpecificity(pattern, urlOrDomain)
    }))
    .filter((candidate) => candidate.score >= 0)
    .sort((left, right) =>
      right.score - left.score
      || compareText(left.pattern, right.pattern)
      || compareText(left.workspaceName, right.workspaceName)
    );
  const selected = candidates[0];
  return selected
    ? { workspaceName: selected.workspaceName, matchedPattern: selected.pattern }
    : null;
}

/** Resolves a configured destination without letting duplicate names win by iteration order. */
export function resolveRuleWorkspace(
  workspaces: readonly Workspace[],
  selector: string
): RuleWorkspaceResolution {
  return resolveWorkspaceLookup(workspaceNames(workspaces), selector);
}

export function rulesPlanRequestRevision(options: Omit<RulesPlanOptions, "now">): Sha256Digest {
  return sha256Canonical({
    engine: "rules",
    engineManifestRevision: ENGINE_MANIFEST_REVISION,
    scope: options.scope,
    configRevision: options.configRevision,
    domainRules: orderedRecord(options.domainRules),
    sourceAllowlist: [...options.sourceAllowlist],
    destinationAllowlist: [...options.destinationAllowlist],
    destinationDenylist: [...options.destinationDenylist],
    only: [...options.only],
    except: [...options.except],
    includePinned: options.includePinned,
    includeEssentials: options.includeEssentials,
    limit: options.limit,
    autoApplyRequested: options.autoApplyRequested
  });
}

export function createRulesPlan(snapshot: Snapshot, options: RulesPlanOptions): Plan {
  const now = options.now ?? new Date();
  const createdAt = canonicalTimestamp(now);
  const expiresAt = new Date(now.getTime() + PLAN_TTL_MS).toISOString();
  const workspaces = new Map(snapshot.workspaces.map((workspace) => [workspace.id, workspace]));
  const workspaceLookup = workspaceNames(snapshot.workspaces);
  const entities = new Map(snapshot.entities.map((entity) => [entity.ref, entity]));
  const requestRevision = rulesPlanRequestRevision(options);
  const actions: PlanAction[] = [];
  let moveCount = 0;

  for (const entity of snapshot.entities) {
    if (entity.parentRef !== null || entity.structuralRootRef !== entity.ref) continue;
    if (!entityInScope(entity, options.scope)) continue;
    const source = workspaces.get(entity.workspaceId);
    if (!source) throw new Error(`Entity ${entity.ref} references a missing source Workspace`);
    const members = movementRootMembers(entity, entities);
    const actionIdBase = { entityRef: entity.ref, requestRevision };

    if (source.protection.source.protected) {
      actions.push(unknownNonMoveAction(
        actionIdBase, entity, "protected", null,
        `Source Workspace ${source.name} is protected from sorting`,
        options.autoApplyRequested
      ));
      continue;
    }
    if (!workspaceAllowedByPolicy(source, options.sourceAllowlist)) {
      actions.push(unknownNonMoveAction(
        actionIdBase, entity, "blocked", null,
        `Source Workspace ${source.name} is outside the active source policy`,
        options.autoApplyRequested
      ));
      continue;
    }
    if (entity.protection.protected && !includedEntityProtection(entity.protection, options)) {
      actions.push(unknownNonMoveAction(
        actionIdBase, entity, "protected", null,
        `Entity is protected: ${entity.protection.reasons.join(", ")}`,
        options.autoApplyRequested
      ));
      continue;
    }
    if (membersMatchAny(members, options.except)) {
      actions.push(unknownNonMoveAction(
        actionIdBase, entity, "unchanged", null,
        "Entity is excluded by the active filter",
        options.autoApplyRequested
      ));
      continue;
    }
    if (options.only.length > 0 && !members.every((member) => matchesAny(member.url, options.only))) {
      actions.push(unknownNonMoveAction(
        actionIdBase, entity, "review", null,
        "Entity contains content outside the active only filter",
        options.autoApplyRequested
      ));
      continue;
    }

    const classification = classifyMembers(members, options.domainRules, workspaceLookup);
    if (classification.status !== "matched") {
      const dispositionReason = classification.status === "unmatched"
        ? "No exact routing rule matched this Entity"
        : classification.status === "invalid_destination"
          ? "A configured routing rule names a Workspace that does not exist in this Snapshot"
          : classification.status === "ambiguous_destination"
            ? "A configured routing rule names more than one Workspace in this Snapshot"
          : "Entity members matched different destination Workspaces";
      actions.push(unknownNonMoveAction(
        actionIdBase, entity, "review", null, dispositionReason,
        options.autoApplyRequested
      ));
      continue;
    }

    const destination = classification.workspace;
    const movement = movementEligibility(snapshot, entity);
    const decision = ruleDecision(
      entity,
      classification.patterns,
      destination,
      options.autoApplyRequested,
      movement
    );
    if (destination.id === source.id) {
      actions.push(nonMoveAction(
        actionIdBase, entity, "unchanged", destination.id, decision,
        `Entity already belongs to destination Workspace ${destination.name}`
      ));
      continue;
    }
    if (destination.protection.destination.protected) {
      actions.push(nonMoveAction(
        actionIdBase, entity, "protected", destination.id, decision,
        `Destination Workspace ${destination.name} is protected from receiving sorted Entities`
      ));
      continue;
    }
    if (!destinationAllowedByPolicy(destination, options.destinationAllowlist, options.destinationDenylist)) {
      actions.push(nonMoveAction(
        actionIdBase, entity, "blocked", destination.id, decision,
        `Destination Workspace ${destination.name} is outside the active destination policy`
      ));
      continue;
    }
    if (!movement.eligible) {
      actions.push(nonMoveAction(
        actionIdBase, entity, "review", destination.id, decision,
        `Entity cannot move through the current Snapshot: ${movement.reason}`
      ));
      continue;
    }
    if (options.limit !== null && moveCount >= options.limit) {
      actions.push(nonMoveAction(
        actionIdBase, entity, "review", destination.id, decision,
        `Move limit ${options.limit} has been reached; review this otherwise eligible move`
      ));
      continue;
    }

    moveCount += 1;
    const actionId = stableActionId({ ...actionIdBase, disposition: "move", destinationWorkspaceId: destination.id });
    actions.push({
      actionId,
      disposition: "move",
      operation: {
        op: "move",
        entityRef: entity.ref as MovementRootRef,
        entityKind: entity.kind,
        precondition: {
          entityRevision: entity.revision,
          entityProtection: moveProtection(entity.protection, `grant:${actionId}:entity`),
          sourceWorkspace: {
            workspaceId: source.id,
            protection: moveProtection(source.protection.source, `grant:${actionId}:source`)
          },
          destinationWorkspace: {
            workspaceId: destination.id,
            protection: moveProtection(destination.protection.destination, `grant:${actionId}:destination`)
          }
        },
        expectedPostState: { workspaceId: destination.id },
        inverse: { op: "move", destinationWorkspaceId: source.id }
      },
      decision
    });
  }

  const idRevision = sha256Canonical({ snapshotRevision: snapshot.revision, requestRevision, createdAt });
  return createPlan(snapshot, {
    schemaVersion: "zts.plan.provisional-1",
    id: `plan:rules:${shortDigest(idRevision)}`,
    configRevision: options.configRevision,
    engineManifestRevision: ENGINE_MANIFEST_REVISION,
    createdAt,
    expiresAt,
    derivation: { kind: "original" },
    source: { kind: "engine", engine: "rules", intentRevision: requestRevision },
    actions
  });
}

type EntityClassification =
  | { readonly status: "unmatched" | "ambiguous" | "invalid_destination" | "ambiguous_destination" }
  | { readonly status: "matched"; readonly workspace: Workspace; readonly patterns: readonly string[] };

function classifyMembers(
  members: readonly EntityMember[],
  domainRules: Readonly<Record<string, string>>,
  workspaces: WorkspaceLookup
): EntityClassification {
  if (members.length === 0) return { status: "unmatched" };
  const configured = members.map((member) => classifyRuleForUrl(member.url, domainRules));
  if (configured.some((match) => match === null)) return { status: "unmatched" };
  const resolved = configured.map((match) => {
    const exact = match!;
    const destination = resolveWorkspaceLookup(workspaces, exact.workspaceName);
    return destination.status === "resolved"
      ? { status: "resolved" as const, workspace: destination.workspace, pattern: exact.matchedPattern }
      : { status: destination.status };
  });
  if (resolved.some((match) => match.status === "missing")) return { status: "invalid_destination" };
  if (resolved.some((match) => match.status === "ambiguous")) return { status: "ambiguous_destination" };
  const exactMatches = resolved as Array<{ status: "resolved"; workspace: Workspace; pattern: string }>;
  const destinationId = exactMatches[0]?.workspace.id;
  if (!destinationId || exactMatches.some((match) => match.workspace.id !== destinationId)) return { status: "ambiguous" };
  return {
    status: "matched",
    workspace: exactMatches[0].workspace,
    patterns: Array.from(new Set(exactMatches.map((match) => match.pattern))).sort()
  };
}

function nonMoveAction(
  identity: { readonly entityRef: string; readonly requestRevision: string },
  entity: Entity,
  disposition: "review" | "protected" | "blocked" | "unchanged",
  candidateDestinationWorkspaceId: string | null,
  decision: DecisionEvidence,
  dispositionReason: string
): PlanAction {
  return {
    actionId: stableActionId({ ...identity, disposition, candidateDestinationWorkspaceId }),
    disposition,
    entityRef: entity.ref,
    candidateDestinationWorkspaceId,
    decision,
    dispositionReason: ztsMessage(dispositionReason)
  };
}

function unknownNonMoveAction(
  identity: { readonly entityRef: string; readonly requestRevision: string },
  entity: Entity,
  disposition: "review" | "protected" | "blocked" | "unchanged",
  candidateDestinationWorkspaceId: string | null,
  dispositionReason: string,
  autoApplyRequested: boolean
): PlanAction {
  return nonMoveAction(
    identity,
    entity,
    disposition,
    candidateDestinationWorkspaceId,
    unknownDecision(entity, dispositionReason, autoApplyRequested),
    dispositionReason
  );
}

function ruleDecision(
  entity: Entity,
  patterns: readonly string[],
  destination: Workspace,
  autoApplyRequested: boolean,
  movement: MovementEligibility
): RuleDecisionEvidence {
  const explanation = evidenceText(
    `Exact rule ${patterns.join(", ")} routes this Entity to Workspace ${destination.name}`,
    entity
  );
  return {
    engine: "rules",
    trustClass: "rule_exact",
    explanation,
    ruleRevision: sha256Canonical({ patterns, destinationWorkspaceId: destination.id }),
    autoApply: autoApplyRequested
      ? movement.eligible
        ? {
          status: "eligible",
          requested: true,
          eligible: true,
          reason: ztsMessage("Exact rule intent is eligible after all movement-safety checks")
        }
        : {
          status: "ineligible",
          requested: true,
          eligible: false,
          reason: ztsMessage(`Current state cannot execute this ${entity.kind} move: ${movement.reason}`)
        }
      : notRequested("Automatic apply was not requested for this Plan")
  };
}

function unknownDecision(entity: Entity, message: string, autoApplyRequested: boolean): UnknownDecisionEvidence {
  const explanation = evidenceText(message, entity);
  return {
    engine: "rules",
    trustClass: "unknown",
    explanation,
    evidenceRevision: sha256Canonical(explanation),
    autoApply: autoApplyRequested
      ? {
          status: "ineligible",
          requested: true,
          eligible: false,
          reason: ztsMessage("Unknown or policy-blocked intent is not eligible for automatic apply")
        }
      : notRequested("Automatic apply was not requested for this Plan")
  };
}

function evidenceText(value: string, entity: Entity) {
  return {
    value,
    provenance: "engine_generated" as const,
    interpretation: "data_only" as const,
    referencedEntityRefs: [entity.ref]
  };
}

function notRequested(value: string): Extract<AutoApplyEvidence, { readonly status: "not_requested" }> {
  return {
    status: "not_requested",
    requested: false,
    eligible: false,
    reason: ztsMessage(value)
  };
}

function ztsMessage(value: string): ZtsMessage {
  return { value, provenance: "zts_generated", interpretation: "data_only" };
}

function moveProtection(protection: Protection, grantId: string): MoveProtectionPrecondition {
  if (!protection.protected) return { protected: false, reasons: [], requiredGrantId: null };
  return {
    protected: true,
    reasons: protection.reasons,
    protectionRevision: sha256Canonical(protection),
    requiredGrantId: grantId
  };
}

function entityInScope(entity: Entity, scope: SortScope): boolean {
  return scope.kind === "all_workspaces" || entity.workspaceId === scope.workspaceId;
}

interface WorkspaceLookup {
  readonly exactIds: ReadonlyMap<string, Workspace>;
  readonly normalizedIds: ReadonlyMap<string, readonly Workspace[]>;
  readonly normalizedNames: ReadonlyMap<string, readonly Workspace[]>;
}

function workspaceNames(workspaces: readonly Workspace[]): WorkspaceLookup {
  const exactIds = new Map<string, Workspace>();
  const normalizedIds = new Map<string, Workspace[]>();
  const normalizedNames = new Map<string, Workspace[]>();
  for (const workspace of workspaces) {
    exactIds.set(workspace.id, workspace);
    pushWorkspace(normalizedIds, normalize(workspace.id), workspace);
    pushWorkspace(normalizedNames, normalize(workspace.name), workspace);
  }
  return { exactIds, normalizedIds, normalizedNames };
}

function resolveWorkspaceLookup(lookup: WorkspaceLookup, selector: string): RuleWorkspaceResolution {
  const exact = lookup.exactIds.get(selector);
  if (exact) return { status: "resolved", workspace: exact };
  const normalized = normalize(selector);
  const candidates = new Map<string, Workspace>();
  for (const workspace of lookup.normalizedIds.get(normalized) ?? []) candidates.set(workspace.id, workspace);
  for (const workspace of lookup.normalizedNames.get(normalized) ?? []) candidates.set(workspace.id, workspace);
  const matches = [...candidates.values()].sort((left, right) => compareText(left.id, right.id));
  if (matches.length === 0) return { status: "missing", matches: [] };
  if (matches.length > 1) return { status: "ambiguous", matches };
  return { status: "resolved", workspace: matches[0]! };
}

function pushWorkspace(map: Map<string, Workspace[]>, key: string, workspace: Workspace): void {
  const values = map.get(key) ?? [];
  values.push(workspace);
  map.set(key, values);
}

function membersMatchAny(members: readonly EntityMember[], patterns: readonly string[]): boolean {
  return members.some((member) => matchesAny(member.url, patterns));
}

function movementRootMembers(
  root: Entity,
  entities: ReadonlyMap<EntityRef, Entity>
): readonly EntityMember[] {
  const members: EntityMember[] = [];
  const visited = new Set<EntityRef>();
  const visiting = new Set<EntityRef>();
  const visit = (entity: Entity): void => {
    if (visiting.has(entity.ref)) throw new Error(`Entity graph cycle at ${entity.ref}`);
    if (visited.has(entity.ref)) throw new Error(`Movement Root ${root.ref} repeats structural child ${entity.ref}`);
    if (entity.structuralRootRef !== root.ref) {
      throw new Error(`Structural child ${entity.ref} escapes Movement Root ${root.ref}`);
    }
    visiting.add(entity.ref);
    members.push(...entity.members);
    for (const childRef of entity.childRefs) {
      const child = entities.get(childRef);
      if (!child) throw new Error(`Movement Root ${root.ref} references missing child ${childRef}`);
      visit(child);
    }
    visiting.delete(entity.ref);
    visited.add(entity.ref);
  };
  visit(root);
  return members;
}

function includedEntityProtection(protection: Protection, options: Pick<RulesPlanOptions, "includePinned" | "includeEssentials">): boolean {
  if (!protection.protected) return true;
  return protection.reasons.every((reason) =>
    (reason === "pinned" && options.includePinned)
    || (reason === "essential" && options.includeEssentials)
  );
}

function matchesAny(url: string, patterns: readonly string[]): boolean {
  return urlMatchesAnyPattern(url, patterns);
}

function stableActionId(value: unknown): string {
  return `action:rules:${shortDigest(sha256Canonical(value))}`;
}

function shortDigest(digest: string): string {
  return digest.slice("sha256:".length, "sha256:".length + 20);
}

function orderedRecord(value: Readonly<Record<string, string>>): Readonly<Record<string, string>> {
  return Object.fromEntries(Object.entries(value).sort(([left], [right]) => compareText(left, right)));
}

function normalize(value: string): string {
  return value.trim().toLowerCase();
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalTimestamp(date: Date): string {
  if (!Number.isFinite(date.getTime())) throw new Error("Rules Engine Plan timestamp is invalid");
  return date.toISOString();
}
