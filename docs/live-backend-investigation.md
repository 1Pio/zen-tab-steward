# Live Backend Investigation

Date: 2026-07-07

`zts` now has two apply backends. The offline session backend mutates `zen-sessions.jsonlz4` only when Zen is closed. The live backend is implemented behind explicit attachment and tab-safety gates; it is expected to refuse on a normal running Zen process that was not launched with the required local WebDriver BiDi access.

`zts bridge status` and `zts bridge doctor` make this boundary explicit in the CLI. They are read-only inspection commands; they do not start Zen, attach to a debugger, open sockets, write profile files, install a service, install a mod, or move tabs.

`zts bridge live-check` is the stricter live-profile attachment gate. It is also read-only. It refuses unless all of the following are true:

- Zen is running for the discovered profile.
- A browser process explicitly matches the discovered profile path.
- The matching browser process has candidate remote transport launch evidence.
- The matching browser process has `--remote-allow-system-access`.
- The profile contains `WebDriverBiDiServer.json`.
- The server file contains a usable local-only `ws_host` and `ws_port`.

Without `--connect`, a clean preflight is still not enough to report attachable, because the server file can be stale. With `--connect`, it also opens the local WebSocket and runs only WebDriver BiDi `session.status`; only that connected check can produce an attachable receipt. It does not create a BiDi session, execute chrome script, move tabs, or write profile files.

`zts bridge live-read` goes one read-only step further after the attachment gate passes. It creates a WebDriver BiDi session, queries the browser chrome context, and evaluates a read-only expression that reports:

- `location.href` for the chrome context,
- whether `gZenWorkspaces` exists,
- `typeof gZenWorkspaces`,
- `gZenWorkspaces.activeWorkspace`,
- `gZenWorkspaces.getWorkspaces().length`.

It does not call any workspace mutation method, open tabs, move tabs, write profile files, or install extensions/mods/services.

`zts bridge live-move-proof` is the first gated live movement proof. It requires:

- `--confirm-live-move`,
- `--url <exact-tab-url>`,
- `--from-workspace <workspace-id>`,
- `--to-workspace <workspace-id>`,
- the same live attachment gate as `live-read`.

The proof searches live `gBrowser.tabs` for exactly one tab whose current URI exactly matches the requested URL and whose `zen-workspace-id` exactly matches the requested source workspace. It refuses pinned, essential, grouped, foldered, ambiguous, unmatched, missing-workspace, and same-workspace moves before calling `gZenWorkspaces.moveTabToWorkspace(...)`. After the move call, it verifies the tab's `zen-workspace-id` equals the requested destination. `zts sort --backend live` now reuses this proof for each planned move after the live attachment gate passes.

`zts bridge probe` is a separate disposable bridge proof. It starts a headless Zen process with a temporary profile, local remote debugging flags, and `--remote-allow-system-access`, verifies WebDriver BiDi `session.status`, creates a session, executes harmless script in a content context, executes harmless script in Zen browser chrome, verifies `gZenWorkspaces` is reachable, performs one temp-profile workspace tab move through Zen internals, then terminates the process and removes the temporary profile. It does not attach to the live profile or move live tabs.

## Local Evidence

The installed Zen app bundle contains packed browser resources:

```text
/Applications/Zen.app/Contents/Resources/omni.ja
/Applications/Zen.app/Contents/Resources/browser/omni.ja
```

The `browser/omni.ja` archive can be partially inspected with `unzip` despite central-directory warnings. Extracting Zen modules to a temporary directory showed internal workspace code and APIs, including:

```text
modules/zen/ZenSpace.mjs
modules/zen/ZenSpaceIcons.mjs
modules/zen/ZenSpaceCreation.mjs
modules/zen/ZenWindowSync.sys.mjs
modules/zen/ZenLiveFoldersManager.sys.mjs
```

Relevant observed internal calls include:

```text
gZenWorkspaces.changeWorkspaceWithID(...)
gZenWorkspaces.saveWorkspace(...)
gZenWorkspaces.removeWorkspace(...)
ZenWindowSync.moveTabsToSyncedWorkspace(...)
```

This supports the product assumption that Zen has internal workspace movement behavior. It does not prove that a standalone CLI can safely invoke that behavior while Zen is running.

The local Zen binary also exposes candidate Firefox remote-control flags:

```text
--start-debugger-server [ws:][ <port> | <path> ]
--marionette
--remote-debugging-port [<port>]
--remote-allow-hosts <hosts>
--remote-allow-origins <origins>
--remote-allow-system-access
```

