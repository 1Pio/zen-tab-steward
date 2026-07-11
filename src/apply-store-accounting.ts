import { lstat, opendir, readdir, statfs } from "node:fs/promises";
import { basename, relative, sep } from "node:path";
import { safeArtifactSegment } from "./apply-artifacts.js";
import { assertApplyReceiptHistoryControlHeld } from "./apply-receipt-history-control.js";
import { APPLY_UNFINISHED_MARKER_MAX_BYTES } from "./apply-unfinished-store.js";
import { sha256Canonical } from "./domain/digest.js";
import {
  createPrivateJsonExclusive,
  inspectPrivateStandaloneTemporaryCandidate,
  isPrivateTemporaryBasename,
  privatePath,
  readPrivateJson,
  reconcilePrivatePublication,
  removePrivateStandaloneTemporaryCandidate,
  replacePrivateJson
} from "./private-store.js";

import type { ApplyArtifactLayout } from "./apply-artifacts.js";
import type { ApplyReceiptHistoryControl } from "./apply-receipt-history-control.js";
import type { Sha256Digest } from "./domain/digest.js";

const ACCOUNTING_SCHEMA = "zts.apply-store-accounting.provisional-5" as const;
const LEGACY_ACCOUNTING_SCHEMA = "zts.apply-store-accounting.provisional-4" as const;
const ACCOUNTING_FILENAME = "store-accounting.json";
export const APPLY_STORE_ACCOUNTING_MAX_BYTES = 16 * 1024;
const ACCOUNTING_MAX_BYTES = APPLY_STORE_ACCOUNTING_MAX_BYTES;
const MEBIBYTE = 1024 * 1024;
const FRESH_UNFINISHED_INDEX_MAX_BYTES = 8 * 1024;
const FRESH_RECEIPT_HISTORY_HEAD_MAX_BYTES = 16 * 1024;
const FRESH_RECEIPT_HISTORY_LOCK_MAX_BYTES = 16 * MEBIBYTE;
const APPLY_ROOT_FIXED_SCAN_MAX_ENTRIES = 32;
const FRESH_CHILD_FIXED_SCAN_MAX_ENTRIES = 16;

export const APPLY_STORE_MAX_ENTRIES = 150_000;
export const APPLY_RETENTION_MAX_INVENTORY_ENTRIES = 1_000_000;
export const APPLY_STORE_MAX_BYTES = 2 * 1024 * MEBIBYTE;
export const APPLY_TRANSACTION_RESERVATION_ENTRIES = 64;
export const APPLY_RETENTION_MAX_TARGET_ENTRIES = 4_096;
// Sixteen target-node publications may be concurrent. The remaining slots
// cover manifest/result canonicals and temporaries, ready-head/accounting
// replacement temporaries, and bounded maintenance control artifacts.
export const APPLY_RETENTION_FIXED_PEAK_ENTRIES = 32;
export const APPLY_RETENTION_FUTURE_HEADROOM_ENTRIES =
  APPLY_RETENTION_MAX_TARGET_ENTRIES + APPLY_RETENTION_FIXED_PEAK_ENTRIES;
export const APPLY_RETENTION_HISTORY_NODE_MAX_BYTES = 16 * 1024;
export const APPLY_RETENTION_MANIFEST_MAX_BYTES = 64 * MEBIBYTE;
export const APPLY_RETENTION_RESULT_MAX_BYTES = 64 * 1024;
export const APPLY_RETENTION_METADATA_TEMP_BYTES = 2 * MEBIBYTE;
export const APPLY_RETENTION_FIXED_HEADROOM_BYTES =
  APPLY_RETENTION_MANIFEST_MAX_BYTES
  + APPLY_RETENTION_RESULT_MAX_BYTES
  + APPLY_RETENTION_METADATA_TEMP_BYTES;
export const APPLY_RETENTION_FUTURE_HEADROOM_BYTES =
  APPLY_RETENTION_MAX_TARGET_ENTRIES * APPLY_RETENTION_HISTORY_NODE_MAX_BYTES
  + APPLY_RETENTION_FIXED_HEADROOM_BYTES;
export const APPLY_RECOVERY_TERMINAL_INTENT_MAX_BYTES = 36 * MEBIBYTE + 64 * 1024;
export const APPLY_RECEIPT_MAX_BYTES = 16 * MEBIBYTE;
export const APPLY_RECEIPT_PUBLICATION_INTENT_MAX_BYTES = 18 * MEBIBYTE;
const APPLY_ROOT_STANDALONE_TEMP_MAX_BYTES = APPLY_RETENTION_MANIFEST_MAX_BYTES;
const FRESH_UNFINISHED_STANDALONE_TEMP_MAX_BYTES = APPLY_UNFINISHED_MARKER_MAX_BYTES;
const FRESH_RECEIPT_HISTORY_STANDALONE_TEMP_MAX_BYTES = MEBIBYTE;

// Every durable Apply-store payload is capped. Mutable replacements occupy one
// canonical file; publication temporaries are removed before the call returns.
export const APPLY_TRANSACTION_ARTIFACT_CAP_BYTES = Object.freeze({
  backupBytes: 64 * MEBIBYTE,
  preparedImageOrFragment: 64 * MEBIBYTE,
  receiptObject: APPLY_RECEIPT_MAX_BYTES,
  receiptPublicationIntent: APPLY_RECEIPT_PUBLICATION_INTENT_MAX_BYTES,
  inversePlan: 128 * MEBIBYTE,
  mutableJournal: 16 * MEBIBYTE,
  normalPrimaryImmutableJournal: 16 * MEBIBYTE,
  normalFallbackImmutableJournal: 16 * MEBIBYTE,
  recoveryImmutableJournal: 16 * MEBIBYTE,
  authorization: 16 * MEBIBYTE,
  consent: 16 * MEBIBYTE,
  unfinishedMarker: APPLY_UNFINISHED_MARKER_MAX_BYTES,
  normalPrimaryControlProof: 16 * MEBIBYTE,
  normalFallbackControlProof: 16 * MEBIBYTE,
  recoveryControlProof: 16 * MEBIBYTE,
  recoveryTerminalIntent: APPLY_RECOVERY_TERMINAL_INTENT_MAX_BYTES,
  recoveryClaim: 16 * MEBIBYTE,
  recoveryKernelControl: 16 * MEBIBYTE,
  normalPreMutationRecoveryDescriptor: 16 * MEBIBYTE,
  recoveryCreatedDescriptor: 16 * MEBIBYTE,
  backupManifest: 16 * MEBIBYTE,
  receiptHistoryNodeAndPointers: 1 * MEBIBYTE,
  largestConcurrentPublicationTemporary: 128 * MEBIBYTE
});

export const APPLY_TRANSACTION_MAX_ARTIFACT_BYTES = Object.values(
  APPLY_TRANSACTION_ARTIFACT_CAP_BYTES
).reduce((total, value) => total + value, 0);

export const APPLY_TRANSACTION_RESERVATION_BYTES = APPLY_TRANSACTION_MAX_ARTIFACT_BYTES;
const LEGACY_APPLY_TRANSACTION_MIN_RESERVATION_BYTES =
  APPLY_TRANSACTION_RESERVATION_BYTES
  // V4 predates three entry-ledger artifacts, four explicitly named finite
  // fallback/recovery fan-out slots, and the 12 MiB Receipt plus 9 MiB intent
  // exact-encoding cap expansions. Keep strict reads compatible with the exact
  // historical reservation while new reservations dominate current writes.
  - (7 * 16 * MEBIBYTE)
  - ((12 + 9) * MEBIBYTE)
  - APPLY_RECOVERY_TERMINAL_INTENT_MAX_BYTES;
if (APPLY_TRANSACTION_RESERVATION_BYTES < APPLY_TRANSACTION_MAX_ARTIFACT_BYTES) {
  throw new Error("Apply Transaction reservation does not dominate every artifact write cap");
}

export interface ApplyRecoveryReservationPolicy {
  readonly maxStoreBytes: number;
  readonly maxStoreEntries: number;
  readonly minimumFreeBytes: number;
  readonly reservationBytes: number;
  readonly reservationEntries: number;
}

export const DEFAULT_APPLY_RECOVERY_RESERVATION_POLICY: ApplyRecoveryReservationPolicy =
  Object.freeze({
    maxStoreBytes: APPLY_STORE_MAX_BYTES,
    maxStoreEntries: APPLY_RETENTION_MAX_INVENTORY_ENTRIES,
    minimumFreeBytes: 512 * MEBIBYTE,
    reservationBytes: APPLY_TRANSACTION_RESERVATION_BYTES,
    reservationEntries: APPLY_TRANSACTION_RESERVATION_ENTRIES
  });

export interface ApplyStoreQuotaPolicy {
  readonly maxStoreBytes: number;
  readonly maxStoreEntries: number;
  readonly minimumFreeBytes: number;
  readonly reservationBytes: number;
  readonly reservationEntries: number;
  readonly retentionHeadroomBytes: number;
  readonly retentionHeadroomEntries: number;
}

export const DEFAULT_APPLY_STORE_QUOTA_POLICY: ApplyStoreQuotaPolicy = Object.freeze({
  maxStoreBytes: APPLY_STORE_MAX_BYTES,
  maxStoreEntries: APPLY_STORE_MAX_ENTRIES,
  minimumFreeBytes: 512 * MEBIBYTE,
  reservationBytes: APPLY_TRANSACTION_RESERVATION_BYTES,
  reservationEntries: APPLY_TRANSACTION_RESERVATION_ENTRIES,
  retentionHeadroomBytes: APPLY_RETENTION_FUTURE_HEADROOM_BYTES,
  retentionHeadroomEntries: APPLY_RETENTION_FUTURE_HEADROOM_ENTRIES
});

export interface ApplyStoreAccountingHead {
  readonly schemaVersion: typeof ACCOUNTING_SCHEMA;
  readonly profileId: string;
  readonly baselineBytes: number;
  readonly baselineEntries: number;
  readonly activeReservation: {
    /** Missing only on the pre-provenance provisional-5 standard shape. */
    readonly kind?: "standard" | "legacy_recovery";
    readonly transactionId: string;
    readonly bytes: number;
    readonly entries: number;
  } | null;
  readonly lastSettledTransactionId: string | null;
  readonly settledMarkerCredit: {
    readonly transactionId: string;
    readonly bytes: number;
    readonly entries: 1;
  } | null;
  readonly maintenanceId: string | null;
  readonly maintenanceReservationBytes: number;
  readonly maintenanceReservationEntries: number;
  readonly maintenanceSourceHeadRevision: Sha256Digest | null;
  readonly updatedAt: string;
  readonly revision: Sha256Digest;
}

