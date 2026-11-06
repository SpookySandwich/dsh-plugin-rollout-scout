# Round two: semantic contrast and acceptance enumeration

Parent review rejected `1baa3b307357c0049e0ff9f77225a11a81218525` for
semantic contrast. This record supersedes any reading of the first record as
proving contrast for all text; that check covered only the primary foreground.

## B1

The independent review's real official-host Edge results measured light-mode
ROLLOUT/Kept at 1.83:1, positive evidence at 1.92:1, self-check at 2.10:1,
score at 2.17:1 and disagreement warning at 1.95:1. Dark ROLLOUT/Kept was
3.90:1. The notification mute button used `currentColor` for its background
and its own foreground, making its label 1:1.

The implementation now separates semantic ink from decorative tints. Plugin
variables use dark green/brown in light mode and pale green/amber under the
official `body[data-ds-dark-theme]` selector. Badge, Keep, evidence chip,
self-check, warning and score text use those variables, while existing tinted
backgrounds remain. The mute button uses separate blue fill and white ink;
the primary action and banner buttons share that readable pair. No theme
option, translation or model behavior was added.

`scripts/check-scout-contrast.mjs` measures the real rendered elements in Edge,
compositing ancestor backgrounds and effective text opacity. It requires every
selected semantic element to reach 4.5:1, exercises a real self-check threshold
disagreement, and tests notification warn/ok plus mute with simulated markup
using the shipped CSS inside the official Web host. These simulated notification
states are **not Native Desktop testing**. Host tertiary text and unrelated
decorative/status fills are outside this semantic-text assertion.

## O1: original failure preserved, identity limit retained

Original independent run: official `0.2.0-rc.2`, Node 22.19.0, fresh host PID
116024, port 60996; browser PID 104576. The immutable source remains
`<QA_PREFIX>/attacker/out-oldest.log`. It failed at the `/qa/state` call after
negative-probe Pause, before explicit `delete-all`, with exit 1:

```text
HTTP 500
SessionQueryError: session "session-6839c7fa-2773-42ea-ab38-a1d1226da6b0" not found
SessionObservationReader.loadSource -> read -> fixture /qa/state
run-dsh-acceptance.mjs:151
500 !== 200
```

The saved report and browser probe do not record a session-ID ledger. Searching
the retained reports, logs and probe found this UUID only in the failure log.
The deleted sandbox cannot supply the missing mapping. **The original UUID is
not proven to be the discarded, retained or unowned session.** No original
retention-loss claim is either established or disproved by that incomplete log.

One requested unchanged oldest-host run without a browser leg passed fresh and
restart (PIDs 30312/41824, ports 58345/58358). This is not treated as proof that
the intermittent failure disappeared.

Source cause of the acceptance exposure: `scheduleAutoDelete` launches an
asynchronous `deleteAttempt`; teardown can release all agent resources before
the deletion task finishes. The old `settled(() => true)` only checked active
and blocking resources, then `/qa/state` independently listed and observed
persistence. An owned log can disappear between those two calls.

A deterministic fixture case now snapshots the real persistence list, explicitly
unprotects/deletes a known owned probe, then observes the old snapshot. It requires
exactly that deleted UUID to produce `SessionQueryError`; any other missing ID
or error fails. This reproduces the API failure mechanism without claiming the
historical UUID's role. The normal `/qa/state` route still propagates **every**
observation failure. Acceptance now waits for the specific negative attempt's
public `deleted` acknowledgement before enumerating sessions. Retained and
unowned existence assertions remain, including after restart and orphan cleanup.
The runner logs retained/unowned/discarded IDs for future causal attribution.

## Review scope and reproduction

Use the first record's official-runtime command with the owned runtime prefixes
and this checkout. The browser helper now checks latest in French (English Scout
fallback) and oldest in English. The new contrast helper is loaded automatically.
Set `DSH_QA_SCREENSHOTS` to an owned reviewer directory. Screenshot folder fields
are masked; the earlier baseline screenshot is cropped to remove its user path.
The first record's machine-specific paths have been replaced with owned-prefix
placeholders or commands derived from the checkout.

The parent's refused optional peer-negative and lock-stability actions were not
retried, substituted or used as gates. Prior strict-install evidence remains
historical. This round does not change compatibility ranges or dependencies.

## Round-two observations

Full `npm test` on Node 24.13.0 and `npm run check:package` passed (11 runtime
files). Build and whitespace checks passed. No additional peer-negative or
lock-stability commands were run.

Latest official 0.2.2-rc.1 on Node 24.13.0: fresh/restart passed, including
deterministic stale-list reproduction, plain/signed catches, cancellation,
confirmed automatic deletion, protected/unowned retention and failure cleanup.
Real Edge 156.0.4314.58: semantic console minimum **5.94:1** in each theme;
self-check warning **7.70:1 light / 8.30:1 dark**; simulated preflight warn/ok
and mute minimum **5.94:1** in each theme. Every audited element individually
met 4.5:1. Navigation and the two existing layout checks passed with no page or
console errors. Screenshots show the real console; simulated preflight states
are asserted programmatically, not presented as Native Desktop screenshots.

