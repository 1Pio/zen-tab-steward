import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  link,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { spawnSync } from "node:child_process";
import test, { after } from "node:test";
import { readApplyArtifactLayout, safeArtifactSegment } from "../dist/apply-artifacts.js";
import {
  applyApplyStoreRetention,
  APPLY_RETENTION_DESTRUCTIVE_CONSENT,
  DEFAULT_APPLY_RETENTION_POLICY,
  inspectApplyStoreRetention
} from "../dist/apply-retention.js";
import {
  readApplyReceiptHistoryHead,
  reduceApplyReceiptUndoLineage,
  withApplyReceiptHistoryMigration
} from "../dist/apply-receipt-store.js";
import {
  APPLY_RETENTION_MAX_INVENTORY_ENTRIES,
  APPLY_RETENTION_FIXED_PEAK_ENTRIES,
  APPLY_RETENTION_FUTURE_HEADROOM_BYTES,
  APPLY_STORE_MAX_BYTES,
  APPLY_STORE_MAX_ENTRIES,
  APPLY_TRANSACTION_RESERVATION_BYTES,
  APPLY_TRANSACTION_RESERVATION_ENTRIES,
  DEFAULT_APPLY_RECOVERY_RESERVATION_POLICY,
  assertApplyStoreFreshBootstrap,
  assertApplyStoreAdmission,
  ensureApplyStoreRecoveryReservation,
  readApplyStoreAccounting,
  reconcileApplyStoreAdmissionTemporaries,
  reconcileApplyStoreFreshBootstrapTemporaries,
  reserveApplyStoreForTransaction,
  settleApplyStoreReservation
} from "../dist/apply-store-accounting.js";
import { listTransactionReceiptPage } from "../dist/apply-transaction.js";
import { sha256Canonical } from "../dist/domain/digest.js";
import { encodeLiteralJsonLz4ForFixture } from "../dist/mozlz4.js";
import { privatePath, removePrivateFile, replacePrivateJson } from "../dist/private-store.js";

const roots = new Set();
const savedEnvironment = new Map();
for (const key of ["HOME", "PATH", "ZTS_ZEN_APP_SUPPORT_DIR", "ZTS_STATE_DIR", "ZTS_CONFIG_PATH"]) {
  savedEnvironment.set(key, process.env[key]);
}

after(async () => {
  for (const [key, value] of savedEnvironment) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await Promise.all([...roots].map((root) => rm(root, { recursive: true, force: true })));
});

test("real canonical Apply retention preview is write-free, time-stable, and archives truthfully", async () => {
  const fixture = await makeAppliedFixture(1);
  const now = new Date(Date.now() + 45 * DAY_MS);
  const policy = testPolicy();
  const before = await snapshotTree(fixture.layout.root);
  const inspection = await inspectApplyStoreRetention(fixture.profileId, { now, policy });
  const laterInspection = await inspectApplyStoreRetention(fixture.profileId, {
    now: new Date(now.getTime() + 60_000),
    policy
  });

  assert.equal(inspection.archiveReceiptCount, 1);
  assert.equal(inspection.fullReceiptCountBefore, 1);
  assert.equal(inspection.fullReceiptCountAfter, 0);
  assert.equal(inspection.inspectionRevision, laterInspection.inspectionRevision);
  assert.equal(inspection.targetPlanRevision, laterInspection.targetPlanRevision);
  assert.deepEqual(await snapshotTree(fixture.layout.root), before);

  await assert.rejects(
    applyApplyStoreRetention(fixture.profileId, {
      now,
      policy,
      expectedInspectionRevision: inspection.inspectionRevision,
      destructiveConsent: "wrong"
    }),
    /explicit typed deletion consent/
  );
  const result = await applyApplyStoreRetention(fixture.profileId, {
    now: new Date(now.getTime() + 60_000),
    policy,
    expectedInspectionRevision: inspection.inspectionRevision,
    destructiveConsent: APPLY_RETENTION_DESTRUCTIVE_CONSENT
  });
  assert.equal(result.outcome, "applied");
  assert.equal(result.archivedReceiptCount, 1);
  assert.ok(result.removedFiles > 0);

  const page = await listTransactionReceiptPage(fixture.profileId, { limit: 10 });
  assert.equal(page.receipts.length, 1);
  assert.equal(page.receipts[0].fullReceiptAvailability, "archived_summary_only");
  assert.equal(page.receipts[0].receiptPath, null);
  assert.deepEqual(await readdir(fixture.layout.receipts), []);
  assert.deepEqual(await readdir(fixture.layout.transactions), []);
});

test("retention validates and archives an applied inverse above the old 16 MiB ceiling", async () => {
  const fixture = await makeAppliedFixture(1, { largeTitleBytes: 9 * MEBIBYTE });
  const page = await listTransactionReceiptPage(fixture.profileId, { limit: 1 });
  assert.equal(page.receipts.length, 1);
  const receiptPath = page.receipts[0].receiptPath;
  assert.ok(receiptPath);
  const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
  assert.ok(receipt.inversePlanArtifact);
  const inverseFiles = await readdir(fixture.layout.inverses);
  assert.equal(inverseFiles.length, 1);
  assert.ok((await stat(privatePath(fixture.layout.inverses, inverseFiles[0]))).size > 16 * MEBIBYTE);

  const now = new Date(Date.now() + 45 * DAY_MS);
  const policy = testPolicy();
  const inspection = await inspectApplyStoreRetention(fixture.profileId, { now, policy });
  assert.deepEqual(inspection.blockers, []);
  assert.equal(inspection.archiveReceiptCount, 1);

  const result = await applyApplyStoreRetention(fixture.profileId, {
    now,
    policy,
    expectedInspectionRevision: inspection.inspectionRevision,
    destructiveConsent: APPLY_RETENTION_DESTRUCTIVE_CONSENT
  });
  assert.equal(result.outcome, "applied");
  assert.equal(result.archivedReceiptCount, 1);
  assert.deepEqual(await readdir(fixture.layout.inverses), []);
  const retained = await listTransactionReceiptPage(fixture.profileId, { limit: 1 });
  assert.equal(retained.receipts[0].fullReceiptAvailability, "archived_summary_only");
});

