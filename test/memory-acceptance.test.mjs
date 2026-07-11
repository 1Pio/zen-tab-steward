import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  open,
  rm,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import test, { after } from "node:test";

import {
  encodeJsonLz4Buffer,
  readJsonLz4
} from "../dist/mozlz4.js";

const MEBIBYTE = 1024 * 1024;
const RUN_ACCEPTANCE = process.env.ZTS_MEMORY_ACCEPTANCE === "1";
const REPOSITORY_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const WORKER_PATH = join(REPOSITORY_ROOT, "test", "memory-probe-worker.mjs");
const fixtureRoots = new Set();

after(async () => {
  await Promise.all([...fixtureRoots].map((root) => rm(root, { recursive: true, force: true })));
});

memoryTest("representative 228-tab capture, rules Plan, and encode stay within 320 MiB and 5 seconds", async () => {
  const session = representativeSession();
  const encoded = encodeJsonLz4Buffer(session);
  const fixture = await createProfileFixture("zts-memory-representative", encoded);
  const report = await runProbe(fixture, {
    scenario: "representative-capture-plan-encode",
    expectedTabCount: 228,
    expectedWorkspaceCount: 6,
    expectedOperationCount: 228,
    expectedSourceDigest: sha256Bytes(encoded)
  }, {
    maxRssMiB: 320,
    maxDurationMs: 5_000
  });

  assert.equal(report.tabCount, 228);
  assert.equal(report.workspaceCount, 6);
  assert.equal(report.operationCount, 228);
  assert.match(report.snapshotDigest, /^sha256:[0-9a-f]{64}$/u);
  assert.match(report.planDigest, /^sha256:[0-9a-f]{64}$/u);
  assert.match(report.encodedDigest, /^sha256:[0-9a-f]{64}$/u);
});

memoryTest("near-limit low-compression 10,000-tab authoritative capture stays within 512 MiB and 10 seconds", async () => {
  const session = nearLimitSession();
  const json = JSON.stringify(session);
  const decompressedBytes = Buffer.byteLength(json);
  assert.ok(decompressedBytes >= 29 * MEBIBYTE, `fixture is only ${decompressedBytes} bytes`);
  assert.ok(decompressedBytes < 32 * MEBIBYTE, `fixture exceeds the production decode limit: ${decompressedBytes}`);
  const encoded = literalMozLz4(json);
  assert.ok(encoded.byteLength / decompressedBytes > 0.99, "fixture must exercise a low-compression source");
  const fixture = await createProfileFixture("zts-memory-near-capture", encoded);
  const report = await runProbe(fixture, {
    scenario: "near-limit-capture",
    expectedTabCount: 10_000,
    expectedEntityCount: 10_000,
    expectedSourceBytes: encoded.byteLength,
    expectedDecompressedBytes: decompressedBytes,
    expectedSourceDigest: sha256Bytes(encoded)
  }, {
    maxRssMiB: 512,
    maxDurationMs: 10_000
  });

  assert.equal(report.tabCount, 10_000);
  assert.equal(report.entityCount, 10_000);
  assert.equal(report.sourceBytes, encoded.byteLength);
  assert.equal(report.decompressedBytes, decompressedBytes);
});

memoryTest("near-limit 500-operation closed-session Apply stays within 512 MiB and 10 seconds", async () => {
  const fixture = await createApplyFixture("zts-memory-apply");
  const plan = prepareApplyPlan(fixture);
  const report = await runProbe(fixture, {
    scenario: "near-limit-apply",
    planId: plan.id,
    planDigest: plan.digest,
    expectedOperationCount: 500,
    expectedStateDigest: fixture.expectedStateDigest
  }, {
    maxRssMiB: 512,
    maxDurationMs: 10_000
  });

  assert.equal(report.operationCount, 500);
  assert.equal(report.verifiedCount, 500);
  assert.equal(report.stateDigest, fixture.expectedStateDigest);
});

