import type { IntentSource } from "./domain/change.js";
import type { Sha256Digest } from "./domain/digest.js";

export const INVOCATION_CONSENT_SCHEMA = "zts.invocation-consent.provisional-2" as const;
export const INVOCATION_CONSENT_MAX_BYTES = 16 * 1024;

interface InvocationConsentBase {
  readonly schemaVersion: typeof INVOCATION_CONSENT_SCHEMA;
  readonly transactionId: string;
  readonly planId: string;
  readonly planDigest: Sha256Digest;
  readonly confirmedDigest: Sha256Digest;
  readonly confirmedAt: string;
  readonly commandRevision: Sha256Digest;
}

export type InvocationConsent =
  | (InvocationConsentBase & {
      readonly purpose: {
        readonly kind: "apply";
      };
    })
  | (InvocationConsentBase & {
      readonly purpose: {
        readonly kind: "undo";
        readonly sourceReceiptId: string;
        readonly sourceReceiptDigest: Sha256Digest;
      };
    });

export interface InvocationConsentBinding {
  readonly transactionId: string;
  readonly planId: string;
  readonly planDigest: Sha256Digest;
  /** Supplying the actual Plan source makes purpose validation mandatory. */
  readonly planSource?: IntentSource;
}

/**
 * Defines the only accepted persisted invocation-consent shape. Callers that
 * have loaded the Plan must supply its source so Undo consent is causally bound
 * to the exact inverse Plan rather than merely to a Plan id and digest.
 */
export function defineInvocationConsent(
  value: unknown,
  binding?: InvocationConsentBinding
): InvocationConsent {
  const record = objectRecord(value, "Invocation consent");
  assertExactKeys(record, [
    "schemaVersion",
    "transactionId",
    "planId",
    "planDigest",
    "confirmedDigest",
    "confirmedAt",
    "commandRevision",
    "purpose"
  ], "Invocation consent");
  if (record.schemaVersion !== INVOCATION_CONSENT_SCHEMA) {
    throw new Error("Unsupported invocation consent schema");
  }
  if (typeof record.transactionId !== "string" || !isTransactionId(record.transactionId)) {
    throw new Error("Invocation consent transaction id is invalid");
  }
  if (typeof record.planId !== "string"
    || record.planId.trim().length === 0
    || Buffer.byteLength(record.planId, "utf8") > 1024
    || containsControl(record.planId)) {
    throw new Error("Invocation consent Plan id is invalid");
  }
  assertDigest(record.planDigest, "Invocation consent Plan digest");
  assertDigest(record.confirmedDigest, "Invocation consent confirmed digest");
  assertDigest(record.commandRevision, "Invocation consent command revision");
  if (record.confirmedDigest !== record.planDigest) {
    throw new Error("Invocation consent confirmed digest does not match its Plan digest");
  }
  const confirmedAt = canonicalTimestamp(record.confirmedAt, "Invocation consent confirmation timestamp");
  const purposeRecord = objectRecord(record.purpose, "Invocation consent purpose");
  let purpose: InvocationConsent["purpose"];
  if (purposeRecord.kind === "apply") {
    assertExactKeys(purposeRecord, ["kind"], "Apply invocation consent purpose");
    purpose = Object.freeze({ kind: "apply" as const });
  } else if (purposeRecord.kind === "undo") {
    assertExactKeys(
      purposeRecord,
      ["kind", "sourceReceiptId", "sourceReceiptDigest"],
      "Undo invocation consent purpose"
    );
    if (typeof purposeRecord.sourceReceiptId !== "string"
      || !isApplyReceiptId(purposeRecord.sourceReceiptId)) {
      throw new Error("Undo invocation consent source Receipt id is invalid");
    }
    assertDigest(purposeRecord.sourceReceiptDigest, "Undo invocation consent source Receipt digest");
    purpose = Object.freeze({
      kind: "undo" as const,
      sourceReceiptId: purposeRecord.sourceReceiptId,
      sourceReceiptDigest: purposeRecord.sourceReceiptDigest
    });
  } else {
    throw new Error("Invocation consent purpose must be apply or undo");
  }

  const consent = Object.freeze({
    schemaVersion: INVOCATION_CONSENT_SCHEMA,
    transactionId: record.transactionId,
    planId: record.planId,
    planDigest: record.planDigest,
    confirmedDigest: record.confirmedDigest,
    confirmedAt,
    commandRevision: record.commandRevision,
    purpose
  }) as InvocationConsent;
  if (binding) assertConsentBinding(consent, binding);
  return consent;
}

function assertConsentBinding(
  consent: InvocationConsent,
  binding: InvocationConsentBinding
): void {
  if (consent.transactionId !== binding.transactionId
    || consent.planId !== binding.planId
    || consent.planDigest !== binding.planDigest) {
    throw new Error("Invocation consent does not match its transaction and Plan binding");
  }
  if (!binding.planSource) return;
  if (binding.planSource.kind !== "inverse") {
    if (consent.purpose.kind !== "apply") {
      throw new Error("Undo invocation consent requires an inverse Plan");
    }
    return;
  }
  if (binding.planSource.sourceReceiptDigest === null) {
    throw new Error("Undo invocation consent requires a digest-bound inverse Plan");
  }
  if (consent.purpose.kind !== "undo") {
    throw new Error("A digest-bound inverse Plan requires Undo invocation consent");
  }
  if (consent.purpose.sourceReceiptId !== binding.planSource.sourceReceiptId
    || consent.purpose.sourceReceiptDigest !== binding.planSource.sourceReceiptDigest) {
    throw new Error("Undo invocation consent source Receipt does not match its bound inverse Plan");
  }
}

function objectRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function assertExactKeys(
  value: Readonly<Record<string, unknown>>,
  expected: readonly string[],
  label: string
): void {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  if (actual.length !== sortedExpected.length
    || actual.some((key, index) => key !== sortedExpected[index])) {
    throw new Error(`${label} contains unknown or missing fields`);
  }
}

function assertDigest(value: unknown, label: string): asserts value is Sha256Digest {
  if (typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(value)) {
    throw new Error(`${label} must be a canonical SHA-256 digest`);
  }
}

function canonicalTimestamp(value: unknown, label: string): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new Error(`${label} must be a canonical timestamp`);
  }
  const canonical = new Date(value).toISOString();
  if (canonical !== value) throw new Error(`${label} must use canonical ISO-8601 form`);
  return canonical;
}

function isTransactionId(value: string): boolean {
  return /^apply:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value);
}

function isApplyReceiptId(value: string): boolean {
  return /^receipt:apply:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value);
}

function containsControl(value: string): boolean {
  return /[\u0000-\u001f\u007f-\u009f]/u.test(value);
}
