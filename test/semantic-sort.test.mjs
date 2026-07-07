import assert from "node:assert/strict";
import test from "node:test";
import { planSortPreview } from "../dist/sort.js";
import { summarizeSession } from "../dist/session.js";
import { lexicalProvider } from "../dist/embeddings/lexical-provider.js";
import { scoreTabsSemantically } from "../dist/embeddings/index.js";
import { buildTabEmbeddingInputs } from "../dist/embeddings/profile.js";

const source = { kind: "zen-sessions", path: "/tmp/zen-sessions.jsonlz4", exists: true, size: 1, modifiedMs: 1 };

function baseInputs() {
  return {
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
    domainRules: {},
    protectedDomains: [],
    semantic: null
  };
}

test("semantic fallback moves a strong-affinity tab when no deterministic rule matches", async () => {
  const session = {
    spaces: [
      { uuid: "w-space", name: "Space" },
      { uuid: "w-portfolio", name: "Portfolio" },
      { uuid: "w-dev", name: "Tool Development" }
    ],
    tabs: [
      // source tabs (Space) — none match a domain rule (rules empty)
      { zenWorkspace: "w-space", entries: [{ url: "https://r-pio.framer.website/home", title: "My Framer Site" }] },
      { zenWorkspace: "w-space", entries: [{ url: "https://example.com/pasta", title: "cooking pasta recipe" }] },
      // portfolio workspace has existing framer tabs that define its profile
      { zenWorkspace: "w-portfolio", entries: [{ url: "https://framer.com/projects", title: "Framer projects" }] },
      { zenWorkspace: "w-portfolio", entries: [{ url: "https://framer.university/course", title: "Framer course" }] }
    ]
  };
  const summary = summarizeSession(session, source);
  const tabInputs = buildTabEmbeddingInputs(session, (tab) => tab.zenWorkspace === "w-space");
  const decisions = await scoreTabsSemantically({
    session,
    summary,
    domainRules: {},
    provider: lexicalProvider,
    weights: { title: 1, url: 0.7, domain: 1.2, description: 0.6 },
    options: {
      fieldWeights: { title: 1, url: 0.7, domain: 1.2, description: 0.6 },
      componentWeights: { lexical: 0.45, dense: 0.4, domain: 0.15 },
      minConfidence: 0.5,
      minMargin: 0.1,
      reviewOnTie: true,
      denseAvailable: false
    },
    tabs: tabInputs,
    sourceWorkspaceId: "w-space"
  });

  const inputs = { ...baseInputs(), semantic: { enabled: true, decisions } };
  const plan = planSortPreview(session, summary, summary.workspaces[0], inputs);

  assert.equal(plan.moveCount, 1, `expected 1 semantic move, got ${plan.moveCount} (planned: ${plan.plannedActions.map((a) => a.entityId).join(",")})`);
  assert.equal(plan.plannedActions[0].reason, "semantic_affinity");
  assert.equal(plan.plannedActions[0].destinationWorkspaceName, "Portfolio");
  assert.ok(plan.reviewActions.some((a) => a.entityId.includes("pasta") || a.url.includes("pasta")), "expected pasta tab in review");
});

test("deterministic rules still outrank semantic matching", async () => {
  const session = {
    spaces: [
      { uuid: "w-space", name: "Space" },
      { uuid: "w-dev", name: "Tool Development" }
    ],
    tabs: [
      { zenWorkspace: "w-space", entries: [{ url: "https://github.com/1Pio/zen-tab-steward", title: "zen-tab-steward repo" }] }
    ]
  };
  const summary = summarizeSession(session, source);
  const tabInputs = buildTabEmbeddingInputs(session, (tab) => tab.zenWorkspace === "w-space");
  const decisions = await scoreTabsSemantically({
    session,
    summary,
    domainRules: { "github.com": "Tool Development" },
    provider: lexicalProvider,
    weights: { title: 1, url: 0.7, domain: 1.2, description: 0.6 },
    options: {
      fieldWeights: { title: 1, url: 0.7, domain: 1.2, description: 0.6 },
      componentWeights: { lexical: 0.45, dense: 0.4, domain: 0.15 },
      minConfidence: 0.0,
      minMargin: 0.0,
      reviewOnTie: true,
      denseAvailable: false
    },
    tabs: tabInputs,
    sourceWorkspaceId: "w-space"
  });
  const inputs = { ...baseInputs(), domainRules: { "github.com": "Tool Development" }, semantic: { enabled: true, decisions } };
  const plan = planSortPreview(session, summary, summary.workspaces[0], inputs);
  assert.equal(plan.moveCount, 1);
  assert.equal(plan.plannedActions[0].reason, "domain_rule");
  assert.equal(plan.plannedActions[0].confidence, 0.9);
});
