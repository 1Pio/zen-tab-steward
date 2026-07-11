import { createHash } from "node:crypto";

export type Sha256Digest = `sha256:${string}`;

/** Deterministic JSON for domain artifacts. Undefined values are omitted. */
export function canonicalJson(value: unknown): string {
  let encoded = "";
  emitCanonicalJson(value, (chunk) => { encoded += chunk; });
  return encoded;
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function sha256Canonical(value: unknown): Sha256Digest {
  const hash = createHash("sha256");
  // Feed canonical JSON directly into the hash instead of materializing a
  // second artifact-sized string. This matters for full-detail Snapshots and
  // receipts containing many browser-provided fields.
  emitCanonicalJson(value, (chunk) => { hash.update(chunk, "utf8"); });
  return `sha256:${hash.digest("hex")}`;
}

export function assertSha256Digest(value: string, label: string): asserts value is Sha256Digest {
  if (!/^sha256:[a-f0-9]{64}$/u.test(value)) throw new Error(`${label} must be a SHA-256 digest`);
}

function emitCanonicalJson(value: unknown, emit: (chunk: string) => void): void {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    emit(JSON.stringify(value));
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Canonical domain data cannot contain a non-finite number");
    emit(JSON.stringify(value));
    return;
  }
  if (Array.isArray(value)) {
    emit("[");
    for (let index = 0; index < value.length; index += 1) {
      if (index > 0) emit(",");
      emitCanonicalJson(value[index], emit);
    }
    emit("]");
    return;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort(compareCodeUnits);
    emit("{");
    for (let index = 0; index < keys.length; index += 1) {
      if (index > 0) emit(",");
      const key = keys[index]!;
      emit(JSON.stringify(key));
      emit(":");
      emitCanonicalJson(record[key], emit);
    }
    emit("}");
    return;
  }
  throw new Error(`Canonical domain data cannot contain ${typeof value}`);
}
