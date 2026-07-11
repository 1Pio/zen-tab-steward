import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { join } from "node:path";

import {
  applyStoredPlanClosedSession
} from "../dist/apply-transaction.js";
import {
  listApplyRecoveryInspections,
  recoverApplyTransaction
} from "../dist/apply-recovery.js";
import {
  backupRootForProfile,
  createBackup,
  listBackups
} from "../dist/backup.js";
import { loadConfig } from "../dist/config.js";
import { planDailySort } from "../dist/daily-sort.js";
import { sha256Canonical } from "../dist/domain/digest.js";
import {
  encodeJsonLz4Buffer,
  readJsonLz4
} from "../dist/mozlz4.js";
import { loadStoredPlan } from "../dist/plans.js";
import { discoverProfileContext } from "../dist/profile.js";
import { captureSessionSnapshot } from "../dist/session-snapshot.js";

const scenario = process.argv[2] ?? "missing";
const descriptorPath = process.argv[3];
const startedAt = performance.now();

try {
  assert.ok(descriptorPath, "probe descriptor path is required");
  const descriptor = JSON.parse(await readFile(descriptorPath, "utf8"));
  assert.equal(descriptor.scenario, scenario);
  const evidence = await runScenario(scenario, descriptor);
  emit({
    ok: true,
    scenario,
    ...evidence,
    durationMs: rounded(performance.now() - startedAt),
    maxRssMiB: rounded(process.resourceUsage().maxRSS / 1024)
  });
} catch (error) {
  emit({
    ok: false,
    scenario,
    failureDigest: sha256Text(error instanceof Error ? `${error.name}:${error.message}` : String(error)),
    durationMs: rounded(performance.now() - startedAt),
    maxRssMiB: rounded(process.resourceUsage().maxRSS / 1024)
  });
  process.exitCode = 1;
}

async function runScenario(name, descriptor) {
  if (name === "representative-capture-plan-encode") {
    return capturePlanEncode(descriptor);
  }
  if (name === "near-limit-capture") {
    return nearLimitCapture(descriptor);
  }
  if (name === "near-limit-apply") {
    return nearLimitApply(descriptor);
  }
  if (name === "crash-after-swap-recovery") {
    return crashAfterSwapRecovery(descriptor);
  }
  if (name === "current-shaped-backup" || name === "raw-limit-backup") {
    return backupProbe(descriptor);
  }
  throw new Error("unknown memory acceptance scenario");
}

async function capturePlanEncode(descriptor) {
  const context = await discoverProfileContext();
  const loadedConfig = await loadConfig();
  const captured = await captureSessionSnapshot(context, loadedConfig.config, {
    requireAuthoritative: true
  });
  assert.equal(captured.snapshot.authority, "authoritative");
  assert.equal(captured.summary.tabCount, descriptor.expectedTabCount);
  assert.equal(captured.summary.workspaceCount, descriptor.expectedWorkspaceCount);

  const planned = await planDailySort(captured.snapshot, loadedConfig.config, {
    scope: { kind: "all_workspaces" },
    engine: "rules",
    destinationAllowlist: [],
    destinationDenylist: [],
    only: [],
    except: [],
    limit: null,
    includePinned: false,
    includeEssentials: false,
    autoApplyRequested: false,
    planMode: "create_or_reuse"
  });
  assert.equal(planned.summary.moveCount, descriptor.expectedOperationCount);
  const encoded = encodeJsonLz4Buffer(captured.session);
  assert.equal(sha256Bytes(captured.state.bytes), descriptor.expectedSourceDigest);

  return {
    tabCount: captured.summary.tabCount,
    workspaceCount: captured.summary.workspaceCount,
    operationCount: planned.summary.moveCount,
    sourceBytes: captured.state.bytes.byteLength,
    encodedBytes: encoded.byteLength,
    snapshotDigest: captured.snapshot.revision,
    planDigest: planned.plan.digest,
    encodedDigest: sha256Bytes(encoded)
  };
}

async function nearLimitCapture(descriptor) {
  const context = await discoverProfileContext();
  const loadedConfig = await loadConfig();
  const captured = await captureSessionSnapshot(context, loadedConfig.config, {
    requireAuthoritative: true
  });
  assert.equal(captured.snapshot.authority, "authoritative");
  assert.equal(captured.summary.tabCount, descriptor.expectedTabCount);
  assert.equal(captured.snapshot.entities.length, descriptor.expectedEntityCount);
  assert.equal(captured.state.bytes.byteLength, descriptor.expectedSourceBytes);
  assert.equal(sha256Bytes(captured.state.bytes), descriptor.expectedSourceDigest);

  return {
    tabCount: captured.summary.tabCount,
    entityCount: captured.snapshot.entities.length,
    sourceBytes: captured.state.bytes.byteLength,
    decompressedBytes: descriptor.expectedDecompressedBytes,
    snapshotDigest: captured.snapshot.revision,
    sourceDigest: descriptor.expectedSourceDigest
  };
}