export interface LegacyApplyStoreAccountingHead {
  readonly schemaVersion: typeof LEGACY_ACCOUNTING_SCHEMA;
  readonly profileId: string;
  readonly baselineBytes: number;
  readonly activeReservation: {
    readonly transactionId: string;
    readonly bytes: number;
  } | null;
  readonly lastSettledTransactionId: string | null;
  readonly settledMarkerCredit: {
    readonly transactionId: string;
    readonly bytes: number;
  } | null;
  readonly maintenanceId: string | null;
  readonly maintenanceReservationBytes: number;
  readonly maintenanceSourceHeadRevision: Sha256Digest | null;
  readonly updatedAt: string;
  readonly revision: Sha256Digest;
}

export type ReadApplyStoreAccountingHead =
  | ApplyStoreAccountingHead
  | LegacyApplyStoreAccountingHead;

export async function initializeEmptyApplyStoreAccounting(
  layout: ApplyArtifactLayout,
  profileId: string,
  now = new Date()
): Promise<boolean> {
  if (await readApplyStoreAccounting(layout, profileId)) return false;
  const fresh = await assertApplyStoreFreshBootstrap(layout);
  const baselineEntries = fresh.entryCount
    + Number(!fresh.hasAccounting)
    + Number(!fresh.hasUnfinishedIndex)
    + Number(!fresh.hasReadyHead);
  const content = {
    schemaVersion: ACCOUNTING_SCHEMA,
    profileId,
    // Reserve the complete bounded accounting file itself. This intentionally
    // overstates the fresh-store baseline until the exact bootstrap rebase.
    baselineBytes: ACCOUNTING_MAX_BYTES
      + FRESH_UNFINISHED_INDEX_MAX_BYTES
      + FRESH_RECEIPT_HISTORY_HEAD_MAX_BYTES
      + FRESH_RECEIPT_HISTORY_LOCK_MAX_BYTES,
    baselineEntries,
    activeReservation: null,
    lastSettledTransactionId: null,
    settledMarkerCredit: null,
    maintenanceId: null,
    maintenanceReservationBytes: 0,
    maintenanceReservationEntries: 0,
    maintenanceSourceHeadRevision: null,
    updatedAt: canonicalTimestamp(now, "Apply store accounting initialization")
  } as const;
  const created = await createPrivateJsonExclusive(
    accountingPath(layout),
    { ...content, revision: sha256Canonical(content) }
  );
  if (created) return true;
  // Exclusive creation may report an already-present file only when another
  // cooperating bootstrap completed first. Validate that exact file instead
  // of replacing it and erasing ownership recorded after our empty scan.
  requiredHead(await readApplyStoreAccounting(layout, profileId));
  return false;
}

/** Owner-only crash-temp reconciliation for the fixed Apply metadata root. */
export async function reconcileApplyStoreAdmissionTemporaries(
  layout: ApplyArtifactLayout,
  historyControl: ApplyReceiptHistoryControl
): Promise<void> {
  await assertHistoryControlMatchesLayout(layout, historyControl);
  const historyPath = privatePath(layout.receiptHistory, "history.lock");
  await reconcileFixedParentStandaloneTemporaries(
    layout.root,
    APPLY_ROOT_FIXED_SCAN_MAX_ENTRIES,
    APPLY_ROOT_STANDALONE_TEMP_MAX_BYTES,
    "Apply root",
    historyControl,
    historyPath
  );
  await assertApplyReceiptHistoryControlHeld(historyControl, historyPath);
}

export async function reconcileApplyStoreFreshBootstrapTemporaries(
  layout: ApplyArtifactLayout,
  historyControl: ApplyReceiptHistoryControl
): Promise<void> {
  await assertHistoryControlMatchesLayout(layout, historyControl);
  const historyPath = privatePath(layout.receiptHistory, "history.lock");
  await reconcileFixedParentStandaloneTemporaries(
    layout.root,
    APPLY_ROOT_FIXED_SCAN_MAX_ENTRIES,
    APPLY_ROOT_STANDALONE_TEMP_MAX_BYTES,
    "Apply root",
    historyControl,
    historyPath
  );
  await reconcileFixedParentStandaloneTemporaries(
    layout.unfinished,
    FRESH_CHILD_FIXED_SCAN_MAX_ENTRIES,
    FRESH_UNFINISHED_STANDALONE_TEMP_MAX_BYTES,
    "Apply unfinished root",
    historyControl,
    historyPath
  );
  await reconcileFixedParentStandaloneTemporaries(
    layout.receiptHistory,
    FRESH_CHILD_FIXED_SCAN_MAX_ENTRIES,
    FRESH_RECEIPT_HISTORY_STANDALONE_TEMP_MAX_BYTES,
    "Apply Receipt-history root",
    historyControl,
    historyPath
  );
  await assertApplyReceiptHistoryControlHeld(historyControl, historyPath);
}

/**
 * Read-only certification of the only store shape that may be initialized
 * without an explicit, receipt-backed maintenance operation. The
 * receipt-history kernel lock is durable and the unfinished index may have
 * been published by an earlier bootstrap attempt; transaction content and
 * interrupted publication temps are rejected, never silently removed.
 */
export async function assertApplyStoreFreshBootstrap(
  layout: ApplyArtifactLayout
): Promise<{
  readonly entryCount: number;
  readonly hasAccounting: boolean;
  readonly hasUnfinishedIndex: boolean;
  readonly hasReadyHead: boolean;
}> {
  const allowedByRoot = new Map<string, ReadonlySet<string>>([
    [layout.unfinished, new Set(["index.json"])],
    [layout.receiptHistory, new Set(["history.lock", "head.json"])]
  ]);
  const roots = [...new Set([
    layout.transactions, layout.unfinished, layout.consents, layout.authorizations,
    layout.backups, layout.backupManifests, layout.preparedImages, layout.recoveries,
    layout.inverses, layout.journals, layout.controls, layout.receipts, layout.receiptHistory
  ])];
  const rootNames = new Set(roots.map((root) => basename(root)));
  let entryCount = 0;
  let hasAccounting = false;
  const rootEntries = await readdir(layout.root, { withFileTypes: true });
  if (rootEntries.length > roots.length + 1) {
    throw new Error("Existing Apply store exceeds the fresh-bootstrap root bound");
  }
  for (const entry of rootEntries) {
    const path = privatePath(layout.root, entry.name);
    const metadata = await lstat(path);
    if (rootNames.has(entry.name)) {
      if (metadata.isSymbolicLink() || !metadata.isDirectory()
        || (typeof process.getuid === "function" && metadata.uid !== process.getuid())
        || (metadata.mode & 0o077) !== 0) {
        throw new Error(`Apply fresh-bootstrap directory is unsafe: ${path}`);
      }
    } else if (entry.name === ACCOUNTING_FILENAME) {
      if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.nlink !== 1
        || (typeof process.getuid === "function" && metadata.uid !== process.getuid())
        || (metadata.mode & 0o077) !== 0
        || metadata.size > ACCOUNTING_MAX_BYTES) {
        throw new Error("Apply fresh-bootstrap accounting file is unsafe");
      }
      hasAccounting = true;
    } else {
      throw new Error(
        "Existing Apply store lacks a complete bounded ledger; automatic legacy or missing-head migration is disabled"
      );
    }
    entryCount += 1;
  }
  for (const root of roots) {
    const allowed = allowedByRoot.get(root) ?? new Set<string>();
    const directory = await opendir(root);
    let seen = 0;
    try {
      for await (const entry of directory) {
        seen += 1;
        entryCount += 1;
        const path = privatePath(root, entry.name);
        const metadata = await lstat(path);
        const maxBytes = root === layout.unfinished
          ? FRESH_UNFINISHED_INDEX_MAX_BYTES
          : entry.name === "head.json"
            ? FRESH_RECEIPT_HISTORY_HEAD_MAX_BYTES
            : FRESH_RECEIPT_HISTORY_LOCK_MAX_BYTES;
        if (seen > 16 || !allowed.has(entry.name)
          || metadata.isSymbolicLink() || !metadata.isFile() || metadata.nlink !== 1
          || (typeof process.getuid === "function" && metadata.uid !== process.getuid())
          || (metadata.mode & 0o077) !== 0
          || metadata.size > maxBytes) {
          throw new Error(
            "Existing Apply store lacks a complete bounded ledger; automatic legacy or missing-head migration is disabled"
          );
        }
      }
    } finally {
      await directory.close().catch(() => undefined);
    }
  }
  return {
    entryCount,
    hasAccounting,
    hasUnfinishedIndex: await pathExists(privatePath(layout.unfinished, "index.json")),
    hasReadyHead: await pathExists(privatePath(layout.receiptHistory, "head.json"))
  };
}

/**
 * Replaces the deliberately conservative bootstrap reservation with the exact
 * durable empty-store inventory. This is permitted only while the real
 * Receipt-history owner is held and the store still has the complete bounded
 * fresh shape, so a crash after publishing the three bootstrap artifacts can
 * safely resume without granting provenance to later content.
 */
export async function rebaseFreshApplyStoreAccountingExact(
  layout: ApplyArtifactLayout,
  profileId: string,
  historyControl: ApplyReceiptHistoryControl,
  now = new Date()
): Promise<boolean> {
  await assertHistoryControlMatchesLayout(layout, historyControl);
  const historyPath = privatePath(layout.receiptHistory, "history.lock");
  await reconcileApplyStoreFreshBootstrapTemporaries(layout, historyControl);
  const fresh = await assertApplyStoreFreshBootstrap(layout);
  if (!fresh.hasAccounting || !fresh.hasUnfinishedIndex || !fresh.hasReadyHead) {
    throw new Error("Exact Apply bootstrap rebase requires all three durable bootstrap artifacts");
  }
  const head = requiredCurrentHead(await readApplyStoreAccounting(layout, profileId));
  if (head.activeReservation !== null
    || head.lastSettledTransactionId !== null
    || head.settledMarkerCredit !== null
    || head.maintenanceId !== null
    || head.maintenanceReservationBytes !== 0
    || head.maintenanceReservationEntries !== 0
    || head.maintenanceSourceHeadRevision !== null) {
    throw new Error("Exact Apply bootstrap rebase requires a pristine unowned accounting head");
  }

  let exactBytes = ACCOUNTING_MAX_BYTES;
  for (const [path, maxBytes, label] of [
    [privatePath(layout.unfinished, "index.json"), FRESH_UNFINISHED_INDEX_MAX_BYTES, "unfinished index"],
    [historyPath, FRESH_RECEIPT_HISTORY_LOCK_MAX_BYTES, "Receipt-history lock"],
    [privatePath(layout.receiptHistory, "head.json"), FRESH_RECEIPT_HISTORY_HEAD_MAX_BYTES, "Receipt-history head"]
  ] as const) {
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.nlink !== 1
      || (typeof process.getuid === "function" && metadata.uid !== process.getuid())
      || (metadata.mode & 0o077) !== 0
      || metadata.size > maxBytes) {
      throw new Error(`Exact Apply bootstrap ${label} is unsafe`);
    }
    exactBytes = checkedSum(exactBytes, metadata.size, 0, "Exact Apply bootstrap byte baseline");
  }
  if (head.baselineBytes === exactBytes && head.baselineEntries === fresh.entryCount) {
    await assertApplyReceiptHistoryControlHeld(historyControl, historyPath);
    return false;
  }
  await assertApplyReceiptHistoryControlHeld(historyControl, historyPath);
  await replaceHead(layout, profileId, {
    baselineBytes: exactBytes,
    baselineEntries: fresh.entryCount,
    activeReservation: null,
    lastSettledTransactionId: null,
    settledMarkerCredit: null,
    maintenanceId: null,
    maintenanceReservationBytes: 0,
    maintenanceReservationEntries: 0,
    maintenanceSourceHeadRevision: null,
    updatedAt: canonicalTimestamp(now, "Exact Apply store bootstrap rebase")
  });
  await assertApplyReceiptHistoryControlHeld(historyControl, historyPath);
  return true;
}

