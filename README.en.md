# dsh-plugin-rollout-scout

English | [中文](./README.md)

A rollout-model fisher for DeepSeek Harness. When the provider does a limited rollout of a stronger conversation model, it may only surface in random new sessions. This plugin launches a batch of short probe conversations concurrently, reads their chain-of-thought **live**, and judges each by phrasing:

- Reasoning that keeps saying **"Let me"** → likely the old model → **cancelled and discarded immediately** (no quota wasted finishing it).
- Reasoning rich in **"I'm" / "I need" / "For"** → likely the rollout model → **allowed to finish its turn** and kept for you.

> ⚠️ These phrase signals are heuristics, not an official criterion — they just reflect differences in chain-of-thought style between models. Every threshold is adjustable.

## Interface

A "Scout" capsule sits at the bottom-right; it opens a glass control panel:

- **Probe prompt**, **model** (default V4-Pro / High), **concurrency**, **folder** for probe sessions.
- Thresholds: `discard at "Let me" ×N`, `keep at signals ×N`, `max probes`.
- Toggles: `stop after first catch`, `auto-delete old-model probes` (removes the session log from disk).
- **Start / Stop / Clear.** After Stop, in-flight probes run to their own verdict; only new launches cease.
- The queue below shows each probe's live status, `Let me` count, signal count, reasoning length and preview; click any row to open that session.

## How it works

- The host half serves `/rollout-scout` and creates brand-new sessions from scratch with `ctx.agents.create` (no seed), setting model and reasoning effort via `installModelSelection`.
- It subscribes to `session/event` scoped to each probe agent, reads `reasoning-delta` chunks from `assistant/chunk` (the streaming chain-of-thought), accumulates them and classifies on the fly.
- On an old-model hit it calls `agent.cancel` to interrupt the turn; on a rollout hit it lets the turn reach `turn/end`.
- All probe sessions are created under the folder you choose (as one workspace), with optional auto-deletion of probes judged old-model.

## Install

```
dsh plugin add dsh-plugin-rollout-scout
```

Restart DSH after installing (the host half loads with the server).

## Compatibility

The UI lives on the global `shell.overlay` layer and conflicts with no per-session plugin; it follows DSH's display language. Part of the same family as [dsh-plugin-smooth-stream](https://github.com/SpookySandwich/dsh-plugin-smooth-stream), [dsh-plugin-smooth-motion](https://github.com/SpookySandwich/dsh-plugin-smooth-motion) and [dsh-plugin-message-tree](https://github.com/SpookySandwich/dsh-plugin-message-tree).

## License

MIT © SpookySandwich
