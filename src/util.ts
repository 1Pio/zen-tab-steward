import { RawTab } from "./session.js";

export function domainFromUrl(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

export function normalizeName(value: string): string {
  return value.trim().toLowerCase();
}

export function matchesUrlPattern(pattern: string, domain: string, url: string): boolean {
  const normalized = pattern.trim().toLowerCase();
  if (!normalized) return false;
  if (normalized.startsWith("http://") || normalized.startsWith("https://")) {
    return url.toLowerCase().startsWith(normalized);
  }
  if (normalized.startsWith("*.")) {
    const suffix = normalized.slice(2);
    return domain.endsWith(`.${suffix}`);
  }
  if (normalized.startsWith(".")) {
    return domain.endsWith(normalized);
  }
  return domain === normalized || domain.endsWith(`.${normalized}`);
}

export function selectedTabEntry(tab: RawTab): { url?: string; title?: string; [key: string]: unknown } | undefined {
  const entries = Array.isArray(tab.entries) ? tab.entries : [];
  if (entries.length === 0) return undefined;
  const rawIndex = typeof tab.index === "number" ? tab.index - 1 : entries.length - 1;
  const index = Math.min(Math.max(rawIndex, 0), entries.length - 1);
  return entries[index];
}

export function tabProtectionReasons(tab: RawTab): string[] {
  const reasons: string[] = [];
  if (tab.pinned) reasons.push("pinned");
  if (tab.zenEssential) reasons.push("essential");
  if (tab.groupId) reasons.push("grouped");
  if (tab.zenLiveFolderItemId) reasons.push("foldered");
  return reasons;
}

export function sanitizePathSegment(segment: string): string {
  return segment.replace(/[^a-zA-Z0-9._ -]/g, "_");
}

export function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max - 1)}…`;
}

export function plural(count: number, singular: string, pluralForm: string): string {
  return count === 1 ? singular : pluralForm;
}
