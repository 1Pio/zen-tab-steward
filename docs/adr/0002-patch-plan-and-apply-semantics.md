# ADR-0002: Patch, Plan, and Apply Transaction semantics

## Status

Accepted on 2026-07-10.

## Context

Humans, local agents, cloud agents, and classification Engines need one safe way to express and execute tab movement. Direct move commands and planner-specific apply loops make validation, drift handling, review, receipts, and undo inconsistent.

## Decision

A Patch is untrusted intent. Its constructor derives the Snapshot revision from an actual validated Snapshot, then verifies every Movement Root, expected source, destination, and attributed caller-text Entity reference against that Snapshot. zts validates the Patch into an immutable Plan, deriving Profile, Snapshot authority/revision/freshness, Entity identity, Workspace identity, and Protection state rather than accepting those claims from the caller. The Plan digest is derived from canonical Plan content and binds configuration, Engine manifest, intent, and one canonical action list with exact Operation preconditions.

Apply Authorization binds explicit consent to one Plan digest, every executable action id, allowed Trust Classes, exact Protection grants, and any separately authorized managed-Zen lifecycle. Applying a subset first creates a derived Plan with a new digest. The Apply Transaction is the only Module allowed to request mutation. It reacquires authoritative state and preflights every executable Operation. Any preflight Drift blocks the whole Plan before the first move. There is no implicit apply of a still-valid subset.

After execution begins, unexpected Drift or failure stops all further Operations. The Apply Transaction verifies each attempted Operation, writes an exact partial Receipt when needed, and may produce an explicit inverse Plan. Compensation is best effort and must never be reported as atomic rollback.

## Consequences

- Preview, approval, selective application, manual agent workflows, automatic sorting, and undo share one contract.
- Consent can bind to a Plan digest instead of vague command intent.
- Outcome-discriminated Receipts distinguish mutation attempt from net change, derive aggregate truth from every Operation result, and bind the journal, Authorization, control proof, backup, inverse Plan, recovery, and lifecycle-closure evidence required by that outcome.
- Control Route proof remains Adapter-private except for durable artifact references and typed outcome evidence.

## Options considered

- Apply valid Operations and skip drifted ones. Rejected because the resulting organization no longer matches the reviewed Plan.
- Let each Control Route implement its own planning and receipt model. Rejected because it duplicates safety logic and makes outcomes incomparable.
- Promise transactional rollback. Rejected because Zen mutations and crashes cannot always be reversed atomically.

## Notes

Whole-plan preflight failure is the default selected by the owner. Exact partial reporting applies only after execution has begun.
