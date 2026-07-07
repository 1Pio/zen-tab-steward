import assert from "node:assert/strict";
import test from "node:test";
import {
  buildLexicalCorpus,
  buildTabLexicalVector,
  buildWorkspaceLexicalVector,
  cosineSparse,
  tokenize,
  parseUrlParts,
  lexicalHash
} from "../dist/embeddings/lexical.js";
import { DEFAULT_FIELD_WEIGHTS } from "../dist/embeddings/provider.js";

const weights = DEFAULT_FIELD_WEIGHTS;

test("tokenizer lowercases, drops stopwords, keeps alphanumerics", () => {
  assert.deepEqual(tokenize("The Quick-Brown Fridge!"), ["quick", "brown", "fridge"]);
  assert.deepEqual(tokenize("a page of the new www"), []);
});

test("parseUrlParts splits host and path into discriminative tokens", () => {
  const parts = parseUrlParts("https://www.github.com/1Pio/zen-tab-steward/issues/42");
  assert.deepEqual(parts.siteTokens, ["github", "com"]);
  assert.ok(parts.pathTokens.includes("1pio") || parts.pathTokens.includes("zen"));
});

test("lexical hash is stable for identical content and differs for changed titles", () => {
  const a = { entityId: "t1", title: "Fridge", url: "https://x.com", domain: "x.com" };
  const b = { entityId: "t1", title: "Fridge", url: "https://x.com", domain: "x.com" };
  const c = { entityId: "t1", title: "Car", url: "https://x.com", domain: "x.com" };
  assert.equal(lexicalHash(a), lexicalHash(b));
  assert.notEqual(lexicalHash(a), lexicalHash(c));
});

test("github tab is most similar to the development workspace profile", () => {
  const workspaces = [
    {
      workspaceId: "w-dev",
      workspaceName: "Tool Development",
      aliases: ["dev", "coding"],
      ruleDomains: ["github.com", "localhost"],
      sampleTabs: []
    },
    {
      workspaceId: "w-travel",
      workspaceName: "Travel",
      aliases: ["trip"],
      ruleDomains: ["airbnb.de"],
      sampleTabs: []
    }
  ];
  const corpus = buildLexicalCorpus(workspaces);
  const tab = buildTabLexicalVector(
    { entityId: "t1", title: "zen-tab-steward repo", url: "https://github.com/1Pio/zen-tab-steward", domain: "github.com" },
    weights,
    corpus
  );
  const dev = buildWorkspaceLexicalVector(workspaces[0], weights, corpus);
  const travel = buildWorkspaceLexicalVector(workspaces[1], weights, corpus);
  const devScore = cosineSparse(tab, dev);
  const travelScore = cosineSparse(tab, travel);
  assert.ok(devScore > travelScore, `dev ${devScore} should beat travel ${travelScore}`);
  assert.ok(devScore > 0.1, `dev score should be meaningful, got ${devScore}`);
});

test("char n-grams connect a tab title to a workspace name with no shared word tokens", () => {
  const workspaces = [
    { workspaceId: "w-hermes", workspaceName: "Hermes Agent", aliases: [], ruleDomains: [], sampleTabs: [] }
  ];
  const corpus = buildLexicalCorpus(workspaces);
  const tab = buildTabLexicalVector(
    { entityId: "t", title: "HermesAgent dashboard", url: "https://nousresearch.com/hermes", domain: "nousresearch.com" },
    weights,
    corpus
  );
  const ws = buildWorkspaceLexicalVector(workspaces[0], weights, corpus);
  assert.ok(cosineSparse(tab, ws) > 0, "should share hermes-derived signal");
});

test("workspace profiles absorb sample-tab tokens so affinity improves with corrected tabs", () => {
  const devSample = { entityId: "s1", title: "Cloudflare Pages deploy", url: "https://dash.cloudflare.com/pages", domain: "dash.cloudflare.com" };
  const withSample = [{ workspaceId: "w", workspaceName: "Dev", aliases: [], ruleDomains: [], sampleTabs: [devSample] }];
  const withoutSample = [{ workspaceId: "w", workspaceName: "Dev", aliases: [], ruleDomains: [], sampleTabs: [] }];
  const tabInput = { entityId: "t", title: "Workers script", url: "https://cloudflare.com/workers", domain: "cloudflare.com" };

  const corpusA = buildLexicalCorpus(withSample);
  const corpusB = buildLexicalCorpus(withoutSample);
  const tabA = buildTabLexicalVector(tabInput, weights, corpusA);
  const wsA = buildWorkspaceLexicalVector(withSample[0], weights, corpusA);
  const tabB = buildTabLexicalVector(tabInput, weights, corpusB);
  const wsB = buildWorkspaceLexicalVector(withoutSample[0], weights, corpusB);
  assert.ok(cosineSparse(tabA, wsA) > cosineSparse(tabB, wsB));
});
