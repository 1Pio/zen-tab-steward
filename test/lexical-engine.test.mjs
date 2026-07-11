import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_CONFIG, effectiveConfigRevision } from "../dist/config.js";
import { createLexicalPlan } from "../dist/engines/lexical.js";
import { buildWorkspaceProfileCorpus } from "../dist/engines/workspace-profile.js";
import { profileIdForPath } from "../dist/profile.js";
import { snapshotFromSession } from "../dist/session-snapshot.js";
import { defineRawSession, summarizeSession, withWorkspacePolicy } from "../dist/session.js";

const CAPTURED_AT = new Date("2026-07-11T12:00:00.000Z");

test("lexical removes protected and policy-denied destinations before ranking", () => {
  const config = structuredClone(DEFAULT_CONFIG);
  config.protect.workspaces.from = ["Stash"];
  config.protect.workspaces.to = ["Stash"];
  const snapshot = makeSnapshot(config, {
    spaces: [
      { uuid: "w-inbox", name: "Inbox" },
      { uuid: "w-development", name: "Development" },
      { uuid: "w-research", name: "Research" },
      { uuid: "w-stash", name: "Stash" }
    ],
    tabs: [
      tab("target", "w-inbox", "Secret archive notes", "https://private.example.test/archive"),
      tab("development", "w-development", "Development code", "https://code.example.test/project"),
      tab("research", "w-research", "Secret archive notes", "https://papers.example.test/archive"),
      tab("stash", "w-stash", "Secret archive notes", "https://private.example.test/archive")
    ],
    folders: [],
    groups: [],
    splitViewData: []
  });
  const plan = createLexicalPlan(snapshot, planOptions(config, {
    destinationDenylist: ["w-research"],
    suggestionThreshold: 0,
    minimumMargin: 0
  }));

  const stashAction = actionForNativeId(plan, snapshot, "stash");
  assert.equal(stashAction.disposition, "protected");
  assert.equal(stashAction.candidateDestinationWorkspaceId, null);

  const targetAction = actionForNativeId(plan, snapshot, "target");
  assert.notEqual(targetAction.candidateDestinationWorkspaceId, "w-stash");
  assert.notEqual(targetAction.candidateDestinationWorkspaceId, "w-research");
  assert.doesNotMatch(targetAction.decision.explanation.value, /\[w-stash\]|\[w-research\]/u);
});

test("lexical duplicate-name ties are deterministic and remain unsuggested below the margin", () => {
  const config = structuredClone(DEFAULT_CONFIG);
  const session = {
    spaces: [
      { uuid: "w-inbox", name: "Inbox" },
      { uuid: "w-research-b", name: "Research" },
      { uuid: "w-research-a", name: "Research" }
    ],
    tabs: [tab("target", "w-inbox", "Research paper", "https://papers.example.test/article")],
    folders: [],
    groups: [],
    splitViewData: []
  };
  const snapshot = makeSnapshot(config, session);
  const options = planOptions(config, { suggestionThreshold: 0.1, minimumMargin: 0.05 });
  const first = actionForNativeId(createLexicalPlan(snapshot, options), snapshot, "target");
  const second = actionForNativeId(createLexicalPlan(snapshot, options), snapshot, "target");

  assert.equal(first.candidateDestinationWorkspaceId, "w-research-a");
  assert.equal(first.disposition, "review");
  assert.equal(first.decision.margin, 0);
  assert.equal(first.decision.suggested, false);
  assert.deepEqual(second, first);
});

test("lexical leaves the current Entity out of its source profile so a misplaced tab can outrank Inbox", () => {
  const config = structuredClone(DEFAULT_CONFIG);
  const snapshot = makeSnapshot(config, {
    spaces: [
      { uuid: "w-inbox", name: "Inbox" },
      { uuid: "w-development", name: "Development" },
      { uuid: "w-research", name: "Research" }
    ],
    tabs: [
      tab("misplaced", "w-inbox", "TypeScript compiler API issue", "https://github.com/microsoft/TypeScript/issues/1"),
      tab("development-a", "w-development", "Node TypeScript API", "https://nodejs.org/api/typescript.html"),
      tab("development-b", "w-development", "TypeScript compiler source", "https://github.com/microsoft/TypeScript"),
      tab("research", "w-research", "Machine learning research", "https://arxiv.org/abs/1")
    ],
    folders: [],
    groups: [],
    splitViewData: []
  });
  const action = actionForNativeId(
    createLexicalPlan(snapshot, planOptions(config, { suggestionThreshold: 0.1 })),
    snapshot,
    "misplaced"
  );

  assert.equal(action.candidateDestinationWorkspaceId, "w-development");
  assert.match(action.decision.explanation.value, /: 1\. Development \[w-development\]/u);
});

