import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { apply } from '../lib/index.js';

const FOLDER = path.join(os.tmpdir(), 'rollout-scout-unsupported-cleanup-test');
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
const workspace = {
  path: FOLDER,
  get sessionIds() { return [...attached]; },
  attachSession: async (id) => { attached.add(id); },
  detachSession: async (id) => { attached.delete(id); },
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
  sessions: { list: () => [...live.values()], get: (id) => live.get(id) },
  agents: {
    get: (id) => live.get(id)?.agent,
    create: async ({ sessionId, setup }) => {
      setup({ on(name, listener) { if (name === 'session/event') listeners.set(sessionId, listener); } });
      const agent = {
        status: 'running', followup() {},
        cancel() { agent.status = 'idle'; },
        whenIdle: async () => {},
      };
      live.set(sessionId, { id: sessionId, header: { id: sessionId, cwd: FOLDER }, agent });
      return { agent, dispose: async () => { live.delete(sessionId); } };
    },
  },
  sessionPersistence: { list: async () => [...attached].map((id) => ({ id, cwd: FOLDER })) },
});
const route = routes.find((entry) => entry?.path === '/rollout-scout');

function send(method, body) {
  const request = body === undefined ? Readable.from([]) : Readable.from([Buffer.from(body)]);
  request.method = method;
  request.headers = { host: '127.0.0.1:5173', 'content-type': 'application/json' };
  const out = { status: 0, body: null };
  const response = {
    writeHead(status) { out.status = status; },
    end(text) { out.body = text === undefined ? null : JSON.parse(text); },
  };
  return Promise.resolve(route.handler(request, response)).then(() => out);
}

const action = (name, extra = {}) => send('POST', JSON.stringify({ action: name, ...extra }));

async function until(predicate, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const response = await send('GET');
    if (predicate(response.body) || Date.now() >= deadline) return response.body;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function discardCurrent() {
  const view = await until((state) => state.running && state.attempts[0]?.status === 'streaming');
  const current = view.attempts[0];
  listeners.get(current.sessionId)?.(null, {
    type: 'assistant/chunk',
    data: { chunk: {
      type: 'reasoning-delta',
      text: 'The directory is empty. Let me inspect it before making changes.\n',
    } },
  });
  await until((state) => state.attempts[0]?.status === 'pending-discard');
  await action('pause');
  listeners.get(current.sessionId)?.(null, { type: 'turn/end' });
  await until((state) => state.active === 0
    && state.attempts.find((attempt) => attempt.id === current.id)?.status === 'discarded');
  return current;
}

const cardIn = (response, id) =>
  (response.body.attempts ?? response.body.state.attempts).find((attempt) => attempt.id === id);

async function stillKeepable(id, label) {
  let response = await action('protect', { id });
  check(response.status === 200 && cardIn(response, id)?.protected === true, `Keep succeeds after ${label}`);
  response = await action('unprotect', { id });
  check(response.status === 200 && !cardIn(response, id)?.protected,
    `and Unkeep returns the probe to ordinary history after ${label}`);
}

const manifest = async () => JSON.parse(await fs.readFile(path.join(FOLDER, '.rollout-scout.json'), 'utf8'));

await fs.rm(FOLDER, { recursive: true, force: true });
let view = (await send('GET')).body;
check(view.cleanupSupported === false, 'the state reports that this store cannot delete probes');

let response = await action('start', { config: { prompt: 'probe', folder: FOLDER, concurrency: 1, autoDelete: true } });
check(response.status === 200, 'a run starts with automatic deletion requested');
const discarded = await discardCurrent();
view = (await send('GET')).body;
let card = view.attempts.find((attempt) => attempt.id === discarded.id);
check(card && !card.deleted && !card.error, 'automatic deletion is not attempted for a discarded probe');
await stillKeepable(discarded.id, 'automatic deletion was skipped');

for (const name of ['clear', 'delete-all', 'reap']) {
  response = await action(name);
  check(response.status === 409 && response.body.error.includes('cleanup is unsupported'),
    `${name} is refused as unsupported (${response.status})`);
  card = cardIn(response, discarded.id);
  check(card && !card.deleted && !card.error, `${name} leaves the probe card ordinary`);
  if (name !== 'reap') await stillKeepable(discarded.id, `a refused ${name}`);
}

let record = await manifest();
check(record.owned.includes(discarded.sessionId) && record.deleting.length === 0
  && attached.has(discarded.sessionId), 'ownership and workspace membership are untouched');

await action('resume');
for (let index = 0; index < 125; index += 1) {
  await discardCurrent();
  await action('resume');
}
view = await until((state) => state.attempts[0]?.status === 'streaming');
check(view.attempts.length <= 122, `refused probes are still trimmed by the history limit (${view.attempts.length} cards)`);
check(!view.attempts.some((attempt) => attempt.id === discarded.id), 'the oldest ordinary card left the list');
check(view.attempts.every((attempt) => !attempt.error), 'no card carries a deletion error');
record = await manifest();
check(record.owned.includes(discarded.sessionId) && record.deleting.length === 0,
  'a trimmed card never deletes or forgets its conversation');

await action('force-stop');
await until((state) => state.active === 0);
await fs.rm(FOLDER, { recursive: true, force: true });

console.log(`\n${checks - failed}/${checks} passed`);
process.exit(failed === 0 ? 0 : 1);
