import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { basename } from "node:path";
import { artifactObjectPath, artifactReference, safeArtifactSegment } from "./apply-artifacts.js";
import { sha256Canonical } from "./domain/digest.js";
import { RECEIPT_DOMAIN_LIMITS } from "./domain/change.js";
import {
  acquireApplyReceiptHistoryControl,
  assertApplyReceiptHistoryControlHeld,
  requireActiveApplyReceiptHistoryKernel
} from "./apply-receipt-history-control.js";
import {
  APPLY_RECEIPT_MAX_BYTES,
  APPLY_RECEIPT_PUBLICATION_INTENT_MAX_BYTES,
  assertApplyStorePublicationReservation,
  readApplyStoreAccounting
} from "./apply-store-accounting.js";
import { readApplyUnfinishedMarkers } from "./apply-unfinished-store.js";
import { loadStoredPlan } from "./plans.js";
import {
  assertPrivateDirectory,
  encodePrivateJsonBytes,
  privatePath,
  publishOwnedPrivateBytes,
  publishPrivateJson,
  readPrivateJson,
  replacePrivateJson
} from "./private-store.js";

import type { ApplyArtifactLayout } from "./apply-artifacts.js";
import type { Receipt } from "./domain/change.js";
import type { Sha256Digest } from "./domain/digest.js";
import type { ArtifactReference } from "./domain/snapshot.js";
import type { ApplyReceiptHistoryControl } from "./apply-receipt-history-control.js";

export type { ApplyReceiptHistoryControl } from "./apply-receipt-history-control.js";

const POINTER_SCHEMA = "zts.apply-receipt-pointer.provisional-1" as const;
const PUBLICATION_INTENT_SCHEMA = "zts.apply-receipt-publication-intent.provisional-1" as const;
const HISTORY_HEAD_SCHEMA = "zts.apply-receipt-history-head.provisional-4" as const;
const HISTORY_NODE_SCHEMA = "zts.apply-receipt-history-node.provisional-4" as const;
const HISTORY_HEAD_FILENAME = "head.json";
const HISTORY_LOCK_FILENAME = "history.lock";
const RECEIPT_MAX_BYTES = APPLY_RECEIPT_MAX_BYTES;
const RECEIPT_PUBLICATION_INTENT_MAX_BYTES = APPLY_RECEIPT_PUBLICATION_INTENT_MAX_BYTES;
const RECEIPT_POINTER_MAX_BYTES = 8 * 1024;
const HISTORY_HEAD_MAX_BYTES = 16 * 1024;
const HISTORY_NODE_MAX_BYTES = 16 * 1024;
const HISTORY_BUILD_PUBLICATION_CONCURRENCY = 16;
const JSON_MAX_ESCAPE_EXPANSION = 6;
const RECEIPT_FIXED_PROJECTION_BYTES = 512 * 1024;
const RECEIPT_OPERATION_STRUCTURE_BYTES = 4 * 1024;
const RECEIPT_ISSUE_STRUCTURE_BYTES = 2 * 1024;
const RECEIPT_INTENT_ENVELOPE_MAX_BYTES = 2 * 1024 * 1024;
const HISTORY_GENERATION_PREFIX = "historygen:";
const HISTORY_CURSOR_VERSION = "ztsrh4";
const historyGenerationBrand = Symbol("ApplyReceiptHistoryGeneration");
const activeBuiltGenerations = new WeakSet<object>();

export type InversePlanReplayability = "bound_snapshot" | "legacy_unbound" | "none";
export type FullReceiptAvailability = "available" | "archived_summary_only";

export interface ApplyReceiptPointer {
  readonly schemaVersion: typeof POINTER_SCHEMA;
  readonly transactionId: string;
  readonly receiptId: string;
  readonly receiptDigest: Sha256Digest;
}

export interface ApplyReceiptPublicationIntent {
  readonly schemaVersion: typeof PUBLICATION_INTENT_SCHEMA;
  readonly transactionId: string;
  readonly receiptId: string;
  readonly receiptDigest: Sha256Digest;
  readonly receipt: Receipt;
}

interface PreparedApplyReceiptPublication {
  readonly artifact: ArtifactReference;
  readonly receiptBytes: Buffer;
  readonly publicationIntentBytes: Buffer;
}

/** Pure exact persisted-byte preflight shared by normal Apply and recovery. */
export function preflightApplyReceiptPublication(receipt: Receipt): {
  readonly receiptBytes: number;
  readonly publicationIntentBytes: number;
} {
  const prepared = prepareApplyReceiptPublication(receipt);
  return {
    receiptBytes: prepared.receiptBytes.byteLength,
    publicationIntentBytes: prepared.publicationIntentBytes.byteLength
  };
}

/**
 * Conservative pre-mutation upper bound over every domain-bounded Receipt
 * field, including six-byte JSON escaping and pretty-print structure.
 */
export function preflightApplyReceiptCapacity(operationCount: number): {
  readonly projectedReceiptBytes: number;
  readonly projectedPublicationIntentBytes: number;
} {
  if (!Number.isSafeInteger(operationCount)
    || operationCount < 1
    || operationCount > RECEIPT_DOMAIN_LIMITS.maxOperations) {
    throw new Error(
      `Apply Receipt capacity requires 1-${RECEIPT_DOMAIN_LIMITS.maxOperations} Operations`
    );
  }
  const escapedIdentity = RECEIPT_DOMAIN_LIMITS.maxIdentityBytes * JSON_MAX_ESCAPE_EXPANSION;
  const escapedIssueCode = RECEIPT_DOMAIN_LIMITS.maxIssueCodeBytes * JSON_MAX_ESCAPE_EXPANSION;
  const perOperation = (3 * escapedIdentity)
    + (RECEIPT_DOMAIN_LIMITS.maxOperationIssueCodes * escapedIssueCode)
    + RECEIPT_OPERATION_STRUCTURE_BYTES;
  const perIssue = escapedIssueCode
    + (RECEIPT_DOMAIN_LIMITS.maxMessageBytes * JSON_MAX_ESCAPE_EXPANSION)
    + escapedIdentity
    + RECEIPT_ISSUE_STRUCTURE_BYTES;
  const projectedReceiptBytes = RECEIPT_FIXED_PROJECTION_BYTES
    + (20 * escapedIdentity)
    + (operationCount * perOperation)
    + (RECEIPT_DOMAIN_LIMITS.maxIssues * perIssue);
  const projectedPublicationIntentBytes = projectedReceiptBytes
    + RECEIPT_INTENT_ENVELOPE_MAX_BYTES;
  if (projectedReceiptBytes > RECEIPT_MAX_BYTES
    || projectedPublicationIntentBytes > RECEIPT_PUBLICATION_INTENT_MAX_BYTES) {
    throw new Error("Apply Receipt domain projection exceeds its exact persisted-byte reservation");
  }
  return { projectedReceiptBytes, projectedPublicationIntentBytes };
}

