# Zen Tab Steward

Zen Tab Steward is a user-owned CLI for inspecting, backing up, planning, and carefully sorting Zen Browser tab and workspace state. The command is `zts`.

The implementation is deliberately conservative. It can discover the local Zen Profile, inspect workspace/tab Protection state, create backups, turn deterministic rules or an exact caller Diff/Patch into one state-bound Plan, and exercise that Plan through a crash-recoverable closed-Zen transaction with Receipt-bound Undo. Closed-session authority comes from Zen/Gecko's native `.parentlock`, not from process absence. The macOS arm64 path now has fixture coverage for managed authoritative Diff capture, managed close/apply/reopen persistence verification, lifecycle recovery, and exact window restoration; a bounded owner-Profile managed Plan-only restart has also passed. This remains active production-readiness work, not a GA claim: a reversible owner-Profile managed Apply/Undo proof, broader compatibility, local-model Engines, privileged live mutation, release automation, and complete setup/doctor UX still need release evidence. zts does not install a service, daemon, browser extension, or autostart entry.

## Install

Current runtime contract: macOS, Node.js 22.12.0 or newer, and a local Zen Browser Profile. Node 22 and 24 are exercised in the release CI matrix. For a source checkout:

```bash
npm ci
npm run build
npm link
npm run test:memory
```

After linking, run:

```bash
zts --help
zts --version
zts status
zts workspaces
zts tabs
zts backup
zts bridge status
zts bridge live-check
zts bridge live-read
zts review
zts config path
zts rules
```

You can also run without linking:

```bash
node dist/cli.js status
```

## Commands

`zts status` reports:

- discovered profile path
- whether Zen is running
- selected session file source
- workspace, tab, pinned, essential, folder, and group counts
- backup/config paths
- current safety posture

Profile selection never falls back to arbitrary `profiles.ini` order. An exact
running Profile, one install default, one Firefox/Zen default, or a sole Profile
is selected automatically. If those signals are ambiguous, set
`ZTS_PROFILE=<exact-profile-id-or-unique-name>`; mutation remains blocked until
selection is explicit.

`zts workspaces` lists workspace names, ids, tab counts, pinned counts, essential counts, folder/group counts, protected status, default inbox status, sortable-from status, and sortable-to status.

`zts tabs [workspace]` projects the canonical Snapshot into full-detail tab rows with Entity revision/root identity, Workspace identity, title, URL, pinned, essential, hidden, active, Protection, and explicit `browser_untrusted` provenance.

`zts backup` copies readable session-state files into:

```text
~/.local/state/zen-tab-steward/backups/<profile-id>/
```

Each backup includes timestamped `.bak` files and a timestamped `manifest.json` with file sizes, SHA-256 hashes, profile path, Zen running state, command, and `zts` version.

`zts backup restore <backup-id>` currently performs a complete read-only restore preview: it validates every target, containment rule, file size, and hash, then exits with a production-disabled blocker without changing Profile bytes. Multi-file restore remains disabled until a narrow single-file durable restore transaction can provide the same crash and recovery guarantees as Plan apply.

`zts backup prune --before <iso-date>` and `zts backup prune --older-than <duration>` remove old zts-owned backup manifests and `.bak` files from the backup state directory. Use `--dry-run` to preview the exact backups and files that would be removed.

`zts bridge status` and `zts bridge doctor` inspect the live-backend boundary without changing Zen state. They report whether the current Zen browser process has any candidate privileged remote-control launch flags, list the current blockers, and show that live apply remains gated until the stricter attachment check passes.

`zts bridge live-check` is a stricter read-only attachment diagnostic for the discovered live profile. It validates matching process flags and a bounded, no-follow, local-only `WebDriverBiDiServer.json`, but currently refuses connection because zts does not yet have a launch receipt binding the endpoint to the exact Zen binary, PID/start identity, Profile, and confined listener. `--connect` therefore remains fail-closed rather than trusting a local port. This command does not move tabs.

`zts bridge live-read` remains disabled at that ownership gate and creates no privileged session. Its browser-chrome read implementation and disposable fixtures remain available for the future zts-owned managed launch, but an externally discovered endpoint is not trusted.

`zts bridge probe` launches a disposable headless Zen instance with a temporary profile, checks local WebDriver BiDi, creates a session, executes harmless script in a content context, executes harmless script in Zen browser chrome, verifies `gZenWorkspaces` is reachable, performs one disposable temp-profile workspace tab move through Zen internals, then terminates the process and removes the temporary profile. It is still a proof only: it does not attach to the live profile and does not move live tabs.