export async function initializeApplyStoreAccountingBaseline(
  layout: ApplyArtifactLayout,
  profileId: string,
  baselineBytes: number,
  baselineEntries: number,
  now = new Date()
): Promise<boolean> {
  if (!Number.isSafeInteger(baselineBytes) || baselineBytes < 0
    || !Number.isSafeInteger(baselineBytes + ACCOUNTING_MAX_BYTES)
    || !Number.isSafeInteger(baselineEntries) || baselineEntries < 0
    || baselineEntries + 1 > APPLY_STORE_MAX_ENTRIES) {
    throw new Error("Apply store accounting baseline is invalid");
  }
  if (await readApplyStoreAccounting(layout, profileId)) return false;
  await replaceHead(layout, profileId, {
    baselineBytes: baselineBytes + ACCOUNTING_MAX_BYTES,
    baselineEntries: baselineEntries + 1,
    activeReservation: null,
    lastSettledTransactionId: null,
    settledMarkerCredit: null,
    maintenanceId: null,
    maintenanceReservationBytes: 0,
    maintenanceReservationEntries: 0,
    maintenanceSourceHeadRevision: null,
    updatedAt: canonicalTimestamp(now, "Apply store accounting baseline initialization")
  });
  return true;
}

export async function rebaseLegacyApplyStoreAccountingForMaintenance(
  layout: ApplyArtifactLayout,
  profileId: string,
  exactBytes: number,
  exactEntries: number,
  now = new Date()
): Promise<boolean> {
  validateExactBaseline(exactBytes, exactEntries);
  const observed = await readApplyStoreAccounting(layout, profileId);
  if (!observed || observed.schemaVersion === ACCOUNTING_SCHEMA) return false;
  if (observed.activeReservation || observed.maintenanceId) {
    throw new Error("Legacy Apply accounting migration requires no active transaction or maintenance owner");
  }
  const baselineBytes = await reserveAccountingFileBytes(layout, exactBytes);
  await replaceHead(layout, profileId, {
    baselineBytes,
    baselineEntries: exactEntries,
    activeReservation: null,
    lastSettledTransactionId: null,
    settledMarkerCredit: null,
    maintenanceId: null,
    maintenanceReservationBytes: 0,
    maintenanceReservationEntries: 0,
    maintenanceSourceHeadRevision: null,
    updatedAt: canonicalTimestamp(now, "Apply store legacy accounting migration")
  });
  return true;
}

