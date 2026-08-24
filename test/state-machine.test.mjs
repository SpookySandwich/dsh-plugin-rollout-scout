// Attempt lifecycle transition matrix.
//
// Classification, execution, temporary review, durable retention and deletion
// are independent axes. These adversarial sequences pin the convergence rule:
// no ended old-model attempt may remain ordinary and unheld without a pending
// or committed discard outcome.
//
//   node test/state-machine.test.mjs
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';

const FOLDER = path.join(os.tmpdir(), 'rollout-scout-state-machine-test');
const LOGS = path.join(FOLDER, 'logs');
const originalSetTimeout = globalThis.setTimeout;
const originalClearTimeout = globalThis.clearTimeout;
const originalDateNow = Date.now;
const fakeTimers = [];
let fakeNow = originalDateNow();

globalThis.setTimeout = (callback, delay, ...args) => {
  if (delay >= 1000) {
    const timer = {
      callback: () => callback(...args), delay, dueAt: fakeNow + delay, active: true,
    };
    fakeTimers.push(timer);
    return timer;
  }
  return originalSetTimeout(callback, delay, ...args);
};
globalThis.clearTimeout = (timer) => {
  if (timer && typeof timer === 'object' && 'active' in timer) timer.active = false;
  else originalClearTimeout(timer);
};
Date.now = () => fakeNow;

const { apply } = await import('../lib/index.js');

