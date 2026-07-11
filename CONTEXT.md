# Zen Tab Steward Context

## Purpose

Zen Tab Steward, or `zts`, helps a person organize Zen Browser tabs into useful Workspaces from a terminal or through an AI agent. It must make read-only inspection effortless, make proposed changes understandable, and make every mutation explicit, state-bound, reversible where possible, and durably evidenced.

The product source of truth lives in the project vault. This repository records the engineering language and decisions needed to keep implementations and reviews aligned with that goal.

## Domain language

Use these terms consistently in code, tests, documentation, and review.

- **Profile**: one Zen user profile whose browser state zts observes and stewards as a unit. Avoid "account" and "browser instance".
- **Workspace**: the user-facing Zen destination and source for organization. It corresponds to an upstream Zen Space. Use "Space" only in Adapter-facing code that mirrors Zen.
- **Entity**: one normalized structural node. Only a top-level **Movement Root** may be moved; its revision and operation include its complete ordered descendant closure. Avoid "item" and "row".
- **Snapshot**: an immutable normalized view of one Profile at one observed revision. It contains provenance, authority, Workspaces, Entities, and Capabilities. Avoid "session" outside Adapter-facing code.
- **Persisted Observation**: a non-authoritative Snapshot read from disk without holding Zen/Gecko's native Profile control. Newer in-memory state or a concurrent opener may exist. It may support display and preview, but it is never executable apply state.
- **Protection**: user-owned policy preventing an Entity or Workspace from participating in a change without an explicit typed grant. Avoid treating Protection as a filter or incidental skip.
- **Patch**: an untrusted human- or agent-authored request for exact changes against one Snapshot revision. A Patch is not a Plan.
- **Plan**: an immutable, read-only zts audit artifact containing validated decisions and exact preconditions. Its Profile, Snapshot revision, authority, and freshness are derived from the validated Snapshot passed to the Plan factory, then bound with configuration and intent revisions. Avoid using "preview" for the domain artifact.
- **Operation**: one exact intended state transition with a precondition and expected post-state. Use "action" only for the broader Plan disposition that may be review, protected, blocked, or unchanged.
- **Apply Authorization**: explicit consent bound to one exact Plan digest, all executable action ids, permitted Trust Classes, Protection grants, and any separately granted managed-Zen lifecycle.
- **Apply Transaction**: one capability-aware attempt to preflight, execute, verify, and record every executable Plan Operation. It is not a promise of atomic rollback.
- **Receipt**: the durable typed result of one Apply Transaction, including exact per-Operation outcomes and observed post-state. A log is not a Receipt.
- **Drift**: any mismatch between a Plan precondition and newly observed state. Use "stale" only when an exact mismatch is not yet known.
- **Engine**: a source of proposed destination intent and evidence. An Engine cannot mutate Zen. Avoid "backend" for classification.
- **Trust Class**: a policy category determining whether a proposal may be considered for automatic apply after all movement-safety checks. A score is not a probability or Trust Class.
- **Control Route**: the evidenced mechanism used to observe or mutate Zen, such as closed session, managed Zen, privileged live, or a future Zen-owned route. A Control Route is not an Engine.
- **Capability**: an evidenced operation available through one Control Route for the current Profile and Zen build. Release labels do not belong in Capability status.

## Architectural shape

The domain core has two initial deep Modules:

- `src/domain/snapshot.ts` owns the Snapshot Interface, Entity identity and structure, provenance, authority, Protection, proof-scoped Capability vocabulary, and the validating Snapshot Implementation.
- `src/domain/change.ts` owns Patch, Plan, Operation, decision evidence, Apply Authorization, Apply Transaction outcome, Receipt contracts, and their validating Implementations.

These Modules define the stable seams. Zen session, managed lifecycle, privileged live, future Zen-owned control, configuration, storage, terminal rendering, JSON rendering, and classification Engines remain Adapters or callers outside the domain core.

`src/domain/digest.ts` is a small internal Implementation primitive. It gives both deep Modules one canonical JSON and SHA-256 rule without creating a third domain concept.

The intended flow is:

```text
Zen Profile -> Snapshot Adapter -> Snapshot -> Engine or Patch -> Plan
Plan -> Apply Transaction -> Control Route Adapter -> Receipt
Snapshot, Plan, Receipt -> human renderer or machine renderer
```

The CLI is a composition caller, not the owner of workflow correctness. Presentation flags, terminal prompts, file paths, process IDs, WebSocket endpoints, raw tab indices, and Adapter proof shapes must not leak into Snapshot, Plan, Patch, or Receipt.

## Non-negotiable invariants

