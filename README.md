# Zen Tab Steward

Zen Tab Steward is a user-owned CLI for inspecting, backing up, planning, and carefully sorting Zen Browser tab and workspace state. The command is `zts`.

The implementation is deliberately conservative. It can discover the local Zen profile, parse `zen-sessions.jsonlz4`, report workspace/tab protection state, create backups, show deterministic sort previews, and apply eligible tab moves through the offline session backend when Zen is closed. It does not write active Zen session files, install a service, start a daemon, create a browser extension, or set up autostart. The live backend is not implemented yet.

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

`zts bridge status` and `zts bridge doctor` inspect the live-backend boundary without changing Zen state. They report whether the current Zen browser process has any candidate privileged remote-control launch flags, list the current blockers, and still report live apply as unavailable until a safe browser-chrome execution client exists.

`zts bridge probe` launches a disposable headless Zen instance with a temporary profile, checks local WebDriver BiDi, creates a session, executes harmless script in a content context, executes harmless script in Zen browser chrome, verifies `gZenWorkspaces` is reachable, then terminates the process and removes the temporary profile. It is still a proof only: it does not attach to the live profile and does not move tabs.

`zts sort [workspace] --preview` produces a safe read-only preview. It uses deterministic domain rules where a matching destination workspace exists, skips pinned tabs and essentials by default, and represents grouped/foldered structures as single review entities so they are not split. Every sortable entity from the source workspace is classified as move, skip, review, or blocked.

Preview and dry-run commands exit successfully because they do not write. Preview is glance-oriented; dry-run prints the full action list with reasons and explanations. Use `--limit <count>` to cap planned move actions for a controlled proof; eligible overflow actions are kept in review with reason `over_move_limit`. Plain `zts sort [workspace]` and `zts sort [workspace] --apply` attempt to apply eligible planned moves using the selected backend. Today, only the offline session backend can apply, and only when Zen is closed and `zen-sessions.jsonlz4` is the selected session source. If Zen is running, apply refuses and shows the same plan plus blockers.

`zts review [workspace]` lists only the sort-plan items that need attention, including low-confidence items, move-limit overflow, and grouped/foldered aggregate entities. It is read-only and supports the same policy/filter flags as `zts sort`.

`zts apply list` lists offline sort-apply receipts for the discovered profile. `zts apply verify <receipt-id>` is read-only: it compares the receipt's recorded moves with the current selected session file and exits with status `2` if the recorded moves no longer match.

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

The current implementation has read, backup, preview, and offline session apply support.

- It reads Zen profile metadata and session files.
- It parses `mozLz40\0` JSONLZ4 session files.
- It copies files for backups.
- It restores backups only when Zen is closed.
- It refuses sort apply while Zen is running.
- It refuses live backend apply because no safe live bridge exists yet.
- It can inspect live-backend launch evidence with `zts bridge status` and `zts bridge doctor`, but those commands are read-only and do not enable live apply.
- It can run a disposable `zts bridge probe` against a temporary headless profile to verify WebDriver BiDi transport, script execution, and Zen chrome object reachability without touching live tabs.
- It creates a fresh backup before offline session mutation.
- It writes an apply receipt under the state directory after offline apply.
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
