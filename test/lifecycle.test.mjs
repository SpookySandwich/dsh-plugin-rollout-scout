// What survives a stop, and what a stop is allowed to reach.
//
// Three things this pins:
//   - pausing cancels the probes already judged as the old model, and leaves
//     the undecided ones streaming;
//   - a kept probe is outside every cohort — force stop, clear and delete-all
//     all run without touching it or its log;
//   - a sweep finds probe conversations by their recorded `cwd`, so a session
//     with a log but no workspace slot (the state that leaves an ungrouped,
//     undeletable sidebar row) is still reachable.
//
//   node test/lifecycle.test.mjs
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { apply } from '../lib/index.js';

const FOLDER = path.join(os.tmpdir(), 'rollout-scout-lifecycle-test');
const LOGS = path.join(FOLDER, 'logs');

let checks = 0;
let failed = 0;

function check(ok, message) {
  checks += 1;
  if (!ok) failed += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${message}`);
}

// One listener per probe, so a test can push reasoning into a chosen probe
// and drive it to a verdict without a provider.
const listeners = new Map();
const cancelled = new Set();
const titles = new Map();
const attached = new Set();
const live = new Map();

const workspace = {
  path: FOLDER,
  get sessionIds() { return [...attached]; },
  attachSession: async (id) => { attached.add(id); },
  detachSession: async (id) => { attached.delete(id); },
};

const routes = [];
apply({
  effect(fn) { routes.push(fn()); },
  get: (service) => (service === 'sessionTitle' ? {
    rename: (session, title) => { titles.set(session.id, title); },
  } : undefined),
  webServer: { register(route) { routes.push(route); return route; } },
  workspaceRegistry: {
    list: () => [workspace],
    resolveByPath: async () => workspace,
    create: async () => workspace,
  },
  sessions: {
    list: () => [...live.values()],
    get: (id) => live.get(id),
  },
  agents: {
    get: (id) => (live.has(id) ? { cancel() { cancelled.add(id); } } : undefined),
    create: async ({ sessionId, setup }) => {
      setup({ on(_event, fn) { listeners.set(sessionId, fn); } });
      live.set(sessionId, { id: sessionId, header: { id: sessionId, cwd: FOLDER } });
      return {
        agent: { followup() {}, cancel() { cancelled.add(sessionId); } },
        dispose: async () => { live.delete(sessionId); },
      };
    },
  },
  sessionPersistence: {
    list: async () => {
      const names = await fs.readdir(LOGS).catch(() => []);
      return names.map((id) => ({ id, cwd: FOLDER }));
    },
    locate: (header) => ({ path: path.join(LOGS, header.id, 'session.jsonl') }),
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
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** Push chain-of-thought into one probe's session listener. */
function think(sessionId, text) {
  const fn = listeners.get(sessionId);
  if (fn) fn(null, { type: 'assistant/chunk', data: { chunk: { type: 'reasoning-delta', text } } });
}

async function writeLog(id) {
  await fs.mkdir(path.join(LOGS, id), { recursive: true });
  await fs.writeFile(path.join(LOGS, id, 'session.jsonl'), 'x\n');
}

const exists = (id) => fs.access(path.join(LOGS, id, 'session.jsonl')).then(() => true, () => false);

await fs.rm(FOLDER, { recursive: true, force: true });

/* ---------------------------------------------- pause cancels settled olds -- */

let r = await send('POST', JSON.stringify({
  action: 'start',
  config: { prompt: 'probe', folder: FOLDER, concurrency: 2 },
}));
check(r.status === 200, `start accepted (${r.status})`);

let view = await until((s) => s.attempts.length >= 2 && s.attempts.every((a) => a.status === 'streaming'));
check(view.active === 2, `two probes streaming (active=${view.active})`);

const ids = view.attempts.map((a) => a.sessionId);
// One reads decisively as the old model; the other says nothing conclusive.
think(ids[0], 'The directory is empty here. Let me start by reading what is already on disk.\n');
think(ids[1], 'Considering the constraints here in a good deal of detail before committing.\n');
for (const id of ids) await writeLog(id);

view = await until((s) => s.attempts.some((a) => a.verdict === 'old'));
check(view.attempts.filter((a) => a.verdict === 'old').length === 1, 'one probe is judged old');

r = await send('POST', '{"action":"pause"}');
check(r.status === 200, `pause accepted (${r.status})`);
check(r.body.culled === 1, `pause cancelled the settled probe (culled=${r.body.culled})`);
check(cancelled.has(ids[0]), 'the old-model probe had its turn cancelled');
check(!cancelled.has(ids[1]), 'the undecided probe was left running');

view = await send('GET');
const undecided = view.body.attempts.find((a) => a.sessionId === ids[1]);
check(undecided && undecided.status === 'streaming', 'and it is still streaming');

/* ------------------------------------------------- a keep survives the lot -- */

const keeper = view.body.attempts.find((a) => a.sessionId === ids[1]);
r = await send('POST', JSON.stringify({ action: 'protect', id: keeper.id }));
check(r.status === 200, `protect accepted (${r.status})`);
check(r.body.attempts.find((a) => a.id === keeper.id).protected, 'the probe reports as kept');

const promises = JSON.parse(await fs.readFile(path.join(FOLDER, '.rollout-scout.json'), 'utf8'));
check(promises.protected.includes(ids[1]), 'the promise is on disk, so it outlives a reload');

cancelled.delete(ids[1]);
r = await send('POST', '{"action":"force-stop"}');
check(r.status === 200, `force-stop accepted (${r.status})`);
check(!cancelled.has(ids[1]), 'force stop did not cancel the kept probe');
check(await exists(ids[1]), 'and its log is intact');

r = await send('POST', '{"action":"clear"}');
check(r.status === 200 && r.body.attempts.some((a) => a.sessionId === ids[1]),
  'clear kept its card');

r = await send('POST', '{"action":"delete-all"}');
check(r.status === 200, `delete-all accepted (${r.status})`);
check(await exists(ids[1]), 'delete-all left the kept log on disk');
check(!(await exists(ids[0])), 'and removed the discarded one');
check(r.body.attempts.length === 1, `only the keep is still listed (${r.body.attempts.length})`);

/* ------------------------------------------ sweeps find sessions by their cwd -- */

// A conversation with a log and no workspace slot: what a half-finished
// delete used to leave behind, and what the sidebar shows as an ungrouped
// row with no Delete in its menu.
await writeLog('session-stray');
r = await send('POST', '{"action":"reap"}');
check(r.status === 200, `reap accepted (${r.status})`);
check(!(await exists('session-stray')), 'the untracked conversation was swept');
check(await exists(ids[1]), 'and the keep still survived that too');

r = await send('POST', JSON.stringify({ action: 'unprotect', id: keeper.id }));
check(r.status === 200 && !r.body.attempts.find((a) => a.id === keeper.id).protected,
  'unprotect hands it back to the ordinary rules');

/* ------------------------------------ keeping a probe already judged old -- */

// Pressing Keep on a fading card leaves the verdict at 'old' — the user is
// overriding the classifier, not agreeing with it. The turn then ends
// normally, and `finish` used to send anything not explicitly PINNED down the
// discard path, so autoDelete unlinked the conversation just kept.
r = await send('POST', '{"action":"delete-all"}');
r = await send('POST', JSON.stringify({
  action: 'start',
  config: { prompt: 'probe', folder: FOLDER, concurrency: 1, autoDelete: true },
}));
check(r.status === 200, `start with autoDelete accepted (${r.status})`);

view = await until((s) => s.attempts.length >= 1 && s.attempts[0].status === 'streaming');
const doomed = view.attempts[0];
await writeLog(doomed.sessionId);
think(doomed.sessionId, 'The directory is empty here. Let me start by reading what is on disk.\n');
view = await until((s) => s.attempts[0].verdict === 'old');
check(view.attempts[0].verdict === 'old', 'the probe is judged old');

r = await send('POST', JSON.stringify({ action: 'protect', id: doomed.id }));
check(r.status === 200, `keep accepted while judged old (${r.status})`);

const turnEnd = listeners.get(doomed.sessionId);
if (turnEnd) turnEnd(null, { type: 'turn/end' });
await until((s) => s.attempts[0].status !== 'streaming', 2000);

view = await send('GET');
const held = view.body.attempts.find((a) => a.id === doomed.id);
check(held && held.protected, 'it is still reported as kept after the turn ended');
check(held && held.status !== 'discarded', `and not marked discarded (${held && held.status})`);
// deleteAttempt runs detached from finish(), so give it room to land before
// asserting the file is still there.
for (let i = 0; i < 20 && await exists(doomed.sessionId); i += 1) {
  await new Promise((resolve) => setTimeout(resolve, 25));
}
check(await exists(doomed.sessionId), 'autoDelete did not unlink the conversation');

/* ---------------------------------------------------------------- naming -- */

check(titles.get(doomed.sessionId) === `Rollout probe ${doomed.id}`,
  `probes are named on launch (${titles.get(doomed.sessionId)})`);

r = await send('POST', JSON.stringify({ action: 'rename', id: doomed.id, title: '  V4 catch  ' }));
check(r.status === 200, `rename accepted (${r.status})`);
check(titles.get(doomed.sessionId) === 'V4 catch', `the harness got the trimmed title (${titles.get(doomed.sessionId)})`);
check(r.body.attempts.find((a) => a.id === doomed.id).title === 'V4 catch', 'and the console shows it');

r = await send('POST', JSON.stringify({ action: 'rename', id: doomed.id, title: '   ' }));
check(r.status === 400, `an empty title is refused (${r.status})`);

/* ------------------------------------------------------------ self-check -- */

// The corpus is the only thing that separates "found nothing" from "could
// never find anything", so a broken classifier has to show up here.
r = await send('POST', JSON.stringify({ action: 'self-check', config: { folder: FOLDER } }));
check(r.status === 200, `self-check accepted (${r.status})`);
check(r.body.total === 13, `the shipped corpus is intact (${r.body.total} samples)`);
check(r.body.agreed === r.body.total,
  `every sample lands on its hand label (${r.body.agreed}/${r.body.total})`);
check(r.body.rolloutKept === r.body.rolloutTotal && r.body.rolloutTotal > 0,
  `known rollout samples are kept (${r.body.rolloutKept}/${r.body.rolloutTotal})`);

// A keep mark the labelled catches cannot reach must be reported, not hidden.
r = await send('POST', JSON.stringify({
  action: 'self-check', config: { folder: FOLDER, keepAbove: 0.95 },
}));
check(r.body.rolloutKept < r.body.rolloutTotal,
  `a stricter keep mark drops known catches (${r.body.rolloutKept}/${r.body.rolloutTotal})`);

/* ------------------------------------------------------------- disposers -- */

// The agent handle's disposer is the exact Cordis effect disposer, and a
// repeat call returns undefined rather than a promise. Chaining .catch()
// straight onto it therefore throws inside the disposal dispatch, which the
// harness reports as "agent/disposed listener threw".
const hostSource = await fs.readFile(new URL('../lib/index.js', import.meta.url), 'utf8');
check(!/\.dispose\(\)\s*\.catch/.test(hostSource),
  'nothing chains directly onto the agent disposer');

await fs.rm(FOLDER, { recursive: true, force: true });

console.log(`\n${checks - failed}/${checks} passed`);
process.exit(failed === 0 ? 0 : 1);