memoryTest("crash-after-swap recovery for 500 Operations stays within 512 MiB and 10 seconds", async () => {
  const fixture = await createApplyFixture("zts-memory-recovery");
  const plan = prepareApplyPlan(fixture);
  const recovery = prepareCrashAfterSwapRecovery(fixture, plan);
  assert.equal(sha256Json(await readJsonLz4(fixture.sessionPath)), fixture.expectedStateDigest);

  const report = await runProbe(fixture, {
    scenario: "crash-after-swap-recovery",
    transactionId: recovery.transactionId,
    recoveryRevision: recovery.recoveryRevision,
    expectedOperationCount: 500,
    expectedStateDigest: fixture.expectedStateDigest
  }, {
    maxRssMiB: 512,
    maxDurationMs: 10_000
  });

  assert.equal(report.operationCount, 500);
  assert.equal(report.verifiedCount, 500);
  assert.equal(report.stateDigest, fixture.expectedStateDigest);
});

memoryTest("current-shaped 18.029 MiB backup stays within 256 MiB and 5 seconds", async () => {
  const sizes = {
    "zen-sessions.jsonlz4": Math.round(2.55 * MEBIBYTE),
    "sessionstore-backups/recovery.jsonlz4": Math.round(7.844 * MEBIBYTE),
    "sessionstore-backups/previous.jsonlz4": Math.round(7.635 * MEBIBYTE)
  };
  const fixture = await createBackupFixture("zts-memory-current-backup", sizes);
  const expectedSourceBytes = Object.values(sizes).reduce((total, size) => total + size, 0);
  const report = await runProbe(fixture, {
    scenario: "current-shaped-backup",
    expectedSourceCount: 3,
    expectedSourceBytes
  }, {
    maxRssMiB: 256,
    maxDurationMs: 5_000
  });

  assert.equal(report.sourceCount, 3);
  assert.equal(report.verifiedCount, 3);
  assert.equal(report.sourceBytes, expectedSourceBytes);
});

memoryTest("63.5 MiB raw backup stays within 320 MiB and 10 seconds", async () => {
  const sourceBytes = Math.round(63.5 * MEBIBYTE);
  const fixture = await createBackupFixture("zts-memory-raw-backup", {
    "zen-sessions.jsonlz4": sourceBytes
  });
  const report = await runProbe(fixture, {
    scenario: "raw-limit-backup",
    expectedSourceCount: 1,
    expectedSourceBytes: sourceBytes
  }, {
    maxRssMiB: 320,
    maxDurationMs: 10_000
  });

  assert.equal(report.sourceCount, 1);
  assert.equal(report.verifiedCount, 1);
  assert.equal(report.sourceBytes, sourceBytes);
});

function memoryTest(name, fn) {
  test(name, {
    concurrency: false,
    timeout: 60_000,
    skip: RUN_ACCEPTANCE ? false : "set ZTS_MEMORY_ACCEPTANCE=1 to run measured subprocess gates"
  }, fn);
}

async function runProbe(fixture, descriptor, limits) {
  const descriptorPath = join(fixture.temp, `${descriptor.scenario}-descriptor.json`);
  await writeFile(descriptorPath, `${JSON.stringify(descriptor)}\n`, { mode: 0o600 });

  const startedAt = performance.now();
  const run = spawnSync(process.execPath, [WORKER_PATH, descriptor.scenario, descriptorPath], {
    cwd: REPOSITORY_ROOT,
    env: fixture.env,
    encoding: "utf8",
    maxBuffer: 256 * 1024,
    timeout: limits.maxDurationMs + 15_000
  });
  const elapsedMs = performance.now() - startedAt;
  assert.equal(run.signal, null, `memory probe terminated by ${run.signal ?? "unknown signal"}`);
  assert.equal(run.status, 0, `memory probe failed: ${run.stdout.trim()} ${run.stderr.trim()}`);
  assert.equal(run.stderr, "");
  const lines = run.stdout.trim().split("\n");
  assert.equal(lines.length, 1, "memory worker must emit exactly one JSON document");
  const report = JSON.parse(lines[0]);
  assertMemoryOnlyReport(report);
  assert.equal(report.ok, true);
  assert.equal(report.scenario, descriptor.scenario);
  assert.ok(
    report.maxRssMiB <= limits.maxRssMiB,
    `${descriptor.scenario} used ${report.maxRssMiB} MiB; limit is ${limits.maxRssMiB} MiB`
  );
  assert.ok(
    report.durationMs <= limits.maxDurationMs,
    `${descriptor.scenario} worker took ${report.durationMs}ms; limit is ${limits.maxDurationMs}ms`
  );
  assert.ok(
    elapsedMs <= limits.maxDurationMs,
    `${descriptor.scenario} subprocess took ${Math.round(elapsedMs)}ms; limit is ${limits.maxDurationMs}ms`
  );
  return report;
}

