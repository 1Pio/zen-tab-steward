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

### Engines

Rules, lexical classification, local embeddings, hybrid classification, and agent-authored decisions propose destinations only. Their evidence is recorded in Plan with explicit provenance and data-only interpretation. Engine output never crosses the mutation seam directly.

### Artifact store

Artifacts may contain full private browser state. zts-owned directories use mode `0700`; files use `0600`. The store rejects symlinks, unexpected file types, oversized content, unknown schemas, identifier collisions, path escape, and payload-to-filename mismatch. Durable publication uses exclusive temporary files, file sync, atomic rename, and directory sync.

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
| Zen starts during closed-session apply | Profile lock, process recheck at transaction boundaries, fail or recover before publication |
| Crash leaves partial file or no audit trail | Durable journal before mutation, atomic publication, recovery state, exact partial Receipt |
| Two zts processes apply concurrently | Exclusive Profile transaction lock with stale-lock and PID-reuse handling |
| Backup or restore escapes its directory | Canonical containment, no symlinks, strict manifest schema and filename binding |
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
6. A durable transaction journal and required recovery artifact exist.

After execution begins:

1. Verify each attempted Operation before continuing.
2. Stop on the first unexpected failure or Drift.
3. Never label an unverified move successful.
4. Record exact changed and unchanged outcomes.
5. Publish an inverse Plan when supported; label compensation as best effort.
6. Leave enough durable state for deterministic recovery after interruption.

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