async function nearLimitApply(descriptor) {
  const context = await discoverProfileContext();
  const stored = await loadStoredPlan(context.profile.id, descriptor.planId);
  assert.equal(stored.plan.digest, descriptor.planDigest);
  const result = await applyStoredPlanClosedSession(context, stored, {
    expectedDigest: descriptor.planDigest,
    command: "memory acceptance: near-limit closed-session apply"
  });
  assert.equal(result.applied, true);
  assert.equal(result.receipt.outcome, "applied");
  assert.equal(result.receipt.operations.length, descriptor.expectedOperationCount);
  assert.ok(result.receipt.operations.every((operation) => operation.status === "verified"));
  const session = await readJsonLz4(context.sessionFile.path);
  const stateDigest = sha256Json(session);
  assert.equal(stateDigest, descriptor.expectedStateDigest);

  return {
    operationCount: result.receipt.operations.length,
    verifiedCount: result.receipt.operations.filter((operation) => operation.status === "verified").length,
    stateDigest,
    receiptDigest: sha256Canonical(result.receipt),
    planDigest: result.plan.digest
  };
}

async function crashAfterSwapRecovery(descriptor) {
  const context = await discoverProfileContext();
  const result = await recoverApplyTransaction(context, descriptor.transactionId, {
    expectedRecoveryRevision: descriptor.recoveryRevision
  });
  assert.equal(result.recoveryRecorded, true);
  assert.equal(result.receipt.outcome, "applied");
  assert.equal(result.receipt.operations.length, descriptor.expectedOperationCount);
  assert.ok(result.receipt.operations.every((operation) => operation.status === "verified"));
  const session = await readJsonLz4(context.sessionFile.path);
  const stateDigest = sha256Json(session);
  assert.equal(stateDigest, descriptor.expectedStateDigest);
  assert.deepEqual(await listApplyRecoveryInspections(await discoverProfileContext()), []);

  return {
    operationCount: result.receipt.operations.length,
    verifiedCount: result.receipt.operations.filter((operation) => operation.status === "verified").length,
    stateDigest,
    receiptDigest: sha256Canonical(result.receipt),
    recoveryDigest: descriptor.recoveryRevision
  };
}

async function backupProbe(descriptor) {
  const context = await discoverProfileContext();
  const manifest = await createBackup(context, `memory acceptance: ${descriptor.scenario}`);
  assert.equal(manifest.schemaVersion, "zts.backup-manifest.v1");
  assert.equal(manifest.profileId, context.profile.id);
  assert.equal(manifest.files.length, descriptor.expectedSourceCount);
  assert.equal(
    manifest.files.reduce((total, file) => total + file.size, 0),
    descriptor.expectedSourceBytes
  );

  const listed = await listBackups(context.profile.id);
  assert.equal(listed.length, 1);
  assert.deepEqual(listed[0], manifest);
  const root = backupRootForProfile(context.profile.id);
  const persistedPath = join(root, `${manifest.id}--manifest.json`);
  assert.equal((await stat(root)).mode & 0o777, 0o700);
  assert.equal((await stat(persistedPath)).mode & 0o777, 0o600);
  const persisted = JSON.parse(await readFile(persistedPath, "utf8"));
  assert.deepEqual(persisted, manifest);

  for (const file of manifest.files) {
    assert.equal((await stat(file.backup)).mode & 0o777, 0o600);
    assert.equal(await streamSha256(file.source), file.sha256);
    assert.equal(await streamSha256(file.backup), file.sha256);
  }

  return {
    sourceCount: manifest.files.length,
    sourceBytes: manifest.files.reduce((total, file) => total + file.size, 0),
    verifiedCount: manifest.files.length,
    manifestDigest: sha256Canonical(persisted),
    contentDigest: sha256Canonical(
      manifest.files.map((file) => ({ size: file.size, sha256: file.sha256 }))
    )
  };
}

function sha256Json(value) {
  return sha256Text(JSON.stringify(value));
}

function sha256Bytes(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function sha256Text(value) {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

function streamSha256(path) {
  return new Promise((resolve, reject) => {
    const digest = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("data", (chunk) => digest.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(digest.digest("hex")));
  });
}

function rounded(value) {
  return Math.round(value * 100) / 100;
}

function emit(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}
