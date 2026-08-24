// Deleting must never run while probes are still streaming.
//
// `pause` stops launching but leaves probes in flight, and it clears the
// `running` flag — so guarding delete-all on `running` alone let a paused run
// unlink the session log of a conversation that was still being written to.
// Clearing has always refused to touch live probes; this pins that deleting
// refuses too, and that force-stopping first lets it through.
//
//   node test/delete.test.mjs
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { apply } from '../lib/index.js';

const FOLDER = path.join(os.tmpdir(), 'rollout-scout-delete-test');

let checks = 0;
let failed = 0;

function check(ok, message) {
  checks += 1;
  if (!ok) failed += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${message}`);
}

// Probes that start cleanly and then never end: no `turn/end` is ever
// emitted, so every one of them stays live.
const removed = [];
let locateFails = false;
let detachFails = false;
let detachGate = null;
const detachCalls = new Map();
const listeners = new Map();
const attached = new Set();
const workspace = {
  path: FOLDER,
  get sessionIds() { return [...attached]; },
  attachSession: async (id) => { attached.add(id); },
  detachSession: async (id) => {
    detachCalls.set(id, (detachCalls.get(id) ?? 0) + 1);
    if (detachFails) throw new Error('workspace unavailable');
    if (detachGate?.id === id) {
      detachGate.entered.resolve();
      await detachGate.release.promise;
    }
    attached.delete(id);
  },
};

const routes = [];
apply({
  effect(fn) { routes.push(fn()); },
  webServer: { register(route) { routes.push(route); return route; } },
  workspaceRegistry: {
    list: () => [workspace],
    resolveByPath: async () => workspace,
    create: async () => workspace,
  },
  agents: {
    create: async ({ sessionId, setup }) => {
      setup({ on(name, listener) {
        if (name === 'session/event') listeners.set(sessionId, listener);
      } });
      const agent = { status: 'running', followup() {}, cancel() { agent.status = 'idle'; } };
      return { agent, dispose: async () => { agent.status = 'idle'; } };
    },
  },
  sessionPersistence: {
    list: async () => [...attached].map((id) => ({ id })),
    // Each session lives in its own directory, named for the session.
    locate: (header) => {
      if (locateFails) throw new Error('persistence unavailable');
      return { path: path.join(FOLDER, 'sessions', header.id, 'session.jsonl') };
    },
  },
});
const route = routes.find((r) => r && r.path === '/rollout-scout');

function send(method, body) {
  const stream = body === undefined ? Readable.from([]) : Readable.from([Buffer.from(body)]);
  stream.method = method;
  stream.headers = { host: '127.0.0.1:5173', 'content-type': 'application/json' };
  const out = { status: 0, body: null };
  const res = {
    writeHead(status) { out.status = status; },
    end(text) { out.body = text === undefined ? null : JSON.parse(text); },
  };
  return Promise.resolve(route.handler(stream, res)).then(() => out);
}

async function until(predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const r = await send('GET');
    if (predicate(r.body) || Date.now() > deadline) return r.body;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function event(sessionId, value) {
  listeners.get(sessionId)?.(null, value);
}

let r = await send('POST', JSON.stringify({
  action: 'start',
  config: { prompt: 'probe', folder: FOLDER, concurrency: 2 },
}));
check(r.status === 200, `start accepted (${r.status})`);

// 'starting' already counts as live, so wait for the sessions to be attached.
let view = await until((s) => s.attempts.length >= 2 && s.attempts.every((a) => a.status === 'streaming'));
check(view.active === 2, `two probes are live (active=${view.active})`);

// Write the session logs the probes would be writing, so a delete is visible.
for (const id of attached) {
  await fs.mkdir(path.join(FOLDER, 'sessions', id), { recursive: true });
  await fs.writeFile(path.join(FOLDER, 'sessions', id, 'session.jsonl'), 'live\n');
}
const liveIds = [...attached];
check(liveIds.length === 2, `two session logs exist on disk (${liveIds.length})`);

r = await send('POST', '{"action":"delete-all"}');
check(r.status === 409, `delete-all while running is refused (${r.status})`);

r = await send('POST', '{"action":"pause"}');
check(r.status === 200 && !(await send('GET')).body.running, 'paused: running is now false');

view = await send('GET');
check(view.body.active === 2, `but the probes are still live (active=${view.body.active})`);

r = await send('POST', '{"action":"delete-all"}');
check(r.status === 409, `delete-all while paused with live probes is refused (${r.status})`);
check(r.body.error.includes('force stop'), `and it says why: ${r.body.error}`);

const stillThere = await Promise.all(liveIds.map((id) =>
  fs.readFile(path.join(FOLDER, 'sessions', id, 'session.jsonl'), 'utf8').then(() => true, () => false)));
check(stillThere.every(Boolean), 'no live session log was unlinked');

r = await send('POST', '{"action":"clear"}');
check(r.status === 200 && r.body.attempts.length === 2, 'clear also leaves live probes alone');

// Force stop first, then deleting is allowed and actually removes the logs.
r = await send('POST', '{"action":"force-stop"}');
check(r.status === 200, `force-stop accepted (${r.status})`);
view = await until((s) => s.active === 0);
check(view.active === 0, `nothing is live any more (active=${view.active})`);

r = await send('POST', '{"action":"delete-all"}');
check(r.status === 200, `delete-all after force-stop succeeds (${r.status})`);
check(r.body.attempts.length === 0 && r.body.launched === 0, 'the list and the counters reset');

const gone = await Promise.all(liveIds.map((id) =>
  fs.readFile(path.join(FOLDER, 'sessions', id, 'session.jsonl'), 'utf8').then(() => false, () => true)));
check(gone.every(Boolean), 'and the session logs are gone from disk');
let manifest = JSON.parse(await fs.readFile(path.join(FOLDER, '.rollout-scout.json'), 'utf8'));
check(manifest.version === 3 && manifest.owned.length === 0 && manifest.deleting.length === 0,
  'successful deletion relinquishes durable ownership');

/* ---------------------------------------- failed delete keeps its own card -- */

r = await send('POST', JSON.stringify({
  action: 'start', config: { prompt: 'probe', folder: FOLDER, concurrency: 1 },
}));
view = await until((s) => s.attempts.length === 1 && s.attempts[0].status === 'streaming');
const retryable = view.attempts[0];
await fs.mkdir(path.join(FOLDER, 'sessions', retryable.sessionId), { recursive: true });
await fs.writeFile(path.join(FOLDER, 'sessions', retryable.sessionId, 'session.jsonl'), 'live\n');
await send('POST', '{"action":"force-stop"}');
await until((s) => s.active === 0);

locateFails = true;
r = await send('POST', '{"action":"delete-all"}');
check(r.status === 409, `a persistence failure is reported (${r.status})`);
view = (await send('GET')).body;
check(view.attempts.some((attempt) => attempt.id === retryable.id),
  'the failed session keeps its card, so it remains reachable');
check(await fs.readFile(path.join(FOLDER, 'sessions', retryable.sessionId, 'session.jsonl'), 'utf8').then(() => true, () => false),
  'the failed session log is still intact');
manifest = JSON.parse(await fs.readFile(path.join(FOLDER, '.rollout-scout.json'), 'utf8'));
check(manifest.owned.includes(retryable.sessionId),
  'a failed log deletion retains durable ownership for retry');
check(manifest.deleting.includes(retryable.sessionId),
  'the durable deleting transaction records the retry point before touching the log');

locateFails = false;
r = await send('POST', '{"action":"delete-all"}');
check(r.status === 200 && r.body.attempts.length === 0, 'retrying deletion succeeds cleanly');

/* ----------------------------- detach failure also retains durable authority -- */

r = await send('POST', JSON.stringify({
  action: 'start', config: { prompt: 'probe', folder: FOLDER, concurrency: 1 },
}));
view = await until((s) => s.attempts.length === 1 && s.attempts[0].status === 'streaming');
const detachRetry = view.attempts[0];
await fs.mkdir(path.join(FOLDER, 'sessions', detachRetry.sessionId), { recursive: true });
await fs.writeFile(path.join(FOLDER, 'sessions', detachRetry.sessionId, 'session.jsonl'), 'live\n');
await send('POST', '{"action":"force-stop"}');
await until((s) => s.active === 0);

detachFails = true;
r = await send('POST', '{"action":"delete-all"}');
check(r.status === 409, `a workspace detach failure is reported (${r.status})`);
manifest = JSON.parse(await fs.readFile(path.join(FOLDER, '.rollout-scout.json'), 'utf8'));
check(manifest.owned.includes(detachRetry.sessionId) && attached.has(detachRetry.sessionId),
  'an incomplete detach retains both the card and durable ownership');
check(manifest.deleting.includes(detachRetry.sessionId),
  'a detach failure also remains inside the durable deleting transaction');

detachFails = false;
r = await send('POST', '{"action":"delete-all"}');
manifest = JSON.parse(await fs.readFile(path.join(FOLDER, '.rollout-scout.json'), 'utf8'));
check(r.status === 200 && !manifest.owned.includes(detachRetry.sessionId),
  'the idempotent retry completes detachment and relinquishes ownership');

/* ---------------------------- auto-delete and button deletion coalesce -- */

r = await send('POST', JSON.stringify({
  action: 'start', config: {
    prompt: 'probe', folder: FOLDER, concurrency: 1, autoDelete: true,
  },
}));
view = await until((s) => s.attempts.length === 1 && s.attempts[0].status === 'streaming');
const overlapping = view.attempts[0];
await fs.mkdir(path.join(FOLDER, 'sessions', overlapping.sessionId), { recursive: true });
await fs.writeFile(path.join(FOLDER, 'sessions', overlapping.sessionId, 'session.jsonl'), 'live\n');
detachGate = {
  id: overlapping.sessionId,
  entered: Promise.withResolvers(),
  release: Promise.withResolvers(),
};
event(overlapping.sessionId, {
  type: 'assistant/chunk',
  data: { chunk: { type: 'reasoning-delta', text: 'The directory is empty. Let me inspect every file before editing.\n' } },
});
await until((s) => s.attempts[0]?.status === 'pending-discard');
r = await send('POST', '{"action":"pause"}');
const revisionBeforeOverlap = r.body.sessionsRevision;
event(overlapping.sessionId, { type: 'turn/end' });
await detachGate.entered.promise;

const concurrentDelete = send('POST', '{"action":"delete-all"}');
await new Promise((resolve) => setImmediate(resolve));
detachGate.release.resolve();
r = await concurrentDelete;
detachGate = null;
check(r.status === 200 && r.body.attempts.length === 0,
  'delete-all joins an in-flight auto-delete instead of starting another');
check(detachCalls.get(overlapping.sessionId) === 1,
  'the overlapping session crosses the workspace deletion boundary once');
check(r.body.sessionsRevision === revisionBeforeOverlap + 1,
  'the coalesced deletion advances the sidebar revision once');

await fs.rm(FOLDER, { recursive: true, force: true });

console.log(`\n${checks - failed}/${checks} passed`);
process.exit(failed === 0 ? 0 : 1);
