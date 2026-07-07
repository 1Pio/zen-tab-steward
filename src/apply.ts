import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createBackup } from "./backup.js";
import { readJsonLz4, writeJsonLz4 } from "./mozlz4.js";
import { ProfileContext } from "./profile.js";
import { RawTab, RawZenSession } from "./session.js";
import { stateDir } from "./paths.js";
import { EntityPlan, SortPlan } from "./sort.js";
import { VERSION } from "./version.js";

export interface AppliedMove {
  entityId: string;
  tabIndex: number;
  title: string;
  url: string;
  fromWorkspaceId: string;
  fromWorkspaceName: string;
  toWorkspaceId: string;
  toWorkspaceName: string;
}

export interface ApplyReceipt {
  id: string;
  createdAt: string;
  backend: "session";
  profilePath: string;
  profileId: string;
  sessionFile: string;
  backupId: string | null;
  command: string;
  ztsVersion: string;
  moveCount: number;
  skippedCount: number;
  reviewCount: number;
  blockedCount: number;
  verification: {
    ok: boolean;
    checkedMoves: number;
  };
  receiptPath: string;
  moves: AppliedMove[];
}

export interface ApplyVerificationMismatch {
  entityId: string;
  tabIndex: number;
  title: string;
  url: string;
  expectedWorkspaceId: string;
  actualWorkspaceId: string | null;
  actualEntityId: string | null;
  actualTitle: string | null;
  actualUrl: string | null;
  reason: "missing_tab" | "identity_mismatch" | "workspace_mismatch";
}

export interface ApplyVerificationResult {
  ok: boolean;
  checkedMoves: number;
  mismatchCount: number;
  mismatches: ApplyVerificationMismatch[];
  blockers: string[];
}

export interface ApplyVerificationReport {
  receiptId: string;
  profileId: string;
  profilePath: string;
  sessionFile: string;
  receiptPath: string;
  verification: ApplyVerificationResult;
  receipt: ApplyReceipt;
}

export function applyReceiptRootForProfile(profileId: string): string {
  return join(stateDir(), "applies", sanitizePathSegment(profileId));
}

export function offlineApplyBlockers(context: ProfileContext, backend: "auto" | "live" | "session"): string[] {
  const blockers: string[] = [];
  if (backend === "live") {
    blockers.push("Live backend is unavailable; run zts bridge status for the current blocker receipt");
    return blockers;
  }
  if (context.running) {
    if (backend === "auto") blockers.push("Zen is running and no live backend is available; run zts bridge status for the current blocker receipt");
    blockers.push("Offline session apply is blocked because Zen is running");
  }
  if (context.sessionFile.kind !== "zen-sessions") {
    blockers.push("Offline session apply requires zen-sessions.jsonlz4 as the selected session source");
  }
  return blockers;
}

export async function applySortPlanOffline(
  context: ProfileContext,
  session: RawZenSession,
  plan: SortPlan,
  command: string
): Promise<ApplyReceipt> {
  const blockers = offlineApplyBlockers(context, "session");
  if (blockers.length > 0) throw new Error(blockers.join("; "));

  const nextSession = structuredClone(session);
  if (!Array.isArray(nextSession.tabs)) throw new Error("Zen session has no tab array to mutate");

  const moves: AppliedMove[] = [];
  for (const action of plan.plannedActions) {
    moves.push(applyTabMove(nextSession, action));
  }

  const backup = moves.length > 0 ? await createBackup(context, command) : null;
  if (moves.length > 0) await writeJsonLz4(context.sessionFile.path, nextSession);
  const verification = moves.length > 0
    ? await verifyAppliedMoves(context.sessionFile.path, moves)
    : { ok: true, checkedMoves: 0 };

  const createdAt = new Date().toISOString();
  const id = createdAt;
  const receiptRoot = applyReceiptRootForProfile(context.profile.id);
  await mkdir(receiptRoot, { recursive: true });
  const receiptPath = join(receiptRoot, `${id}--session-apply.json`);
  const receipt: ApplyReceipt = {
    id,
    createdAt,
    backend: "session",
    profilePath: context.profile.path,
    profileId: context.profile.id,
    sessionFile: context.sessionFile.path,
    backupId: backup?.id ?? null,
    command,
    ztsVersion: VERSION,
    moveCount: moves.length,
    skippedCount: plan.skipCount,
    reviewCount: plan.reviewCount,
    blockedCount: plan.blockedCount,
    verification,
    receiptPath,
    moves
  };
  await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
  return receipt;
}

