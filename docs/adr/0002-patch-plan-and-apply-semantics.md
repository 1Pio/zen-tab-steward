# ADR-0002: Patch, Plan, and Apply Transaction semantics

## Status

Accepted on 2026-07-10.

## Context

Humans, local agents, cloud agents, and classification Engines need one safe way to express and execute tab movement. Direct move commands and planner-specific apply loops make validation, drift handling, review, receipts, and undo inconsistent.

## Decision

A Patch is untrusted intent. Its constructor derives the Snapshot revision from an actual validated Snapshot, then verifies every Movement Root, expected source, destination, and attributed caller-text Entity reference against that Snapshot. zts validates the Patch into an immutable Plan, deriving Profile, Snapshot authority/revision/freshness, Entity identity, Workspace identity, and Protection state rather than accepting those claims from the caller. The Plan digest is derived from canonical Plan content and binds configuration, Engine manifest, intent, and one canonical action list with exact Operation preconditions.

Apply Authorization binds explicit consent to one Plan digest, every executable action id, allowed Trust Classes, exact Protection grants, and any separately authorized managed-Zen lifecycle. Applying a subset first creates a derived Plan with a new digest. The Apply Transaction is the only Module allowed to request mutation. It reacquires authoritative state and preflights every executable Operation. Any preflight Drift blocks the whole Plan before the first move. There is no implicit apply of a still-valid subset.

After execution begins, unexpected Drift or failure stops all further Operations. The Apply Transaction verifies each attempted Operation, writes an exact partial Receipt when needed, and may produce an explicit inverse Plan. Compensation is best effort and must never be reported as atomic rollback.

The closed-session adapter publishes one complete session-file image with one macOS atomic swap, so its selected Operations cross the commit boundary together and are then independently verified from disk as one batch. The exact swap is the mutation boundary. A source raced into that boundary is restored with one atomic reverse swap, never a multi-rename interval with the canonical file absent. If the helper outcome itself is indeterminate, the unfinished marker remains authoritative and no terminal Receipt is published until recovery classifies the exact target/residue pair.

Before that mutation boundary becomes eligible, zts deterministically derives the exact normalized after-Snapshot, publishes the one inverse Plan bound to it, and records both bindings in the durable preflight journal. Inverse publication therefore cannot fail for the first time after mutation. Successful execution reuses that exact artifact and timestamp, and accepts `applied` only when the independently captured Snapshot matches the complete derived revision. A prepublished inverse remains audit/recovery evidence after a pre-mutation failure; blocked and interrupted Receipts do not expose it as Receipt-bound Undo state.

Admission first records one bounded Apply-store reservation, then publishes exactly one immutable unfinished marker as the first transaction artifact. The marker carries validated consent, Authorization, Plan, and initial-journal bootstrap identity, so recovery can reconstruct a marker-only crash without guessing from process state or timestamps. It remains indexed until terminal evidence, reservation settlement, and required Profile-control cleanup are durable; marker removal is last. Mutation admission rechecks the index while holding the Profile lock, excluding only its own transaction. Only an empty store may bootstrap its index and ready head automatically; transaction-bearing pre-index state fails closed pending explicit maintenance.

Terminal saved-Plan Receipts append to one immutable content-addressed history ledger under persistent kernel-held store control. The immutable node is durable before one atomic ready-head replacement makes it visible; the head also binds the latest transaction id and Receipt digest. Exactly one unfinished marker and its exact accounting reservation authorize a new append. A markerless repeat can only validate an identical Receipt already reachable from the ready head, never create another node. Marker removal follows successful ledger reachability, reservation settlement, and verified control release. Ready-state listing follows at most the requested number of small nodes. Its opaque cursor is authenticated and binds the Profile, ledger generation, sequence, and node digest, so an orphan or prior-generation node cannot be selected. Migration and maintenance refuse unfinished work, apply bounded domain validation, and never downgrade corrupt ledger state into a missing-index rebuild.