export async function readApplyStoreAccounting(
  layout: ApplyArtifactLayout,
  profileId: string
): Promise<ReadApplyStoreAccountingHead | null> {
  let value: unknown;
  try {
    value = await readPrivateJson(accountingPath(layout), ACCOUNTING_MAX_BYTES);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  return defineAnyHead(value, profileId);
}

export async function assertApplyStoreAdmission(
  layout: ApplyArtifactLayout,
  profileId: string,
  policy: ApplyStoreQuotaPolicy = DEFAULT_APPLY_STORE_QUOTA_POLICY
): Promise<void> {
  definePolicy(policy);
  await assertFixedParentHasNoStandaloneTemporaries(
    layout.root,
    APPLY_ROOT_FIXED_SCAN_MAX_ENTRIES,
    "Apply root"
  );
  const head = await readApplyStoreAccounting(layout, profileId);
  if (!head) throw new Error("Apply store accounting is unavailable; run zts history retain --apply --yes");
  if (head.schemaVersion === LEGACY_ACCOUNTING_SCHEMA) {
    throw new Error(
      "Apply store accounting requires reviewed v4 to v5 migration; run zts history retain --apply --yes before another Apply"
    );
  }
  if (head.maintenanceId) {
    throw new Error(`Apply store maintenance ${head.maintenanceId} is incomplete; resume with zts history retain`);
  }
  if (head.activeReservation) {
    throw new Error(`Apply Transaction ${head.activeReservation.transactionId} already owns the store reservation`);
  }
  const baseline = await effectiveBaseline(layout, head);
  if (checkedSum(
    baseline.bytes,
    policy.reservationBytes,
    policy.retentionHeadroomBytes,
    "Apply store byte admission"
  ) > policy.maxStoreBytes) {
    throw new Error(
      `Apply store cannot reserve ${formatBytes(policy.reservationBytes)} plus ${formatBytes(policy.retentionHeadroomBytes)} retention headroom under its ${formatBytes(policy.maxStoreBytes)} cap; run zts history retain --apply --yes`
    );
  }
  if (checkedSum(
    baseline.entries,
    policy.reservationEntries,
    policy.retentionHeadroomEntries,
    "Apply store entry admission"
  ) > policy.maxStoreEntries) {
    throw new Error(
      `Apply store cannot reserve ${policy.reservationEntries} entries plus ${policy.retentionHeadroomEntries} retention entries under its ${policy.maxStoreEntries}-entry cap; run zts history retain --apply --yes`
    );
  }
  const fs = await statfs(layout.root, { bigint: true });
  if (fs.bavail < 0n || fs.bsize <= 0n) throw new Error("Filesystem free-space accounting is invalid");
  const free = fs.bavail * fs.bsize;
  if (free < BigInt(policy.reservationBytes)
    + BigInt(policy.retentionHeadroomBytes)
    + BigInt(policy.minimumFreeBytes)) {
    throw new Error(
      `Apply store cannot reserve ${formatBytes(policy.reservationBytes)} plus ${formatBytes(policy.retentionHeadroomBytes)} retention headroom while preserving ${formatBytes(policy.minimumFreeBytes)} free`
    );
  }
}

export async function reserveApplyStoreForTransaction(
  layout: ApplyArtifactLayout,
  profileId: string,
  transactionId: string,
  policy: ApplyStoreQuotaPolicy = DEFAULT_APPLY_STORE_QUOTA_POLICY,
  now = new Date()
): Promise<void> {
  definePolicy(policy);
  await assertFixedParentHasNoStandaloneTemporaries(
    layout.root,
    APPLY_ROOT_FIXED_SCAN_MAX_ENTRIES,
    "Apply root"
  );
  const head = requiredCurrentHead(await readApplyStoreAccounting(layout, profileId));
  if (head.maintenanceId) throw new Error(`Apply store maintenance ${head.maintenanceId} blocks reservation`);
  if (head.activeReservation) {
    if (head.activeReservation.transactionId === transactionId
      && head.activeReservation.bytes === policy.reservationBytes
      && head.activeReservation.entries === policy.reservationEntries) return;
    throw new Error(`Apply store reservation belongs to ${head.activeReservation.transactionId}`);
  }
  if (head.lastSettledTransactionId === transactionId) return;
  const baseline = await effectiveBaseline(layout, head);
  if (checkedSum(
    baseline.bytes,
    policy.reservationBytes,
    policy.retentionHeadroomBytes,
    "Apply store byte reservation"
  ) > policy.maxStoreBytes) {
    throw new Error("Apply store cap changed before transaction reservation");
  }
  if (checkedSum(
    baseline.entries,
    policy.reservationEntries,
    policy.retentionHeadroomEntries,
    "Apply store entry reservation"
  ) > policy.maxStoreEntries) {
    throw new Error("Apply store entry cap changed before transaction reservation");
  }
  const fs = await statfs(layout.root, { bigint: true });
  if (fs.bavail < 0n || fs.bsize <= 0n) throw new Error("Filesystem free-space accounting is invalid");
  if (fs.bavail * fs.bsize < BigInt(policy.reservationBytes)
    + BigInt(policy.retentionHeadroomBytes)
    + BigInt(policy.minimumFreeBytes)) {
    throw new Error("Apply store free space changed before transaction reservation");
  }
  await replaceHead(layout, profileId, {
    baselineBytes: baseline.bytes,
    baselineEntries: baseline.entries,
    activeReservation: {
      kind: "standard",
      transactionId,
      bytes: policy.reservationBytes,
      entries: policy.reservationEntries
    },
    lastSettledTransactionId: head.lastSettledTransactionId,
    settledMarkerCredit: null,
    maintenanceId: null,
    maintenanceReservationBytes: 0,
    maintenanceReservationEntries: 0,
    maintenanceSourceHeadRevision: null,
    updatedAt: canonicalTimestamp(now, "Apply store reservation")
  });
}

export interface ApplyRecoveryReservationResult {
  readonly expanded: boolean;
  readonly reservationKind: "standard" | "legacy_recovery" | "settled";
  readonly reservationBytes: number;
  readonly reservationEntries: number;
}

/**
 * Expands an unfinished transaction's historical reservation before recovery
 * publishes any current-format artifact. The Receipt-history capability is a
 * non-forgeable store owner; inventory is measured read-only after exact
 * fixed-root crash-temp reconciliation, and the v5 head is the first growth.
 */
export async function ensureApplyStoreRecoveryReservation(
  layout: ApplyArtifactLayout,
  profileId: string,
  transactionId: string,
  historyControl: ApplyReceiptHistoryControl,
  policy: ApplyRecoveryReservationPolicy = DEFAULT_APPLY_RECOVERY_RESERVATION_POLICY,
  now = new Date()
): Promise<ApplyRecoveryReservationResult> {
  defineRecoveryReservationPolicy(policy);
  if (!/^apply:[0-9a-f-]{36}$/u.test(transactionId)) {
    throw new Error("Apply recovery reservation transaction id is invalid");
  }
  await reconcileApplyStoreAdmissionTemporaries(layout, historyControl);
  const historyPath = privatePath(layout.receiptHistory, "history.lock");
  const head = requiredHead(await readApplyStoreAccounting(layout, profileId));
  if (head.maintenanceId) {
    throw new Error(`Apply store maintenance ${head.maintenanceId} blocks recovery reservation`);
  }
  const settledOwns = head.activeReservation === null
    && head.lastSettledTransactionId === transactionId
    && head.settledMarkerCredit?.transactionId === transactionId;
  if (!settledOwns && head.activeReservation?.transactionId !== transactionId) {
    throw new Error(`Apply recovery reservation does not own ${transactionId}`);
  }
  await assertApplyReceiptHistoryControlHeld(historyControl, historyPath);
  const exact = await reconcileAndMeasureApplyStoreForRecoveryReservation(
    layout,
    transactionId,
    APPLY_RETENTION_MAX_INVENTORY_ENTRIES,
    historyControl,
    historyPath
  );
  await assertApplyReceiptHistoryControlHeld(historyControl, historyPath);
  if (settledOwns) {
    const transient = await recoveryTransientContribution(layout, transactionId);
    const exactWithoutClaimBytes = exact.exactStoreBytes - transient.claimBytes;
    const exactWithoutClaimEntries = exact.exactStoreEntries - transient.claimEntries;
    const recordedSettledEntries = head.schemaVersion === ACCOUNTING_SCHEMA
      ? head.baselineEntries
      : null;
    const matchesRecordedBaseline = exactWithoutClaimBytes === head.baselineBytes
      && (recordedSettledEntries === null || exactWithoutClaimEntries === recordedSettledEntries);
    const matchesOneNewControl = transient.controlEntries === 1
      && exactWithoutClaimBytes === head.baselineBytes + transient.controlBytes
      && (recordedSettledEntries === null
        || exactWithoutClaimEntries === recordedSettledEntries + 1);
    if (!matchesRecordedBaseline && !matchesOneNewControl) {
      throw new Error("Settled Apply recovery store exceeds its exact credited baseline");
    }
    const settledEntries = recordedSettledEntries === null
      ? exactWithoutClaimEntries
      : recordedSettledEntries + Number(matchesOneNewControl);
    await preflightApplyRecoveryCapacity(
      layout,
      exact.exactStoreBytes,
      checkedSum(
        head.baselineBytes,
        APPLY_TRANSACTION_ARTIFACT_CAP_BYTES.recoveryClaim
          + APPLY_TRANSACTION_ARTIFACT_CAP_BYTES.recoveryKernelControl
          + APPLY_TRANSACTION_ARTIFACT_CAP_BYTES.largestConcurrentPublicationTemporary,
        APPLY_RETENTION_FUTURE_HEADROOM_BYTES,
        "Settled Apply recovery replay byte peak"
      ),
      checkedSum(
        settledEntries,
        3,
        APPLY_RETENTION_FUTURE_HEADROOM_ENTRIES,
        "Settled Apply recovery replay entry peak"
      ),
      policy
    );
    if (matchesOneNewControl || recordedSettledEntries === null) {
      await assertApplyReceiptHistoryControlHeld(historyControl, historyPath);
      await replaceHead(layout, profileId, {
        baselineBytes: exactWithoutClaimBytes,
        baselineEntries: settledEntries,
        activeReservation: null,
        lastSettledTransactionId: transactionId,
        settledMarkerCredit: {
          transactionId,
          bytes: head.settledMarkerCredit!.bytes,
          entries: 1
        },
        maintenanceId: null,
        maintenanceReservationBytes: 0,
        maintenanceReservationEntries: 0,
        maintenanceSourceHeadRevision: null,
        updatedAt: canonicalTimestamp(now, "Settled Apply recovery control accounting")
      });
      await assertApplyReceiptHistoryControlHeld(historyControl, historyPath);
    }
    return {
      expanded: false,
      reservationKind: "settled",
      reservationBytes: 0,
      reservationEntries: 0
    };
  }
  const activeReservationBytes = head.activeReservation!.bytes;
  const oldByteCeiling = checkedSum(
    head.baselineBytes,
    activeReservationBytes,
    0,
    "Historical Apply recovery byte reservation"
  );
  if (exact.exactStoreBytes > oldByteCeiling) {
    throw new Error("Apply recovery store already exceeds its historical owned byte reservation");
  }
  if (head.schemaVersion === ACCOUNTING_SCHEMA) {
    const currentActive = head.activeReservation!;
    if ((currentActive.kind ?? "standard") === "standard"
      && (exact.exactStoreBytes < head.baselineBytes
        || exact.exactStoreEntries < head.baselineEntries)) {
      throw new Error("Standard Apply recovery inventory is below its exact recorded baseline");
    }
    if (exact.exactStoreEntries > checkedSum(
        head.baselineEntries,
        currentActive.entries,
        0,
        "Historical Apply recovery entry reservation"
      )) {
      throw new Error("Apply recovery store already exceeds its historical owned entry reservation");
    }
    if (currentActive.bytes >= policy.reservationBytes
      && currentActive.entries >= policy.reservationEntries) {
      await preflightApplyRecoveryCapacity(
        layout,
        exact.exactStoreBytes,
        checkedSum(
          head.baselineBytes,
          currentActive.bytes,
          APPLY_RETENTION_FUTURE_HEADROOM_BYTES,
          "Existing Apply recovery byte peak"
        ),
        checkedSum(
          head.baselineEntries,
          currentActive.entries,
          APPLY_RETENTION_FUTURE_HEADROOM_ENTRIES,
          "Existing Apply recovery entry peak"
        ),
        policy
      );
      return {
        expanded: false,
        reservationKind: currentActive.kind ?? "standard",
        reservationBytes: currentActive.bytes,
        reservationEntries: currentActive.entries
      };
    }
  }

  const reservationBytes = Math.max(activeReservationBytes, policy.reservationBytes);
  const baselineEntries = head.schemaVersion === LEGACY_ACCOUNTING_SCHEMA
    ? Math.max(1, exact.exactStoreEntries - policy.reservationEntries)
    : head.baselineEntries;
  // V4 has no entry baseline. Carry one full historical transaction allowance
  // and reserve one complete current allowance, so existing entries never
  // consume the future recovery slots reconstructed by this migration.
  const reservationEntries = head.schemaVersion === LEGACY_ACCOUNTING_SCHEMA
    ? checkedSum(
        policy.reservationEntries,
        policy.reservationEntries,
        0,
        "Legacy Apply recovery entry reservation"
      )
    : Math.max(head.activeReservation!.entries, policy.reservationEntries);
  const bytePeak = checkedSum(
    head.baselineBytes,
    reservationBytes,
    APPLY_RETENTION_FUTURE_HEADROOM_BYTES,
    "Expanded Apply recovery byte peak"
  );
  const entryPeak = checkedSum(
    baselineEntries,
    reservationEntries,
    APPLY_RETENTION_FUTURE_HEADROOM_ENTRIES,
    "Expanded Apply recovery entry peak"
  );
  if (exact.exactStoreBytes > head.baselineBytes + reservationBytes
    || exact.exactStoreEntries > baselineEntries + reservationEntries) {
    throw new Error("Apply recovery expansion does not dominate the measured current store");
  }
  await preflightApplyRecoveryCapacity(
    layout,
    exact.exactStoreBytes,
    bytePeak,
    entryPeak,
    policy
  );
  await assertApplyReceiptHistoryControlHeld(historyControl, historyPath);
  await replaceHead(layout, profileId, {
    baselineBytes: head.baselineBytes,
    baselineEntries,
    activeReservation: {
      kind: "legacy_recovery",
      transactionId,
      bytes: reservationBytes,
      entries: reservationEntries
    },
    lastSettledTransactionId: head.lastSettledTransactionId,
    settledMarkerCredit: null,
    maintenanceId: null,
    maintenanceReservationBytes: 0,
    maintenanceReservationEntries: 0,
    maintenanceSourceHeadRevision: null,
    updatedAt: canonicalTimestamp(now, "Apply recovery reservation expansion")
  });
  await assertApplyReceiptHistoryControlHeld(historyControl, historyPath);
  return {
    expanded: true,
    reservationKind: "legacy_recovery",
    reservationBytes,
    reservationEntries
  };
}

export async function assertApplyStorePublicationReservation(
  layout: ApplyArtifactLayout,
  profileId: string,
  transactionId: string
): Promise<void> {
  const head = requiredHead(await readApplyStoreAccounting(layout, profileId));
  if (head.maintenanceId) throw new Error(`Apply store maintenance ${head.maintenanceId} blocks Receipt publication`);
  if (head.activeReservation?.transactionId !== transactionId) {
    throw new Error(`Apply Receipt publication lacks the exact ${transactionId} store reservation`);
  }
}

export async function settleApplyStoreReservation(
  layout: ApplyArtifactLayout,
  profileId: string,
  transactionId: string,
  exactStoreBytes: number,
  exactStoreEntries: number,
  markerBytes: number,
  now = new Date()
): Promise<void> {
  const head = requiredHead(await readApplyStoreAccounting(layout, profileId));
  validateExactSettlement(
    exactStoreBytes,
    exactStoreEntries,
    settlementEntryLimit(head, transactionId)
  );
  if (exactStoreBytes < ACCOUNTING_MAX_BYTES) {
    throw new Error("Apply store exact transaction settlement omitted its reserved accounting slot");
  }
  if (!Number.isSafeInteger(markerBytes)
    || markerBytes < 1
    || markerBytes > APPLY_UNFINISHED_MARKER_MAX_BYTES) {
    throw new Error("Apply store settled marker credit is invalid");
  }
  if (head.schemaVersion === LEGACY_ACCOUNTING_SCHEMA) {
    const activeOwns = head.activeReservation?.transactionId === transactionId;
    const settledOwns = head.activeReservation === null
      && head.lastSettledTransactionId === transactionId
      && head.settledMarkerCredit?.transactionId === transactionId
      && head.settledMarkerCredit.bytes === markerBytes;
    if (!activeOwns && !settledOwns) {
      throw new Error(`Legacy Apply store reservation does not belong to ${transactionId}`);
    }
    if (activeOwns && exactStoreBytes > checkedSum(
      head.baselineBytes,
      head.activeReservation!.bytes,
      0,
      "Legacy Apply transaction settlement"
    )) {
      throw new Error("Legacy Apply transaction exact growth exceeds its owned byte reservation");
    }
    await replaceHead(layout, profileId, {
      baselineBytes: exactStoreBytes,
      baselineEntries: exactStoreEntries,
      activeReservation: null,
      lastSettledTransactionId: transactionId,
      settledMarkerCredit: { transactionId, bytes: markerBytes, entries: 1 },
      maintenanceId: null,
      maintenanceReservationBytes: 0,
      maintenanceReservationEntries: 0,
      maintenanceSourceHeadRevision: null,
      updatedAt: canonicalTimestamp(now, "Apply store legacy transaction settlement")
    });
    return;
  }
  if (!head.activeReservation) {
    if (head.lastSettledTransactionId === transactionId) {
      if (head.settledMarkerCredit?.transactionId !== transactionId
        || head.settledMarkerCredit.bytes !== markerBytes
        || head.settledMarkerCredit.entries !== 1
        || head.baselineBytes !== exactStoreBytes
        || head.baselineEntries !== exactStoreEntries) {
        throw new Error(`Apply store settled marker credit does not match ${transactionId}`);
      }
      return;
    }
    throw new Error(`Apply store has no reservation to settle for ${transactionId}`);
  }
  if (head.activeReservation.transactionId !== transactionId) {
    throw new Error(`Apply store reservation belongs to ${head.activeReservation.transactionId}`);
  }
  if ((head.activeReservation.kind ?? "standard") === "standard"
    && (exactStoreBytes < head.baselineBytes
      || exactStoreEntries < head.baselineEntries)) {
    throw new Error("Standard Apply transaction settlement is below its exact recorded baseline");
  }
  if (exactStoreBytes > checkedSum(
    head.baselineBytes,
    head.activeReservation.bytes,
    0,
    "Apply transaction byte settlement"
  )) {
    throw new Error("Apply transaction exact byte growth exceeds its owned reservation");
  }
  if (exactStoreEntries > checkedSum(
      head.baselineEntries,
      head.activeReservation.entries,
      0,
      "Apply transaction entry settlement"
    )) {
    throw new Error("Apply transaction exact entry growth exceeds its owned reservation");
  }
  await replaceHead(layout, profileId, {
    baselineBytes: exactStoreBytes,
    baselineEntries: exactStoreEntries,
    activeReservation: null,
    lastSettledTransactionId: transactionId,
    settledMarkerCredit: { transactionId, bytes: markerBytes, entries: 1 },
    maintenanceId: null,
    maintenanceReservationBytes: 0,
    maintenanceReservationEntries: 0,
    maintenanceSourceHeadRevision: null,
    updatedAt: canonicalTimestamp(now, "Apply store reservation settlement")
  });
}

export async function beginApplyStoreMaintenance(
  layout: ApplyArtifactLayout,
  profileId: string,
  maintenanceId: string,
  reservationBytes: number,
  reservationEntries: number,
  sourceHeadRevision: Sha256Digest,
  policy: Pick<ApplyStoreQuotaPolicy, "maxStoreBytes" | "maxStoreEntries" | "minimumFreeBytes"> = DEFAULT_APPLY_STORE_QUOTA_POLICY,
  now = new Date()
): Promise<void> {
  if (!/^retention:[0-9a-f-]{36}$/u.test(maintenanceId)) throw new Error("Apply maintenance owner is invalid");
  if (!/^sha256:[a-f0-9]{64}$/u.test(sourceHeadRevision)) throw new Error("Apply maintenance source head is invalid");
  if (!Number.isSafeInteger(reservationBytes) || reservationBytes < 0
    || !Number.isSafeInteger(reservationEntries) || reservationEntries < 0) {
    throw new Error("Apply maintenance reservation is invalid");
  }
  if (!Number.isSafeInteger(policy.maxStoreBytes) || policy.maxStoreBytes < 0
    || policy.maxStoreBytes > APPLY_STORE_MAX_BYTES
    || !Number.isSafeInteger(policy.maxStoreEntries) || policy.maxStoreEntries < 0
    || policy.maxStoreEntries > APPLY_RETENTION_MAX_INVENTORY_ENTRIES
    || !Number.isSafeInteger(policy.minimumFreeBytes) || policy.minimumFreeBytes < 0) {
    throw new Error("Apply maintenance quota policy is invalid");
  }
  const head = requiredCurrentHead(await readApplyStoreAccounting(layout, profileId));
  if (head.activeReservation) {
    throw new Error(`Apply Transaction ${head.activeReservation.transactionId} blocks store maintenance`);
  }
  if (head.maintenanceId) {
    if (head.maintenanceId === maintenanceId
      && head.maintenanceReservationBytes === reservationBytes
      && head.maintenanceReservationEntries === reservationEntries
      && head.maintenanceSourceHeadRevision === sourceHeadRevision) return;
    throw new Error(`Apply store maintenance is already owned by ${head.maintenanceId}`);
  }
  const baseline = await effectiveBaseline(layout, head);
  if (checkedSum(baseline.bytes, reservationBytes, 0, "Apply maintenance byte reservation") > policy.maxStoreBytes) {
    throw new Error(
      `Apply maintenance cannot reserve ${formatBytes(reservationBytes)} under its ${formatBytes(policy.maxStoreBytes)} store cap`
    );
  }
  if (checkedSum(baseline.entries, reservationEntries, 0, "Apply maintenance entry reservation") > policy.maxStoreEntries) {
    throw new Error(
      `Apply maintenance cannot reserve ${reservationEntries} entries under its ${policy.maxStoreEntries}-entry cap`
    );
  }
  const fs = await statfs(layout.root, { bigint: true });
  if (fs.bavail < 0n || fs.bsize <= 0n) throw new Error("Filesystem free-space accounting is invalid");
  if (fs.bavail * fs.bsize < BigInt(reservationBytes) + BigInt(policy.minimumFreeBytes)) {
    throw new Error(
      `Apply maintenance cannot reserve ${formatBytes(reservationBytes)} while preserving ${formatBytes(policy.minimumFreeBytes)} free`
    );
  }
  await replaceHead(layout, profileId, {
    baselineBytes: baseline.bytes,
    baselineEntries: baseline.entries,
    activeReservation: null,
    lastSettledTransactionId: head.lastSettledTransactionId,
    settledMarkerCredit: null,
    maintenanceId,
    maintenanceReservationBytes: reservationBytes,
    maintenanceReservationEntries: reservationEntries,
    maintenanceSourceHeadRevision: sourceHeadRevision,
    updatedAt: canonicalTimestamp(now, "Apply store maintenance gate")
  });
}

export async function beginLegacyApplyStoreMaintenance(
  layout: ApplyArtifactLayout,
  profileId: string,
  maintenanceId: string,
  exactBytes: number,
  exactEntries: number,
  reservationBytes: number,
  reservationEntries: number,
  sourceHeadRevision: Sha256Digest,
  policy: Pick<ApplyStoreQuotaPolicy, "maxStoreBytes" | "maxStoreEntries" | "minimumFreeBytes">,
  now = new Date()
): Promise<void> {
  if (!/^retention:[0-9a-f-]{36}$/u.test(maintenanceId)
    || !/^sha256:[a-f0-9]{64}$/u.test(sourceHeadRevision)) {
    throw new Error("Legacy Apply maintenance identity is invalid");
  }
  if (!Number.isSafeInteger(exactBytes) || exactBytes < 0
    || exactBytes > APPLY_STORE_MAX_BYTES
    || !Number.isSafeInteger(exactEntries) || exactEntries < 1
    || exactEntries > APPLY_RETENTION_MAX_INVENTORY_ENTRIES
    || !Number.isSafeInteger(reservationBytes) || reservationBytes < APPLY_RETENTION_FIXED_HEADROOM_BYTES
    || !Number.isSafeInteger(reservationEntries) || reservationEntries < APPLY_RETENTION_FIXED_PEAK_ENTRIES
    || !Number.isSafeInteger(policy.maxStoreBytes) || policy.maxStoreBytes < 1
    || policy.maxStoreBytes > APPLY_STORE_MAX_BYTES
    || !Number.isSafeInteger(policy.maxStoreEntries) || policy.maxStoreEntries < 1
    || policy.maxStoreEntries > APPLY_RETENTION_MAX_INVENTORY_ENTRIES
    || !Number.isSafeInteger(policy.minimumFreeBytes) || policy.minimumFreeBytes < 0) {
    throw new Error("Legacy Apply maintenance quota or exact baseline is invalid");
  }
  const head = requiredHead(await readApplyStoreAccounting(layout, profileId));
  if (head.schemaVersion !== LEGACY_ACCOUNTING_SCHEMA) {
    throw new Error("Legacy Apply maintenance requires a strict v4 accounting head");
  }
  if (head.activeReservation || head.maintenanceId) {
    throw new Error("Legacy Apply maintenance migration requires no active transaction or maintenance owner");
  }
  const baselineBytes = await reserveAccountingFileBytes(layout, exactBytes);
  if (checkedSum(baselineBytes, reservationBytes, 0, "Legacy maintenance byte peak") > policy.maxStoreBytes
    || checkedSum(exactEntries, reservationEntries, 0, "Legacy maintenance entry peak") > policy.maxStoreEntries) {
    throw new Error("Legacy Apply maintenance target-generation peak exceeds its emergency migration cap");
  }
  const fs = await statfs(layout.root, { bigint: true });
  if (fs.bavail < 0n || fs.bsize <= 0n
    || fs.bavail * fs.bsize < BigInt(reservationBytes) + BigInt(policy.minimumFreeBytes)) {
    throw new Error("Legacy Apply maintenance lacks reserved filesystem headroom");
  }
  await replaceHead(layout, profileId, {
    baselineBytes,
    baselineEntries: exactEntries,
    activeReservation: null,
    lastSettledTransactionId: null,
    settledMarkerCredit: null,
    maintenanceId,
    maintenanceReservationBytes: reservationBytes,
    maintenanceReservationEntries: reservationEntries,
    maintenanceSourceHeadRevision: sourceHeadRevision,
    updatedAt: canonicalTimestamp(now, "Apply store legacy maintenance gate")
  });
}

export async function reconcileAndMeasureApplyStoreSettlement(
  layout: ApplyArtifactLayout,
  profileId: string,
  transactionId: string
): Promise<{
  readonly exactStoreBytes: number;
  readonly exactStoreEntries: number;
  readonly markerBytes: number;
}> {
  if (!/^apply:[0-9a-f-]{36}$/u.test(transactionId)) throw new Error("Apply settlement transaction id is invalid");
  const head = requiredHead(await readApplyStoreAccounting(layout, profileId));
  const maxEntries = settlementEntryLimit(head, transactionId);
  for (let pass = 0; pass < 3; pass += 1) {
    const result = await measureSettlementPass(layout, transactionId, maxEntries);
    if (!result.reconciledPublication) return result;
  }
  throw new Error("Apply settlement publication residue did not converge");
}

async function measureSettlementPass(
  layout: ApplyArtifactLayout,
  transactionId: string,
  maxEntries: number
): Promise<{
  readonly exactStoreBytes: number;
  readonly exactStoreEntries: number;
  readonly markerBytes: number;
  readonly reconciledPublication: boolean;
}> {
  const markerFilename = `${safeArtifactSegment(transactionId)}.json`;
  const headPath = accountingPath(layout);
  let bytes = 0;
  let markerBytes = 0;
  let scannedEntries = 0;
  let exactStoreEntries = 0;
  let reconciledPublication = false;
  const visit = async (directory: string, depth: number): Promise<void> => {
    if (depth > 64) throw new Error("Apply settlement inventory exceeds its depth bound");
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      scannedEntries += 1;
      if (scannedEntries > maxEntries) throw new Error(`Apply settlement inventory exceeds ${maxEntries} entries`);
      const path = privatePath(directory, entry.name);
      let metadata;
      try {
        metadata = await lstat(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT"
          && /^\.tmp-[0-9a-f-]+\.(?:artifact|json)$/iu.test(basename(path))) continue;
        throw error;
      }
      exactStoreEntries += 1;
      if (metadata.isSymbolicLink() || (!metadata.isDirectory() && !metadata.isFile())) {
        throw new Error(`Apply settlement inventory contains an unsafe entry: ${path}`);
      }
      if (typeof process.getuid === "function" && metadata.uid !== process.getuid()) {
        throw new Error(`Apply settlement inventory entry has another owner: ${path}`);
      }
      if ((metadata.mode & 0o077) !== 0 || (metadata.isFile() && ![1, 2].includes(metadata.nlink))) {
        throw new Error(`Apply settlement inventory entry is not one owner-private path: ${path}`);
      }
      if (metadata.isDirectory()) {
        await visit(path, depth + 1);
        continue;
      }
      if (metadata.nlink === 1 && isPrivateTemporaryBasename(entry.name)) {
        const candidate = await inspectPrivateStandaloneTemporaryCandidate(
          path,
          APPLY_TRANSACTION_ARTIFACT_CAP_BYTES.largestConcurrentPublicationTemporary
        );
        await removePrivateStandaloneTemporaryCandidate(candidate);
        reconciledPublication = true;
        continue;
      }
      if (metadata.nlink === 2) {
        if (/^\.tmp-[0-9a-f-]+\.(?:artifact|json)$/iu.test(basename(path))) continue;
        if (!await reconcilePrivatePublication(path)) {
          throw new Error(`Apply settlement could not reconcile publication residue: ${path}`);
        }
        reconciledPublication = true;
        continue;
      }
      const accounted = path === headPath ? ACCOUNTING_MAX_BYTES : metadata.size;
      bytes += accounted;
      if (!Number.isSafeInteger(bytes)) throw new Error("Apply settlement byte total exceeds safe accounting range");
      if (relative(layout.root, path) === `unfinished${sep}${markerFilename}`) markerBytes = metadata.size;
    }
  };
  await visit(layout.root, 0);
  // A committed hardlink residue is intentionally omitted from this pass:
  // reconciliation changes its link count and invalidates the observed
  // inventory. Let the outer loop remeasure before requiring the marker.
  if (markerBytes < 1 && !reconciledPublication) {
    throw new Error(`Apply settlement marker is missing for ${transactionId}`);
  }
  return { exactStoreBytes: bytes, exactStoreEntries, markerBytes, reconciledPublication };
}

