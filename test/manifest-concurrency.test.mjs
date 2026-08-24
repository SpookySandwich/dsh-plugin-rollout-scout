// Hot-reloaded plugin instances must not overwrite one another's ownership.
//
// An old instance can still be draining a delete while the replacement's
// live run launches another probe. Both modules share the folder but not their
// JS state. This deterministic interleaving holds the old delete between its
// physical and final manifest phases, lets the new instance add an id, then
// verifies the old final mutation re-reads disk and preserves it.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';

const FOLDER = path.join(os.tmpdir(), 'rollout-scout-manifest-concurrency-test');
const moduleUrl = new URL('../lib/index.js', import.meta.url);
const first = await import(`${moduleUrl.href}?instance=old`);
const second = await import(`${moduleUrl.href}?instance=new`);
const originalRename = fs.rename.bind(fs);
let renameFailure = null;
fs.rename = async (...args) => {
  if (renameFailure !== null) {
    const error = renameFailure;
    renameFailure = null;
    throw error;
  }
  return originalRename(...args);
};

let checks = 0;
let failed = 0;
function check(ok, message) {
  checks += 1;
  if (!ok) failed += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${message}`);
}

function harness(apply, label) {
  const listeners = new Map();
  const live = new Map();
  const attached = new Set();
  const routes = [];
  let detachGate = null;
  const workspace = {
    path: FOLDER,
    get sessionIds() { return [...attached]; },
    attachSession: async (id) => { attached.add(id); },
    detachSession: async (id) => {
      if (detachGate?.id === id) {
        detachGate.entered.resolve();
        await detachGate.release.promise;
      }
      attached.delete(id);
    },
  };
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
          status: 'running',
          followup() {},
          cancel() { agent.status = 'idle'; },
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
      list: async () => [...attached].map((id) => ({ id, cwd: FOLDER })),
      locate: ({ id }) => ({ path: path.join(FOLDER, 'logs', id, 'session.jsonl') }),
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
  function event(sessionId, value) {
    listeners.get(sessionId)?.(null, value);
  }
  async function until(predicate, timeoutMs = 8000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const response = await send('GET');
      if (predicate(response.body) || Date.now() >= deadline) return response.body;
      await new Promise((resolve) => setTimeout(resolve, 15));
    }
  }
  return {
    label, send, event, until, attached,
    gateDetach(id) {
      detachGate = { id, entered: Promise.withResolvers(), release: Promise.withResolvers() };
      return detachGate;
    },
  };
}

await fs.rm(FOLDER, { recursive: true, force: true });
const oldHost = harness(first.apply, 'old');
const newHost = harness(second.apply, 'new');

let response = await oldHost.send('POST', JSON.stringify({
  action: 'start', config: { prompt: 'old', folder: FOLDER, concurrency: 1, autoDelete: false },
}));
check(response.status === 200, 'old plugin instance starts a probe');
let oldView = await oldHost.until((state) => state.attempts[0]?.status === 'streaming');
const oldAttempt = oldView.attempts[0];
await fs.mkdir(path.join(FOLDER, 'logs', oldAttempt.sessionId), { recursive: true });
await fs.writeFile(path.join(FOLDER, 'logs', oldAttempt.sessionId, 'session.jsonl'), 'old\n');
await oldHost.send('POST', '{"action":"force-stop"}');
await oldHost.until((state) => state.active === 0);

response = await newHost.send('POST', JSON.stringify({
  action: 'start', config: { prompt: 'new', folder: FOLDER, concurrency: 1, autoDelete: false },
}));
check(response.status === 200, 'replacement plugin instance starts its own run');
let newView = await newHost.until((state) => state.attempts[0]?.status === 'streaming');
const firstNewAttempt = newView.attempts[0];

const detach = oldHost.gateDetach(oldAttempt.sessionId);
const oldClear = oldHost.send('POST', '{"action":"clear"}');
await detach.entered.promise;

// The replacement finishes its first probe while the old delete is paused.
// Its pump launches another probe and persists that new ownership before the
// old instance is allowed to finish its final manifest transaction.
newHost.event(firstNewAttempt.sessionId, { type: 'turn/end' });
newView = await newHost.until((state) =>
  state.attempts.length >= 2 && state.attempts[0]?.status === 'streaming');
const secondNewAttempt = newView.attempts[0];
let manifest = JSON.parse(await fs.readFile(path.join(FOLDER, '.rollout-scout.json'), 'utf8'));
check(manifest.owned.includes(firstNewAttempt.sessionId)
  && manifest.owned.includes(secondNewAttempt.sessionId),
  'replacement ownership is durable before the old mutation resumes');

detach.release.resolve();
response = await oldClear;
check(response.status === 200, 'old instance completes its delayed cleanup');
manifest = JSON.parse(await fs.readFile(path.join(FOLDER, '.rollout-scout.json'), 'utf8'));
check(!manifest.owned.includes(oldAttempt.sessionId)
  && manifest.owned.includes(firstNewAttempt.sessionId)
  && manifest.owned.includes(secondNewAttempt.sessionId),
  'fresh-read manifest transactions remove only the old id and preserve the replacement ids');
check(manifest.version === 3 && !manifest.deleting.includes(oldAttempt.sessionId),
  'the completed cross-instance delete closes its durable transaction');

await newHost.send('POST', '{"action":"force-stop"}');
await newHost.until((state) => state.active === 0);
await newHost.send('POST', '{"action":"delete-all"}');

// A failed Keep exists only in memory, but hot reload is still the same
// process. The shared manifest registry must carry that veto to the replacement
// module so its generic cleanup controls cannot delete the conversation.
response = await oldHost.send('POST', JSON.stringify({
  action: 'start', config: { prompt: 'keep fault', folder: FOLDER, concurrency: 1, autoDelete: true },
}));
oldView = await oldHost.until((state) => state.attempts[0]?.status === 'streaming');
const failedKeep = oldView.attempts[0];
await fs.mkdir(path.join(FOLDER, 'logs', failedKeep.sessionId), { recursive: true });
await fs.writeFile(path.join(FOLDER, 'logs', failedKeep.sessionId, 'session.jsonl'), 'keep me\n');
await oldHost.send('POST', '{"action":"pause"}');
oldHost.event(failedKeep.sessionId, {
  type: 'assistant/chunk', data: { chunk: {
    type: 'reasoning-delta', text: 'The directory is empty. Let me inspect it before changing anything.\n',
  } },
});
oldHost.event(failedKeep.sessionId, { type: 'turn/end' });
await oldHost.until((state) => state.active === 0
  && state.attempts.find((attempt) => attempt.id === failedKeep.id)?.status === 'pending-discard');
renameFailure = new Error('injected hot-reload Keep failure');
response = await oldHost.send('POST', JSON.stringify({ action: 'protect', id: failedKeep.id }));
check(response.status === 409, 'retiring instance records a failed Keep intent');

response = await newHost.send('POST', '{"action":"reap"}');
check(response.status === 200 && response.body.reaped === 0,
  'replacement instance does not advertise or reap the failed Keep as an orphan');
response = await newHost.send('POST', '{"action":"delete-all"}');
check(response.status === 200
  && await fs.readFile(path.join(FOLDER, 'logs', failedKeep.sessionId, 'session.jsonl'), 'utf8') === 'keep me\n',
  'replacement Delete all also observes the shared fail-closed Keep veto');

fs.rename = originalRename;
await fs.rm(FOLDER, { recursive: true, force: true });

console.log(`\n${checks - failed}/${checks} passed`);
process.exit(failed === 0 ? 0 : 1);
