import { sha256Canonical } from "./domain/digest.js";
import { createSnapshot } from "./domain/snapshot.js";
import { assertJsonLz4SourceIdentity, readJsonLz4State } from "./mozlz4.js";
import {
  assertRawSessionStructure,
  detectZenSessionSchemaFamily,
  listTabs,
  defineRawSession,
  SESSION_STRUCTURE_LIMITS,
  summarizeSession,
  withWorkspacePolicy
} from "./session.js";
import {
  assertProfileIdentity,
  findSessionFile,
  readZenCompatibilityIdentity,
  zenProcessMayOwnProfile
} from "./profile.js";
import { acquireNativeProfileControl, assertNativeProfileControl } from "./closed-session-control.js";
import { findZenProcesses } from "./processes.js";
import { matchingUrlPatterns } from "./url-pattern.js";
import { evaluateClosedSessionTabCompatibility } from "./zen-compatibility.js";

import type { ZtsConfig } from "./config.js";
import type { ProfileContext, ZenCompatibilityIdentity } from "./profile.js";
import type { NativeProfileControl, NativeProfileControlProof } from "./closed-session-control.js";
import type { JsonLz4Fingerprint, JsonLz4State } from "./mozlz4.js";
import type { RawFolder, RawGroup, RawZenSession, SessionSummary, TabSummary } from "./session.js";
import type {
  CapabilityEvidence,
  EntityDraft,
  EntityMember,
  EntityRef,
  MovementRootRef,
  Protection,
  Snapshot,
  SnapshotDraft,
  StructuralChildRef,
  Workspace
} from "./domain/snapshot.js";

export interface SessionTabBinding {
  readonly entityRef: MovementRootRef;
  readonly nativeId: string;
  readonly rawIndex: number;
  readonly workspaceId: string;
}

export interface ControlledSessionCapture {
  readonly context: ProfileContext;
  readonly state: JsonLz4State;
  readonly session: RawZenSession;
  readonly summary: SessionSummary;
  readonly snapshot: Snapshot;
}

export class SessionSnapshotDriftError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionSnapshotDriftError";
  }
}

export interface SessionSnapshotCapture extends ControlledSessionCapture {
  readonly authorityBlocker: string | null;
}

export interface ControlledSessionCaptureOptions {
  /** Internal fault-injection hook after the exact source read. */
  readonly afterSourceRead?: () => void | Promise<void>;
}

/** A generic persisted read can never mint closed-session authority. */
export function snapshotFromSession(
  context: ProfileContext,
  session: RawZenSession,
  summary: SessionSummary,
  config: ZtsConfig,
  capturedAt = new Date(),
  compatibilityIdentity: ZenCompatibilityIdentity | null = null
): Snapshot {
  return buildSnapshot(context, session, summary, config, null, capturedAt, null, compatibilityIdentity);
}

/**
 * Owns the entire authoritative capture boundary. The same live native lease is
 * checked before and after the exact JSONLZ4 read, so caller-supplied stale
 * bytes can never be promoted into an authoritative Snapshot.
 */
export async function captureControlledSessionSnapshot(
  initialContext: ProfileContext,
  nativeControl: NativeProfileControl,
  config: ZtsConfig,
  capturedAt = new Date(),
  options: ControlledSessionCaptureOptions = {}
): Promise<ControlledSessionCapture> {
  const nativeControlProof = await assertNativeProfileControl(nativeControl, initialContext.profile);
  const selected = await findSessionFile(initialContext.profile.path);
  if (selected.kind !== "zen-sessions") {
    throw new SessionSnapshotDriftError(
      "Authoritative closed-session Snapshot requires zen-sessions.jsonlz4"
    );
  }
  const state = await readJsonLz4State(selected.path);
  const session = defineRawSession(state.value);
  await options.afterSourceRead?.();
  await assertNativeProfileControl(nativeControl, initialContext.profile);
  const current = await findSessionFile(initialContext.profile.path);
  if (current.kind !== "zen-sessions"
    || current.path !== selected.path
    || current.size !== state.fingerprint.size
    || current.modifiedMs !== state.fingerprint.modifiedMs) {
    throw new SessionSnapshotDriftError(
      "Zen session source changed across the native-control capture boundary"
    );
  }
  try {
    await assertJsonLz4SourceIdentity(current.path, state.fingerprint);
  } catch {
    throw new SessionSnapshotDriftError(
      "Zen session source changed across the native-control capture boundary"
    );
  }
  const runningProcesses = await findZenProcesses();
  const context: ProfileContext = {
    ...initialContext,
    running: false,
    runningProcesses,
    sessionFile: current
  };
  const summary = withWorkspacePolicy(summarizeSession(session, current), config);
  const compatibilityIdentity = await readZenCompatibilityIdentity(initialContext.profile.path);
  const snapshot = buildSnapshot(
    context,
    session,
    summary,
    config,
    nativeControlProof,
    capturedAt,
    state.fingerprint,
    compatibilityIdentity
  );
  await assertNativeProfileControl(nativeControl, initialContext.profile);
  try {
    await assertJsonLz4SourceIdentity(current.path, state.fingerprint);
  } catch {
    throw new SessionSnapshotDriftError(
      "Zen session source changed across the native-control capture boundary"
    );
  }
  return { context, state, session, summary, snapshot };
}