1. An Engine proposes intent and never mutates Zen.
2. Process absence is not authority. A closed-session Snapshot is authoritative only when zts holds the exact Profile's Gecko-compatible native `.parentlock` across the source read; every other disk read is a Persisted Observation.
3. A Patch derives its revision binding from, and is validated against, the actual Snapshot before it can become a Plan. Caller-authored reasons remain attributed data and every referenced Entity must belong to that Snapshot.
4. Entity closure, normalized Snapshot state, Plan content, Protection grants, and Apply Authorization are content-addressed with canonical SHA-256 digests. Plan creation, authorization, and Receipt validation all receive and revalidate the actual Snapshot; authority is never caller-declared.
5. Apply Authorization covers every executable action in one exact Plan. Applying a subset first creates a derived Plan with a new digest.
6. Apply reacquires authoritative state and preflights every executable Operation. Any preflight Drift blocks the whole Plan before the first move.
7. Unexpected execution-time failure stops further work and produces an exact partial Receipt. Silent valid-subset apply is forbidden.
8. Protection, move caps, destination policy, structural Entity integrity, and capability checks apply equally to human, agent, rule, lexical, and semantic intent.
9. Humans and agents receive the same underlying information model. Full titles and URLs are available by default; optional masking is a presentation choice, not an agent-specific mode. Browser-controlled, caller-authored, Engine-generated, and zts-generated text preserves explicit provenance and is always data-only, never an instruction. Evidence references must resolve inside the bound Snapshot.
10. Bare `zts sort` is read-only until the user records explicit quick-sort consent. Non-interactive execution never invents consent.
11. Semantic automatic apply requires explicit user opt-in, separate suggestion and apply thresholds, an engine-specific calibration and model revision, a minimum margin, and the normal safety gates. Eligibility is derived from that evidence.
12. Unknown Zen schema or unproven Control Route capability fails closed for mutation.
13. User-owned state and artifacts are private by default: zts directories use `0700` and files use `0600`.
14. A Profile id is opaque and derived from its canonical filesystem target. Same-named or retargeted Profile directories cannot share Snapshots, Plans, locks, or Apply Transaction stores.
15. Every non-terminal Apply Transaction has exactly one owner-private unfinished marker. A bounded store reservation may be recorded first, but the marker is the first durable transaction artifact and contains enough validated consent, Authorization, Plan, and journal bootstrap identity to recover a marker-only crash. It remains until the canonical terminal Receipt is reachable, the reservation is settled, and required Profile-control cleanup is durable. Marker removal is last.
16. Completed saved-Plan history is one content-addressed, generation-bound linked Receipt ledger. An immutable node is durable before one atomic ready-head swap under persistent kernel store control; the head binds the latest transaction and Receipt digest. Exactly one unfinished marker plus its exact reservation authorizes a new append. A markerless repeat may only validate an already-reachable Receipt. Profile- and generation-bound authenticated cursors traverse requested canonical nodes, and corruption is never treated as absence or migration.
17. Apply-store growth is bounded by a small conservative accounting head. Transaction and maintenance reservations precede artifact growth and dominate every bounded payload plus publication temporary. Read-only retention preview binds an exact deterministic target/GC revision. Mutation builds an immutable generation off-head, publishes one fixed source/target/deletion manifest, performs one head swap, and idempotently reconciles exact deletions. Full Receipts age to `archived_summary_only` inside the same bounded ledger; unfinished work, incomplete maintenance, capacity pressure, or an unsafe manifest blocks Apply.

## Product scope

Mac-first closed-Zen organization is the first production baseline. The approved managed lifecycle experiment may close and restore Zen only through an explicit, bounded, recoverable workflow. Reliable privileged live control remains an intended production feature. It stays experimental only while documented security, lifecycle, compatibility, or reliability evidence justifies that status.

Local and cloud AI agents are both valid callers when the user chooses them. zts does not decide which agent the user may trust. It does ensure that visibility does not grant mutation authority, Protection override, or permission to bypass Plan and Apply Transaction semantics.

Backward compatibility is not a goal while the provisional contracts are being validated through the manual Patch vertical slice. Prefer one coherent replacement over parallel legacy and production architectures.

## Decision records

- [ADR-0001: Authoritative Snapshots and Entity identity](docs/adr/0001-authoritative-snapshots-and-entity-identity.md)
- [ADR-0002: Patch, Plan, and Apply Transaction semantics](docs/adr/0002-patch-plan-and-apply-semantics.md)
- [ADR-0003: Explicit automatic-apply trust](docs/adr/0003-explicit-auto-apply-trust.md)
- [ADR-0004: Evidence-gated Control Routes](docs/adr/0004-evidence-gated-control-routes.md)
- [ADR-0005: One information model for humans and agents](docs/adr/0005-one-information-model-for-humans-and-agents.md)
- [ADR-0006: Capability-tested Zen support](docs/adr/0006-capability-tested-zen-support.md)
- [Threat model](docs/THREAT_MODEL.md)
