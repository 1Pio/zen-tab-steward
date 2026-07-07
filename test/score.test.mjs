import assert from "node:assert/strict";
import test from "node:test";
import { combine, scoreTabAgainstWorkspaces } from "../dist/embeddings/score.js";
import { lexicalProvider } from "../dist/embeddings/lexical-provider.js";
import { scoreTabsSemantically } from "../dist/embeddings/index.js";

const fieldWeights = { title: 1, url: 0.7, domain: 1.2, description: 0.6 };

test("combine redistributes the dense weight across lexical+domain when dense is unavailable", () => {
  const options = { componentWeights: { lexical: 0.45, dense: 0.4, domain: 0.15 }, denseAvailable: false };
  const denseOnly = combine({ lexical: 0.6, dense: 0.9, domain: 0.2 }, options);
  // dense is dropped; weight redistributed so lexical+domain still sum to 1
  assert.ok(denseOnly > 0.4 && denseOnly < 0.7, `lexical-only combine got ${denseOnly}`);
  assert.equal(combine({ lexical: 1, dense: 1, domain: 1 }, { componentWeights: { lexical: 0, dense: 0, domain: 0 }, denseAvailable: true }), 0);
});

test("hybrid combine uses all three when dense is available", () => {
  const full = combine({ lexical: 0.5, dense: 0.5, domain: 0.5 }, { componentWeights: { lexical: 0.45, dense: 0.4, domain: 0.15 }, denseAvailable: true });
  assert.ok(Math.abs(full - 0.5) < 1e-9);
});

test("scoreTabAgainstWorkspaces picks the affinity workspace and respects confidence/margin gating", async () => {
  const session = {
    spaces: [
      { uuid: "w-space", name: "Space" },
      { uuid: "w-dev", name: "Tool Development" },
      { uuid: "w-travel", name: "Travel" }
    ],
    tabs: [
      { zenWorkspace: "w-space", entries: [{ url: "https://github.com/1Pio/zen-tab-steward", title: "zen-tab-steward repo" }] }
    ]
  };
  const summary = {
    workspaces: [
      { id: "w-space", name: "Space", order: 0, tabCount: 1, pinnedCount: 0, essentialCount: 0, folderCount: 0, groupCount: 0, folderGroupCount: 0, protectedStatus: "none", defaultInbox: true, sortableFrom: true, sortableTo: true },
      { id: "w-dev", name: "Tool Development", order: 1, tabCount: 0, pinnedCount: 0, essentialCount: 0, folderCount: 0, groupCount: 0, folderGroupCount: 0, protectedStatus: "none", defaultInbox: false, sortableFrom: true, sortableTo: true },
      { id: "w-travel", name: "Travel", order: 2, tabCount: 0, pinnedCount: 0, essentialCount: 0, folderCount: 0, groupCount: 0, folderGroupCount: 0, protectedStatus: "none", defaultInbox: false, sortableFrom: true, sortableTo: true }
    ]
  };

  const domainRules = { "github.com": "Tool Development" };
  const decisions = await scoreTabsSemantically({
    session,
    summary,
    domainRules,
    provider: lexicalProvider,
    weights: fieldWeights,
    options: {
      fieldWeights,
      componentWeights: { lexical: 0.45, dense: 0.4, domain: 0.15 },
      minConfidence: 0.0,
      minMargin: 0.0,
      reviewOnTie: true,
      denseAvailable: false
    },
    tabs: [{ entityId: "t0", title: "zen-tab-steward repo", url: "https://github.com/1Pio/zen-tab-steward", domain: "github.com" }],
    sourceWorkspaceId: "w-space"
  });
  const decision = decisions.get("t0");
  assert.ok(decision?.top, "expected a top candidate");
  assert.equal(decision.top.workspaceId, "w-dev");
  assert.equal(decision.move, true);
});

test("low-confidence semantic match routes to review instead of move", async () => {
  const session = {
    spaces: [
      { uuid: "w-space", name: "Space" },
      { uuid: "w-misc", name: "Notes" }
    ],
    tabs: [{ zenWorkspace: "w-space", entries: [{ url: "https://example.com/pasta-recipe", title: "cooking pasta recipe" }] }]
  };
  const summary = {
    workspaces: [
      { id: "w-space", name: "Space", order: 0, tabCount: 1, pinnedCount: 0, essentialCount: 0, folderCount: 0, groupCount: 0, folderGroupCount: 0, protectedStatus: "none", defaultInbox: true, sortableFrom: true, sortableTo: true },
      { id: "w-misc", name: "Notes", order: 1, tabCount: 0, pinnedCount: 0, essentialCount: 0, folderCount: 0, groupCount: 0, folderGroupCount: 0, protectedStatus: "none", defaultInbox: false, sortableFrom: true, sortableTo: true }
    ]
  };
  const decisions = await scoreTabsSemantically({
    session,
    summary,
    domainRules: {},
    provider: lexicalProvider,
    weights: fieldWeights,
    options: {
      fieldWeights,
      componentWeights: { lexical: 0.45, dense: 0.4, domain: 0.15 },
      minConfidence: 0.5,
      minMargin: 0.0,
      reviewOnTie: true,
      denseAvailable: false
    },
    tabs: [{ entityId: "t0", title: "cooking pasta recipe", url: "https://example.com/pasta-recipe", domain: "example.com" }],
    sourceWorkspaceId: "w-space"
  });
  const decision = decisions.get("t0");
  assert.equal(decision.move, false);
  assert.equal(decision.reason, "below_semantic_min_confidence");
});