/**
 * Captures the best truthful read available for interactive planning. Closed
 * Profiles become authoritative only through native control; otherwise the
 * result remains an explicitly non-executable persisted observation.
 */
export async function captureSessionSnapshot(
  initialContext: ProfileContext,
  config: ZtsConfig,
  options: { readonly requireAuthoritative?: boolean } = {}
): Promise<SessionSnapshotCapture> {
  const refreshed = await refreshProfileContext(initialContext);
  if (!refreshed.running) {
    let control: NativeProfileControl;
    try {
      control = await acquireNativeProfileControl(refreshed, 0);
    } catch (error) {
      if (options.requireAuthoritative) {
        throw new Error(
          `Current authoritative Snapshot is unavailable: ${error instanceof Error ? error.message : String(error)}`
        );
      }
      return capturePersistedObservation(refreshed, config, error);
    }
    let captured: ControlledSessionCapture;
    try {
      captured = await captureControlledSessionSnapshot(refreshed, control, config);
    } catch (error) {
      try {
        await control.release();
      } catch (releaseError) {
        throw new AggregateError([error, releaseError], "Authoritative Snapshot capture and native control release both failed");
      }
      if (options.requireAuthoritative) {
        throw new Error(
          `Current authoritative Snapshot is unavailable: ${error instanceof Error ? error.message : String(error)}`
        );
      }
      return capturePersistedObservation(refreshed, config, error);
    }
    await control.release();
    return { ...captured, authorityBlocker: null };
  }
  if (options.requireAuthoritative) {
    throw new Error("Current authoritative Snapshot is unavailable because Zen owns or may own the target Profile");
  }
  return capturePersistedObservation(refreshed, config, new Error(
    "Zen owns or may own the target Profile; persisted session state may be stale"
  ));
}

async function capturePersistedObservation(
  initialContext: ProfileContext,
  config: ZtsConfig,
  blocker: unknown
): Promise<SessionSnapshotCapture> {
  const context = await refreshProfileContext(initialContext);
  const state = await readJsonLz4State(context.sessionFile.path);
  const session = defineRawSession(state.value);
  const exactContext: ProfileContext = {
    ...context,
    sessionFile: {
      ...context.sessionFile,
      size: state.fingerprint.size,
      modifiedMs: state.fingerprint.modifiedMs
    }
  };
  const summary = withWorkspacePolicy(summarizeSession(session, exactContext.sessionFile), config);
  const compatibilityIdentity = await readZenCompatibilityIdentity(exactContext.profile.path);
  const snapshot = buildSnapshot(
    exactContext,
    session,
    summary,
    config,
    null,
    new Date(),
    state.fingerprint,
    compatibilityIdentity
  );
  return {
    context: exactContext,
    state,
    session,
    summary,
    snapshot,
    authorityBlocker: blocker instanceof Error ? blocker.message : String(blocker)
  };
}

async function refreshProfileContext(initialContext: ProfileContext): Promise<ProfileContext> {
  const runningProcesses = await findZenProcesses();
  return {
    ...initialContext,
    running: runningProcesses.some((process) => zenProcessMayOwnProfile(process, initialContext.profile)),
    runningProcesses,
    sessionFile: await findSessionFile(initialContext.profile.path)
  };
}