export interface ApplyReceiptPublicationHooks {
  readonly afterReceiptObject?: () => void | Promise<void>;
  /** Fault hook after the immutable node is durable but before the head swap. */
  readonly afterHistoryIntent?: () => void | Promise<void>;
  /** Fault hook after the atomic ready-head swap. */
  readonly afterHistoryHead?: () => void | Promise<void>;
  readonly inversePlanReplayability: InversePlanReplayability;
  readonly causalSourceReceiptId: string | null;
  readonly causalSourceReceiptDigest: Sha256Digest | null;
  readonly historyControl?: ApplyReceiptHistoryControl;
}

export interface ApplyReceiptSummary {
  readonly id: string;
  readonly kind: "saved_plan";
  readonly outcome: Receipt["outcome"];
  readonly planId: string;
  readonly planDigest: Sha256Digest;
  readonly causalSourceReceiptId: string | null;
  readonly causalSourceReceiptDigest: Sha256Digest | null;
  readonly profileId: string;
  readonly completedAt: string;
  readonly operationCount: number;
  readonly inversePlanReplayability: InversePlanReplayability;
  readonly receiptDigest: Sha256Digest;
  readonly fullReceiptAvailability: FullReceiptAvailability;
  readonly archivedAt: string | null;
}

export interface ApplyReceiptSummaryPage {
  readonly receipts: readonly ApplyReceiptSummary[];
  readonly nextCursor: string | null;
}

export interface ApplyReceiptHistoryHead {
  readonly schemaVersion: typeof HISTORY_HEAD_SCHEMA;
  readonly profileId: string;
  readonly generationId: string;
  readonly cursorHmacSecret: string;
  readonly entryCount: number;
  readonly latestNodeDigest: Sha256Digest | null;
  readonly latestTransactionId: string | null;
  readonly latestReceiptDigest: Sha256Digest | null;
  readonly revision: Sha256Digest;
}

interface ApplyReceiptHistoryNode {
  readonly schemaVersion: typeof HISTORY_NODE_SCHEMA;
  readonly profileId: string;
  readonly generationId: string;
  readonly sequence: number;
  readonly previousNodeDigest: Sha256Digest | null;
  readonly entry: ApplyReceiptSummary;
}

export interface ApplyReceiptHistoryGeneration {
  readonly head: ApplyReceiptHistoryHead;
  readonly nodeDigests: readonly Sha256Digest[];
  readonly [historyGenerationBrand]: true;
}

export class ApplyReceiptHistoryCorruptionError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "ApplyReceiptHistoryCorruptionError";
  }
}

export class ApplyReceiptCursorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ApplyReceiptCursorError";
  }
}

export async function withApplyReceiptHistoryMigration<T>(
  layout: ApplyArtifactLayout,
  profileId: string,
  action: (control: ApplyReceiptHistoryControl) => Promise<T>
): Promise<T> {
  return withApplyReceiptLock(layout, profileId, undefined, action);
}

export async function publishApplyReceipt(
  layout: ApplyArtifactLayout,
  transactionRoot: string,
  receipt: Receipt,
  hooks: ApplyReceiptPublicationHooks
): Promise<{
  readonly artifact: ArtifactReference;
  readonly receiptPath: string;
  readonly pointerPath: string;
  readonly historyNodePath: string;
}> {
  const transactionId = transactionIdFromReceiptId(receipt.id);
  if (basename(transactionRoot) !== safeArtifactSegment(transactionId)) {
    throw new Error("Apply Receipt transaction root does not match its Receipt id");
  }
  const prepared = prepareApplyReceiptPublication(receipt);
  const { artifact, receiptBytes, publicationIntentBytes } = prepared;
  return withApplyReceiptLock(layout, receipt.profileId, hooks.historyControl, async (historyControl) => {
  const existingNodeDigest = await authorizeReceiptPublication(
    layout,
    receipt.profileId,
    transactionId,
    artifact.digest
  );
  const receiptPath = artifactObjectPath(layout.receipts, artifact.digest);
  const pointerPath = privatePath(transactionRoot, "receipt-pointer.json");
  if (existingNodeDigest) {
    const stored = await readPrivateJson(receiptPath, RECEIPT_MAX_BYTES);
    if (sha256Canonical(stored) !== artifact.digest) throw new Error("Reachable markerless Receipt bytes are invalid");
    const pointer = await readApplyReceiptPointer(transactionRoot, receipt.id);
    if (!pointer || pointer.receiptDigest !== artifact.digest) throw new Error("Reachable markerless Receipt pointer is invalid");
    return {
      artifact,
      receiptPath,
      pointerPath,
      historyNodePath: historyNodePath(layout, existingNodeDigest)
    };
  }
  await publishOwnedPrivateBytes(
    privatePath(transactionRoot, "receipt-intent.json"),
    publicationIntentBytes,
    RECEIPT_PUBLICATION_INTENT_MAX_BYTES
  );
  await publishOwnedPrivateBytes(receiptPath, receiptBytes, RECEIPT_MAX_BYTES);
  await hooks.afterReceiptObject?.();
  const pointer: ApplyReceiptPointer = {
    schemaVersion: POINTER_SCHEMA,
    transactionId,
    receiptId: receipt.id,
    receiptDigest: artifact.digest
  };
  await publishPrivateJson(pointerPath, pointer);
  const publishedHistoryNodePath = await appendApplyReceiptHistory(
    layout,
    receipt,
    artifact.digest,
    { ...hooks, historyControl }
  );
  return { artifact, receiptPath, pointerPath, historyNodePath: publishedHistoryNodePath };
  });
}

function prepareApplyReceiptPublication(receipt: Receipt): PreparedApplyReceiptPublication {
  const transactionId = transactionIdFromReceiptId(receipt.id);
  const artifact = artifactReference(receipt.id, sha256Canonical(receipt));
  const receiptBytes = encodePrivateJsonBytes(receipt, RECEIPT_MAX_BYTES, "Apply Receipt");
  const publicationIntent: ApplyReceiptPublicationIntent = {
    schemaVersion: PUBLICATION_INTENT_SCHEMA,
    transactionId,
    receiptId: receipt.id,
    receiptDigest: artifact.digest,
    receipt
  };
  const publicationIntentBytes = encodePrivateJsonBytes(
    publicationIntent,
    RECEIPT_PUBLICATION_INTENT_MAX_BYTES,
    "Apply Receipt publication intent"
  );
  return { artifact, receiptBytes, publicationIntentBytes };
}

