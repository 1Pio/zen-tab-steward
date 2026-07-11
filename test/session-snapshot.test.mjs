import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { DEFAULT_CONFIG, effectiveConfigRevision } from "../dist/config.js";
import { acquireNativeProfileControl } from "../dist/closed-session-control.js";
import { createPlan } from "../dist/domain/change.js";
import { createRulesPlan } from "../dist/engines/rules.js";
import { createManualPlanFromInput } from "../dist/manual.js";
import { encodeLiteralJsonLz4ForFixture } from "../dist/mozlz4.js";
import { findSessionFile, profileIdForPath } from "../dist/profile.js";
import {
  defineRawSession,
  SESSION_STRUCTURE_LIMITS,
  summarizeSession,
  withWorkspacePolicy
} from "../dist/session.js";
import {
  captureControlledSessionSnapshot,
  sessionTabBindings,
  snapshotFromSession
} from "../dist/session-snapshot.js";

const roots = new Set();
const CAPTURED_AT = new Date("2026-07-11T08:00:00.000Z");

after(async () => {
  await Promise.all([...roots].map((root) => rm(root, { recursive: true, force: true })));
});

test("reconstructs standalone tabs, groups, nested folders, and split views with one direct owner", async () => {
  const config = structuredClone(DEFAULT_CONFIG);
  config.protect.domains.neverMove = ["github.com"];
  const session = realisticStructuredSession();
  const snapshot = await makeSnapshot(session, config);

  assert.deepEqual(
    snapshot.entities.filter((entity) => entity.parentRef === null).map((entity) => entity.kind).sort(),
    ["split_view", "tab", "tab_group", "zen_folder"]
  );
  const folderRoot = snapshot.entities.find((entity) => entity.kind === "zen_folder" && entity.nativeId === "folder-root");
  const folderChild = snapshot.entities.find((entity) => entity.kind === "zen_folder" && entity.nativeId === "folder-child");
  const folderGrandchild = snapshot.entities.find((entity) => entity.kind === "zen_folder" && entity.nativeId === "folder-grandchild");
  const group = snapshot.entities.find((entity) => entity.kind === "tab_group");
  const split = snapshot.entities.find((entity) => entity.kind === "split_view");
  assert.ok(folderRoot && folderChild && folderGrandchild && group && split);
  assert.equal(folderRoot.parentRef, null);
  assert.deepEqual(folderRoot.childRefs, [folderChild.ref]);
  assert.equal(folderChild.parentRef, folderRoot.ref);
  assert.deepEqual(folderChild.childRefs, [folderGrandchild.ref]);
  assert.equal(folderGrandchild.structuralRootRef, folderRoot.ref);
  assert.deepEqual(folderRoot.members.map((member) => member.nativeId), ["tab-folder-root"]);
  assert.deepEqual(folderChild.members.map((member) => member.nativeId), ["tab-folder-child"]);
  assert.deepEqual(folderGrandchild.members.map((member) => member.nativeId), ["tab-folder-grandchild"]);
  assert.deepEqual(folderRoot.protection.reasons, ["configured_never_move:github.com", "essential"]);
  assert.deepEqual(group.members.map((member) => member.nativeId), ["tab-group-1", "tab-group-2"]);
  assert.deepEqual(group.protection.reasons, ["pinned"]);
  assert.deepEqual(split.members.map((member) => member.nativeId), ["tab-split-1", "tab-split-2"]);
  assert.equal(snapshot.entities.find((entity) => entity.kind === "tab").members[0].active, true);

  const directOwners = snapshot.entities.flatMap((entity) => entity.members.map((member) => member.nativeId));
  assert.equal(directOwners.length, 8);
  assert.equal(new Set(directOwners).size, directOwners.length);
  const capabilities = new Map(snapshot.capabilities.evidence.map((evidence) => [evidence.id, evidence.status]));
  assert.equal(capabilities.get("move.tab_group"), "unavailable");
  assert.equal(capabilities.get("move.zen_folder"), "unavailable");
  assert.equal(capabilities.get("move.split_view"), "unavailable");
});