let checks = 0;
let failed = 0;
function check(ok, message) {
  checks += 1;
  if (!ok) failed += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${message}`);
}

const listeners = new Map();
const live = new Map();
const attached = new Set();
const cancelled = new Set();
let detachGate = null;
let persistenceListGate = null;
const workspace = {
  path: FOLDER,
  get sessionIds() { return [...attached]; },
  attachSession: async (id) => { attached.add(id); },
  detachSession: async (id) => {
    if (detachGate?.id === id) {
      const gate = detachGate;
      gate.entered.resolve();
      await gate.release.promise;
      if (detachGate === gate && gate.next) detachGate = gate.next;
    }
    attached.delete(id);
  },
};

const routes = [];
apply({
  effect(fn) { routes.push(fn()); },
  get() { return undefined; },
  webServer: { register(route) { routes.push(route); return route; } },
  workspaceRegistry: {
    list: () => [workspace],
    resolveByPath: async () => workspace,
    create: async () => workspace,
  },
  sessions: {
    list: () => [...live.values()],
    get: (id) => live.get(id),
  },
  agents: {
    get: (id) => live.get(id)?.agent,
    create: async ({ sessionId, setup }) => {
      setup({ on(name, listener) {
        if (name === 'session/event') listeners.set(sessionId, listener);
      } });
      const agent = {
        status: 'running',
        followup() {},
        cancel() {
          cancelled.add(sessionId);
          agent.status = 'idle';
        },
        whenIdle: async () => {},
      };
      live.set(sessionId, {
        id: sessionId, header: { id: sessionId, cwd: FOLDER }, agent,
      });
      return {
        agent,
        dispose: async () => { live.delete(sessionId); },
      };
    },
  },
  sessionPersistence: {
    list: async () => {
      if (persistenceListGate !== null) {
        const gate = persistenceListGate;
        gate.entered.resolve();
        await gate.release.promise;
        if (persistenceListGate === gate) persistenceListGate = null;
      }
      const ids = await fs.readdir(LOGS).catch(() => []);
      return ids.map((id) => ({ id, cwd: FOLDER }));
    },
    locate: ({ id }) => ({ path: path.join(LOGS, id, 'session.jsonl') }),
  },
});
const route = routes.find((entry) => entry && entry.path === '/rollout-scout');
const unload = routes.find((entry) => typeof entry === 'function');

function send(method, body) {
  const stream = body === undefined ? Readable.from([]) : Readable.from([Buffer.from(body)]);
  stream.method = method;
  stream.headers = { host: '127.0.0.1:5173', 'content-type': 'application/json' };
  const out = { status: 0, body: null };
  const response = {
    writeHead(status) { out.status = status; },
    end(text) { out.body = text === undefined ? null : JSON.parse(text); },
  };
  return Promise.resolve(route.handler(stream, response)).then(() => out);
}

async function until(predicate, timeoutMs = 5000) {
  const deadline = originalDateNow() + timeoutMs;
  for (;;) {
    const response = await send('GET');
    if (predicate(response.body) || originalDateNow() > deadline) return response.body;
    await new Promise((resolve) => originalSetTimeout(resolve, 10));
  }
}

function event(id, value) {
  listeners.get(id)?.(null, value);
}

function think(id) {
  event(id, {
    type: 'assistant/chunk',
    data: { chunk: {
      type: 'reasoning-delta',
      text: 'The directory is empty. Let me inspect every file before editing anything.\n',
    } },
  });
}

function thinkRollout(id) {
  event(id, {
    type: 'assistant/chunk',
    data: { chunk: {
      type: 'reasoning-delta',
      text: [
        'I will inspect the current behavior before changing it.',
        'I will trace the state transitions and their ownership.',
        'I will add a deterministic regression for the race.',
        'I will implement the smallest coherent state-machine change.',
        'I will verify every boundary and generated artifact.',
      ].join('\n\n'),
    } },
  });
}

async function writeLog(id) {
  await fs.mkdir(path.join(LOGS, id), { recursive: true });
  await fs.writeFile(path.join(LOGS, id, 'session.jsonl'), 'probe\n');
}

function noInvariantErrors(view, message) {
  check(Array.isArray(view.invariantErrors) && view.invariantErrors.length === 0,
    `${message}${view.invariantErrors?.length ? ` (${view.invariantErrors.join(', ')})` : ''}`);
}

function fireTimer(delay) {
  const timer = fakeTimers.findLast((candidate) => candidate.active && candidate.delay === delay);
  if (timer === undefined) return false;
  timer.active = false;
  fakeNow = Math.max(fakeNow, timer.dueAt);
  timer.callback();
  return true;
}

function fireSpecificTimer(timer, evenIfCleared = false) {
  if (timer === undefined || (!timer.active && !evenIfCleared)) return false;
  timer.active = false;
  fakeNow = Math.max(fakeNow, timer.dueAt);
  timer.callback();
  return true;
}

function advanceTime(ms) {
  fakeNow += ms;
}

async function begin(autoDelete = true) {
  const response = await send('POST', JSON.stringify({
    action: 'start', config: {
      prompt: 'probe', folder: FOLDER, concurrency: 1, autoDelete,
    },
  }));
  check(response.status === 200, 'run starts');
  const view = await until((state) => state.attempts[0]?.status === 'streaming');
  await writeLog(view.attempts[0].sessionId);
  return view.attempts[0];
}

async function reset() {
  await send('POST', '{"action":"clear"}');
  await send('POST', '{"action":"force-stop"}');
}

async function claim(id, lease, overrides = {}) {
  const snapshot = (await send('GET')).body;
  const card = snapshot.attempts.find((item) => item.id === id);
  return send('POST', JSON.stringify({
    action: 'hold', id, lease, mode: 'claim', enteredAt: fakeNow,
    observedDiscardAt: card?.discardAt ?? null,
    ...overrides,
  }));
}

function heartbeat(id, lease) {
  return send('POST', JSON.stringify({ action: 'hold', id, lease, mode: 'heartbeat' }));
}

async function stopAndClear() {
  await send('POST', '{"action":"force-stop"}');
  await until((snapshot) => snapshot.active === 0);
  await send('POST', '{"action":"clear"}');
}

await fs.rm(FOLDER, { recursive: true, force: true });

/* ------------------ continuous old-model output owns one fade deadline -- */

let attempt = await begin(false);
think(attempt.sessionId);
let view = (await send('GET')).body;
let card = view.attempts.find((item) => item.id === attempt.id);
const firstStreamingDeadline = card.discardAt;
const firstStreamingFade = fakeTimers.findLast(
  (timer) => timer.active && timer.delay === 3_450);
check(card.status === 'pending-discard' && Number.isFinite(firstStreamingDeadline),
  'first old verdict arms one absolute fade deadline');
advanceTime(1_000);
think(attempt.sessionId);
advanceTime(1_000);
think(attempt.sessionId);
view = (await send('GET')).body;
card = view.attempts.find((item) => item.id === attempt.id);
check(card.discardAt === firstStreamingDeadline && firstStreamingFade.active,
  'continuous reasoning deltas cannot postpone the original fade');
check(fakeTimers.filter((timer) => timer.active && timer.delay === 3_450).length === 1,
  'continuous classification still has exactly one fade owner');
check(fireSpecificTimer(firstStreamingFade), 'the original fade owner reaches its deadline');
view = (await send('GET')).body;
card = view.attempts.find((item) => item.id === attempt.id);
check(card.status === 'discarding' && cancelled.has(attempt.sessionId)
    && card.discardAt === null,
  'the first deadline cancels a continuously streaming old model');
noInvariantErrors(view, 'continuous-stream cancellation satisfies invariants');
await send('POST', '{"action":"pause"}');
check(fireTimer(10_000), 'continuous-stream cancellation retains its bounded reaper');
await until((state) => state.active === 0);
await reset();

/* ------------------------- final evaluation preserves an armed deadline -- */

attempt = await begin(false);
think(attempt.sessionId);
view = (await send('GET')).body;
card = view.attempts.find((item) => item.id === attempt.id);
const finalEvaluationDeadline = card.discardAt;
const finalEvaluationFade = fakeTimers.findLast(
  (timer) => timer.active && timer.delay === 3_450);
advanceTime(500);
event(attempt.sessionId, { type: 'turn/end' });
view = await until((state) => state.active === 0);
card = view.attempts.find((item) => item.id === attempt.id);
check(card.status === 'pending-discard' && card.discardAt === finalEvaluationDeadline
    && finalEvaluationFade.active,
  'turn/end final evaluation cannot reset an existing fade');
check(fireSpecificTimer(finalEvaluationFade), 'the pre-end deadline commits the ended probe');
view = (await send('GET')).body;
card = view.attempts.find((item) => item.id === attempt.id);
check(card.status === 'discarded' && card.discardAt === null,
  'ended probe crosses discard at the original deadline');
noInvariantErrors(view, 'final-evaluation fade satisfies invariants');
await send('POST', '{"action":"pause"}');
await reset();

/* ----------------------- hover resumes only the unspent fade remainder -- */

attempt = await begin(false);
think(attempt.sessionId);
view = (await send('GET')).body;
card = view.attempts.find((item) => item.id === attempt.id);
const preHoverFade = fakeTimers.findLast((timer) => timer.active && timer.delay === 3_450);
advanceTime(1_000);
let response = await claim(attempt.id, 'partial-review');
card = response.body.attempts.find((item) => item.id === attempt.id);
check(card.held && card.discardAt === null && !preHoverFade.active,
  'hover suspends the active fade and hides its public deadline');
advanceTime(10_000);
think(attempt.sessionId);
check(!fakeTimers.some((timer) => timer.active && timer.delay === 3_450),
  'reasoning while held cannot manufacture a replacement fade');
response = await send('POST', JSON.stringify({
  action: 'release', id: attempt.id, lease: 'partial-review',
}));
card = response.body.attempts.find((item) => item.id === attempt.id);
const resumedLiveFade = fakeTimers.findLast((timer) => timer.active && timer.delay === 2_450);
const resumedLiveDeadline = card.discardAt;
check(card.status === 'pending-discard' && Number.isFinite(resumedLiveDeadline)
    && resumedLiveFade !== undefined,
  'explicit mouseleave resumes the saved 2.2-second remainder');
advanceTime(1_000);
think(attempt.sessionId);
view = (await send('GET')).body;
card = view.attempts.find((item) => item.id === attempt.id);
check(card.discardAt === resumedLiveDeadline && resumedLiveFade.active,
  'post-release streaming cannot renew the resumed remainder');
check(fireSpecificTimer(resumedLiveFade), 'the resumed live remainder commits once');
await send('POST', '{"action":"pause"}');
check(fireTimer(10_000), 'resumed live cancellation retains its bounded reaper');
await until((state) => state.active === 0);
await reset();

/* ----------------------- Keep resets; live Unkeep starts one new grace -- */

attempt = await begin(false);
think(attempt.sessionId);
const preKeepFade = fakeTimers.findLast((timer) => timer.active && timer.delay === 3_450);
response = await send('POST', JSON.stringify({ action: 'protect', id: attempt.id }));
card = response.body.attempts.find((item) => item.id === attempt.id);
check(card.protected && card.discardAt === null && !preKeepFade.active,
  'Keep resets the active fade before its persistence boundary');
noInvariantErrors(response.body, 'protected live-old fade state satisfies invariants');
response = await send('POST', JSON.stringify({ action: 'unprotect', id: attempt.id }));
card = response.body.attempts.find((item) => item.id === attempt.id);
check(!card.protected && card.status === 'pending-discard'
    && Number.isFinite(card.discardAt)
    && fakeTimers.filter((timer) => timer.active && timer.delay === 3_450).length === 1,
  'live Unkeep creates exactly one fresh discard grace');
noInvariantErrors(response.body, 'unprotected live-old fade state satisfies invariants');
await send('POST', '{"action":"pause"}');
check(fireTimer(10_000), 'Pause replaces the Unkeep fade with one bounded reaper');
await until((state) => state.active === 0);
await reset();

/* ---------------- lease expiry resumes live, but closes ended review -- */

attempt = await begin(false);
think(attempt.sessionId);
advanceTime(1_000);
await claim(attempt.id, 'live-expiry');
check(fireTimer(30_000), 'live abandoned review reaches its finite expiry');
view = (await send('GET')).body;
card = view.attempts.find((item) => item.id === attempt.id);
check(!card.held && card.status === 'pending-discard'
    && fakeTimers.some((timer) => timer.active && timer.delay === 2_450),
  'live lease expiry resumes only the saved remainder');
const expiryDeadline = card.discardAt;
const expiryFade = fakeTimers.findLast(
  (timer) => timer.active && timer.delay === 2_450);
response = await heartbeat(attempt.id, 'live-expiry');
card = response.body.attempts.find((item) => item.id === attempt.id);
check(response.body.review?.accepted === false
    && response.body.review?.reason === 'released'
    && !card.held && card.discardAt === expiryDeadline && expiryFade.active,
  'an expired heartbeat is rejected and cannot resurrect its tombstoned lease');
response = await send('POST', JSON.stringify({
  action: 'release', id: attempt.id, lease: 'live-expiry',
}));
card = response.body.attempts.find((item) => item.id === attempt.id);
check(response.body.review?.reason === 'not-held'
    && card.discardAt === expiryDeadline && expiryFade.active,
  'a release after expiry is ACK-only and cannot replace the resumed fade');
check(fireTimer(2_450), 'live expiry remainder reaches discard');
await send('POST', '{"action":"pause"}');
check(fireTimer(10_000), 'live expiry cancellation retains its bounded reaper');
await until((state) => state.active === 0);
await reset();

attempt = await begin(false);
think(attempt.sessionId);
advanceTime(1_000);
await claim(attempt.id, 'wall-clock-release');
const overdueReleaseTimer = fakeTimers.findLast(
  (timer) => timer.active && timer.delay === 30_000);
event(attempt.sessionId, { type: 'turn/end' });
await until((state) => state.active === 0);
advanceTime(30_001);
response = await send('POST', JSON.stringify({
  action: 'release', id: attempt.id, lease: 'wall-clock-release',
}));
card = response.body.attempts.find((item) => item.id === attempt.id);
check(response.body.review?.accepted === true
    && response.body.review?.reason === 'expired'
    && !overdueReleaseTimer.active && !card.held
    && card.status === 'discarded' && card.discardAt === null,
  'release applies overdue lease expiry once and cannot re-offer an ended fade');
noInvariantErrors(response.body, 'wall-clock release expiry satisfies invariants');
await reset();

attempt = await begin(false);
think(attempt.sessionId);
advanceTime(1_000);
await claim(attempt.id, 'wall-clock-expiry');
const overdueLeaseTimer = fakeTimers.findLast(
  (timer) => timer.active && timer.delay === 30_000);
advanceTime(30_001);
response = await heartbeat(attempt.id, 'wall-clock-expiry');
card = response.body.attempts.find((item) => item.id === attempt.id);
check(response.body.review?.accepted === false
    && response.body.review?.reason === 'released'
    && !card.held && card.status === 'pending-discard' && !overdueLeaseTimer.active,
  'heartbeat enforces wall-clock lease expiry even before the overdue timer callback runs');
check(fireTimer(2_450), 'wall-clock expiry resumes the saved fade exactly once');
await send('POST', '{"action":"pause"}');
check(fireTimer(10_000), 'wall-clock expiry cancellation retains its reaper');
await until((state) => state.active === 0);
await reset();

attempt = await begin(false);
think(attempt.sessionId);
advanceTime(1_000);
await claim(attempt.id, 'ended-expiry');
event(attempt.sessionId, { type: 'turn/end' });
await until((state) => state.active === 0);
check(fireTimer(30_000), 'ended abandoned review reaches its finite expiry');
view = (await send('GET')).body;
card = view.attempts.find((item) => item.id === attempt.id);
check(!card.held && card.status === 'discarded' && card.discardAt === null,
  'ended lease expiry commits immediately instead of creating another timer');
noInvariantErrors(view, 'ended lease expiry satisfies invariants');
await send('POST', '{"action":"pause"}');
await reset();

/* -------------------------- stale fade callbacks cannot steal ownership -- */

attempt = await begin(false);
think(attempt.sessionId);
const staleFade = fakeTimers.findLast((timer) => timer.active && timer.delay === 3_450);
advanceTime(1_000);
await claim(attempt.id, 'stale-fade');
response = await send('POST', JSON.stringify({
  action: 'release', id: attempt.id, lease: 'stale-fade',
}));
const currentFade = fakeTimers.findLast((timer) => timer.active && timer.delay === 2_450);
const currentDeadline = response.body.attempts.find((item) => item.id === attempt.id).discardAt;
check(fireSpecificTimer(staleFade, true), 'a cleared fade callback can be forced adversarially');
view = (await send('GET')).body;
card = view.attempts.find((item) => item.id === attempt.id);
check(currentFade.active && card.discardAt === currentDeadline
    && card.status === 'pending-discard',
  'generation and identity prevent a stale callback stealing the new owner');
check(fireSpecificTimer(currentFade), 'the current fade owner remains authoritative');
await send('POST', '{"action":"pause"}');
check(fireTimer(10_000), 'authoritative fade cancellation retains its reaper');
await until((state) => state.active === 0);
await reset();

/* ---------------- bounded late-arriving hover claims use visual deadline -- */

const claimWindowCases = [
  { processed: -1, entered: -1, accepted: true, label: 'D-1' },
  { processed: 0, entered: 0, accepted: true, label: 'D' },
  { processed: 1, entered: -1, accepted: true, label: 'D+1 transit' },
  { processed: 249, entered: -1, accepted: true, label: 'D+249 transit' },
  { processed: 250, entered: -1, accepted: false, label: 'D+250 commit' },
];
for (const boundary of claimWindowCases) {
  attempt = await begin(false);
  think(attempt.sessionId);
  view = (await send('GET')).body;
  card = view.attempts.find((item) => item.id === attempt.id);
  const deadline = card.discardAt;
  advanceTime(deadline + boundary.processed - fakeNow);
  response = await claim(attempt.id, `boundary-${boundary.label}`, {
    enteredAt: deadline + boundary.entered,
  });
  card = response.body.attempts.find((item) => item.id === attempt.id);
  const ack = response.body.review;
  check(response.status === 200 && ack?.action === 'hold'
      && ack.id === attempt.id && ack.lease === `boundary-${boundary.label}`
      && ack.accepted === boundary.accepted
      && (boundary.accepted ? card.held : card.status === 'discarding'),
  `claim processed at ${boundary.label} obeys the bounded commit window`);
  await stopAndClear();
}

attempt = await begin(false);
think(attempt.sessionId);
view = (await send('GET')).body;
card = view.attempts.find((item) => item.id === attempt.id);
const mismatchDeadline = card.discardAt;
response = await claim(attempt.id, 'deadline-mismatch', {
  observedDiscardAt: mismatchDeadline + 1,
});
card = response.body.attempts.find((item) => item.id === attempt.id);
check(response.status === 200 && response.body.review?.accepted === false
    && response.body.review?.reason === 'stale-deadline'
    && !card.held && card.discardAt === mismatchDeadline,
  'a no-op 200 with a mismatched observed deadline is an explicit rejection ACK');
await stopAndClear();

attempt = await begin(false);
const malformedClaims = [
  {
    lease: 'missing-mode', body: { enteredAt: fakeNow, observedDiscardAt: null },
    reason: 'invalid-mode',
  },
  {
    lease: 'unknown-mode', body: {
      mode: 'renew', enteredAt: fakeNow, observedDiscardAt: null,
    }, reason: 'invalid-mode',
  },
  {
    lease: 'null-time', body: { mode: 'claim', enteredAt: null, observedDiscardAt: null },
    reason: 'invalid-claim-time',
  },
  {
    lease: 'string-time', body: {
      mode: 'claim', enteredAt: String(fakeNow), observedDiscardAt: null,
    }, reason: 'invalid-claim-time',
  },
  {
    lease: 'missing-deadline', body: { mode: 'claim', enteredAt: fakeNow },
    reason: 'unexpected-deadline',
  },
  {
    lease: 'coerced-deadline', body: {
      mode: 'claim', enteredAt: fakeNow, observedDiscardAt: 0,
    }, reason: 'unexpected-deadline',
  },
];
for (const malformed of malformedClaims) {
  response = await send('POST', JSON.stringify({
    action: 'hold', id: attempt.id, lease: malformed.lease, ...malformed.body,
  }));
  card = response.body.attempts.find((item) => item.id === attempt.id);
  check(response.status === 200 && response.body.review?.accepted === false
      && response.body.review?.reason === malformed.reason && !card.held,
  `malformed claim ${malformed.lease} fails closed without creating a lease`);
}
response = await claim(attempt.id, 'strict-valid');
check(response.body.review?.accepted === true,
  'a pre-verdict claim requires and accepts an explicit null observed deadline');
response = await claim(attempt.id, 'strict-valid');
check(response.body.review?.accepted === false
    && response.body.review?.reason === 'claim-already-active'
    && response.body.attempts.find((item) => item.id === attempt.id)?.held,
  'an active token can be renewed only through heartbeat mode');
response = await heartbeat(attempt.id, 'strict-valid');
check(response.body.review?.accepted === true
    && response.body.review?.reason === 'heartbeat',
  'an exact heartbeat renews the active strict token');
await send('POST', JSON.stringify({
  action: 'release', id: attempt.id, lease: 'strict-valid',
}));
await stopAndClear();

/* ----------------------- watchdog and Clear close every fade boundary -- */

attempt = await begin(false);
think(attempt.sessionId);
const watchdogCrossedFade = fakeTimers.findLast(
  (timer) => timer.active && timer.delay === 3_450);
const watchdog = fakeTimers.findLast((timer) => timer.active && timer.delay === 240_000);
check(fireSpecificTimer(watchdog), 'watchdog can win before the fade callback');
check(!watchdogCrossedFade.active, 'watchdog invalidates the armed fade owner');
check(fireSpecificTimer(watchdogCrossedFade, true),
  'the cleared fade callback can arrive late after watchdog cancellation');
view = (await send('GET')).body;
card = view.attempts.find((item) => item.id === attempt.id);
check(card.status === 'stopping' && card.discardAt === null,
  'late fade cannot cross the watchdog cancellation boundary');
noInvariantErrors(view, 'watchdog/fade crossing satisfies invariants');
check(fireTimer(10_000), 'watchdog cancellation retains exactly one reaper');
await until((state) => state.active === 0);
await send('POST', '{"action":"pause"}');
await reset();

attempt = await begin(false);
think(attempt.sessionId);
await claim(attempt.id, 'watchdog-held');
// Keep the finite review genuinely alive until the 240-second watchdog. A
// single abandoned claim is supposed to expire after 30 seconds and would no
// longer be a valid test of watchdog-vs-active-review convergence.
for (let i = 0; i < 12; i += 1) {
  advanceTime(20_000);
  await heartbeat(attempt.id, 'watchdog-held');
}
const heldWatchdog = fakeTimers.findLast(
  (timer) => timer.active && timer.delay === 240_000);
check(fireSpecificTimer(heldWatchdog), 'watchdog can expire while review remains active');
view = (await send('GET')).body;
card = view.attempts.find((item) => item.id === attempt.id);
check(card.held && card.status === 'stopping' && card.discardAt === null,
  'watchdog-held cancellation has no active or suspended public fade');
noInvariantErrors(view, 'watchdog-held cancelling state satisfies invariants');
check(fireTimer(10_000), 'watchdog-held cancellation retains its original reaper');
view = await until((state) => state.active === 0);
card = view.attempts.find((item) => item.id === attempt.id);
check(card.held && card.status === 'error' && card.discardAt === null,
  'ended watchdog review preserves the file without inventing a remainder');
noInvariantErrors(view, 'ended watchdog-held state satisfies invariants');
response = await send('POST', JSON.stringify({
  action: 'release', id: attempt.id, lease: 'watchdog-held',
}));
card = response.body.attempts.find((item) => item.id === attempt.id);
check(!card.held && card.status === 'discarded' && card.discardAt === null,
  'releasing an ended watchdog review commits immediately without re-fading');
noInvariantErrors(response.body, 'watchdog-held release satisfies invariants');
await send('POST', '{"action":"pause"}');
await reset();

attempt = await begin(false);
await send('POST', '{"action":"pause"}');
think(attempt.sessionId);
const clearedCardFade = fakeTimers.findLast((timer) => timer.active && timer.delay === 3_450);
event(attempt.sessionId, { type: 'turn/end' });
await until((state) => state.active === 0);
response = await send('POST', '{"action":"clear"}');
check(response.status === 200 && response.body.attempts.length === 0,
  `Clear removes an ended card through the unified deletion gate (${response.status}: ${response.body.error || 'ok'}; cards=${response.body.attempts.length})`);
check(!clearedCardFade.active, 'the unified deletion gate invalidates its fade');
check(fireSpecificTimer(clearedCardFade, true),
  'a detached card can still receive an adversarial stale callback');
view = (await send('GET')).body;
check(view.attempts.length === 0 && view.invariantErrors.length === 0,
  `stale fade cannot resurrect a card after Clear (cards=${view.attempts.length}; invariants=${view.invariantErrors.join(',')})`);
await send('POST', '{"action":"force-stop"}');

/* ---------------- hover before verdict + pause + end + release (screenshot) -- */

attempt = await begin(true);
await claim(attempt.id, 'pre-verdict');
await send('POST', '{"action":"pause"}');
think(attempt.sessionId);
view = (await send('GET')).body;
card = view.attempts.find((item) => item.id === attempt.id);
check(card.verdict === 'old' && card.held,
  'classification is recorded even while a pre-verdict hover is active');
noInvariantErrors(view, 'hovered old streaming state satisfies invariants');

event(attempt.sessionId, { type: 'turn/end' });
view = await until((state) => state.active === 0);
card = view.attempts.find((item) => item.id === attempt.id);
check(card.status === 'finished' && card.verdict === 'old' && card.held && !card.protected,
  'ended old probe waits only while its temporary lease exists');
noInvariantErrors(view, 'ended held state satisfies invariants');

response = await send('POST', JSON.stringify({
  action: 'release', id: attempt.id, lease: 'pre-verdict',
}));
card = response.body.attempts.find((item) => item.id === attempt.id);
check(card.status === 'pending-discard' && !card.held && Number.isFinite(card.discardAt),
  'explicit release resumes the ended probe\'s saved fade');
check(fireTimer(3_450), 'the resumed ended fade retains its original full remainder');
view = await until((state) => state.attempts.find((item) => item.id === attempt.id)?.deleted);
noInvariantErrors(view, 'post-delete state satisfies invariants');
check(!attached.has(attempt.sessionId), 'auto-delete detaches the released old session');
const deletedMutationId = attempt.id;
const deletedDisplayNumber = attempt.number;
const deletedSessionId = attempt.sessionId;
response = await send('POST', JSON.stringify({ action: 'protect', id: deletedMutationId }));
check(response.status === 409,
  'a stale Keep cannot resurrect ownership after physical deletion');
response = await send('POST', JSON.stringify({
  action: 'rename', id: deletedMutationId, title: 'ghost',
}));
check(response.status === 409,
  'Rename shares the same post-deletion transition gate');
let diskManifest = JSON.parse(await fs.readFile(path.join(FOLDER, '.rollout-scout.json'), 'utf8'));
check(!diskManifest.owned.includes(deletedSessionId)
  && !diskManifest.protected.includes(deletedSessionId),
  'late card actions cannot recreate ghost manifest ownership');
await reset();

/* -------------------------- old verdict + hover + pause respects review -- */

attempt = await begin(true);
check(attempt.number === deletedDisplayNumber && attempt.id !== deletedMutationId,
  'display numbering may restart while mutation identity never does');
response = await send('POST', JSON.stringify({ action: 'protect', id: deletedMutationId }));
check(response.status === 400 && !response.body.protected,
  'a delayed Keep for the old display number is rejected');
response = await claim(deletedMutationId, 'stale-generation');
card = response.body.attempts.find((item) => item.id === attempt.id);
check(response.status === 200 && !card.held,
  'a delayed hover lease cannot attach to the replacement card');
think(attempt.sessionId);
view = await until((state) => state.attempts[0]?.status === 'pending-discard');
await claim(attempt.id, 'already-old');
response = await send('POST', '{"action":"pause"}');
card = response.body.attempts.find((item) => item.id === attempt.id);
check(card.held && card.verdict === 'old' && card.status === 'streaming',
  'Pause cannot cross an already-active review lease');
check(response.body.culled === 0 && !cancelled.has(attempt.sessionId),
  'a reviewed old probe is not reported or sent as a Pause cull');
noInvariantErrors(response.body, 'paused held-old state satisfies invariants');

event(attempt.sessionId, { type: 'turn/end' });
view = await until((state) => state.active === 0);
card = view.attempts.find((item) => item.id === attempt.id);
check(card.status === 'finished' && card.held && !card.deleted,
  'natural end remains reviewable after Pause');
response = await send('POST', '{"action":"clear"}');
check(response.status === 200
  && response.body.attempts.some((item) => item.id === attempt.id),
  'Clear finished cannot cross an active review lease');
response = await send('POST', '{"action":"delete-all"}');
check(response.status === 200
  && response.body.attempts.some((item) => item.id === attempt.id)
  && await fs.access(path.join(LOGS, attempt.sessionId, 'session.jsonl')).then(() => true, () => false),
  'Delete all also leaves the reviewed conversation and log intact');
response = await send('POST', JSON.stringify({
  action: 'release', id: attempt.id, lease: 'already-old',
}));
card = response.body.attempts.find((item) => item.id === attempt.id);
check(card.status === 'pending-discard' && !card.held && Number.isFinite(card.discardAt),
  'release resumes the reviewed conversation\'s saved fade');
check(fireTimer(3_450), 'the resumed reviewed fade reaches its original deadline');
await until((state) => state.attempts.find((item) => item.id === attempt.id)?.deleted);
await reset();

/* -------------------------- durable protection is a separate state axis -- */

attempt = await begin(true);
await claim(attempt.id, 'review');
await send('POST', '{"action":"pause"}');
think(attempt.sessionId);
await send('POST', JSON.stringify({ action: 'protect', id: attempt.id }));
event(attempt.sessionId, { type: 'turn/end' });
await until((state) => state.active === 0);
response = await send('POST', JSON.stringify({ action: 'release', id: attempt.id, lease: 'review' }));
card = response.body.attempts.find((item) => item.id === attempt.id);
check(card.protected && card.verdict === 'old' && card.status === 'pinned',
  'release cannot override an explicit Keep');
noInvariantErrors(response.body, 'protected old state satisfies invariants');

response = await send('POST', JSON.stringify({ action: 'unprotect', id: attempt.id }));
card = response.body.attempts.find((item) => item.id === attempt.id);
check(!card.protected && card.status === 'discarded',
  'Unkeep runs the same reconciliation and commits the ended old probe');
view = await until((state) => state.attempts.find((item) => item.id === attempt.id)?.deleted);
noInvariantErrors(view, 'Unkeep deletion state satisfies invariants');
await reset();

/* --------------------------------------- multiple leases converge by count -- */

attempt = await begin(false);
await claim(attempt.id, 'mouse-a');
await claim(attempt.id, 'mouse-b');
await send('POST', '{"action":"pause"}');
think(attempt.sessionId);
event(attempt.sessionId, { type: 'turn/end' });
await until((state) => state.active === 0);

response = await send('POST', JSON.stringify({ action: 'release', id: attempt.id, lease: 'mouse-a' }));
card = response.body.attempts.find((item) => item.id === attempt.id);
check(card.held && card.status === 'finished', 'one of two leases cannot release the review');
response = await send('POST', JSON.stringify({ action: 'release', id: attempt.id, lease: 'mouse-b' }));
card = response.body.attempts.find((item) => item.id === attempt.id);
check(!card.held && card.status === 'pending-discard' && Number.isFinite(card.discardAt),
  'the final lease release resumes exactly one fade');
check(fakeTimers.filter((timer) => timer.active && timer.delay === 3_450).length === 1,
  'multiple leases cannot create multiple resumed fade owners');
check(fireTimer(3_450), 'the single resumed fade commits after the final lease');
noInvariantErrors(response.body, 'multi-lease release satisfies invariants');
await reset();

/* -------------------------------------- abandoned client lease has an expiry -- */

attempt = await begin(false);
await claim(attempt.id, 'abandoned');
const firstLeaseTimer = fakeTimers.findLast((timer) => timer.active && timer.delay === 30_000);
await heartbeat(attempt.id, 'abandoned');
const refreshedLeaseTimer = fakeTimers.findLast((timer) => timer.active && timer.delay === 30_000);
check(firstLeaseTimer !== refreshedLeaseTimer && firstLeaseTimer.active === false,
  'a hover heartbeat slides the same lease expiry instead of multiplying leases');
await send('POST', '{"action":"pause"}');
think(attempt.sessionId);
event(attempt.sessionId, { type: 'turn/end' });
await until((state) => state.active === 0);
check(fireTimer(30_000), 'temporary review lease owns a finite expiry');
view = (await send('GET')).body;
card = view.attempts.find((item) => item.id === attempt.id);
check(!card.held && card.status === 'discarded',
  'an abandoned client cannot retain an ended old probe forever');
noInvariantErrors(view, 'expired lease state satisfies invariants');
await reset();

/* -------------------------------- release-before-hold request reordering -- */

attempt = await begin(false);
await send('POST', '{"action":"pause"}');
await send('POST', JSON.stringify({ action: 'release', id: attempt.id, lease: 'reordered' }));
response = await claim(attempt.id, 'reordered');
response = await heartbeat(attempt.id, 'reordered');
card = response.body.attempts.find((item) => item.id === attempt.id);
check(!card.held, 'release tombstone rejects every late heartbeat for the same lease');
for (let i = 0; i < 300; i += 1) {
  await send('POST', JSON.stringify({ action: 'release', id: attempt.id, lease: `later-${i}` }));
}
response = await heartbeat(attempt.id, 'reordered');
card = response.body.attempts.find((item) => item.id === attempt.id);
check(!card.held, 'release tombstones do not expire after many later gestures');
think(attempt.sessionId);
view = (await send('GET')).body;
card = view.attempts.find((item) => item.id === attempt.id);
check(card.status === 'pending-discard', 'reordered gesture cannot suppress the old verdict');
noInvariantErrors(view, 'reordered gesture state satisfies invariants');
await send('POST', '{"action":"force-stop"}');
await until((state) => state.active === 0);
await send('POST', '{"action":"clear"}');

/* -------------------------- force-stop retires an in-flight heartbeat -- */

attempt = await begin(false);
await claim(attempt.id, 'force-race');
await send('POST', '{"action":"force-stop"}');
await until((state) => state.active === 0);
response = await heartbeat(attempt.id, 'force-race');
card = response.body.attempts.find((item) => item.id === attempt.id);
check(!card.held, 'Force stop tombstones a heartbeat that was already in flight');
response = await claim(attempt.id, 'never-seen-before-stop');
card = response.body.attempts.find((item) => item.id === attempt.id);
check(!card.held, 'Force stop closes review to an entirely unseen delayed hold');
await send('POST', '{"action":"clear"}');

attempt = await begin(false);
await claim(attempt.id, 'ended-review');
await send('POST', '{"action":"pause"}');
think(attempt.sessionId);
event(attempt.sessionId, { type: 'turn/end' });
await until((state) => state.active === 0);
await send('POST', '{"action":"force-stop"}');
response = await claim(attempt.id, 'ended-never-seen-before-stop');
card = response.body.attempts.find((item) => item.id === attempt.id);
check(!card.held && card.status === 'discarded' && card.discardAt === null,
  'Force stop closes and immediately reconciles an already-ended review');
noInvariantErrors(response.body, 'Force stop ended-review convergence satisfies invariants');
await send('POST', '{"action":"clear"}');

/* ---------------------- Clear revalidates rows after every await -------- */

response = await send('POST', JSON.stringify({
  action: 'start', config: {
    prompt: 'probe', folder: FOLDER, concurrency: 2, autoDelete: false,
  },
}));
view = await until((snapshot) => snapshot.attempts.filter(
  (item) => item.status === 'streaming').length === 2);
const clearRaceCards = view.attempts.slice(0, 2);
for (const item of clearRaceCards) await writeLog(item.sessionId);
await send('POST', '{"action":"pause"}');
for (const item of clearRaceCards) think(item.sessionId);
view = await until((snapshot) => clearRaceCards.every((item) =>
  snapshot.attempts.find((candidate) => candidate.id === item.id)?.status === 'pending-discard'));
for (const item of clearRaceCards) event(item.sessionId, { type: 'turn/end' });
await until((snapshot) => snapshot.active === 0);
const firstDropped = clearRaceCards[0];
const hoverDuringClear = clearRaceCards[1];
detachGate = {
  id: firstDropped.sessionId,
  entered: Promise.withResolvers(),
  release: Promise.withResolvers(),
};
const clearing = send('POST', '{"action":"clear"}');
await detachGate.entered.promise;
const clearRaceTimeout = Symbol('clear-review-timeout');
const rescuedDuringClear = await Promise.race([
  claim(hoverDuringClear.id, 'clear-race-hover'),
  new Promise((resolve) => originalSetTimeout(() => resolve(clearRaceTimeout), 250)),
]);
check(rescuedDuringClear !== clearRaceTimeout
    && rescuedDuringClear.body.review?.accepted === true
    && rescuedDuringClear.body.attempts.find(
      (item) => item.id === hoverDuringClear.id)?.held,
  'a later Clear candidate can acquire review while an earlier deletion is awaiting I/O');
detachGate.release.resolve();
const clearRaceResult = await clearing;
detachGate = null;
const rescuedCard = clearRaceResult.body.attempts.find(
  (item) => item.id === hoverDuringClear.id);
check(clearRaceResult.status === 200 && rescuedCard?.held
    && !clearRaceResult.body.attempts.some((item) => item.id === firstDropped.id)
    && await fs.access(path.join(LOGS, hoverDuringClear.sessionId, 'session.jsonl'))
      .then(() => true, () => false),
  'Clear revalidates its stale dropped snapshot and keeps the newly reviewed row reachable');
response = await send('POST', JSON.stringify({
  action: 'release', id: hoverDuringClear.id, lease: 'clear-race-hover',
}));
check(response.body.attempts.find((item) => item.id === hoverDuringClear.id)?.status
    === 'pending-discard',
  'the preserved Clear-race row still follows ordinary release reconciliation');
await send('POST', '{"action":"clear"}');
await send('POST', '{"action":"force-stop"}');

/* ---------------- destructive actions prune overdue wall-clock leases --- */

attempt = await begin(false);
await send('POST', '{"action":"pause"}');
think(attempt.sessionId);
advanceTime(1_000);
await claim(attempt.id, 'clear-overdue');
const clearOverdueTimer = fakeTimers.findLast(
  (timer) => timer.active && timer.delay === 30_000);
event(attempt.sessionId, { type: 'turn/end' });
await until((snapshot) => snapshot.active === 0);
advanceTime(30_001);
response = await send('POST', '{"action":"clear"}');
check(response.status === 200 && response.body.attempts.length === 0
    && !clearOverdueTimer.active
    && !await fs.access(path.join(LOGS, attempt.sessionId, 'session.jsonl'))
      .then(() => true, () => false),
  'Clear prunes an overdue lease itself instead of waiting for GET or its timer callback');
await send('POST', '{"action":"force-stop"}');

/* ---------------- Delete all removes already auto-deleted history -------- */

attempt = await begin(true);
await send('POST', '{"action":"pause"}');
think(attempt.sessionId);
event(attempt.sessionId, { type: 'turn/end' });
await until((snapshot) => snapshot.active === 0);
check(fireTimer(3_450), 'auto-delete history reaches its committed fade');
view = await until((snapshot) =>
  snapshot.attempts.find((item) => item.id === attempt.id)?.deleted === true);
response = await send('POST', '{"action":"delete-all"}');
check(response.status === 200
    && !response.body.attempts.some((item) => item.id === attempt.id),
  'Delete all removes an already-deleted card instead of regressing it to failed');

/* ---------------- Delete all closes each tracked row as it succeeds ------ */

response = await send('POST', JSON.stringify({
  action: 'start', config: {
    prompt: 'probe', folder: FOLDER, concurrency: 2,
    autoDelete: false, autoPauseOnMatch: false,
  },
}));
view = await until((snapshot) => snapshot.attempts.filter(
  (item) => item.status === 'streaming').length === 2);
const deleteAllRaceCards = view.attempts.slice(0, 2);
for (const item of deleteAllRaceCards) await writeLog(item.sessionId);
for (const item of deleteAllRaceCards) thinkRollout(item.sessionId);
view = await until((snapshot) => deleteAllRaceCards.every((item) =>
  snapshot.attempts.find((candidate) => candidate.id === item.id)?.verdict === 'rollout'));
await send('POST', '{"action":"pause"}');
for (const item of deleteAllRaceCards) event(item.sessionId, { type: 'turn/end' });
view = await until((snapshot) => snapshot.active === 0
  && deleteAllRaceCards.every((item) =>
    snapshot.attempts.find((candidate) => candidate.id === item.id)?.protected));
for (const item of deleteAllRaceCards) {
  response = await send('POST', JSON.stringify({ action: 'unprotect', id: item.id }));
  check(response.status === 200, `rollout delete-race probe ${item.number} is unprotected`);
}
const deleteAllManifest = JSON.parse(
  await fs.readFile(path.join(FOLDER, '.rollout-scout.json'), 'utf8'));
const deleteAllRaceIds = new Set(deleteAllRaceCards.map((item) => item.sessionId));
const deleteAllOrder = deleteAllManifest.owned.filter((id) => deleteAllRaceIds.has(id));
check(deleteAllOrder.length === 2, 'both rollout delete-race probes remain durably owned');
const firstDeleteAllId = deleteAllOrder[0];
const secondDeleteAllId = deleteAllOrder[1];
const firstDeleteAllCard = deleteAllRaceCards.find(
  (item) => item.sessionId === firstDeleteAllId);
const secondDeleteAllCard = deleteAllRaceCards.find(
  (item) => item.sessionId === secondDeleteAllId);
await claim(secondDeleteAllCard.id, 'held-before-delete-all');
persistenceListGate = {
  entered: Promise.withResolvers(),
  release: Promise.withResolvers(),
};
const secondDeleteAllGate = {
  id: secondDeleteAllId,
  entered: Promise.withResolvers(),
  release: Promise.withResolvers(),
};
const firstDeleteAllGate = {
  id: firstDeleteAllId,
  entered: Promise.withResolvers(),
  release: Promise.withResolvers(),
  next: secondDeleteAllGate,
};
detachGate = firstDeleteAllGate;
const deletingMany = send('POST', '{"action":"delete-all"}');
await persistenceListGate.entered.promise;
response = await send('POST', JSON.stringify({
  action: 'release', id: secondDeleteAllCard.id, lease: 'held-before-delete-all',
}));
check(response.body.review?.accepted === true && !response.body.attempts.find(
  (item) => item.id === secondDeleteAllCard.id)?.held,
  'an initially held Delete-all row can be released during the pre-id await');
persistenceListGate.release.resolve();
await firstDeleteAllGate.entered.promise;
const selectedAfterReleaseClaim = await claim(
  secondDeleteAllCard.id, 'selected-after-release');
check(selectedAfterReleaseClaim.body.review?.accepted === false
    && selectedAfterReleaseClaim.body.review?.reason === 'deleting',
  'the final manifest id set synchronously gates a row released after the initial target snapshot');
firstDeleteAllGate.release.resolve();
await secondDeleteAllGate.entered.promise;
const postDeleteClaim = await claim(firstDeleteAllCard.id, 'post-delete-window');
check(postDeleteClaim.body.review?.accepted === false
    && postDeleteClaim.body.review?.reason === 'review-closed'
    && postDeleteClaim.body.attempts.find(
      (item) => item.id === firstDeleteAllCard.id)?.deleted,
  `a physically deleted earlier row rejects review while a later Delete-all target drains `
  + `(review=${JSON.stringify(postDeleteClaim.body.review)}, card=${JSON.stringify(
    postDeleteClaim.body.attempts.find((item) => item.id === firstDeleteAllCard.id))})`);
secondDeleteAllGate.release.resolve();
const deleteManyResult = await deletingMany;
detachGate = null;
persistenceListGate = null;
check(deleteManyResult.status === 200 && deleteManyResult.body.attempts.length === 0,
  'multi-row Delete all removes every confirmed deletion without a held ghost');

/* ---------------- deletion gate and review lane cross the action queue -- */

attempt = await begin(false);
await send('POST', '{"action":"pause"}');
think(attempt.sessionId);
event(attempt.sessionId, { type: 'turn/end' });
await until((snapshot) => snapshot.active === 0);
check(fireTimer(3_450), 'ended deletion-race probe reaches committed discard');
detachGate = {
  id: attempt.sessionId,
  entered: Promise.withResolvers(),
  release: Promise.withResolvers(),
};
let deletionSettled = false;
const deleting = send('POST', '{"action":"delete-all"}').finally(() => {
  deletionSettled = true;
});
await detachGate.entered.promise;
const timeout = Symbol('review-timeout');
const priorityHold = await Promise.race([
  claim(attempt.id, 'during-delete'),
  new Promise((resolve) => originalSetTimeout(() => resolve(timeout), 250)),
]);
const priorityRelease = await Promise.race([
  send('POST', JSON.stringify({
    action: 'release', id: attempt.id, lease: 'during-delete',
  })),
  new Promise((resolve) => originalSetTimeout(() => resolve(timeout), 250)),
]);
check(!deletionSettled && priorityHold !== timeout
    && priorityHold.body.review?.accepted === false
    && priorityHold.body.review?.reason === 'deleting',
  'priority hold bypasses a blocked delete-all and fails closed at the manifest gate');
check(priorityRelease !== timeout && priorityRelease.body.review?.action === 'release'
    && priorityRelease.body.review?.accepted === true,
  'priority release also bypasses the blocked ordinary action queue');
detachGate.release.resolve();
const deletionResult = await deleting;
detachGate = null;
check(deletionResult.status === 200 && deletionResult.body.attempts.length === 0,
  'delete-all completes after the rejected review traffic');

/* ---------------------------- unload also reconciles ended review loans -- */

attempt = await begin(false);
await claim(attempt.id, 'unload-ended');
await send('POST', '{"action":"pause"}');
think(attempt.sessionId);
event(attempt.sessionId, { type: 'turn/end' });
await until((state) => state.active === 0);
unload();
view = (await send('GET')).body;
card = view.attempts.find((item) => item.id === attempt.id);
check(!card.held && card.status === 'discarded' && card.discardAt === null,
  'plugin unload retires and immediately reconciles an ended review');
noInvariantErrors(view, 'unload ended-review convergence satisfies invariants');

globalThis.setTimeout = originalSetTimeout;
globalThis.clearTimeout = originalClearTimeout;
Date.now = originalDateNow;
await fs.rm(FOLDER, { recursive: true, force: true });

console.log(`\n${checks - failed}/${checks} passed`);
process.exit(failed === 0 ? 0 : 1);
