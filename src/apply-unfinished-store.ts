import { lstat, readdir } from "node:fs/promises";
import {
  inspectPrivateStandaloneTemporaryCandidate,
  isPrivateTemporaryBasename,
  privatePath,
  publishPrivateBytes,
  publishPrivateJson,
  readPrivateJson,
  reconcilePrivatePublication,
  removePrivateFile
} from "./private-store.js";
import { safeArtifactSegment } from "./apply-artifacts.js";
import { defineApplyJournal } from "./apply-journal.js";
import { sha256Canonical } from "./domain/digest.js";
import { defineInvocationConsent } from "./invocation-consent.js";

import type { ApplyArtifactLayout } from "./apply-artifacts.js";
import type { ApplyJournal } from "./apply-journal.js";
import type { ApplyAuthorization } from "./domain/change.js";
import type { Plan } from "./domain/change.js";
import type { ArtifactReference } from "./domain/snapshot.js";
import type { InvocationConsent } from "./invocation-consent.js";
import type { PrivatePublicationHooks } from "./private-store.js";

const INDEX_SCHEMA = "zts.apply-unfinished-index.provisional-1" as const;
const MARKER_SCHEMA = "zts.apply-unfinished-marker.provisional-2" as const;
const INDEX_FILENAME = "index.json";
const INDEX_MAX_BYTES = 8 * 1024;
const MAX_UNFINISHED_ENTRIES = 256;
const PREPARED_MARKER = Symbol("prepared Apply unfinished marker");

export const APPLY_UNFINISHED_MARKER_MAX_BYTES = 16 * 1024 * 1024;

interface ApplyUnfinishedIndex {
  readonly schemaVersion: typeof INDEX_SCHEMA;
  readonly profileId: string;
}

export interface ApplyUnfinishedMarker {
  readonly schemaVersion: typeof MARKER_SCHEMA;
  readonly journal: ApplyJournal;
  readonly bootstrap: ApplyUnfinishedBootstrap;
}

export interface ApplyUnfinishedBootstrap {
  readonly consent: InvocationConsent;
  readonly consentArtifact: ArtifactReference;
  readonly authorization: ApplyAuthorization;
  readonly authorizationArtifact: ArtifactReference;
}

export interface PreparedApplyUnfinishedMarker {
  readonly transactionId: string;
  readonly encoded: string;
  readonly byteLength: number;
  readonly [PREPARED_MARKER]: true;
}

export class ApplyUnfinishedMarkerLimitError extends Error {
  readonly byteLength: number;
  readonly maxBytes: number;

  constructor(byteLength: number) {
    super(
      `Apply unfinished marker is ${byteLength} bytes and exceeds the ${APPLY_UNFINISHED_MARKER_MAX_BYTES}-byte transaction limit`
    );
    this.name = "ApplyUnfinishedMarkerLimitError";
    this.byteLength = byteLength;
    this.maxBytes = APPLY_UNFINISHED_MARKER_MAX_BYTES;
  }
}

export type ApplyUnfinishedPlanLoader = (
  profileId: string,
  planDigest: string
) => Promise<Plan>;

export async function initializeApplyUnfinishedIndex(
  layout: ApplyArtifactLayout,
  profileId: string,
  hooks: PrivatePublicationHooks = {}
): Promise<void> {
  const index: ApplyUnfinishedIndex = { schemaVersion: INDEX_SCHEMA, profileId };
  await publishPrivateJson(privatePath(layout.unfinished, INDEX_FILENAME), index, hooks);
}

/** Reconciles only the exact inode-bound index publication under store control. */
export async function reconcileApplyUnfinishedIndexPublication(
  layout: ApplyArtifactLayout,
  profileId: string
): Promise<boolean> {
  if (!await hasApplyUnfinishedIndex(layout, profileId)) return false;
  const reconciled = await reconcilePrivatePublication(privatePath(layout.unfinished, INDEX_FILENAME));
  if (!await hasApplyUnfinishedIndex(layout, profileId)) {
    throw new Error("Apply unfinished index disappeared during publication reconciliation");
  }
  return reconciled;
}

