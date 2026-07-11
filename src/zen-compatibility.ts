import { sha256Canonical } from "./domain/digest.js";

import type { ZenCompatibilityIdentity } from "./profile.js";

const CLOSED_SESSION_TAB_ACCEPTANCE = Object.freeze([
  {
    platform: "darwin-arm64",
    osAbi: "Darwin_aarch64-gcc3",
    version: "1.19.3b",
    buildId: "20260315063056",
    schemaFamily: "zen-session-v1"
  }
]);

export const CLOSED_SESSION_TAB_ACCEPTANCE_REVISION = sha256Canonical({
  contract: "zts.closed-session.move-tab.acceptance-2",
  fixtures: [
    "standalone-reorder-and-rebind",
    "whole-plan-drift",
    "atomic-swap-race-and-recovery",
    "post-state-independent-reread",
    "closed-profile-native-control",
    "bounded-owner-profile-apply-reopen-undo-reopen"
  ],
  supported: CLOSED_SESSION_TAB_ACCEPTANCE
});

export type ClosedSessionTabCompatibility =
  | {
      readonly supported: true;
      readonly evidenceRevision: string;
      readonly reason: string;
    }
  | {
      readonly supported: false;
      readonly evidenceRevision: null;
      readonly reason: string;
    };

export function evaluateClosedSessionTabCompatibility(
  identity: ZenCompatibilityIdentity | null,
  schemaFamily: string,
  platform: string
): ClosedSessionTabCompatibility {
  if (!identity) {
    return {
      supported: false,
      evidenceRevision: null,
      reason: "Zen version/build identity is unavailable from the selected Profile"
    };
  }
  const accepted = CLOSED_SESSION_TAB_ACCEPTANCE.some((entry) =>
    entry.platform === platform
    && entry.osAbi === identity.osAbi
    && entry.version === identity.version
    && entry.buildId === identity.buildId
    && entry.schemaFamily === schemaFamily
  );
  return accepted
    ? {
        supported: true,
        evidenceRevision: CLOSED_SESSION_TAB_ACCEPTANCE_REVISION,
        reason: `Closed-session tab mutation is acceptance-tested for Zen ${identity.version} build ${identity.buildId}, ${schemaFamily}, ${platform}`
      }
    : {
        supported: false,
        evidenceRevision: null,
        reason: `No closed-session tab-mutation acceptance evidence matches Zen ${identity.version} build ${identity.buildId}, ${identity.osAbi}, ${schemaFamily}, ${platform}`
      };
}
