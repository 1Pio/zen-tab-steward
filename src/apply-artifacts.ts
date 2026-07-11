import { sha256Canonical } from "./domain/digest.js";
import { stateDir } from "./paths.js";
import { assertPrivateDirectory, ensurePrivateDirectory, privatePath } from "./private-store.js";

import type { Sha256Digest } from "./domain/digest.js";
import type { ArtifactReference } from "./domain/snapshot.js";

export interface ApplyArtifactLayout {
  readonly root: string;
  readonly transactions: string;
  readonly unfinished: string;
  readonly consents: string;
  readonly authorizations: string;
  readonly backups: string;
  readonly backupManifests: string;
  readonly preparedImages: string;
  readonly recoveries: string;
  readonly inverses: string;
  readonly journals: string;
  readonly controls: string;
  readonly receipts: string;
  readonly receiptHistory: string;
}

export async function applyArtifactLayout(profileId: string): Promise<ApplyArtifactLayout> {
  const profileKey = applyProfileKey(profileId);
  const root = await ensurePrivateDirectory(stateDir(), "apply-transactions", profileKey);
  return {
    root,
    transactions: await ensurePrivateDirectory(root, "transactions"),
    unfinished: await ensurePrivateDirectory(root, "unfinished"),
    consents: await ensurePrivateDirectory(root, "consents"),
    authorizations: await ensurePrivateDirectory(root, "authorizations"),
    backups: await ensurePrivateDirectory(root, "backups"),
    backupManifests: await ensurePrivateDirectory(root, "backup-manifests"),
    preparedImages: await ensurePrivateDirectory(root, "prepared-images"),
    recoveries: await ensurePrivateDirectory(root, "recoveries"),
    inverses: await ensurePrivateDirectory(root, "inverse-plans"),
    journals: await ensurePrivateDirectory(root, "journals"),
    controls: await ensurePrivateDirectory(root, "controls"),
    receipts: await ensurePrivateDirectory(root, "receipts"),
    receiptHistory: await ensurePrivateDirectory(root, "receipt-history")
  };
}

export async function readApplyArtifactLayout(profileId: string): Promise<ApplyArtifactLayout> {
  const profileKey = applyProfileKey(profileId);
  const root = await assertPrivateDirectory(stateDir(), "apply-transactions", profileKey);
  return {
    root,
    transactions: await assertPrivateDirectory(root, "transactions"),
    unfinished: privatePath(root, "unfinished"),
    consents: await assertPrivateDirectory(root, "consents"),
    authorizations: await assertPrivateDirectory(root, "authorizations"),
    backups: await assertPrivateDirectory(root, "backups"),
    backupManifests: await assertPrivateDirectory(root, "backup-manifests"),
    preparedImages: privatePath(root, "prepared-images"),
    recoveries: await assertPrivateDirectory(root, "recoveries"),
    inverses: await assertPrivateDirectory(root, "inverse-plans"),
    journals: await assertPrivateDirectory(root, "journals"),
    controls: await assertPrivateDirectory(root, "controls"),
    receipts: await assertPrivateDirectory(root, "receipts"),
    receiptHistory: privatePath(root, "receipt-history")
  };
}

function applyProfileKey(profileId: string): string {
  if (!profileId.trim()) throw new Error("Apply artifact store requires a Profile id");
  return `profile-${digestHex(sha256Canonical({ profileId }))}`;
}

export function artifactObjectPath(root: string, digest: Sha256Digest, extension = "json"): string {
  return privatePath(root, `${digestHex(digest)}.${extension}`);
}

export function artifactReference(id: string, digest: Sha256Digest): ArtifactReference {
  if (!id.trim()) throw new Error("Artifact reference requires an id");
  return { id, digest };
}

export function digestHex(digest: Sha256Digest): string {
  return digest.slice("sha256:".length);
}

export function safeArtifactSegment(value: string): string {
  const cleaned = value.trim().replace(/[^A-Za-z0-9._-]+/gu, "-").replace(/^-+|-+$/gu, "");
  return cleaned || "unknown";
}
