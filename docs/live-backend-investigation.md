# Live Backend Investigation

Date: 2026-07-07

`zts` currently has one production Apply Transaction route: authoritative closed-session mutation while Zen is closed and the native Profile lock is held. Live attachment/read probes exist, but live mutation is intentionally not shipped until it can enter through the same Plan, Authorization, whole-Plan preflight, recovery, inverse Plan, and Receipt boundary.

`zts bridge status` and `zts bridge doctor` make this boundary explicit in the CLI. They are read-only inspection commands; they do not start Zen, attach to a debugger, open sockets, write profile files, install a service, install a mod, or move tabs.

`zts bridge live-check` is the stricter live-profile attachment diagnostic. It is also read-only. It validates all of the following:

- Zen is running for the discovered profile.
- A browser process explicitly matches the discovered profile path.
- The matching browser process has candidate remote transport launch evidence.
- The matching browser process has `--remote-allow-system-access`.
- The profile contains `WebDriverBiDiServer.json`.
- The server file contains a usable local-only `ws_host` and `ws_port`.

These signals are not endpoint ownership. zts currently has no launch receipt binding the exact Zen binary, PID/start identity, Profile, endpoint, and listener confinement, so `--connect` refuses before opening the WebSocket. A local server file and matching-looking process flags cannot produce an attachable receipt.

`zts bridge live-read` is currently disabled by that ownership gate and creates no privileged session. The implemented future managed-launch proof would query:

- `location.href` for the chrome context,
- whether `gZenWorkspaces` exists,
- `typeof gZenWorkspaces`,
- `gZenWorkspaces.activeWorkspace`,
- `gZenWorkspaces.getWorkspaces().length`.

It does not call any workspace mutation method, open tabs, move tabs, write profile files, or install extensions/mods/services.

`zts bridge probe` is a separate disposable bridge proof. It starts a headless Zen process with a temporary profile, a random loopback remote-debugging port, and `--remote-allow-system-access`, without wildcard origin or host allowlists. It verifies WebDriver BiDi `session.status`, creates a session, executes harmless script in a content context, executes harmless script in Zen browser chrome, verifies `gZenWorkspaces` is reachable, performs one temp-profile workspace tab move through Zen internals, then terminates the process and removes the temporary profile. It does not attach to the live profile or move live tabs.

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

The live movement Control Route is not implemented in production. The disposable evidence below proves useful transport and Zen-internal primitives, but it is not sufficient authority for a user-Profile mutation.

`zts sort --apply --backend live` always refuses because that production Control Route is not enabled. Attachment is necessary evidence, but it is no longer treated as sufficient mutation authority. The project must still avoid UI automation, extension setup, Zen mod installation, daemon/autostart setup, and active session-file writes.

`zts bridge doctor` records the current blockers:

```text
Live sort apply requires an attachable Zen bridge; run zts bridge live-check --connect for the current gate receipt
Current Zen browser process has no remote debugging, debugger server, or Marionette launch flag
Current Zen browser process has no privileged remote system-access launch flag
```

`zts bridge live-check` adds the live attachment blockers. On a typical live profile that includes the missing local BiDi server file:

```text
~/Library/Application Support/zen/Profiles/<profile-id>/WebDriverBiDiServer.json does not exist.
```

## Current Safe Behavior

When Zen is running:

```bash
zts sort Space --json
```

returns a persisted-observation preview with full detail and warns that it cannot be authorized for mutation. An apply request refuses because Zen owns or may own the Profile; it never switches to an alternate live mutator:

```text
No browser process explicitly matched the discovered profile path.
No matching browser process has remote debugging, debugger server, or Marionette launch evidence.
No matching candidate browser process has --remote-allow-system-access.
WebDriverBiDiServer.json does not exist.
```

When Zen is closed:

```bash
zts sort Space --apply --yes --backend session --json
```

enters the canonical closed-session Apply Transaction, acquires native Profile control, publishes recovery evidence, mutates only exact planned Entity roots in `zen-sessions.jsonlz4`, writes a canonical Receipt, and independently verifies the result.

## Next Safe Live-Backend Spike

The next live-backend spike should stay narrow until it can prove on the real profile:

- how to address the intended Zen window/profile,
- how to launch or attach to the live profile with local WebDriver BiDi without services, extensions, mods, or autostart items,
- how to bind the same-session authoritative Snapshot and whole-Plan preflight to the live control session,
- how to execute, independently verify, recover, and receipt one exact Plan without a per-tab bypass,
- how to fail closed without installing services, extensions, mods, or autostart items.