The currently running Zen browser process on this machine was not launched with remote debugging, debugger server, Marionette, or `--remote-allow-system-access` flags. That means there is no current privileged remote execution surface to safely test against.

A disposable temp-profile probe showed that Zen prints:

```text
WebDriver BiDi listening on ws://127.0.0.1:<port>
```

The actual WebDriver BiDi WebSocket endpoint is:

```text
ws://127.0.0.1:<port>/session
```

Sending `session.status` to that endpoint returned a successful readiness response:

```json
{"type":"success","id":1,"result":{"ready":true,"message":""}}
```

Creating a BiDi session and querying chrome scope also worked in the disposable profile:

```text
browsingContext.getTree {"moz:scope":"chrome"} -> chrome://browser/content/browser.xhtml
script.evaluate in that chrome context -> typeof gZenWorkspaces === "object"
```

A disposable workspace operation through Zen internals also worked:

```text
gZenWorkspaces.createAndSaveWorkspace("ZTS Probe Target", ...)
gBrowser.addTab("about:blank", ...)
gZenWorkspaces.moveTabToWorkspace(tab, sourceWorkspaceId)
```

The probe validates that the disposable tab started in the target workspace, ended in the source workspace, moved via Zen's own method, was present in the source workspace container after the move, and was not pinned or essential.

## Current Blocker

The live movement backend is implemented behind attachment and tab-safety gates, but it has not yet been proven against the user's current real Zen process because the running process is not attachable.

Until the intended live Zen profile/window is attachable, `zts sort --backend live` must continue to refuse before mutation. The project must still avoid UI automation, extension setup, Zen mod installation, daemon/autostart setup, and active session-file writes.

`zts bridge doctor` records the current blockers:

```text
Live sort apply requires an attachable Zen bridge; run zts bridge live-check --connect for the current gate receipt
Current Zen browser process has no remote debugging, debugger server, or Marionette launch flag
Current Zen browser process has no privileged remote system-access launch flag
```

`zts bridge live-check` adds the live attachment blockers. On the current live profile that includes the missing local BiDi server file:

```text
/Users/main/Library/Application Support/zen/Profiles/4le6r9n3.Default (release)/WebDriverBiDiServer.json does not exist.
```

## Current Safe Behavior

When Zen is running:

```bash
zts sort Space --json
```

uses the auto-selected live backend. On the current live profile it still returns a plan and refuses apply, because the running Zen process is not attachable:

```text
No browser process explicitly matched the discovered profile path.
No matching browser process has remote debugging, debugger server, or Marionette launch evidence.
No matching candidate browser process has --remote-allow-system-access.
WebDriverBiDiServer.json does not exist.
```

Live apply receipts can be reverified only through the same live attachment boundary. `zts apply verify <live-receipt-id>` is read-only, inspects current live tab URL/workspace state through WebDriver BiDi, and refuses with the live-check blockers when the running Zen process is not attachable.

When Zen is closed:

```bash
zts sort Space --backend session --json
```

uses the offline session backend, creates a fresh backup, mutates only planned tab workspace ids in `zen-sessions.jsonlz4`, writes an apply receipt, and verifies the recorded moves.

## Next Safe Live-Backend Spike

The next live-backend spike should stay narrow until it can prove on the real profile:

- how to address the intended Zen window/profile,
- how to launch or attach to the live profile with local WebDriver BiDi without services, extensions, mods, or autostart items,
- how to move one intentionally selected low-risk live tab through `zts sort --backend live --limit 1`,
- how to verify the move from Zen state after the call and preserve the receipt,
- how to fail closed without installing services, extensions, mods, or autostart items.

## User-Owned Opt-In Path

`zts bridge doctor` prints the exact relaunch command for a user who wants to try the live backend against their own profile. `zts` never relaunches Zen itself. The command is local-only and security-sensitive, and is the only currently-known way to make a running Zen attachable without an extension, mod, service, or autostart item:

```bash
/Applications/Zen.app/Contents/MacOS/zen \
  --profile "<profile-path>" \
  --remote-debugging-port 9222 \
  --remote-allow-hosts 127.0.0.1,localhost \
  --remote-allow-origins '*' \
  --remote-allow-system-access
```

After relaunch, `zts bridge live-check --connect` reports whether the profile is now attachable, and `zts sort --backend live --limit 1 --apply --yes` can move one verified low-risk tab through Zen's own `gZenWorkspaces.moveTabToWorkspace(...)` for a narrow proof.
