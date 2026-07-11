import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

const root = new URL("../src/", import.meta.url);

test("closed-Profile mutation has one production writer boundary", async () => {
  const files = (await readdir(root))
    .filter((name) => name.endsWith(".ts"))
    .sort();
  const sources = new Map();
  for (const name of files) {
    sources.set(name, await readFile(new URL(name, root), "utf8"));
  }

  const profileWriterUsers = [...sources]
    .filter(([, source]) => /\bwriteJsonLz4(?:Durable)?\s*\(/u.test(source))
    .map(([name]) => name);
  assert.deepEqual(profileWriterUsers, ["apply-transaction.ts", "mozlz4.ts"]);

  const forbiddenLegacyWriters = [
    "applySortPlanOffline",
    "applyManualPatchOffline",
    "applySortPlanLive",
    "runBridgeLiveMoveProof",
    "live-move-proof",
    "--session-apply.json",
    "--domain-apply.json"
  ];
  for (const token of forbiddenLegacyWriters) {
    const users = [...sources]
      .filter(([, source]) => source.includes(token))
      .map(([name]) => join("src", name));
    assert.deepEqual(users, [], `${token} must not bypass the canonical Apply Transaction`);
  }

  assert.doesNotMatch(sources.get("backup.ts"), /\brename\s*\(/u);
  assert.equal(sources.has("apply.ts"), false);
  assert.equal(sources.has("sort.ts"), false);
  assert.doesNotMatch(sources.get("manual.ts"), /from ["']\.\/mozlz4\.js["']/u);
  assert.doesNotMatch(sources.get("cli.ts"), /from ["']\.\/mozlz4\.js["']/u);
});
