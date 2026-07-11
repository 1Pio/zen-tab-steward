# Zen compatibility and capability matrix

This matrix is deliberately exact. A matching version string alone does not
authorize mutation. `zts` also binds the selected Profile, platform and OS ABI,
parsed session schema family, Entity kind, source bytes, and native Profile
control into the runtime Snapshot capability proof.

## Current closed-session tab gate

| Platform | Zen version | Build id | OS ABI | Schema family | Entity kind | Route | Capability posture |
| --- | --- | --- | --- | --- | --- | --- | --- |
| macOS arm64 | 1.19.3b | 20260315063056 | `Darwin_aarch64-gcc3` | `zen-session-v1` | standalone tab with one unique native id | closed session | Fixture, crash/recovery, bounded owner-Profile apply/reopen/Undo/reopen, and clean-consumer packaging accepted 2026-07-11; release automation remains |
| macOS arm64 | 1.19.3b | 20260315063056 | `Darwin_aarch64-gcc3` | `zen-session-v1` | standalone tab with one unique native id | managed closed session | Exact app/Profile/process/window fixture and crash-recovery gates accepted; bounded owner-Profile authoritative Diff Plan, managed Apply, persisted reopen, exact reverse Diff, and restored reopen accepted 2026-07-11; managed Undo CLI parity remains |
| macOS x64 | 1.19.3b | 20260315063056 | `Darwin_x86_64-gcc3` | `zen-session-v1` | standalone tab with one unique native id | closed session | Provisional fixture-tested candidate; runtime proof required |

The exact gate above allows a current authoritative Snapshot to report
`move.tab` as available. It is not a GA declaration. The arm64 row targets the
owner's current installation and has passed a reversible one-tab proof with a
safety backup, authoritative closed-session Apply, real reopen persistence,
default whole-Plan Drift refusal after Zen rewrote unrelated state, explicit
exact-inverse drift rebase, verified Undo Receipt, causal history, and a second
reopen that retained the restored Workspace. The same source candidate also
passed a fresh package build, allowlisted tarball inspection, clean-consumer
installation, packaged CLI smoke, and packaged read-only acceptance against the
running owner Profile. Repeatable release automation and signed/published
artifacts remain separate gates. The x64 row is contract-fixture coverage and
still needs its own real installation acceptance.

The managed arm64 candidate uses normal app termination only and never force
kills Zen. It restores the exact signed app, Profile, and semantic window
geometry. Apply uses two bounded restart cycles because the second authoritative
closed capture is the evidence that Zen itself loaded and persisted the planned
Workspace state; a stable process/window alone is not persistence proof.

Grouped tabs, Zen folders, nested folders, and split views are normalized for
inspection and planning, but closed-session mutation for those Entity kinds is
not yet available. A standalone tab without one unique stable native id remains
visible as observation-only and cannot become an Operation.

## Unknown or changed Zen builds

An absent or malformed `compatibility.ini`, any other Zen version or build, an
OS ABI mismatch, a platform mismatch, or an unrecognized session schema makes
`move.tab` `unknown`. Read-only inspection remains available when the input can
still be parsed and bounded safely. Apply fails the whole Plan before mutation;
`zts` never guesses a compatible version range or silently falls back to a
different route.

Adding a matrix row requires representative fixtures plus read, Plan, Apply,
whole-Plan Drift, crash/recovery, verification, normal reopen, and undo evidence
for the exact route and Entity kind. Release support additionally requires a
clean-install proof and bounded real-Profile acceptance.