function buildSnapshot(
  context: ProfileContext,
  session: RawZenSession,
  summary: SessionSummary,
  config: ZtsConfig,
  nativeControlProof: NativeProfileControlProof | null,
  capturedAt: Date,
  sourceFingerprint: JsonLz4Fingerprint | null,
  compatibilityIdentity: ZenCompatibilityIdentity | null
): Snapshot {
  assertProfileIdentity(context.profile);
  const capturedAtIso = canonicalTimestamp(capturedAt);
  if (nativeControlProof && context.running) {
    throw new Error("A running-Zen context cannot claim closed-session native Profile control");
  }
  const authoritative = Boolean(nativeControlProof) && context.sessionFile.kind === "zen-sessions";
  const route = authoritative ? "closed_session" : "persisted_session";
  // Runtime capture already hashes the exact encoded source bytes while they
  // are held open and stable. Re-hashing the entire parsed browser object here
  // creates a large second canonical string and needlessly scales peak memory
  // with private form/storage payloads. Synthetic callers without a source
  // fingerprint retain the semantic fallback used by contract fixtures.
  const sourceRevision = sourceFingerprint
    ? sha256Canonical({ kind: context.sessionFile.kind, fingerprint: sourceFingerprint })
    : sha256Canonical({
        kind: context.sessionFile.kind,
        modifiedMs: context.sessionFile.modifiedMs,
        size: context.sessionFile.size,
        session
      });
  const entities = reconstructSessionEntities(session, summary, config);
  const unstableStandaloneCount = entities.filter((entity) => entity.kind === "tab" && entity.nativeId === null).length;
  const platform = `${process.platform}-${process.arch}`;
  const schemaFamily = detectZenSessionSchemaFamily(session) ?? "unknown";
  const tabCompatibility = evaluateClosedSessionTabCompatibility(
    compatibilityIdentity,
    schemaFamily,
    platform
  );
  const scope = {
    profileId: context.profile.id,
    route,
    platform,
    zenVersion: compatibilityIdentity?.version ?? "unknown",
    zenBuildId: compatibilityIdentity?.buildId ?? null,
    schemaFamily,
    entityKind: null
  } as const;
  const observeProof = {
    artifact: { id: `session:${context.sessionFile.kind}:source`, digest: sourceRevision },
    source: "runtime_probe" as const,
    capturedAt: capturedAtIso,
    scope,
    controlSessionId: null,
    processBindingRevision: null
  };
  const evidence: CapabilityEvidence[] = [
    {
      id: "observe.snapshot",
      status: "available",
      reason: authoritative
        ? "Read Zen session state while holding Gecko-compatible native Profile control"
        : "Read persisted Zen session state without native Profile control",
      proof: observeProof
    }
  ];
  if (authoritative) {
    const controlRevision = sha256Canonical({
      nativeControlProof,
      sourceRevision,
      compatibilityEvidenceRevision: tabCompatibility.evidenceRevision
    });
    evidence.push({
      id: "profile.exclusive_control",
      status: "available",
      reason: "zts holds the native lock that Gecko requires for this Profile",
      proof: { ...observeProof, artifact: { id: "session:closed-profile:exclusive-control", digest: controlRevision } }
    });
    evidence.push(tabCompatibility.supported
      ? {
          id: "move.tab",
          status: "available",
          reason: unstableStandaloneCount === 0
            ? tabCompatibility.reason
            : `${tabCompatibility.reason}; ${unstableStandaloneCount} observation-only tab(s) remain ineligible`,
          proof: {
            ...observeProof,
            artifact: { id: "session:closed-profile:move-tab", digest: controlRevision },
            scope: { ...scope, entityKind: "tab" }
          }
        }
      : {
          id: "move.tab",
          status: "unknown",
          reason: tabCompatibility.reason,
          proof: null
        });
  } else {
    evidence.push({
      id: "move.tab",
      status: "unavailable",
      reason: "Persisted session observations cannot authorize tab mutation",
      proof: null
    });
  }
  evidence.push(
    {
      id: "move.tab_group",
      status: "unavailable",
      reason: "The current closed-session adapter reconstructs tab groups but has no accepted group mutation proof",
      proof: null
    },
    {
      id: "move.zen_folder",
      status: "unavailable",
      reason: "The current closed-session adapter reconstructs Zen folder closure but has no accepted folder mutation proof",
      proof: null
    },
    {
      id: "move.split_view",
      status: "unavailable",
      reason: "The current closed-session adapter reconstructs split views but has no accepted split-view mutation proof",
      proof: null
    }
  );

  const draft = {
    schemaVersion: "zts.snapshot.provisional-1",
    profile: {
      id: context.profile.id,
      name: context.profile.name,
      contentTrust: "browser_untrusted"
    },
    capturedAt: capturedAtIso,
    authority: authoritative ? "authoritative" : "persisted_observation",
    freshness: authoritative ? "current" : "possibly_stale",
    provenance: {
      route,
      sourceRevision,
      platform: scope.platform,
      zenVersion: scope.zenVersion,
      zenBuildId: scope.zenBuildId,
      schemaFamily: scope.schemaFamily
    },
    capabilities: {
      observedAt: capturedAtIso,
      evidence: evidence as [CapabilityEvidence, ...CapabilityEvidence[]]
    },
    workspaces: summary.workspaces.map((workspace): Workspace => ({
      id: workspace.id,
      name: workspace.name,
      contentTrust: "browser_untrusted",
      position: workspace.order,
      protection: workspaceProtection(workspace.protectedStatus)
    })),
    entities
  } as SnapshotDraft;
  return createSnapshot(draft);
}

