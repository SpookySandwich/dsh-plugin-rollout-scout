// Loaded only by scripts/run-dsh-acceptance.mjs in a disposable official host.
import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

assert.ok(process.env.DSH_QA_MODULES);
assert.match(process.env.DSH_HOME ?? '', /rollout-scout-dsh-qa-/);
const require = createRequire(join(process.env.DSH_QA_MODULES, 'package.json'));
const { LlmAdapter } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-llm')));
const { installModelSelection } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-agent')));
const calls = [];
const cancelled = [];
const reasoning = "I'll validate this offline probe with a deterministic local reply.";
const signature = '<signature>Let me keep this opaque metadata out of classification.</signature>\r\n\n';

class LocalReply extends LlmAdapter {
  async resolveModel(provider, model) {
    return { provider, id: model, name: 'Offline acceptance model', inputModalities: ['text'],
      reasoning: { efforts: [{ id: 'high', name: 'High' }, { id: 'max', name: 'Max' }] } };
  }
  async listModels(provider) { return [await this.resolveModel(provider, 'qa-model')]; }
  async *stream(options) {
    const message = options.messages.findLast(message => message.source.kind === 'dsh-plugin-rollout-scout');
    assert.ok(message, 'Only Scout probes may use the offline adapter');
    const prompt = message.content.find(block => block.type === 'text')?.text;
    assert.equal(options.provider, 'qa-local');
    assert.equal(options.model, 'qa-model');
    calls.push({ prompt, reasoningEffort: options.reasoningEffort, source: message.source });
    if (prompt === 'qa-error') throw new Error('Offline QA model failure');
    if (prompt === 'qa-old') {
      yield { type: 'reasoning-delta', index: 0, text: 'Let me inspect this deterministic old-model probe before continuing.' };
      try {
        await delay(30000, undefined, { signal: options.signal });
        throw new Error('Old probe was not cancelled');
      } finally {
        if (options.signal?.aborted) cancelled.push(prompt);
      }
    }
    if (prompt === 'qa-signed') {
      for (const text of signature) yield { type: 'reasoning-delta', index: 0, text };
    }
    yield { type: 'reasoning-delta', index: 0, text: reasoning };
    yield { type: 'text-delta', index: 1, text: 'Offline Scout acceptance reply.' };
    yield { type: 'finish', reason: { kind: 'stop' } };
  }
}

export const inject = ['llm', 'sessions', 'agents', 'sessionQuery', 'sessionPersistence', 'workspaceRegistry', 'webServer'];
export function apply(ctx) {
  ctx.llm.registerAdapter(['qa-local'], new LocalReply());
  // Deterministic reproduction of the non-transactional list/observe boundary.
  // Separate from /qa/state: ordinary acceptance still propagates every error.
  let listedForRace;
  ctx.webServer.register({ kind: 'exact', path: '/qa/list-race', handler: async (req, res) => {
    if (req.method === 'POST') {
      listedForRace = await ctx.sessionPersistence.list();
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ids: listedForRace.map(record => (record.header ?? record).id) }));
      return;
    }
    assert.ok(listedForRace);
    const failures = [];
    for (const record of listedForRace) {
      const id = (record.header ?? record).id;
      try {
        const observation = await ctx.sessionQuery.observeSession(id, { projectionMode: 'none' });
        observation[Symbol.dispose]();
      } catch (error) { failures.push({ id, name: error.name, message: error.message }); }
    }
    listedForRace = undefined;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ failures }));
  } });
  ctx.webServer.register({ kind: 'exact', path: '/qa/unowned', handler: async (req, res) => {
    assert.equal(req.method, 'POST');
    const selection = { provider: 'qa-local', model: 'qa-model', reasoningEffort: 'max' };
    const handle = await ctx.agents.create({ sessionId: `session-${crypto.randomUUID()}`,
      meta: { cwd: process.env.DSH_QA_FOLDER }, agentOptions: selection,
      setup(agentCtx) { installModelSelection(agentCtx, { current: selection, assembled: undefined }); } });
    try {
      handle.agent.followup({ id: crypto.randomUUID(), role: 'user',
        content: [{ type: 'text', text: 'qa-unowned' }], source: { kind: 'dsh-plugin-rollout-scout' } });
      await handle.agent.whenIdle();
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ sessionId: handle.agent.session.id }));
    } finally { await handle.dispose(); }
  } });
  ctx.webServer.register({ kind: 'exact', path: '/qa/state', handler: async (_req, res) => {
    try {
      const sessions = [];
      for (const record of await ctx.sessionPersistence.list()) {
        const header = record.header ?? record;
        const observation = await ctx.sessionQuery.observeSession(header.id, { projectionMode: 'none' });
        try {
          const location = ctx.sessionPersistence.locate?.(header);
          const onDisk = location && await access(location.path).then(() => true, () => false);
          sessions.push({ header: observation.header, events: observation.events,
            attached: ctx.workspaceRegistry.list().some(workspace => workspace.sessionIds.includes(header.id)),
            live: !!ctx.sessions.get(header.id), onDisk });
        } finally { observation[Symbol.dispose](); }
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ sessions, calls, cancelled, reasoning, signature }));
    } catch (error) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: String(error), stack: error.stack }));
    }
  } });
  console.log('Scout QA offline adapter ready.');
}
