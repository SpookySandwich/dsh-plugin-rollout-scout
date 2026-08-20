# dsh-plugin-rollout-scout

English | [中文](./README.md)

A rollout-model fisher for DeepSeek Harness. When the provider does a limited rollout of a stronger conversation model, it may only surface in random new sessions. This plugin launches a batch of short probe conversations concurrently, reads their chain-of-thought **live**, and judges each by phrasing:

- Strong old-model tells: **"Let me"** and **"We need"**, counted at **double weight**.
- Rollout tells: **"I'm"**, **"I need"**, **"For"**.

### Confidence score

Every probe carries a 0–100% rollout confidence:

```
score = (weighted positive + 1) / (total weighted evidence + 2)
```

The add-one prior (Laplace smoothing) means **the score stays near 50% while evidence is thin**, so a single stray phrase never produces a confident verdict. For example:

| Evidence | Score | Meaning |
| --- | --- | --- |
| none | 50% | can't tell |
| 1 × "Let me" | 25% | discard now |
| 1 positive / 10 negative | 15% | clearly not the rollout |
| 3 positive / 0 negative | 80% | keep it |

Below `discard below` (default 0.35) the turn is **cancelled mid-thought and discarded** (no quota wasted finishing it); above `keep above` (default 0.7) it is **allowed to finish and kept**. Both require `min. evidence` (default 2) to have accumulated first, so one word cannot decide the outcome.

> ⚠️ These phrase signals are heuristics, not an official criterion — they just reflect differences in chain-of-thought style between models. Weights and thresholds are adjustable.

## Interface

A "Rollout Scout" entry sits at the bottom of the sidebar and opens a **full-screen console**:

- Left column: **probe prompt**, **model** (default V4-Pro / High), **concurrency**, **max probes**, **folder**, plus the scoring thresholds and toggles (`stop after first catch`, `auto-delete old-model probes`).
- Right column: headline stats (launched / live / kept / discarded / best score) above the probe queue — each probe shows a **score meter** with both threshold marks, the phrases it matched (colour-coded for and against), status, and a reasoning preview; click any probe to open that conversation.
- **Start / Stop / Clear finished.** After Stop, in-flight probes run to their own verdict; only new launches cease.

The interface follows DSH's display language (English / 中文).

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