interface FolderNode {
  readonly id: string;
  readonly record: RawFolder;
  readonly parentId: string | null;
  readonly workspaceId: string;
  readonly rootId: string;
  readonly depth: number;
}

interface FolderClosure {
  readonly memberCount: number;
  readonly reasons: readonly string[];
}

function reconstructSessionEntities(
  session: RawZenSession,
  summary: SessionSummary,
  config: ZtsConfig
): EntityDraft[] {
  assertRawSessionStructure(session);
  const tabs = listTabs(session, summary);
  const workspaceIds = new Set(summary.workspaces.map((workspace) => workspace.id));
  const folders = indexStructures(session.folders ?? [], "folder");
  const groups = indexStructures(session.groups ?? [], "group");
  const splitDefinitions = splitViewDefinitions(session, folders, groups);
  const splitIds = new Set(splitDefinitions.keys());

  for (const splitId of splitIds) {
    const folder = folders.get(splitId);
    if (folder && optionalStructureId(folder.parentId, `folder ${splitId} parentId`) !== null) {
      throw new Error(`Split view ${splitId} cannot also be a nested Zen folder`);
    }
  }

  const folderMembers = new Map<string, TabSummary[]>();
  const groupMembers = new Map<string, TabSummary[]>();
  const splitMembers = new Map<string, TabSummary[]>();
  const standaloneTabs: TabSummary[] = [];
  for (const tab of tabs) {
    const folderId = optionalStructureId(tab.folderId, `tab ${tab.index} folder id`);
    const groupId = optionalStructureId(tab.groupId, `tab ${tab.index} group id`);
    const splitCandidates = Array.from(new Set([folderId, groupId]
      .filter((id): id is string => id !== null && splitIds.has(id))));
    if (splitCandidates.length > 1) {
      throw new Error(`Tab ${tabIdentity(tab)} has duplicate split-view ownership: ${splitCandidates.join(", ")}`);
    }
    if (!folderId && !groupId) {
      if (tab.workspaceId !== null) standaloneTabs.push(tab);
      continue;
    }
    if (tab.workspaceId === null) {
      throw new Error(`Structured tab ${tabIdentity(tab)} has no Workspace`);
    }
    if (splitCandidates[0]) {
      pushMember(splitMembers, splitCandidates[0], tab);
    } else if (folderId) {
      if (!folders.has(folderId)) {
        throw new Error(`Tab ${tabIdentity(tab)} references missing structure ${folderId}`);
      }
      pushMember(folderMembers, folderId, tab);
    } else if (groupId && folders.has(groupId)) {
      pushMember(folderMembers, groupId, tab);
    } else if (groupId && groups.has(groupId)) {
      pushMember(groupMembers, groupId, tab);
    } else {
      throw new Error(`Tab ${tabIdentity(tab)} references missing structure ${groupId ?? folderId}`);
    }
  }
  for (const [id, definition] of splitDefinitions) {
    const members = splitMembers.get(id) ?? [];
    const declaredIds = (definition.tabs ?? []).map((value, index) =>
      requiredStructureId(value, `split view ${id} tabs[${index}]`)
    );
    if (new Set(declaredIds).size !== declaredIds.length) {
      throw new Error(`Split view ${id} declares duplicate tab membership`);
    }
    const membersById = new Map<string, TabSummary>();
    for (const member of members) {
      if (!member.nativeId) throw new Error(`Split view ${id} member lacks stable native identity`);
      if (membersById.has(member.nativeId)) throw new Error(`Split view ${id} has duplicate tab ownership for ${member.nativeId}`);
      membersById.set(member.nativeId, member);
    }
    if (declaredIds.length !== members.length || declaredIds.some((nativeId) => !membersById.has(nativeId))) {
      throw new Error(`Split view ${id} tab closure does not match its structural membership`);
    }
    splitMembers.set(id, declaredIds.map((nativeId) => membersById.get(nativeId)!));
  }

  const normalFolders = new Map([...folders].filter(([id]) => !splitIds.has(id)));
  const folderChildren = new Map<string, string[]>();
  const resolvedFolders = new Map<string, FolderNode>();
  const resolvingFolders = new Set<string>();
  const resolveFolder = (id: string): FolderNode => {
    const existing = resolvedFolders.get(id);
    if (existing) return existing;
    if (resolvingFolders.has(id)) throw new Error(`Zen folder graph contains a cycle at ${id}`);
    const record = normalFolders.get(id);
    if (!record) throw new Error(`Zen folder ${id} is missing`);
    resolvingFolders.add(id);
    const parentId = optionalStructureId(record.parentId, `folder ${id} parentId`);
    const explicitWorkspaceId = optionalStructureId(record.workspaceId, `folder ${id} workspaceId`);
    let workspaceId: string;
    let rootId: string;
    let depth: number;
    if (parentId) {
      const parent = resolveFolder(parentId);
      if (explicitWorkspaceId && explicitWorkspaceId !== parent.workspaceId) {
        throw new Error(`Zen folder ${id} crosses Workspaces from ${parent.workspaceId} to ${explicitWorkspaceId}`);
      }
      workspaceId = explicitWorkspaceId ?? parent.workspaceId;
      rootId = parent.rootId;
      depth = parent.depth + 1;
      pushChild(folderChildren, parentId, id);
    } else {
      if (!explicitWorkspaceId) throw new Error(`Root Zen folder ${id} has no Workspace`);
      workspaceId = explicitWorkspaceId;
      rootId = id;
      depth = 1;
    }
    if (depth > SESSION_STRUCTURE_LIMITS.maxFolderDepth) {
      throw new Error(`Zen folder ${id} exceeds the maximum depth of ${SESSION_STRUCTURE_LIMITS.maxFolderDepth}`);
    }
    if (!workspaceIds.has(workspaceId)) throw new Error(`Zen folder ${id} references unknown Workspace ${workspaceId}`);
    const node = { id, record, parentId, workspaceId, rootId, depth };
    resolvedFolders.set(id, node);
    resolvingFolders.delete(id);
    return node;
  };
  for (const id of [...normalFolders.keys()].sort(compareText)) resolveFolder(id);

  for (const [folderId, members] of folderMembers) {
    const folder = resolvedFolders.get(folderId);
    if (!folder) throw new Error(`Tab membership references missing Zen folder ${folderId}`);
    assertOneWorkspace(members, folder.workspaceId, `Zen folder ${folderId}`);
  }

  const folderClosureCache = new Map<string, FolderClosure>();
  const folderClosure = (id: string): FolderClosure => {
    const existing = folderClosureCache.get(id);
    if (existing) return existing;
    const node = resolvedFolders.get(id);
    if (!node) throw new Error(`Zen folder closure references missing ${id}`);
    const members = folderMembers.get(id) ?? [];
    let memberCount = members.length;
    const reasons = entityReasons(members, config);
    if (structurePinned(node.record, groups.get(id), `Zen folder ${id}`)) reasons.push("pinned");
    for (const childId of (folderChildren.get(id) ?? []).sort(compareText)) {
      const child = folderClosure(childId);
      memberCount += child.memberCount;
      reasons.push(...child.reasons);
    }
    const closure = { memberCount, reasons: orderedReasons(reasons) };
    folderClosureCache.set(id, closure);
    return closure;
  };
  for (const node of resolvedFolders.values()) {
    if (node.parentId === null) assertMovementRootMemberCount(folderClosure(node.id).memberCount, `Zen folder ${node.id}`);
  }

  const standaloneRefs = standaloneTabRefs(standaloneTabs);
  const entities: EntityDraft[] = [];
  for (const tab of standaloneTabs) {
    const ref = standaloneRefs.get(tab.index);
    if (!ref) throw new Error(`Standalone tab at index ${tab.index} has no Snapshot-scoped Entity reference`);
    entities.push({
      ref,
      kind: "tab",
      nativeId: tab.nativeId,
      parentRef: null,
      childRefs: [],
      structuralRootRef: ref,
      workspaceId: requiredWorkspace(tab),
      title: tab.title,
      contentTrust: "browser_untrusted",
      protection: protection(entityReasons([tab], config)),
      members: [entityMember(tab)]
    });
  }

  for (const [id, record] of [...groups].sort(([left], [right]) => compareText(left, right))) {
    if (splitIds.has(id) || folders.has(id)) continue;
    const members = groupMembers.get(id) ?? [];
    if (members.length === 0) continue;
    assertMovementRootMemberCount(members.length, `Tab group ${id}`);
    const workspaceId = oneWorkspace(members, `Tab group ${id}`);
    const reasons = entityReasons(members, config);
    if (structurePinned(record, null, `Tab group ${id}`)) reasons.push("pinned");
    const ref = structureRef("tab-group", id, "root");
    entities.push({
      ref,
      kind: "tab_group",
      nativeId: id,
      parentRef: null,
      childRefs: [],
      structuralRootRef: ref,
      workspaceId,
      title: structureTitle(record.name, id),
      contentTrust: "browser_untrusted",
      protection: protection(reasons),
      members: members.map(entityMember) as [EntityMember, ...EntityMember[]]
    });
  }

  for (const id of [...splitIds].sort(compareText)) {
    const members = splitMembers.get(id) ?? [];
    if (members.length < 2) throw new Error(`Split view ${id} must own at least two tabs`);
    assertMovementRootMemberCount(members.length, `Split view ${id}`);
    const workspaceId = oneWorkspace(members, `Split view ${id}`);
    const group = groups.get(id);
    const folder = folders.get(id);
    if (folder) {
      const folderWorkspaceId = optionalStructureId(folder.workspaceId, `split view ${id} workspaceId`);
      if (folderWorkspaceId && folderWorkspaceId !== workspaceId) {
        throw new Error(`Split view ${id} crosses Workspaces from ${folderWorkspaceId} to ${workspaceId}`);
      }
    }
    const reasons = entityReasons(members, config);
    if (structurePinned(folder, group, `Split view ${id}`)) reasons.push("pinned");
    const ref = structureRef("split-view", id, "root");
    entities.push({
      ref,
      kind: "split_view",
      nativeId: id,
      parentRef: null,
      childRefs: [],
      structuralRootRef: ref,
      workspaceId,
      title: structureTitle(folder?.name ?? group?.name, id),
      contentTrust: "browser_untrusted",
      protection: protection(reasons),
      members: members.map(entityMember) as [EntityMember, EntityMember, ...EntityMember[]]
    });
  }

  const folderRefs = new Map<string, MovementRootRef | StructuralChildRef>();
  for (const node of resolvedFolders.values()) {
    folderRefs.set(node.id, node.parentId === null
      ? structureRef("zen-folder", node.id, "root")
      : structureRef("zen-folder", node.id, "child"));
  }
  for (const node of [...resolvedFolders.values()].sort((left, right) => compareText(left.id, right.id))) {
    const ref = requiredFolderRef(folderRefs, node.id);
    const rootRef = requiredFolderRef(folderRefs, node.rootId) as MovementRootRef;
    const directMembers = folderMembers.get(node.id) ?? [];
    entities.push({
      ref,
      kind: "zen_folder",
      nativeId: node.id,
      parentRef: node.parentId === null ? null : requiredFolderRef(folderRefs, node.parentId) as EntityRef,
      childRefs: (folderChildren.get(node.id) ?? []).sort(compareText)
        .map((childId) => requiredFolderRef(folderRefs, childId) as StructuralChildRef),
      structuralRootRef: rootRef,
      workspaceId: node.workspaceId,
      title: structureTitle(node.record.name, node.id),
      contentTrust: "browser_untrusted",
      protection: protection(folderClosure(node.id).reasons),
      members: directMembers.map(entityMember)
    } as EntityDraft);
  }

  if (entities.length > SESSION_STRUCTURE_LIMITS.maxEntities) {
    throw new Error(`Normalized Entity count exceeds ${SESSION_STRUCTURE_LIMITS.maxEntities}`);
  }
  return entities;
}

