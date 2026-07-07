import assert from "node:assert/strict";
import test from "node:test";
import { planSortPreview } from "../dist/sort.js";
import { summarizeSession } from "../dist/session.js";

const source = {
  kind: "zen-sessions",
  path: "/tmp/profile/zen-sessions.jsonlz4",
  exists: true,
  size: 100,
  modifiedMs: 123
};

const inputs = {
  preview: true,
  dryRun: false,
  minConfidence: 0.8,
  includePinned: false,
  includeEssentials: false,
  to: [],
  notTo: [],
  only: [],
  except: [],
  limit: null,
  backend: "auto",
  domainRules: {
    "framer.com": "Portfolio",
    "framer.university": "Portfolio",
    "github.com": "Tool Development"
  },
  protectedDomains: []
};

test("plans deterministic domain-rule moves and protection skips without applying", () => {
  const session = {
    spaces: [
      { uuid: "w1", name: "Space" },
      { uuid: "w2", name: "Portfolio" },
      { uuid: "w3", name: "Tool Development" }
    ],
    tabs: [
      { zenWorkspace: "w1", entries: [{ url: "https://framer.com/projects/site", title: "Framer" }] },
      { zenWorkspace: "w1", entries: [{ url: "https://github.com/1Pio/zen-tab-steward", title: "Repo" }] },
      { zenWorkspace: "w1", pinned: true, entries: [{ url: "https://github.com/pinned", title: "Pinned" }] },
      { zenWorkspace: "w1", zenEssential: true, entries: [{ url: "https://framer.com/essential", title: "Essential" }] },
      { zenWorkspace: "w1", groupId: "g1", entries: [{ url: "https://framer.com/grouped", title: "Grouped" }] },
      { zenWorkspace: "w1", entries: [{ url: "https://example.com/unknown", title: "Unknown" }] }
    ],
    folders: [],
    groups: [{ id: "g1", name: "Grouped" }]
  };
  const summary = summarizeSession(session, source);
  const plan = planSortPreview(session, summary, summary.workspaces[0], inputs);

  assert.equal(plan.moveCount, 2);
  assert.equal(plan.skipCount, 2);
  assert.equal(plan.reviewCount, 2);
  assert.equal(plan.blockedCount, 0);
  assert.deepEqual(
    plan.plannedActions.map((action) => action.destinationWorkspaceName),
    ["Portfolio", "Tool Development"]
  );
  assert.deepEqual(
    plan.skippedActions.map((action) => action.reason),
    ["pinned_protected", "essential_protected"]
  );
  assert.deepEqual(
    plan.reviewActions.map((action) => action.reason),
    ["structured_entity_review", "no_deterministic_rule"]
  );
  assert.equal(plan.reviewActions[0].entityType, "group");
  assert.equal(plan.reviewActions[0].childTabCount, 1);
});

test("blocks protected domains and protected destination workspaces", () => {
  const session = {
    spaces: [
      { uuid: "w1", name: "Space" },
      { uuid: "w2", name: "Portfolio" },
      { uuid: "w3", name: "Tool Development", }
    ],
    tabs: [
      { zenWorkspace: "w1", entries: [{ url: "https://framer.com/projects/site", title: "Framer" }] },
      { zenWorkspace: "w1", entries: [{ url: "https://github.com/1Pio/zen-tab-steward", title: "Repo" }] }
    ],
    folders: [],
    groups: []
  };
  const summary = summarizeSession(session, source);
  const protectedSummary = {
    ...summary,
    workspaces: summary.workspaces.map((workspace) => ({
      ...workspace,
      protectedStatus: workspace.name === "Portfolio" ? "to" : "none",
      sortableTo: workspace.name !== "Portfolio"
    }))
  };
  const plan = planSortPreview(session, protectedSummary, protectedSummary.workspaces[0], {
    ...inputs,
    protectedDomains: ["github.com"]
  });

  assert.equal(plan.moveCount, 0);
  assert.equal(plan.blockedCount, 2);
  assert.deepEqual(
    plan.blockedActions.map((action) => action.reason),
    ["destination_workspace_protected", "domain_protected"]
  );
});

