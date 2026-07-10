import { createPlan } from "../domain/change.js";
import { sha256Canonical } from "../domain/digest.js";

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
import type { Entity, MovementRootRef, Protection, Snapshot, Workspace } from "../domain/snapshot.js";
import type { Sha256Digest } from "../domain/digest.js";

const ENGINE_MANIFEST_REVISION = sha256Canonical({
  engine: "rules",
  implementation: "zts.rules.provisional-1",
  matching: "url-domain-subdomain-tld-specificity"
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
  readonly protectedDomains: readonly string[];
  readonly limit: number | null;
  readonly autoApplyRequested: boolean;
  readonly now?: Date;
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
    protectedDomains: [...options.protectedDomains],
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
  const requestRevision = rulesPlanRequestRevision(options);
  const actions: PlanAction[] = [];
  let moveCount = 0;

  for (const entity of snapshot.entities) {
    if (entity.parentRef !== null || entity.structuralRootRef !== entity.ref) continue;
    if (!entityInScope(entity, options.scope)) continue;
    const source = workspaces.get(entity.workspaceId);
    if (!source) throw new Error(`Entity ${entity.ref} references a missing source Workspace`);
    const actionIdBase = { entityRef: entity.ref, requestRevision };

    if (source.protection.source.protected) {
      actions.push(nonMoveAction(actionIdBase, entity, "protected", null, unknownDecision(
        entity,
        `Source Workspace ${source.name} is protected from sorting`,
        options.autoApplyRequested
      )));
      continue;
    }
    if (!workspaceAllowed(source, options.sourceAllowlist)) {
      actions.push(nonMoveAction(actionIdBase, entity, "blocked", null, unknownDecision(
        entity,
        `Source Workspace ${source.name} is outside the active source policy`,
        options.autoApplyRequested
      )));
      continue;
    }
    if (entity.protection.protected) {
      actions.push(nonMoveAction(actionIdBase, entity, "protected", null, unknownDecision(
        entity,
        `Entity is protected: ${entity.protection.reasons.join(", ")}`,
        options.autoApplyRequested
      )));
      continue;
    }
    if (entityMatchesAny(entity, options.protectedDomains)) {
      actions.push(nonMoveAction(actionIdBase, entity, "protected", null, unknownDecision(
        entity,
        "Entity contains a protected domain or URL",
        options.autoApplyRequested
      )));
      continue;
    }
    if (entityMatchesAny(entity, options.except)) {
      actions.push(nonMoveAction(actionIdBase, entity, "unchanged", null, unknownDecision(
        entity,
        "Entity is excluded by the active filter",
        options.autoApplyRequested
      )));
      continue;
    }
    if (options.only.length > 0 && !entity.members.every((member) => matchesAny(member.url, options.only))) {
      actions.push(nonMoveAction(actionIdBase, entity, "review", null, unknownDecision(
        entity,
        "Entity contains content outside the active only filter",
        options.autoApplyRequested
      )));
      continue;
    }

    const classification = classifyEntity(entity, options.domainRules, workspaceLookup);
    if (classification.status !== "matched") {
      actions.push(nonMoveAction(actionIdBase, entity, "review", null, unknownDecision(
        entity,
        classification.status === "unmatched"
          ? "No exact routing rule matched this Entity"
          : "Entity members matched different destination Workspaces",
        options.autoApplyRequested
      )));
      continue;
    }

    const destination = classification.workspace;
    const decision = ruleDecision(entity, classification.patterns, destination, options.autoApplyRequested);
    if (destination.id === source.id) {
      actions.push(nonMoveAction(actionIdBase, entity, "unchanged", destination.id, decision));
      continue;
    }
    if (destination.protection.destination.protected) {
      actions.push(nonMoveAction(actionIdBase, entity, "protected", destination.id, decision));
      continue;
    }
    if (!destinationAllowed(destination, options.destinationAllowlist, options.destinationDenylist)) {
      actions.push(nonMoveAction(actionIdBase, entity, "blocked", destination.id, decision));
      continue;
    }
    if (options.limit !== null && moveCount >= options.limit) {
      actions.push(nonMoveAction(actionIdBase, entity, "review", destination.id, decision));
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
    source: { kind: "engine", engine: "rules", intentRevision: requestRevision },
    actions
  });
}

type EntityClassification =
  | { readonly status: "unmatched" | "ambiguous" }
  | { readonly status: "matched"; readonly workspace: Workspace; readonly patterns: readonly string[] };

function classifyEntity(
  entity: Entity,
  domainRules: Readonly<Record<string, string>>,
  workspaces: ReadonlyMap<string, Workspace>
): EntityClassification {
  const matches = entity.members.map((member) => classifyUrl(member.url, domainRules, workspaces));
  if (matches.some((match) => match === null)) return { status: "unmatched" };
  const exactMatches = matches as Array<{ workspace: Workspace; pattern: string }>;
  const destinationId = exactMatches[0]?.workspace.id;
  if (!destinationId || exactMatches.some((match) => match.workspace.id !== destinationId)) return { status: "ambiguous" };
  return {
    status: "matched",
    workspace: exactMatches[0].workspace,
    patterns: Array.from(new Set(exactMatches.map((match) => match.pattern))).sort()
  };
}

function classifyUrl(
  url: string,
  domainRules: Readonly<Record<string, string>>,
  workspaces: ReadonlyMap<string, Workspace>
): { workspace: Workspace; pattern: string } | null {
  const candidates = Object.entries(domainRules)
    .map(([pattern, destination]) => ({ pattern, destination, score: matchSpecificity(pattern, url) }))
    .filter((candidate) => candidate.score >= 0)
    .sort((left, right) => right.score - left.score || compareText(left.pattern, right.pattern));
  const selected = candidates[0];
  if (!selected) return null;
  const workspace = workspaces.get(normalize(selected.destination));
  if (!workspace) return null;
  return { workspace, pattern: selected.pattern };
}

function matchSpecificity(pattern: string, url: string): number {
  const normalized = normalize(pattern);
  if (!normalized) return -1;
  const parsed = parseUrl(url);
  const host = parsed?.hostname.toLowerCase() ?? "";
  const full = url.toLowerCase();
  if (normalized.startsWith("http://") || normalized.startsWith("https://")) {
    return full.startsWith(normalized) ? 4000 + normalized.length : -1;
  }
  if (normalized.startsWith("*.")) {
    const suffix = normalized.slice(2);
    return host.endsWith(`.${suffix}`) ? 2000 + normalized.length : -1;
  }
  if (normalized.startsWith(".")) {
    return host.endsWith(normalized) ? 1000 + normalized.length : -1;
  }
  if (host === normalized) return 3000 + normalized.length;
  return host.endsWith(`.${normalized}`) ? 2500 + normalized.length : -1;
}

function nonMoveAction(
  identity: { readonly entityRef: string; readonly requestRevision: string },
  entity: Entity,
  disposition: "review" | "protected" | "blocked" | "unchanged",
  candidateDestinationWorkspaceId: string | null,
  decision: DecisionEvidence
): PlanAction {
  return {
    actionId: stableActionId({ ...identity, disposition, candidateDestinationWorkspaceId }),
    disposition,
    entityRef: entity.ref,
    candidateDestinationWorkspaceId,
    decision
  };
}

function ruleDecision(
  entity: Entity,
  patterns: readonly string[],
  destination: Workspace,
  autoApplyRequested: boolean
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
      ? {
          status: "eligible",
          requested: true,
          eligible: true,
          reason: ztsMessage("Exact rule intent is eligible after all movement-safety checks")
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

function workspaceAllowed(workspace: Workspace, allowlist: readonly string[]): boolean {
  if (allowlist.length === 0) return true;
  const identities = new Set([normalize(workspace.id), normalize(workspace.name)]);
  return allowlist.some((value) => identities.has(normalize(value)));
}

function destinationAllowed(workspace: Workspace, allowlist: readonly string[], denylist: readonly string[]): boolean {
  if (!workspaceAllowed(workspace, allowlist)) return false;
  const identities = new Set([normalize(workspace.id), normalize(workspace.name)]);
  return !denylist.some((value) => identities.has(normalize(value)));
}

function workspaceNames(workspaces: readonly Workspace[]): ReadonlyMap<string, Workspace> {
  const result = new Map<string, Workspace>();
  for (const workspace of workspaces) {
    result.set(normalize(workspace.id), workspace);
    result.set(normalize(workspace.name), workspace);
  }
  return result;
}

function entityMatchesAny(entity: Entity, patterns: readonly string[]): boolean {
  return entity.members.some((member) => matchesAny(member.url, patterns));
}

function matchesAny(url: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => matchSpecificity(pattern, url) >= 0);
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

function parseUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
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
