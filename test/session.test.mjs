import assert from "node:assert/strict";
import test from "node:test";
import { summarizeSession } from "../dist/session.js";

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