test("distinguishes source allowlist blocks from protected source blocks", () => {
  const session = {
    spaces: [
      { uuid: "w1", name: "Space" },
      { uuid: "w2", name: "Portfolio" }
    ],
    tabs: [
      { zenWorkspace: "w1", entries: [{ url: "https://framer.com/projects/site", title: "Framer" }] }
    ],
    folders: [],
    groups: []
  };
  const summary = summarizeSession(session, source);
  const allowlistBlockedSummary = {
    ...summary,
    workspaces: summary.workspaces.map((workspace) => ({
      ...workspace,
      sortableFrom: workspace.name !== "Space"
    }))
  };
  const protectedSummary = {
    ...summary,
    workspaces: summary.workspaces.map((workspace) => ({
      ...workspace,
      protectedStatus: workspace.name === "Space" ? "from" : "none",
      sortableFrom: workspace.name !== "Space"
    }))
  };

  const allowlistPlan = planSortPreview(session, allowlistBlockedSummary, allowlistBlockedSummary.workspaces[0], inputs);
  const protectedPlan = planSortPreview(session, protectedSummary, protectedSummary.workspaces[0], inputs);

  assert.equal(allowlistPlan.blockedActions[0].reason, "source_workspace_not_allowed");
  assert.match(allowlistPlan.blockedActions[0].explanation, /not allowed/);
  assert.equal(protectedPlan.blockedActions[0].reason, "source_workspace_protected");
  assert.match(protectedPlan.blockedActions[0].explanation, /protected/);
});

test("respects only, except, to, and not-to filters", () => {
  const session = {
    spaces: [
      { uuid: "w1", name: "Space" },
      { uuid: "w2", name: "Portfolio" },
      { uuid: "w3", name: "Tool Development" }
    ],
    tabs: [
      { zenWorkspace: "w1", entries: [{ url: "https://framer.com/projects/site", title: "Framer" }] },
      { zenWorkspace: "w1", entries: [{ url: "https://github.com/1Pio/zen-tab-steward", title: "Repo" }] }
    ],
    folders: [],
    groups: []
  };
  const summary = summarizeSession(session, source);
  const plan = planSortPreview(session, summary, summary.workspaces[0], {
    ...inputs,
    to: ["Portfolio"],
    notTo: ["Tool Development"],
    only: ["framer.com"],
    except: ["github.com"]
  });

  assert.equal(plan.moveCount, 1);
  assert.equal(plan.skipCount, 1);
  assert.equal(plan.plannedActions[0].destinationWorkspaceName, "Portfolio");
  assert.equal(plan.skippedActions[0].reason, "excluded_by_filter");
});

test("routes deterministic matches below min confidence to review", () => {
  const session = {
    spaces: [
      { uuid: "w1", name: "Space" },
      { uuid: "w2", name: "Portfolio" }
    ],
    tabs: [
      { zenWorkspace: "w1", entries: [{ url: "https://framer.com/projects/site", title: "Framer" }] }
    ],
    folders: [],
    groups: []
  };
  const summary = summarizeSession(session, source);
  const plan = planSortPreview(session, summary, summary.workspaces[0], {
    ...inputs,
    minConfidence: 0.95
  });

  assert.equal(plan.moveCount, 0);
  assert.equal(plan.reviewCount, 1);
  assert.equal(plan.reviewActions[0].reason, "below_min_confidence");
  assert.equal(plan.reviewActions[0].destinationWorkspaceName, "Portfolio");
});

test("limits planned moves without hiding eligible overflow actions", () => {
  const session = {
    spaces: [
      { uuid: "w1", name: "Space" },
      { uuid: "w2", name: "Portfolio" },
      { uuid: "w3", name: "Tool Development" }
    ],
    tabs: [
      { zenWorkspace: "w1", entries: [{ url: "https://framer.com/projects/site", title: "Framer" }] },
      { zenWorkspace: "w1", entries: [{ url: "https://github.com/1Pio/zen-tab-steward", title: "Repo" }] },
      { zenWorkspace: "w1", entries: [{ url: "https://framer.university/course", title: "Course" }] }
    ],
    folders: [],
    groups: []
  };
  const summary = summarizeSession(session, source);
  const plan = planSortPreview(session, summary, summary.workspaces[0], {
    ...inputs,
    limit: 1
  });

  assert.equal(plan.moveCount, 1);
  assert.equal(plan.reviewCount, 2);
  assert.equal(plan.plannedActions[0].title, "Framer");
  assert.deepEqual(
    plan.reviewActions.map((action) => action.reason),
    ["over_move_limit", "over_move_limit"]
  );
  assert.deepEqual(
    plan.destinationSummaries.map((destination) => [destination.workspaceName, destination.tabCount]),
    [["Portfolio", 1]]
  );
});

test("uses configured domain rules as deterministic destinations", () => {
  const session = {
    spaces: [
      { uuid: "w1", name: "Space" },
      { uuid: "w2", name: "Research" }
    ],
    tabs: [
      { zenWorkspace: "w1", entries: [{ url: "https://docs.example.com/page", title: "Docs" }] }
    ],
    folders: [],
    groups: []
  };
  const summary = summarizeSession(session, source);
  const plan = planSortPreview(session, summary, summary.workspaces[0], {
    ...inputs,
    domainRules: { "docs.example.com": "Research" }
  });

  assert.equal(plan.moveCount, 1);
  assert.equal(plan.plannedActions[0].destinationWorkspaceName, "Research");
  assert.equal(plan.plannedActions[0].explanation, "Domain docs.example.com matched docs.example.com");
});

