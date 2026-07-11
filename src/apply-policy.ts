export const APPLY_UNDO_WINDOW_DAYS = 30;
export const APPLY_UNDO_WINDOW_MS = APPLY_UNDO_WINDOW_DAYS * 24 * 60 * 60 * 1000;

export function applyUndoWindowExpiresAt(completedAt: string): string {
  const completedMs = Date.parse(completedAt);
  if (!Number.isFinite(completedMs) || new Date(completedAt).toISOString() !== completedAt) {
    throw new Error("Apply Undo-window source timestamp must be canonical UTC ISO");
  }
  return new Date(completedMs + APPLY_UNDO_WINDOW_MS).toISOString();
}