test("retention skips browser-data graph walking for a maximum 10k-tab inverse Snapshot", async () => {
  const fixture = await makeAppliedFixture(1, { extraUnmatchedTabs: 9_999 });
  const now = new Date(Date.now() + 45 * DAY_MS);
  const policy = testPolicy();

  const inspection = await inspectApplyStoreRetention(fixture.profileId, { now, policy });
  assert.deepEqual(inspection.blockers, []);
  assert.equal(inspection.archiveReceiptCount, 1);
  const result = await applyApplyStoreRetention(fixture.profileId, {
    now,
    policy,
    expectedInspectionRevision: inspection.inspectionRevision,
    destructiveConsent: APPLY_RETENTION_DESTRUCTIVE_CONSENT
  });
  assert.equal(result.outcome, "applied");
  assert.equal(result.archivedReceiptCount, 1);
  const retained = await listTransactionReceiptPage(fixture.profileId, { limit: 1 });
  assert.equal(retained.receipts[0].fullReceiptAvailability, "archived_summary_only");
});

test("summary count retention preserves a successful Undo and forward source as one causal unit", async () => {
  const fixture = await makeAppliedFixture(1);
  const forward = (await listTransactionReceiptPage(fixture.profileId, { limit: 10 })).receipts[0];
  const undoPreview = spawnSync(
    "node",
    ["dist/cli.js", "undo", forward.id, "--preview", "--json"],
    { cwd: process.cwd(), env: fixture.env, encoding: "utf8" }
  );
  assert.equal(undoPreview.status, 0, `${undoPreview.stdout}\n${undoPreview.stderr}`);
  const undoPlan = JSON.parse(undoPreview.stdout).data.inspection.undoPlan;
  const undo = spawnSync(
    "node",
    ["dist/cli.js", "undo", forward.id, "--yes", "--expect-digest", undoPlan.digest, "--json"],
    { cwd: process.cwd(), env: fixture.env, encoding: "utf8" }
  );
  assert.equal(undo.status, 0, `${undo.stdout}\n${undo.stderr}`);
  const undoReceipt = JSON.parse(undo.stdout).data.receipt;

  const nextPreview = spawnSync(
    "node",
    ["dist/cli.js", "sort", "--all", "--engine", "rules", "--preview", "--json"],
    { cwd: process.cwd(), env: fixture.env, encoding: "utf8" }
  );
  assert.equal(nextPreview.status, 0, `${nextPreview.stdout}\n${nextPreview.stderr}`);
  const nextPlan = JSON.parse(nextPreview.stdout).data.plan;
  const nextApply = spawnSync(
    "node",
    ["dist/cli.js", "apply", nextPlan.id, "--yes", "--expect-digest", nextPlan.digest, "--json"],
    { cwd: process.cwd(), env: fixture.env, encoding: "utf8" }
  );
  assert.equal(nextApply.status, 0, `${nextApply.stdout}\n${nextApply.stderr}`);
  const latestReceipt = JSON.parse(nextApply.stdout).data.receipt;

  const before = await listTransactionReceiptPage(fixture.profileId, { limit: 10 });
  assert.deepEqual(before.receipts.map((summary) => summary.id), [
    latestReceipt.id,
    undoReceipt.id,
    forward.id
  ]);
  assert.equal(before.receipts[1].causalSourceReceiptId, forward.id);

  const now = new Date(Date.now() + 45 * DAY_MS);
  await assert.rejects(
    inspectApplyStoreRetention(fixture.profileId, {
      now,
      policy: testPolicy({ undoWindowDays: 29, maxSummaryEntries: 2 })
    }),
    /fixed 30-day Undo window/
  );
  const policy = testPolicy({ maxSummaryEntries: 2 });
  const inspection = await inspectApplyStoreRetention(fixture.profileId, { now, policy });
  assert.deepEqual(inspection.blockers, []);
  assert.equal(inspection.summaryCountBefore, 3);
  assert.equal(inspection.summaryCountAfter, 1);
  assert.equal(inspection.archiveReceiptCount, 1);
  assert.equal(inspection.evictSummaryCount, 2);

  const result = await applyApplyStoreRetention(fixture.profileId, {
    now,
    policy,
    expectedInspectionRevision: inspection.inspectionRevision,
    destructiveConsent: APPLY_RETENTION_DESTRUCTIVE_CONSENT
  });
  assert.equal(result.outcome, "applied");
  assert.equal(result.summaryCount, 1);
  assert.equal(result.archivedReceiptCount, 1);
  assert.equal(result.evictedSummaryCount, 2);
  const after = await listTransactionReceiptPage(fixture.profileId, { limit: 10 });
  assert.deepEqual(after.receipts.map((summary) => summary.id), [latestReceipt.id]);
  const lineage = await reduceApplyReceiptUndoLineage(fixture.layout, fixture.profileId);
  assert.equal(lineage.activeForward?.id, latestReceipt.id);
});

test("crash before the ready-head swap discards only the prepared generation", async () => {
  const fixture = await makeAppliedFixture(1);
  const now = new Date(Date.now() + 45 * DAY_MS);
  const policy = testPolicy();
  const sourceHead = await readApplyReceiptHistoryHead(fixture.layout, fixture.profileId);
  const preview = await inspectApplyStoreRetention(fixture.profileId, { now, policy });
  await assert.rejects(
    applyApplyStoreRetention(fixture.profileId, {
      now,
      policy,
      expectedInspectionRevision: preview.inspectionRevision,
      destructiveConsent: APPLY_RETENTION_DESTRUCTIVE_CONSENT,
      hooks: { afterManifest: () => { throw new Error("fixture crash after manifest"); } }
    }),
    /fixture crash/
  );

  const interrupted = await inspectApplyStoreRetention(fixture.profileId, { now, policy });
  assert.equal(interrupted.action, "discard_prepared_generation");
  const discarded = await applyApplyStoreRetention(fixture.profileId, {
    now,
    policy,
    expectedInspectionRevision: interrupted.inspectionRevision,
    destructiveConsent: APPLY_RETENTION_DESTRUCTIVE_CONSENT
  });
  assert.equal(discarded.outcome, "discarded");
  assert.equal((await readApplyReceiptHistoryHead(fixture.layout, fixture.profileId)).revision, sourceHead.revision);
  assert.equal((await listTransactionReceiptPage(fixture.profileId, { limit: 10 })).receipts[0].fullReceiptAvailability, "available");
});