`zts sort [workspace] --preview` produces a safe read-only preview. It uses deterministic domain rules where a matching destination Workspace exists and protects pinned, essential, grouped, and foldered tabs by default. Every captured Movement Root from the source Workspace is classified as move, protected, review, blocked, or unchanged.

The production Plan path is available for exact-rule planning across every applicable Workspace:

```bash
zts sort --all --engine rules --preview
zts sort --all --engine rules --dry-run
zts plan show latest
```

Preview saves one owner-private, content-addressed domain Plan. Dry-run reuses that exact Plan and digest. If the Snapshot changes between the two commands, dry-run reports Snapshot Drift and preserves the reviewed Plan instead of silently regenerating it. Workspace Protection is directional, so a Workspace can remain usable as a source while protected as a destination. `--include-pinned` and `--include-essentials` may place those entities into the Plan, but their Operations retain Protection preconditions for explicit authorization. The paired `--no-include-pinned` and `--no-include-essentials` flags explicitly keep them protected when config defaults opt in.

Apply always targets one saved Plan. Calling `apply` without consent displays the exact digest and confirmation command. Selecting Operations first creates a new derived Plan with its own digest, which must be reviewed separately:

```bash
zts apply <plan-id>
zts apply <plan-id> --actions <action-id>,<action-id>
zts apply <derived-plan-id> --yes --expect-digest sha256:<exact-digest>
zts apply <plan-id> --yes --expect-digest sha256:<exact-digest> --manage-zen
```

The authoritative session Apply path reserves the complete bounded transaction footprint, then publishes a self-contained unfinished marker before lifecycle or Profile mutation. With `--manage-zen`, zts binds the exact ordinary Zen app, process tree, Profile, signature, and semantic windows; gracefully quits without force-kill; performs the existing closed-session transaction under Zen/Gecko's native `.parentlock`; reopens Zen; closes it once more to prove the exact planned state survived Zen's own load/flush cycle; and finally restores the exact app/Profile/window geometry. The second bounded restart is intentional: process and window readiness alone cannot prove that Zen accepted and persisted the moved tabs. Only after that authoritative persistence capture does zts publish one applied Receipt with all managed lifecycle statuses verified. Any uncertain commit, persistence mismatch, or incomplete final relaunch retains the unfinished marker for recovery and never reports applied.

Without `--manage-zen`, Zen must already be closed. In both routes, whole-Plan Drift, native-control contention, incomplete maintenance, capacity pressure, an unknown Zen version/schema, or any unavailable capability blocks before mutation. The exact provisional capability gate is documented in [docs/compatibility.md](docs/compatibility.md).

If the process is killed or the machine loses power between journal stages, recovery is inspect-first. Inspection is write-free. Explicit digest-bound finalization normally records evidence only, but may perform one atomic restorative swap to put back the exact external writer displaced by an interrupted zts swap; JSON and human output report that separately as a recovery mutation:

```bash
zts apply recover --json
zts apply recover <transaction-id> --json
zts apply recover <transaction-id> --yes --expect-recovery-digest sha256:<exact-inspection-digest> --json
```

The first command lists incomplete transactions from an owner-private unfinished index, independent of completed history size. The marker includes strictly validated, Plan-bound invocation consent and bootstrap state, so even a crash before the mutable journal exists remains recoverable without process-absence or timestamp guesses. Selecting one without `--yes` succeeds as a read-only inspection and shows its journal stage, Profile-lock state, exact recovery digest, canonical target fingerprint, and exact journal-owned atomic residue fingerprint. Finalization requires both `--yes` and that exact `--expect-recovery-digest`; any changed residue requires a new inspection. Managed recovery may close and restore only the exact marker-bound Zen replacement needed to finish lifecycle and persistence proof; it never silently adopts another app/Profile or replays a classified mutation. Terminal lifecycle proof and the canonical Receipt are published only after native and zts control release and final Zen restoration are verified. Reservation settlement is idempotent, and unfinished-marker removal is last.

Completed saved-Plan history is one immutable, content-addressed ledger with a tiny atomic head. An immutable generation-bound node is durable before one atomic head swap; the head binds the latest transaction and Receipt digest. The exact unfinished marker plus its reservation authorize a new append, while a markerless retry may only validate an identical already-reachable Receipt. History pages follow only the requested number of size-bounded nodes. Opaque HMAC cursors bind the Profile, ledger generation, sequence, and exact node digest, so an old generation or orphan fork cannot be selected:

