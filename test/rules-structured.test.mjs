import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_CONFIG, effectiveConfigRevision } from "../dist/config.js";
import { createRulesPlan } from "../dist/engines/rules.js";
import { profileIdForPath } from "../dist/profile.js";
import { snapshotFromSession } from "../dist/session-snapshot.js";
import { defineRawSession, summarizeSession, withWorkspacePolicy } from "../dist/session.js";

const CAPTURED_AT = new Date("2026-07-11T08:00:00.000Z");

test("rules classify the complete nested-folder Movement Root and expose unavailable-route review", () => {
  const { snapshot, config } = structuredFixture();
  const plan = createRulesPlan(snapshot, planOptions(config));
  const root = snapshot.entities.find((entity) => entity.nativeId === "folder-root");
  assert.ok(root);

  const action = actionFor(plan, root.ref);
  assert.equal(root.members.length, 0, "the fixture proves classification cannot rely on direct root members");
  assert.equal(action.disposition, "review");
  assert.equal(action.candidateDestinationWorkspaceId, "w-research");
  assert.equal(action.decision.trustClass, "rule_exact");
  assert.equal(action.decision.autoApply.status, "ineligible");
  assert.match(action.decision.autoApply.reason.value, /cannot execute this zen_folder move/iu);
  assert.equal(action.dispositionReason.provenance, "zts_generated");
  assert.equal(action.dispositionReason.interpretation, "data_only");
  assert.match(action.dispositionReason.value, /cannot move.*current Snapshot/iu);
  assert.notEqual(action.dispositionReason.value, action.decision.explanation.value);
  assert.equal(plan.actions.some((candidate) => entityRef(candidate) === root.childRefs[0]), false);
});

test("rules filters inspect descendant members without splitting a nested folder", () => {
  const { snapshot, config } = structuredFixture();
  const root = snapshot.entities.find((entity) => entity.nativeId === "folder-root");
  assert.ok(root);

  const excluded = createRulesPlan(snapshot, planOptions(config, {
    except: ["nested.example.test"]
  }));
  const excludedAction = actionFor(excluded, root.ref);
  assert.equal(excludedAction.disposition, "unchanged");
  assert.match(excludedAction.decision.explanation.value, /excluded/iu);
  assert.match(excludedAction.dispositionReason.value, /excluded by the active filter/iu);

  const allowed = createRulesPlan(snapshot, planOptions(config, {
    only: ["nested.example.test"]
  }));
  const allowedAction = actionFor(allowed, root.ref);
  assert.equal(allowedAction.disposition, "review");
  assert.equal(allowedAction.candidateDestinationWorkspaceId, "w-research");
  assert.equal(allowedAction.decision.trustClass, "rule_exact");
});

test("rules never resolve a duplicate Workspace name by iteration order", () => {
  const { snapshot, config } = structuredFixture({ duplicateDestinationName: true });
  const root = snapshot.entities.find((entity) => entity.nativeId === "folder-root");
  assert.ok(root);
  const action = actionFor(createRulesPlan(snapshot, planOptions(config)), root.ref);
  assert.equal(action.disposition, "review");
  assert.equal(action.candidateDestinationWorkspaceId, null);
  assert.equal(action.decision.trustClass, "unknown");
  assert.match(action.decision.explanation.value, /more than one Workspace/iu);

  config.rules.domains = { "nested.example.test": "w-research" };
  const identityBound = actionFor(createRulesPlan(snapshot, planOptions(config)), root.ref);
  assert.equal(identityBound.disposition, "review");
  assert.equal(identityBound.candidateDestinationWorkspaceId, "w-research");
  assert.equal(identityBound.decision.trustClass, "rule_exact");
});

function structuredFixture(options = {}) {
  const profilePath = "/tmp/zts-rules-structured/fixture.Default";
  const source = {
    kind: "zen-sessions",
    path: `${profilePath}/zen-sessions.jsonlz4`,
    exists: true,
    size: 1,
    modifiedMs: 1
  };
  const config = structuredClone(DEFAULT_CONFIG);
  config.rules.domains = { "nested.example.test": "Research" };
  const session = defineRawSession({
    spaces: [
      { uuid: "w-space", name: "Space" },
      { uuid: "w-research", name: "Research" },
      ...(options.duplicateDestinationName ? [{ uuid: "w-research-other", name: "Research" }] : [])
    ],
    tabs: [{
      zenSyncId: "tab-nested",
      zenWorkspace: "w-space",
      zenLiveFolderItemId: "folder-child",
      entries: [{ url: "https://nested.example.test/article", title: "Nested article" }]
    }],
    folders: [
      { id: "folder-root", name: "Root", workspaceId: "w-space", parentId: null },
      { id: "folder-child", name: "Child", parentId: "folder-root" }
    ],
    groups: [],
    splitViewData: []
  });
  const summary = withWorkspacePolicy(summarizeSession(session, source), config);
  const context = {
    appSupportDir: "/tmp/zts-rules-structured",
    profile: {
      id: profileIdForPath(profilePath),
      name: "Fixture",
      path: profilePath,
      isDefault: true,
      fromInstallDefault: true
    },
    running: true,
    runningProcesses: [],
    sessionFile: source
  };
  return {
    config,
    snapshot: snapshotFromSession(context, session, summary, config, CAPTURED_AT)
  };
}

function planOptions(config, overrides = {}) {
  return {
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
    now: CAPTURED_AT,
    ...overrides
  };
}

function actionFor(plan, ref) {
  const action = plan.actions.find((candidate) => entityRef(candidate) === ref);
  assert.ok(action, `missing action for ${ref}`);
  return action;
}

function entityRef(action) {
  return action.disposition === "move" ? action.operation.entityRef : action.entityRef;
}
