// Executable client review protocol tests.
//
// These run the exact helper functions shipped in plugin.client.js with a
// deterministic scheduler. Source-string checks cannot catch the failure that
// motivated them: a host rejection represented by HTTP 200 was treated as a
// successful hover, leaving a visual anchor alive without a host lease.
import fs from 'node:fs';

const source = fs.readFileSync(new URL('../plugin.client.js', import.meta.url), 'utf8');
const protocolStart = source.indexOf('function exactReviewAck(');
const protocolEnd = source.indexOf('\n// Clicking a hovered card', protocolStart);
if (protocolStart === -1 || protocolEnd === -1) {
  throw new Error('cannot locate client review protocol helpers');
}

function scheduler() {
  const timeouts = [];
  const intervals = [];
  return {
    timeouts,
    intervals,
    setTimeout(callback, delay) {
      const timer = { callback, delay, active: true };
      timeouts.push(timer);
      return timer;
    },
    clearTimeout(timer) { if (timer) timer.active = false; },
    setInterval(callback, delay) {
      const timer = { callback, delay, active: true };
      intervals.push(timer);
      return timer;
    },
    clearInterval(timer) { if (timer) timer.active = false; },
    fireTimeout(timer) {
      if (!timer?.active) return false;
      timer.active = false;
      timer.callback();
      return true;
    },
    tick(timer) {
      if (!timer?.active) return false;
      timer.callback();
      return true;
    },
    reset() {
      for (const timer of [...timeouts, ...intervals]) timer.active = false;
      timeouts.length = 0;
      intervals.length = 0;
    },
  };
}

const clock = scheduler();
const protocolFactory = new Function(
  'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval',
  'HOLD_ACK_TIMEOUT_MS', 'HOLD_REFRESH_MS',
  `${source.slice(protocolStart, protocolEnd)}
   return { exactReviewAck, boundedReviewAck, createReviewLease };`,
);
const { exactReviewAck, createReviewLease } = protocolFactory(
  clock.setTimeout.bind(clock), clock.clearTimeout.bind(clock),
  clock.setInterval.bind(clock), clock.clearInterval.bind(clock),
  1_200, 10_000,
);

