# Threat model

## Scope and assets

zts handles private browser state and can eventually change the user's active organization. Assets include:

- Zen Profile integrity and availability
- tab titles, full URLs, workspace names, history-bearing session artifacts, and configuration
- Snapshot, Patch, Plan, backup, transaction journal, and Receipt integrity
- Protection policy and user consent
- local model artifacts and calibration evidence
- the confidentiality and lifecycle of any privileged browser-control endpoint

The expected environment is a real user-owned Mac. Crashes, concurrent Zen activity, malformed browser content, stale state, corrupt files, compromised local inputs, and accidental command invocation are in scope. Defending against a fully compromised user account or kernel is not.

## Trust seams

### Zen Profile Adapter

Raw Zen files and live browser objects are untrusted inputs. They require size bounds, schema validation, provenance, stable identity resolution, structural Entity reconstruction, and explicit authority classification before entering Snapshot.

### Patch and CLI input

Arguments, standard input, Patch files, environment variables, and configuration are untrusted intent. They cannot directly choose an internal mutation primitive or bypass Protection. Unknown fields, duplicate configuration, malformed values, contradictory intent, and stale revisions fail clearly.

Configuration accepts only its bounded documented grammar. Unknown sections or fixed keys, duplicate sections/keys/rules, malformed or mistyped values, oversized collections/strings, and incoherent semantic thresholds are rejected before load or edit; valid partial files inherit explicit defaults.

### Engines

Rules, lexical classification, local embeddings, hybrid classification, and agent-authored decisions propose destinations only. Their evidence is recorded in Plan with explicit provenance and data-only interpretation. Engine output never crosses the mutation seam directly.

### Artifact store

Artifacts may contain full private browser state. zts-owned directories use mode `0700`; files use `0600`. The store rejects symlinks, unexpected file types, oversized content, unknown schemas, identifier collisions, path escape, and payload-to-filename mismatch. Durable immutable publication uses an exclusive synced temporary and no-replace hardlink. A kill between link and temp unlink is accepted only when exactly one owner-private, same-directory zts temp has the same inode, and explicit reconciliation under the same store owner removes that proof-bound residue. Mutable user/config publication uses expectation-bound Darwin atomic CAS; kernel-controlled internal heads use synced replacement and directory sync. A small digest-bound accounting head reserves conservative capacity before transaction or maintenance artifact growth; reservations include the largest bounded publication temporary. Baselines are replaced only from a complete bounded inventory while the non-forgeable store owner is held: during initial bootstrap, transaction or maintenance settlement, legacy recovery expansion, or the narrowly scoped admission of one exact newly created recovery-control file for a settled transaction retry.

Standalone backup creation accepts at most 64 MiB per known source and four fixed source names. Stable reads allocate the exact pre-open-handle stat size, fill that buffer, probe one byte past the boundary, and then recheck handle and path identity before publication. Session decoding retains its independent 32 MiB decompressed ceiling and the corresponding LZ4 worst-case compressed ceiling; larger profile support requires new measured evidence rather than silently raising either bound.

### Control Route Adapter

Mutation routes are privileged. Apply requires an authoritative Snapshot, a digest-bound Plan, whole-plan preflight, exclusive Profile control where relevant, exact Capability proof, bounded execution, immediate verification, and a durable transaction journal. Route-specific credentials, endpoints, PIDs, and raw proof stay outside domain artifacts unless referenced by an owner-private artifact ID.

### Human and machine renderers

Browser-provided titles, URLs, Workspace names, folder names, and group names are untrusted content. The Snapshot marks them `browser_untrusted`. Human output removes ANSI escapes, control characters, newlines, and bidirectional controls. JSON retains the underlying information through valid JSON escaping and writes exactly one protocol document in document mode. Agent callers must treat those values as data, never as instructions, tool calls, issue messages, remediation, or policy.

## Principal failure and abuse cases

