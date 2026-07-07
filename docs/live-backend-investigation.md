# Live Backend Investigation

Date: 2026-07-07

`zts` still has no enabled live backend. The offline session backend is the only apply backend currently implemented.

`zts bridge status` and `zts bridge doctor` now make this boundary explicit in the CLI. They are read-only inspection commands; they do not start Zen, attach to a debugger, open sockets, write profile files, install a service, install a mod, or enable live apply.

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

## Current Blocker

No safe CLI-to-Zen browser-chrome execution channel has been proven.

Until that exists, `zts` must not claim live sorting support and must not attempt UI automation, extension setup, Zen mod installation, daemon/autostart setup, or active session-file writes.

`zts bridge doctor` records the current blockers:

```text
Live backend client is not implemented yet
Current Zen browser process has no remote debugging, debugger server, or Marionette launch flag
Current Zen browser process has no privileged remote system-access launch flag
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