function indexStructures<T extends { readonly id?: string }>(records: readonly T[], kind: string): Map<string, T> {
  const result = new Map<string, T>();
  for (const [index, record] of records.entries()) {
    const id = requiredStructureId(record.id, `${kind}[${index}].id`);
    if (result.has(id)) throw new Error(`Duplicate Zen ${kind} id ${id}`);
    result.set(id, record);
  }
  return result;
}

function splitViewDefinitions(
  session: RawZenSession,
  folders: ReadonlyMap<string, RawFolder>,
  groups: ReadonlyMap<string, RawGroup>
): Map<string, NonNullable<RawZenSession["splitViewData"]>[number]> {
  const flagged = new Set<string>();
  for (const [id, group] of groups) {
    assertOptionalBoolean(group.splitView, `group ${id} splitView`);
    if (group.splitView === true) flagged.add(id);
  }
  for (const [id, folder] of folders) {
    assertOptionalBoolean(folder.splitViewGroup, `folder ${id} splitViewGroup`);
    if (folder.splitViewGroup === true) flagged.add(id);
  }
  const result = new Map<string, NonNullable<RawZenSession["splitViewData"]>[number]>();
  for (const [index, split] of (session.splitViewData ?? []).entries()) {
    const id = requiredStructureId(split.groupId, `splitViewData[${index}].groupId`);
    if (result.has(id)) throw new Error(`Duplicate Zen split view id ${id}`);
    if (!groups.has(id) && !folders.has(id)) throw new Error(`Split view ${id} references a missing group or folder`);
    if (!flagged.has(id)) throw new Error(`Split view ${id} is not marked as a split structure`);
    if (!Array.isArray(split.tabs)) throw new Error(`Split view ${id} requires an exact tabs closure`);
    result.set(id, split);
  }
  for (const id of flagged) {
    if (!result.has(id)) throw new Error(`Split structure ${id} lacks splitViewData closure evidence`);
  }
  return result;
}

