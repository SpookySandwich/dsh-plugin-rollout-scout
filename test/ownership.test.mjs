// Adversarial ownership and timer boundaries.
//
// These are the races ordinary happy-path tests miss: a stop arriving before
// create() returns, a Keep arriving after cancellation is committed, a turn
// ending under hover, and an Unkeep that must restore the original watchdog.
//
//   node test/ownership.test.mjs
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';

const FOLDER = path.join(os.tmpdir(), 'rollout-scout-ownership-test');
const originalSetTimeout = globalThis.setTimeout;
const originalClearTimeout = globalThis.clearTimeout;
const originalDateNow = Date.now;
const originalRename = fs.rename.bind(fs);
const fakeTimers = [];
let fakeNow = originalDateNow();
let manifestWriteGate = null;
let manifestRenameFailure = null;

// Keep long plugin timers deterministic while retaining short polling waits.
globalThis.setTimeout = (callback, delay, ...args) => {
  if (delay >= 3000) {
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

// Gate one selected atomic manifest rename so Force Stop can be placed exactly
// between durable ownership and agent creation.
fs.rename = async (...args) => {
  if (manifestRenameFailure !== null) {
    const error = manifestRenameFailure;
    manifestRenameFailure = null;
    throw error;
  }
  const gate = manifestWriteGate;
  if (gate !== null && !gate.blocked) {
    if (gate.remaining > 0) gate.remaining -= 1;
    else {
      gate.blocked = true;
      gate.entered.resolve();
      await gate.release.promise;
    }
  }
  return originalRename(...args);
};

const { apply } = await import('../lib/index.js');

let checks = 0;
let failed = 0;
function check(ok, message) {
  checks += 1;
  if (!ok) failed += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${message}`);
}

function fireTimer(delay) {
  const timer = fakeTimers.findLast((candidate) => candidate.active && candidate.delay === delay);
  if (timer === undefined) return false;
  timer.active = false;
  fakeNow = Math.max(fakeNow, timer.dueAt);
  timer.callback();
  return true;
}

function fireSpecificTimer(timer) {
  if (timer === undefined || !timer.active) return false;
  timer.active = false;
  fakeNow = Math.max(fakeNow, timer.dueAt);
  timer.callback();
  return true;
}

const listeners = new Map();
const cancelled = new Set();
const disposed = new Set();
const prompted = new Set();
const live = new Map();
const attached = new Set();
let creationGate = null;
let createCalls = 0;

const workspace = {
  path: FOLDER,
  get sessionIds() { return [...attached]; },
  attachSession: async (id) => { attached.add(id); },
  detachSession: async (id) => { attached.delete(id); },
};

const routes = [];
apply({
  effect(fn) { routes.push(fn()); },
  get: (service) => (service === 'sessionTitle' ? { rename() {} } : undefined),
  webServer: { register(route) { routes.push(route); return route; } },
  workspaceRegistry: {
    list: () => [workspace],
    resolveByPath: async () => workspace,
    create: async () => workspace,
  },
  sessions: { list: () => [...live.values()], get: (id) => live.get(id) },
  agents: {
    get: (id) => live.get(id)?.agent,
    create: async ({ sessionId, setup }) => {
      createCalls += 1;
      if (creationGate !== null) await creationGate.promise;
      setup({ on(_name, listener) { listeners.set(sessionId, listener); } });
      const agent = {
        followup() { prompted.add(sessionId); },
        cancel() { cancelled.add(sessionId); },
        status: 'running',
        whenIdle: async () => {},
      };
      live.set(sessionId, { id: sessionId, header: { id: sessionId, cwd: FOLDER }, agent });
      return {
        agent,
        dispose: async () => {
          disposed.add(sessionId);
          live.delete(sessionId);
        },
      };
    },
  },
  sessionPersistence: {
    list: async () => [],
    locate: ({ id }) => ({ path: path.join(FOLDER, 'logs', id, 'session.jsonl') }),
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

async function claim(id, lease) {
  const snapshot = (await send('GET')).body;
  const card = snapshot.attempts.find((item) => item.id === id);
  return send('POST', JSON.stringify({
    action: 'hold', id, lease, mode: 'claim', enteredAt: Date.now(),
    observedDiscardAt: card?.discardAt ?? null,
  }));
}

async function until(predicate, timeoutMs = 3000) {
  const deadline = originalDateNow() + timeoutMs;
  for (;;) {
    const response = await send('GET');
    if (predicate(response.body) || originalDateNow() > deadline) return response.body;
    await new Promise((resolve) => originalSetTimeout(resolve, 10));
  }
}

function event(sessionId, value) {
  listeners.get(sessionId)?.(null, value);
}

function think(sessionId, text) {
  event(sessionId, { type: 'assistant/chunk', data: { chunk: { type: 'reasoning-delta', text } } });
}

async function writeLog(sessionId) {
  const directory = path.join(FOLDER, 'logs', sessionId);
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, 'session.jsonl'), 'probe\n');
}

await fs.rm(FOLDER, { recursive: true, force: true });

/* -------------------------------- corrupted Keep data fails closed on disk -- */

await fs.mkdir(FOLDER, { recursive: true });
await fs.writeFile(path.join(FOLDER, '.rollout-scout.json'), '{broken');
let response = await send('POST', JSON.stringify({
  action: 'start', config: { prompt: 'probe', folder: FOLDER, concurrency: 1 },
}));
check(response.status === 409 && response.body.error.includes('protection record'),
  'a corrupt protection record blocks the run instead of risking kept logs');
check((await send('GET')).body.attempts.length === 0, 'no probe starts before protection is known');
await fs.writeFile(path.join(FOLDER, '.rollout-scout.json'),
  '{"version":2,"owned":[],"protected":["session-not-owned"]}\n');
response = await send('POST', JSON.stringify({
  action: 'start', config: { prompt: 'probe', folder: FOLDER, concurrency: 1 },
}));
check(response.status === 409 && response.body.error.includes('must be owned'),
  'a malformed v2 subset also fails closed');
check((await send('GET')).body.attempts.length === 0, 'malformed ownership cannot create a probe');

await fs.writeFile(path.join(FOLDER, '.rollout-scout.json'),
  '{"version":3,"owned":["session-one"],"protected":[],"deleting":["session-other"]}\n');
response = await send('POST', JSON.stringify({
  action: 'start', config: { prompt: 'probe', folder: FOLDER, concurrency: 1 },
}));
check(response.status === 409 && response.body.error.includes('deleting ids must be owned'),
  'v3 rejects a deletion transaction without ownership');
await fs.writeFile(path.join(FOLDER, '.rollout-scout.json'),
  '{"version":3,"owned":["session-one"],"protected":["session-one"],"deleting":["session-one"]}\n');
response = await send('POST', JSON.stringify({
  action: 'start', config: { prompt: 'probe', folder: FOLDER, concurrency: 1 },
}));
check(response.status === 409 && response.body.error.includes('cannot be protected'),
  'v3 keeps protected and deleting states disjoint');

await fs.writeFile(path.join(FOLDER, '.rollout-scout.json'),
  '{"version":1,"protected":["session-legacy-keep"]}\n');
live.set('session-legacy-unowned', {
  id: 'session-legacy-unowned', header: { id: 'session-legacy-unowned', cwd: FOLDER },
});
attached.add('session-legacy-unowned');

/* ------------------------------- stop while ownership write is unresolved -- */

manifestWriteGate = {
  remaining: 1,
  blocked: false,
  entered: Promise.withResolvers(),
  release: Promise.withResolvers(),
};
const createsBeforeOwnershipStop = createCalls;
response = await send('POST', JSON.stringify({
  action: 'start', config: { prompt: 'probe', folder: FOLDER, concurrency: 1 },
}));
check(response.status === 200, 'start returns while the ownership claim is pending');
await manifestWriteGate.entered.promise;
let view = await until((state) => state.attempts[0]?.status === 'starting'
  && state.attempts[0]?.sessionId !== null);
const claiming = view.attempts[0];
const claimingId = claiming.sessionId;
let migrated = JSON.parse(await fs.readFile(path.join(FOLDER, '.rollout-scout.json'), 'utf8'));
check(migrated.version === 3
  && migrated.owned.includes('session-legacy-keep')
  && migrated.protected.includes('session-legacy-keep'),
  'v1 migrates only its explicit Keep ids into v3 ownership');
check(!migrated.owned.includes('session-legacy-unowned'),
  'v1 migration never adopts an arbitrary same-cwd workspace session');

response = await send('POST', '{"action":"force-stop"}');
check(response.status === 200 && response.body.active === 1,
  'force stop marks the unresolved ownership boundary as draining');
manifestWriteGate.release.resolve();
manifestWriteGate = null;
view = await until((state) => state.active === 0);
migrated = JSON.parse(await fs.readFile(path.join(FOLDER, '.rollout-scout.json'), 'utf8'));
const abandoned = view.attempts.find((attempt) => attempt.id === claiming.id);
check(createCalls === createsBeforeOwnershipStop && abandoned?.sessionId === null,
  'a stop during manifest I/O never creates an agent');
check(!migrated.owned.includes(claimingId),
  'the uncreated session claim is relinquished after the stop');

/* --------------------------------------- stop while create() is unresolved -- */

creationGate = Promise.withResolvers();
response = await send('POST', JSON.stringify({
  action: 'start', config: { prompt: 'probe', folder: FOLDER, concurrency: 1 },
}));
check(response.status === 200, 'start returns while agent creation is pending');
view = await until((state) => state.attempts[0]?.id !== claiming.id
  && state.attempts[0]?.status === 'starting' && state.attempts[0]?.sessionId !== null);
const starting = view.attempts[0];
migrated = JSON.parse(await fs.readFile(path.join(FOLDER, '.rollout-scout.json'), 'utf8'));
check(migrated.owned.includes(starting.sessionId),
  'the generated id is durable before agent creation resolves');

response = await send('POST', '{"action":"force-stop"}');
check(response.status === 200 && response.body.active === 1,
  'force stop marks an unresolved creation as draining');
response = await send('POST', JSON.stringify({
  action: 'start', config: { prompt: 'second', folder: FOLDER, concurrency: 1 },
}));
check(response.status === 409, 'a new run cannot cross the previous create boundary');

creationGate.resolve();
creationGate = null;
view = await until((state) => state.active === 0);
const stoppedStart = view.attempts.find((attempt) => attempt.id === starting.id);
check(stoppedStart?.sessionId && !prompted.has(stoppedStart.sessionId), 'the late-created agent is never prompted');
check(stoppedStart?.sessionId && disposed.has(stoppedStart.sessionId), 'the late-created agent is disposed');

/* --------------------------------------- Unkeep restores the same deadline -- */

response = await send('POST', JSON.stringify({
  action: 'start', config: { prompt: 'probe', folder: FOLDER, concurrency: 1 },
}));
view = await until((state) => state.attempts[0]?.status === 'streaming');
const timed = view.attempts[0];
const firstWatchdog = fakeTimers.findLast((timer) => timer.active && timer.delay > 200_000);
check(firstWatchdog !== undefined, 'a live probe owns a watchdog');

await send('POST', JSON.stringify({ action: 'protect', id: timed.id }));
check(firstWatchdog.active === false, 'Keep disarms automatic cancellation');
await send('POST', JSON.stringify({ action: 'unprotect', id: timed.id }));
const rearmed = fakeTimers.findLast((timer) => timer.active && timer.delay > 200_000);
check(rearmed !== undefined && rearmed !== firstWatchdog,
  'Unkeep re-arms the watchdog against the original prompt deadline');
await send('POST', '{"action":"force-stop"}');
await until((state) => state.active === 0);

/* -------------------------------- cancellation cannot be rescued halfway -- */

await send('POST', JSON.stringify({
  action: 'start', config: { prompt: 'probe', folder: FOLDER, concurrency: 1 },
}));
view = await until((state) => state.attempts[0]?.status === 'streaming');
const cancelling = view.attempts[0];
think(cancelling.sessionId, 'The directory is empty. Let me inspect the files before editing anything.\n');
view = await until((state) => state.attempts[0].status === 'pending-discard');
check(fireTimer(3450), 'the discard fade can be committed deterministically');
view = (await send('GET')).body;
check(view.attempts[0].status === 'discarding', 'the turn crossed the cancellation boundary');

await send('POST', JSON.stringify({ action: 'protect', id: cancelling.id }));
check(fakeTimers.some((timer) => timer.active && timer.delay === 10_000),
  'Keep during cancellation preserves the cancel reaper');
await send('POST', '{"action":"pause"}');
check(fireTimer(10_000), 'the cancel reaper fires when turn/end never arrives');
view = await until((state) => state.active === 0);
check(disposed.has(cancelling.sessionId), 'the cancelled protected agent is still disposed');
check(view.attempts.find((attempt) => attempt.id === cancelling.id)?.protected,
  'its disk-retention promise survives disposal');
await send('POST', '{"action":"force-stop"}');

/* ------------------------------------- hover remains a temporary lease only -- */

await send('POST', JSON.stringify({
  action: 'start', config: { prompt: 'probe', folder: FOLDER, concurrency: 1 },
}));
view = await until((state) => state.attempts[0]?.status === 'streaming');
const hovered = view.attempts[0];
await send('POST', '{"action":"pause"}');
think(hovered.sessionId, 'The directory is empty. Let me inspect it first.\n');
await until((state) => state.attempts[0].status === 'pending-discard');
response = await claim(hovered.id, 'mouse-1');
check(response.body.attempts[0].held && response.body.attempts[0].status === 'streaming',
  'hover itself keeps a fading conversation alive');
event(hovered.sessionId, { type: 'turn/end' });
await until((state) => state.active === 0);
response = await send('POST', JSON.stringify({ action: 'release', id: hovered.id, lease: 'mouse-1' }));
const resumedHoverFade = fakeTimers.findLast((timer) => timer.active
  && timer.delay > 0 && timer.delay <= 3_450);
check(response.status === 200 && response.body.attempts[0].status === 'pending-discard'
    && Number.isFinite(response.body.attempts[0].discardAt),
  'leaving after turn/end resumes the borrowed hover remainder');
check(fireSpecificTimer(resumedHoverFade), 'the resumed hover remainder reaches discard');
view = (await send('GET')).body;
check(view.attempts[0].status === 'discarded',
  'the ended hover is discarded at its resumed deadline');

response = await send('POST', JSON.stringify({ action: 'release', id: 999_999, lease: 'stale-card' }));
check(response.status === 200, 'release from an already-cleared card is an idempotent no-op');

/* -------------------------------- Keep persistence errors fail closed -- */

await send('POST', '{"action":"force-stop"}');
await send('POST', '{"action":"clear"}');
await send('POST', JSON.stringify({
  action: 'start', config: {
    prompt: 'probe', folder: FOLDER, concurrency: 1, autoDelete: true,
  },
}));
view = await until((state) => state.attempts[0]?.status === 'streaming');
const keepFault = view.attempts[0];
await writeLog(keepFault.sessionId);
await send('POST', '{"action":"pause"}');
think(keepFault.sessionId, 'The directory is empty. Let me inspect it before making changes.\n');
event(keepFault.sessionId, { type: 'turn/end' });
view = await until((state) => state.active === 0
  && state.attempts.find((attempt) => attempt.id === keepFault.id)?.status === 'pending-discard');

manifestRenameFailure = Object.assign(new Error('injected Keep persistence failure'), { code: 'EIO' });
response = await send('POST', JSON.stringify({ action: 'protect', id: keepFault.id }));
check(response.status === 409 && response.body.error.includes('injected Keep persistence failure'),
  'a failed Keep reports its persistence error');
view = (await send('GET')).body;
let faultCard = view.attempts.find((attempt) => attempt.id === keepFault.id);
check(faultCard?.protected && faultCard.status === 'pinned'
  && faultCard.retention.intent === 'manual' && faultCard.retention.durability === 'failed'
  && faultCard.retention.operation === 'protect',
  'failed persistence preserves the manual Keep intent as an explicit state');
check(view.invariantErrors.length === 0,
  `failed Keep remains a valid state (${view.invariantErrors.join(', ')})`);

let diskManifest = JSON.parse(await fs.readFile(path.join(FOLDER, '.rollout-scout.json'), 'utf8'));
check(diskManifest.owned.includes(keepFault.sessionId)
  && !diskManifest.protected.includes(keepFault.sessionId),
  'the fault is real: ownership is durable while protection is not');
response = await send('POST', '{"action":"clear"}');
check(response.status === 200
  && response.body.attempts.some((attempt) => attempt.id === keepFault.id),
  'Clear cannot reinterpret a failed Keep as deletion permission');
response = await send('POST', '{"action":"delete-all"}');
check(response.status === 200
  && response.body.attempts.some((attempt) => attempt.id === keepFault.id),
  'Delete all also observes the in-memory retention authority');
check(await fs.readFile(path.join(FOLDER, 'logs', keepFault.sessionId, 'session.jsonl'), 'utf8') === 'probe\n',
  'the conversation log survives every cleanup path after failed Keep');

response = await send('POST', JSON.stringify({ action: 'protect', id: keepFault.id }));
faultCard = response.body.attempts.find((attempt) => attempt.id === keepFault.id);
check(response.status === 200 && faultCard.retention.durability === 'durable',
  'retrying Keep advances the same intent to durable');
diskManifest = JSON.parse(await fs.readFile(path.join(FOLDER, '.rollout-scout.json'), 'utf8'));
check(diskManifest.protected.includes(keepFault.sessionId),
  'successful retry records protection on disk');

manifestRenameFailure = Object.assign(new Error('injected Unkeep persistence failure'), { code: 'EIO' });
response = await send('POST', JSON.stringify({ action: 'unprotect', id: keepFault.id }));
check(response.status === 409 && response.body.error.includes('injected Unkeep persistence failure'),
  'a failed Unkeep reports its persistence error');
view = (await send('GET')).body;
faultCard = view.attempts.find((attempt) => attempt.id === keepFault.id);
check(faultCard?.protected && faultCard.retention.durability === 'failed'
  && faultCard.retention.operation === 'unprotect',
  'failed Unkeep leaves effective retention in force');
check(await fs.readFile(path.join(FOLDER, 'logs', keepFault.sessionId, 'session.jsonl'), 'utf8') === 'probe\n',
  'failed Unkeep cannot delete the retained log');

response = await send('POST', JSON.stringify({ action: 'unprotect', id: keepFault.id }));
faultCard = response.body.attempts.find((attempt) => attempt.id === keepFault.id);
check(response.status === 200 && !faultCard.protected && faultCard.status === 'discarded',
  'successful Unkeep hands the ended old probe back to reconciliation');
view = await until((state) =>
  state.attempts.find((attempt) => attempt.id === keepFault.id)?.deleted === true);
check(view.invariantErrors.length === 0,
  `post-Unkeep deletion remains valid (${view.invariantErrors.join(', ')})`);
check(await fs.access(path.join(FOLDER, 'logs', keepFault.sessionId)).then(() => false, () => true),
  'the log is deleted only after Unkeep becomes durable');

/* --------------------------- automatic Keep faults use the same retry axis -- */

await send('POST', '{"action":"clear"}');
await send('POST', JSON.stringify({
  action: 'start', config: {
    prompt: 'probe', folder: FOLDER, concurrency: 1, autoDelete: true,
  },
}));
view = await until((state) => state.attempts[0]?.status === 'streaming');
const autoKeepFault = view.attempts[0];
await writeLog(autoKeepFault.sessionId);
think(autoKeepFault.sessionId, "I'll inspect the constraints carefully before implementing the change.\n");
view = await until((state) =>
  state.attempts.find((attempt) => attempt.id === autoKeepFault.id)?.verdict === 'rollout');
manifestRenameFailure = Object.assign(new Error('injected automatic Keep failure'), { code: 'EIO' });
event(autoKeepFault.sessionId, { type: 'turn/end' });
view = await until((state) => {
  const attempt = state.attempts.find((item) => item.id === autoKeepFault.id);
  return state.active === 0 && attempt?.retention.durability === 'failed';
});
faultCard = view.attempts.find((attempt) => attempt.id === autoKeepFault.id);
check(faultCard?.protected && faultCard.status === 'kept'
  && faultCard.retention.intent === 'auto' && faultCard.retention.durability === 'failed',
  'an automatic Keep failure remains a retained catch, not an execution failure');
check(fireTimer(12_000), 'an automatic catch schedules a bounded persistence retry');
view = await until((state) =>
  state.attempts.find((attempt) => attempt.id === autoKeepFault.id)?.retention.durability === 'durable');
faultCard = view.attempts.find((attempt) => attempt.id === autoKeepFault.id);
check(faultCard?.retention.intent === 'auto' && faultCard.error === null,
  'the background retry makes automatic retention durable and clears its fault');
response = await send('POST', JSON.stringify({ action: 'protect', id: autoKeepFault.id }));
faultCard = response.body.attempts.find((attempt) => attempt.id === autoKeepFault.id);
check(response.status === 200 && faultCard.status === 'kept'
  && faultCard.retention.intent === 'manual' && faultCard.retention.durability === 'durable'
  && faultCard.error === null,
  'manual retry upgrades automatic intent and clears only the retention fault');
await send('POST', JSON.stringify({ action: 'unprotect', id: autoKeepFault.id }));
await send('POST', '{"action":"delete-all"}');

/* ------------------------------------ refill waits for natural disposition -- */

await send('POST', '{"action":"force-stop"}');
await send('POST', JSON.stringify({
  action: 'start', config: { prompt: 'probe', folder: FOLDER, concurrency: 1 },
}));
view = await until((state) => state.attempts[0]?.status === 'streaming');
const completing = view.attempts[0];
const launchedBeforeFinish = view.launched;
think(completing.sessionId, "I'll inspect the constraints carefully before implementing the change.\n");
event(completing.sessionId, { type: 'turn/end' });
view = await until((state) => state.launched > launchedBeforeFinish
  && state.attempts[0]?.status === 'streaming');
check(disposed.has(completing.sessionId), 'natural turn/end disposes its agent handle');
check(view.launched === launchedBeforeFinish + 1,
  'the pump refills only after natural disposal frees the concurrency slot');

/* -------------------------------- review traffic bypasses a blocked action -- */

await send('POST', '{"action":"force-stop"}');
await until((state) => state.active === 0);
await send('POST', '{"action":"clear"}');
await send('POST', JSON.stringify({
  action: 'start', config: { prompt: 'probe', folder: FOLDER, concurrency: 1 },
}));
view = await until((state) => state.attempts[0]?.status === 'streaming');
const priorityAttempt = view.attempts[0];
manifestWriteGate = {
  remaining: 0,
  blocked: false,
  entered: Promise.withResolvers(),
  release: Promise.withResolvers(),
};
let protectSettled = false;
const blockedProtect = send('POST', JSON.stringify({
  action: 'protect', id: priorityAttempt.id,
})).finally(() => { protectSettled = true; });
await manifestWriteGate.entered.promise;
const priorityTimeout = Symbol('priority-timeout');
const priorityClaim = await Promise.race([
  claim(priorityAttempt.id, 'priority-lane'),
  new Promise((resolve) => originalSetTimeout(() => resolve(priorityTimeout), 250)),
]);
const priorityRelease = await Promise.race([
  send('POST', JSON.stringify({
    action: 'release', id: priorityAttempt.id, lease: 'priority-lane',
  })),
  new Promise((resolve) => originalSetTimeout(() => resolve(priorityTimeout), 250)),
]);
check(!protectSettled && priorityClaim !== priorityTimeout
    && priorityClaim.body.review?.accepted === true
    && priorityClaim.body.attempts[0].held,
  'hold is accepted promptly while an ordinary manifest action owns the global queue');
check(priorityRelease !== priorityTimeout
    && priorityRelease.body.review?.accepted === true
    && !priorityRelease.body.attempts[0].held,
  'release is also prompt and reconciles only its real lease');
manifestWriteGate.release.resolve();
await blockedProtect;
manifestWriteGate = null;
await send('POST', '{"action":"force-stop"}');
await until((state) => state.active === 0);

/* ------------------------------------------------ unload closes pump first -- */

await send('POST', '{"action":"force-stop"}');
await send('POST', JSON.stringify({
  action: 'start', config: { prompt: 'probe', folder: FOLDER, concurrency: 1 },
}));
view = await until((state) => state.attempts[0]?.status === 'streaming');
const launchedBeforeUnload = view.launched;
unload();
view = await until((state) => state.active === 0);
check(view.running === false && view.launched === launchedBeforeUnload,
  'plugin unload closes the pump before released slots can launch replacements');

globalThis.setTimeout = originalSetTimeout;
globalThis.clearTimeout = originalClearTimeout;
Date.now = originalDateNow;
fs.rename = originalRename;
await fs.rm(FOLDER, { recursive: true, force: true });

console.log(`\n${checks - failed}/${checks} passed`);
process.exit(failed === 0 ? 0 : 1);
