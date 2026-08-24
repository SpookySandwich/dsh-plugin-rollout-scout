import fs from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { apply } from '../../lib/index.js';

const [mode, folder, marker] = process.argv.slice(2);
const listeners = new Map();
const attached = new Set();
let detachGate = null;
const workspace = {
  path: folder,
  get sessionIds() { return [...attached]; },
  attachSession: async (id) => { attached.add(id); },
  detachSession: async (id) => {
    if (detachGate?.id === id) {
      await fs.writeFile(`${marker}.entered`, id);
      while (!(await fs.access(`${marker}.release`).then(() => true, () => false))) {
        await new Promise((resolve) => setTimeout(resolve, 15));
      }
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
  sessions: { list: () => [], get: () => undefined },
  agents: {
    get: () => undefined,
    create: async ({ sessionId, setup }) => {
      setup({ on(_name, listener) { listeners.set(sessionId, listener); } });
      const agent = {
        status: 'running', followup() {},
        cancel() { agent.status = 'idle'; }, whenIdle: async () => {},
      };
      return { agent, dispose: async () => { agent.status = 'idle'; } };
    },
  },
  sessionPersistence: {
    list: async () => [...attached].map((id) => ({ id, cwd: folder })),
    locate: ({ id }) => ({ path: path.join(folder, 'logs', id, 'session.jsonl') }),
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
    if (predicate(response.body)) return response.body;
    if (Date.now() >= deadline) throw new Error('child timed out');
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
}

if (mode === 'create') {
  await send('POST', JSON.stringify({
    action: 'start', config: { prompt: 'child', folder, concurrency: 1, autoDelete: false },
  }));
  const view = await until((state) => state.attempts[0]?.status === 'streaming');
  await fs.writeFile(marker, view.attempts[0].sessionId);
  await send('POST', '{"action":"force-stop"}');
  await until((state) => state.active === 0);
  process.exit(0);
}

if (mode === 'delete') {
  const target = await fs.readFile(marker, 'utf8');
  attached.add(target);
  detachGate = { id: target };
  await send('POST', JSON.stringify({
    action: 'start', config: { prompt: 'load', folder, concurrency: 1, autoDelete: false },
  }));
  await until((state) => state.attempts[0]?.status === 'streaming');
  await send('POST', '{"action":"force-stop"}');
  await until((state) => state.active === 0);
  const response = await send('POST', '{"action":"reap"}');
  if (response.status !== 200) throw new Error(response.body?.error || 'delete failed');
  process.exit(0);
}

throw new Error(`unknown child mode: ${mode}`);