function entityMember(tab: TabSummary): EntityMember {
  return {
    nativeId: tab.nativeId,
    title: tab.title,
    url: tab.url,
    contentTrust: "browser_untrusted",
    pinned: tab.pinned,
    essential: tab.essential,
    hidden: tab.hidden,
    active: tab.active
  };
}

function entityReasons(tabs: readonly TabSummary[], config: ZtsConfig): string[] {
  const reasons: string[] = [];
  for (const tab of tabs) {
    if (tab.pinned) reasons.push("pinned");
    if (tab.essential) reasons.push("essential");
    reasons.push(...matchingUrlPatterns(tab.url, config.protect.domains.neverMove)
      .map((pattern) => `configured_never_move:${pattern}`));
  }
  return orderedReasons(reasons);
}

function protection(reasons: readonly string[]): Protection {
  const ordered = orderedReasons(reasons);
  return ordered.length > 0
    ? { protected: true, reasons: ordered as [string, ...string[]] }
    : { protected: false, reasons: [] };
}

function orderedReasons(reasons: readonly string[]): string[] {
  return Array.from(new Set(reasons)).sort(compareText);
}

function structurePinned(
  primary: { readonly pinned?: boolean } | undefined,
  alias: { readonly pinned?: boolean } | null | undefined,
  label: string
): boolean {
  assertOptionalBoolean(primary?.pinned, `${label} pinned`);
  assertOptionalBoolean(alias?.pinned, `${label} alias pinned`);
  return primary?.pinned === true || alias?.pinned === true;
}

