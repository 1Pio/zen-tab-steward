import assert from "node:assert/strict";
import test from "node:test";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const repoRoot = new URL("..", import.meta.url);
const ignoredDirs = new Set([".git", "dist", "node_modules"]);
const forbiddenArtifactPath = /(^|\/)(LaunchAgents|LaunchDaemons|NativeMessagingHosts|systemd|autostart|Extensions)(\/|$)|\.(plist|xpi|crx)$|(^|\/)manifest\.json$/i;
const forbiddenRuntimeContent = /\b(launchctl|LaunchAgent|LaunchDaemon|NativeMessagingHosts|chrome\.runtime|browser\.runtime|web-ext|systemd|plistbuddy)\b/i;

test("runtime package has no forbidden service, autostart, or extension setup", async () => {
  const files = await listFiles(repoRoot);
  const forbiddenArtifacts = files.filter((file) => forbiddenArtifactPath.test(file));

  assert.deepEqual(forbiddenArtifacts, []);

  const runtimeFiles = files.filter((file) => file === "package.json" || file.startsWith("src/"));
  const contentHits = [];
  for (const file of runtimeFiles) {
    const contents = await readFile(new URL(file, repoRoot), "utf8");
    if (forbiddenRuntimeContent.test(contents)) contentHits.push(file);
  }

  assert.deepEqual(contentHits, []);
});

async function listFiles(rootUrl, prefix = "") {
  const entries = await readdir(rootUrl, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (ignoredDirs.has(entry.name)) continue;
      files.push(...await listFiles(new URL(`${entry.name}/`, rootUrl), join(prefix, entry.name)));
      continue;
    }
    if (entry.isFile()) files.push(join(prefix, entry.name));
  }
  return files;
}