test("normalization is deterministic and a descendant change revises its complete folder-root closure", async () => {
  const original = realisticStructuredSession();
  const reordered = structuredClone(original);
  reordered.folders.reverse();
  reordered.groups.reverse();
  const first = await makeSnapshot(original);
  const same = await makeSnapshot(reordered);
  assert.deepEqual(
    first.entities.map((entity) => ({ ref: entity.ref, revision: entity.revision })),
    same.entities.map((entity) => ({ ref: entity.ref, revision: entity.revision }))
  );

  const changed = structuredClone(original);
  changed.tabs.find((tab) => tab.zenSyncId === "tab-folder-grandchild").entries[0].title = "Changed descendant";
  const after = await makeSnapshot(changed);
  const firstRoot = first.entities.find((entity) => entity.nativeId === "folder-root");
  const afterRoot = after.entities.find((entity) => entity.nativeId === "folder-root");
  const firstGroup = first.entities.find((entity) => entity.nativeId === "group-normal");
  const afterGroup = after.entities.find((entity) => entity.nativeId === "group-normal");
  assert.notEqual(firstRoot.revision, afterRoot.revision);
  assert.equal(firstGroup.revision, afterGroup.revision);
  assert.notEqual(first.revision, after.revision);
});

test("Snapshot revision binds normalized state but excludes capture proof", async () => {
  const session = realisticStructuredSession();
  const first = snapshotForSource(session, { size: 100, modifiedMs: 10 }, CAPTURED_AT);
  const sameSourceLater = snapshotForSource(
    session,
    { size: 100, modifiedMs: 10 },
    new Date("2026-07-11T09:00:00.000Z")
  );
  const changedSource = snapshotForSource(session, { size: 101, modifiedMs: 11 }, CAPTURED_AT);

  assert.equal(first.revision, sameSourceLater.revision);
  assert.equal(first.revision, changedSource.revision);
  assert.notEqual(first.provenance.sourceRevision, changedSource.provenance.sourceRevision);
});

test("structure ownership uses split then folder alias then normal group precedence", async () => {
  const session = realisticStructuredSession();
  session.folders.push({ id: "folder-precedence", name: "Folder precedence", workspaceId: "w1" });
  session.groups.push(
    { id: "group-shadowed", name: "Normal group" },
    { id: "split-precedence", name: "Split", splitView: true }
  );
  session.splitViewData.push({
    groupId: "split-precedence",
    gridType: "2x1",
    layoutTree: { type: "row" },
    tabs: ["tab-split-wins-1", "tab-split-wins-2"]
  });
  session.tabs.push(
    {
      zenSyncId: "tab-folder-wins",
      zenWorkspace: "w1",
      groupId: "group-shadowed",
      zenLiveFolderItemId: "folder-precedence",
      entries: [{ url: "https://folder.example.test", title: "Folder wins" }]
    },
    {
      zenSyncId: "tab-split-wins-1",
      zenWorkspace: "w1",
      groupId: "split-precedence",
      zenLiveFolderItemId: "folder-precedence",
      entries: [{ url: "https://split.example.test/1", title: "Split wins one" }]
    },
    {
      zenSyncId: "tab-split-wins-2",
      zenWorkspace: "w1",
      groupId: "split-precedence",
      zenLiveFolderItemId: "folder-precedence",
      entries: [{ url: "https://split.example.test/2", title: "Split wins two" }]
    }
  );
  const snapshot = await makeSnapshot(session);
  const folder = snapshot.entities.find((entity) => entity.nativeId === "folder-precedence");
  const split = snapshot.entities.find((entity) => entity.nativeId === "split-precedence");
  assert.deepEqual(folder.members.map((member) => member.nativeId), ["tab-folder-wins"]);
  assert.deepEqual(split.members.map((member) => member.nativeId), ["tab-split-wins-1", "tab-split-wins-2"]);
  assert.equal(snapshot.entities.some((entity) => entity.nativeId === "group-shadowed"), false);
});

test("standalone mutation bindings exclude structured and observation-only members", async () => {
  const session = realisticStructuredSession();
  const { snapshot, summary } = await makeSnapshotWithSummary(session);
  const bindings = sessionTabBindings(snapshot, defineRawSession(session), summary);
  const standalone = snapshot.entities.find((entity) => entity.kind === "tab");
  assert.equal(bindings.size, 1);
  assert.equal(bindings.get(standalone.ref).nativeId, "tab-standalone");

  const withoutNativeIdentity = structuredClone(session);
  delete withoutNativeIdentity.tabs.find((tab) => tab.zenSyncId === "tab-standalone").zenSyncId;
  const rebuilt = await makeSnapshotWithSummary(withoutNativeIdentity);
  const moveTabCapability = rebuilt.snapshot.capabilities.evidence.find((evidence) => evidence.id === "move.tab");
  assert.equal(moveTabCapability.status, "unavailable");
  assert.match(moveTabCapability.reason, /Persisted session observations/);
  assert.equal(sessionTabBindings(rebuilt.snapshot, defineRawSession(withoutNativeIdentity), rebuilt.summary).size, 0);
});