test("crash after the one head swap resumes the exact immutable deletion manifest", async () => {
  const fixture = await makeAppliedFixture(1);
  const now = new Date(Date.now() + 45 * DAY_MS);
  const policy = testPolicy();
  const preview = await inspectApplyStoreRetention(fixture.profileId, { now, policy });
  await assert.rejects(
    applyApplyStoreRetention(fixture.profileId, {
      now,
      policy,
      expectedInspectionRevision: preview.inspectionRevision,
      destructiveConsent: APPLY_RETENTION_DESTRUCTIVE_CONSENT,
      hooks: { afterHeadSwap: () => { throw new Error("fixture crash after head"); } }
    }),
    /fixture crash/
  );

  const interrupted = await inspectApplyStoreRetention(fixture.profileId, { now, policy });
  assert.equal(interrupted.action, "resume_deletions");
  const resumed = await applyApplyStoreRetention(fixture.profileId, {
    now,
    policy,
    expectedInspectionRevision: interrupted.inspectionRevision,
    destructiveConsent: APPLY_RETENTION_DESTRUCTIVE_CONSENT
  });
  assert.equal(resumed.outcome, "applied");
  assert.equal((await listTransactionReceiptPage(fixture.profileId, { limit: 10 })).receipts[0].fullReceiptAvailability, "archived_summary_only");
  assert.equal((await readApplyStoreAccounting(fixture.layout, fixture.profileId)).maintenanceId, null);
});

test("a mid-subtree crash resumes from an exact safe subset and keeps fixed totals", async () => {
  const fixture = await makeAppliedFixture(1);
  const now = new Date(Date.now() + 45 * DAY_MS);
  const policy = testPolicy();
  const preview = await inspectApplyStoreRetention(fixture.profileId, { now, policy });
  await assert.rejects(
    applyApplyStoreRetention(fixture.profileId, {
      now,
      policy,
      expectedInspectionRevision: preview.inspectionRevision,
      destructiveConsent: APPLY_RETENTION_DESTRUCTIVE_CONSENT,
      hooks: { afterHeadSwap: () => { throw new Error("fixture crash before subtree deletion"); } }
    }),
    /fixture crash/
  );
  const manifest = JSON.parse(await readFile(
    privatePath(fixture.layout.root, "retention-manifest.json"),
    "utf8"
  ));
  const directoryTarget = manifest.deletionTargets.find(
    (target) => target.identity.kind === "transaction_directory"
  );
  assert.ok(directoryTarget);
  const firstFile = directoryTarget.identity.treeEntries.find((entry) => entry.kind === "file");
  assert.ok(firstFile);
  await removePrivateFile(privatePath(
    fixture.layout.root,
    ...directoryTarget.relativePath.split("/"),
    ...firstFile.path.split("/")
  ));

  const interrupted = await inspectApplyStoreRetention(fixture.profileId, { now, policy });
  const resumed = await applyApplyStoreRetention(fixture.profileId, {
    now,
    policy,
    expectedInspectionRevision: interrupted.inspectionRevision,
    destructiveConsent: APPLY_RETENTION_DESTRUCTIVE_CONSENT
  });
  assert.equal(resumed.removedBytes, manifest.deletionTotals.bytes);
  assert.equal(resumed.removedFiles, manifest.deletionTotals.files);
  assert.equal(resumed.removedTransactionDirectories, manifest.deletionTotals.transactionDirectories);
  assert.deepEqual(await readdir(fixture.layout.transactions), []);
});

test("a recomputed corrupt manifest cannot name target-generation reachable state", async () => {
  const fixture = await makeAppliedFixture(2);
  const summaries = (await listTransactionReceiptPage(fixture.profileId, { limit: 10 })).receipts;
  assert.equal(summaries.length, 2);
  const firstCompleted = Date.parse(summaries[1].completedAt);
  const secondCompleted = Date.parse(summaries[0].completedAt);
  assert.ok(secondCompleted > firstCompleted);
  const now = new Date(Math.floor((firstCompleted + secondCompleted) / 2) + 30 * DAY_MS);
  const policy = testPolicy();
  const preview = await inspectApplyStoreRetention(fixture.profileId, { now, policy });
  assert.equal(preview.archiveReceiptCount, 1);
  await assert.rejects(
    applyApplyStoreRetention(fixture.profileId, {
      now,
      policy,
      expectedInspectionRevision: preview.inspectionRevision,
      destructiveConsent: APPLY_RETENTION_DESTRUCTIVE_CONSENT,
      hooks: { afterHeadSwap: () => { throw new Error("fixture crash for manifest tamper"); } }
    }),
    /fixture crash/
  );

  const recent = summaries[0];
  const receiptPath = recent.receiptPath;
  assert.ok(receiptPath);
  const metadata = await lstat(receiptPath);
  const manifestPath = privatePath(fixture.layout.root, "retention-manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const malicious = {
    relativePath: relative(fixture.layout.root, receiptPath),
    bytes: metadata.size,
    files: 1,
    identity: {
      kind: "file",
      device: metadata.dev,
      inode: metadata.ino,
      size: metadata.size,
      mode: metadata.mode & 0o777,
      modifiedMs: metadata.mtimeMs,
      changedMs: metadata.ctimeMs
    }
  };
  const content = {
    ...manifest,
    deletionTargets: [...manifest.deletionTargets, malicious],
    deletionTotals: {
      ...manifest.deletionTotals,
      bytes: manifest.deletionTotals.bytes + malicious.bytes,
      files: manifest.deletionTotals.files + 1
    }
  };
  delete content.revision;
  await replacePrivateJson(manifestPath, { ...content, revision: sha256Canonical(content) });
  await assert.rejects(
    inspectApplyStoreRetention(fixture.profileId, { now, policy }),
    /target-generation reachable state/
  );
  assert.equal((await stat(receiptPath)).isFile(), true);
});

test("write-free inspection reports and exact maintenance repairs one publication residue", async () => {
  const fixture = await makeAppliedFixture(1);
  const receiptFile = (await readdir(fixture.layout.receipts))[0];
  const canonical = privatePath(fixture.layout.receipts, receiptFile);
  const temporary = privatePath(fixture.layout.receipts, `.tmp-${randomUUID()}.artifact`);
  await link(canonical, temporary);
  const beforeHead = await readApplyReceiptHistoryHead(fixture.layout, fixture.profileId);
  const now = new Date(Date.now() + 1 * DAY_MS);
  const policy = testPolicy();
  const inspection = await inspectApplyStoreRetention(fixture.profileId, { now, policy });
  assert.equal(inspection.action, "reconcile_publication_residue");
  assert.equal(inspection.publicationResidueCount, 1);
  assert.equal((await lstat(canonical)).nlink, 2);
  assert.equal((await lstat(temporary)).nlink, 2);

  const repaired = await applyApplyStoreRetention(fixture.profileId, {
    now,
    policy,
    expectedInspectionRevision: inspection.inspectionRevision,
    destructiveConsent: APPLY_RETENTION_DESTRUCTIVE_CONSENT
  });
  assert.equal(repaired.outcome, "discarded");
  await assert.rejects(lstat(temporary), /ENOENT/);
  assert.equal((await lstat(canonical)).nlink, 1);
  assert.equal((await readApplyReceiptHistoryHead(fixture.layout, fixture.profileId)).revision, beforeHead.revision);
});