function assertOptionalBoolean(value: unknown, label: string): void {
  if (value !== undefined && typeof value !== "boolean") throw new Error(`${label} must be boolean`);
}

function oneWorkspace(tabs: readonly TabSummary[], label: string): string {
  const workspaces = new Set(tabs.map((tab) => tab.workspaceId).filter((id): id is string => id !== null));
  if (workspaces.size !== 1 || tabs.some((tab) => tab.workspaceId === null)) {
    throw new Error(`${label} crosses Workspaces or has an unassigned tab`);
  }
  return [...workspaces][0];
}

function assertOneWorkspace(tabs: readonly TabSummary[], workspaceId: string, label: string): void {
  if (tabs.some((tab) => tab.workspaceId !== workspaceId)) {
    throw new Error(`${label} crosses Workspaces`);
  }
}

function requiredWorkspace(tab: TabSummary): string {
  if (!tab.workspaceId) throw new Error(`Tab ${tabIdentity(tab)} has no Workspace`);
  return tab.workspaceId;
}

function assertMovementRootMemberCount(count: number, label: string): void {
  if (count > SESSION_STRUCTURE_LIMITS.maxMembersPerMovementRoot) {
    throw new Error(`${label} exceeds the ${SESSION_STRUCTURE_LIMITS.maxMembersPerMovementRoot}-member Movement Root limit`);
  }
}

function pushMember(map: Map<string, TabSummary[]>, id: string, tab: TabSummary): void {
  const values = map.get(id) ?? [];
  values.push(tab);
  map.set(id, values);
}

function pushChild(map: Map<string, string[]>, id: string, childId: string): void {
  const values = map.get(id) ?? [];
  values.push(childId);
  map.set(id, values);
}

function tabIdentity(tab: TabSummary): string {
  return tab.nativeId ?? `at index ${tab.index}`;
}

function requiredStructureId(value: unknown, label: string): string {
  const id = optionalStructureId(value, label);
  if (!id) throw new Error(`${label} is required`);
  return id;
}