let checks = 0;
let failed = 0;
function check(ok, message) {
  checks += 1;
  if (!ok) failed += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${message}`);
}

function ack(id, lease, accepted = true, overrides = {}) {
  return {
    review: {
      action: 'hold', id, lease, accepted, reason: accepted ? 'claimed' : 'rejected',
      ...overrides,
    },
  };
}

async function flush() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

/* ----------------------- exact ACK and initial claim metadata ----------- */

clock.reset();
const firstCalls = [];
const firstReleases = [];
const first = createReviewLease({
  id: 7,
  lease: 'L1',
  enteredAt: 100,
  observedDiscardAt: 200,
  hold(id, lease, claim) {
    firstCalls.push({ id, lease, claim });
    return ack(id, lease);
  },
  release(id, lease) { firstReleases.push({ id, lease }); },
});
check(await first.initialAck,
  'an exact id/action/lease accepted ACK establishes the initial review');
await flush();
check(firstCalls.length === 1 && firstCalls[0].claim.mode === 'claim'
    && firstCalls[0].claim.enteredAt === 100
    && firstCalls[0].claim.observedDiscardAt === 200,
  'the first request carries claim mode, pointer time, and observed visual deadline');
check(first.phase === 'active'
    && clock.intervals.filter((timer) => timer.active).length === 1,
  'heartbeat scheduling begins only after the initial exact ACK');
check(!exactReviewAck({ review: { action: 'hold', id: 7, lease: 'wrong', accepted: true } },
  'hold', 7, 'L1'), 'a successful ACK for another lease is rejected locally');
first.release();
check(firstReleases.length === 1 && first.phase === 'released',
  'explicit pointer release closes the epoch and sends one tombstone');

/* ----------------------- false/missing ACK and timeout converge --------- */

for (const sample of [
  { name: 'accepted:false', value: ack(8, 'reject', false) },
  { name: 'missing review object', value: { attempts: [] } },
  { name: 'wrong lease', value: ack(8, 'somebody-else', true) },
]) {
  clock.reset();
  let rejected = 0;
  let released = 0;
  const review = createReviewLease({
    id: 8,
    lease: 'reject',
    enteredAt: 10,
    observedDiscardAt: null,
    hold() { return sample.value; },
    release() { released += 1; },
    onReject() { rejected += 1; },
  });
  check((await review.initialAck) === false,
    `${sample.name} is not mistaken for a host lease`);
  await flush();
  check(review.phase === 'rejected' && rejected === 1 && released === 1
      && clock.intervals.every((timer) => !timer.active),
  `${sample.name} runs the unified rejection cleanup`);
}

clock.reset();
let timeoutRejected = 0;
let timeoutReleased = 0;
const never = Promise.withResolvers();
const timed = createReviewLease({
  id: 9,
  lease: 'timeout',
  enteredAt: 1,
  observedDiscardAt: null,
  hold() { return never.promise; },
  release() { timeoutReleased += 1; },
  onReject() { timeoutRejected += 1; },
});
await flush();
check(clock.fireTimeout(clock.timeouts.find((timer) => timer.active && timer.delay === 1_200)),
  'initial claim has a bounded ACK timeout');
check((await timed.initialAck) === false, 'an unanswered claim resolves as rejected');
await flush();
check(timed.phase === 'rejected' && timeoutRejected === 1 && timeoutReleased === 1,
  'claim timeout clears the epoch and sends a release tombstone');

/* ----------------------- heartbeat ordering and rejection --------------- */

clock.reset();
const initial = Promise.withResolvers();
const beat = Promise.withResolvers();
const orderedCalls = [];
let heartbeatReleases = 0;
const ordered = createReviewLease({
  id: 10,
  lease: 'ordered',
  enteredAt: 4,
  observedDiscardAt: 40,
  hold(id, lease, claim) {
    orderedCalls.push(claim);
    return claim.mode === 'claim' ? initial.promise : beat.promise;
  },
  release() { heartbeatReleases += 1; },
});
await flush();
check(orderedCalls.length === 1 && clock.intervals.length === 0,
  'no heartbeat can overtake an unresolved initial claim');
initial.resolve(ack(10, 'ordered'));
check(await ordered.initialAck, 'ordered initial claim is accepted');
await flush();
const heartbeatTimer = clock.intervals.find((timer) => timer.active);
check(clock.tick(heartbeatTimer), 'an accepted review owns one heartbeat schedule');
await flush();
check(orderedCalls.length === 2 && orderedCalls[1].mode === 'heartbeat'
    && !('enteredAt' in orderedCalls[1]) && !('observedDiscardAt' in orderedCalls[1]),
  'heartbeat uses its distinct protocol mode only after claim success');
beat.resolve(ack(10, 'ordered', false));
await flush();
check(ordered.phase === 'rejected' && heartbeatReleases === 1 && !heartbeatTimer.active,
  'heartbeat rejection stops refresh and tombstones the lease');

/* ----------------------- L1 response cannot affect the L2 epoch ---------- */

clock.reset();
const lateL1 = Promise.withResolvers();
const liveL2 = Promise.withResolvers();
let current = null;
let clearedLease = null;
function generation(lease, response) {
  const review = createReviewLease({
    id: 11,
    lease,
    enteredAt: 1,
    observedDiscardAt: null,
    hold() { return response.promise; },
    release() {},
    onReject(rejected) {
      if (current !== rejected) return;
      clearedLease = rejected.lease;
      current = null;
    },
  });
  current = review;
  return review;
}
const l1 = generation('L1-late', lateL1);
await flush();
l1.release();
const l2 = generation('L2-current', liveL2);
await flush();
lateL1.resolve(ack(11, 'L1-late', false));
await l1.initialAck;
await flush();
check(current === l2 && clearedLease === null,
  'a delayed L1 rejection cannot clear the current L2 generation');
liveL2.resolve(ack(11, 'L2-current'));
check(await l2.initialAck, 'the independent L2 claim remains valid');
await flush();
l2.release();

/* ----------------------- carried review keeps the same epoch ------------- */

const carryStart = source.indexOf('let carriedHold = null;');
const carryEnd = source.indexOf('\n/**\n * Restore one row', carryStart);
if (carryStart === -1 || carryEnd === -1) throw new Error('cannot locate carried review helper');
const documentListeners = new Map();
const windowListeners = new Map();
const fakeDocument = {
  addEventListener(name, listener) { documentListeners.set(name, listener); },
  removeEventListener(name, listener) {
    if (documentListeners.get(name) === listener) documentListeners.delete(name);
  },
};
const fakeWindow = {
  document: fakeDocument,
  addEventListener(name, listener) { windowListeners.set(name, listener); },
  removeEventListener(name, listener) {
    if (windowListeners.get(name) === listener) windowListeners.delete(name);
  },
};
const carriedCalls = [];
function carriedApi(method, body) {
  carriedCalls.push({ method, body });
  if (body.action === 'hold') return Promise.resolve(ack(body.id, body.lease));
  return Promise.resolve({
    review: { action: 'release', id: body.id, lease: body.lease, accepted: true },
  });
}
const carryFactory = new Function(
  'realGlobal', 'api',
  `${source.slice(carryStart, carryEnd)}
   return carryHoldUntilPointerMoves;`,
);
const carryHoldUntilPointerMoves = carryFactory(() => fakeWindow, carriedApi);

clock.reset();
const carried = createReviewLease({
  id: 12,
  lease: 'carried',
  enteredAt: 5,
  observedDiscardAt: 50,
  hold() { throw new Error('card transport must be replaced by carry'); },
  release() { throw new Error('card release transport must be replaced by carry'); },
});
carryHoldUntilPointerMoves(carried);
check(documentListeners.has('pointermove') && carried.phase === 'claiming',
  'click handoff preserves the pending epoch instead of immediately releasing it');
check(await carried.initialAck, 'the carried initial claim still requires an exact ACK');
await flush();
check(carriedCalls[0]?.body.mode === 'claim'
    && carriedCalls[0]?.body.enteredAt === 5
    && carriedCalls[0]?.body.observedDiscardAt === 50,
  'carried handoff retains the original claim metadata and ordering');
documentListeners.get('pointermove')();
await flush();
check(carried.phase === 'released'
    && carriedCalls.some((call) => call.body.action === 'release')
    && !documentListeners.has('pointermove'),
  'the first real pointer movement releases and detaches the carried epoch');

console.log(`\n${checks - failed}/${checks} passed`);
process.exit(failed === 0 ? 0 : 1);