test("lexical bounds hostile browser text and remains byte-for-byte deterministic", () => {
  const config = structuredClone(DEFAULT_CONFIG);
  const hostile = `\u001b[31m\u202e${"TypeScript compiler ".repeat(20_000)}`;
  const snapshot = makeSnapshot(config, {
    spaces: [
      { uuid: "w-inbox", name: "Inbox" },
      { uuid: "w-development", name: `Development ${hostile}` }
    ],
    tabs: [
      tab("target", "w-inbox", hostile, `https://example.test/${hostile}`),
      tab("sample", "w-development", hostile, "https://example.test/typescript")
    ],
    folders: [],
    groups: [],
    splitViewData: []
  });
  const options = planOptions(config, { suggestionThreshold: 0.1, minimumMargin: 0 });
  const first = createLexicalPlan(snapshot, options);
  const second = createLexicalPlan(snapshot, options);
  const action = actionForNativeId(first, snapshot, "target");

  assert.deepEqual(second, first);
  assert.ok(Buffer.byteLength(action.decision.explanation.value, "utf8") <= 2 * 1024);
  assert.equal(action.decision.explanation.provenance, "engine_generated");
  assert.equal(action.decision.explanation.interpretation, "data_only");
});

test("lexical keeps a same-source zero-evidence winner in review", () => {
  const config = structuredClone(DEFAULT_CONFIG);
  const snapshot = makeSnapshot(config, {
    spaces: [
      { uuid: "w-a", name: "Inbox" },
      { uuid: "w-b", name: "Reference" }
    ],
    tabs: [tab("unknown", "w-a", "Qzxv", "https://qzxv.invalid/")],
    folders: [],
    groups: [],
    splitViewData: []
  });
  const action = actionForNativeId(
    createLexicalPlan(snapshot, planOptions(config, { suggestionThreshold: 0.2 })),
    snapshot,
    "unknown"
  );

  assert.equal(action.candidateDestinationWorkspaceId, "w-a");
  assert.equal(action.disposition, "review");
  assert.equal(action.decision.suggested, false);
  assert.match(action.dispositionReason.value, /no bounded token overlap/iu);
});

test("lexical refuses incomplete classification of a Movement Root above its member cap", () => {
  const config = structuredClone(DEFAULT_CONFIG);
  const groupedTabs = Array.from({ length: 65 }, (_, index) => ({
    ...tab(`group-member-${index}`, "w-inbox", `Development member ${index}`, `https://code.example.test/${index}`),
    groupId: "group-large"
  }));
  const snapshot = makeSnapshot(config, {
    spaces: [
      { uuid: "w-inbox", name: "Inbox" },
      { uuid: "w-development", name: "Development" }
    ],
    tabs: [
      ...groupedTabs,
      tab("development-sample", "w-development", "Development code", "https://code.example.test/sample")
    ],
    folders: [],
    groups: [{ id: "group-large", name: "Large group" }],
    splitViewData: []
  });
  const action = actionForNativeId(
    createLexicalPlan(snapshot, planOptions(config, { suggestionThreshold: 0 })),
    snapshot,
    "group-large"
  );

  assert.equal(action.disposition, "review");
  assert.equal(action.candidateDestinationWorkspaceId, null);
  assert.match(action.dispositionReason.value, /65 members.+complete-input limit is 64/iu);
});

