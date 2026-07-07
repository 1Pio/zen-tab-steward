# Zen Tab Steward

Zen Tab Steward is a user-owned CLI for inspecting, backing up, planning, and carefully sorting Zen Browser tab and workspace state. The command is `zts`.

The implementation is deliberately conservative. It can discover the local Zen profile, parse `zen-sessions.jsonlz4`, report workspace/tab protection state, create backups, show deterministic sort previews, and apply eligible tab moves through the offline session backend when Zen is closed. It also has a gated live backend that drives exact one-tab live move proofs from the sort plan when Zen is running and attachable. It does not write active Zen session files, install a service, start a daemon, create a browser extension, or set up autostart.

## Install

```bash
npm install
npm run build
npm link
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
zts bridge live-move-proof
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

`zts workspaces` lists workspace names, ids, tab counts, pinned counts, essential counts, folder/group counts, protected status, default inbox status, sortable-from status, and sortable-to status.

`zts tabs [workspace]` lists tabs with title, URL, domain, workspace, pinned, essential, grouped/foldered, hidden, and protection metadata.

`zts backup` copies readable session-state files into:

```text
~/.local/state/zen-tab-steward/backups/<profile-id>/
```

Each backup includes timestamped `.bak` files and a timestamped `manifest.json` with file sizes, SHA-256 hashes, profile path, Zen running state, command, and `zts` version.

`zts backup restore <backup-id>` restores a saved backup only when Zen is closed. Restore preflights every backup target and hash before any profile write, creates a fresh safety backup of the current profile first, writes each restored file through a temp file and rename, verifies restored hashes, and writes a restore receipt.

`zts backup prune --before <iso-date>` and `zts backup prune --older-than <duration>` remove old zts-owned backup manifests and `.bak` files from the backup state directory. Use `--dry-run` to preview the exact backups and files that would be removed.

`zts bridge status` and `zts bridge doctor` inspect the live-backend boundary without changing Zen state. They report whether the current Zen browser process has any candidate privileged remote-control launch flags, list the current blockers, and show that live apply remains gated until the stricter attachment check passes.

`zts bridge live-check` is a stricter read-only attachment gate for the discovered live profile. It refuses unless Zen is running for the profile, a browser process explicitly matches the profile path, that browser process has candidate privileged remote-control launch flags, the profile has a local `WebDriverBiDiServer.json`, and that file points to a local-only WebDriver BiDi endpoint. It reports attachable only when `--connect` is used and WebDriver BiDi `session.status` succeeds. This command does not move tabs.

`zts bridge live-read` requires the same live attachment gate, then creates a WebDriver BiDi session and runs a read-only browser-chrome script against the live profile to verify the Zen chrome context, `gZenWorkspaces`, active workspace id, and workspace count. It does not move tabs or write Zen state.

`zts bridge live-move-proof` is the first gated live movement proof. It refuses unless you pass `--confirm-live-move`, `--url <exact-tab-url>`, `--from-workspace <workspace-id>`, and `--to-workspace <workspace-id>`, and the live attachment gate passes. It moves at most one exact URL match from the exact source workspace to the exact destination workspace, and refuses pinned, essential, grouped, foldered, ambiguous, unmatched, or same-workspace moves. `zts sort --backend live` uses the same proof machinery for each planned move after creating a backup and writing a live apply receipt.

`zts bridge probe` launches a disposable headless Zen instance with a temporary profile, checks local WebDriver BiDi, creates a session, executes harmless script in a content context, executes harmless script in Zen browser chrome, verifies `gZenWorkspaces` is reachable, performs one disposable temp-profile workspace tab move through Zen internals, then terminates the process and removes the temporary profile. It is still a proof only: it does not attach to the live profile and does not move live tabs.

`zts sort [workspace] --preview` produces a safe read-only preview. It uses deterministic domain rules where a matching destination workspace exists, skips pinned tabs and essentials by default, and represents grouped/foldered structures as single review entities so they are not split. Every sortable entity from the source workspace is classified as move, skip, review, or blocked.

Preview and dry-run commands exit successfully because they do not write. Preview is glance-oriented; dry-run prints the full action list with reasons and explanations. Use `--limit <count>` to cap planned move actions for a controlled proof; eligible overflow actions are kept in review with reason `over_move_limit`. Plain `zts sort [workspace]` and `zts sort [workspace] --apply` attempt to apply eligible planned moves using the selected backend. The session backend applies only when Zen is closed and `zen-sessions.jsonlz4` is the selected session source. The live backend applies only when Zen is running, the live attachment gate passes, and every planned tab move passes exact URL/workspace protection checks.

`zts review [workspace]` lists only the sort-plan items that need attention, including low-confidence items, move-limit overflow, and grouped/foldered aggregate entities. It is read-only and supports the same policy/filter flags as `zts sort`.

`zts apply list` lists sort-apply receipts for the discovered profile. Session receipts are reverified against the current selected session file with `zts apply verify <receipt-id>`, which exits with status `2` if recorded moves no longer match. Live receipts are reverified through a read-only live bridge check when the live attachment gate passes; if the current Zen process is not attachable, verification refuses with the live-check blockers instead of reading stale session files.

`zts config` inspects and updates the user config at:

```text
~/.config/zen-tab-steward/config.toml
```

Supported keys include `defaults.inbox`, `defaults.min_confidence`, `defaults.include_pinned`, `defaults.include_essentials`, `defaults.apply_backend`, `sort.from`, `sort.to`, `sort.not_to`, `sort.only`, `sort.except`, `protect.workspaces.from`, `protect.workspaces.to`, and `protect.domains.never_move`.

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
zts bridge live-move-proof --json
zts bridge probe --json
zts apply list --json
zts apply verify <receipt-id> --json
zts sort Space --preview --json
zts sort Space --dry-run --json
zts sort Space --dry-run --limit 3 --json
zts review Space --json
zts sort Space --backend session --json
zts config show --json
zts rules test https://github.com/1Pio/zen-tab-steward --json
```

