# ADR-0006: Capability-tested Zen support

## Status

Accepted on 2026-07-10.

## Context

Zen is evolving and its session schema and browser internals can change independently of zts. Version strings alone do not prove that a specific Entity kind can be observed, moved, and verified safely.

## Decision

Mutation is supported only for Zen version, schema-family, Entity-kind, platform, Profile, and Control Route combinations with acceptance evidence. Adapters report granular Capabilities as available, unavailable, or unknown, with reasons and a durable proof artifact. Static acceptance and compatibility fixtures support the tested matrix but cannot claim present availability. Available Capabilities require runtime proof from the exact Snapshot capture; privileged-live proof also binds the process and control session. Every `move.*` Capability includes immediate exact post-state verification for that Entity kind. The Snapshot constructor rejects duplicate, stale, mismatched, unscoped, or live-unbound availability claims.

Unknown or changed shapes may produce explicitly labeled diagnostic reads when they can be bounded safely. Mutation fails closed. Version ranges summarize tested evidence; they do not override runtime shape validation or Capability proof.

Compatibility fixtures contain synthetic or redacted representative structures for tabs, groups, nested Zen folders, split views, pinned tabs, essentials, hidden tabs, and relevant failure shapes. Each promoted Control Route has read, plan, apply, verify, drift, recovery, and reopen evidence appropriate to its risk.

## Consequences

- Users receive precise capability explanations instead of unsupported-version guesses.
- A new Zen build can remain useful for safe inspection while mutation is gated.
- Release work includes a maintained compatibility matrix and recurring acceptance fixtures.
- Capability detection has higher leverage than scattered version checks.

## Options considered

- Support all versions matching a broad semantic range. Rejected because internal shape and behavior can change without a useful compatibility signal.
- Refuse all activity on an unknown version. Rejected because bounded diagnostic reads can still help users and maintainers.
- Treat successful attachment as proof of mutation support. Rejected because attachment does not prove Entity completeness, operation safety, or verification.

## Notes

The first compatibility evidence targets the owner's current macOS Zen installation, then expands across a documented supported window.