async function reconcileAndMeasureApplyStoreForRecoveryReservation(
  layout: ApplyArtifactLayout,
  transactionId: string,
  maxEntries: number,
  historyControl: ApplyReceiptHistoryControl,
  historyPath: string
): Promise<{ readonly exactStoreBytes: number; readonly exactStoreEntries: number }> {
  for (let pass = 0; pass < 3; pass += 1) {
    const measured = await measureApplyStoreRecoveryReservationPass(
      layout,
      transactionId,
      maxEntries,
      historyControl,
      historyPath
    );
    if (!measured.reconciledPublication) return measured;
  }
  throw new Error("Apply recovery reservation publication residue did not converge");
}

async function measureApplyStoreRecoveryReservationPass(
  layout: ApplyArtifactLayout,
  transactionId: string,
  maxEntries: number,
  historyControl: ApplyReceiptHistoryControl,
  historyPath: string
): Promise<{
  readonly exactStoreBytes: number;
  readonly exactStoreEntries: number;
  readonly reconciledPublication: boolean;
}> {
  const markerPath = privatePath(
    layout.unfinished,
    `${safeArtifactSegment(transactionId)}.json`
  );
  const headPath = accountingPath(layout);
  let exactStoreBytes = 0;
  let exactStoreEntries = 0;
  let markerPresent = false;
  let reconciledPublication = false;
  const visit = async (directory: string, depth: number): Promise<void> => {
    if (depth > 64) throw new Error("Apply recovery reservation inventory exceeds its depth bound");
    const handle = await opendir(directory);
    try {
      for await (const entry of handle) {
        exactStoreEntries += 1;
        if (exactStoreEntries > maxEntries) {
          throw new Error(`Apply recovery reservation inventory exceeds ${maxEntries} entries`);
        }
        const path = privatePath(directory, entry.name);
        let metadata;
        try {
          metadata = await lstat(path);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT"
            && isPrivateTemporaryBasename(entry.name)) continue;
          throw error;
        }
        if (metadata.isSymbolicLink() || (!metadata.isDirectory() && !metadata.isFile())) {
          throw new Error(`Apply recovery reservation inventory contains an unsafe entry: ${path}`);
        }
        if (typeof process.getuid === "function" && metadata.uid !== process.getuid()) {
          throw new Error(`Apply recovery reservation inventory entry has another owner: ${path}`);
        }
        if ((metadata.mode & 0o077) !== 0
          || (metadata.isFile() && ![1, 2].includes(metadata.nlink))) {
          throw new Error(`Apply recovery reservation inventory entry is not one owner-private path: ${path}`);
        }
        if (metadata.isDirectory()) {
          await visit(path, depth + 1);
          continue;
        }
        if (metadata.nlink === 1 && isPrivateTemporaryBasename(entry.name)) {
          await assertApplyReceiptHistoryControlHeld(historyControl, historyPath);
          const candidate = await inspectPrivateStandaloneTemporaryCandidate(
            path,
            APPLY_TRANSACTION_ARTIFACT_CAP_BYTES.largestConcurrentPublicationTemporary
          );
          await assertApplyReceiptHistoryControlHeld(historyControl, historyPath);
          await removePrivateStandaloneTemporaryCandidate(candidate);
          await assertApplyReceiptHistoryControlHeld(historyControl, historyPath);
          reconciledPublication = true;
          continue;
        }
        if (metadata.nlink === 2) {
          if (isPrivateTemporaryBasename(entry.name)) continue;
          await assertApplyReceiptHistoryControlHeld(historyControl, historyPath);
          if (!await reconcilePrivatePublication(path)) {
            throw new Error(`Apply recovery reservation could not reconcile publication residue: ${path}`);
          }
          await assertApplyReceiptHistoryControlHeld(historyControl, historyPath);
          reconciledPublication = true;
          continue;
        }
        exactStoreBytes += path === headPath ? ACCOUNTING_MAX_BYTES : metadata.size;
        if (!Number.isSafeInteger(exactStoreBytes)) {
          throw new Error("Apply recovery reservation byte total exceeds safe accounting range");
        }
        if (path === markerPath) markerPresent = true;
      }
    } finally {
      await handle.close().catch(() => undefined);
    }
  };
  await visit(layout.root, 0);
  if (!markerPresent && !reconciledPublication) {
    throw new Error(`Apply recovery reservation marker is missing for ${transactionId}`);
  }
  return { exactStoreBytes, exactStoreEntries, reconciledPublication };
}