Oldest official 0.2.0-rc.2 on Node 22.19.0, after correcting the notice helper:
the same complete browser and fresh/restart acceptance passed, with the same
contrast minima in both themes and no page/console errors. This round's oldest
browser uses English, not Chinese; it tests the same CSS and host theme contract.
The middle two hosts were not rerun this round; their earlier evidence remains
historical, not independent revalidation of this commit.

Latest causal ledger:

- Explicitly deleted stale-list probe: `session-e88381f9-762b-4517-863f-3a3f1487d837`.
- Retained: `session-feba370e-7acb-4587-999e-dfc9a530749a`.
- Unowned: `session-ddd40ff9-5308-40bd-807d-244a28c83674`.
- Negative/discarded: `session-b7f15636-113b-4969-99a2-dbb979c4d510`.

Owned QA inventory (under `<QA_PREFIX>/rollout-scout-dsh-qa-<suffix>`):

| Run | Suffix | Host PIDs:ports | Edge PID / control port / profile suffix |
| --- | --- | --- | --- |
| Oldest without browser, initial diagnostic | 9q7ttj | 30312:58345, 41824:58358 | none |
| Latest complete round-two pass | 8qMcl3 | 41560:60482, 100936:55116 | 73236 / 55082 / 0GMo5f |
| Oldest preview-notice setup failure | dYIyfv | 33816:58992 | 108788 / 57966 / 6kQJfY |
| Oldest complete round-two pass | abORGb | 54112:58074, 44192:64348 | 66924 / 58076 / EOlOID |

Browser profile names have prefix `playwright_chromiumdev_profile-`. The oldest
browser attempt initially did not dismiss its English preview notice, so the
launcher was inert; it stopped/cleaned up without reporting a contrast result.
The helper now dismisses the observed notice using the selected host locale.

Oldest final ledger: explicitly deleted stale-list probe
`session-e19c9d4b-55d6-4a95-9478-453675cd0c84`; retained
`session-4a8ce893-874a-41f1-b332-7dd8245c7e27`; unowned
`session-d150dc90-c5ce-468a-83f3-6fd6e032d97b`; negative/discarded
`session-3bac88a1-a281-4ff9-80db-3cf901b543ff`.

Final cleanup inspection found no listed PIDs, no task-prefix Node/Edge processes,
no listeners on the recorded ports, and no remaining task QA sandboxes/profiles
or their runtime junctions. Official runtime/tool installations remain reusable.

## Independent review: Opus verification (exact commit c6ad8a5)

Independent review confirmed exact commit `c6ad8a5da11421a0c361979c21cbe95263b55ea0`:
- Fresh packed artifact: 11 files / 8 key files byte-identical; generated client (`lib/client.js`) identical to build from `plugin.client.js`.
- Acceptance in real headless Edge 156 against both latest official `0.2.2-rc.1` (Node 24.13.0, French host with English fallback) and oldest official `0.2.0-rc.2` (Node 22.19.0, English host): full fresh/restart exit 0, zero page/console errors. Layouts 1440x1000, 1000x760, and 1280x620 show no layout overflow and action footer remains visible; retained card successfully opens the persisted response.
- Semantic contrast B1 and Mute pass real CSS through nested tints and opacity; simulated notification states and mid/low scores pass. `client-css` tests pass (Node 22, 20/20).
- Implementer test suite (`npm test`, Node 24), package check, build, and diff checks passed.
- Middle hosts (`0.2.1-rc.2`, `0.2.1-rc.5`) were not rerun after the latest palette change; they share the identical `--dsw-alias-bg-layer-1` contract across all four official runtimes.

### Documented limits and scope

- **Semantic text scope vs. full WCAG**: Do not claim full WCAG or that all semantic states pass 4.5:1. Negative-red badge/chip/error/danger states remain ~2.87-3.91:1 in light mode and ~2.92-4.05:1 in dark mode (pre-existing, legible, and nonblocking); native host tertiary light text is also < 4.5:1. Mid-score hue is now warning (amber) instead of blue, with no scoring logic change. Scope is measured and readable green, amber, self-check, and Mute text, not a blanket claim for all text.
- **Notification environment**: Notification states are verified using simulated browser markup under the shipped CSS, not OS Native Desktop integration.
- **Historical O1 oldest-host failure**: The original Round 1 `/qa/state` 500 `SessionQueryError` involved an unmapped UUID without a recorded session ledger. Deterministic owned-deleted-ID route `/qa/list-race` reproduces the stale not-found mechanism, and the new wait requires actual `deleteOwnedSession` and manifest completion before listing. Normal `/qa/state` still propagates every missing-session error without catchalls. Retained and unowned sessions were preserved across both Opus runs. While source analysis supports a fixture timing gap, the original UUID, session role, and exact interleaving remain unknown; this does not claim the historical failure was disproved or that all intermittent races are fixed.
- **Platform claims**: Tests run on Windows official Web hosts and deterministic local adapter. No remote model classification, Native Desktop, or Linux claims are made.
