import assert from "node:assert/strict";
import test from "node:test";
import { listTabs, summarizeSession, withWorkspacePolicy } from "../dist/session.js";

const source = {
  kind: "zen-sessions",
  path: "/tmp/profile/zen-sessions.jsonlz4",
  exists: true,
  size: 100,
  modifiedMs: 123
};

test("summarizes workspaces, pinned tabs, essentials, folders, and groups", () => {
  const summary = summarizeSession(
    {
      spaces: [
        { uuid: "w1", name: "Space" },
        { uuid: "w2", name: "Stash" }
      ],
      tabs: [
        { zenWorkspace: "w1", pinned: true, zenEssential: true },
        { zenWorkspace: "w1", pinned: false, groupId: "g1" },
        { zenWorkspace: "w2", pinned: false }
      ],
      folders: [{ id: "g1", workspaceId: "w1", pinned: true }],
      groups: [
        { id: "g1", pinned: true },
        { id: "g2", splitView: true }
      ],
      splitViewData: [{ id: "g2" }]
    },
    source
  );

  assert.equal(summary.workspaceCount, 2);
  assert.equal(summary.tabCount, 3);
  assert.equal(summary.pinnedCount, 1);
  assert.equal(summary.essentialCount, 1);
  assert.equal(summary.folderCount, 1);
  assert.equal(summary.groupCount, 2);
  assert.equal(summary.folderGroupCount, 3);
  assert.deepEqual(
    summary.workspaces.map((workspace) => ({
      name: workspace.name,
      tabs: workspace.tabCount,
      pinned: workspace.pinnedCount,
      essentials: workspace.essentialCount,
      folders: workspace.folderCount,
      groups: workspace.groupCount
    })),
    [
      { name: "Space", tabs: 2, pinned: 1, essentials: 1, folders: 1, groups: 1 },
      { name: "Stash", tabs: 1, pinned: 0, essentials: 0, folders: 0, groups: 0 }
    ]
  );
});

test("adds workspace policy status from config", () => {
  const summary = summarizeSession(
    {
      spaces: [
        { uuid: "w1", name: "Space" },
        { uuid: "w2", name: "Stash" },
        { uuid: "w3", name: "Portfolio" }
      ],
      tabs: [],
      folders: [],
      groups: []
    },
    source
  );

  const policySummary = withWorkspacePolicy(summary, {
    defaults: {
      inbox: "Space",
      minConfidence: 0.8,
      includePinned: false,
      includeEssentials: false,
      applyBackend: "auto"
    },
    sort: {
      from: ["Space"],
      to: ["Portfolio"],
      notTo: ["Stash"],
      only: [],
      except: []
    },
    semantic: {
      enabled: false,
      engine: "bge_small",
      suggestionThreshold: 0.72,
      autoApply: false,
      autoApplyThreshold: 0.92,
      minimumMargin: 0.18,
      maxMoves: 5
    },
    protect: {
      workspaces: {
        from: ["Stash"],
        to: ["Stash"]
      },
      domains: {
        neverMove: []
      }
    },
    rules: { domains: {} }
  });

  assert.deepEqual(
    policySummary.workspaces.map((workspace) => ({
      name: workspace.name,
      protected: workspace.protectedStatus,
      inbox: workspace.defaultInbox,
      from: workspace.sortableFrom,
      to: workspace.sortableTo
    })),
    [
      { name: "Space", protected: "none", inbox: true, from: true, to: false },
      { name: "Stash", protected: "from_to", inbox: false, from: false, to: false },
      { name: "Portfolio", protected: "none", inbox: false, from: false, to: true }
    ]
  );
});

test("lists tabs with workspace and protection metadata", () => {
  const session = {
    spaces: [
      { uuid: "w1", name: "Space" },
      { uuid: "w2", name: "Portfolio" }
    ],
    tabs: [
      {
        zenWorkspace: "w1",
        pinned: true,
        zenEssential: true,
        index: 1,
        entries: [{ url: "https://example.com", title: "Example" }]
      },
      {
        zenWorkspace: "w2",
        groupId: "g1",
        zenLiveFolderItemId: "f1",
        entries: [{ url: "https://framer.com/project", title: "Framer" }]
      }
    ],
    folders: [],
    groups: []
  };
  const summary = summarizeSession(session, source);

  const tabs = listTabs(session, summary, "Portfolio");

  assert.equal(tabs.length, 1);
  assert.equal(tabs[0].workspaceName, "Portfolio");
  assert.equal(tabs[0].domain, "framer.com");
  assert.equal(tabs[0].grouped, true);
  assert.equal(tabs[0].foldered, true);
  assert.deepEqual(tabs[0].protectionReasons, ["grouped", "foldered"]);
});