```bash
zts apply list --limit 50
zts apply list --limit 50 --cursor <opaque-cursor>
```

Normal commands never reconstruct a missing Receipt head or unfinished index from transaction files. Only a genuinely empty fresh store may bootstrap accounting, the unfinished index, and an empty ready head under the same kernel control. Any transaction-bearing pre-index or missing-head store fails closed and requires an explicit future maintenance or migration operation; corruption is never reinterpreted as absence.

Apply-store retention is inspect-first and uses the same lean human/JSON split:

```bash
zts history retain
zts history retain --json
zts history retain --apply --yes --expect-inspection-revision sha256:<exact-preview-revision>
```

Preview is write-free. It validates every available full Receipt against its Plan, Authorization, journal, referenced artifacts, and causal Undo closure, then binds deterministic archive decisions and an exact deletion graph. A forward Receipt and its successful Undo are retained or evicted as one causal unit at the summary-count boundary; retention never leaves an unmatched Undo consumer. The mutating pass reserves its bounded maintenance footprint, builds a complete immutable ledger generation off-head, publishes one fixed source/target/deletion manifest, performs one head swap, and reconciles deletions idempotently. Receipts outside the default 30-day undo window become truthful `archived_summary_only` entries; full private payloads are deleted while bounded summaries remain. A crash with the source head discards only the prepared generation. A crash with the target head resumes the same manifest and fixed totals. Incomplete transactions, unsafe hardlink residue, manifest corruption, low capacity, or head Drift block rather than guessing.

An explicit, reserved, crash-resumable legacy or missing-head migration command is not implemented. This remains a release boundary for provisional stores created by older builds. Retention requires an existing valid ready head and unfinished index; malformed or missing canonical state fails closed.

Every successfully verified forward Apply stores a Receipt-bound inverse template. Undo is preview-first and reuses the canonical Apply Transaction rather than bypassing it:

```bash
zts undo latest --preview
zts undo <source-receipt-id> --preview --json
zts undo <source-receipt-id> --yes --expect-digest sha256:<exact-undo-plan-digest>
zts undo <source-receipt-id> --preview --accept-unrelated-drift
```

The executable Undo Plan is deterministically materialized from the exact source Receipt, forward Plan, inverse-template digest, current configuration, and current authoritative Snapshot. The mutation seam recomputes that binding at admission and again under exclusive control at the final commit boundary. Whole-Snapshot Drift fails by default. When a normal Zen reopen changes unrelated normalized state, `--accept-unrelated-drift` explicitly rematerializes the same exact inverse against the fresh Snapshot only if every affected Entity, revision, source, destination, Protection precondition, and causal binding still validates; the resulting new digest must be reviewed and supplied again at apply. An expired default 30-day window, archived full Receipt, affected-Operation drift, missing artifact, uncertain later mutation, or changed causal lineage still blocks before mutation. Successful tail Undo cancels its forward Receipt in the causal stack, so `undo latest` can continue to the previous still-active forward change; blocked and fully compensated attempts do not consume a source, while uncertain outcomes stop the stack. Direct Apply of inverse Plans and Undo-of-Undo are rejected. JSON retains full action detail; human output is bounded and points to JSON when more detail exists.

Plain `zts sort [workspace]`, `--preview`, and `--dry-run` are read-only Plan workflows. Preview is glance-oriented; dry-run reuses the reviewed Plan and prints the full action list with reasons and explanations. Use `--limit <count>` to cap move actions; eligible overflow remains visible as review. Mutation requires an already reviewed Plan plus `--apply --yes --expect-digest sha256:<exact-digest>`, and delegates to the same canonical Apply Transaction. The current fixture-tested adapter applies only while Zen is closed and the primary `zen-sessions.jsonlz4` source is under native Profile control. Selecting or configuring `live` never falls back to this route; an explicit `--backend session` can override a live-only preference after review.

`zts review [plan-selector]` defaults to `latest` and shows every review, protected, or blocked attention item from that exact saved Plan without capturing current browser state or regenerating planning intent. Its bound Snapshot is included in JSON so Entity refs retain full title/URL context. Exact rules have no synthetic confidence score; confidence thresholds become relevant only for confidence-producing Engines.

