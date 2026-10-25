// Loaded only by scripts/run-dsh-acceptance.mjs in a disposable official host.
import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

assert.ok(process.env.DSH_QA_MODULES);
assert.match(process.env.DSH_HOME ?? '', /rollout-scout-dsh-qa-/);
const require = createRequire(join(process.env.DSH_QA_MODULES, 'package.json'));
const { LlmAdapter } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-llm')));
const calls = [];
const reasoning = "I'll validate this offline probe with a deterministic local reply.";

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
    calls.push({ prompt, reasoningEffort: options.reasoningEffort, source: message.source });
    if (prompt === 'qa-error') throw new Error('Offline QA model failure');
    yield { type: 'reasoning-delta', index: 0, text: reasoning };
    yield { type: 'text-delta', index: 1, text: 'Offline Scout acceptance reply.' };
    yield { type: 'finish', reason: { kind: 'stop' } };
  }
}

export const inject = ['llm', 'sessions', 'agents', 'sessionQuery', 'sessionPersistence', 'webServer'];
export function apply(ctx) {
  ctx.llm.registerAdapter(['qa-local'], new LocalReply());
  ctx.webServer.register({ kind: 'exact', path: '/qa/state', handler: async (_req, res) => {
    try {
      const sessions = [];
      for (const record of await ctx.sessionPersistence.list()) {
        const header = record.header ?? record;
        const observation = await ctx.sessionQuery.observeSession(header.id, { projectionMode: 'none' });
        try {
          const location = ctx.sessionPersistence.locate(header);
          const onDisk = await access(location.path).then(() => true, () => false);
          sessions.push({ header: observation.header, events: observation.events,
            live: !!ctx.sessions.get(header.id), onDisk });
        } finally { observation[Symbol.dispose](); }
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ sessions, calls, reasoning }));
    } catch (error) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: String(error), stack: error.stack }));
    }
  } });
  console.log('Scout QA offline adapter ready.');
}