test("workspace profiles bind names, rules, strong exemplars, weak domain-balanced samples, and source exclusion", () => {
  const config = structuredClone(DEFAULT_CONFIG);
  config.defaults.inbox = "Inbox";
  config.rules.domains = { "github.com": "w-development" };
  const snapshot = makeSnapshot(config, {
    spaces: [
      { uuid: "w-inbox", name: "Inbox" },
      { uuid: "w-development", name: "Development" }
    ],
    tabs: [
      tab("inbox-ordinary", "w-inbox", "Unorganized code", "https://github.com/inbox"),
      { ...tab("development-pinned", "w-development", "Pinned TypeScript guide", "https://typescriptlang.org/guide"), pinned: true },
      tab("development-github-a", "w-development", "GitHub project A", "https://github.com/a"),
      tab("development-github-b", "w-development", "GitHub project B", "https://github.com/b"),
      tab("development-node", "w-development", "Node API", "https://nodejs.org/api")
    ],
    folders: [],
    groups: [],
    splitViewData: []
  });
  const corpus = buildWorkspaceProfileCorpus(snapshot, {
    inboxSelector: "Inbox",
    sourceSelectors: [],
    domainRules: config.rules.domains
  });
  const inbox = corpus.profiles.find((profile) => profile.workspaceId === "w-inbox");
  const development = corpus.profiles.find((profile) => profile.workspaceId === "w-development");
  assert.ok(inbox && development);
  assert.equal(inbox.destinationEligible, false);
  assert.equal(inbox.weakExemplars.length, 0);
  assert.deepEqual(development.ruleDomains.map((entry) => entry.value), ["github.com"]);
  assert.deepEqual(development.strongExemplars.map((entry) => entry.primaryDomain), ["typescriptlang.org"]);
  assert.deepEqual(
    development.weakExemplars.map((entry) => entry.primaryDomain),
    ["github.com", "nodejs.org", "github.com"]
  );

  const sourceExcluded = buildWorkspaceProfileCorpus(snapshot, {
    inboxSelector: "Inbox",
    sourceSelectors: ["w-development"],
    domainRules: config.rules.domains
  });
  const excludedDevelopment = sourceExcluded.profiles.find((profile) => profile.workspaceId === "w-development");
  assert.equal(excludedDevelopment.destinationEligible, false);
  assert.equal(excludedDevelopment.weakExemplars.length, 0);
  assert.equal(excludedDevelopment.strongExemplars.length, 1);
  assert.notEqual(sourceExcluded.revision, corpus.revision);
  assert.equal(
    buildWorkspaceProfileCorpus(snapshot, {
      inboxSelector: "Inbox",
      sourceSelectors: [],
      domainRules: config.rules.domains
    }).revision,
    corpus.revision
  );
});

function makeSnapshot(config, value) {
  const profilePath = "/tmp/zts-lexical-engine/fixture.Default";
  const source = {
    kind: "zen-sessions",
    path: `${profilePath}/zen-sessions.jsonlz4`,
    exists: true,
    size: 1,
    modifiedMs: 1
  };
  const session = defineRawSession(structuredClone(value));
  const summary = withWorkspacePolicy(summarizeSession(session, source), config);
  const context = {
    appSupportDir: "/tmp/zts-lexical-engine",
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
  return snapshotFromSession(context, session, summary, config, CAPTURED_AT);
}

function planOptions(config, overrides = {}) {
  return {
    scope: { kind: "all_workspaces" },
    configRevision: effectiveConfigRevision(config),
    sourceAllowlist: [],
    destinationAllowlist: [],
    destinationDenylist: [],
    only: [],
    except: [],
    includePinned: false,
    includeEssentials: false,
    limit: null,
    autoApplyRequested: false,
    suggestionThreshold: 0.2,
    minimumMargin: 0.05,
    inboxSelector: config.defaults.inbox,
    domainRules: config.rules.domains,
    now: CAPTURED_AT,
    ...overrides
  };
}

function tab(id, workspaceId, title, url) {
  return {
    zenSyncId: id,
    zenWorkspace: workspaceId,
    pinned: false,
    entries: [{ title, url }]
  };
}

function actionForNativeId(plan, snapshot, nativeId) {
  const entity = snapshot.entities.find((candidate) => candidate.nativeId === nativeId);
  assert.ok(entity, `missing Entity ${nativeId}`);
  const action = plan.actions.find((candidate) =>
    (candidate.disposition === "move" ? candidate.operation.entityRef : candidate.entityRef) === entity.ref
  );
  assert.ok(action, `missing action for ${nativeId}`);
  return action;
}