test("standalone Entity refs and apply bindings survive raw tab reorder", async () => {
  const session = baseSession({
    tabs: [
      tab("stable-a", "w1"),
      tab("stable-b", "w2")
    ]
  });
  const original = await makeSnapshotWithSummary(session);
  const reorderedSession = structuredClone(session);
  reorderedSession.tabs.reverse();
  const reordered = await makeSnapshotWithSummary(reorderedSession);
  const refsByNativeId = (snapshot) => Object.fromEntries(
    snapshot.entities
      .filter((entity) => entity.kind === "tab")
      .map((entity) => [entity.nativeId, entity.ref])
  );

  assert.deepEqual(refsByNativeId(reordered.snapshot), refsByNativeId(original.snapshot));

  const bindings = sessionTabBindings(
    original.snapshot,
    defineRawSession(reorderedSession),
    reordered.summary
  );
  const refForA = original.snapshot.entities.find((entity) => entity.nativeId === "stable-a").ref;
  const refForB = original.snapshot.entities.find((entity) => entity.nativeId === "stable-b").ref;
  assert.equal(bindings.get(refForA).rawIndex, 1);
  assert.equal(bindings.get(refForB).rawIndex, 0);
});

test("identity-less observation refs do not expose raw tab position as domain identity", async () => {
  const session = baseSession({
    tabs: [
      tab("discarded-a", "w1", { url: "https://example.test/a" }),
      tab("discarded-b", "w2", { url: "https://example.test/b" })
    ]
  });
  delete session.tabs[0].zenSyncId;
  delete session.tabs[1].zenSyncId;
  const original = await makeSnapshotWithSummary(session);
  const reorderedSession = structuredClone(session);
  reorderedSession.tabs.reverse();
  const reordered = await makeSnapshotWithSummary(reorderedSession);
  const refsByTitle = (snapshot) => Object.fromEntries(
    snapshot.entities
      .filter((entity) => entity.kind === "tab")
      .map((entity) => [entity.title, entity.ref])
  );

  assert.deepEqual(refsByTitle(reordered.snapshot), refsByTitle(original.snapshot));
  assert.ok(original.snapshot.entities.every((entity) => entity.kind !== "tab" || entity.nativeId === null));
  assert.equal(sessionTabBindings(
    original.snapshot,
    defineRawSession(reorderedSession),
    reordered.summary
  ).size, 0);
});

test("authoritative closed capture advertises route capability while isolating unstable tab identities", async () => {
  const stable = await makeAuthoritativeSnapshot(baseSession({ tabs: [tab("stable-tab", "w1")] }));
  assert.equal(
    stable.capabilities.evidence.find((evidence) => evidence.id === "move.tab").status,
    "available"
  );

  const unstableSession = baseSession({ tabs: [tab("discarded-id", "w1")] });
  delete unstableSession.tabs[0].zenSyncId;
  const unstable = await makeAuthoritativeSnapshot(unstableSession);
  const capability = unstable.capabilities.evidence.find((evidence) => evidence.id === "move.tab");
  assert.equal(capability.status, "available");
  assert.match(capability.reason, /observation-only/);

  const unsupported = await makeAuthoritativeSnapshot(
    baseSession({ tabs: [tab("future-tab", "w1")] }),
    structuredClone(DEFAULT_CONFIG),
    { version: "9.99.0", buildId: "20990101000000" }
  );
  const unsupportedCapability = unsupported.capabilities.evidence.find((evidence) => evidence.id === "move.tab");
  assert.equal(unsupported.provenance.zenVersion, "9.99.0");
  assert.equal(unsupported.provenance.schemaFamily, "zen-session-v1");
  assert.equal(unsupportedCapability.status, "unknown");
  assert.match(unsupportedCapability.reason, /No closed-session.*acceptance evidence/iu);
});