test("retention binds and repairs accounting, history-head, and transaction-artifact standalone crash temps", async () => {
  const fixture = await makeAppliedFixture(1);
  const accountingPath = privatePath(fixture.layout.root, "store-accounting.json");
  const historyHeadPath = privatePath(fixture.layout.receiptHistory, "head.json");
  const artifactPath = privatePath(fixture.layout.controls, `${"a".repeat(64)}.json`);
  const crashes = [
    {
      status: 101,
      script: [
        'import { readFile } from "node:fs/promises";',
        'import { replacePrivateBytes } from "./dist/private-store.js";',
        `await replacePrivateBytes(${JSON.stringify(accountingPath)}, await readFile(${JSON.stringify(accountingPath)}), 16384, { beforeRename: () => process.exit(101) });`
      ].join("\n")
    },
    {
      status: 102,
      script: [
        'import { readFile } from "node:fs/promises";',
        'import { replacePrivateBytes } from "./dist/private-store.js";',
        `await replacePrivateBytes(${JSON.stringify(historyHeadPath)}, await readFile(${JSON.stringify(historyHeadPath)}), 16777216, { beforeRename: () => process.exit(102) });`
      ].join("\n")
    },
    {
      status: 103,
      script: [
        'import { publishPrivateBytes } from "./dist/private-store.js";',
        `await publishPrivateBytes(${JSON.stringify(artifactPath)}, Buffer.from("uncommitted transaction artifact"), 1024, { afterTemporaryWrite: () => process.exit(103) });`
      ].join("\n")
    }
  ];
  for (const crash of crashes) {
    const result = spawnSync(process.execPath, ["--input-type=module", "--eval", crash.script], {
      cwd: process.cwd(),
      env: fixture.env,
      encoding: "utf8"
    });
    assert.equal(result.status, crash.status, `${result.stdout}\n${result.stderr}`);
  }
  const beforeHead = await readApplyReceiptHistoryHead(fixture.layout, fixture.profileId);
  const beforeAccounting = await readApplyStoreAccounting(fixture.layout, fixture.profileId);
  const before = await snapshotTree(fixture.layout.root);
  const now = new Date(Date.now() + DAY_MS);
  const policy = testPolicy();
  const inspection = await inspectApplyStoreRetention(fixture.profileId, { now, policy });
  assert.equal(inspection.action, "reconcile_publication_residue");
  assert.equal(inspection.publicationResidueCount, 0);
  assert.equal(inspection.uncommittedTemporaryCount, 3);
  assert.deepEqual(await snapshotTree(fixture.layout.root), before);

  await applyApplyStoreRetention(fixture.profileId, {
    now,
    policy,
    expectedInspectionRevision: inspection.inspectionRevision,
    destructiveConsent: APPLY_RETENTION_DESTRUCTIVE_CONSENT
  });
  assert.equal(Object.keys(await snapshotTree(fixture.layout.root)).some((path) => path.includes(".tmp-")), false);
  assert.equal((await readApplyReceiptHistoryHead(fixture.layout, fixture.profileId)).revision, beforeHead.revision);
  assert.equal((await readApplyStoreAccounting(fixture.layout, fixture.profileId)).activeReservation, beforeAccounting.activeReservation);
});

test("marker prelink crash with an active reservation is read-only visible and cleared under history control", async () => {
  const fixture = await makeAppliedFixture(1);
  const transactionId = `apply:${randomUUID()}`;
  await reserveApplyStoreForTransaction(fixture.layout, fixture.profileId, transactionId);
  const markerTarget = privatePath(fixture.layout.unfinished, "never-committed-marker.json");
  const script = [
    'import { publishPrivateBytes } from "./dist/private-store.js";',
    `await publishPrivateBytes(${JSON.stringify(markerTarget)}, Buffer.from("uncommitted marker"), 1024, { afterTemporaryWrite: () => process.exit(104) });`
  ].join("\n");
  const crashed = spawnSync(process.execPath, ["--input-type=module", "--eval", script], {
    cwd: process.cwd(),
    env: fixture.env,
    encoding: "utf8"
  });
  assert.equal(crashed.status, 104, `${crashed.stdout}\n${crashed.stderr}`);

  const before = await snapshotTree(fixture.layout.root);
  const now = new Date(Date.now() + DAY_MS);
  const policy = testPolicy();
  const inspection = await inspectApplyStoreRetention(fixture.profileId, { now, policy });
  assert.equal(inspection.action, "clear_orphan_reservation");
  assert.equal(inspection.uncommittedTemporaryCount, 1);
  assert.deepEqual(await snapshotTree(fixture.layout.root), before);

  await applyApplyStoreRetention(fixture.profileId, {
    now,
    policy,
    expectedInspectionRevision: inspection.inspectionRevision,
    destructiveConsent: APPLY_RETENTION_DESTRUCTIVE_CONSENT
  });
  assert.equal((await readApplyStoreAccounting(fixture.layout, fixture.profileId)).activeReservation, null);
  assert.equal((await readdir(fixture.layout.unfinished)).some((entry) => entry.startsWith(".tmp-")), false);
});

test("an orphan maintenance gate reconciles exact hardlink residue before reopening Apply", async () => {
  const fixture = await makeAppliedFixture(1);
  const now = new Date(Date.now() + 45 * DAY_MS);
  const policy = testPolicy();
  const preview = await inspectApplyStoreRetention(fixture.profileId, { now, policy });
  await assert.rejects(
    applyApplyStoreRetention(fixture.profileId, {
      now,
      policy,
      expectedInspectionRevision: preview.inspectionRevision,
      destructiveConsent: APPLY_RETENTION_DESTRUCTIVE_CONSENT,
      hooks: { afterMaintenanceGate: () => { throw new Error("fixture crash after gate"); } }
    }),
    /fixture crash/
  );
  const gatedAccounting = await readApplyStoreAccounting(fixture.layout, fixture.profileId);
  assert.equal(
    gatedAccounting.maintenanceReservationEntries,
    preview.summaryCountAfter + APPLY_RETENTION_FIXED_PEAK_ENTRIES
  );
  assert.equal(
    preview.maintenancePeakEntries,
    preview.accountingEntries + gatedAccounting.maintenanceReservationEntries
  );
  const receiptFile = (await readdir(fixture.layout.receipts))[0];
  const canonical = privatePath(fixture.layout.receipts, receiptFile);
  const temporary = privatePath(fixture.layout.receipts, `.tmp-${randomUUID()}.artifact`);
  await link(canonical, temporary);

  const interrupted = await inspectApplyStoreRetention(fixture.profileId, { now, policy });
  assert.equal(interrupted.action, "clear_orphan_gate");
  assert.equal(interrupted.publicationResidueCount, 1);
  await applyApplyStoreRetention(fixture.profileId, {
    now,
    policy,
    expectedInspectionRevision: interrupted.inspectionRevision,
    destructiveConsent: APPLY_RETENTION_DESTRUCTIVE_CONSENT
  });
  await assert.rejects(lstat(temporary), /ENOENT/);
  assert.equal((await lstat(canonical)).nlink, 1);
  assert.equal((await readApplyStoreAccounting(fixture.layout, fixture.profileId)).maintenanceId, null);
});

