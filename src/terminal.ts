const DEFAULT_MAX_HUMAN_FIELD_LENGTH = 4096;

/**
 * Render untrusted browser, caller, Engine, or artifact text as inert one-line
 * terminal data. Machine JSON deliberately retains the original values.
 */
export function terminalText(value: unknown, maxLength = DEFAULT_MAX_HUMAN_FIELD_LENGTH): string {
  if (!Number.isSafeInteger(maxLength) || maxLength < 1) throw new Error("Terminal text limit must be positive");
  const input = String(value ?? "");
  const inert = input
    // OSC, DCS, SOS, PM, and APC strings terminated by BEL or ST.
    .replace(/\u001B(?:\][^\u0007\u001B]*|[PX^_][^\u001B]*)(?:\u0007|\u001B\\)/gu, "")
    // CSI sequences and remaining single-character escape sequences.
    .replace(/(?:\u001B\[|\u009B)[0-?]*[ -/]*[@-~]/gu, "")
    .replace(/\u001B[@-_]/gu, "")
    // C0/C1 controls and Unicode bidi-control characters.
    .replace(/[\u0000-\u001F\u007F-\u009F\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  if (inert.length <= maxLength) return inert;
  return `${inert.slice(0, Math.max(0, maxLength - 1))}…`;
}

export function terminalJson(value: unknown): string {
  return JSON.stringify(value, (_key, item) => typeof item === "string" ? terminalText(item) : item, 2);
}
