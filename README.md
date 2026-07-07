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

`zts sort [workspace] --preview` produces a safe read-only preview. It uses deterministic domain rules where a matching destination workspace exists, skips pinned tabs and essentials by default, and treats grouped/foldered tabs as protected so they are not split. Every tab from the source workspace is classified as move, skip, review, or blocked.

Preview and dry-run commands exit successfully because they do not write. Preview is glance-oriented; dry-run prints the full action list with reasons and explanations. Plain `zts sort [workspace]` and `zts sort [workspace] --apply` attempt to apply eligible planned moves using the selected backend. Today, only the offline session backend can apply, and only when Zen is closed and `zen-sessions.jsonlz4` is the selected session source. If Zen is running, apply refuses and shows the same plan plus blockers.

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
zts sort Space --preview --json
zts sort Space --dry-run --json
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
- It creates a fresh backup before offline session mutation.
- It writes an apply receipt under the state directory after offline apply.
- It creates a fresh safety backup and restore receipt before/after offline restore.
- It preserves unknown Zen session fields by mutating only planned tab workspace ids.
- It does not mutate files inside the active Zen profile while Zen is running.

Pinned tabs and essentials are counted explicitly using Zen's observed `pinned` and `zenEssential` fields. Folder and group records are counted so later sorting can protect them as unsplittable entities.

See [docs/live-backend-investigation.md](docs/live-backend-investigation.md) for the current live-backend evidence and blocker receipt.

## Development

```bash
npm test
npm run build
npm run smoke
```

The tests use synthetic JSONLZ4 fixtures and temporary directories. They do not depend on the user's real Zen profile.
