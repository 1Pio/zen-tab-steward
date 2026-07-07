import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildIndex, loadIndex } from "../dist/embeddings/store.js";
import { lexicalProvider } from "../dist/embeddings/lexical-provider.js";
import { summarizeSession } from "../dist/session.js";

const source = { kind: "zen-sessions", path: "/tmp/zen-sessions.jsonlz4", exists: true, size: 1, modifiedMs: 1 };

const weights = { title: 1, url: 0.7, domain: 1.2, description: 0.6 };

function session() {
  return {
    spaces: [
      { uuid: "w-space", name: "Space" },
      { uuid: "w-dev", name: "Tool Development" },
      { uuid: "w-travel", name: "Travel" }
    ],
    tabs: [
      { zenWorkspace: "w-space", entries: [{ url: "https://github.com/1Pio/zen-tab-steward", title: "zen-tab-steward repo" }] },
      { zenWorkspace: "w-space", entries: [{ url: "https://airbnb.de/berlin", title: "Berlin stay" }] },
      { zenWorkspace: "w-dev", entries: [{ url: "https://cloudflare.com/dashboard", title: "Cloudflare" }] }
    ]
  };
}

test("buildIndex writes a versioned index with workspace and tab vectors and reloads it", async () => {
  const temp = await mkdtemp(join(tmpdir(), "zts-store-"));
  process.env.ZTS_STATE_DIR = temp;
  try {
    const ses = session();
    const summary = summarizeSession(ses, source);
    const report = await buildIndex({
      profileId: "p1",
      session: ses,
      summary,
      domainRules: { "github.com": "Tool Development" },
      provider: lexicalProvider,
      weights
    });
    assert.equal(report.total, 3);
    assert.equal(report.indexed, 3);
    assert.equal(report.reused, 0);
    assert.equal(report.workspaceCount, 3);

    const loaded = await loadIndex("p1");
    assert.equal(loaded?.provider, "lexical-v1");
    assert.equal(loaded?.tabs.length, 3);
    assert.equal(loaded?.workspaces.length, 3);
  } finally {
    delete process.env.ZTS_STATE_DIR;
  }
});

test("buildIndex reuses unchanged tab embeddings incrementally", async () => {
  const temp = await mkdtemp(join(tmpdir(), "zts-store-2-"));
  process.env.ZTS_STATE_DIR = temp;
  try {
    const ses = session();
    const summary = summarizeSession(ses, source);
    const first = await buildIndex({ profileId: "p2", session: ses, summary, domainRules: {}, provider: lexicalProvider, weights });
    const previous = await loadIndex("p2");
    const second = await buildIndex({ profileId: "p2", session: ses, summary, domainRules: {}, provider: lexicalProvider, weights, reuse: previous });
    assert.equal(first.indexed, 3);
    assert.equal(second.reused, 3);
    assert.equal(second.indexed, 0);
  } finally {
    delete process.env.ZTS_STATE_DIR;
  }
});
