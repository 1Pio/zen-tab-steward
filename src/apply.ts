import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createBackup } from "./backup.js";
import { readJsonLz4, writeJsonLz4 } from "./mozlz4.js";
import { ProfileContext } from "./profile.js";
import { RawZenSession } from "./session.js";
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

export function offlineApplyBlockers(context: ProfileContext, backend: "auto" | "live" | "session"): string[] {
  const blockers: string[] = [];
  if (backend === "live") {
    blockers.push("Live backend is unavailable");
    return blockers;
  }
  if (context.running) {
    if (backend === "auto") blockers.push("Zen is running and no live backend is available");
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
  const receiptRoot = join(stateDir(), "applies", sanitizePathSegment(context.profile.id));
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

async function verifyAppliedMoves(path: string, moves: AppliedMove[]): Promise<ApplyReceipt["verification"]> {
  const written = await readJsonLz4(path) as RawZenSession;
  if (!Array.isArray(written.tabs)) throw new Error("Post-apply verification failed: written session has no tab array");
  for (const move of moves) {
    const tab = written.tabs[move.tabIndex];
    if (!tab) throw new Error(`Post-apply verification failed: missing tab index ${move.tabIndex}`);
    if (tab.zenWorkspace !== move.toWorkspaceId) {
      throw new Error(`Post-apply verification failed: tab ${move.entityId} is in ${tab.zenWorkspace ?? "(none)"} instead of ${move.toWorkspaceId}`);
    }
  }
  return { ok: true, checkedMoves: moves.length };
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