/** Compatibility initializer. v3 has only ready heads; no building head is ever published. */
export async function beginApplyReceiptHistoryMigration(
  layout: ApplyArtifactLayout,
  profileId: string,
  control?: ApplyReceiptHistoryControl
): Promise<"ready"> {
  return withApplyReceiptLock(layout, profileId, control, async (activeControl) => {
    const existing = await readApplyReceiptHistoryHead(layout, profileId);
    if (!existing) await replaceHistoryHead(layout, createHead(profileId, null, 0), activeControl);
    return "ready" as const;
  });
}

export async function completeApplyReceiptHistoryMigration(
  layout: ApplyArtifactLayout,
  profileId: string,
  control?: ApplyReceiptHistoryControl
): Promise<void> {
  await beginApplyReceiptHistoryMigration(layout, profileId, control);
}

export async function readApplyReceiptSummaryPage(
  layout: ApplyArtifactLayout,
  profileId: string,
  options: {
    readonly limit: number;
    readonly cursor?: string;
    readonly historyControl?: ApplyReceiptHistoryControl;
    readonly repairCorruption?: boolean;
  }
): Promise<ApplyReceiptSummaryPage | null> {
  if (!Number.isSafeInteger(options.limit) || options.limit < 1 || options.limit > 500) {
    throw new Error("Apply Receipt history limit must be between 1 and 500");
  }
  void options.historyControl;
  void options.repairCorruption;
  try {
    const head = await readApplyReceiptHistoryHead(layout, profileId);
    if (!head) return null;
    if (head.entryCount === 0) {
      if (options.cursor) throw new ApplyReceiptCursorError("Apply Receipt history cursor cannot resume an empty history");
      return { receipts: [], nextCursor: null };
    }
    const start = options.cursor
      ? defineCursor(options.cursor, head)
      : { sequence: head.entryCount, nodeDigest: head.latestNodeDigest! };
    if (start.sequence > head.entryCount) throw new ApplyReceiptCursorError("Apply Receipt history cursor is ahead of current history");
    const receipts: ApplyReceiptSummary[] = [];
    let sequence = start.sequence;
    let digest: Sha256Digest | null = start.nodeDigest;
    while (digest && receipts.length < options.limit) {
      const node = await readHistoryNode(layout, profileId, head.generationId, digest);
      if (node.sequence !== sequence) throw new ApplyReceiptHistoryCorruptionError("Apply Receipt node sequence is invalid");
      if (sequence === head.entryCount
        && (transactionIdFromReceiptId(node.entry.id) !== head.latestTransactionId
          || node.entry.receiptDigest !== head.latestReceiptDigest)) {
        throw new ApplyReceiptHistoryCorruptionError("Apply Receipt ready head latest identity is invalid");
      }
      receipts.push(node.entry);
      digest = node.previousNodeDigest;
      sequence -= 1;
    }
    if (sequence < 0 || (sequence === 0) !== (digest === null)) {
      throw new ApplyReceiptHistoryCorruptionError("Apply Receipt history boundary is invalid");
    }
    return {
      receipts,
      nextCursor: digest ? createCursor(head, sequence, digest) : null
    };
  } catch (error) {
    throw error;
  }
}

/** Builds a complete immutable generation without changing the canonical head. */
export async function buildApplyReceiptSummaryGeneration(
  layout: ApplyArtifactLayout,
  profileId: string,
  summaries: readonly ApplyReceiptSummary[],
  control: ApplyReceiptHistoryControl
): Promise<ApplyReceiptHistoryGeneration> {
  await assertApplyReceiptHistoryControlHeld(control, historyLockPath(layout));
  const normalized = normalizeOrderedSummaries(summaries, profileId);
  const generationId = `${HISTORY_GENERATION_PREFIX}${randomBytes(32).toString("hex")}`;
  const cursorHmacSecret = randomBytes(32).toString("hex");
  let previousNodeDigest: Sha256Digest | null = null;
  const nodeDigests: Sha256Digest[] = [];
  let pendingPublications: Promise<void>[] = [];
  for (let index = 0; index < normalized.length; index += 1) {
    const node: ApplyReceiptHistoryNode = {
      schemaVersion: HISTORY_NODE_SCHEMA,
      profileId,
      generationId,
      sequence: index + 1,
      previousNodeDigest,
      entry: normalized[index]!
    };
    const digest = sha256Canonical(node);
    const nodeBytes = encodePrivateJsonBytes(node, HISTORY_NODE_MAX_BYTES, "Apply Receipt history node");
    pendingPublications.push(publishOwnedPrivateBytes(
      historyNodePath(layout, digest),
      nodeBytes,
      HISTORY_NODE_MAX_BYTES
    ));
    if (pendingPublications.length === HISTORY_BUILD_PUBLICATION_CONCURRENCY) {
      await settleHistoryNodePublications(pendingPublications);
      pendingPublications = [];
    }
    nodeDigests.push(digest);
    previousNodeDigest = digest;
  }
  await settleHistoryNodePublications(pendingPublications);
  const head = createHead(
    profileId,
    previousNodeDigest,
    normalized.length,
    generationId,
    cursorHmacSecret,
    normalized.length > 0 ? transactionIdFromReceiptId(normalized.at(-1)!.id) : null,
    normalized.at(-1)?.receiptDigest ?? null
  );
  const generation: ApplyReceiptHistoryGeneration = {
    head,
    nodeDigests,
    [historyGenerationBrand]: true
  };
  activeBuiltGenerations.add(generation);
  return generation;
}

async function settleHistoryNodePublications(publications: readonly Promise<void>[]): Promise<void> {
  if (publications.length === 0) return;
  const results = await Promise.allSettled(publications);
  const failures = results
    .filter((result): result is PromiseRejectedResult => result.status === "rejected")
    .map((result) => result.reason);
  if (failures.length > 0) {
    throw new AggregateError(failures, "Apply Receipt history generation node publication failed");
  }
}

/** One exact atomic canonical-head swap, always under the kernel history control. */
export async function swapApplyReceiptHistoryHead(
  layout: ApplyArtifactLayout,
  profileId: string,
  expectedSourceRevision: Sha256Digest | null,
  target: ApplyReceiptHistoryGeneration,
  control: ApplyReceiptHistoryControl
): Promise<void> {
  if (!activeBuiltGenerations.has(target) || target[historyGenerationBrand] !== true) {
    throw new Error("Apply Receipt target generation was not built by this active store module");
  }
  const current = await readApplyReceiptHistoryHead(layout, profileId);
  if ((current?.revision ?? null) !== expectedSourceRevision) {
    throw new Error("Apply Receipt history head Drifted before its exact atomic swap");
  }
  if (target.head.profileId !== profileId) throw new Error("Apply Receipt target head belongs to a different Profile");
  await validateGenerationChain(layout, target);
  await replaceHistoryHead(layout, defineHead(target.head), control);
  activeBuiltGenerations.delete(target);
}