function assertMemoryOnlyReport(report) {
  assert.ok(report && typeof report === "object" && !Array.isArray(report));
  for (const [key, value] of Object.entries(report)) {
    assert.match(
      key,
      /^(?:ok|scenario|durationMs|maxRssMiB|[a-z][A-Za-z]*(?:Count|Bytes|Digest))$/u,
      `memory worker emitted a non-evidence field: ${key}`
    );
    assert.ok(["boolean", "number", "string"].includes(typeof value));
  }
}

async function createProfileFixture(prefix, sessionBytes) {
  const temp = await mkdtemp(join(tmpdir(), `${prefix}-`));
  fixtureRoots.add(temp);
  const appSupportDir = join(temp, "zen");
  const profilePath = join(appSupportDir, "Profiles", "memory.Default");
  const sessionPath = join(profilePath, "zen-sessions.jsonlz4");
  const configDir = join(temp, "config", "zen-tab-steward");
  const configPath = join(configDir, "config.toml");
  const stateDir = join(temp, "state");
  const binDir = join(temp, "bin");
  await mkdir(join(profilePath, "sessionstore-backups"), { recursive: true });
  await mkdir(configDir, { recursive: true, mode: 0o700 });
  await chmod(configDir, 0o700);
  await mkdir(binDir, { recursive: true });
  await writeFile(join(binDir, "ps"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  await chmod(join(binDir, "ps"), 0o755);
  await writeFile(join(appSupportDir, "profiles.ini"), [
    "[Profile0]",
    "Name=Memory acceptance",
    "IsRelative=1",
    "Path=Profiles/memory.Default",
    "Default=1",
    ""
  ].join("\n"), { mode: 0o600 });
  await writeFile(join(appSupportDir, "installs.ini"), [
    "[Install]",
    "Default=Profiles/memory.Default",
    "Locked=1",
    ""
  ].join("\n"), { mode: 0o600 });
  await writeFile(join(profilePath, "compatibility.ini"), supportedCompatibilityIni(), { mode: 0o600 });
  await writeFile(sessionPath, sessionBytes, { mode: 0o600 });
  await writeFile(configPath, acceptanceConfig(), { mode: 0o600 });

  return {
    temp,
    appSupportDir,
    profilePath,
    sessionPath,
    configPath,
    stateDir,
    binDir,
    env: {
      ...process.env,
      HOME: temp,
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
      ZTS_ZEN_APP_SUPPORT_DIR: appSupportDir,
      ZTS_STATE_DIR: stateDir,
      ZTS_CONFIG_PATH: configPath
    }
  };
}

async function createApplyFixture(prefix) {
  const session = applySession();
  const expected = {
    ...session,
    tabs: session.tabs.map((tab) => ({ ...tab, zenWorkspace: "w-destination" }))
  };
  const fixture = await createProfileFixture(prefix, encodeJsonLz4Buffer(session));
  return { ...fixture, expectedStateDigest: sha256Json(expected) };
}

async function createBackupFixture(prefix, sourceSizes) {
  const fixture = await createProfileFixture(prefix, Buffer.alloc(1));
  for (const [index, [relativePath, size]] of Object.entries(sourceSizes).entries()) {
    const path = join(fixture.profilePath, ...relativePath.split("/"));
    await mkdir(dirname(path), { recursive: true });
    await writeDeterministicFile(path, size, 0x6d2b79f5 ^ index);
    await chmod(path, 0o600);
  }
  return fixture;
}

async function writeDeterministicFile(path, size, seed) {
  const chunk = Buffer.allocUnsafe(MEBIBYTE);
  let state = seed >>> 0;
  for (let index = 0; index < chunk.length; index += 1) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    chunk[index] = state & 0xff;
  }
  const handle = await open(path, "w", 0o600);
  try {
    let offset = 0;
    while (offset < size) {
      const length = Math.min(chunk.length, size - offset);
      const { bytesWritten } = await handle.write(chunk, 0, length, offset);
      assert.equal(bytesWritten, length);
      offset += bytesWritten;
    }
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function prepareApplyPlan(fixture) {
  const prepared = spawnSync(process.execPath, [
    "dist/cli.js",
    "sort",
    "--all",
    "--engine",
    "rules",
    "--preview",
    "--limit",
    "500",
    "--json"
  ], {
    cwd: REPOSITORY_ROOT,
    env: fixture.env,
    encoding: "utf8",
    maxBuffer: 64 * MEBIBYTE,
    timeout: 30_000
  });
  assert.equal(prepared.status, 0, `${prepared.stdout}\n${prepared.stderr}`);
  const plan = JSON.parse(prepared.stdout).data.plan;
  assert.equal(plan.actions.filter((action) => action.disposition === "move").length, 500);
  return plan;
}

function prepareCrashAfterSwapRecovery(fixture, plan) {
  const exitCode = 86;
  const crashScript = [
    'import { discoverProfileContext } from "./dist/profile.js";',
    'import { loadStoredPlan } from "./dist/plans.js";',
    'import { applyStoredPlanClosedSession } from "./dist/apply-transaction.js";',
    "const context = await discoverProfileContext();",
    `const stored = await loadStoredPlan(context.profile.id, ${JSON.stringify(plan.id)});`,
    "await applyStoredPlanClosedSession(context, stored, {",
    `  expectedDigest: ${JSON.stringify(plan.digest)},`,
    '  command: "memory acceptance: prepare crash after atomic swap",',
    `  afterAtomicSwap: () => process.exit(${exitCode})`,
    "});"
  ].join("\n");
  const crashed = spawnSync(process.execPath, ["--input-type=module", "--eval", crashScript], {
    cwd: REPOSITORY_ROOT,
    env: fixture.env,
    encoding: "utf8",
    maxBuffer: 4 * MEBIBYTE,
    timeout: 30_000
  });
  assert.equal(crashed.status, exitCode, `${crashed.stdout}\n${crashed.stderr}`);

  const listed = spawnSync(process.execPath, ["dist/cli.js", "apply", "recover", "--json"], {
    cwd: REPOSITORY_ROOT,
    env: fixture.env,
    encoding: "utf8",
    maxBuffer: 64 * MEBIBYTE,
    timeout: 30_000
  });
  assert.equal(listed.status, 0, `${listed.stdout}\n${listed.stderr}`);
  const recoveries = JSON.parse(listed.stdout).data.recoveries;
  assert.equal(recoveries.length, 1);
  assert.equal(recoveries[0].classification, "planned_after_present");
  assert.equal(recoveries[0].recoverable, true);
  return recoveries[0];
}

function representativeSession() {
  const nextText = deterministicTextFactory(0x1a2b3c4d);
  const workspaces = [
    { uuid: "w-source", name: "Source" },
    { uuid: "w-destination", name: "Destination" },
    { uuid: "w-research", name: "Research" },
    { uuid: "w-writing", name: "Writing" },
    { uuid: "w-tools", name: "Tools" },
    { uuid: "w-stash", name: "Stash" }
  ];
  return {
    spaces: workspaces,
    tabs: Array.from({ length: 228 }, (_, index) => {
      const base = nextText(10_000);
      return {
        zenSyncId: `representative-${String(index).padStart(4, "0")}`,
        zenWorkspace: "w-source",
        pinned: false,
        entries: [{
          url: `https://move.example.test/representative/${index}`,
          title: `Representative tab ${index}`
        }],
        formdata: { fixtureState: base.repeat(11) }
      };
    }),
    folders: [],
    groups: [],
    splitViewData: []
  };
}

function nearLimitSession() {
  const nextText = deterministicTextFactory(0x5e6f7788);
  return {
    spaces: [
      { uuid: "w-source", name: "Source" },
      { uuid: "w-destination", name: "Destination" }
    ],
    tabs: Array.from({ length: 10_000 }, (_, index) => ({
      zenSyncId: `near-limit-${String(index).padStart(5, "0")}`,
      zenWorkspace: "w-source",
      pinned: false,
      entries: [{
        url: `https://capture-${index}.example.test/path`,
        title: nextText(2_950)
      }]
    })),
    folders: [],
    groups: [],
    splitViewData: []
  };
}

function applySession() {
  return {
    spaces: [
      { uuid: "w-source", name: "Source" },
      { uuid: "w-destination", name: "Destination" }
    ],
    tabs: Array.from({ length: 500 }, (_, index) => ({
      zenSyncId: `apply-${String(index).padStart(4, "0")}`,
      zenWorkspace: "w-source",
      pinned: false,
      entries: [{
        url: `https://move.example.test/apply/${index}`,
        title: `Apply fixture ${index}`
      }]
    })),
    folders: [],
    groups: [],
    splitViewData: []
  };
}

function deterministicTextFactory(seed) {
  const alphabet = Buffer.from("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789", "ascii");
  let state = seed >>> 0;
  return (length) => {
    const output = Buffer.allocUnsafe(length);
    for (let index = 0; index < length; index += 1) {
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      state >>>= 0;
      output[index] = alphabet[state % alphabet.length];
    }
    return output.toString("ascii");
  };
}

function literalMozLz4(json) {
  const payload = Buffer.from(json, "utf8");
  const lengthBytes = [Math.min(15, payload.length) << 4];
  if (payload.length >= 15) {
    let remaining = payload.length - 15;
    while (remaining >= 255) {
      lengthBytes.push(255);
      remaining -= 255;
    }
    lengthBytes.push(remaining);
  }
  const header = Buffer.alloc(12);
  Buffer.from([0x6d, 0x6f, 0x7a, 0x4c, 0x7a, 0x34, 0x30, 0x00]).copy(header);
  header.writeUInt32LE(payload.length, 8);
  return Buffer.concat([header, Buffer.from(lengthBytes), payload]);
}

function acceptanceConfig() {
  return [
    "[defaults]",
    'inbox = "Source"',
    "min_confidence = 0.8",
    "include_pinned = false",
    "include_essentials = false",
    'apply_backend = "auto"',
    "",
    "[sort]",
    "from = []",
    "to = []",
    "not_to = []",
    "only = []",
    "except = []",
    "",
    "[semantic]",
    "enabled = false",
    'engine = "bge-small"',
    "suggestion_threshold = 0.72",
    "auto_apply = false",
    "auto_apply_threshold = 0.92",
    "minimum_margin = 0.18",
    "max_moves = 500",
    "",
    "[protect.workspaces]",
    "from = []",
    "to = []",
    "",
    "[protect.domains]",
    "never_move = []",
    "",
    "[rules.domains]",
    '"move.example.test" = "Destination"',
    ""
  ].join("\n");
}

function supportedCompatibilityIni() {
  const osAbi = process.arch === "arm64" ? "Darwin_aarch64-gcc3" : "Darwin_x86_64-gcc3";
  return `[Compatibility]\nLastVersion=1.19.3b_20260315063056/20260315063056\nLastOSABI=${osAbi}\n`;
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