test("maintenance capacity refusal happens before publishing a gate or manifest", async () => {
  const fixture = await makeAppliedFixture(1);
  const now = new Date(Date.now() + 45 * DAY_MS);
  const policy = testPolicy({ maxStoreBytes: 1 });
  const inspection = await inspectApplyStoreRetention(fixture.profileId, { now, policy });
  const accountingBefore = await readApplyStoreAccounting(fixture.layout, fixture.profileId);
  const headBefore = await readApplyReceiptHistoryHead(fixture.layout, fixture.profileId);
  await assert.rejects(
    applyApplyStoreRetention(fixture.profileId, {
      now,
      policy,
      expectedInspectionRevision: inspection.inspectionRevision,
      destructiveConsent: APPLY_RETENTION_DESTRUCTIVE_CONSENT
    }),
    /store cap/
  );
  assert.deepEqual(await readApplyStoreAccounting(fixture.layout, fixture.profileId), accountingBefore);
  assert.deepEqual(await readApplyReceiptHistoryHead(fixture.layout, fixture.profileId), headBefore);
  await assert.rejects(
    readFile(privatePath(fixture.layout.root, "retention-manifest.json")),
    /ENOENT/
  );
});

test("tiny terminal Applies settle exact usage instead of accumulating worst-case reservations", async () => {
  const fixture = await makeAppliedFixture(6);
  const accounting = await readApplyStoreAccounting(fixture.layout, fixture.profileId);
  assert.equal(accounting.schemaVersion, "zts.apply-store-accounting.provisional-5");
  assert.equal(accounting.activeReservation, null);
  assert.ok(accounting.settledMarkerCredit);
  assert.equal(accounting.settledMarkerCredit.entries, 1);
  assert.ok(Number.isSafeInteger(accounting.baselineEntries));
  assert.equal(
    accounting.baselineEntries - accounting.settledMarkerCredit.entries,
    Object.keys(await snapshotTree(fixture.layout.root)).length
  );
  assert.ok(
    accounting.baselineBytes - accounting.settledMarkerCredit.bytes < 64 * 1024 * 1024,
    `tiny fixture store was overcharged at ${accounting.baselineBytes} bytes`
  );
  await assertApplyStoreAdmission(fixture.layout, fixture.profileId);
});

test("entry-aware reservation is O(1), marker-credit aware, and cleared by reviewed maintenance", async () => {
  const fixture = await makeAppliedFixture(1);
  const before = await readApplyStoreAccounting(fixture.layout, fixture.profileId);
  assert.equal(before.settledMarkerCredit.entries, 1);
  const transactionId = `apply:${randomUUID()}`;
  await reserveApplyStoreForTransaction(fixture.layout, fixture.profileId, transactionId);
  const reserved = await readApplyStoreAccounting(fixture.layout, fixture.profileId);
  assert.equal(reserved.activeReservation.transactionId, transactionId);
  assert.equal(reserved.activeReservation.entries, APPLY_TRANSACTION_RESERVATION_ENTRIES);
  assert.equal(reserved.baselineEntries, before.baselineEntries - 1);
  assert.equal(reserved.settledMarkerCredit, null);

  const now = new Date(Date.now() + DAY_MS);
  const policy = testPolicy();
  const inspection = await inspectApplyStoreRetention(fixture.profileId, { now, policy });
  assert.equal(inspection.action, "clear_orphan_reservation");
  await applyApplyStoreRetention(fixture.profileId, {
    now,
    policy,
    expectedInspectionRevision: inspection.inspectionRevision,
    destructiveConsent: APPLY_RETENTION_DESTRUCTIVE_CONSENT
  });
  const cleared = await readApplyStoreAccounting(fixture.layout, fixture.profileId);
  assert.equal(cleared.schemaVersion, "zts.apply-store-accounting.provisional-5");
  assert.equal(cleared.activeReservation, null);
  assert.equal(cleared.baselineEntries, Object.keys(await snapshotTree(fixture.layout.root)).length);
});

test("fixed-parent temp cleanup requires real history ownership while assertions stay read-only", async () => {
  const fixture = await makeAppliedFixture(1);
  const admissionTemporary = privatePath(
    fixture.layout.root,
    `.tmp-${randomUUID()}.artifact`
  );
  await writeFile(admissionTemporary, "interrupted accounting replacement", { mode: 0o600 });
  await assert.rejects(
    assertApplyStoreAdmission(fixture.layout, fixture.profileId),
    /interrupted private replacement/iu
  );
  await assert.doesNotReject(lstat(admissionTemporary));
  await assert.rejects(
    reconcileApplyStoreAdmissionTemporaries(fixture.layout, {
      path: privatePath(fixture.layout.receiptHistory, "history.lock"),
      assertHeld: async () => undefined
    }),
    /capability is inactive|belongs to another store/iu
  );
  await assert.doesNotReject(lstat(admissionTemporary));
  await withApplyReceiptHistoryMigration(
    fixture.layout,
    fixture.profileId,
    async (historyControl) => {
      await assert.rejects(
        reconcileApplyStoreAdmissionTemporaries(
          {
            ...fixture.layout,
            receiptHistory: privatePath(fixture.layout.root, "wrong-receipt-history")
          },
          historyControl
        ),
        /belongs to another store/iu
      );
      await assert.doesNotReject(lstat(admissionTemporary));
      await reconcileApplyStoreAdmissionTemporaries(fixture.layout, historyControl);
    }
  );
  await assertApplyStoreAdmission(fixture.layout, fixture.profileId);
  await assert.rejects(lstat(admissionTemporary), /ENOENT/);

  const freshTemporaries = [
    privatePath(fixture.layout.root, `.tmp-${randomUUID()}.json`),
    privatePath(fixture.layout.unfinished, `.tmp-${randomUUID()}.artifact`),
    privatePath(fixture.layout.receiptHistory, `.tmp-${randomUUID()}.json`)
  ];
  await Promise.all(freshTemporaries.map((path) => writeFile(path, "stale", { mode: 0o600 })));
  await assert.rejects(
    assertApplyStoreFreshBootstrap(fixture.layout),
    /fresh-bootstrap root bound|lacks a complete bounded ledger/iu
  );
  for (const path of freshTemporaries) await assert.doesNotReject(lstat(path));
  await withApplyReceiptHistoryMigration(
    fixture.layout,
    fixture.profileId,
    (historyControl) => reconcileApplyStoreFreshBootstrapTemporaries(
      fixture.layout,
      historyControl
    )
  );
  await assert.rejects(
    assertApplyStoreFreshBootstrap(fixture.layout),
    /lacks a complete bounded ledger/iu
  );
  for (const path of freshTemporaries) await assert.rejects(lstat(path), /ENOENT/);
});

