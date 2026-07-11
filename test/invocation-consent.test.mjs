import assert from "node:assert/strict";
import test from "node:test";
import {
  defineInvocationConsent,
  INVOCATION_CONSENT_SCHEMA
} from "../dist/invocation-consent.js";

const D1 = `sha256:${"1".repeat(64)}`;
const D2 = `sha256:${"2".repeat(64)}`;
const D3 = `sha256:${"3".repeat(64)}`;
const TRANSACTION_ID = "apply:11111111-1111-4111-8111-111111111111";
const RECEIPT_ID = `receipt:${TRANSACTION_ID}`;

function standardConsent(overrides = {}) {
  return {
    schemaVersion: INVOCATION_CONSENT_SCHEMA,
    transactionId: TRANSACTION_ID,
    planId: "plan:fixture",
    planDigest: D1,
    confirmedDigest: D1,
    confirmedAt: "2026-07-11T10:00:00.000Z",
    commandRevision: D2,
    purpose: { kind: "apply" },
    ...overrides
  };
}

function binding(planSource) {
  return {
    transactionId: TRANSACTION_ID,
    planId: "plan:fixture",
    planDigest: D1,
    planSource
  };
}

test("Invocation consent accepts only its exact bounded standard schema", () => {
  const consent = defineInvocationConsent(standardConsent(), binding({
    kind: "manual_patch",
    intentRevision: D3
  }));
  assert.equal(consent.purpose.kind, "apply");
  assert.equal(Object.isFrozen(consent), true);
  assert.equal(Object.isFrozen(consent.purpose), true);

  assert.throws(
    () => defineInvocationConsent({ ...standardConsent(), extra: true }),
    /unknown or missing fields/iu
  );
  assert.throws(
    () => defineInvocationConsent(standardConsent({ purpose: { kind: "apply", sourceReceiptId: RECEIPT_ID } })),
    /unknown or missing fields/iu
  );
  assert.throws(
    () => defineInvocationConsent(standardConsent({ confirmedDigest: D3 })),
    /confirmed digest does not match/iu
  );
  assert.throws(
    () => defineInvocationConsent(standardConsent({ commandRevision: "sha256:BAD" })),
    /canonical SHA-256/iu
  );
  assert.throws(
    () => defineInvocationConsent(standardConsent({ confirmedAt: "2026-07-11T10:00:00Z" })),
    /canonical ISO-8601/iu
  );
  assert.throws(
    () => defineInvocationConsent(standardConsent(), { ...binding({ kind: "manual_patch", intentRevision: D3 }), planId: "plan:other" }),
    /transaction and Plan binding/iu
  );
});

test("Undo consent must equal the source Receipt identity bound by the inverse Plan", () => {
  const inverseSource = {
    kind: "inverse",
    sourceReceiptId: RECEIPT_ID,
    sourceReceiptDigest: D3,
    inverseTemplateDigest: D2,
    sourcePlanId: "plan:forward",
    sourcePlanDigest: D2,
    intentRevision: D1
  };
  const undo = standardConsent({
    purpose: {
      kind: "undo",
      sourceReceiptId: RECEIPT_ID,
      sourceReceiptDigest: D3
    }
  });
  assert.equal(defineInvocationConsent(undo, binding(inverseSource)).purpose.kind, "undo");

  assert.throws(
    () => defineInvocationConsent(standardConsent(), binding(inverseSource)),
    /requires Undo invocation consent/iu
  );
  assert.throws(
    () => defineInvocationConsent(undo, binding({ ...inverseSource, sourceReceiptDigest: D2 })),
    /does not match its bound inverse Plan/iu
  );
  assert.throws(
    () => defineInvocationConsent(undo, binding({ ...inverseSource, sourceReceiptId: "receipt:apply:22222222-2222-4222-8222-222222222222" })),
    /does not match its bound inverse Plan/iu
  );
  assert.throws(
    () => defineInvocationConsent(undo, binding({ ...inverseSource, sourceReceiptDigest: null })),
    /digest-bound inverse Plan/iu
  );
  assert.throws(
    () => defineInvocationConsent(undo, binding({ kind: "engine", engine: "rules", intentRevision: D3 })),
    /requires an inverse Plan/iu
  );
});