async function effectiveBaseline(
  layout: ApplyArtifactLayout,
  head: ApplyStoreAccountingHead
): Promise<{ readonly bytes: number; readonly entries: number }> {
  const credit = head.settledMarkerCredit;
  if (!credit) return { bytes: head.baselineBytes, entries: head.baselineEntries };
  if (head.baselineBytes < credit.bytes || head.baselineEntries < credit.entries) {
    throw new Error("Apply store marker credit exceeds its baseline");
  }
  const path = privatePath(layout.unfinished, `${safeArtifactSegment(credit.transactionId)}.json`);
  try {
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.nlink !== 1
      || (typeof process.getuid === "function" && metadata.uid !== process.getuid())
      || (metadata.mode & 0o077) !== 0
      || metadata.size !== credit.bytes) {
      throw new Error("Apply store settled marker credit no longer matches its marker");
    }
    return { bytes: head.baselineBytes, entries: head.baselineEntries };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return {
      bytes: head.baselineBytes - credit.bytes,
      entries: head.baselineEntries - credit.entries
    };
  }
}

export async function completeApplyStoreMaintenance(
  layout: ApplyArtifactLayout,
  profileId: string,
  maintenanceId: string,
  exactBytes: number,
  exactEntries: number,
  now = new Date()
): Promise<void> {
  validateEmergencyExactBaseline(exactBytes, exactEntries);
  const head = requiredHead(await readApplyStoreAccounting(layout, profileId));
  if (head.activeReservation) throw new Error("Cannot rebuild accounting with an active Apply reservation");
  if (head.maintenanceId !== maintenanceId) {
    throw new Error(`Apply store maintenance completion does not own ${maintenanceId}`);
  }
  if (exactBytes > checkedSum(
    head.baselineBytes,
    head.maintenanceReservationBytes,
    0,
    "Apply maintenance byte settlement"
  )) {
    throw new Error("Apply maintenance exact byte growth exceeds its owned reservation");
  }
  if (head.schemaVersion === ACCOUNTING_SCHEMA
    && exactEntries > checkedSum(
      head.baselineEntries,
      head.maintenanceReservationEntries,
      0,
      "Apply maintenance entry settlement"
    )) {
    throw new Error("Apply maintenance exact entry growth exceeds its owned reservation");
  }
  const baselineBytes = await reserveAccountingFileBytes(layout, exactBytes);
  await replaceHead(layout, profileId, {
    baselineBytes,
    baselineEntries: exactEntries,
    activeReservation: null,
    lastSettledTransactionId: null,
    settledMarkerCredit: null,
    maintenanceId: null,
    maintenanceReservationBytes: 0,
    maintenanceReservationEntries: 0,
    maintenanceSourceHeadRevision: null,
    updatedAt: canonicalTimestamp(now, "Apply store accounting rebuild")
  });
}

