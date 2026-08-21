# dsh-plugin-rollout-scout

English | [简体中文](README.md)

[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![dsh](https://img.shields.io/badge/dsh-0.1.0--rc.7-4b8dff)](https://github.com/deepseek-ai/deepseek-harness)
[![stars](https://img.shields.io/github/stars/SpookySandwich/dsh-plugin-rollout-scout?style=flat&label=stars)](https://github.com/SpookySandwich/dsh-plugin-rollout-scout/stargazers)

Providers sometimes roll a new conversation model out gradually, so which one you get is luck of the draw. Rollout Scout opens throwaway conversations on your own account, reads each one's chain-of-thought **as it streams**, and scores how the reasoning is written — cancelling the ones that read like the model you already have, and keeping the ones that don't.

It is a curiosity tool built on phrase heuristics, not an oracle. Everything it does, you could do by hand: start a chat, glance at the reasoning, close the tab.

![the console](https://raw.githubusercontent.com/SpookySandwich/dsh-plugin-rollout-scout/master/assets/console.png)

## How it decides

The signal is in **how each paragraph opens** — not how often a phrase appears overall. A running tally of "Let me" drifts negative with length alone, so a long, perfectly good chain-of-thought eventually accumulates enough of them to look bad. Counting openings keeps the measure per-paragraph.

Only the first 48 characters of a paragraph are ever read. The phrase rarely sits at character zero:

> **The directory is empty. Let me create** a 3D cyberpunk scene.
> **To avoid conflicts, I'll keep** I18n.cs edits under one change.

Two signals are decisive, and they are deliberately **asymmetric**:

| Signal | Effect |
| --- | --- |
| `Let me` opening any paragraph | Old model — cancel the turn immediately |
| `I'll` opening the **whole** chain-of-thought | Rollout model — let it finish and keep it |

`I'll` counts as proof only at the very start, because old-model reasoning happily opens a *middle* paragraph with "I'll create a single HTML file…" and then says "Let me build…" three paragraphs later. Treating every `I'll` as proof produced false positives.

When neither fires, the remaining openings feed a score:

```
confidence = (positive openings + 1) / (classified openings + 2)
```

A paragraph opening is scored as soon as 48 characters have arrived, even if the model never inserts a newline. `Let me` later in the chain-of-thought **overrides** an earlier keep.

The rollout path often uses a **small model to summarise** the chain-of-thought. That summariser commonly starts `We need to…` (so a first-paragraph `we` is only a negative opening, not a kill), writes **even, essay-sized paragraphs**, and streams in **bursts with stalls** in between. Those three are positive evidence of the new pipeline. The old model is irregular — one blob, or mixed tiny `Let me` lines.

Positive openings are the first-person **singular** planning voice — `I'm`, `I am`, `I've`, `I have`, `I need`, `I think`, `I also`, `I will`, and a leading `For`. Negative openings are `Let me` / `Let's` and **any** first-person plural in the opening (`we`, `we need`, `we will`, `we'll`, …). The rollout model reasons in "I", not "we". The add-one prior keeps a thin sample near 50% instead of swinging to a confident verdict off one word:

| Evidence | Confidence | Verdict |
| --- | --- | --- |
| nothing yet | 50% | keep watching |
| 1 positive, 10 negative | 15% | discard |
| 5 positive, 0 negative | 86% | keep |

A probe is discarded below `discard below` (0.35) and kept above `keep above` (0.7), but only once `min. openings` (4) have been classified. One that opens ten paragraphs without a single positive is given up on, and a chain-of-thought that is **mostly Chinese** (80%+ of its letters) is discarded on sight — quoting a Chinese prompt inside English reasoning does not count.

The classifier is covered by tests over hand-labelled transcripts, alongside tests for the route guards, the launch loop's failure behaviour, and the rules about deleting sessions:

```bash
npm test
```

## The console

**Rollout Scout** sits at the sidebar foot, beside Settings, and opens the full-frame console shown above. It is a `sidebar.footer.action` entry, so it matches the shell's own rows and collapses to a single icon when the sidebar folds to the rail.

**Left** — the probe prompt, model (default V4-Pro / High), concurrency, folder, the scoring thresholds, and toggles: auto-pause on a strong match, discard Chinese reasoning, delete old-model probes from disk.

**Right** — launched / live / kept / discarded / best score, above a queue in launch order that never jumps. Each row has a score meter, matched phrases, and a preview. Click a card to open the conversation — it keeps running. Hover means you need it: putting the mouse on a fading card rescues it.

**Start** becomes **Pause**, which stops launching while letting probes already in flight reach their own verdict, then **Resume**. **Force stop** aborts everything mid-thought.

A probe judged old fades for about 3 seconds (a thin line at the bottom of the card) while the turn is still running, then cancels. Hover or click during the fade keeps it.

**Clear finished** removes completed probes from the list *and* deletes those conversations from disk. **Delete all sessions** wipes every probe in the folder — including ones already cleared from the list — and resets numbering so the next run starts at probe 1.

Both refuse to touch a probe that is still streaming. Pause stops launching but leaves probes in flight, so **Delete all sessions** asks you to **Force stop** first rather than unlinking a log that is still being written to. The probe folder may not be your home directory, a drive root, or anywhere inside `~/.dsh` — deleting is scoped to that folder, and those would put unrelated conversations in its path.

If three probes in a row fail to even start — provider unreachable, folder unwritable — the run stops itself and reports the error instead of relaunching into the same failure forever. **Resume** tries again.

The run lives on the host, so it keeps going when you close the console — the sidebar row carries a status pip on its icon (pulsing while scouting, grey when paused, green on a catch), a live count in the wide column, a green badge with the number caught, and the tried count and best confidence so far on hover. In the rail the pip is the whole signal, which is why it sits on the icon rather than in the label.

## Install

```bash
dsh plugin --profile web add github:SpookySandwich/dsh-plugin-rollout-scout
```

Restart DSH afterwards: the host half loads with the server. The interface follows DSH's display language (English / 中文).

Not on npm yet, so install from the repository. `lib/client.js` is a generated bundle but it is **committed**, so the install works without running any build step — `dsh plugin add` is pnpm underneath and does not run dependency lifecycle scripts by default. If you edit `plugin.client.js`, run `npm run build` to regenerate it (`npm test` does this too), and commit the result.

## How it works

- The host half serves `/rollout-scout` and creates each probe as a brand-new session with `ctx.agents.create` (no seed), setting model and reasoning effort through `installModelSelection`.
- It subscribes to `session/event` scoped to that one agent and reads `reasoning-delta` chunks off `assistant/chunk` — the chain-of-thought as it streams — classifying on every chunk.
- A verdict against calls `agent.cancel` to interrupt the turn; a verdict for lets it run to `turn/end`. While streaming, the last paragraph is withheld because its opening may be half-written; at turn end the complete text is re-classified.
- Probes are created in the folder you choose, which becomes a workspace. Old-model probes can be deleted from disk.
- `/rollout-scout` listens on a local port, so it is guarded like one: writes require an `application/json` content type (which forces a CORS preflight that is never answered) and a cross-origin `Origin` is refused. A page you happen to be visiting cannot make it start or delete anything.

## Compatibility

The launcher takes a `sidebar.footer.action` seat (a list slot, so it sits beside any other footer action rather than displacing one) and the console renders on the frame-wide `shell.overlay` layer. Neither is per-session, so it conflicts with no session plugin. Requires a DSH whose sidebar declares that seat; without it the console has no way in. Part of the same family as [dsh-plugin-smooth-stream](https://github.com/SpookySandwich/dsh-plugin-smooth-stream), [dsh-plugin-smooth-motion](https://github.com/SpookySandwich/dsh-plugin-smooth-motion) and [dsh-plugin-message-tree](https://github.com/SpookySandwich/dsh-plugin-message-tree).

## A note on cost

Every probe is a real turn against your own quota. Discarded ones are cancelled within a second or two, but a run left going will keep launching until you stop it. Concurrency and the thresholds are yours to tune.

## License

MIT © SpookySandwich
