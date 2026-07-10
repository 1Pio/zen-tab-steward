import { createHash } from "node:crypto";

export type Sha256Digest = `sha256:${string}`;

/** Deterministic JSON for domain artifacts. Undefined values are omitted. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Canonical domain data cannot contain a non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const entries = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort(compareCodeUnits)
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`);
    return `{${entries.join(",")}}`;
  }
  throw new Error(`Canonical domain data cannot contain ${typeof value}`);
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function sha256Canonical(value: unknown): Sha256Digest {
  return `sha256:${createHash("sha256").update(canonicalJson(value), "utf8").digest("hex")}`;
}

export function assertSha256Digest(value: string, label: string): asserts value is Sha256Digest {
  if (!/^sha256:[a-f0-9]{64}$/u.test(value)) throw new Error(`${label} must be a SHA-256 digest`);
}