`zts snapshot --json` prints the normalized domain Snapshot with stable `entity:root:*` references for exact manual Patch planning. If Zen is running, the Snapshot is marked as a persisted observation and is not executable for apply.

Agents can submit the smaller revision-bound Diff DTO directly. Validate and review the exact saved Plan before applying it:

```bash
zts tabs --all --json
zts diff plan --stdin --manage-zen --json
zts apply <plan-id> --yes --expect-digest sha256:<exact-digest> --manage-zen --json
```

`diff plan --manage-zen` validates the complete input before lifecycle impact, writes a crash-recovery marker before quitting, captures a current authoritative Snapshot under native Profile control, refuses any listed Snapshot revision drift, persists exactly one new Plan, and restores the exact Zen app/Profile/window geometry. Recovery restores Zen only; it never creates a Plan. JSON reports both `captureZenRunning` and the post-command `zenRunning` state.

`zts patch plan <patch-file|-> --json` validates a caller-authored Patch against the current Snapshot and returns a digest-bound manual Plan. Public drafts stay lean: callers provide a reason string, while zts derives `caller_untrusted`/`data_only` provenance and binds the reason to that Operation's Entity ref. A parsed canonical Patch has both `schemaVersion` and `snapshotRevision`; stale, malformed, or unsupported canonical artifacts are refused rather than reinterpreted as drafts.

```json
{
  "operations": [
    {
      "op": "move",
      "entityRef": "entity:root:tab-...",
      "expectedSourceWorkspaceId": "workspace-inbox",
      "destinationWorkspaceId": "workspace-research",
      "reason": "Project-specific research"
    }
  ]
}
```

`zts patch plan <patch-file|->` also stores the resulting Plan. `zts patch apply <patch-file|-> --yes --expect-digest sha256:<reviewed-digest>` is a thin composition alias: it requires the exact unexpired reviewed Patch Plan and delegates to the canonical Apply Transaction. Patch and rules workflows therefore share locks, backup/recovery, verification, inverse Plan, Receipt, and history behavior.

`zts apply list` is the one canonical Receipt history for both rules and manual Patch Plans. `--limit` defaults to 50 and is capped at 500; JSON returns the next opaque cursor under `data.history.nextCursor`. `zts apply verify <receipt-id>` accepts canonical transaction Receipts and exits with status `3` when it cannot reacquire native Profile control or prove every recorded post-state from a current authoritative Snapshot.

`zts config` inspects and updates the user config at:

```text
~/.config/zen-tab-steward/config.toml
```

Supported keys include `defaults.inbox`, `defaults.min_confidence`, `defaults.include_pinned`, `defaults.include_essentials`, `defaults.apply_backend`, `sort.from`, `sort.to`, `sort.not_to`, `sort.only`, `sort.except`, `semantic.enabled`, `semantic.engine`, `semantic.suggestion_threshold`, `semantic.auto_apply`, `semantic.auto_apply_threshold`, `semantic.minimum_margin`, `semantic.max_moves`, `protect.workspaces.from`, `protect.workspaces.to`, and `protect.domains.never_move`.

The config uses a deliberately small, single-line TOML-like grammar: known sections and keys, double-quoted strings, booleans, non-negative decimal numbers, and arrays of double-quoted strings. Partial configs inherit defaults. Unknown or duplicate schema, malformed literals, and contradictory semantic policy fail closed; `suggestion_threshold` must be less than or equal to `auto_apply_threshold`. `semantic.engine` accepts `lexical`, `bge-small`, or `hybrid`. Files are capped at 1 MiB, strings at 4096 UTF-8 bytes, arrays at 256 entries, domain rules at 1024, and `semantic.max_moves` at 1000. Config edit commands validate both the existing and resulting document before preserving its comments and formatting. The config directory must be owner-only mode `0700` and an existing config file must be mode `0600`; reads never silently repair unsafe permissions. The error reports the exact `chmod 700` or `chmod 600` remediation for the user to review and run.

`zts rules` manages deterministic domain routing rules:

```bash
zts rules
zts rules add domain docs.example.com Research
zts rules test https://docs.example.com/page
```

Rules are stored in the config file and are used by `zts sort --preview`.

## JSON Output

Machine-readable output is available where useful:

