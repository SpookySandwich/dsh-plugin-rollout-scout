// dsh-plugin-rollout-scout — host half.
//
// Fishes for a limited-rollout conversation model by starting short probe
// conversations and reading their chain-of-thought live off the session/event
// firehose. Reasoning that leans on "Let me" marks the old model and the probe
// is cancelled immediately; enough "I'm" / "I need" / "For" marks a likely
// rollout catch, which is allowed to finish its turn and is kept for the user.
// The /rollout-scout route drives it: GET returns live state for the panel,
// POST starts/stops the run or clears history.

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const ROLLOUT_SCOUT_PATH = '/rollout-scout';

const name = 'rollout-scout';
const inject = [
  'agents',
  'sessions',
  'sessionPersistence',
  'workspaceRegistry',
  'webServer',
];

/* -------------------------------------------------------------- classifier -- */

// Old-model tell: chain-of-thought that keeps saying "Let me …".
const OLD_SIGNAL = /\blet me\b/gi;
// Rollout tells: sentence-leading "For" plus first-person "I'm" / "I need".
const NEW_SIGNALS = [/\bI'm\b/g, /\bI need\b/gi, /\bFor\b/g];

function classify(text) {
  const letMe = (text.match(OLD_SIGNAL) ?? []).length;
  let signals = 0;
  for (const pattern of NEW_SIGNALS) signals += (text.match(pattern) ?? []).length;
  return { letMe, signals };
}

/* ------------------------------------------------------------------ config -- */

const DEFAULT_CONFIG = Object.freeze({
  prompt: 'Which is larger, 9.11 or 9.9? Think it through carefully, then answer in one line.',
  concurrency: 2,
  provider: 'deepseek-official',
  model: 'deepseek-v4-pro',
  reasoningEffort: 'high',
  folder: path.join(os.homedir(), 'rollout-scout'),
  // Cancel a probe the moment its reasoning says "Let me" this many times.
  letMeThreshold: 2,
  // Call it a rollout catch once this many new-model signals accumulate.
  confidenceThreshold: 4,
  // Stop launching new probes after the first confident catch.
  stopAfterHit: true,
  // Delete probes judged as the old model (session log removed from disk).
  autoDelete: false,
  // Hard cap on probes per run, so a forgotten run cannot burn quota forever.
  maxAttempts: 25,
});

function sanitizeConfig(raw) {
  const source = typeof raw === 'object' && raw !== null ? raw : {};
  const config = { ...DEFAULT_CONFIG };
  if (typeof source.prompt === 'string' && source.prompt.trim() !== '') config.prompt = source.prompt;
  if (Number.isInteger(source.concurrency)) config.concurrency = Math.min(6, Math.max(1, source.concurrency));
  if (typeof source.provider === 'string' && source.provider !== '') config.provider = source.provider;
  if (typeof source.model === 'string' && source.model !== '') config.model = source.model;
  if (['default', 'off', 'high', 'max'].includes(source.reasoningEffort)) config.reasoningEffort = source.reasoningEffort;
  if (typeof source.folder === 'string' && source.folder.trim() !== '') config.folder = source.folder.trim();
  if (Number.isInteger(source.letMeThreshold)) config.letMeThreshold = Math.min(20, Math.max(1, source.letMeThreshold));
  if (Number.isInteger(source.confidenceThreshold)) config.confidenceThreshold = Math.min(50, Math.max(1, source.confidenceThreshold));
  if (typeof source.stopAfterHit === 'boolean') config.stopAfterHit = source.stopAfterHit;
  if (typeof source.autoDelete === 'boolean') config.autoDelete = source.autoDelete;
  if (Number.isInteger(source.maxAttempts)) config.maxAttempts = Math.min(200, Math.max(1, source.maxAttempts));
  if (!path.isAbsolute(config.folder)) throw new TypeError('folder 必须是绝对路径 / folder must be an absolute path');
  return config;
}

/* ------------------------------------------------------------------- state -- */

const HISTORY_LIMIT = 120;
const WATCHDOG_MS = 240_000;

const state = {
  running: false,
  config: { ...DEFAULT_CONFIG },
  attempts: [],
  launched: 0,
  note: null,
};

function publicAttempt(attempt) {
  return {
    id: attempt.id,
    sessionId: attempt.sessionId,
    status: attempt.status,
    verdict: attempt.verdict,
    letMe: attempt.letMe,
    signals: attempt.signals,
    chars: attempt.reasoning.length,
    startedAt: attempt.startedAt,
    endedAt: attempt.endedAt,
    deleted: attempt.deleted,
    error: attempt.error,
    preview: attempt.reasoning.slice(0, 160),
  };
}

function publicState() {
  return {
    running: state.running,
    config: state.config,
    launched: state.launched,
    note: state.note,
    active: state.attempts.filter((a) => a.status === 'starting' || a.status === 'streaming' || a.status === 'kept-streaming').length,
    attempts: state.attempts.map(publicAttempt),
  };
}

/* ---------------------------------------------------------------- attempts -- */

function userMessage(text) {
  return Object.freeze({
    id: crypto.randomUUID(),
    role: 'user',
    content: Object.freeze([Object.freeze({ type: 'text', text })]),
    source: Object.freeze({ kind: 'user' }),
  });
}

function activeCount() {
  let n = 0;
  for (const a of state.attempts) {
    if (a.status === 'starting' || a.status === 'streaming' || a.status === 'kept-streaming') n += 1;
  }
  return n;
}

function anyCatch() {
  return state.attempts.some((a) => a.verdict === 'rollout');
}

/** Launch probes while running, under the concurrency and attempt caps. */
function pump(ctx) {
  if (!state.running) return;
  if (state.launched >= state.config.maxAttempts) {
    state.running = false;
    state.note = 'max-attempts';
    return;
  }
  while (state.running && activeCount() < state.config.concurrency && state.launched < state.config.maxAttempts) {
    state.launched += 1;
    const attempt = {
      id: state.launched,
      sessionId: null,
      status: 'starting',
      verdict: null,
      letMe: 0,
      signals: 0,
      reasoning: '',
      startedAt: Date.now(),
      endedAt: null,
      deleted: false,
      error: null,
      handle: null,
      decided: false,
      closed: false,
      watchdog: null,
    };
    state.attempts.unshift(attempt);
    if (state.attempts.length > HISTORY_LIMIT) state.attempts.length = HISTORY_LIMIT;
    launch(ctx, attempt).catch((error) => {
      attempt.status = 'error';
      attempt.error = error instanceof Error ? error.message : String(error);
      attempt.endedAt = Date.now();
      settle(ctx, attempt);
    });
  }
}

async function launch(ctx, attempt) {
  const config = state.config;
  await fs.mkdir(config.folder, { recursive: true });
  const workspace = (await ctx.workspaceRegistry.resolveByPath(config.folder))
    ?? (await ctx.workspaceRegistry.create(config.folder, 'Rollout Scout'));

  const selection = {
    provider: config.provider,
    model: config.model,
    ...(config.reasoningEffort !== 'default' ? { reasoningEffort: config.reasoningEffort } : {}),
  };
  let installModelSelection = null;
  try { ({ installModelSelection } = await import('@deepseek-ai/dsh-agent')); } catch (e) {}

  const sessionId = `session-${crypto.randomUUID()}`;
  const handle = await ctx.agents.create({
    sessionId,
    meta: { cwd: workspace.path },
    agentOptions: { provider: selection.provider, model: selection.model },
    setup: (agentCtx) => {
      if (installModelSelection) {
        installModelSelection(agentCtx, { current: selection, assembled: undefined });
      }
      // Scoped: only this agent's events reach this listener.
      agentCtx.on('session/event', (session, event) => onSessionEvent(ctx, attempt, event));
    },
  });
  attempt.sessionId = sessionId;
  attempt.handle = handle;
  try { await workspace.attachSession(sessionId); } catch (e) {}

  attempt.status = 'streaming';
  attempt.watchdog = setTimeout(() => {
    if (!attempt.closed) {
      attempt.error = 'watchdog timeout';
      try { handle.agent.cancel({ kind: 'user' }, { keepInbox: false }); } catch (e) {}
    }
  }, WATCHDOG_MS);
  handle.agent.followup(userMessage(config.prompt));
}

function onSessionEvent(ctx, attempt, event) {
  if (attempt.closed) return;
  if (event.type === 'assistant/chunk') {
    const chunk = event.data.chunk;
    if (chunk.type === 'reasoning-delta') {
      attempt.reasoning += chunk.text;
      evaluate(ctx, attempt);
    }
    return;
  }
  if (event.type === 'turn/end') {
    finish(ctx, attempt);
  }
}

/** Live verdict: kill fast on "Let me", keep on enough rollout signals. */
function evaluate(ctx, attempt) {
  const { letMe, signals } = classify(attempt.reasoning);
  attempt.letMe = letMe;
  attempt.signals = signals;
  if (attempt.decided) return;
  const config = state.config;
  if (letMe >= config.letMeThreshold) {
    attempt.decided = true;
    attempt.verdict = 'old';
    attempt.status = 'discarding';
    try { attempt.handle.agent.cancel({ kind: 'user' }, { keepInbox: false }); } catch (e) {}
    return;
  }
  if (signals >= config.confidenceThreshold) {
    attempt.decided = true;
    attempt.verdict = 'rollout';
    attempt.status = 'kept-streaming';
    if (config.stopAfterHit) {
      state.running = false;
      state.note = 'hit';
    }
  }
}

function finish(ctx, attempt) {
  if (attempt.closed) return;
  attempt.closed = true;
  attempt.endedAt = Date.now();
  if (attempt.watchdog) { clearTimeout(attempt.watchdog); attempt.watchdog = null; }
  if (!attempt.decided) {
    // Turn ended before either threshold: judge what we saw.
    attempt.verdict = attempt.letMe >= 1 ? 'old' : (attempt.signals >= 2 ? 'rollout' : 'unknown');
  }
  if (attempt.verdict === 'rollout') {
    attempt.status = 'kept';
    if (state.config.stopAfterHit) {
      state.running = false;
      state.note = 'hit';
    }
  } else if (attempt.verdict === 'old') {
    attempt.status = 'discarded';
    if (state.config.autoDelete) {
      deleteAttempt(ctx, attempt).catch((error) => {
        attempt.error = error instanceof Error ? error.message : String(error);
      });
    }
  } else {
    attempt.status = attempt.error ? 'error' : 'finished';
  }
  settle(ctx, attempt);
}

function settle(ctx, attempt) {
  attempt.handleSettled = true;
  pump(ctx);
}

/** Remove a discarded probe entirely: live agent, workspace slot, on-disk log. */
async function deleteAttempt(ctx, attempt) {
  const sessionId = attempt.sessionId;
  if (sessionId === null) return;
  const workspace = ctx.workspaceRegistry.list().find((w) => w.sessionIds.includes(sessionId));
  try { await workspace?.detachSession(sessionId); } catch (e) {}
  try { await attempt.handle?.dispose(); } catch (e) {}
  attempt.handle = null;
  const header = (await ctx.sessionPersistence.list()).find((h) => h.id === sessionId);
  if (header !== undefined) {
    const location = ctx.sessionPersistence.locate(header);
    if (location !== undefined && typeof location.path === 'string') {
      await fs.rm(path.dirname(location.path), { recursive: true, force: true });
    }
  }
  attempt.deleted = true;
}

/* -------------------------------------------------------------- operations -- */

function start(ctx, rawConfig) {
  if (state.running) throw new Error('已在运行 / already running');
  state.config = sanitizeConfig(rawConfig);
  state.running = true;
  state.launched = 0;
  state.note = null;
  pump(ctx);
  return publicState();
}

function stop() {
  // Existing probes keep going to their own verdicts; we just stop launching.
  state.running = false;
  state.note = 'stopped';
  return publicState();
}

function clearHistory() {
  if (state.running) throw new Error('运行中不能清空 / cannot clear while running');
  state.attempts = state.attempts.filter(
    (a) => a.status === 'starting' || a.status === 'streaming' || a.status === 'kept-streaming');
  return publicState();
}

/* -------------------------------------------------------------------- http -- */

function requestJson(request) {
  return new Promise((resolve, reject) => {
    const decoder = new TextDecoder();
    let text = '';
    request.on('data', (chunk) => {
      text += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
    });
    request.on('end', () => {
      try {
        text += decoder.decode();
        resolve(text === '' ? {} : JSON.parse(text));
      } catch (error) {
        reject(error);
      }
    });
    request.on('error', reject);
  });
}

function respondJson(response, status, value) {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  response.end(JSON.stringify(value));
}

async function handleRoute(ctx, request, response) {
  try {
    if (request.method === 'GET') {
      respondJson(response, 200, publicState());
      return;
    }
    if (request.method === 'POST') {
      const body = await requestJson(request);
      switch (body.action) {
        case 'start':
          respondJson(response, 200, start(ctx, body.config));
          return;
        case 'stop':
          respondJson(response, 200, stop());
          return;
        case 'clear':
          respondJson(response, 200, clearHistory());
          return;
        default:
          throw new TypeError('action 必须是 start / stop / clear');
      }
    }
    response.writeHead(405);
    response.end();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    respondJson(response, error instanceof TypeError ? 400 : 409, { error: message });
  }
}

function apply(ctx) {
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: ROLLOUT_SCOUT_PATH,
    handler: (request, response) => handleRoute(ctx, request, response),
  }), 'rollout-scout: HTTP route');
}

export { ROLLOUT_SCOUT_PATH, apply, inject, name };