test("mixed identity planning moves only stable roots and rejects a forged observation-only Operation", async () => {
  const config = structuredClone(DEFAULT_CONFIG);
  config.rules.domains = { "example.test": "Research" };
  const session = baseSession({
    tabs: [tab("stable-native", "w1"), tab("discarded-native", "w1")]
  });
  delete session.tabs[1].zenSyncId;
  const snapshot = await makeAuthoritativeSnapshot(session, config);
  const stable = snapshot.entities.find((entity) => entity.kind === "tab" && entity.nativeId === "stable-native");
  const observationOnly = snapshot.entities.find((entity) => entity.kind === "tab" && entity.nativeId === null);
  assert.ok(stable && observationOnly);

  const rules = createRulesPlan(snapshot, {
    scope: { kind: "all_workspaces" },
    configRevision: effectiveConfigRevision(config),
    domainRules: config.rules.domains,
    sourceAllowlist: [],
    destinationAllowlist: [],
    destinationDenylist: [],
    only: [],
    except: [],
    includePinned: false,
    includeEssentials: false,
    limit: null,
    autoApplyRequested: true,
    now: CAPTURED_AT
  });
  const stableRule = rules.actions.find((action) => action.disposition === "move" && action.operation.entityRef === stable.ref);
  const unstableRule = rules.actions.find((action) => action.disposition !== "move" && action.entityRef === observationOnly.ref);
  assert.ok(stableRule && unstableRule);
  assert.equal(stableRule.disposition, "move");
  assert.equal(unstableRule.disposition, "review");
  assert.match(unstableRule.decision.autoApply.reason.value, /observation-only/iu);

  const patchInput = {
    operations: [stable, observationOnly].map((entity) => ({
      op: "move",
      entityRef: entity.ref,
      expectedSourceWorkspaceId: "w1",
      destinationWorkspaceId: "w2",
      reason: `Move ${entity.title}`
    }))
  };
  const manual = createManualPlanFromInput(snapshot, patchInput, config);
  const stableManual = manual.plan.actions.find((action) => action.disposition === "move");
  const unstableManual = manual.plan.actions.find((action) => action.disposition === "blocked");
  assert.ok(stableManual && unstableManual);
  assert.equal(stableManual.operation.entityRef, stable.ref);
  assert.equal(unstableManual.entityRef, observationOnly.ref);
  assert.equal(unstableManual.dispositionReason.provenance, "zts_generated");
  assert.match(unstableManual.dispositionReason.value, /cannot move.*observation-only/iu);
  assert.deepEqual(
    manual.patch.operations.map((operation) => operation.reason.referencedEntityRefs),
    [[stable.ref], [observationOnly.ref]]
  );

  const canonical = createManualPlanFromInput(snapshot, structuredClone(manual.patch), config);
  assert.equal(canonical.patch.snapshotRevision, snapshot.revision);
  assert.throws(
    () => createManualPlanFromInput(snapshot, {
      ...structuredClone(manual.patch),
      schemaVersion: "zts.patch.future-1"
    }, config),
    /Unsupported Patch schema version/
  );
  assert.throws(
    () => createManualPlanFromInput(snapshot, {
      snapshotRevision: snapshot.revision,
      operations: patchInput.operations
    }, config),
    /Patch is missing field schemaVersion/
  );

  const forgedAction = {
    actionId: "manual-forged-observation-only",
    disposition: "move",
    operation: {
      ...stableManual.operation,
      entityRef: observationOnly.ref,
      precondition: {
        ...stableManual.operation.precondition,
        entityRevision: observationOnly.revision
      }
    },
    decision: unstableManual.decision
  };
  const {
    digest: _digest,
    profileId: _profileId,
    snapshotRevision: _snapshotRevision,
    snapshotAuthority: _snapshotAuthority,
    snapshotFreshness: _snapshotFreshness,
    ...manualDraft
  } = manual.plan;
  assert.throws(
    () => createPlan(snapshot, { ...manualDraft, id: "plan:forged-observation-only", actions: [forgedAction] }),
    /not mutation-eligible.*observation-only/iu
  );
});

