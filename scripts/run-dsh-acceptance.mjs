// Run with DSH_QA_MODULES pointing at an installed official DSH node_modules.
// All probes, profile state, and ownership records live in a disposable sandbox.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, symlink, writeFile, copyFile, cp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const root = resolve(import.meta.dirname, '..');
assert.ok(process.env.DSH_QA_MODULES, 'Set DSH_QA_MODULES to official DSH node_modules');
const modules = resolve(process.env.DSH_QA_MODULES);
const runtime = JSON.parse(await readFile(join(modules, '@deepseek-ai/dsh/package.json'), 'utf8'));
const sandbox = await mkdtemp(join(tmpdir(), 'rollout-scout-dsh-qa-'));
const home = join(sandbox, 'dsh');
const profile = join(home, 'profiles', 'web');
const folder = join(sandbox, 'probes');
const config = { folder, prompt: 'qa-keep', provider: 'qa-local', model: 'qa-model',
  reasoningEffort: 'max', concurrency: 1, autoPauseOnMatch: true, autoDelete: true };
let server, origin, output = '';
const redact = text => text.replace(/([?&]token=)[^\s]+/g, '$1[redacted]');
async function stop() {
  const child = server;
  server = undefined;
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  child.kill();
  await exited;
}
async function request(path, body) {
  const response = await fetch(origin + path, { signal: AbortSignal.timeout(15000),
    ...(body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}) });
  const value = await response.json();
  assert.equal(response.status, 200, JSON.stringify(value));
  return value;
}
const scout = body => request('/rollout-scout', body);
async function settled(predicate) {
  const deadline = Date.now() + 20000;
  let state;
  do {
    state = await scout();
    assert.deepEqual(state.invariantErrors, []);
    if (!state.running && state.active === 0 && state.blocking === 0 && predicate(state)) return state;
    await delay(50);
  } while (Date.now() < deadline);
  throw new Error(`Scout did not settle: ${JSON.stringify(state)}`);
}
async function keepProbe() {
  await scout({ action: 'start', config });
  const state = await settled(state => state.protectedCount > 0);
  assert.equal(state.note, 'hit');
  assert.equal(state.launched, 1);
  const attempt = state.attempts[0];
  assert.equal(attempt.verdict, 'rollout');
  assert.equal(attempt.protected, true);
  const qa = await request('/qa/state');
  assert.equal(attempt.chars, qa.reasoning.length, 'Live reasoning must not be missed or duplicated');
  assert.equal(qa.calls.at(-1).reasoningEffort, 'max');
  assert.equal(qa.calls.at(-1).source.kind, 'dsh-plugin-rollout-scout');
  const session = qa.sessions.find(session => session.header.id === attempt.sessionId);
  assert.ok(session?.onDisk, 'Real JSONL persistence must contain the retained probe');
  assert.equal(session.live, false, 'Completed Scout agents release their live sessions');
  assert.ok(session.events.some(event => event.type === 'assistant/message'));
  return attempt;
}
try {
  const installed = join(profile, 'node_modules', 'dsh-plugin-rollout-scout');
  await mkdir(installed, { recursive: true });
  await mkdir(join(sandbox, 'user'), { recursive: true });
  await symlink(join(modules, '@deepseek-ai'), join(profile, 'node_modules', '@deepseek-ai'), 'junction');
  // Copy the plugin so its dynamic imports resolve the selected runtime, never
  // the previous runtime in the worktree's development node_modules.
  for (const file of ['package.json', 'cordis.patch.yml', 'plugin.client.js', '_wrap-client.mjs']) {
    await copyFile(join(root, file), join(installed, file));
  }
  await cp(join(root, 'lib'), join(installed, 'lib'), { recursive: true });
  await writeFile(join(profile, 'package.json'), JSON.stringify({ name: 'rollout-scout-qa', private: true,
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-plugin-rollout-scout'] } } }));
  await copyFile(join(root, 'test/fixtures/dsh-acceptance.mjs'), join(profile, 'fixture.mjs'));
  await writeFile(join(profile, 'cordis.patch.yml'), '- insert:\n    - id: offline-qa\n      name: ./fixture.mjs\n');
  let retainedId;
  for (const phase of ['fresh', 'restart']) {
    output = '';
    origin = undefined;
    server = spawn(process.execPath, ['--expose-internals', join(modules, '@deepseek-ai/dsh/lib/bin.js'),
      '--profile', 'web', '--no-open', '--port', '0'], {
      env: { ...process.env, DSH_HOME: home, DSH_QA_MODULES: modules,
        USERPROFILE: join(sandbox, 'user'), HOME: join(sandbox, 'user') },
      stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    });
    server.stdout.on('data', chunk => { output += chunk; });
    server.stderr.on('data', chunk => { output += chunk; });
    const deadline = Date.now() + 180000;
    while (!origin) {
      origin = output.match(/dsh web: (http:\/\/127\.0\.0\.1:\d+)/)?.[1];
      if (origin && output.includes('Scout QA offline adapter ready.')) break;
      origin = undefined;
      if (server.exitCode !== null || Date.now() > deadline) throw new Error(`DSH ${phase} startup failed`);
      await delay(100);
    }
    console.log(`Official DSH ${runtime.version}: ${phase}`);
    if (phase === 'fresh') {
      const attempt = await keepProbe();
      await scout({ action: 'rename', id: attempt.id, title: 'QA retained catch' });
      let qa = await request('/qa/state');
      assert.ok(JSON.stringify(qa.sessions.find(session => session.header.id === attempt.sessionId).events)
        .includes('QA retained catch'), 'Cold rename must persist');
      await scout({ action: 'clear' });
      await scout({ action: 'delete-all' });
      qa = await request('/qa/state');
      assert.ok(qa.sessions.some(session => session.header.id === attempt.sessionId && session.onDisk),
        'Protected probes survive both cleanup actions');
      await scout({ action: 'unprotect', id: attempt.id });
      await scout({ action: 'clear' });
      qa = await request('/qa/state');
      assert.ok(!qa.sessions.some(session => session.header.id === attempt.sessionId), 'Explicit cleanup removes the log');
      retainedId = (await keepProbe()).sessionId;
      console.log('PASS: streaming, max effort, auto-pause, cold rename, protected cleanup, explicit deletion');
    } else {
      let qa = await request('/qa/state');
      assert.ok(qa.sessions.some(session => session.header.id === retainedId && session.onDisk));
      await scout({ action: 'start', config: { ...config, prompt: 'qa-error' } });
      const state = await settled(state => state.note === 'launch-failed');
      assert.equal(state.paused, true);
      assert.equal(state.launched, 3);
      assert.equal(state.protectedCount, 1, 'Keep survives a host restart and manifest reload');
      assert.equal(state.attempts.length, 3);
      assert.ok(state.attempts.every(attempt => attempt.status === 'error' && attempt.verdict === 'unknown' && !attempt.deleted));
      assert.match(state.lastError, /Offline QA model failure/);
      qa = await request('/qa/state');
      assert.equal(qa.calls.length, 3);
      for (const attempt of state.attempts) {
        assert.ok(qa.sessions.some(session => session.header.id === attempt.sessionId && session.onDisk),
          'Model failures must not enter automatic deletion');
      }
      await scout({ action: 'delete-all' });
      await scout({ action: 'reap' });
      qa = await request('/qa/state');
      assert.ok(qa.sessions.some(session => session.header.id === retainedId && session.onDisk),
        'Restart orphan cleanup must preserve durable Keep');
      for (const attempt of state.attempts) {
        assert.ok(!qa.sessions.some(session => session.header.id === attempt.sessionId));
      }
      console.log('PASS: restart retention, three-failure breaker, failed-probe preservation, orphan cleanup');
    }
    if (process.env.DSH_QA_LOG_DIR) {
      await writeFile(join(process.env.DSH_QA_LOG_DIR, `host-${runtime.version}-${phase}.log`), redact(output));
    }
    await stop();
  }
} catch (error) {
  console.error(redact(output));
  throw error;
} finally {
  await stop();
  await rm(sandbox, { recursive: true, force: true });
}