export function prepareApplyUnfinishedMarker(
  journal: ApplyJournal,
  bootstrap: ApplyUnfinishedBootstrap,
  plan: Plan
): PreparedApplyUnfinishedMarker {
  const initial = defineApplyJournal(structuredClone(journal));
  if (initial.stage !== "initialized" || initial.history.length !== 1) {
    throw new Error("Apply unfinished marker requires the initial journal state");
  }
  if (plan.id !== initial.planId || plan.digest !== initial.planDigest) {
    throw new Error("Apply unfinished marker Plan does not match its initial journal");
  }
  const marker = defineMarker({ schemaVersion: MARKER_SCHEMA, journal: initial, bootstrap }, plan);
  const encoded = `${JSON.stringify(marker, null, 2)}\n`;
  const byteLength = Buffer.byteLength(encoded, "utf8");
  if (byteLength > APPLY_UNFINISHED_MARKER_MAX_BYTES) {
    throw new ApplyUnfinishedMarkerLimitError(byteLength);
  }
  return Object.freeze({
    transactionId: initial.transactionId,
    encoded,
    byteLength,
    [PREPARED_MARKER]: true as const
  });
}

export async function publishApplyUnfinishedMarker(
  layout: ApplyArtifactLayout,
  prepared: PreparedApplyUnfinishedMarker
): Promise<void> {
  const byteLength = Buffer.byteLength(prepared.encoded, "utf8");
  if (prepared[PREPARED_MARKER] !== true
    || byteLength !== prepared.byteLength
    || byteLength > APPLY_UNFINISHED_MARKER_MAX_BYTES) {
    throw new Error("Apply unfinished marker publication does not match its exact preflight");
  }
  await publishPrivateBytes(
    markerPath(layout, prepared.transactionId),
    Buffer.from(prepared.encoded, "utf8"),
    APPLY_UNFINISHED_MARKER_MAX_BYTES
  );
}

