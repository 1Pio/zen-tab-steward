import assert from "node:assert/strict";
import { mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import {
  readBoundedFileState,
  reconcileInterruptedAtomicReplace
} from "../dist/atomic-file-cas.js";
import { atomicSwapFilesDarwin } from "../dist/atomic-fs.js";

const roots = new Set();

after(async () => {
  await Promise.all([...roots].map((root) => rm(root, { recursive: true, force: true })));
});

test("crash reconciliation recognizes a valid atomic swap without changing either inode", {
  skip: process.platform !== "darwin"
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "zts-atomic-crash-valid-"));
  roots.add(root);
  const targetPath = join(root, "config.toml");
  const preparedPath = join(root, ".zts-prepared.tmp");
  await writeFile(targetPath, "source", { mode: 0o600 });
  await writeFile(preparedPath, "planned", { mode: 0o600 });
  const source = await readBoundedFileState(targetPath, 1024);
  const planned = await readBoundedFileState(preparedPath, 1024);
  await atomicSwapFilesDarwin(preparedPath, targetPath);

  const result = await reconcileInterruptedAtomicReplace({
    targetPath,
    preparedPath,
    expectedTarget: source.fingerprint,
    expectedPreparedDigest: planned.fingerprint.digest,
    maxBytes: 1024
  });

  assert.equal(result.classification, "accepted_commit");
  assert.equal(result.mutationPerformed, false);
  assert.equal(result.target.fingerprint.digest, planned.fingerprint.digest);
  assert.equal(result.prepared.fingerprint.digest, source.fingerprint.digest);
  assert.equal(result.target.fingerprint.inode, planned.fingerprint.inode);
  assert.equal(result.prepared.fingerprint.inode, source.fingerprint.inode);
});

test("crash reconciliation restores the exact writer displaced by a raced swap", {
  skip: process.platform !== "darwin"
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "zts-atomic-crash-drift-"));
  roots.add(root);
  const targetPath = join(root, "config.toml");
  const preparedPath = join(root, ".zts-prepared.tmp");
  const writerPath = join(root, "external.tmp");
  await writeFile(targetPath, "source", { mode: 0o600 });
  await writeFile(preparedPath, "planned", { mode: 0o600 });
  const source = await readBoundedFileState(targetPath, 1024);
  const planned = await readBoundedFileState(preparedPath, 1024);
  await writeFile(writerPath, "external", { mode: 0o600 });
  const writer = await readBoundedFileState(writerPath, 1024);
  await rename(writerPath, targetPath);
  await atomicSwapFilesDarwin(preparedPath, targetPath);

  const result = await reconcileInterruptedAtomicReplace({
    targetPath,
    preparedPath,
    expectedTarget: source.fingerprint,
    expectedPreparedDigest: planned.fingerprint.digest,
    maxBytes: 1024
  });

  assert.equal(result.classification, "drift_restored");
  assert.equal(result.mutationPerformed, true);
  assert.equal(result.target.fingerprint.digest, writer.fingerprint.digest);
  assert.equal(result.target.fingerprint.inode, writer.fingerprint.inode);
  assert.equal(result.prepared.fingerprint.digest, planned.fingerprint.digest);
  assert.equal(result.prepared.fingerprint.inode, planned.fingerprint.inode);
});

test("crash reconciliation classifies a prepared image before swap as not committed", async () => {
  const root = await mkdtemp(join(tmpdir(), "zts-atomic-crash-before-"));
  roots.add(root);
  const targetPath = join(root, "config.toml");
  const preparedPath = join(root, ".zts-prepared.tmp");
  await writeFile(targetPath, "source", { mode: 0o600 });
  await writeFile(preparedPath, "planned", { mode: 0o600 });
  const source = await readBoundedFileState(targetPath, 1024);
  const planned = await readBoundedFileState(preparedPath, 1024);

  const result = await reconcileInterruptedAtomicReplace({
    targetPath,
    preparedPath,
    expectedTarget: source.fingerprint,
    expectedPreparedDigest: planned.fingerprint.digest,
    maxBytes: 1024
  });

  assert.equal(result.classification, "not_committed");
  assert.equal(result.reason, "expected_source_present");
  assert.equal(result.mutationPerformed, false);
  assert.equal(result.target.fingerprint.inode, source.fingerprint.inode);
  assert.equal(result.prepared.fingerprint.inode, planned.fingerprint.inode);
});

test("crash reconciliation preserves both external writers when rollback is raced", {
  skip: process.platform !== "darwin"
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "zts-atomic-crash-second-writer-"));
  roots.add(root);
  const targetPath = join(root, "config.toml");
  const preparedPath = join(root, ".zts-prepared.tmp");
  const firstPath = join(root, "first.tmp");
  const secondPath = join(root, "second.tmp");
  await writeFile(targetPath, "source", { mode: 0o600 });
  await writeFile(preparedPath, "planned", { mode: 0o600 });
  const source = await readBoundedFileState(targetPath, 1024);
  const planned = await readBoundedFileState(preparedPath, 1024);
  await writeFile(firstPath, "first-writer", { mode: 0o600 });
  await rename(firstPath, targetPath);
  await atomicSwapFilesDarwin(preparedPath, targetPath);

  const result = await reconcileInterruptedAtomicReplace({
    targetPath,
    preparedPath,
    expectedTarget: source.fingerprint,
    expectedPreparedDigest: planned.fingerprint.digest,
    maxBytes: 1024,
    afterClassification: async () => {
      await writeFile(secondPath, "second-writer", { mode: 0o600 });
      await rename(secondPath, targetPath);
    }
  });

  assert.equal(result.classification, "uncertain");
  assert.equal(result.mutationPerformed, false);
  assert.equal(result.target.bytes.toString("utf8"), "second-writer");
  assert.equal(result.prepared.bytes.toString("utf8"), "first-writer");
  assert.deepEqual(new Set(result.residuePaths), new Set([targetPath, preparedPath]));
});
