# DSH host behaviour this plugin relies on

Notes on harness internals that are not in DSH's own documentation and that
were read out of `~/.dsh/profiles/node_modules/@deepseek-ai/*` and the DSH
Desktop bundle. Verified against **dsh 0.1.1-rc.2**. Each entry says what the
plugin does about it, so a future change to the harness has an obvious blast
radius.

## Desktop notifications fire on user-authored turns

`app.asar.unpacked/lib/notifications.js` in DSH Desktop runs in the same host
context as this plugin. Its `trackTurn` arms on a `user/message` whose
`source.kind` is `user`, and fires on the matching `turn/end`:

```js
if (event.type === 'user/message') {
  const openTurn = openTurns.get(sessionId);
  if (openTurn !== undefined && event.data.source.kind === 'user') openTurn.userInitiated = true;
```

A probe prompt sent as `{ kind: 'user' }` is therefore indistinguishable from
typing, and a run at any real concurrency produces one system toast per probe.

Probes go out as `{ kind: 'plugin', plugin: 'dsh-plugin-rollout-scout' }`.
`followup` never reads the source and the role stays `user`, so the turn and
the request to the model are unchanged.

Settings live in the `dsh-desktop-notifications` namespace
(`enabled`, `notifyOnTurnCompletion`, `notifyOnTurnFailure`,
`notifyOnJobCompletion`, `notifyOnJobFailure`), readable through
`ctx.get('settings').get(...)` and writable through `.update(...)`. A web-only
profile never registers the namespace, and `get` returns `undefined` there.

## Automatic session titles also key off the user source

`dsh-session-title`'s `onUserMessage` returns early unless
`source.kind === 'user'`. Plugin-sourced probes therefore never reach the
titler — which saves a small-model call per probe, but leaves them untitled.
The plugin names them itself via `sessionTitle.rename(session, …)`.

## The sidebar lists live *and* cold sessions

`dsh-host-apiproxy`'s `listVisibleSessionSummaries` unions
`ctx.sessions.list()` with everything in `sessionPersistence.list()` that has
a `cwd`. `dsh-client-ui-workspace` then groups by workspace membership;
anything unaccounted for renders as a *stray*, ungrouped row.

So a conversation disappears from the sidebar only when **both** its live
session and its on-disk log are gone. Dropping just the workspace slot demotes
it to a stray, which is worse — the session context menu offers Rename, Fork
and Archive, but no Delete.

## `sessionPersistence.locate` is a pure path computation

The JSONL backend's `locate(meta)` returns
`logPath(root, meta.cwd, meta.id, compression)` without touching disk, so a
synthetic `{ id, cwd }` is enough. Deletion must not depend on the session
appearing in `list()` first: a log the listing has not caught up with is
exactly the one that gets stranded.

`list()` itself walks and stats every session directory the harness holds, so
it is not free to call on a UI poll interval.

## Probe conversations are found by `cwd`, not by log path

Session logs live under `~/.dsh/sessions/<encoded-project>/<sessionId>/`,
never under the workspace directory. The predicate that identifies a probe is
the session's recorded `cwd` matching the probe folder.

## Agents outlive the plugin that created them

`agents.create` passes the *agent service's* context as the owner:

```js
async create(options) {
  const ownerCtx = this.ctx;
```

So probe agents survive a plugin reload, an upgrade, or an HMR swap, and the
new plugin instance has no handles to them. The plugin tears its cohort down
on unload for that reason, and the folder sweep exists to reach anything from
before.

An orphan that predates the current instance can still be `cancel`ed via
`ctx.agents.get(id)`, which stops the spending, but its session object stays
in the store until the app restarts — the disposer is only reachable from the
handle that creation returned.

## A session cannot change workspace

`SessionHeader.cwd` is fixed when the session is created. Workspace membership
derives from it in two places, so there is no way around it:

- `WorkspaceEntity.attachSession` rejects any session whose `cwd` does not
  equal the workspace path;
- `WorkspaceEntity.sessionIds` filters on `host.sessionPath(id) === record.path`,
  so a forced record write is filtered back out on read.

`sessions.fork` copies the parent's `cwd`, so forking does not escape it
either. The harness exposes `workspace.insertSessionBefore` (reorder within a
workspace) and `workspace.archiveSession`, but no cross-workspace move.

Detaching is the only "move": it drops the workspace slot and leaves the
conversation intact.
[dsh-plugin-no-workspace](https://github.com/SpookySandwich/dsh-plugin-no-workspace)
renders detached conversations as first-class sidebar rows and ships a
**Move out of Workspace** menu item; without it they land in the shell's
"Ungrouped" accordion.

## A harness listener throws on every agent disposal

`dsh-file-reference-local` logs a warning each time this plugin tears an agent
down:

    [agent-registry] agent "session-…": agent/disposed listener threw:
    TypeError: Cannot read properties of undefined (reading 'catch')

Its `agent/disposed` handler calls `disposePrompt`, which does
`fiber.dispose().catch(...)` (`lib/index.js:282`). Cordis disposers are
single-shot and a repeat call returns `undefined`, and by the time
`agent/disposed` fires the prompt fiber has normally gone already with the
agent's scope — so the chain throws.

It is upstream, harmless (the disposal completes; the registry contains the
throw and warns), and unavoidable from here: any plugin that disposes agents
triggers it. Not to be confused with the same mistake this plugin used to make
at its own three disposal sites, which `release()` fixed.

## Probes deliberately join no agent preset

Every probe logs a warning:

    [windows-agent-presets] agent "session-…" was published without joining an
    agent preset; its tools, prompt sections, and skill catalog resolve against
    the empty global layer

`agentPresets.mount(agentCtx, id)` from the `setup` callback would silence it,
and that is the wrong trade. The preset's composition carries the tool
catalogue and system prompt sections, and the classifier reads the model's
chain-of-thought — change what is in the context and the reasoning changes with
it, which would drift the calibration the labelled corpus was captured under.
It would also pay for that catalogue on every throwaway probe, and a probe
sends one message and never calls a tool.

`mount` rejecting inside `setup` rolls the agent creation back, so a preset
problem would surface as failed launches and trip the breaker after three.
The empty layer is the right shape here; the warning is the harness noticing
something unusual, not something broken.