test("represents foldered tabs as one structured review entity", () => {
  const session = {
    spaces: [
      { uuid: "w1", name: "Space" },
      { uuid: "w2", name: "Portfolio" }
    ],
    tabs: [
      { zenWorkspace: "w1", zenLiveFolderItemId: "f1", entries: [{ url: "https://framer.com/projects/site", title: "Framer" }] },
      { zenWorkspace: "w1", zenLiveFolderItemId: "f1", entries: [{ url: "https://framer.university/course", title: "Course" }] }
    ],
    folders: [{ id: "f1", name: "Framer Folder", workspaceId: "w1" }],
    groups: []
  };
  const summary = summarizeSession(session, source);
  const plan = planSortPreview(session, summary, summary.workspaces[0], inputs);

  assert.equal(plan.moveCount, 0);
  assert.equal(plan.skipCount, 0);
  assert.equal(plan.reviewCount, 1);
  assert.equal(plan.reviewActions[0].entityType, "folder");
  assert.equal(plan.reviewActions[0].title, "Framer Folder");
  assert.equal(plan.reviewActions[0].childTabCount, 2);
  assert.deepEqual(plan.reviewActions[0].tabIndices, [0, 1]);
  assert.deepEqual(plan.reviewActions[0].domains, ["framer.com", "framer.university"]);
  assert.deepEqual(plan.reviewActions[0].urls, ["https://framer.com/projects/site", "https://framer.university/course"]);
  assert.equal(plan.reviewActions[0].destinationWorkspaceName, "Portfolio");
  assert.match(plan.reviewActions[0].explanation, /grouped\/foldered apply is not enabled/);
});

test("applies filters and destination policy to structured entities conservatively", () => {
  const session = {
    spaces: [
      { uuid: "w1", name: "Space" },
      { uuid: "w2", name: "Portfolio" }
    ],
    tabs: [
      { zenWorkspace: "w1", zenLiveFolderItemId: "f1", entries: [{ url: "https://framer.com/projects/site", title: "Framer" }] },
      { zenWorkspace: "w1", zenLiveFolderItemId: "f1", entries: [{ url: "https://framer.university/course", title: "Course" }] }
    ],
    folders: [{ id: "f1", name: "Framer Folder", workspaceId: "w1" }],
    groups: []
  };
  const summary = summarizeSession(session, source);
  const excludedPlan = planSortPreview(session, summary, summary.workspaces[0], {
    ...inputs,
    except: ["framer.university"]
  });
  const destinationDeniedPlan = planSortPreview(session, summary, summary.workspaces[0], {
    ...inputs,
    notTo: ["Portfolio"]
  });

  assert.equal(excludedPlan.skipCount, 1);
  assert.equal(excludedPlan.skippedActions[0].entityType, "folder");
  assert.equal(excludedPlan.skippedActions[0].reason, "excluded_by_filter");
  assert.equal(destinationDeniedPlan.blockedCount, 1);
  assert.equal(destinationDeniedPlan.blockedActions[0].entityType, "folder");
  assert.equal(destinationDeniedPlan.blockedActions[0].reason, "destination_not_allowed");
  assert.equal(destinationDeniedPlan.blockedActions[0].destinationWorkspaceName, "Portfolio");
});

test("does not suggest destinations for mixed or partially unclassified structured entities", () => {
  const session = {
    spaces: [
      { uuid: "w1", name: "Space" },
      { uuid: "w2", name: "Portfolio" }
    ],
    tabs: [
      { zenWorkspace: "w1", zenLiveFolderItemId: "f1", entries: [{ url: "https://framer.com/projects/site", title: "Framer" }] },
      { zenWorkspace: "w1", zenLiveFolderItemId: "f1", entries: [{ url: "https://example.com/unknown", title: "Unknown" }] }
    ],
    folders: [{ id: "f1", name: "Mixed Folder", workspaceId: "w1" }],
    groups: []
  };
  const summary = summarizeSession(session, source);
  const plan = planSortPreview(session, summary, summary.workspaces[0], inputs);

  assert.equal(plan.reviewCount, 1);
  assert.equal(plan.reviewActions[0].entityType, "folder");
  assert.equal(plan.reviewActions[0].destinationWorkspaceId, null);
  assert.equal(plan.reviewActions[0].destinationWorkspaceName, null);
  assert.equal(plan.reviewActions[0].confidence, 0);
});
