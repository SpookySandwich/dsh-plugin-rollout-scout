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
const fakeTimers = [];

// Keep long plugin timers deterministic while retaining short polling waits.
globalThis.setTimeout = (callback, delay, ...args) => {
  if (delay >= 3000) {
    const timer = { callback: () => callback(...args), delay, active: true };
    fakeTimers.push(timer);
    return timer;
  }
  return originalSetTimeout(callback, delay, ...args);
};
globalThis.clearTimeout = (timer) => {
  if (timer && typeof timer === 'object' && 'active' in timer) timer.active = false;
  else originalClearTimeout(timer);
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

async function until(predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const response = await send('GET');
    if (predicate(response.body) || Date.now() > deadline) return response.body;
    await new Promise((resolve) => originalSetTimeout(resolve, 10));
  }
}

function event(sessionId, value) {
  listeners.get(sessionId)?.(null, value);
}

function think(sessionId, text) {
  event(sessionId, { type: 'assistant/chunk', data: { chunk: { type: 'reasoning-delta', text } } });
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
await fs.writeFile(path.join(FOLDER, '.rollout-scout.json'), '{"version":1,"protected":[]}\n');

/* --------------------------------------- stop while create() is unresolved -- */

creationGate = Promise.withResolvers();
response = await send('POST', JSON.stringify({
  action: 'start', config: { prompt: 'probe', folder: FOLDER, concurrency: 1 },
}));
check(response.status === 200, 'start returns while agent creation is pending');
let view = await until((state) => state.attempts[0]?.status === 'starting');
const starting = view.attempts[0];

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
check(fireTimer(3200), 'the discard fade can be committed deterministically');
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
response = await send('POST', JSON.stringify({ action: 'hold', id: hovered.id, lease: 'mouse-1' }));
check(response.body.attempts[0].held && response.body.attempts[0].status === 'streaming',
  'hover itself keeps a fading conversation alive');
event(hovered.sessionId, { type: 'turn/end' });
await until((state) => state.active === 0);
response = await send('POST', JSON.stringify({ action: 'release', id: hovered.id, lease: 'mouse-1' }));
check(response.status === 200 && response.body.attempts[0].status === 'discarded',
  'leaving after turn/end returns the borrowed hover and discards normally');

response = await send('POST', JSON.stringify({ action: 'release', id: 999_999, lease: 'stale-card' }));
check(response.status === 200, 'release from an already-cleared card is an idempotent no-op');

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
await fs.rm(FOLDER, { recursive: true, force: true });

console.log(`\n${checks - failed}/${checks} passed`);
process.exit(failed === 0 ? 0 : 1);
