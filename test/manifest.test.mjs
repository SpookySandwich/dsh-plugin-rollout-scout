// Durable ownership is the only authority for cleanup.
//
// This deliberately mixes plugin-owned leftovers with DSH's blank workspace
// placeholder and an ordinary user conversation in the exact same cwd and
// workspace. Only ids present in the legacy v2 manifest may be counted or
// deleted; loading migrates them conservatively into v3 with no deletion
// transaction inferred.
//
//   node test/manifest.test.mjs
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { apply } from '../lib/index.js';

const FOLDER = path.join(os.tmpdir(), 'rollout-scout-manifest-test');
const OWNED_LIVE = 'session-owned-live';
const OWNED_IDLE = 'session-owned-idle';
const PROTECTED = 'session-owned-protected';
const MANUAL = 'session-manual-same-cwd';
const BLANK = 'session-dsh-blank-placeholder';

let checks = 0;
let failed = 0;
function check(ok, message) {
  checks += 1;
  if (!ok) failed += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${message}`);
}

await fs.rm(FOLDER, { recursive: true, force: true });
await fs.mkdir(FOLDER, { recursive: true });
await fs.writeFile(path.join(FOLDER, '.rollout-scout.json'), `${JSON.stringify({
  version: 2,
  owned: [OWNED_LIVE, OWNED_IDLE, PROTECTED],
  protected: [PROTECTED],
}, null, 2)}\n`);

async function writeLog(id) {
  const directory = path.join(FOLDER, 'sessions', id);
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, 'session.jsonl'), `${id}\n`);
}

async function exists(id) {
  return fs.access(path.join(FOLDER, 'sessions', id, 'session.jsonl')).then(() => true, () => false);
}

for (const id of [OWNED_LIVE, OWNED_IDLE, PROTECTED, MANUAL]) await writeLog(id);

const attached = new Set([OWNED_LIVE, OWNED_IDLE, PROTECTED, MANUAL]);
const sessions = new Map([
  [OWNED_LIVE, { id: OWNED_LIVE, header: { id: OWNED_LIVE, cwd: FOLDER } }],
  [OWNED_IDLE, { id: OWNED_IDLE, header: { id: OWNED_IDLE, cwd: FOLDER } }],
  [PROTECTED, { id: PROTECTED, header: { id: PROTECTED, cwd: FOLDER } }],
  [MANUAL, { id: MANUAL, header: { id: MANUAL, cwd: FOLDER } }],
  [BLANK, { id: BLANK, header: { id: BLANK, cwd: FOLDER }, blank: true }],
]);
const agents = new Map();
const cancelled = new Set();
let createFails = false;

function oldAgent(id, status) {
  const agent = {
    status,
    cancel() {
      cancelled.add(id);
      agent.status = 'idle';
    },
    whenIdle: async () => {},
  };
  agents.set(id, agent);
}
oldAgent(OWNED_LIVE, 'running');
oldAgent(OWNED_IDLE, 'idle');
oldAgent(PROTECTED, 'running');

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
  sessions: {
    list: () => [...sessions.values()],
    get: (id) => sessions.get(id),
  },
  agents: {
    get: (id) => agents.get(id),
    create: async ({ sessionId, setup }) => {
      if (createFails) throw new Error('agent creation failed after ownership claim');
      setup({ on() {} });
      const agent = {
        status: 'running',
        followup() {},
        cancel() {
          cancelled.add(sessionId);
          agent.status = 'idle';
        },
        whenIdle: async () => {},
      };
      agents.set(sessionId, agent);
      sessions.set(sessionId, { id: sessionId, header: { id: sessionId, cwd: FOLDER } });
      return {
        agent,
        dispose: async () => { agents.delete(sessionId); },
      };
    },
  },
  sessionPersistence: {
    list: async () => [...sessions.values()].map((session) => session.header),
    locate: ({ id }) => ({ path: path.join(FOLDER, 'sessions', id, 'session.jsonl') }),
  },
});
const route = routes.find((entry) => entry && entry.path === '/rollout-scout');

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

async function until(predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const response = await send('GET');
    if (predicate(response.body) || Date.now() > deadline) return response.body;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

let response = await send('POST', JSON.stringify({
  action: 'start', config: { prompt: 'probe', folder: FOLDER, concurrency: 1 },
}));
check(response.status === 200, 'a run can start with durable leftovers present');
let view = await until((state) => state.attempts[0]?.status === 'streaming'
  && state.orphans.live === 1 && state.orphans.cold === 1);
const current = view.attempts[0];
let manifest = JSON.parse(await fs.readFile(path.join(FOLDER, '.rollout-scout.json'), 'utf8'));
check(manifest.version === 3 && manifest.deleting.length === 0,
  'v2 ownership migrates to v3 without authorizing physical deletion');
check(view.orphans.live === 1 && view.orphans.cold === 1,
  'only the two unprotected owned leftovers appear in the banner');
check(view.orphans.live + view.orphans.cold === 2,
  'loaded same-cwd sessions and the blank placeholder are not adopted');

response = await send('POST', '{"action":"force-stop"}');
check(response.status === 200, 'the current run can be stopped before cleanup');
await until((state) => state.active === 0);

response = await send('POST', '{"action":"reap"}');
check(response.status === 200 && response.body.reaped === 2,
  'cleanup deletes exactly the two manifest-owned leftovers');
check(cancelled.has(OWNED_LIVE) && !cancelled.has(OWNED_IDLE),
  'only an agent whose status is running is cancelled');
check(!cancelled.has(PROTECTED) && !cancelled.has(MANUAL),
  'protected and arbitrary same-cwd conversations are never cancelled');
check(!(await exists(OWNED_LIVE)) && !(await exists(OWNED_IDLE)),
  'owned leftover logs are removed');
check(await exists(PROTECTED) && await exists(MANUAL),
  'protected and manual logs remain intact');
check(attached.has(PROTECTED) && attached.has(MANUAL),
  'their workspace slots also remain intact');
check(response.body.orphans.live === 0 && response.body.orphans.cold === 0,
  'the banner disappears after its owned candidates are gone');

manifest = JSON.parse(await fs.readFile(path.join(FOLDER, '.rollout-scout.json'), 'utf8'));
check(manifest.owned.includes(current.sessionId) && manifest.owned.includes(PROTECTED)
  && !manifest.owned.includes(OWNED_LIVE) && !manifest.owned.includes(OWNED_IDLE),
  'successful cleanup relinquishes only the ids it actually deleted');

response = await send('POST', '{"action":"delete-all"}');
check(response.status === 200, 'delete-all removes the current unprotected probe');
check(await exists(PROTECTED) && await exists(MANUAL) && sessions.has(BLANK),
  'delete-all still ignores protected, manual, and blank-placeholder sessions');
manifest = JSON.parse(await fs.readFile(path.join(FOLDER, '.rollout-scout.json'), 'utf8'));
check(JSON.stringify(manifest.owned) === JSON.stringify([PROTECTED])
  && JSON.stringify(manifest.protected) === JSON.stringify([PROTECTED]),
  'the final manifest retains only the protected owned conversation');

/* ---------------------------- a failed create remains safely recoverable -- */

createFails = true;
response = await send('POST', JSON.stringify({
  action: 'start', config: { prompt: 'probe', folder: FOLDER, concurrency: 1 },
}));
check(response.status === 200, 'a run reports create failures asynchronously');
view = await until((state) => state.paused && state.note === 'launch-failed');
const failedIds = view.attempts.map((attempt) => attempt.sessionId).filter(Boolean);
manifest = JSON.parse(await fs.readFile(path.join(FOLDER, '.rollout-scout.json'), 'utf8'));
check(failedIds.length === 3 && failedIds.every((id) => manifest.owned.includes(id)),
  'ids remain durably owned when agent creation fails after the claim');
response = await send('POST', '{"action":"delete-all"}');
manifest = JSON.parse(await fs.readFile(path.join(FOLDER, '.rollout-scout.json'), 'utf8'));
check(response.status === 200 && failedIds.every((id) => !manifest.owned.includes(id)),
  'delete-all safely retires the failed-create claims');

await fs.rm(FOLDER, { recursive: true, force: true });

console.log(`\n${checks - failed}/${checks} passed`);
process.exit(failed === 0 ? 0 : 1);
