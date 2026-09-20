import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { apply } from '../lib/index.js';

test('terminal DSH model errors pause retries and never classify failed probes for deletion', async t => {
  const folder = await mkdtemp(join(tmpdir(), 'scout-request-errors-'));
  const workspace = { id: 'qa', path: folder, sessionIds: [], attachSession: async () => {} };
  let route;
  let launches = 0;
  let deletes = 0;
  let receivedOptions;
  const disposers = [];
  const ctx = {
    get: () => undefined,
    effect(fn) { const dispose = fn(); if (typeof dispose === 'function') disposers.push(dispose); },
    webServer: { register(value) { route = value; return () => {}; } },
    workspaceRegistry: { list: () => [workspace], resolveByPath: async () => workspace },
    sessionPersistence: { list: async () => [], locate() { deletes++; return { path: join(folder, 'never-delete.jsonl') }; } },
    agents: { async create(options) {
      launches++;
      receivedOptions = options.agentOptions;
      let onEvent;
      options.setup({ on(name, fn) { if (name === 'session/event') onEvent = fn; return () => {}; } });
      return {
        dispose: async () => {},
        agent: {
          session: { id: options.sessionId },
          followup() { queueMicrotask(() => onEvent(null, { type: 'turn/end', data: {
            reason: { kind: 'error', error: { message: 'Unsupported reasoning effort', code: 'UNSUPPORTED_REASONING_EFFORT' } },
          } })); },
          cancel() {}, whenIdle: async () => {},
        },
      };
    } },
  };
  apply(ctx);
  async function send(body) {
    const req = Readable.from(body ? [Buffer.from(JSON.stringify(body))] : []);
    req.method = body ? 'POST' : 'GET';
    req.headers = { host: 'localhost', 'content-type': 'application/json' };
    let result;
    await route.handler(req, { writeHead() {}, end(value) { result = JSON.parse(value); } });
    return result;
  }
  t.after(async () => {
    await send({ action: 'force-stop' });
    for (const dispose of disposers.reverse()) await dispose();
    await rm(folder, { recursive: true, force: true });
  });
  await send({ action: 'start', config: { folder, prompt: 'probe', concurrency: 1, autoDelete: true, reasoningEffort: 'max' } });
  let state;
  const deadline = Date.now() + 4000;
  do {
    await new Promise(resolve => setTimeout(resolve, 20));
    state = await send();
  } while (state.running && Date.now() < deadline);
  assert.equal(state.running, false);
  assert.equal(state.paused, true);
  assert.equal(state.note, 'launch-failed');
  assert.equal(launches, 3, 'A completed create/followup must not reset the failure counter');
  assert.equal(receivedOptions.reasoningEffort, 'max');
  assert.match(state.lastError, /reasoning effort/);
  assert.ok(state.attempts.every(a => a.status === 'error' && a.verdict === 'unknown'));
  assert.equal(deletes, 0, 'Failed probes must not enter automatic log deletion');
});