test("strict v4 recovery expands before writes and is idempotent under exact history control", async () => {
  const fixture = await makeAppliedFixture(1);
  const transactionId = `apply:${randomUUID()}`;
  await establishLegacyActiveRecoveryAccounting(fixture, transactionId);
  const nestedStandalone = privatePath(
    fixture.layout.recoveries,
    `.tmp-${randomUUID()}.artifact`
  );
  await writeFile(nestedStandalone, "interrupted descriptor", { mode: 0o600 });
  const controlCanonical = privatePath(
    fixture.layout.controls,
    (await readdir(fixture.layout.controls))[0]
  );
  const nestedHardlink = privatePath(
    fixture.layout.controls,
    `.tmp-${randomUUID()}.json`
  );
  await link(controlCanonical, nestedHardlink);

  const first = await withApplyReceiptHistoryMigration(
    fixture.layout,
    fixture.profileId,
    (historyControl) => ensureApplyStoreRecoveryReservation(
      fixture.layout,
      fixture.profileId,
      transactionId,
      historyControl
    )
  );
  assert.equal(first.expanded, true);
  assert.equal(first.reservationKind, "legacy_recovery");
  assert.equal(first.reservationBytes, APPLY_TRANSACTION_RESERVATION_BYTES);
  assert.equal(first.reservationEntries, 2 * APPLY_TRANSACTION_RESERVATION_ENTRIES);
  await assert.rejects(lstat(nestedStandalone), /ENOENT/);
  await assert.rejects(lstat(nestedHardlink), /ENOENT/);
  assert.equal((await lstat(controlCanonical)).nlink, 1);
  const expanded = await readApplyStoreAccounting(fixture.layout, fixture.profileId);
  assert.equal(expanded.schemaVersion, "zts.apply-store-accounting.provisional-5");
  assert.equal(expanded.activeReservation.kind, "legacy_recovery");
  const afterFirst = await snapshotTree(fixture.layout.root);

  const second = await withApplyReceiptHistoryMigration(
    fixture.layout,
    fixture.profileId,
    (historyControl) => ensureApplyStoreRecoveryReservation(
      fixture.layout,
      fixture.profileId,
      transactionId,
      historyControl
    )
  );
  assert.equal(second.expanded, false);
  assert.equal(second.reservationKind, "legacy_recovery");
  assert.deepEqual(await snapshotTree(fixture.layout.root), afterFirst);

});

test("standard v5 recovery refuses deletion below its exact recorded baseline", async () => {
  const fixture = await makeAppliedFixture(1);
  const transactionId = `apply:${randomUUID()}`;
  await reserveApplyStoreForTransaction(fixture.layout, fixture.profileId, transactionId);
  const receiptFiles = await readdir(fixture.layout.receipts);
  assert.equal(receiptFiles.length, 1);
  await removePrivateFile(privatePath(fixture.layout.receipts, receiptFiles[0]));
  await writeFile(
    privatePath(fixture.layout.unfinished, `${safeArtifactSegment(transactionId)}.json`),
    "x",
    { mode: 0o600 }
  );
  const accountingBefore = await readApplyStoreAccounting(fixture.layout, fixture.profileId);
  const treeBefore = await snapshotTree(fixture.layout.root);

  await assert.rejects(
    withApplyReceiptHistoryMigration(
      fixture.layout,
      fixture.profileId,
      (historyControl) => ensureApplyStoreRecoveryReservation(
        fixture.layout,
        fixture.profileId,
        transactionId,
        historyControl
      )
    ),
    /below its exact recorded baseline/iu
  );
  assert.deepEqual(await readApplyStoreAccounting(fixture.layout, fixture.profileId), accountingBefore);
  assert.deepEqual(await snapshotTree(fixture.layout.root), treeBefore);
});

test("unsafe nested recovery residue blocks expansion without mutating accounting", async () => {
  const fixture = await makeAppliedFixture(1);
  const transactionId = `apply:${randomUUID()}`;
  await establishLegacyActiveRecoveryAccounting(fixture, transactionId);
  const accountingBefore = await readFile(
    privatePath(fixture.layout.root, "store-accounting.json")
  );
  const canonical = privatePath(fixture.layout.recoveries, "unsafe-residue.json");
  const firstLink = privatePath(fixture.layout.recoveries, "unsafe-residue-a.json");
  const secondLink = privatePath(fixture.layout.recoveries, "unsafe-residue-b.json");
  await writeFile(canonical, "{}\n", { mode: 0o600 });
  await link(canonical, firstLink);
  await link(canonical, secondLink);

  await assert.rejects(
    withApplyReceiptHistoryMigration(
      fixture.layout,
      fixture.profileId,
      (historyControl) => ensureApplyStoreRecoveryReservation(
        fixture.layout,
        fixture.profileId,
        transactionId,
        historyControl
      )
    ),
    /not one owner-private path/iu
  );
  assert.deepEqual(
    await readFile(privatePath(fixture.layout.root, "store-accounting.json")),
    accountingBefore
  );
  assert.equal((await lstat(canonical)).nlink, 3);
});