function optionalStructureId(value: unknown, label: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string`);
  const id = value.trim();
  if (id.length > SESSION_STRUCTURE_LIMITS.maxNativeIdLength) {
    throw new Error(`${label} exceeds the ${SESSION_STRUCTURE_LIMITS.maxNativeIdLength}-character id limit`);
  }
  if (Buffer.byteLength(id, "utf8") > SESSION_STRUCTURE_LIMITS.maxNativeIdBytes) {
    throw new Error(`${label} exceeds the ${SESSION_STRUCTURE_LIMITS.maxNativeIdBytes}-byte UTF-8 id limit`);
  }
  return id;
}

function structureTitle(value: unknown, fallback: string): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

function structureRef(
  kind: "tab-group" | "zen-folder" | "split-view",
  nativeId: string,
  role: "root"
): MovementRootRef;
function structureRef(
  kind: "tab-group" | "zen-folder" | "split-view",
  nativeId: string,
  role: "child"
): StructuralChildRef;
function structureRef(
  kind: "tab-group" | "zen-folder" | "split-view",
  nativeId: string,
  role: "root" | "child"
): MovementRootRef | StructuralChildRef {
  const digest = sha256Canonical({ kind, nativeId }).slice("sha256:".length);
  return `entity:${role}:${kind}:${digest}` as MovementRootRef | StructuralChildRef;
}

function requiredFolderRef(
  refs: ReadonlyMap<string, MovementRootRef | StructuralChildRef>,
  id: string
): MovementRootRef | StructuralChildRef {
  const ref = refs.get(id);
  if (!ref) throw new Error(`Zen folder ${id} has no canonical Entity reference`);
  return ref;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function sessionTabBindings(
  snapshot: Snapshot,
  session: RawZenSession,
  summary: SessionSummary
): ReadonlyMap<MovementRootRef, SessionTabBinding> {
  const entities = new Map(snapshot.entities.map((entity) => [entity.ref, entity]));
  const stableTabEntities = snapshot.entities.filter((entity) => entity.kind === "tab" && entity.nativeId !== null);
  const bindings = new Map<MovementRootRef, SessionTabBinding>();
  for (const tab of listTabs(session, summary)) {
    if (tab.workspaceId === null) continue;
    if (!tab.nativeId) continue;
    const entityRef = stableTabRef(tab.nativeId);
    const entity = entities.get(entityRef);
    if (!entity) continue;
    if (entity.nativeId === null) throw new Error(`Session tab binding lacks stable native identity for Snapshot Entity ${entityRef}`);
    if (entity.kind !== "tab" || entity.nativeId !== tab.nativeId || entity.workspaceId !== tab.workspaceId) {
      throw new Error(`Session tab binding does not match Snapshot Entity ${entityRef}`);
    }
    if (bindings.has(entityRef)) throw new Error(`Session tab binding repeats Snapshot Entity ${entityRef}`);
    bindings.set(entityRef, {
      entityRef,
      nativeId: tab.nativeId,
      rawIndex: tab.index,
      workspaceId: tab.workspaceId
    });
  }
  if (bindings.size !== stableTabEntities.length) {
    throw new Error("Session tab binding cannot re-establish every mutation-eligible standalone tab identity");
  }
  return bindings;
}

function workspaceProtection(status: SessionSummary["workspaces"][number]["protectedStatus"]): Workspace["protection"] {
  return {
    source: status === "from" || status === "from_to"
      ? { protected: true, reasons: ["protected_source"] }
      : { protected: false, reasons: [] },
    destination: status === "to" || status === "from_to"
      ? { protected: true, reasons: ["protected_destination"] }
      : { protected: false, reasons: [] }
  };
}

function standaloneTabRefs(tabs: readonly TabSummary[]): ReadonlyMap<number, MovementRootRef> {
  const refs = new Map<number, MovementRootRef>();
  const unresolved = tabs
    .filter((tab) => tab.nativeId === null)
    .map((tab) => ({
      tab,
      contentRevision: sha256Canonical({
        kind: "unresolved_session_tab_observation",
        workspaceId: tab.workspaceId,
        title: tab.title,
        url: tab.url,
        pinned: tab.pinned,
        essential: tab.essential,
        hidden: tab.hidden,
        active: tab.active,
        protectionReasons: tab.protectionReasons
      })
    }))
    .sort((left, right) => compareText(left.contentRevision, right.contentRevision) || left.tab.index - right.tab.index);
  const ordinals = new Map<string, number>();

  for (const tab of tabs) {
    if (tab.nativeId) refs.set(tab.index, stableTabRef(tab.nativeId));
  }
  for (const { tab, contentRevision } of unresolved) {
    const ordinal = ordinals.get(contentRevision) ?? 0;
    ordinals.set(contentRevision, ordinal + 1);
    const digest = sha256Canonical({ kind: "unresolved_session_tab_ref", contentRevision, ordinal })
      .slice("sha256:".length);
    refs.set(tab.index, `entity:root:tab:unresolved:${digest}`);
  }
  return refs;
}

function stableTabRef(nativeId: string): MovementRootRef {
  const digest = sha256Canonical({ kind: "zen_tab_native_id", nativeId })
    .slice("sha256:".length);
  return `entity:root:tab:${digest}`;
}

function canonicalTimestamp(value: Date): string {
  if (!Number.isFinite(value.getTime())) throw new Error("Snapshot capture timestamp is invalid");
  return value.toISOString();
}