JSON output is structured for future Raycast and agent use. It includes version, command, success state, warnings, blockers, suggested next commands, and command-specific data.

## Safety Boundary

The current implementation has read, backup, preview, offline session apply, and gated live apply support.

- It reads Zen profile metadata and session files.
- It parses `mozLz40\0` JSONLZ4 session files.
- It copies files for backups.
- It restores backups only when Zen is closed.
- It refuses offline session apply while Zen is running.
- It runs live apply only after the explicit live attachment gate and exact tab-safety checks pass.
- It can inspect live-backend launch evidence with `zts bridge status` and `zts bridge doctor`, but those commands are read-only.
- It can run `zts bridge live-check` as a read-only live-profile attachment gate; refusal is expected unless Zen was launched with the required remote-control flags and a local WebDriver BiDi server file exists.
- It can run `zts bridge live-read` as a read-only live-profile browser-chrome proof after the attachment gate passes; it does not move tabs.
- It can run `zts bridge live-move-proof` only with explicit confirmation and exact tab/workspace selectors; `zts sort --backend live` reuses that gated proof machinery.
- It can run a disposable `zts bridge probe` against a temporary headless profile to verify WebDriver BiDi transport, script execution, Zen chrome object reachability, and one temp-profile workspace tab move without touching live tabs.
- It creates a fresh backup before offline session mutation.
- It writes an apply receipt under the state directory after offline or live apply.
- It can list and re-verify apply receipts without writing Zen state.
- It creates a fresh safety backup and restore receipt before/after offline restore.
- It preserves unknown Zen session fields by mutating only planned tab workspace ids.
- It surfaces grouped/foldered tabs as aggregate review entities but does not apply grouped/foldered moves yet.
- It does not mutate files inside the active Zen profile while Zen is running.

Pinned tabs and essentials are counted explicitly using Zen's observed `pinned` and `zenEssential` fields. Folder and group records are counted and represented conservatively so later sorting can protect them as unsplittable entities.

See [docs/live-backend-investigation.md](docs/live-backend-investigation.md) for the current live-backend evidence and blocker receipt.

## Development

```bash
npm test
npm run build
npm run smoke
```

The tests use synthetic JSONLZ4 fixtures and temporary directories. They do not depend on the user's real Zen profile.