export async function removeApplyUnfinishedMarker(
  layout: ApplyArtifactLayout,
  transactionId: string
): Promise<boolean> {
  try {
    const path = markerPath(layout, transactionId);
    // Marker removal is an explicit mutation boundary. A process may have
    // died after the immutable marker hardlink committed but before its
    // owner-private publication temporary was unlinked. Reconcile only that
    // exact inode-bound pair here, immediately before deleting the marker.
    await reconcilePrivatePublication(path);
    await removePrivateFile(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/** Returns null only for a pre-index store that requires one legacy scan. */
export async function readApplyUnfinishedMarkers(
  layout: ApplyArtifactLayout,
  expectedProfileId: string,
  loadPlan: ApplyUnfinishedPlanLoader
): Promise<ApplyUnfinishedMarker[] | null> {
  if (!await hasApplyUnfinishedIndex(layout, expectedProfileId)) return null;
  const entries = await readdir(layout.unfinished, { withFileTypes: true });
  if (entries.length > MAX_UNFINISHED_ENTRIES + 16) {
    throw new Error(`Apply unfinished index exceeds the ${MAX_UNFINISHED_ENTRIES}-transaction scan bound`);
  }
  const markers: ApplyUnfinishedMarker[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (entry.name === INDEX_FILENAME) continue;
    if (isPrivateTemporaryBasename(entry.name)) {
      const temporaryPath = privatePath(layout.unfinished, entry.name);
      const metadata = await lstat(temporaryPath);
      if (metadata.nlink === 1) {
        // This can be the exact marker prelink crash window. Inspection is
        // read-only: the history-lock owner will bind and remove this inode
        // before clearing an orphan reservation or planning retention.
        await inspectPrivateStandaloneTemporaryCandidate(
          temporaryPath,
          APPLY_UNFINISHED_MARKER_MAX_BYTES
        );
        continue;
      }
      if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.nlink !== 2) {
        throw new Error(`Apply unfinished index contains an invalid publication temporary: ${entry.name}`);
      }
      const canonicalMatches: string[] = [];
      for (const candidate of entries) {
        if (candidate.name === entry.name || !candidate.name.endsWith(".json")) continue;
        const candidatePath = privatePath(layout.unfinished, candidate.name);
        const candidateMetadata = await lstat(candidatePath);
        if (!candidateMetadata.isSymbolicLink()
          && candidateMetadata.isFile()
          && candidateMetadata.dev === metadata.dev
          && candidateMetadata.ino === metadata.ino) {
          canonicalMatches.push(candidatePath);
        }
      }
      if (canonicalMatches.length !== 1) {
        throw new Error(`Apply unfinished publication temporary lacks one proof-bound canonical marker: ${entry.name}`);
      }
      // Inspection is strictly read-only. The exact publication residue is
      // tolerated because the canonical marker is already durable and will
      // be returned below; explicit terminal marker removal reconciles it.
      continue;
    }
    if (!entry.isFile() || entry.isSymbolicLink() || !entry.name.endsWith(".json")) {
      throw new Error(`Apply unfinished index contains an unexpected entry: ${entry.name}`);
    }
    const markerValue = await readPrivateJson(
      privatePath(layout.unfinished, entry.name),
      APPLY_UNFINISHED_MARKER_MAX_BYTES
    );
    const identity = defineMarker(markerValue);
    const plan = await loadPlan(expectedProfileId, identity.journal.planDigest);
    const marker = defineMarker(markerValue, plan);
    if (marker.journal.profileId !== expectedProfileId) {
      throw new Error("Apply unfinished marker belongs to a different Profile");
    }
    if (entry.name !== markerFilename(marker.journal.transactionId)) {
      throw new Error("Apply unfinished marker filename does not match its transaction");
    }
    markers.push(marker);
  }
  return markers;
}

export async function hasApplyUnfinishedIndex(
  layout: ApplyArtifactLayout,
  expectedProfileId: string
): Promise<boolean> {
  let indexValue: unknown;
  try {
    indexValue = await readPrivateJson(
      privatePath(layout.unfinished, INDEX_FILENAME),
      INDEX_MAX_BYTES
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  defineIndex(indexValue, expectedProfileId);
  return true;
}

export function assertJournalMatchesUnfinishedMarker(
  marker: ApplyUnfinishedMarker,
  journal: ApplyJournal
): void {
  const initial = marker.journal;
  if (
    journal.transactionId !== initial.transactionId
    || journal.planId !== initial.planId
    || journal.planDigest !== initial.planDigest
    || journal.authorizationRevision !== initial.authorizationRevision
    || journal.profileId !== initial.profileId
    || journal.targetPathRevision !== initial.targetPathRevision
  ) {
    throw new Error("Apply transaction journal does not match its unfinished marker");
  }
}

function defineIndex(value: unknown, expectedProfileId: string): ApplyUnfinishedIndex {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Apply unfinished index must be an object");
  }
  const keys = Object.keys(value).sort();
  if (keys.length !== 2 || keys[0] !== "profileId" || keys[1] !== "schemaVersion") {
    throw new Error("Apply unfinished index contains unknown or missing fields");
  }
  const index = value as ApplyUnfinishedIndex;
  if (index.schemaVersion !== INDEX_SCHEMA || index.profileId !== expectedProfileId) {
    throw new Error("Apply unfinished index identity is invalid");
  }
  return index;
}

function defineMarker(value: unknown, plan?: Plan): ApplyUnfinishedMarker {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Apply unfinished marker must be an object");
  }
  const keys = Object.keys(value).sort();
  if (keys.length !== 3 || keys[0] !== "bootstrap" || keys[1] !== "journal" || keys[2] !== "schemaVersion") {
    throw new Error("Apply unfinished marker contains unknown or missing fields");
  }
  const marker = value as ApplyUnfinishedMarker;
  if (marker.schemaVersion !== MARKER_SCHEMA) throw new Error("Unsupported Apply unfinished marker schema");
  const journal = defineApplyJournal(marker.journal);
  if (journal.stage !== "initialized" || journal.history.length !== 1) {
    throw new Error("Apply unfinished marker does not contain an initial journal");
  }
  if (plan && (plan.id !== journal.planId
    || plan.digest !== journal.planDigest
    || plan.profileId !== journal.profileId)) {
    throw new Error("Apply unfinished marker does not match its bound Plan");
  }
  const bootstrap = defineBootstrap(marker.bootstrap, journal, plan);
  return { schemaVersion: MARKER_SCHEMA, journal, bootstrap };
}

function defineBootstrap(value: unknown, journal: ApplyJournal, plan?: Plan): ApplyUnfinishedBootstrap {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Apply unfinished bootstrap must be an object");
  }
  const keys = Object.keys(value).sort();
  const expected = ["authorization", "authorizationArtifact", "consent", "consentArtifact"].sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw new Error("Apply unfinished bootstrap contains unknown or missing fields");
  }
  const bootstrap = value as ApplyUnfinishedBootstrap;
  const consent = defineInvocationConsent(bootstrap.consent, {
    transactionId: journal.transactionId,
    planId: journal.planId,
    planDigest: journal.planDigest,
    ...(plan ? { planSource: plan.source } : {})
  });
  if (!isArtifactReference(bootstrap.consentArtifact)
    || bootstrap.consentArtifact.id !== `consent:${journal.transactionId}`
    || sha256Canonical(consent) !== bootstrap.consentArtifact.digest) {
    throw new Error("Apply unfinished bootstrap consent artifact is invalid");
  }
  if (!bootstrap.authorization || typeof bootstrap.authorization !== "object" || Array.isArray(bootstrap.authorization)
    || !isArtifactReference(bootstrap.authorizationArtifact)
    || bootstrap.authorization.id !== bootstrap.authorizationArtifact.id
    || bootstrap.authorization.revision !== bootstrap.authorizationArtifact.digest
    || bootstrap.authorization.revision !== journal.authorizationRevision
    || bootstrap.authorization.profileId !== journal.profileId
    || bootstrap.authorization.planId !== journal.planId
    || bootstrap.authorization.planDigest !== journal.planDigest
    || bootstrap.authorization.authorizedAt !== consent.confirmedAt) {
    throw new Error("Apply unfinished bootstrap Authorization binding is invalid");
  }
  const { revision: _revision, ...authorizationDraft } = bootstrap.authorization;
  if (sha256Canonical(authorizationDraft) !== bootstrap.authorization.revision) {
    throw new Error("Apply unfinished bootstrap Authorization revision is invalid");
  }
  const authorizationConsent = (bootstrap.authorization as {
    readonly source?: { readonly consentArtifact?: unknown };
  }).source?.consentArtifact;
  if (!isArtifactReference(authorizationConsent)
    || authorizationConsent.id !== bootstrap.consentArtifact.id
    || authorizationConsent.digest !== bootstrap.consentArtifact.digest) {
    throw new Error("Apply unfinished bootstrap Authorization does not bind its exact invocation consent");
  }
  return { ...bootstrap, consent };
}

function isArtifactReference(value: unknown): value is ArtifactReference {
  return Boolean(value)
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.keys(value as object).length === 2
    && typeof (value as ArtifactReference).id === "string"
    && /^sha256:[a-f0-9]{64}$/u.test((value as ArtifactReference).digest);
}

function markerPath(layout: ApplyArtifactLayout, transactionId: string): string {
  return privatePath(layout.unfinished, markerFilename(transactionId));
}

function markerFilename(transactionId: string): string {
  return `${safeArtifactSegment(transactionId)}.json`;
}
