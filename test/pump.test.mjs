// The launch loop's failure behaviour.
//
// A probe that fails before it ever streams frees its concurrency slot at
// once, so the loop launches a replacement that fails the same way. With the
// provider down or the folder unwritable that is an unbounded launch storm:
// this pins the breaker that stops it, and that a resume clears the breaker.
//
//   node test/pump.test.mjs
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { apply } from '../lib/index.js';

const FOLDER = path.join(os.tmpdir(), 'rollout-scout-pump-test');

let checks = 0;
let failed = 0;

function check(ok, message) {
  checks += 1;
  if (!ok) failed += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${message}`);
}

// Every launch fails at workspace creation — the shape of "the harness is
// there but the run cannot get off the ground".
let creates = 0;
const routes = [];
apply({
  effect(fn) { routes.push(fn()); },
  webServer: { register(route) { routes.push(route); return route; } },
  workspaceRegistry: {
    list: () => [],
    resolveByPath: async () => null,
    create: async () => {
      creates += 1;
      throw new Error('workspace unavailable');
    },
  },
  agents: { create: async () => { throw new Error('should not be reached'); } },
  sessionPersistence: { list: async () => [], locate: () => undefined },
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

/** Wait for the loop to stop launching, or give up. */
async function settled(timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const r = await send('GET');
    if (!r.body.running) return r.body;
    if (Date.now() > deadline) return r.body;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

const config = JSON.stringify({
  action: 'start',
  // Concurrency one pins the boundary where the failed launch itself is the
  // only active slot; the refill must happen after `launching` turns false.
  config: { prompt: 'probe', folder: FOLDER, concurrency: 1 },
});

let r = await send('POST', config);
check(r.status === 200, `start accepted (${r.status})`);

let view = await settled();
check(view.running === false, 'the run stopped itself instead of launching forever');
check(view.paused === true && view.note === 'launch-failed',
  `it stopped with note=${view.note} paused=${view.paused}`);
check(typeof view.lastError === 'string' && view.lastError.includes('workspace unavailable'),
  `the failure is reported to the console: ${view.lastError}`);

// The breaker is what bounds this. Without it the loop would keep going for
// the whole timeout above, which is thousands of attempts, not a handful.
check(view.launched <= 8, `launching stopped after ${view.launched} attempts`);
check(view.attempts.every((a) => a.status === 'error'), 'every attempt is recorded as an error');
check(view.active === 0, `no attempt is left counted as live (active=${view.active})`);

// Resume is the user saying "try again": it must re-arm, then trip again.
const before = view.launched;
r = await send('POST', '{"action":"resume"}');
check(r.status === 200, `resume accepted (${r.status})`);

view = await settled();
check(view.launched > before, `resume re-armed the breaker and launched again (${before} -> ${view.launched})`);
check(view.note === 'launch-failed', 'and it tripped a second time rather than spinning');

await fs.rm(FOLDER, { recursive: true, force: true });

console.log(`\n${checks - failed}/${checks} passed`);
process.exit(failed === 0 ? 0 : 1);