| Case | Required defense |
| --- | --- |
| Bare or automated command mutates unexpectedly | Preview-first default, explicit unattended consent, later Plan-digest binding |
| Zen changes after preview | Reacquire authority and fail the whole preflight on any Drift |
| Duplicate URL or shifted tab index moves the wrong tab | Snapshot-scoped Entity reference, native identity, Entity revision, exact source precondition |
| Folder, group, or split is broken apart | Structural Entity reconstruction and indivisible movement policy |
| Zen starts during closed-session apply | Hold Zen/Gecko's native `.parentlock` across capture, preflight, commit, and verification; recheck the live lease and exact source at the atomic-swap boundary |
| Crash leaves partial file or no audit trail | Capacity reservation, self-contained unfinished marker as the first transaction artifact, exact atomic-swap boundary, residue-fingerprint-bound recovery, truthful restorative-mutation reporting, applied outcome only after exact after-state verification, and an exactly preflighted terminal intent that replays fixed evidence without reacquiring browser control |
| Two zts processes apply concurrently | Exclusive Profile transaction lock with stale-lock and PID-reuse handling |
| Completed history makes apply/recovery unusable | Indexed unfinished markers, O(1) accounting admission, bounded immutable Receipt ledger, and O(page-size) traversal |
| Concurrent or interrupted Receipt publication loses/duplicates history | Persistent kernel store control, exact marker plus reservation authorization, immutable generation-bound node before one atomic head swap, markerless validate-only retry, and marker cleanup last |
| Cursor selects another Profile, old generation, or orphan fork | HMAC-authenticated opaque cursor bound to Profile, ledger generation, immutable node digest, and sequence; append-only traversal from that canonical node |
| Missing index silently hides terminal Receipts | Bootstrap only an empty store under kernel control; never rebuild transaction-bearing state implicitly; malformed or inconsistent ledger state fails closed and requires explicit maintenance |
| Retention deletes current undo or audit state | Unexpired Plan self-pinning, Apply-reference protection after expiry, write-free exact preview, deterministic archive boundary, domain validation of every available Receipt, immutable source/target manifest, reachability and disjoint-generation checks, one head swap, safe-subset deletion reconciliation |
| Forged inverse metadata mutates arbitrary tabs as Undo | Strict causal invocation consent plus deterministic inverse-template and source-Receipt recomputation at admission and the final mutation boundary |
| A later Undo or failed transaction makes older history ambiguous | Causal stack reduction cancels only digest-bound successful forward/Undo pairs; uncertain outcomes stop eligibility and whole-Snapshot Drift still fails closed |
| Low disk wedges maintenance after it blocks Apply | Conservative maintenance reservation covers target nodes, manifest, result, and publication temporary before the maintenance gate is published |
| Backup or restore escapes its directory | Canonical containment, no symlinks, strict manifest schema and filename binding; restore remains preview-only until its narrow durable transaction exists |
| Malicious title controls the terminal | Renderer sanitization without mutating domain data |
| Malicious title or URL injects instructions into an agent | Explicit browser-untrusted data label, strict separation from instructions/issues, hostile-content fixtures |
| Semantic score is mistaken for certainty | Engine-specific calibration, margin, explicit opt-in, move cap, normal safety gates |
| Explicit Engine silently falls back | Typed unavailable result and user-visible remediation |
| Privileged endpoint belongs to another process | zts-owned launch receipt bound to binary, process start, Profile, endpoint, and short lifecycle |
| Privileged listener remains exposed | Random loopback port, no wildcard origin, bounded session, proven shutdown or managed quit |
| Model or package supply chain changes | Pinned versions and hashes, package audit, clean pack proof, model provenance and cache integrity |
| Private artifact becomes world-readable | Explicit `0700` directories, `0600` files, permission doctor and repair preview |

## Mutation invariants

Before the first operation, the Apply Transaction must prove:

1. Plan schema and digest are valid.
2. Apply Authorization covers this exact Plan digest, every executable action id, allowed Trust Classes, typed Protection grants, and any separate managed-Zen lifecycle grant.
3. Plan creation, authorization, and Receipt validation receive the actual validated Snapshot. Derived Profile, authority, freshness, Entity, Workspace, and Protection state plus configuration, intent, Engine/model, and calibration revisions match.
4. Every Entity identity, source Workspace, Protection decision, destination, move cap, and Capability precondition matches authoritative current state.
5. The selected Control Route is exclusively and safely available.
6. A durable transaction journal and required recovery artifact exist. When the route supports Undo, the exact inverse Plan bound to the deterministic complete after-Snapshot is durable before mutation becomes eligible.

After execution begins:

1. Verify each attempted Operation before continuing.
2. Stop on the first unexpected failure or Drift.
3. Never label an unverified move successful.
4. Record exact changed and unchanged outcomes.
5. Reuse the prepublished inverse Plan only after the exact complete after-Snapshot verifies; blocked and interrupted Receipts must not advertise it as executable Undo state.
6. Leave enough durable state for deterministic recovery after interruption.
7. Verify native and zts control release before publishing terminal lifecycle proof and the canonical Receipt; then settle the exact reservation idempotently and remove the unfinished marker last. Any uncertain commit or control release retains recovery work.

For Undo, the same boundary additionally reloads the source Receipt, source Plan, exact inverse template and Snapshot, causal ledger state, and typed invocation consent. It recomputes the one deterministic executable inverse Plan and rejects any digest, action, configuration, expiry, or lineage mismatch before the atomic swap.

## Privacy position

The user selected one full-detail information model for humans and agents. zts therefore exposes full titles and URLs by default when requested through its normal read surfaces. This is not permission to transmit data automatically. zts makes no network call to a cloud agent on the user's behalf, and callers remain responsible for where they send output. Optional masking and shareable diagnostics are explicit presentation features.

## Release gates

No mutation route is production-ready until it has:

- synthetic and redacted compatibility fixtures for every supported Entity kind
- Drift, concurrency, corruption, crash, and interruption tests
- backup, reopen, verification, undo, and recovery evidence
- owner-private artifact permission proof under permissive umask
- bounded memory and latency measurements at representative and stress profile sizes
- an independent security and source-of-truth review

Privileged live control additionally needs endpoint ownership, listener confinement, same-session Snapshot and execution, disconnect-at-each-operation tests, and documented evidence supporting either promotion or continued experimental status.