test("authoritative capture rejects a same-size source replacement with restored mtime", async () => {
  const root = await mkdtemp(join(tmpdir(), "zts-authoritative-capture-race-"));
  roots.add(root);
  const profilePath = join(root, "fixture.Default");
  const binPath = join(root, "bin");
  await mkdir(profilePath);
  await mkdir(binPath);
  await writeFile(join(binPath, "ps"), "#!/bin/sh\nexit 0\n");
  await chmod(join(binPath, "ps"), 0o755);
  const sessionPath = join(profilePath, "zen-sessions.jsonlz4");
  const replacementPath = join(profilePath, "replacement.jsonlz4");
  const original = baseSession({ tabs: [tab("native-a", "w1")] });
  const replacement = baseSession({ tabs: [tab("native-b", "w1")] });
  const originalBytes = encodeLiteralJsonLz4ForFixture(original);
  const replacementBytes = encodeLiteralJsonLz4ForFixture(replacement);
  assert.equal(replacementBytes.byteLength, originalBytes.byteLength);
  await writeFile(sessionPath, originalBytes);
  const context = {
    appSupportDir: root,
    profile: {
      id: profileIdForPath(profilePath),
      name: "Fixture",
      path: profilePath,
      isDefault: true,
      fromInstallDefault: true
    },
    running: false,
    runningProcesses: [],
    sessionFile: await findSessionFile(profilePath)
  };
  const previousPath = process.env.PATH;
  process.env.PATH = `${binPath}:${previousPath ?? ""}`;
  let control;
  try {
    control = await acquireNativeProfileControl(context, 0);
    await assert.rejects(
      () => captureControlledSessionSnapshot(
        context,
        control,
        structuredClone(DEFAULT_CONFIG),
        CAPTURED_AT,
        {
          afterSourceRead: async () => {
            const sourceMetadata = await stat(sessionPath);
            await writeFile(replacementPath, replacementBytes);
            await utimes(replacementPath, sourceMetadata.atime, sourceMetadata.mtime);
            await rename(replacementPath, sessionPath);
          }
        }
      ),
      /session source changed across the native-control capture boundary/i
    );
  } finally {
    if (control) await control.release();
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
  }
});

test("malformed structure and ambiguous identity fail closed", async (t) => {
  await t.test("folder cycle", async () => {
    await assert.rejects(() => makeSnapshot(baseSession({
      folders: [
        { id: "a", parentId: "b", workspaceId: "w1" },
        { id: "b", parentId: "a", workspaceId: "w1" }
      ]
    })), /cycle/);
  });
  await t.test("duplicate structure id", async () => {
    await assert.rejects(() => makeSnapshot(baseSession({
      groups: [{ id: "duplicate" }, { id: "duplicate" }]
    })), /Duplicate Zen group id/);
  });
  await t.test("missing structure", async () => {
    await assert.rejects(() => makeSnapshot(baseSession({
      tabs: [tab("tab-missing", "w1", { groupId: "missing" })]
    })), /references missing structure/);
  });
  await t.test("cross-Workspace group", async () => {
    await assert.rejects(() => makeSnapshot(baseSession({
      tabs: [tab("tab-a", "w1", { groupId: "g" }), tab("tab-b", "w2", { groupId: "g" })],
      groups: [{ id: "g" }]
    })), /crosses Workspaces/);
  });
  await t.test("duplicate standalone native ids remain observation-only without disabling unique tabs", async () => {
    const session = baseSession({
      tabs: [tab("same-native", "w1"), tab("same-native", "w1"), tab("unique-native", "w2")]
    });
    const snapshot = await makeAuthoritativeSnapshot(session);
    const { summary } = await makeSnapshotWithSummary(session);
    const entities = snapshot.entities.filter((entity) => entity.kind === "tab");
    assert.equal(entities.length, 3);
    assert.deepEqual(entities.map((entity) => entity.nativeId).sort(), [null, null, "unique-native"]);
    assert.equal(new Set(entities.map((entity) => entity.ref)).size, 3);
    const capability = snapshot.capabilities.evidence.find((evidence) => evidence.id === "move.tab");
    assert.equal(capability.status, "available");
    assert.match(capability.reason, /2 observation-only/);
    const bindings = sessionTabBindings(snapshot, defineRawSession(session), summary);
    assert.equal(bindings.size, 1);
    assert.equal([...bindings.values()][0].nativeId, "unique-native");
  });
  await t.test("split with one member", async () => {
    await assert.rejects(() => makeSnapshot(baseSession({
      tabs: [tab("tab-split", "w1", { groupId: "split" })],
      groups: [{ id: "split", splitView: true }],
      splitViewData: [{ groupId: "split", tabs: ["tab-split"] }]
    })), /at least two tabs/);
  });
  await t.test("duplicate cross-split ownership", async () => {
    await assert.rejects(() => makeSnapshot(baseSession({
      tabs: [{
        ...tab("tab-both", "w1"),
        groupId: "split-a",
        zenLiveFolderItemId: "split-b"
      }],
      groups: [{ id: "split-a", splitView: true }, { id: "split-b", splitView: true }],
      splitViewData: [
        { groupId: "split-a", tabs: ["tab-both"] },
        { groupId: "split-b", tabs: ["tab-both"] }
      ]
    })), /duplicate split-view ownership/);
  });
  await t.test("split closure mismatch", async () => {
    await assert.rejects(() => makeSnapshot(baseSession({
      tabs: [tab("tab-a", "w1", { groupId: "split" }), tab("tab-b", "w1", { groupId: "split" })],
      groups: [{ id: "split", splitView: true }],
      splitViewData: [{ groupId: "split", tabs: ["tab-a", "different-tab"] }]
    })), /tab closure does not match/);
  });
  await t.test("invalid active-state shape", async () => {
    const invalid = tab("tab-active", "w1");
    invalid._zenIsActiveTab = "yes";
    await assert.rejects(() => makeSnapshot(baseSession({ tabs: [invalid] })), /_zenIsActiveTab.*boolean/);
  });
});