```bash
zts status --json
zts workspaces --json
zts tabs Space --json
zts backup --json
zts backup list --json
zts backup prune --dry-run --older-than 30d --json
zts bridge status --json
zts bridge doctor --json
zts bridge live-check --json
zts bridge live-check --connect --json
zts bridge live-read --json
zts bridge probe --json
zts apply list --json
zts apply list --limit 50 --cursor <opaque-cursor> --json
zts apply verify <receipt-id> --json
zts sort Space --preview --json
zts sort Space --dry-run --json
zts sort --all --engine rules --preview --json
zts sort --all --engine rules --dry-run --json
zts plan show latest --json
zts sort Space --dry-run --limit 3 --json
zts review latest --json
zts sort Space --apply --yes --expect-digest sha256:<reviewed-digest> --json
zts patch plan patch.json --json
zts patch apply patch.json --yes --expect-digest sha256:<reviewed-digest> --json
zts config show --json
zts rules test https://github.com/1Pio/zen-tab-steward --json
```

JSON output is structured for future Raycast and agent use. It includes version, command, success state, warnings, blockers, suggested next commands, and command-specific data.

Exit codes are stable across human and JSON modes: `0` means completed or valid read-only output, `1` means invocation/config/input validation failed, `2` means safely blocked before mutation or explicit review is required, `3` means mutation or verification failed or is uncertain, and `4` means unexpected internal, I/O, corruption, or compatibility failure.

`npm run test:memory` first builds fresh output, then runs the opt-in memory acceptance probes. The current probes separately cover representative capture/Plan encoding, a 10,000-tab low-compression image, the 500-Operation transaction cap, crash recovery at that Operation limit, an approximately 18 MiB real-shape backup source, and a 63.5 MiB raw source near the 64 MiB backup ceiling. Reported `maxRSS` is the Node worker and does not include the short-lived macOS atomic-rename helper.

## Safety Boundary

The current implementation has canonical full-detail reads, durable backup, unified Plan preview/apply, crash recovery, canonical Receipt history, read-only live attachment evidence, and a disposable-profile bridge probe. User-Profile live mutation is not exposed outside Apply Transaction.

- It reads Zen profile metadata and session files.
- It parses `mozLz40\0` JSONLZ4 session files.
- It copies files for backups.
- It validates restore backups without mutating; production restore is intentionally disabled pending a durable restore transaction.
- It refuses closed-session apply unless the same live native `.parentlock` lease brackets authoritative read, commit, and verification.
- It can manage an explicitly authorized exact Zen quit/reopen lifecycle for authoritative Diff planning and Apply; managed Apply proves persistence through a second bounded load/flush cycle before reporting applied.
- It can inspect live-backend launch evidence with `zts bridge status` and `zts bridge doctor`, but those commands are read-only.
- It can run `zts bridge live-check` as a read-only live-profile attachment gate; refusal is expected unless Zen was launched with the required remote-control flags and a local WebDriver BiDi server file exists.
- It can run `zts bridge live-read` as a read-only live-profile browser-chrome proof after the attachment gate passes; it does not move tabs.
- It can run a disposable `zts bridge probe` against a temporary headless profile to verify WebDriver BiDi transport, script execution, Zen chrome object reachability, and one temp-profile workspace tab move without touching live tabs.
- It publishes a content-addressed backup and recovery descriptor before closed-session mutation.
- It stores production Plan artifacts under an owner-only state root using `0700` directories, `0600` files, bounded handle-based reads, content binding, fsync, and atomic publication.
- It publishes canonical transaction Receipts into one generation-bound linked ledger.
- It can list Receipts in bounded pages and re-verify them without writing Zen state.
- It previews and applies bounded Receipt retention through one exact crash-resumable manifest.
- It preserves unknown Zen session fields by mutating only planned tab workspace ids.
- It protects grouped/foldered tabs from closed-session mutation until native structured-Entity capture and verification are implemented.
- It does not mutate files inside the active Zen profile while Zen is running.

Pinned tabs and essentials are counted explicitly using Zen's observed `pinned` and `zenEssential` fields. Folder and group records are counted and represented conservatively so later sorting can protect them as unsplittable entities.

See [docs/live-backend-investigation.md](docs/live-backend-investigation.md) for the current live-backend evidence and blocker receipt.

## Development

```bash
npm test
npm run build
npm run smoke
```

The smoke command runs only against a temporary fixture profile, home, config, and state directory. It does not inspect or mutate the installed Zen profile.

The tests use synthetic JSONLZ4 fixtures and temporary directories. They do not depend on the user's real Zen profile.