The Apply store has a small conservative accounting head rather than a hot-path directory scan. A transaction reservation dominates every per-artifact cap and the largest publication temporary; terminal settlement performs one bounded exact store measurement and carries a marker credit until marker removal is observed, avoiding cumulative worst-case charging. Retention uses its own capacity reservation before building off-head state. Retention preview is write-free and binds deterministic target summaries plus the exact source-node and deletion graph. The mutating pass publishes one immutable manifest containing source and target heads, disjoint node generations, deletion identities, and fixed totals before its sole head swap. A source head retries by discarding only the prepared target generation; a target head resumes only the manifest deletions. Per-file and subtree identities permit safe subset reconciliation after a crash. Full Receipts outside the undo window become `archived_summary_only` in the same bounded ledger, while their full private payloads are reclaimed.

Plan-store retention treats the validated Plan expiry as a crash-stable execution pin. Publication age alone never makes a still-executable detached Plan collectible; only an expired, old, and Apply-unreferenced Plan may be removed. This closes the admission interval between publishing a system-owned Undo Plan and publishing its unfinished Apply marker without adding a second mutable pin index.

Write intent binds the exact temporary path and prepared digest before temp creation. Recovery inspection binds the canonical target plus the exact journal-owned residue path and fingerprint. Finalization first preserves the complete planned image, partial fragment, or displaced external writer, then closes its temp lifecycle as removed or already absent. When an interrupted swap displaced an external writer, finalization may perform one explicitly reported atomic restorative swap under native Profile control. It releases native and zts controls before immutable terminal proof and Receipt publication. A recovered canonical state is reported as `applied` only when it is the exact planned after-Snapshot, every Operation independently verifies, and a bound inverse Plan is durable; ambiguous or externally drifted state remains non-applied.

Before recovery publishes terminal evidence, it exactly preflights every bounded downstream artifact and durably publishes one compact terminal intent. That intent binds the exact mutable-journal prefix, one stable prepared timestamp, the control proof, the reconstructed final immutable journal, the complete Receipt template, and every referenced recovery or inverse artifact. Once the intent exists, replay validates and completes those exact bytes without reacquiring Profile or native browser control and without recapturing browser state, even if Zen has reopened. An intent-bound `recovery_receipt_prepared` journal can transition only to `recovery_complete`. Recovery-created descriptors and legacy inverse evidence are deterministic across retries, so a repeated crash either reuses identical content or fails closed on collision.

Undo is a causal Apply intent, not a privileged side channel. A successful forward Receipt binds an immutable inverse template to its exact after-Snapshot. Preview deterministically materializes the only executable Undo Plan from that template, the full source Receipt and Plan, the current configuration, and the current authoritative Snapshot. Persisted invocation consent has a strict discriminated purpose and binds the source Receipt id and digest. The Apply mutation seam reloads and recomputes the complete reverse binding both at admission and at the final mutation boundary. Receipt history reduces as a causal stack: a successful Undo cancels exactly its forward source, allowing the preceding active forward Receipt to become `latest`; blocked and fully compensated attempts are inert, and partial, failed, interrupted, or otherwise uncertain lineage is a barrier. Direct inverse Apply and Undo-of-Undo are not enabled.

## Consequences

- Preview, approval, selective application, manual agent workflows, automatic sorting, and undo share one contract.
- Consent can bind to a Plan digest instead of vague command intent.
- Outcome-discriminated Receipts distinguish mutation attempt from net change, derive aggregate truth from every Operation result, and bind the journal, Authorization, control proof, backup, inverse Plan, recovery, and lifecycle-closure evidence required by that outcome.
- Control Route proof remains Adapter-private except for durable artifact references and typed outcome evidence.
- Completed history pagination is generation-stable and proportional to page size; mutation admission uses the accounting head, unfinished marker, and ready-head identity rather than scanning completed history.

## Options considered

- Apply valid Operations and skip drifted ones. Rejected because the resulting organization no longer matches the reviewed Plan.
- Let each Control Route implement its own planning and receipt model. Rejected because it duplicates safety logic and makes outcomes incomparable.
- Promise transactional rollback. Rejected because Zen mutations and crashes cannot always be reversed atomically.

## Notes

Whole-plan preflight failure is the default selected by the owner. Exact partial reporting applies only after execution has begun.