export async function listApplyReceipts(profileId: string): Promise<ApplyReceipt[]> {
  const root = applyReceiptRootForProfile(profileId);
  try {
    const entries = await readdir(root);
    const receiptFiles = entries.filter((entry) => entry.endsWith("--session-apply.json")).sort().reverse();
    const receipts: ApplyReceipt[] = [];
    for (const receiptFile of receiptFiles) {
      receipts.push(JSON.parse(await readFile(join(root, receiptFile), "utf8")) as ApplyReceipt);
    }
    return receipts;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

export async function findApplyReceipt(profileId: string, receiptId: string): Promise<ApplyReceipt | null> {
  const root = applyReceiptRootForProfile(profileId);
  try {
    return JSON.parse(await readFile(join(root, `${receiptId}--session-apply.json`), "utf8")) as ApplyReceipt;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function verifyApplyReceipt(context: ProfileContext, receiptId: string): Promise<ApplyVerificationReport> {
  const receipt = await findApplyReceipt(context.profile.id, receiptId);
  if (!receipt) throw new Error(`Apply receipt not found: ${receiptId}`);

  const blockers: string[] = [];
  if (receipt.profilePath !== context.profile.path) {
    blockers.push(`Apply receipt ${receiptId} belongs to a different profile path`);
  }
  if (receipt.sessionFile !== context.sessionFile.path) {
    blockers.push(`Apply receipt ${receiptId} was written against a different session file`);
  }

  let verification: ApplyVerificationResult;
  if (blockers.length > 0) {
    verification = {
      ok: false,
      checkedMoves: 0,
      mismatchCount: 0,
      mismatches: [],
      blockers
    };
  } else {
    verification = await verifyMovesDetailed(context.sessionFile.path, receipt.moves);
  }

  return {
    receiptId: receipt.id,
    profileId: receipt.profileId,
    profilePath: receipt.profilePath,
    sessionFile: receipt.sessionFile,
    receiptPath: receipt.receiptPath,
    verification,
    receipt
  };
}

async function verifyAppliedMoves(path: string, moves: AppliedMove[]): Promise<ApplyReceipt["verification"]> {
  const verification = await verifyMovesDetailed(path, moves);
  if (verification.blockers.length > 0) throw new Error(`Post-apply verification failed: ${verification.blockers.join("; ")}`);
  if (!verification.ok) {
    const mismatch = verification.mismatches[0];
    throw new Error(
      `Post-apply verification failed: tab ${mismatch.entityId} is in ${mismatch.actualWorkspaceId ?? "(missing)"} instead of ${mismatch.expectedWorkspaceId}`
    );
  }
  return { ok: true, checkedMoves: moves.length };
}

async function verifyMovesDetailed(path: string, moves: AppliedMove[]): Promise<ApplyVerificationResult> {
  const written = await readJsonLz4(path) as RawZenSession;
  if (!Array.isArray(written.tabs)) {
    return {
      ok: false,
      checkedMoves: 0,
      mismatchCount: 0,
      mismatches: [],
      blockers: ["Session has no tab array"]
    };
  }

  const mismatches: ApplyVerificationMismatch[] = [];
  for (const move of moves) {
    const tab = written.tabs[move.tabIndex];
    if (!tab) {
      mismatches.push({
        entityId: move.entityId,
        tabIndex: move.tabIndex,
        title: move.title,
        url: move.url,
        expectedWorkspaceId: move.toWorkspaceId,
        actualWorkspaceId: null,
        actualEntityId: null,
        actualTitle: null,
        actualUrl: null,
        reason: "missing_tab"
      });
      continue;
    }
    const identity = tabIdentity(tab, move.tabIndex);
    if (!tabMatchesMoveIdentity(tab, identity, move)) {
      mismatches.push({
        entityId: move.entityId,
        tabIndex: move.tabIndex,
        title: move.title,
        url: move.url,
        expectedWorkspaceId: move.toWorkspaceId,
        actualWorkspaceId: tab.zenWorkspace ?? null,
        actualEntityId: identity.stableEntityId ?? identity.fallbackEntityId,
        actualTitle: identity.title,
        actualUrl: identity.url,
        reason: "identity_mismatch"
      });
      continue;
    }
    if (tab.zenWorkspace !== move.toWorkspaceId) {
      mismatches.push({
        entityId: move.entityId,
        tabIndex: move.tabIndex,
        title: move.title,
        url: move.url,
        expectedWorkspaceId: move.toWorkspaceId,
        actualWorkspaceId: tab.zenWorkspace ?? null,
        actualEntityId: identity.stableEntityId ?? identity.fallbackEntityId,
        actualTitle: identity.title,
        actualUrl: identity.url,
        reason: "workspace_mismatch"
      });
    }
  }

  return {
    ok: mismatches.length === 0,
    checkedMoves: moves.length,
    mismatchCount: mismatches.length,
    mismatches,
    blockers: []
  };
}

function tabMatchesMoveIdentity(tab: RawTab, identity: TabIdentity, move: AppliedMove): boolean {
  if (identity.stableEntityId) return identity.stableEntityId === move.entityId;
  return identity.url === move.url && identity.title === move.title;
}

interface TabIdentity {
  stableEntityId: string | null;
  fallbackEntityId: string;
  title: string;
  url: string;
}

function tabIdentity(tab: RawTab, index: number): TabIdentity {
  const entry = selectedEntry(tab);
  const url = entry?.url ?? "about:blank";
  const stableEntityId = tab.zenSyncId || tab.zenGlanceId ? String(tab.zenSyncId ?? tab.zenGlanceId) : null;
  return {
    stableEntityId,
    fallbackEntityId: String(tab.zenWorkspace ? `${tab.zenWorkspace}:${index}` : `unknown:${index}`),
    title: entry?.title ?? url,
    url
  };
}

function selectedEntry(tab: RawTab) {
  const entries = Array.isArray(tab.entries) ? tab.entries : [];
  if (entries.length === 0) return undefined;
  const rawIndex = typeof tab.index === "number" ? tab.index - 1 : entries.length - 1;
  const index = Math.min(Math.max(rawIndex, 0), entries.length - 1);
  return entries[index];
}

function applyTabMove(session: RawZenSession, action: EntityPlan): AppliedMove {
  if (action.entityType !== "tab") throw new Error(`Unsupported entity type for offline apply: ${action.entityType}`);
  if (!action.destinationWorkspaceId || !action.destinationWorkspaceName) {
    throw new Error(`Planned move ${action.entityId} has no destination workspace`);
  }
  const tabs = Array.isArray(session.tabs) ? session.tabs : [];
  const tab = tabs[action.tabIndex];
  if (!tab) throw new Error(`Planned move ${action.entityId} references missing tab index ${action.tabIndex}`);
  if (tab.zenWorkspace !== action.sourceWorkspaceId) {
    throw new Error(`Planned move ${action.entityId} no longer matches source workspace ${action.sourceWorkspaceId}`);
  }
  tab.zenWorkspace = action.destinationWorkspaceId;
  return {
    entityId: action.entityId,
    tabIndex: action.tabIndex,
    title: action.title,
    url: action.url,
    fromWorkspaceId: action.sourceWorkspaceId,
    fromWorkspaceName: action.sourceWorkspaceName,
    toWorkspaceId: action.destinationWorkspaceId,
    toWorkspaceName: action.destinationWorkspaceName
  };
}

function sanitizePathSegment(segment: string): string {
  return segment.replace(/[^a-zA-Z0-9._ -]/g, "_");
}
