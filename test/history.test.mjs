// Retriable failures are operational state, not disposable history.
//
// Once a delete fails, its exact card must survive ordinary history pressure
// so the user can see the error and retry that transaction. This drives more
// than HISTORY_LIMIT terminal probes through the real lifecycle and verifies
// only ordinary cards are trimmed.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { apply } from '../lib/index.js';

const FOLDER = path.join(os.tmpdir(), 'rollout-scout-history-test');
const LOGS = path.join(FOLDER, 'logs');
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
let locateFails = false;
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
      setup({ on(_name, listener) { listeners.set(sessionId, listener); } });
      const agent = {
        status: 'running', followup() {},
        cancel() { agent.status = 'idle'; },
        whenIdle: async () => {},
      };
      live.set(sessionId, { id: sessionId, header: { id: sessionId, cwd: FOLDER }, agent });
      return { agent, dispose: async () => { live.delete(sessionId); } };
    },
  },
  sessionPersistence: {
    list: async () => [...attached].map((id) => ({ id, cwd: FOLDER })),
    locate: ({ id }) => {
      if (locateFails) throw new Error('injected locate failure');
      return { path: path.join(LOGS, id, 'session.jsonl') };
    },
  },
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

async function until(predicate, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const response = await send('GET');
    if (predicate(response.body) || Date.now() >= deadline) return response.body;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function event(sessionId, value) {
  listeners.get(sessionId)?.(null, value);
}

await fs.rm(FOLDER, { recursive: true, force: true });
let response = await send('POST', JSON.stringify({
  action: 'start', config: { prompt: 'failure', folder: FOLDER, concurrency: 1, autoDelete: false },
}));
let view = await until((state) => state.attempts[0]?.status === 'streaming');
const retryable = view.attempts[0];
await fs.mkdir(path.join(LOGS, retryable.sessionId), { recursive: true });
await fs.writeFile(path.join(LOGS, retryable.sessionId, 'session.jsonl'), 'retry me\n');
await send('POST', '{"action":"force-stop"}');
await until((state) => state.active === 0);
locateFails = true;
response = await send('POST', '{"action":"delete-all"}');
check(response.status === 409, 'the seed deletion fails deterministically');
locateFails = false;
view = (await send('GET')).body;
check(view.attempts.find((attempt) => attempt.id === retryable.id)?.status === 'error',
  'the failed transaction remains visible before history churn');

response = await send('POST', JSON.stringify({
  action: 'start', config: { prompt: 'churn', folder: FOLDER, concurrency: 1, autoDelete: true },
}));
check(response.status === 200, 'a new run may continue alongside the retriable card');

for (let index = 0; index < 126; index += 1) {
  view = await until((state) => state.running && state.attempts[0]?.status === 'streaming');
  const current = view.attempts[0];
  event(current.sessionId, {
    type: 'assistant/chunk',
    data: { chunk: {
      type: 'reasoning-delta',
      text: 'The directory is empty. Let me inspect it before making changes.\n',
    } },
  });
  await until((state) => state.attempts[0]?.status === 'pending-discard');
  await send('POST', '{"action":"pause"}');
  event(current.sessionId, { type: 'turn/end' });
  await until((state) => state.active === 0
    && state.attempts.find((attempt) => attempt.id === current.id)?.deleted === true);
  await send('POST', '{"action":"resume"}');
}

view = await until((state) => state.attempts[0]?.status === 'streaming');
const retainedFailure = view.attempts.find((attempt) => attempt.id === retryable.id);
check(retainedFailure?.status === 'error' && retainedFailure.deleted === false
  && typeof retainedFailure.error === 'string' && retainedFailure.error.length > 0,
  'delete-failed card survives beyond the ordinary history limit with its retry error');
check(view.attempts.length <= 122,
  `successfully deleted history remains bounded (${view.attempts.length} cards)`);

await send('POST', '{"action":"force-stop"}');
await until((state) => state.active === 0);
await fs.rm(FOLDER, { recursive: true, force: true });
console.log(`\n${checks - failed}/${checks} passed`);
process.exit(failed === 0 ? 0 : 1);