export async function clearOrphanApplyStoreReservation(
  layout: ApplyArtifactLayout,
  profileId: string,
  transactionId: string,
  exactBytes: number,
  exactEntries: number,
  now = new Date()
): Promise<void> {
  validateExactBaseline(exactBytes, exactEntries);
  const head = requiredHead(await readApplyStoreAccounting(layout, profileId));
  if (head.maintenanceId) throw new Error(`Apply store maintenance ${head.maintenanceId} blocks reservation cleanup`);
  if (head.activeReservation?.transactionId !== transactionId) {
    throw new Error(`Apply orphan reservation cleanup does not own ${transactionId}`);
  }
  if (exactBytes > checkedSum(
    head.baselineBytes,
    head.activeReservation.bytes,
    0,
    "Apply orphan byte settlement"
  )) {
    throw new Error("Apply orphan exact byte growth exceeds its owned reservation");
  }
  if (head.schemaVersion === ACCOUNTING_SCHEMA
    && exactEntries > checkedSum(
      head.baselineEntries,
      head.activeReservation.entries,
      0,
      "Apply orphan entry settlement"
    )) {
    throw new Error("Apply orphan exact entry growth exceeds its owned reservation");
  }
  const baselineBytes = await reserveAccountingFileBytes(layout, exactBytes);
  await replaceHead(layout, profileId, {
    baselineBytes,
    baselineEntries: exactEntries,
    activeReservation: null,
    lastSettledTransactionId: null,
    settledMarkerCredit: null,
    maintenanceId: null,
    maintenanceReservationBytes: 0,
    maintenanceReservationEntries: 0,
    maintenanceSourceHeadRevision: null,
    updatedAt: canonicalTimestamp(now, "Apply orphan reservation cleanup")
  });
}

async function replaceHead(
  layout: ApplyArtifactLayout,
  profileId: string,
  values: Omit<ApplyStoreAccountingHead, "schemaVersion" | "profileId" | "revision">
): Promise<void> {
  const content = { schemaVersion: ACCOUNTING_SCHEMA, profileId, ...values } as const;
  const head = { ...content, revision: sha256Canonical(content) } as ApplyStoreAccountingHead;
  defineHead(head, profileId);
  await replacePrivateJson(accountingPath(layout), head);
}

async function reserveAccountingFileBytes(
  layout: ApplyArtifactLayout,
  observedStoreBytes: number
): Promise<number> {
  const metadata = await lstat(accountingPath(layout));
  if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.nlink !== 1
    || (typeof process.getuid === "function" && metadata.uid !== process.getuid())
    || (metadata.mode & 0o077) !== 0
    || metadata.size > ACCOUNTING_MAX_BYTES) {
    throw new Error("Apply accounting file cannot be safely reserved during rebase");
  }
  const value = observedStoreBytes - metadata.size + ACCOUNTING_MAX_BYTES;
  if (!Number.isSafeInteger(value) || value < ACCOUNTING_MAX_BYTES) {
    throw new Error("Apply accounting rebase exceeds safe range");
  }
  return value;
}

function defineAnyHead(value: unknown, profileId: string): ReadApplyStoreAccountingHead {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Apply store accounting head must be an object");
  const schema = (value as { readonly schemaVersion?: unknown }).schemaVersion;
  if (schema === ACCOUNTING_SCHEMA) return defineHead(value, profileId);
  if (schema === LEGACY_ACCOUNTING_SCHEMA) return defineLegacyHead(value, profileId);
  throw new Error("Unsupported Apply store accounting schema");
}

function defineHead(value: unknown, profileId: string): ApplyStoreAccountingHead {
  const head = value as ApplyStoreAccountingHead;
  const keys = Object.keys(head).sort();
  const expected = [
    "schemaVersion", "profileId", "baselineBytes", "baselineEntries", "activeReservation",
    "lastSettledTransactionId", "settledMarkerCredit", "maintenanceId", "maintenanceReservationBytes",
    "maintenanceReservationEntries", "maintenanceSourceHeadRevision", "updatedAt", "revision"
  ].sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw new Error("Apply store accounting head contains unknown or missing fields");
  }
  const activeKind = head.activeReservation?.kind ?? "standard";
  if (head.schemaVersion !== ACCOUNTING_SCHEMA
    || head.profileId !== profileId
    || !Number.isSafeInteger(head.baselineBytes)
    || head.baselineBytes < 0
    || head.baselineBytes > APPLY_STORE_MAX_BYTES
    || !Number.isSafeInteger(head.baselineEntries)
    || head.baselineEntries < 1
    || head.baselineEntries > APPLY_RETENTION_MAX_INVENTORY_ENTRIES
    || (head.activeReservation !== null && (
      typeof head.activeReservation !== "object"
      || Array.isArray(head.activeReservation)
      || (!exactKeys(head.activeReservation, ["transactionId", "bytes", "entries"])
        && !exactKeys(head.activeReservation, ["kind", "transactionId", "bytes", "entries"]))
      || !Object.hasOwn(head.activeReservation, "transactionId")
      || !Object.hasOwn(head.activeReservation, "bytes")
      || !Object.hasOwn(head.activeReservation, "entries")
      || !["standard", "legacy_recovery"].includes(activeKind)
      || !/^apply:[0-9a-f-]{36}$/u.test(head.activeReservation.transactionId)
      || !Number.isSafeInteger(head.activeReservation.bytes)
      || head.activeReservation.bytes < (activeKind === "standard"
        ? LEGACY_APPLY_TRANSACTION_MIN_RESERVATION_BYTES
        : APPLY_TRANSACTION_MAX_ARTIFACT_BYTES)
      || checkedSum(
        head.baselineBytes,
        head.activeReservation.bytes,
        APPLY_RETENTION_FUTURE_HEADROOM_BYTES,
        "Apply active reservation validation"
      ) > APPLY_STORE_MAX_BYTES
      || !Number.isSafeInteger(head.activeReservation.entries)
      || head.activeReservation.entries < APPLY_TRANSACTION_RESERVATION_ENTRIES
      || checkedSum(
        head.baselineEntries,
        head.activeReservation.entries,
        APPLY_RETENTION_FUTURE_HEADROOM_ENTRIES,
        "Apply active entry reservation validation"
      ) > (activeKind === "standard"
        ? APPLY_STORE_MAX_ENTRIES
        : APPLY_RETENTION_MAX_INVENTORY_ENTRIES)
    ))
    || (head.lastSettledTransactionId !== null && !/^apply:[0-9a-f-]{36}$/u.test(head.lastSettledTransactionId))
    || (head.settledMarkerCredit !== null && (
      typeof head.settledMarkerCredit !== "object"
      || Array.isArray(head.settledMarkerCredit)
      || !exactKeys(head.settledMarkerCredit, ["transactionId", "bytes", "entries"])
      || head.settledMarkerCredit.transactionId !== head.lastSettledTransactionId
      || !/^apply:[0-9a-f-]{36}$/u.test(head.settledMarkerCredit.transactionId)
      || !Number.isSafeInteger(head.settledMarkerCredit.bytes)
      || head.settledMarkerCredit.bytes < 1
      || head.settledMarkerCredit.bytes > APPLY_UNFINISHED_MARKER_MAX_BYTES
      || head.settledMarkerCredit.entries !== 1
    ))
    || (head.settledMarkerCredit !== null
      && (head.activeReservation !== null || head.maintenanceId !== null))
    || (head.activeReservation !== null && head.maintenanceId !== null)
    || (head.maintenanceId !== null && !/^retention:[0-9a-f-]{36}$/u.test(head.maintenanceId))
    || !Number.isSafeInteger(head.maintenanceReservationBytes)
    || head.maintenanceReservationBytes < 0
    || !Number.isSafeInteger(head.maintenanceReservationEntries)
    || head.maintenanceReservationEntries < 0
    || head.maintenanceReservationEntries > APPLY_RETENTION_MAX_INVENTORY_ENTRIES
    || (head.maintenanceId === null) !== (head.maintenanceReservationBytes === 0)
    || (head.maintenanceId === null) !== (head.maintenanceReservationEntries === 0)
    || (head.maintenanceId !== null
      && (head.maintenanceReservationBytes < APPLY_RETENTION_FIXED_HEADROOM_BYTES
        || head.maintenanceReservationEntries < APPLY_RETENTION_FIXED_PEAK_ENTRIES))
    || (head.maintenanceId !== null
      && head.baselineBytes + head.maintenanceReservationBytes > APPLY_STORE_MAX_BYTES)
    || (head.maintenanceId !== null
      && head.baselineEntries + head.maintenanceReservationEntries > APPLY_RETENTION_MAX_INVENTORY_ENTRIES)
    || (head.maintenanceId === null
      ? head.maintenanceSourceHeadRevision !== null
      : !/^sha256:[a-f0-9]{64}$/u.test(head.maintenanceSourceHeadRevision ?? ""))
    || !isTimestamp(head.updatedAt)
    || !/^sha256:[a-f0-9]{64}$/u.test(head.revision)) {
    throw new Error("Apply store accounting head identity is invalid");
  }
  const { revision: _revision, ...content } = head;
  if (sha256Canonical(content) !== head.revision) throw new Error("Apply store accounting head revision is invalid");
  return head;
}

function defineLegacyHead(value: unknown, profileId: string): LegacyApplyStoreAccountingHead {
  const head = value as LegacyApplyStoreAccountingHead;
  const expected = [
    "schemaVersion", "profileId", "baselineBytes", "activeReservation",
    "lastSettledTransactionId", "settledMarkerCredit", "maintenanceId", "maintenanceReservationBytes",
    "maintenanceSourceHeadRevision", "updatedAt", "revision"
  ];
  if (!exactKeys(head, expected)
    || head.schemaVersion !== LEGACY_ACCOUNTING_SCHEMA
    || head.profileId !== profileId
    || !Number.isSafeInteger(head.baselineBytes) || head.baselineBytes < 0
    || (head.activeReservation !== null && (
      typeof head.activeReservation !== "object" || Array.isArray(head.activeReservation)
      || !exactKeys(head.activeReservation, ["transactionId", "bytes"])
      || !/^apply:[0-9a-f-]{36}$/u.test(head.activeReservation.transactionId)
      || !Number.isSafeInteger(head.activeReservation.bytes)
      || head.activeReservation.bytes < LEGACY_APPLY_TRANSACTION_MIN_RESERVATION_BYTES
    ))
    || (head.lastSettledTransactionId !== null
      && !/^apply:[0-9a-f-]{36}$/u.test(head.lastSettledTransactionId))
    || (head.settledMarkerCredit !== null && (
      typeof head.settledMarkerCredit !== "object" || Array.isArray(head.settledMarkerCredit)
      || !exactKeys(head.settledMarkerCredit, ["transactionId", "bytes"])
      || head.settledMarkerCredit.transactionId !== head.lastSettledTransactionId
      || !/^apply:[0-9a-f-]{36}$/u.test(head.settledMarkerCredit.transactionId)
      || !Number.isSafeInteger(head.settledMarkerCredit.bytes)
      || head.settledMarkerCredit.bytes < 1
      || head.settledMarkerCredit.bytes > APPLY_UNFINISHED_MARKER_MAX_BYTES
    ))
    || (head.settledMarkerCredit !== null
      && (head.activeReservation !== null || head.maintenanceId !== null))
    || (head.maintenanceId !== null && !/^retention:[0-9a-f-]{36}$/u.test(head.maintenanceId))
    || !Number.isSafeInteger(head.maintenanceReservationBytes)
    || head.maintenanceReservationBytes < 0
    || (head.maintenanceId === null) !== (head.maintenanceReservationBytes === 0)
    || (head.maintenanceId === null
      ? head.maintenanceSourceHeadRevision !== null
      : !/^sha256:[a-f0-9]{64}$/u.test(head.maintenanceSourceHeadRevision ?? ""))
    || !isTimestamp(head.updatedAt)
    || !/^sha256:[a-f0-9]{64}$/u.test(head.revision)) {
    throw new Error("Legacy Apply store accounting head identity is invalid");
  }
  const { revision: _revision, ...content } = head;
  if (sha256Canonical(content) !== head.revision) {
    throw new Error("Legacy Apply store accounting head revision is invalid");
  }
  return head;
}