export async function replaceApplyReceiptSummaryHistory(
  layout: ApplyArtifactLayout,
  profileId: string,
  summaries: readonly ApplyReceiptSummary[],
  options: {
    readonly historyControl?: ApplyReceiptHistoryControl;
    readonly afterHeadAdvance?: (entryCount: number) => void | Promise<void>;
  } = {}
): Promise<ApplyReceiptHistoryGeneration> {
  return withApplyReceiptLock(layout, profileId, options.historyControl, async (control) => {
    const markers = await readApplyUnfinishedMarkers(layout, profileId, loadUnfinishedReceiptPlan);
    if (markers && markers.length > 0) {
      throw new Error("Apply Receipt history replacement is blocked by an unfinished Apply Transaction");
    }
    const accounting = await readApplyStoreAccounting(layout, profileId);
    if (accounting?.maintenanceId || accounting?.activeReservation) {
      throw new Error("Apply Receipt history replacement is blocked by active Apply store ownership");
    }
    const source = await readApplyReceiptHistoryHead(layout, profileId);
    const target = await buildApplyReceiptSummaryGeneration(layout, profileId, summaries, control);
    await options.afterHeadAdvance?.(target.head.entryCount);
    await swapApplyReceiptHistoryHead(layout, profileId, source?.revision ?? null, target, control);
    return target;
  });
}

export interface ApplyReceiptSummaryScan {
  readonly summaryCount: number;
  readonly fullReceiptCount: number;
  readonly newest: readonly ApplyReceiptSummary[];
  readonly receiptIds: readonly string[];
}

/**
 * Traverses a ready ledger in bounded pages while retaining only a fixed
 * newest window and fixed-width Receipt ids. The visitor sees one validated
 * summary at a time and may perform bounded maintenance validation.
 */