test("folder depth and Movement Root member limits are enforced before domain publication", async () => {
  const folders = Array.from({ length: SESSION_STRUCTURE_LIMITS.maxFolderDepth + 1 }, (_, index) => ({
    id: `folder-${index}`,
    parentId: index === 0 ? null : `folder-${index - 1}`,
    ...(index === 0 ? { workspaceId: "w1" } : {})
  }));
  await assert.rejects(() => makeSnapshot(baseSession({ folders })), /maximum depth/);

  const tabs = Array.from({ length: SESSION_STRUCTURE_LIMITS.maxMembersPerMovementRoot + 1 }, (_, index) =>
    tab(`member-${index}`, "w1", { groupId: "large-group" })
  );
  await assert.rejects(
    () => makeSnapshot(baseSession({ tabs, groups: [{ id: "large-group" }] })),
    /member Movement Root limit/
  );
});

function realisticStructuredSession() {
  return baseSession({
    tabs: [
      tab("tab-standalone", "w1", { active: true, url: "https://standalone.example.test" }),
      tab("tab-group-1", "w1", { groupId: "group-normal", pinned: true, url: "https://group.example.test/1" }),
      tab("tab-group-2", "w1", { groupId: "group-normal", url: "https://group.example.test/2" }),
      tab("tab-folder-root", "w1", { groupId: "folder-root", url: "https://folder.example.test/root" }),
      tab("tab-folder-child", "w1", { folderId: "folder-child", url: "https://github.com/project" }),
      tab("tab-folder-grandchild", "w1", { folderId: "folder-grandchild", essential: true, url: "https://folder.example.test/grandchild" }),
      tab("tab-split-1", "w1", { groupId: "split-main", url: "https://split.example.test/1" }),
      tab("tab-split-2", "w1", { groupId: "split-main", url: "https://split.example.test/2" })
    ],
    folders: [
      { id: "folder-root", name: "Research", workspaceId: "w1", parentId: null },
      { id: "folder-child", name: "Implementation", parentId: "folder-root" },
      { id: "folder-grandchild", name: "References", workspaceId: "w1", parentId: "folder-child" }
    ],
    groups: [
      { id: "folder-root", name: "Research alias" },
      { id: "group-normal", name: "Working set" },
      { id: "split-main", name: "Side by side", splitView: true }
    ],
    splitViewData: [{
      groupId: "split-main",
      gridType: "2x1",
      layoutTree: { type: "row", children: [0, 1] },
      tabs: ["tab-split-1", "tab-split-2"]
    }]
  });
}

function baseSession(overrides = {}) {
  return {
    spaces: [{ uuid: "w1", name: "Space" }, { uuid: "w2", name: "Research" }],
    tabs: [],
    folders: [],
    groups: [],
    splitViewData: [],
    ...overrides
  };
}