function requiredHead(value: ReadApplyStoreAccountingHead | null): ReadApplyStoreAccountingHead {
  if (!value) throw new Error("Apply store accounting is unavailable; run zts history retain --apply --yes");
  return value;
}

function requiredCurrentHead(value: ReadApplyStoreAccountingHead | null): ApplyStoreAccountingHead {
  const head = requiredHead(value);
  if (head.schemaVersion === LEGACY_ACCOUNTING_SCHEMA) {
    throw new Error(
      "Apply store accounting requires reviewed v4 to v5 migration; run zts history retain --apply --yes"
    );
  }
  return head;
}

function definePolicy(policy: ApplyStoreQuotaPolicy): void {
  for (const [label, value] of Object.entries(policy)) {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Apply store quota ${label} is invalid`);
  }
  if (policy.reservationBytes < APPLY_TRANSACTION_MAX_ARTIFACT_BYTES) {
    throw new Error("Apply store reservation is smaller than the transaction artifact cap");
  }
  if (policy.maxStoreBytes > APPLY_STORE_MAX_BYTES
    || policy.maxStoreEntries > APPLY_STORE_MAX_ENTRIES
    || policy.reservationEntries < APPLY_TRANSACTION_RESERVATION_ENTRIES
    || policy.retentionHeadroomBytes < APPLY_RETENTION_FUTURE_HEADROOM_BYTES
    || policy.retentionHeadroomEntries < APPLY_RETENTION_FUTURE_HEADROOM_ENTRIES) {
    throw new Error("Apply store quota weakens the production entry or retention-headroom bound");
  }
}

function defineRecoveryReservationPolicy(policy: ApplyRecoveryReservationPolicy): void {
  for (const [label, value] of Object.entries(policy)) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(`Apply recovery reservation ${label} is invalid`);
    }
  }
  if (policy.maxStoreBytes > APPLY_STORE_MAX_BYTES
    || policy.maxStoreEntries > APPLY_RETENTION_MAX_INVENTORY_ENTRIES
    || policy.reservationBytes < APPLY_TRANSACTION_MAX_ARTIFACT_BYTES
    || policy.reservationEntries < APPLY_TRANSACTION_RESERVATION_ENTRIES) {
    throw new Error("Apply recovery reservation policy weakens a production hard bound");
  }
}

function exactKeys(value: object, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const sorted = [...expected].sort();
  return actual.length === sorted.length && actual.every((key, index) => key === sorted[index]);
}

function validateExactBaseline(bytes: number, entries: number): void {
  if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > APPLY_STORE_MAX_BYTES
    || !Number.isSafeInteger(entries) || entries < 1 || entries > APPLY_STORE_MAX_ENTRIES) {
    throw new Error("Apply store exact settlement baseline is invalid");
  }
}

function validateEmergencyExactBaseline(bytes: number, entries: number): void {
  if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > APPLY_STORE_MAX_BYTES
    || !Number.isSafeInteger(entries) || entries < 1
    || entries > APPLY_RETENTION_MAX_INVENTORY_ENTRIES) {
    throw new Error("Apply store emergency exact settlement baseline is invalid");
  }
}

function validateExactSettlement(bytes: number, entries: number, maxEntries: number): void {
  if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > APPLY_STORE_MAX_BYTES
    || !Number.isSafeInteger(entries) || entries < 1 || entries > maxEntries) {
    throw new Error("Apply store exact transaction settlement baseline is invalid");
  }
}

function settlementEntryLimit(
  head: ReadApplyStoreAccountingHead,
  transactionId: string
): number {
  if (head.schemaVersion === LEGACY_ACCOUNTING_SCHEMA) {
    if (head.activeReservation?.transactionId === transactionId
      || (head.activeReservation === null
        && head.lastSettledTransactionId === transactionId
        && head.settledMarkerCredit?.transactionId === transactionId)) {
      return APPLY_RETENTION_MAX_INVENTORY_ENTRIES;
    }
    return APPLY_STORE_MAX_ENTRIES;
  }
  if (head.activeReservation?.kind === "legacy_recovery"
    && head.activeReservation.transactionId === transactionId) {
    return APPLY_RETENTION_MAX_INVENTORY_ENTRIES;
  }
  if (head.activeReservation === null
    && head.baselineEntries > APPLY_STORE_MAX_ENTRIES
    && head.lastSettledTransactionId === transactionId
    && head.settledMarkerCredit?.transactionId === transactionId) {
    return APPLY_RETENTION_MAX_INVENTORY_ENTRIES;
  }
  return APPLY_STORE_MAX_ENTRIES;
}

function checkedSum(left: number, middle: number, right: number, label: string): number {
  const value = left + middle + right;
  if (!Number.isSafeInteger(value)) throw new Error(`${label} exceeds the safe integer range`);
  return value;
}

async function preflightApplyRecoveryCapacity(
  layout: ApplyArtifactLayout,
  exactStoreBytes: number,
  bytePeak: number,
  entryPeak: number,
  policy: ApplyRecoveryReservationPolicy
): Promise<void> {
  if (bytePeak > policy.maxStoreBytes) {
    throw new Error("Apply recovery expansion exceeds the hard store byte cap with retention headroom");
  }
  if (entryPeak > policy.maxStoreEntries) {
    throw new Error("Apply recovery expansion exceeds the emergency entry cap with retention headroom");
  }
  if (exactStoreBytes > bytePeak) {
    throw new Error("Apply recovery measured bytes exceed its preflight peak");
  }
  const fs = await statfs(layout.root, { bigint: true });
  if (fs.bavail < 0n || fs.bsize <= 0n) throw new Error("Filesystem free-space accounting is invalid");
  if (fs.bavail * fs.bsize
    < BigInt(bytePeak - exactStoreBytes) + BigInt(policy.minimumFreeBytes)) {
    throw new Error("Apply recovery expansion lacks filesystem space for its owned growth and retention headroom");
  }
}

async function recoveryTransientContribution(
  layout: ApplyArtifactLayout,
  transactionId: string
): Promise<{
  readonly claimBytes: number;
  readonly claimEntries: 0 | 1;
  readonly controlBytes: number;
  readonly controlEntries: 0 | 1;
}> {
  const root = privatePath(
    layout.transactions,
    safeArtifactSegment(transactionId)
  );
  let claimBytes = 0;
  let claimEntries: 0 | 1 = 0;
  let controlBytes = 0;
  let controlEntries: 0 | 1 = 0;
  for (const [filename, maxBytes] of [
    ["recovery-claim.json", APPLY_TRANSACTION_ARTIFACT_CAP_BYTES.recoveryClaim],
    ["recovery-control.lock", APPLY_TRANSACTION_ARTIFACT_CAP_BYTES.recoveryKernelControl]
  ] as const) {
    const path = privatePath(root, filename);
    let metadata;
    try {
      metadata = await lstat(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.nlink !== 1
      || (typeof process.getuid === "function" && metadata.uid !== process.getuid())
      || (metadata.mode & 0o077) !== 0
      || metadata.size > maxBytes) {
      throw new Error("Apply recovery transient contribution is unsafe or exceeds its named cap");
    }
    if (filename === "recovery-claim.json") {
      claimBytes = metadata.size;
      claimEntries = 1;
    } else {
      controlBytes = metadata.size;
      controlEntries = 1;
    }
  }
  return { claimBytes, claimEntries, controlBytes, controlEntries };
}

async function reconcileFixedParentStandaloneTemporaries(
  parent: string,
  maxEntries: number,
  maxTemporaryBytes: number,
  label: string,
  historyControl: ApplyReceiptHistoryControl,
  expectedHistoryPath: string
): Promise<void> {
  await assertApplyReceiptHistoryControlHeld(historyControl, expectedHistoryPath);
  const directory = await opendir(parent);
  let seen = 0;
  try {
    for await (const entry of directory) {
      seen += 1;
      if (seen > maxEntries) {
        throw new Error(`${label} exceeds its fixed-parent admission scan bound`);
      }
      if (!isPrivateTemporaryBasename(entry.name)) continue;
      await assertApplyReceiptHistoryControlHeld(historyControl, expectedHistoryPath);
      const candidate = await inspectPrivateStandaloneTemporaryCandidate(
        privatePath(parent, entry.name),
        maxTemporaryBytes
      );
      await assertApplyReceiptHistoryControlHeld(historyControl, expectedHistoryPath);
      await removePrivateStandaloneTemporaryCandidate(candidate);
      await assertApplyReceiptHistoryControlHeld(historyControl, expectedHistoryPath);
    }
  } finally {
    await directory.close().catch(() => undefined);
  }
  await assertApplyReceiptHistoryControlHeld(historyControl, expectedHistoryPath);
}

async function assertFixedParentHasNoStandaloneTemporaries(
  parent: string,
  maxEntries: number,
  label: string
): Promise<void> {
  const directory = await opendir(parent);
  let seen = 0;
  try {
    for await (const entry of directory) {
      seen += 1;
      if (seen > maxEntries) {
        throw new Error(`${label} exceeds its fixed-parent admission scan bound`);
      }
      if (isPrivateTemporaryBasename(entry.name)) {
        throw new Error(
          `${label} contains an interrupted private replacement; reconcile it under Apply Receipt-history control`
        );
      }
    }
  } finally {
    await directory.close().catch(() => undefined);
  }
}

async function assertHistoryControlMatchesLayout(
  layout: ApplyArtifactLayout,
  historyControl: ApplyReceiptHistoryControl
): Promise<void> {
  if (historyControl.path !== privatePath(layout.receiptHistory, "history.lock")) {
    throw new Error("Apply Receipt-history control belongs to another store");
  }
  await assertApplyReceiptHistoryControlHeld(
    historyControl,
    privatePath(layout.receiptHistory, "history.lock")
  );
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function accountingPath(layout: ApplyArtifactLayout): string {
  return privatePath(layout.root, ACCOUNTING_FILENAME);
}

function canonicalTimestamp(value: Date, label: string): string {
  if (!Number.isFinite(value.getTime())) throw new Error(`${label} timestamp is invalid`);
  return value.toISOString();
}

function isTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

function formatBytes(value: number): string {
  return `${Math.ceil(value / MEBIBYTE)} MiB`;
}
