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
  to: [],
  notTo: [],
  only: [],
  except: [],
  backend: "auto"
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
  assert.equal(plan.skipCount, 3);
  assert.equal(plan.reviewCount, 1);
  assert.deepEqual(
    plan.plannedActions.map((action) => action.destinationWorkspaceName),
    ["Portfolio", "Tool Development"]
  );
  assert.deepEqual(
    plan.skippedActions.map((action) => action.reason),
    ["pinned_protected", "essential_protected", "grouped_or_foldered_protected"]
  );
  assert.equal(plan.reviewActions[0].reason, "no_deterministic_rule");
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
