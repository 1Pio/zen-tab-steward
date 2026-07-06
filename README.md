# Zen Tab Steward

Zen Tab Steward is a user-owned CLI for inspecting and backing up Zen Browser tab and workspace state. The command is `zts`.

This first tranche is deliberately conservative. It can discover the local Zen profile, parse `zen-sessions.jsonlz4`, report workspace/tab protection counts, create backups, and show a deterministic read-only sort preview. It does not write active Zen session files, move tabs, install a service, start a daemon, create a browser extension, or set up autostart.

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

`zts workspaces` lists workspace names, ids, tab counts, pinned counts, essential counts, and folder/group counts.

`zts backup` copies readable session-state files into:

```text
~/.local/state/zen-tab-steward/backups/<profile-id>/
```

Each backup includes timestamped `.bak` files and a timestamped `manifest.json` with file sizes, SHA-256 hashes, profile path, Zen running state, command, and `zts` version.

`zts sort [workspace] --preview` produces a safe read-only preview. It uses deterministic domain rules where a matching destination workspace exists, skips pinned tabs and essentials by default, and treats grouped/foldered tabs as protected so they are not split.

Preview and dry-run commands exit successfully because they do not write. Plain `zts sort [workspace]` still refuses apply with a nonzero exit until a safe live or offline backend is proven.

`zts config` inspects and updates the user config at:

```text
~/.config/zen-tab-steward/config.toml
```

Supported starter keys are `defaults.inbox`, `defaults.min_confidence`, `defaults.include_pinned`, and `defaults.apply_backend`.

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
zts backup --json
zts backup list --json
zts sort Space --preview --json
zts sort Space --dry-run --json
zts config show --json
zts rules test https://github.com/1Pio/zen-tab-steward --json
```

JSON output is structured for future Raycast and agent use. It includes version, command, success state, warnings, blockers, suggested next commands, and command-specific data.

## Safety Boundary

The current implementation is read/backup only.

- It reads Zen profile metadata and session files.
- It parses `mozLz40\0` JSONLZ4 session files.
- It copies files for backups.
- It refuses restore/apply paths.
- It refuses sort apply while Zen is running and no live backend exists.
- It does not mutate files inside the active Zen profile.

Pinned tabs and essentials are counted explicitly using Zen's observed `pinned` and `zenEssential` fields. Folder and group records are counted so later sorting can protect them as unsplittable entities.

## Development

```bash
npm test
npm run build
npm run smoke
```

The tests use synthetic JSONLZ4 fixtures and temporary directories. They do not depend on the user's real Zen profile.