test("recovery reservation cap and free-space failures do not grow the Apply store", async () => {
  const fixture = await makeAppliedFixture(1);
  const transactionId = `apply:${randomUUID()}`;
  const current = await establishLegacyActiveRecoveryAccounting(fixture, transactionId);
  const before = await snapshotTree(fixture.layout.root);
  const bytePeak = current.baselineBytes
    + APPLY_TRANSACTION_RESERVATION_BYTES
    + APPLY_RETENTION_FUTURE_HEADROOM_BYTES;

  await assert.rejects(
    withApplyReceiptHistoryMigration(
      fixture.layout,
      fixture.profileId,
      (historyControl) => ensureApplyStoreRecoveryReservation(
        fixture.layout,
        fixture.profileId,
        transactionId,
        historyControl,
        {
          ...DEFAULT_APPLY_RECOVERY_RESERVATION_POLICY,
          maxStoreBytes: bytePeak - 1,
          minimumFreeBytes: 0
        }
      )
    ),
    /hard store byte cap/iu
  );
  assert.deepEqual(await snapshotTree(fixture.layout.root), before);
  assert.equal(
    (await readApplyStoreAccounting(fixture.layout, fixture.profileId)).schemaVersion,
    "zts.apply-store-accounting.provisional-4"
  );

  await assert.rejects(
    withApplyReceiptHistoryMigration(
      fixture.layout,
      fixture.profileId,
      (historyControl) => ensureApplyStoreRecoveryReservation(
        fixture.layout,
        fixture.profileId,
        transactionId,
        historyControl,
        {
          ...DEFAULT_APPLY_RECOVERY_RESERVATION_POLICY,
          maxStoreBytes: APPLY_STORE_MAX_BYTES,
          minimumFreeBytes: Number.MAX_SAFE_INTEGER
        }
      )
    ),
    /lacks filesystem space/iu
  );
  assert.deepEqual(await snapshotTree(fixture.layout.root), before);
});

test("a terminal legacy transaction above the operational entry cap migrates without stranding recovery", async () => {
  const fixture = await makeAppliedFixture(1);
  const current = await readApplyStoreAccounting(fixture.layout, fixture.profileId);
  const transactionId = `apply:${randomUUID()}`;
  const legacyContent = {
    schemaVersion: "zts.apply-store-accounting.provisional-4",
    profileId: current.profileId,
    baselineBytes: current.baselineBytes,
    activeReservation: {
      transactionId,
      bytes: APPLY_TRANSACTION_RESERVATION_BYTES
    },
    lastSettledTransactionId: null,
    settledMarkerCredit: null,
    maintenanceId: null,
    maintenanceReservationBytes: 0,
    maintenanceSourceHeadRevision: null,
    updatedAt: current.updatedAt
  };
  await replacePrivateJson(
    privatePath(fixture.layout.root, "store-accounting.json"),
    { ...legacyContent, revision: sha256Canonical(legacyContent) }
  );

  const transitionalEntries = APPLY_STORE_MAX_ENTRIES + 1;
  await settleApplyStoreReservation(
    fixture.layout,
    fixture.profileId,
    transactionId,
    current.baselineBytes,
    transitionalEntries,
    1
  );
  // Settlement is retry-safe after v4 has become an over-cap transitional v5
  // head but before marker cleanup has completed.
  await settleApplyStoreReservation(
    fixture.layout,
    fixture.profileId,
    transactionId,
    current.baselineBytes,
    transitionalEntries,
    1
  );
  const transitional = await readApplyStoreAccounting(fixture.layout, fixture.profileId);
  assert.equal(transitional.schemaVersion, "zts.apply-store-accounting.provisional-5");
  assert.equal(transitional.baselineEntries, transitionalEntries);
  assert.equal(transitional.settledMarkerCredit.entries, 1);
  await assert.rejects(
    assertApplyStoreAdmission(fixture.layout, fixture.profileId),
    /entry admission|retention entries/iu
  );

  const now = new Date(Date.now() + DAY_MS);
  const policy = testPolicy({
    maxInventoryEntries: APPLY_RETENTION_MAX_INVENTORY_ENTRIES
  });
  const inspection = await inspectApplyStoreRetention(fixture.profileId, { now, policy });
  assert.deepEqual(inspection.blockers, []);
  const retained = await applyApplyStoreRetention(fixture.profileId, {
    now,
    policy,
    expectedInspectionRevision: inspection.inspectionRevision,
    destructiveConsent: APPLY_RETENTION_DESTRUCTIVE_CONSENT
  });
  assert.equal(retained.outcome, "applied");
  const repaired = await readApplyStoreAccounting(fixture.layout, fixture.profileId);
  assert.ok(repaired.baselineEntries <= APPLY_STORE_MAX_ENTRIES);
});

test("strict legacy v4 accounting preserves historical reads, blocks Apply, and migrates only through retention", async () => {
  const fixture = await makeAppliedFixture(2);
  const beforePage = await listTransactionReceiptPage(fixture.profileId, { limit: 10 });
  assert.equal(beforePage.receipts.length, 2);
  const current = await readApplyStoreAccounting(fixture.layout, fixture.profileId);
  const legacyContent = {
    schemaVersion: "zts.apply-store-accounting.provisional-4",
    profileId: current.profileId,
    baselineBytes: current.baselineBytes,
    activeReservation: null,
    lastSettledTransactionId: current.lastSettledTransactionId,
    settledMarkerCredit: current.settledMarkerCredit && {
      transactionId: current.settledMarkerCredit.transactionId,
      bytes: current.settledMarkerCredit.bytes
    },
    maintenanceId: null,
    maintenanceReservationBytes: 0,
    maintenanceSourceHeadRevision: null,
    updatedAt: current.updatedAt
  };
  await replacePrivateJson(
    privatePath(fixture.layout.root, "store-accounting.json"),
    { ...legacyContent, revision: sha256Canonical(legacyContent) }
  );

  const legacy = await readApplyStoreAccounting(fixture.layout, fixture.profileId);
  assert.equal(legacy.schemaVersion, "zts.apply-store-accounting.provisional-4");
  assert.equal((await listTransactionReceiptPage(fixture.profileId, { limit: 10 })).receipts.length, 2);
  await assert.rejects(
    assertApplyStoreAdmission(fixture.layout, fixture.profileId),
    /reviewed v4 to v5 migration.*zts history retain --apply --yes/iu
  );

  const now = new Date(Date.now() + DAY_MS);
  const policy = testPolicy();
  const inspection = await inspectApplyStoreRetention(fixture.profileId, { now, policy });
  await applyApplyStoreRetention(fixture.profileId, {
    now,
    policy,
    expectedInspectionRevision: inspection.inspectionRevision,
    destructiveConsent: APPLY_RETENTION_DESTRUCTIVE_CONSENT
  });
  const migrated = await readApplyStoreAccounting(fixture.layout, fixture.profileId);
  assert.equal(migrated.schemaVersion, "zts.apply-store-accounting.provisional-5");
  assert.ok(Number.isSafeInteger(migrated.baselineEntries));
  assert.equal((await listTransactionReceiptPage(fixture.profileId, { limit: 10 })).receipts.length, 2);
});

