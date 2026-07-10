# ADR-0004: Evidence-gated Control Routes

## Status

Accepted on 2026-07-10.

## Context

The original goal includes effortless mutation whether Zen is open or closed. Current routes have materially different security and lifecycle properties. Closed session replacement is narrow but requires Zen to be closed. Firefox remote control is powerful and may expose unauthenticated privileged browser control while enabled. A future Zen-owned route could provide a least-privilege Interface.

## Decision

Mac-first closed-Zen organization is the first production baseline. The managed closed-Zen lifecycle experiment is approved and may be promoted only after separately authorized bounded quit, state flush, exclusive access, apply, restore, relaunch, window restoration, and failure recovery are evidenced. Movement consent alone never grants permission to close or relaunch Zen.

Reliable privileged live control remains an intended production feature and must be developed toward that standard. It remains experimental only while concrete documented security, lifecycle, compatibility, or reliability evidence warrants that classification. Promotion requires process and Profile binding, a complete authoritative live Snapshot, one short-lived session for preflight and execution, immediate verification, typed partial outcomes, and safe listener shutdown or bounded managed lifecycle.

Release status is not encoded as a Capability status. The current Capability report records available, unavailable, or unknown based on proof scoped to Profile, route, platform, Zen build, schema family, Entity kind, and an owner-private artifact digest. Privileged-live availability additionally binds the control session and process. Product release policy interprets that evidence separately.

## Consequences

- The tool automatically chooses only among routes proven safe for the current operation and environment.
- Explicit route selection fails clearly instead of silently falling back.
- Privileged live work continues, but experimental status is justified by evidence rather than convenience.
- A Zen-owned least-privilege control Interface remains the strategic upstream direction.

## Options considered

- Make current privileged remote control the default immediately. Rejected because endpoint ownership, listener confinement, and lifecycle shutdown are not yet proven.
- Permanently abandon live control. Rejected because it would fail the original product goal without exhausting viable routes.
- Use GUI automation. Rejected because it is brittle, hard to verify, and structurally unsafe for production mutation.

## Notes

This ADR approves the closed-Zen lifecycle experiment. It does not authorize destructive or unrecoverable lifecycle tests.
