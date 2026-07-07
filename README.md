# Zen Tab Steward

Zen Tab Steward is a user-owned CLI for inspecting, backing up, previewing, and carefully sorting Zen Browser tabs and workspaces. The command is `zts`.

The implementation is deliberately conservative. It can discover the local Zen profile, parse `zen-sessions.jsonlz4`, report workspace/tab protection state, create backups, show a glanceable sort preview, route tabs via deterministic rules plus an optional local semantic-affinity fallback, and apply eligible tab moves through the offline session backend when Zen is closed. It also has a gated live backend that drives Zen's own internal workspace move via a local WebDriver BiDi bridge when Zen is running and attachable. It never writes active Zen session files, installs a service, starts a daemon, creates a browser extension, or sets up autostart.

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
zts sort --preview
zts backup
zts bridge doctor
zts review
zts config path
zts rules
```

You can also run without linking:

```bash
node dist/cli.js status
```

## Commands

`zts status` reports the discovered profile path, whether Zen is running, the selected session source, workspace/tab/pinned/essential/folder/group counts, backend readiness, and the current sort posture in one scannable block.

`zts workspaces` lists workspaces as a compact aligned table with pinned/grouped/essential counts and inbox/protected markers. Use `--json` for ids and full metadata.

`zts tabs [workspace]` lists tabs as one scannable line per tab with `P`/`E`/`G`/`F` markers (pinned/essential/grouped/foldered). Use `--json` for full metadata.

`zts backup` copies readable session-state files into:

```text
~/.local/state/zen-tab-steward/backups/<profile-id>/
```

Each backup includes timestamped `.bak` files and a timestamped `manifest.json` with file sizes, SHA-256 hashes, profile path, Zen running state, command, and `zts` version.

`zts backup restore <backup-id>` restores a saved backup only when Zen is closed. Restore preflights every backup target and hash before any profile write, creates a fresh safety backup of the current profile first, writes each restored file through a temp file and rename, verifies restored hashes, and writes a restore receipt.

`zts backup prune --before <iso-date>` and `zts backup backup prune --older-than <duration>` remove old zts-owned backup manifests and `.bak` files from the backup state directory. Use `--dry-run` to preview the exact backups and files that would be removed.

### Sorting tabs

`zts sort [source-workspace]` is the main command. It defaults to a **glanceable preview** — never a surprise write.

```bash
zts sort                 # preview the configured inbox workspace
zts sort Space           # preview a named source workspace
zts sort Space --dry-run # full operational plan (every action with reasons)
zts sort Space --apply   # apply all safe moves (respects protection + confidence + filters)
zts sort Space --apply --limit 3   # apply a small confident batch first
zts sort Space --apply --yes       # skip the interactive confirmation (agents/scripts)
```

The preview groups moves by destination with confidence, sample titles, a compact protected summary, and review items with suggested destinations — so you can genuinely see what will move where before committing.

`--apply` is the single write trigger. It applies every move that passes the safety rules: pinned and essential protection (unless `--include-pinned` / `--include-essentials`), the confidence threshold (`--min-confidence`), destination policy (`--to` / `--not-to`), and source filters (`--only` / `--except`). Combining `--apply` with those flags gives full granular control; `--apply` alone is "apply everything safe".

Filter flags work the same for preview, dry-run, and apply:

```bash
zts sort Space --only github.com,*.framer.com
zts sort Space --except youtube.com,chatgpt.com
zts sort Space --to Portfolio,Tool Development --not-to Stash
zts sort Space --min-confidence 0.85
zts sort Space --include-pinned
```

On a TTY, `--apply` asks for a confirmation before writing; pass `--yes` to skip it (Raycast, agents, scripts). A timestamped backup is always created before any write, and an apply receipt is written under the state directory.

`zts review [workspace]` lists only the sort-plan items that need attention — low-confidence items, move-limit overflow, and grouped/foldered aggregate entities. It is read-only.

`zts apply list` lists sort-apply receipts. `zts apply verify <receipt-id>` re-verifies recorded moves against the current session and exits with status `2` if they no longer match. Live receipts are reverified through a read-only live bridge check when the live attachment gate passes.

### Backends

`zts sort --backend auto` (default) picks the session backend when Zen is closed and the live backend when Zen is running. `--backend session` forces the offline session backend. `--backend live` forces the live backend.

- **Session backend**: mutates `zen-sessions.jsonlz4` only when Zen is closed, after a fresh backup, and verifies every recorded move. Preserves all unknown session fields.
- **Live backend**: drives Zen's own `gZenWorkspaces.moveTabToWorkspace(...)` through a local WebDriver BiDi bridge. Gated behind an explicit attachment check and per-tab safety checks. See the bridge section below.

### The live bridge (optional, opt-in)

The live backend needs Zen itself to accept a local remote-control connection. A normally-launched Zen does not expose one, so `zts sort --apply` falls back to "preview only" while Zen is running. This is an intentional safety boundary, not a bug.

`zts bridge status` and `zts bridge doctor` inspect the boundary read-only and list the exact blockers. `zts bridge doctor` also prints the **opt-in launch hint** — the exact command to relaunch Zen with local remote debugging flags so the live backend can attach. It is local-only and security-sensitive; `zts` never relaunches Zen for you:

```bash
zts bridge doctor   # shows the opt-in launch command and current blockers
```

`zts bridge live-check [--connect]` is the stricter read-only attachment gate. `zts bridge live-read` and `zts bridge live-move-proof` prove read and one-tab-move access after the gate passes. `zts bridge probe` runs a disposable headless Zen proof that does not touch your live profile.

### Config and rules

`zts config` inspects and updates the user config at:

```text
~/.config/zen-tab-steward/config.toml
```

`zts rules` manages deterministic domain routing rules used by sorting:

```bash
zts rules
zts rules add domain docs.example.com Research
zts rules test https://docs.example.com/page
```

Routing rules are the single source of truth for deterministic destinations — `zts` ships no built-in domain assumptions, so it works for anyone's workflow.

### Semantic sorting (rules-first, similarity fallback)

Rules are exact but tedious for the long tail of tabs. Semantic sorting adds a workspace-affinity fallback: when a tab matches no deterministic rule, `zts` compares it against each destination workspace's profile (its name, its rule domains, and a sample of its existing tabs) and routes the tab if one workspace is clearly the best fit.

Rules always win. Semantic only fills the gap, and it is gated by confidence and margin so uncertain matches fall through to review instead of becoming bad moves.

```bash
zts sort Space --semantic --preview   # one-shot semantic plan
zts sort Space --semantic --apply     # apply confident semantic + rule moves
zts index                             # build/refresh the local embeddings index
zts embeddings status                 # show active provider and index state
```

Make it the default via config:

```toml
[semantic]
enabled = true        # always use semantic as a fallback when sorting
auto_index = true     # refresh the index on every sort
min_confidence = 0.78 # auto-move only above this
min_margin = 0.10     # and only when the top workspace beats the runner-up by this
review_on_tie = true  # send close calls to review instead of moving
```

Field weights are configurable too (`[embeddings.weights]` title/url/domain/description).

**Providers.** The default `built-in` provider is a zero-dependency, offline, field-aware lexical embedder (TF-IDF + char n-grams). It is genuinely strong for tab routing because domains, product names, and path tokens are highly discriminative. For true synonym-level matching, an opt-in local neural provider (`bge-small-en-v1.5` via Transformers.js) can be enabled:

```bash
npm install @huggingface/transformers   # in the zts install directory
zts embeddings install bge-small        # downloads the model into the cache dir
zts config set embeddings.provider hybrid
```

The neural provider is strictly opt-in. The default install and the default `zts sort` never download anything, and `zts sort --semantic` works with the built-in provider alone. If a neural provider is configured but not installed, `zts` refuses with the exact install steps rather than silently downgrading.

Hybrid scoring combines the three signals (`0.45 lexical + 0.40 dense + 0.15 domain-affinity`); when dense is unavailable the dense weight is redistributed across the others so the built-in provider is fully useful on its own.

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
zts sort Space --json
zts sort Space --dry-run --json
zts sort Space --apply --yes --json
zts review Space --json
zts sort Space --backend session --json
zts config show --json
zts rules test https://github.com/1Pio/zen-tab-steward --json
```

The sort envelope reports `mode` (`preview`, `dry-run`, or `apply`) and an `apply` object with `ready`, `backend`, and `receipt`. JSON output is structured for future Raycast and agent use: version, command, success state, warnings, blockers, suggested next commands, and command-specific data.

## Safety Boundary

The current implementation has read, backup, preview, offline session apply, and gated live apply support.

- It reads Zen profile metadata and session files.
- It parses `mozLz40\0` JSONLZ4 session files.
- `zts sort` defaults to a read-only preview; writes happen only with `--apply`.
- It copies files for backups.
- It restores backups only when Zen is closed.
- It refuses offline session apply while Zen is running.
- It runs live apply only after the explicit live attachment gate and exact tab-safety checks pass.
- On a TTY, `--apply` asks for confirmation; `--yes` skips it for agents/scripts.
- It can inspect live-backend launch evidence with `zts bridge status` and `zts bridge doctor` (read-only); `doctor` prints the opt-in relaunch command for users who want the live backend.
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