async function makeAppliedFixture(count, options = {}) {
  const temp = await mkdtemp(join(tmpdir(), "zts-retention-real-"));
  roots.add(temp);
  const appSupportDir = join(temp, "zen");
  const profilePath = join(appSupportDir, "Profiles", "retention.Default");
  const sessionPath = join(profilePath, "zen-sessions.jsonlz4");
  const stateDir = join(temp, "state");
  const binDir = join(temp, "bin");
  const configPath = join(temp, "config", "zen-tab-steward", "config.toml");
  await mkdir(join(profilePath, "sessionstore-backups"), { recursive: true });
  await mkdir(binDir, { recursive: true });
  await mkdir(join(temp, "config", "zen-tab-steward"), { recursive: true, mode: 0o700 });
  await writeFile(join(binDir, "ps"), "#!/bin/sh\nexit 0\n");
  await chmod(join(binDir, "ps"), 0o755);
  await writeFile(join(appSupportDir, "profiles.ini"), [
    "[Profile0]", "Name=Retention", "IsRelative=1",
    "Path=Profiles/retention.Default", "Default=1", ""
  ].join("\n"));
  await writeFile(join(appSupportDir, "installs.ini"), [
    "[Install]", "Default=Profiles/retention.Default", "Locked=1", ""
  ].join("\n"));
  const osAbi = process.arch === "arm64" ? "Darwin_aarch64-gcc3" : "Darwin_x86_64-gcc3";
  await writeFile(
    join(profilePath, "compatibility.ini"),
    `[Compatibility]\nLastVersion=1.19.3b_20260315063056/20260315063056\nLastOSABI=${osAbi}\n`
  );
  await writeFile(configPath, [
    "[defaults]", "inbox = \"Space\"", "min_confidence = 0.8",
    "include_pinned = false", "include_essentials = false", "apply_backend = \"auto\"",
    "", "[sort]", "from = []", "to = []", "not_to = []", "only = []", "except = []",
    "", "[protect.workspaces]", "from = []", "to = []",
    "", "[protect.domains]", "never_move = []",
    "", "[rules.domains]", "\"framer.com\" = \"Portfolio\"", ""
  ].join("\n"), { mode: 0o600 });
  const session = {
    spaces: [
      { uuid: "w-space", name: "Space" },
      { uuid: "w-portfolio", name: "Portfolio" }
    ],
    tabs: [
      {
        zenSyncId: "tab-framer",
        zenWorkspace: "w-space",
        pinned: false,
        entries: [{
          url: "https://framer.com/project",
          title: options.largeTitleBytes
            ? "L".repeat(options.largeTitleBytes)
            : "Framer project"
        }]
      },
      ...Array.from({ length: options.extraUnmatchedTabs ?? 0 }, (_, index) => ({
        zenSyncId: `tab-unmatched-${index}`,
        zenWorkspace: "w-space",
        pinned: false,
        entries: [{
          url: `https://unmatched-${index}.example.test`,
          title: `Unmatched tab ${index}`
        }]
      }))
    ],
    folders: [], groups: [], splitViewData: []
  };
  const originalSession = encodeLiteralJsonLz4ForFixture(session);
  await writeFile(join(profilePath, "sessionstore-backups", "recovery.jsonlz4"), "recovery");
  await writeFile(join(profilePath, "sessionstore-backups", "previous.jsonlz4"), "previous");
  const env = {
    ...process.env,
    HOME: temp,
    PATH: `${binDir}:${savedEnvironment.get("PATH") ?? ""}`,
    ZTS_ZEN_APP_SUPPORT_DIR: appSupportDir,
    ZTS_STATE_DIR: stateDir,
    ZTS_CONFIG_PATH: configPath
  };
  let profileId;
  for (let index = 0; index < count; index += 1) {
    await writeFile(sessionPath, originalSession);
    const preview = spawnSync(
      "node",
      ["dist/cli.js", "sort", "--all", "--engine", "rules", "--preview", "--json"],
      { cwd: process.cwd(), env, encoding: "utf8", maxBuffer: 128 * MEBIBYTE }
    );
    assert.equal(preview.status, 0, `${preview.stdout}\n${preview.stderr}`);
    const plan = JSON.parse(preview.stdout).data.plan;
    profileId = plan.profileId;
    const applied = spawnSync(
      "node",
      ["dist/cli.js", "apply", plan.id, "--yes", "--expect-digest", plan.digest, "--json"],
      { cwd: process.cwd(), env, encoding: "utf8", maxBuffer: 128 * MEBIBYTE }
    );
    assert.equal(applied.status, 0, `${applied.stdout}\n${applied.stderr}`);
  }
  for (const key of ["HOME", "PATH", "ZTS_ZEN_APP_SUPPORT_DIR", "ZTS_STATE_DIR", "ZTS_CONFIG_PATH"]) {
    process.env[key] = env[key];
  }
  const layout = await readApplyArtifactLayout(profileId);
  return { temp, env, profileId, layout };
}

async function establishLegacyActiveRecoveryAccounting(fixture, transactionId) {
  const current = await readApplyStoreAccounting(fixture.layout, fixture.profileId);
  const markerPath = privatePath(
    fixture.layout.unfinished,
    `${safeArtifactSegment(transactionId)}.json`
  );
  await writeFile(markerPath, "{}\n", { mode: 0o600 });
  const legacyContent = {
    schemaVersion: "zts.apply-store-accounting.provisional-4",
    profileId: current.profileId,
    baselineBytes: current.baselineBytes,
    activeReservation: {
      transactionId,
      // Exercises a strict historical reservation immediately below the
      // complete current named artifact allowance.
      bytes: APPLY_TRANSACTION_RESERVATION_BYTES - 1
    },
    lastSettledTransactionId: current.lastSettledTransactionId,
    settledMarkerCredit: null,
    maintenanceId: null,
    maintenanceReservationBytes: 0,
    maintenanceSourceHeadRevision: null,
    updatedAt: current.updatedAt
  };
  await replacePrivateJson(
    privatePath(fixture.layout.root, "store-accounting.json"),
    { ...legacyContent, revision: sha256Canonical(legacyContent) }
  );
  return legacyContent;
}

async function snapshotTree(root, current = root, result = {}) {
  for (const entry of (await readdir(current, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(current, entry.name);
    const key = relative(root, path);
    if (entry.isDirectory()) {
      result[`${key}/`] = "directory";
      await snapshotTree(root, path, result);
    } else {
      const bytes = await readFile(path);
      result[key] = createHash("sha256").update(bytes).digest("hex");
    }
  }
  return result;
}

function testPolicy(overrides = {}) {
  return {
    ...DEFAULT_APPLY_RETENTION_POLICY,
    maxSummaryEntries: 32,
    maxInventoryEntries: 20_000,
    ...overrides
  };
}

const DAY_MS = 24 * 60 * 60 * 1000;
const MEBIBYTE = 1024 * 1024;
