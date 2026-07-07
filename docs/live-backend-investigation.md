# Live Backend Investigation

Date: 2026-07-07

`zts` still has no enabled live backend. The offline session backend is the only apply backend currently implemented.

`zts bridge status` and `zts bridge doctor` now make this boundary explicit in the CLI. They are read-only inspection commands; they do not start Zen, attach to a debugger, open sockets, write profile files, install a service, install a mod, or enable live apply.

`zts bridge live-check` is the stricter live-profile attachment gate. It is also read-only. It refuses unless all of the following are true:

- Zen is running for the discovered profile.
- A browser process explicitly matches the discovered profile path.
- The matching browser process has candidate remote transport launch evidence.
- The matching browser process has `--remote-allow-system-access`.
- The profile contains `WebDriverBiDiServer.json`.
- The server file contains a usable local-only `ws_host` and `ws_port`.

Without `--connect`, a clean preflight is still not enough to report attachable, because the server file can be stale. With `--connect`, it also opens the local WebSocket and runs only WebDriver BiDi `session.status`; only that connected check can produce an attachable receipt. It does not create a BiDi session, execute chrome script, move tabs, write profile files, or enable live sort apply.

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

No safe live-profile tab movement backend has been proven.

Until the same kind of operation is proven against the intended live Zen profile/window with explicit attachment gates, `zts` must not claim live sorting support and must not attempt UI automation, extension setup, Zen mod installation, daemon/autostart setup, or active session-file writes.

`zts bridge doctor` records the current blockers:

```text
Live backend client is not implemented yet
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

returns a plan and refuses apply with blockers equivalent to:

```text
Zen is running and no live backend is available
Offline session apply is blocked because Zen is running
```

## Next Safe Live-Backend Spike

The next live-backend spike should remain read-only until it can prove:

- how to execute code inside Zen browser chrome explicitly and user-owned,
- how to address the intended Zen window/profile,
- how to call Zen's own workspace movement API without UI automation,
- how to move one intentionally selected disposable test tab,
- how to verify the move from Zen state after the call,
- how to fail closed without installing services, extensions, mods, or autostart items.