function tab(id, workspaceId, options = {}) {
  return {
    zenSyncId: id,
    zenWorkspace: workspaceId,
    pinned: Boolean(options.pinned),
    zenEssential: Boolean(options.essential),
    _zenIsActiveTab: Boolean(options.active),
    ...(options.groupId ? { groupId: options.groupId } : {}),
    ...(options.folderId ? { zenLiveFolderItemId: options.folderId } : {}),
    entries: [{ url: options.url ?? `https://example.test/${id}`, title: id }]
  };
}

async function makeSnapshot(rawSession, config = structuredClone(DEFAULT_CONFIG)) {
  return (await makeSnapshotWithSummary(rawSession, config)).snapshot;
}

async function makeSnapshotWithSummary(rawSession, config = structuredClone(DEFAULT_CONFIG)) {
  const root = await mkdtemp(join(tmpdir(), "zts-structured-snapshot-"));
  roots.add(root);
  const profilePath = join(root, "fixture.Default");
  await mkdir(profilePath);
  const source = {
    kind: "zen-sessions",
    path: join(profilePath, "zen-sessions.jsonlz4"),
    exists: true,
    size: 1,
    modifiedMs: 1
  };
  const session = defineRawSession(structuredClone(rawSession));
  const summary = withWorkspacePolicy(summarizeSession(session, source), config);
  const context = {
    appSupportDir: root,
    profile: {
      id: profileIdForPath(profilePath),
      name: "Fixture",
      path: profilePath,
      isDefault: true,
      fromInstallDefault: true
    },
    running: false,
    runningProcesses: [],
    sessionFile: source
  };
  return { snapshot: snapshotFromSession(context, session, summary, config, CAPTURED_AT), summary };
}

function snapshotForSource(rawSession, sourceOverrides, capturedAt) {
  const profilePath = "/tmp/zts-snapshot-source-provenance/fixture.Default";
  const source = {
    kind: "zen-sessions",
    path: `${profilePath}/zen-sessions.jsonlz4`,
    exists: true,
    size: Buffer.byteLength(JSON.stringify(rawSession)),
    modifiedMs: 1,
    ...sourceOverrides
  };
  const context = {
    appSupportDir: "/tmp/zts-snapshot-source-provenance",
    profile: {
      id: profileIdForPath(profilePath),
      name: "Fixture",
      path: profilePath,
      isDefault: true,
      fromInstallDefault: true
    },
    running: false,
    runningProcesses: [],
    sessionFile: source
  };
  const config = structuredClone(DEFAULT_CONFIG);
  const session = defineRawSession(structuredClone(rawSession));
  const summary = withWorkspacePolicy(summarizeSession(session, source), config);
  return snapshotFromSession(context, session, summary, config, capturedAt);
}

async function makeAuthoritativeSnapshot(
  rawSession,
  config = structuredClone(DEFAULT_CONFIG),
  compatibility = { version: "1.19.3b", buildId: "20260315063056" }
) {
  const root = await mkdtemp(join(tmpdir(), "zts-authoritative-structured-snapshot-"));
  roots.add(root);
  const profilePath = join(root, "fixture.Default");
  await mkdir(profilePath);
  const sessionPath = join(profilePath, "zen-sessions.jsonlz4");
  const binPath = join(root, "bin");
  await mkdir(binPath);
  await writeFile(join(binPath, "ps"), "#!/bin/sh\nexit 0\n");
  await chmod(join(binPath, "ps"), 0o755);
  const osAbi = process.arch === "arm64" ? "Darwin_aarch64-gcc3" : "Darwin_x86_64-gcc3";
  await writeFile(
    join(profilePath, "compatibility.ini"),
    `[Compatibility]\nLastVersion=${compatibility.version}_${compatibility.buildId}/${compatibility.buildId}\nLastOSABI=${osAbi}\n`
  );
  await writeFile(sessionPath, encodeLiteralJsonLz4ForFixture(rawSession));
  const context = {
    appSupportDir: root,
    profile: {
      id: profileIdForPath(profilePath),
      name: "Fixture",
      path: profilePath,
      isDefault: true,
      fromInstallDefault: true
    },
    running: false,
    runningProcesses: [],
    sessionFile: await findSessionFile(profilePath)
  };
  const previousPath = process.env.PATH;
  process.env.PATH = `${binPath}:${previousPath ?? ""}`;
  let control;
  try {
    control = await acquireNativeProfileControl(context, 0);
    return (await captureControlledSessionSnapshot(context, control, config, CAPTURED_AT)).snapshot;
  } finally {
    if (control) await control.release();
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
  }
}
