import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { apply } from '../lib/index.js';

test('DSH 0.1.5 transient chunks classify and pause without double-counting the legacy feed', async t => {
  const folder = await mkdtemp(join(tmpdir(), 'scout-stream-events-'));
  const workspace = { id: 'qa', path: folder, sessionIds: [], attachSession: async () => {} };
  let route, launches = 0;
  const disposers = [];
  const text = "I'll check this local fixture and preserve the detected conversation.";
  const ctx = {
    get: () => undefined,
    effect(fn) { const dispose = fn(); if (typeof dispose === 'function') disposers.push(dispose); },
    webServer: { register(value) { route = value; return () => {}; } },
    workspaceRegistry: { list: () => [workspace], resolveByPath: async () => workspace },
    sessionPersistence: { list: async () => [] },
    agents: { async create(options) {
      launches++;
      const listeners = new Map();
      options.setup({ on(name, fn) { listeners.set(name, fn); return () => {}; } });
      return { dispose: async () => {}, agent: {
        session: { id: options.sessionId }, cancel() {}, whenIdle: async () => {},
        followup() { queueMicrotask(() => {
          const stream = listeners.get('agent/assistant-stream');
          assert.equal(typeof stream, 'function', 'Listen to live Agent frames before sending the probe');
          stream({ frame: { type: 'start' } });
          const chunk = { type: 'reasoning-delta', text };
          stream({ frame: { type: 'chunk', chunk } });
          listeners.get('session/event')(null, { type: 'assistant/chunk', data: { chunk } });
          stream({ frame: { type: 'end' } });
          listeners.get('session/event')(null, { type: 'turn/end', data: { reason: { kind: 'completed' } } });
        }); },
      } };
    } },
  };
  apply(ctx);
  async function send(body) {
    const req = Readable.from(body ? [JSON.stringify(body)] : []);
    req.method = body ? 'POST' : 'GET';
    req.headers = { host: 'localhost', 'content-type': 'application/json' };
    let status, result;
    await route.handler(req, { writeHead(code) { status = code; }, end(value) { result = JSON.parse(value); } });
    assert.equal(status, 200, JSON.stringify(result));
    return result;
  }
  t.after(async () => {
    await send({ action: 'force-stop' });
    for (const dispose of disposers.reverse()) await dispose();
    await rm(folder, { recursive: true, force: true });
  });
  await send({ action: 'start', config: { folder, prompt: 'probe', concurrency: 1, autoPauseOnMatch: true } });
  const deadline = Date.now() + 5000;
  let state;
  do {
    await new Promise(resolve => setTimeout(resolve, 10));
    state = await send();
  } while ((state.running || state.active > 0 || state.protectedCount === 0) && Date.now() < deadline);
  assert.equal(state.paused, true);
  assert.equal(launches, 1);
  assert.equal(state.attempts[0].verdict, 'rollout');
  assert.equal(state.attempts[0].chars, text.length);
  assert.equal(state.attempts[0].protected, true);
});
