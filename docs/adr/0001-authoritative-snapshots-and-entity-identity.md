# ADR-0001: Authoritative Snapshots and Entity identity

## Status

Accepted on 2026-07-10.

## Context

Zen keeps active browser state in memory and persists session artifacts asynchronously. A file can be readable while its contents lag the running browser. The legacy implementation also identifies tabs partly by array index or URL, both of which can drift or be ambiguous. Plans cannot be safely executed against that model.

## Decision

Executable Plans require an authoritative Snapshot captured either from the verified live Control Route used for apply or from a stable closed Profile while zts holds Zen/Gecko's native `.parentlock`. Process absence and a zts-only lock are not Profile authority. The closed-session capture owns the complete boundary: acquire the native lease, assert its canonical inode, read the exact primary JSONLZ4 source, assert the lease again, normalize, and release. A serializable proof is audit evidence only; only the live module-issued lease can mint authority. Every other disk read is a Persisted Observation and cannot satisfy an apply precondition.

Every Entity receives an opaque Snapshot-scoped reference and a revision digest derived from canonical content. Native Zen identity is retained when available, but URL-only and tab-index-only identity are forbidden for mutation. Plan Operations carry exact Entity and Workspace Protection revisions and source/destination preconditions.

Folders, tab groups, and split views are first-class Entities. Direct tab-member ownership is non-overlapping. Nested folders are structural child nodes under one top-level Movement Root. Only the Movement Root may enter a Patch or executable Operation, and its canonical revision includes its complete ordered descendant closure. Snapshot revision is derived from normalized Profile identity, ordered Workspaces, and ordered Entity revisions, excluding observation timestamps and proof artifacts.

Profile identity is an opaque digest of the canonical Profile directory target, not its basename. The raw path remains Adapter-private, while the derived id binds Snapshot, Plan, artifact store, and lock identity. A symlink retarget or a same-named cloned Profile therefore fails the existing binding instead of reusing its mutable authority.

At the migration boundary, mutation reconstructs every pre-canonical identity from the configured `profiles.ini` paths that still resolve to the selected physical Profile. Any unfinished legacy transaction or legacy lock under those ids and paths blocks new mutation for explicit audit.

## Consequences

- Read and preview remain available from explicitly labeled Persisted Observations when native Profile control is unavailable.
- Apply must reacquire or retain an authoritative Snapshot before the first mutation.
- Plan creation derives Snapshot identity, authority, freshness, Entity revisions, Workspace identities, and Protection preconditions from an actual validated Snapshot. Apply Authorization and Receipt validation require that same exact Snapshot binding.
- Adapters normalize Zen-specific shapes before they cross the Snapshot seam.
- Raw session indices, file modification times, and URLs may support diagnostics but cannot establish executable identity.
- Snapshot construction validates proof scope, structural reachability, child ownership, cycles, member ownership, and root closure before freezing the Snapshot.
- Profile discovery and every authoritative Snapshot/lock boundary revalidate the canonical path-derived Profile id.

## Options considered

- Trust the newest session file even while Zen runs. Rejected because freshness is not proven.
- Use URL plus source Workspace as identity. Rejected because duplicate URLs and live navigation make it ambiguous.
- Treat each tab as independent. Rejected because it can destroy user-created folders, groups, and split views.

## Notes

The contract is provisional until exercised by the manual Patch vertical slice and supported Zen fixtures.
