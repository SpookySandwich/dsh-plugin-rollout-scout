# Architecture

Two halves and one route. `lib/index.js` runs on the host and owns everything
that costs money; `plugin.client.js` is the console and owns nothing. They
talk over `/rollout-scout` — `GET` returns the whole state, `POST` takes an
action and returns the whole state back. The console polls; there is no
incremental protocol and no client-side model of the run.

`lib/client.js` is generated from `plugin.client.js` by `_wrap-client.mjs` and
is committed, because `dsh plugin add` does not run lifecycle scripts. Edit the
source, run `npm run build`, commit both.

## The probe lifecycle

`pump` keeps `concurrency` probes in flight, launching a fresh session per
probe through `ctx.agents.create` and subscribing to that one agent's
`session/event`. `reasoning-delta` chunks accumulate into `attempt.reasoning`
and re-run the classifier on every chunk.

An attempt carries a `status` (what it is doing), a `verdict` (what we think
it is), and flags. The interesting states:

| status | meaning |
| --- | --- |
| `streaming` | undecided, still thinking |
| `kept-streaming` | reads as rollout, still thinking, still revisable |
| `pending-discard` | judged old, fading on the card, turn still running |
| `discarding` | cancelled, waiting on `turn/end` |
| `kept` / `discarded` | closed |

`pending-discard` exists so a wrong verdict is recoverable: the card fades for
`FADE_MS` before `commitDiscard` actually cancels, and a hover or click during
the fade rescues it.

## Cohorts

Stop and delete operations do not each decide what they may touch. Two
predicates decide once, and the operations act on what comes back:

```js
function settled(attempt)  // fixed in place by the user; the classifier may not revise it
function sweepable(attempt) // membership test for every bulk stop/delete cohort
```

`forceStop`, `pause`, `clearHistory`, `deleteAll` and `releaseOnUnload` all
iterate `state.attempts.filter(sweepable)`. The folder sweeps subtract
`keptIds()` from their id set once, in `probeSessionIds`. Nothing else filters.

The split between the two predicates is about *who is acting*, not about
degrees of caution. The classifier retracting a live `kept-streaming` probe
because a later paragraph opened with "Let me" is evidence, and only `settled`
outranks it. A user pressing Force stop is aiming at the run, not at that
conversation, so `sweepable` excludes catches as well.

`state.protectedIds` is the durable half of `settled`. It is keyed by session
id rather than by attempt, because the attempt list does not survive a plugin
reload but the folder sweep that runs afterwards still has to know what to
skip. It persists to `<probeFolder>/.rollout-scout.json`, so it travels with
the folder it describes.

## Pausing

Pause stops launching and cancels the probes already judged old; undecided
ones run on to their own verdict. That is the whole distinction from Force
stop, which cancels the entire cohort.

## Cleanup

`probeSessionIds` is the single answer to "what probe conversations exist",
unioning three sources — workspace slots, the live session store, and the
persistence listing — because each survives a different failure. See
[dsh-host-notes.md](dsh-host-notes.md) for why sessions are matched on `cwd`
and why the listing alone is not enough.

`orphans` is that set minus what the console is tracking: conversations no
card can reach, which is what a plugin reload or a half-finished delete leaves
behind. `countOrphans` is rate-limited and runs off the request path — the
console shows a banner and offers a sweep; `GET` never waits on a filesystem
walk.

## The corpus

`lib/fixtures.js` holds thirteen hand-labelled chains-of-thought. It ships with
the plugin rather than living in the test, because the `self-check` action runs
them through `classify` and `wantsDiscard` — the same functions a live probe
goes through — and reports what the user's current thresholds would decide.
The test imports the same module, so the samples asserted on in CI are the ones
the console demonstrates.

## Screenshots

`node scripts/shoot.mjs` regenerates `assets/console*.png` by rendering the real
`lib/client.js` in headless Chrome against a stubbed route, so the README images
track the shipped UI. The probe cards are staged; the self-check numbers come
from `selfCheck`, so an image cannot advertise a detection rate the classifier
does not actually produce. Animations are disabled in the harness — without
that, the entry animation and button transitions land mid-flight and the two
locales come out looking different from identical state.

## Tests

`npm test` runs six files, no framework, each a script that prints
`PASS`/`FAIL` lines and exits non-zero:

- `classifier.test.mjs` — the classifier and the config guards, against the
  labelled corpus in `lib/fixtures.js`
- `route.test.mjs` — HTTP surface and the same-origin/content-type guards
- `pump.test.mjs` — the launch-failure breaker
- `delete.test.mjs` — deleting never runs against a live log
- `lifecycle.test.mjs` — pause culls settled probes, a keep survives every
  destructive path, sweeps find conversations by `cwd`, and the self-check
  reports the corpus honestly under an unreachable threshold
- `client-css.test.mjs` — source-to-artifact checks for shell geometry

The host is driven through the real route handler with a mock `ctx`, so tests
exercise dispatch, not internals.