export async function scanApplyReceiptSummaries(
  layout: ApplyArtifactLayout,
  profileId: string,
  options: {
    readonly maxEntries: number;
    readonly retainNewest: number;
    readonly collectReceiptIds?: boolean;
    readonly onSummary?: (summary: ApplyReceiptSummary, newestIndex: number) => void | Promise<void>;
  }
): Promise<ApplyReceiptSummaryScan | null> {
  if (!Number.isSafeInteger(options.maxEntries) || options.maxEntries < 1) {
    throw new Error("Apply Receipt scan limit must be positive");
  }
  if (!Number.isSafeInteger(options.retainNewest)
    || options.retainNewest < 0
    || options.retainNewest > options.maxEntries) {
    throw new Error("Apply Receipt retained scan window is invalid");
  }
  const newest: ApplyReceiptSummary[] = [];
  const receiptIds: string[] = [];
  let summaryCount = 0;
  let fullReceiptCount = 0;
  let cursor: string | undefined;
  do {
    const remaining = options.maxEntries - summaryCount;
    if (remaining <= 0) throw new Error(`Apply Receipt history exceeds the ${options.maxEntries}-entry scan bound`);
    const page = await readApplyReceiptSummaryPage(layout, profileId, {
      limit: Math.min(500, remaining),
      ...(cursor ? { cursor } : {})
    });
    if (!page) return null;
    for (const summary of page.receipts) {
      const newestIndex = summaryCount;
      summaryCount += 1;
      if (newestIndex < options.retainNewest) newest.push(summary);
      if (options.collectReceiptIds !== false) receiptIds.push(summary.id);
      if (summary.fullReceiptAvailability === "available") fullReceiptCount += 1;
      await options.onSummary?.(summary, newestIndex);
    }
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  return {
    summaryCount,
    fullReceiptCount,
    newest: newest.reverse(),
    receiptIds
  };
}

export async function readApplyReceiptHistoryNodeDigests(
  layout: ApplyArtifactLayout,
  profileId: string
): Promise<readonly Sha256Digest[] | null> {
  try {
    const head = await readApplyReceiptHistoryHead(layout, profileId);
    if (!head) return null;
    const newest: Sha256Digest[] = [];
    let sequence = head.entryCount;
    let digest = head.latestNodeDigest;
    while (digest) {
      const node = await readHistoryNode(layout, profileId, head.generationId, digest);
      if (node.sequence !== sequence) throw new ApplyReceiptHistoryCorruptionError("Apply Receipt node sequence is invalid");
      newest.push(digest);
      digest = node.previousNodeDigest;
      sequence -= 1;
    }
    if (sequence !== 0 || newest.length !== head.entryCount) throw new ApplyReceiptHistoryCorruptionError("Apply Receipt chain is incomplete");
    return newest.reverse();
  } catch (error) {
    throw error;
  }
}

export async function readApplyReceiptHistoryHead(
  layout: ApplyArtifactLayout,
  profileId: string
): Promise<ApplyReceiptHistoryHead | null> {
  try {
    await assertPrivateDirectory(layout.root, "receipt-history");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw historyCorruption(error, "Apply Receipt history directory is invalid");
  }
  let value: unknown;
  try {
    value = await readPrivateJson(historyHeadPath(layout), HISTORY_HEAD_MAX_BYTES);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw historyCorruption(error, "Apply Receipt history head cannot be read");
  }
  try {
    return defineApplyReceiptHistoryHead(value as ApplyReceiptHistoryHead, profileId);
  } catch (error) {
    throw historyCorruption(error, "Apply Receipt history head is invalid");
  }
}

export function defineApplyReceiptSummary(value: ApplyReceiptSummary, profileId: string): ApplyReceiptSummary {
  return defineSummary(value, profileId);
}

export function defineApplyReceiptHistoryHead(
  value: ApplyReceiptHistoryHead,
  profileId: string
): ApplyReceiptHistoryHead {
  const head = defineHead(value);
  if (head.profileId !== profileId) throw new Error("Apply Receipt history head belongs to a different Profile");
  return head;
}

export async function findApplyReceiptSummary(
  layout: ApplyArtifactLayout,
  profileId: string,
  receiptId: string,
  maxNodes = 4_096
): Promise<ApplyReceiptSummary | null> {
  return (await findReceiptNodeInReadyHistory(layout, profileId, receiptId, maxNodes))?.summary ?? null;
}

export async function findApplyReceiptSummaryByCausalSource(
  layout: ApplyArtifactLayout,
  profileId: string,
  sourceReceiptId: string,
  maxNodes = 4_096
): Promise<ApplyReceiptSummary | null> {
  const head = await readApplyReceiptHistoryHead(layout, profileId);
  if (!head) return null;
  let digest = head.latestNodeDigest;
  let seen = 0;
  while (digest) {
    seen += 1;
    if (seen > maxNodes) throw new Error(`Apply causal Receipt lookup exceeds the ${maxNodes}-node bound`);
    const node = await readHistoryNode(layout, profileId, head.generationId, digest);
    if (node.entry.causalSourceReceiptId === sourceReceiptId && node.entry.outcome !== "blocked") {
      return node.entry;
    }
    if (node.entry.id === sourceReceiptId) return null;
    digest = node.previousNodeDigest;
  }
  return null;
}

export interface ApplyReceiptUndoLineage {
  /** The newest currently active forward Receipt, when one exists. */
  readonly activeForward: ApplyReceiptSummary | null;
  /** The requested exact source, when an exact source id was supplied and reached. */
  readonly source: ApplyReceiptSummary | null;
  /** The first effective or uncertain Receipt preventing the requested source. */
  readonly barrier: ApplyReceiptSummary | null;
  /** The successful Undo that consumed the requested source. */
  readonly causalConsumer: ApplyReceiptSummary | null;
}

/**
 * Reduces the newest-first Receipt ledger as a causal stack. A successful Undo
 * cancels exactly its bound forward Receipt; blocked and fully compensated
 * attempts do not alter the stack; uncertain outcomes stop the reduction.
 */
export async function reduceApplyReceiptUndoLineage(
  layout: ApplyArtifactLayout,
  profileId: string,
  options: {
    readonly sourceReceiptId?: string;
    readonly maxNodes?: number;
  } = {}
): Promise<ApplyReceiptUndoLineage> {
  const head = await readApplyReceiptHistoryHead(layout, profileId);
  if (!head) return { activeForward: null, source: null, barrier: null, causalConsumer: null };
  const maxNodes = options.maxNodes ?? 4_096;
  const pendingConsumers = new Map<string, ApplyReceiptSummary>();
  let digest = head.latestNodeDigest;
  let seen = 0;
  while (digest) {
    seen += 1;
    if (seen > maxNodes) throw new Error(`Apply Undo lineage reduction exceeds the ${maxNodes}-node bound`);
    const node = await readHistoryNode(layout, profileId, head.generationId, digest);
    const summary = node.entry;
    const requested = summary.id === options.sourceReceiptId;

    if (summary.outcome === "blocked" || summary.outcome === "compensated") {
      if (pendingConsumers.has(summary.id)) {
        throw new Error("Successful Undo lineage points to a Receipt without an applied changed state");
      }
      if (requested) {
        return { activeForward: null, source: summary, barrier: null, causalConsumer: null };
      }
      digest = node.previousNodeDigest;
      continue;
    }

    if (["partial", "compensation_failed", "verification_failed", "interrupted"].includes(summary.outcome)) {
      return {
        activeForward: null,
        source: requested ? summary : null,
        barrier: requested ? null : summary,
        causalConsumer: null
      };
    }

    if (summary.outcome !== "applied") {
      throw new Error(`Unsupported Apply Undo lineage outcome ${summary.outcome}`);
    }
    if (summary.causalSourceReceiptId !== null) {
      if (requested) {
        // The current contract rejects Undo-of-Undo using the source Plan. It
        // must not silently reinterpret a causal Receipt as a forward change.
        return { activeForward: null, source: summary, barrier: null, causalConsumer: null };
      }
      if (pendingConsumers.has(summary.causalSourceReceiptId)) {
        throw new Error(`Apply Undo lineage contains duplicate successful consumers for ${summary.causalSourceReceiptId}`);
      }
      if (pendingConsumers.has(summary.id)) {
        throw new Error("Apply Undo lineage contains an unsupported Undo-of-Undo pair");
      }
      pendingConsumers.set(summary.causalSourceReceiptId, summary);
      digest = node.previousNodeDigest;
      continue;
    }

    const consumer = pendingConsumers.get(summary.id) ?? null;
    if (consumer) {
      if (consumer.causalSourceReceiptDigest !== summary.receiptDigest) {
        throw new Error(`Apply Undo lineage digest does not match source Receipt ${summary.id}`);
      }
      pendingConsumers.delete(summary.id);
      if (requested) {
        return { activeForward: null, source: summary, barrier: consumer, causalConsumer: consumer };
      }
      digest = node.previousNodeDigest;
      continue;
    }

    if (requested || options.sourceReceiptId === undefined) {
      return { activeForward: summary, source: requested ? summary : null, barrier: null, causalConsumer: null };
    }
    return { activeForward: summary, source: null, barrier: summary, causalConsumer: null };
  }

  if (pendingConsumers.size > 0) {
    throw new Error("Apply Undo lineage contains a successful consumer whose source Receipt is missing");
  }
  return { activeForward: null, source: null, barrier: null, causalConsumer: null };
}

export async function findApplyReceiptSummaryBarrierAfterSource(
  layout: ApplyArtifactLayout,
  profileId: string,
  sourceReceiptId: string,
  maxNodes = 4_096
): Promise<ApplyReceiptSummary | null> {
  const head = await readApplyReceiptHistoryHead(layout, profileId);
  if (!head) return null;
  let digest = head.latestNodeDigest;
  let seen = 0;
  while (digest) {
    seen += 1;
    if (seen > maxNodes) throw new Error(`Apply supersession lookup exceeds the ${maxNodes}-node bound`);
    const node = await readHistoryNode(layout, profileId, head.generationId, digest);
    if (node.entry.id === sourceReceiptId) return null;
    if (!["blocked", "compensated"].includes(node.entry.outcome)) return node.entry;
    digest = node.previousNodeDigest;
  }
  return null;
}

export async function readApplyReceiptPublicationIntent(
  transactionRoot: string,
  expectedReceiptId: string
): Promise<ApplyReceiptPublicationIntent | null> {
  let value: unknown;
  try {
    value = await readPrivateJson(privatePath(transactionRoot, "receipt-intent.json"), RECEIPT_PUBLICATION_INTENT_MAX_BYTES);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Apply Receipt publication intent must be an object");
  assertExactKeys(value, ["schemaVersion", "transactionId", "receiptId", "receiptDigest", "receipt"], "Apply Receipt publication intent");
  const intent = value as ApplyReceiptPublicationIntent;
  if (intent.schemaVersion !== PUBLICATION_INTENT_SCHEMA
    || intent.receiptId !== expectedReceiptId
    || intent.transactionId !== transactionIdFromReceiptId(expectedReceiptId)
    || !isSha256Digest(intent.receiptDigest)
    || sha256Canonical(intent.receipt) !== intent.receiptDigest
    || intent.receipt.id !== expectedReceiptId) {
    throw new Error("Apply Receipt publication intent identity is invalid");
  }
  assertJsonSize(intent.receipt, RECEIPT_MAX_BYTES, "Apply Receipt");
  return intent;
}

export async function readApplyReceiptPointer(
  transactionRoot: string,
  expectedReceiptId: string
): Promise<ApplyReceiptPointer | null> {
  let value: unknown;
  try {
    value = await readPrivateJson(privatePath(transactionRoot, "receipt-pointer.json"), RECEIPT_POINTER_MAX_BYTES);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Apply Receipt pointer must be an object");
  assertExactKeys(value, ["schemaVersion", "transactionId", "receiptId", "receiptDigest"], "Apply Receipt pointer");
  const pointer = value as ApplyReceiptPointer;
  if (pointer.schemaVersion !== POINTER_SCHEMA
    || pointer.receiptId !== expectedReceiptId
    || pointer.transactionId !== transactionIdFromReceiptId(expectedReceiptId)
    || !isSha256Digest(pointer.receiptDigest)) {
    throw new Error("Apply Receipt pointer identity is invalid");
  }
  return pointer;
}

export function transactionIdFromReceiptId(receiptId: string): string {
  if (!/^receipt:apply:[0-9a-f-]+$/iu.test(receiptId)) throw new Error(`Invalid saved-Plan Receipt id: ${receiptId}`);
  return receiptId.slice("receipt:".length);
}

async function authorizeReceiptPublication(
  layout: ApplyArtifactLayout,
  profileId: string,
  transactionId: string,
  receiptDigest: Sha256Digest
): Promise<Sha256Digest | null> {
  const markers = await readApplyUnfinishedMarkers(layout, profileId, loadUnfinishedReceiptPlan);
  if (markers === null) throw new Error("Apply Receipt publication requires the canonical unfinished index");
  if (markers.length === 0) {
    const existing = await findReceiptNodeInReadyHistory(
      layout,
      profileId,
      `receipt:${transactionId}`,
      50_000
    );
    if (!existing) throw new Error("Markerless Apply Receipt publication cannot append new history");
    if (existing.summary.receiptDigest !== receiptDigest) {
      throw new Error("Markerless Apply Receipt history collides with different bytes");
    }
    return existing.nodeDigest;
  }
  if (markers.length !== 1 || markers[0]!.journal.transactionId !== transactionId) {
    throw new Error("Apply Receipt append requires the exact sole unfinished transaction marker");
  }
  const head = await readApplyReceiptHistoryHead(layout, profileId);
  if (!head) throw new Error("Apply Receipt publication requires a ready history head");
  if (head.latestTransactionId === transactionId) {
    if (head.latestReceiptDigest !== receiptDigest || !head.latestNodeDigest) {
      throw new Error("Reachable marked Apply Receipt history collides with different bytes");
    }
    const latest = await readHistoryNode(layout, profileId, head.generationId, head.latestNodeDigest);
    if (transactionIdFromReceiptId(latest.entry.id) !== transactionId
      || latest.entry.receiptDigest !== receiptDigest
      || latest.sequence !== head.entryCount) {
      throw new Error("Reachable marked Apply Receipt ready-head identity is invalid");
    }
    const accounting = await readApplyStoreAccounting(layout, profileId);
    const reservationOwnsReplay = accounting?.activeReservation?.transactionId === transactionId;
    const settledOwnsReplay = accounting?.activeReservation === null
      && accounting.lastSettledTransactionId === transactionId
      && accounting.settledMarkerCredit?.transactionId === transactionId;
    if (!reservationOwnsReplay && !settledOwnsReplay) {
      throw new Error("Reachable marked Apply Receipt lacks exact reserved or settled store ownership");
    }
    // No append or pointer repair is authorized here. The caller's existing-
    // node path validates the canonical Receipt bytes and transaction pointer,
    // then recovery may finish only the proof-bound marker cleanup.
    return head.latestNodeDigest;
  }
  await assertApplyStorePublicationReservation(layout, profileId, transactionId);
  return null;
}

async function findReceiptNodeInReadyHistory(
  layout: ApplyArtifactLayout,
  profileId: string,
  receiptId: string,
  maxNodes: number
): Promise<{ readonly summary: ApplyReceiptSummary; readonly nodeDigest: Sha256Digest } | null> {
  const head = await readApplyReceiptHistoryHead(layout, profileId);
  if (!head) return null;
  let digest = head.latestNodeDigest;
  let seen = 0;
  while (digest) {
    seen += 1;
    if (seen > maxNodes) throw new Error(`Apply Receipt lookup exceeds the ${maxNodes}-node bound`);
    const node = await readHistoryNode(layout, profileId, head.generationId, digest);
    if (node.entry.id === receiptId) return { summary: node.entry, nodeDigest: digest };
    digest = node.previousNodeDigest;
  }
  return null;
}

async function appendApplyReceiptHistory(
  layout: ApplyArtifactLayout,
  receipt: Receipt,
  receiptDigest: Sha256Digest,
  hooks: ApplyReceiptPublicationHooks
): Promise<string> {
  return withApplyReceiptLock(layout, receipt.profileId, hooks.historyControl, async (control) => {
    const head = await readApplyReceiptHistoryHead(layout, receipt.profileId);
    if (!head) throw new Error("Apply Receipt history is not initialized");
    if (head.entryCount > 0) {
      const latest = await readHistoryNode(layout, receipt.profileId, head.generationId, head.latestNodeDigest!);
      if (latest.entry.id === receipt.id) {
        if (latest.entry.receiptDigest !== receiptDigest) throw new Error("Apply Receipt history id collides with different bytes");
        return historyNodePath(layout, head.latestNodeDigest!);
      }
    }
    const summary = defineSummary({
      id: receipt.id,
      kind: "saved_plan",
      outcome: receipt.outcome,
      planId: receipt.planId,
      planDigest: receipt.planDigest,
      causalSourceReceiptId: hooks.causalSourceReceiptId,
      causalSourceReceiptDigest: hooks.causalSourceReceiptDigest,
      profileId: receipt.profileId,
      completedAt: receipt.completedAt,
      operationCount: receipt.operations.length,
      inversePlanReplayability: hooks.inversePlanReplayability,
      receiptDigest,
      fullReceiptAvailability: "available",
      archivedAt: null
    }, receipt.profileId);
    const node: ApplyReceiptHistoryNode = {
      schemaVersion: HISTORY_NODE_SCHEMA,
      profileId: receipt.profileId,
      generationId: head.generationId,
      sequence: head.entryCount + 1,
      previousNodeDigest: head.latestNodeDigest,
      entry: summary
    };
    const nodeDigest = sha256Canonical(node);
    const nodeBytes = encodePrivateJsonBytes(node, HISTORY_NODE_MAX_BYTES, "Apply Receipt history node");
    await publishOwnedPrivateBytes(
      historyNodePath(layout, nodeDigest),
      nodeBytes,
      HISTORY_NODE_MAX_BYTES
    );
    await hooks.afterHistoryIntent?.();
    const nextHead = createHead(
      receipt.profileId,
      nodeDigest,
      node.sequence,
      head.generationId,
      head.cursorHmacSecret,
      transactionIdFromReceiptId(receipt.id),
      receiptDigest
    );
    const current = await readApplyReceiptHistoryHead(layout, receipt.profileId);
    if (current?.revision !== head.revision) throw new Error("Apply Receipt history head Drifted before append");
    await replaceHistoryHead(layout, nextHead, control);
    await hooks.afterHistoryHead?.();
    return historyNodePath(layout, nodeDigest);
  });
}

async function readHistoryNode(
  layout: ApplyArtifactLayout,
  profileId: string,
  generationId: string,
  digest: Sha256Digest
): Promise<ApplyReceiptHistoryNode> {
  let value: unknown;
  try {
    value = await readPrivateJson(historyNodePath(layout, digest), HISTORY_NODE_MAX_BYTES);
  } catch (error) {
    throw historyCorruption(error, "Apply Receipt history node cannot be read");
  }
  try {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Apply Receipt history node must be an object");
    assertExactKeys(value, ["schemaVersion", "profileId", "generationId", "sequence", "previousNodeDigest", "entry"], "Apply Receipt history node");
    const node = value as ApplyReceiptHistoryNode;
    if (node.schemaVersion !== HISTORY_NODE_SCHEMA
      || node.profileId !== profileId
      || node.generationId !== generationId
      || !isHistoryGenerationId(node.generationId)
      || !Number.isSafeInteger(node.sequence)
      || node.sequence < 1
      || (node.sequence === 1 ? node.previousNodeDigest !== null : !isSha256Digest(node.previousNodeDigest))
      || sha256Canonical(node) !== digest) {
      throw new Error("Apply Receipt history node identity is invalid");
    }
    defineSummary(node.entry, profileId);
    return node;
  } catch (error) {
    throw historyCorruption(error, "Apply Receipt history node is invalid");
  }
}

async function validateGenerationChain(
  layout: ApplyArtifactLayout,
  generation: ApplyReceiptHistoryGeneration
): Promise<void> {
  const { head, nodeDigests } = generation;
  if (nodeDigests.length !== head.entryCount) throw new Error("Apply Receipt target generation count is incomplete");
  let expectedPrevious: Sha256Digest | null = null;
  for (let index = 0; index < nodeDigests.length; index += 1) {
    const digest = nodeDigests[index]!;
    const node = await readHistoryNode(layout, head.profileId, head.generationId, digest);
    if (node.sequence !== index + 1 || node.previousNodeDigest !== expectedPrevious) {
      throw new Error("Apply Receipt target generation chain is invalid");
    }
    expectedPrevious = digest;
  }
  if (expectedPrevious !== head.latestNodeDigest) throw new Error("Apply Receipt target generation head is incomplete");
  const latest = nodeDigests.length > 0
    ? await readHistoryNode(layout, head.profileId, head.generationId, nodeDigests.at(-1)!)
    : null;
  if (latest
    ? transactionIdFromReceiptId(latest.entry.id) !== head.latestTransactionId
      || latest.entry.receiptDigest !== head.latestReceiptDigest
    : head.latestTransactionId !== null || head.latestReceiptDigest !== null) {
    throw new Error("Apply Receipt target generation latest identity is invalid");
  }
}

function defineSummary(value: ApplyReceiptSummary, profileId: string): ApplyReceiptSummary {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Apply Receipt summary must be an object");
  assertExactKeys(value, [
    "id", "kind", "outcome", "planId", "planDigest", "profileId", "completedAt",
    "causalSourceReceiptId", "causalSourceReceiptDigest", "operationCount", "inversePlanReplayability", "receiptDigest",
    "fullReceiptAvailability", "archivedAt"
  ], "Apply Receipt summary");
  if (value.kind !== "saved_plan"
    || value.profileId !== profileId
    || !/^receipt:apply:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(value.id)
    || !value.planId?.trim()
    || !isSha256Digest(value.planDigest)
    || (value.causalSourceReceiptId !== null
      && !/^receipt:apply:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(value.causalSourceReceiptId))
    || ((value.causalSourceReceiptId === null) !== (value.causalSourceReceiptDigest === null))
    || (value.causalSourceReceiptDigest !== null && !isSha256Digest(value.causalSourceReceiptDigest))
    || !isReceiptOutcome(value.outcome)
    || !Number.isSafeInteger(value.operationCount)
    || value.operationCount < 1
    || !["bound_snapshot", "legacy_unbound", "none"].includes(value.inversePlanReplayability)
    || !isSha256Digest(value.receiptDigest)
    || !isCanonicalTimestamp(value.completedAt)
    || !["available", "archived_summary_only"].includes(value.fullReceiptAvailability)
    || (value.fullReceiptAvailability === "available"
      ? value.archivedAt !== null
      : !isCanonicalTimestamp(value.archivedAt))) {
    throw new Error("Apply Receipt summary identity is invalid");
  }
  if (value.outcome === "blocked" && value.inversePlanReplayability !== "none") throw new Error("Blocked Receipt cannot claim inverse replayability");
  if (["applied", "compensated"].includes(value.outcome) && value.inversePlanReplayability === "none") {
    throw new Error(`${value.outcome} Receipt requires inverse replayability`);
  }
  return value;
}

function normalizeOrderedSummaries(
  summaries: readonly ApplyReceiptSummary[],
  profileId: string
): ApplyReceiptSummary[] {
  const normalized = summaries.map((summary) => defineSummary(summary, profileId));
  const ids = new Set<string>();
  for (const summary of normalized) {
    if (ids.has(summary.id)) throw new Error(`Duplicate Apply Receipt summary id: ${summary.id}`);
    ids.add(summary.id);
  }
  return normalized;
}

async function withApplyReceiptLock<T>(
  layout: ApplyArtifactLayout,
  profileId: string,
  inherited: ApplyReceiptHistoryControl | undefined,
  action: (control: ApplyReceiptHistoryControl) => Promise<T>
): Promise<T> {
  const path = historyLockPath(layout);
  if (inherited) {
    await assertApplyReceiptHistoryControlHeld(inherited, path);
    return action(inherited);
  }
  const acquired = await acquireApplyReceiptHistoryControl(
    path,
    `Apply Receipt history for ${profileId}`
  );
  const capability = acquired.capability;
  let primaryError: unknown = null;
  try {
    return await action(capability);
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    try {
      await acquired.release();
    } catch (releaseError) {
      if (primaryError) throw new AggregateError([primaryError, releaseError], "Receipt history update and lock release failed");
      throw releaseError;
    }
  }
}

async function replaceHistoryHead(
  layout: ApplyArtifactLayout,
  head: ApplyReceiptHistoryHead,
  control: ApplyReceiptHistoryControl
): Promise<void> {
  const kernel = requireActiveApplyReceiptHistoryKernel(control, historyLockPath(layout));
  await kernel.assertHeld();
  assertJsonSize(head, HISTORY_HEAD_MAX_BYTES, "Apply Receipt history head");
  await replacePrivateJson(historyHeadPath(layout), head);
}

function createHead(
  profileId: string,
  latestNodeDigest: Sha256Digest | null,
  entryCount: number,
  generationId = `${HISTORY_GENERATION_PREFIX}${randomBytes(32).toString("hex")}`,
  cursorHmacSecret = randomBytes(32).toString("hex"),
  latestTransactionId: string | null = null,
  latestReceiptDigest: Sha256Digest | null = null
): ApplyReceiptHistoryHead {
  const content = {
    schemaVersion: HISTORY_HEAD_SCHEMA,
    profileId,
    generationId,
    cursorHmacSecret,
    entryCount,
    latestNodeDigest,
    latestTransactionId,
    latestReceiptDigest
  } as const;
  return { ...content, revision: sha256Canonical(content) };
}

function defineHead(value: ApplyReceiptHistoryHead): ApplyReceiptHistoryHead {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Apply Receipt history head must be an object");
  assertExactKeys(value, [
    "schemaVersion", "profileId", "generationId", "cursorHmacSecret",
    "entryCount", "latestNodeDigest", "latestTransactionId", "latestReceiptDigest", "revision"
  ], "Apply Receipt history head");
  if (value.schemaVersion !== HISTORY_HEAD_SCHEMA
    || !value.profileId?.trim()
    || !isHistoryGenerationId(value.generationId)
    || !/^[a-f0-9]{64}$/u.test(value.cursorHmacSecret)
    || !Number.isSafeInteger(value.entryCount)
    || value.entryCount < 0
    || (value.entryCount === 0 ? value.latestNodeDigest !== null : !isSha256Digest(value.latestNodeDigest))
    || (value.entryCount === 0
      ? value.latestTransactionId !== null || value.latestReceiptDigest !== null
      : !/^apply:[0-9a-f-]{36}$/u.test(value.latestTransactionId ?? "")
        || !isSha256Digest(value.latestReceiptDigest))
    || !isSha256Digest(value.revision)) {
    throw new Error("Apply Receipt history head identity is invalid");
  }
  const { revision: _revision, ...content } = value;
  const expected = sha256Canonical(content);
  if (expected !== value.revision) throw new Error("Apply Receipt history head revision is invalid");
  return value;
}

function createCursor(head: ApplyReceiptHistoryHead, sequence: number, digest: Sha256Digest): string {
  const payload = cursorPayload(head, sequence, digest);
  return `${payload}.${createHmac("sha256", Buffer.from(head.cursorHmacSecret, "hex")).update(payload).digest("hex")}`;
}

function defineCursor(value: string, head: ApplyReceiptHistoryHead): { sequence: number; nodeDigest: Sha256Digest } {
  if (typeof value !== "string" || value.length > 320) throw new ApplyReceiptCursorError("Apply Receipt history cursor is invalid");
  const match = /^ztsrh4\.([a-f0-9]{64})\.([a-f0-9]{64})\.([1-9][0-9]*)\.([a-f0-9]{64})\.([a-f0-9]{64})$/u.exec(value);
  if (!match) throw new ApplyReceiptCursorError("Apply Receipt history cursor is invalid");
  if (match[1] !== sha256Canonical({ profileId: head.profileId }).slice(7)) throw new ApplyReceiptCursorError("Apply Receipt cursor belongs to another Profile");
  if (match[2] !== sha256Canonical({ generationId: head.generationId }).slice(7)) throw new ApplyReceiptCursorError("Apply Receipt cursor belongs to a replaced generation");
  const sequence = Number(match[3]);
  if (!Number.isSafeInteger(sequence)) throw new ApplyReceiptCursorError("Apply Receipt cursor sequence is invalid");
  const nodeDigest = `sha256:${match[4]}` as Sha256Digest;
  const payload = cursorPayload(head, sequence, nodeDigest);
  const expected = Buffer.from(createHmac("sha256", Buffer.from(head.cursorHmacSecret, "hex")).update(payload).digest("hex"), "hex");
  const actual = Buffer.from(match[5], "hex");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new ApplyReceiptCursorError("Apply Receipt cursor authentication is invalid");
  return { sequence, nodeDigest };
}

function cursorPayload(head: ApplyReceiptHistoryHead, sequence: number, digest: Sha256Digest): string {
  if (!Number.isSafeInteger(sequence) || sequence < 1) throw new Error("Apply Receipt cursor sequence is invalid");
  return [
    HISTORY_CURSOR_VERSION,
    sha256Canonical({ profileId: head.profileId }).slice(7),
    sha256Canonical({ generationId: head.generationId }).slice(7),
    String(sequence),
    digest.slice(7)
  ].join(".");
}

function historyHeadPath(layout: ApplyArtifactLayout): string {
  return privatePath(layout.receiptHistory, HISTORY_HEAD_FILENAME);
}

function historyLockPath(layout: ApplyArtifactLayout): string {
  return privatePath(layout.receiptHistory, HISTORY_LOCK_FILENAME);
}

function historyNodePath(layout: ApplyArtifactLayout, digest: Sha256Digest): string {
  return privatePath(layout.receiptHistory, `${digest.slice(7)}.node.json`);
}

function isHistoryGenerationId(value: unknown): value is string {
  return typeof value === "string" && /^historygen:[a-f0-9]{64}$/u.test(value);
}

function historyCorruption(error: unknown, fallback: string): ApplyReceiptHistoryCorruptionError {
  return new ApplyReceiptHistoryCorruptionError(error instanceof Error ? `${fallback}: ${error.message}` : fallback, error);
}

function assertJsonSize(value: unknown, maxBytes: number, label: string): void {
  void encodePrivateJsonBytes(value, maxBytes, label);
}

function isSha256Digest(value: unknown): value is Sha256Digest {
  return typeof value === "string" && /^sha256:[a-f0-9]{64}$/u.test(value);
}

function isReceiptOutcome(value: unknown): value is Receipt["outcome"] {
  return typeof value === "string" && [
    "applied", "blocked", "partial", "interrupted", "verification_failed",
    "compensated", "compensation_failed"
  ].includes(value);
}

function isCanonicalTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

async function loadUnfinishedReceiptPlan(profileId: string, planDigest: string) {
  return (await loadStoredPlan(profileId, planDigest)).plan;
}

function assertExactKeys(value: object, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(`${label} contains unknown or missing fields`);
  }
}
