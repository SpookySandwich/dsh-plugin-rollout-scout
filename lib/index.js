// dsh-plugin-rollout-scout — host half.
//
// Fishes for a limited-rollout conversation model by starting short probe
// conversations and reading their chain-of-thought live off the session/event
// firehose. Reasoning that leans on "Let me" marks the old model and the probe
// is cancelled immediately; enough "I'm" / "I need" / "For" marks a likely
// rollout catch, which is allowed to finish its turn and is kept for the user.
// The /rollout-scout route drives it: GET returns live state for the console,
// POST starts a run, stops launching, force-stops everything in flight, or
// clears finished probes.

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

// The tell is how a paragraph OPENS, not how often a phrase occurs across the
// whole text: a running tally drifts negative with length alone, so a long but
// genuinely promising chain-of-thought eventually accumulates enough "Let me"
// to be killed even while opening paragraph after paragraph the new way.
//
// Two openings are decisive on their own, and the FIRST one to appear settles
// the probe — a later "Let me" cannot overturn an "I'll" already seen.
const DECISIVE_OLD = /^Let me\b/i;
const DECISIVE_NEW = /^I'll\b/i;
// The rest are soft: they inform the score and, by their absence over the
// paragraph window, trigger a discard.
const POSITIVE_OPENING = /^(?:I'll|I will|I'm|I am|I need|I should|For(?![a-z]))/i;
const NEGATIVE_OPENING = /^(?:Let me|Let's|Let us|We need|We should|We'll|We can)/i;
// Only the start of a paragraph is inspected.
const OPENING_CHARS = 48;

// A chain-of-thought that switches to Chinese is its own verdict, independent
// of the openings. A handful of characters rather than one guards against an
// incidental quotation deciding it.
const CJK = /[㐀-鿿豈-﫿]/g;
const CJK_MIN = 4;

function isChinese(text) {
  return (text.match(CJK) ?? []).length >= CJK_MIN;
}

/**
 * Split a partial chain-of-thought into paragraphs, dropping the last one:
 * while text is still streaming its opening may be half-written, and a
 * paragraph must be judged on a complete opening or not at all.
 */
function settledParagraphs(text) {
  const parts = text.split(/\n+/).map((p) => p.trim()).filter((p) => p !== '');
  return parts.slice(0, -1);
}

/**
 * Classify by paragraph openings. `positive` counts paragraphs that open the
 * way the rollout model does; `paragraphs` is how many complete openings have
 * been seen, which is what the discard window measures against.
 */
function classify(text) {
  const paragraphs = settledParagraphs(text);
  const hits = {};
  let positive = 0;
  let negative = 0;
  let decisive = null;
  for (const paragraph of paragraphs) {
    const opening = paragraph.slice(0, OPENING_CHARS);
    if (decisive === null) {
      if (DECISIVE_NEW.test(opening)) decisive = 'new';
      else if (DECISIVE_OLD.test(opening)) decisive = 'old';
    }
    const positiveMatch = opening.match(POSITIVE_OPENING);
    const negativeMatch = opening.match(NEGATIVE_OPENING);
    if (positiveMatch) {
      positive += 1;
      hits[positiveMatch[0]] = (hits[positiveMatch[0]] ?? 0) + 1;
    } else if (negativeMatch) {
      negative += 1;
      hits[negativeMatch[0]] = (hits[negativeMatch[0]] ?? 0) + 1;
    }
  }
  // Shown as confidence: the share of classified openings reading as the
  // rollout model, held near 0.5 until openings actually accumulate. A
  // decisive opening pins it to the corresponding end.
  const classified = positive + negative;
  const score = decisive === 'new' ? 1 : decisive === 'old' ? 0 : (positive + 1) / (classified + 2);
  return { score, decisive, paragraphs: paragraphs.length, positive, negative, hits };
}

/* ------------------------------------------------------------------ config -- */

const DEFAULT_CONFIG = Object.freeze({
  prompt: 'Three guests pay $30 for a room. The clerk refunds $5; the bellhop pockets $2 and '
    + 'returns $1 to each guest. Each guest paid $9 — $27 in total — and the $2 kept makes $29. '
    + 'Where is the missing dollar? Reason it through carefully, then answer in one line.',
  concurrency: 2,
  provider: 'deepseek-official',
  model: 'deepseek-v4-pro',
  reasoningEffort: 'high',
  folder: path.join(os.homedir(), 'rollout-scout'),
  // Used only when no decisive opening has appeared: discard at/below
  // discardBelow, keep at/above keepAbove, and act on neither until
  // `minOpenings` paragraph openings have actually been classified.
  discardBelow: 0.35,
  keepAbove: 0.7,
  minOpenings: 4,
  // Give up on a probe that has opened this many paragraphs without a single
  // positive opening — the "nothing promising ever showed up" case.
  paragraphWindow: 10,
  // Stop launching new probes after the first confident catch.
  stopAfterHit: true,
  // A Chinese chain-of-thought is discarded on sight, whatever the score.
  discardChinese: true,
  // Delete probes judged as the old model (session log removed from disk).
  autoDelete: false,
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
  if (Number.isFinite(source.discardBelow)) config.discardBelow = Math.min(0.9, Math.max(0.05, source.discardBelow));
  if (Number.isFinite(source.keepAbove)) config.keepAbove = Math.min(0.99, Math.max(0.5, source.keepAbove));
  if (Number.isInteger(source.minOpenings)) config.minOpenings = Math.min(40, Math.max(1, source.minOpenings));
  if (Number.isInteger(source.paragraphWindow)) config.paragraphWindow = Math.min(200, Math.max(2, source.paragraphWindow));
  if (config.keepAbove <= config.discardBelow) {
    throw new TypeError('keepAbove 必须大于 discardBelow / keepAbove must exceed discardBelow');
  }
  if (typeof source.stopAfterHit === 'boolean') config.stopAfterHit = source.stopAfterHit;
  if (typeof source.discardChinese === 'boolean') config.discardChinese = source.discardChinese;
  if (typeof source.autoDelete === 'boolean') config.autoDelete = source.autoDelete;
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
  // Probes launched in the current run; reset by start() for the stat.
  launched: 0,
  // Never reset: ids must stay unique across runs or history collides.
  sequence: 0,
  note: null,
};

function publicAttempt(attempt) {
  return {
    id: attempt.id,
    sessionId: attempt.sessionId,
    status: attempt.status,
    verdict: attempt.verdict,
    score: attempt.score,
    decisive: attempt.decisive,
    reason: attempt.reason,
    paragraphs: attempt.paragraphs,
    positive: attempt.positive,
    negative: attempt.negative,
    hits: attempt.hits,
    chinese: attempt.chinese,
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

/** Keep the concurrency slots full for as long as the run is active. */
function pump(ctx) {
  if (!state.running) return;
  while (state.running && activeCount() < state.config.concurrency) {
    state.launched += 1;
    state.sequence += 1;
    const attempt = {
      id: state.sequence,
      sessionId: null,
      status: 'starting',
      verdict: null,
      score: 0.5,
      decisive: null,
      reason: null,
      paragraphs: 0,
      positive: 0,
      negative: 0,
      hits: {},
      chinese: false,
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
  // A force stop that landed while the agent was being created: never prompt.
  if (attempt.forced) {
    attempt.handle = null;
    finish(ctx, attempt);
    handle.dispose().catch(() => {});
    return;
  }
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

function discard(attempt, reason) {
  attempt.decided = true;
  attempt.verdict = 'old';
  attempt.reason = reason;
  attempt.status = 'discarding';
  try { attempt.handle.agent.cancel({ kind: 'user' }, { keepInbox: false }); } catch (e) {}
}

function keep(attempt, reason) {
  attempt.decided = true;
  attempt.verdict = 'rollout';
  attempt.reason = reason;
  attempt.status = 'kept-streaming';
  if (state.config.stopAfterHit) {
    state.running = false;
    state.note = 'hit';
  }
}

/**
 * Live verdict, in priority order: a Chinese chain-of-thought, then the first
 * decisive paragraph opening, then — when neither has appeared — the soft
 * score, and finally the window rule for a probe that has opened many
 * paragraphs without ever reading promising.
 */
function evaluate(ctx, attempt) {
  const result = classify(attempt.reasoning);
  attempt.score = result.score;
  attempt.decisive = result.decisive;
  attempt.paragraphs = result.paragraphs;
  attempt.positive = result.positive;
  attempt.negative = result.negative;
  attempt.hits = result.hits;
  if (attempt.decided) return;
  const config = state.config;

  if (config.discardChinese && isChinese(attempt.reasoning)) {
    attempt.chinese = true;
    discard(attempt, 'chinese');
    return;
  }
  if (result.decisive === 'new') { keep(attempt, 'decisive'); return; }
  if (result.decisive === 'old') { discard(attempt, 'decisive'); return; }

  const openings = result.positive + result.negative;
  if (openings >= config.minOpenings) {
    if (result.score <= config.discardBelow) { discard(attempt, 'score'); return; }
    if (result.score >= config.keepAbove) { keep(attempt, 'score'); return; }
  }
  // Nothing promising ever opened a paragraph: stop spending on it.
  if (result.paragraphs >= config.paragraphWindow && result.positive === 0) {
    discard(attempt, 'window');
  }
}

function finish(ctx, attempt) {
  if (attempt.closed) return;
  attempt.closed = true;
  attempt.endedAt = Date.now();
  if (attempt.watchdog) { clearTimeout(attempt.watchdog); attempt.watchdog = null; }
  if (!attempt.decided) {
    // The turn ended before anything fired: judge on the final score, but only
    // if any paragraph opening was ever classified.
    const openings = attempt.positive + attempt.negative;
    attempt.verdict = openings === 0 ? 'unknown'
      : attempt.score <= state.config.discardBelow ? 'old'
      : attempt.score >= state.config.keepAbove ? 'rollout'
      : 'unknown';
    if (attempt.verdict !== 'unknown') attempt.reason = 'score';
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
    attempt.status = attempt.error ? 'error' : (attempt.forced ? 'stopped' : 'finished');
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

/**
 * Stop launching AND abort every conversation still in flight. `cancel` is a
 * no-op when a probe has no active turn yet, so each agent is also disposed
 * and its attempt settled here rather than left waiting on a `turn/end` that
 * may never arrive.
 */
function forceStop(ctx) {
  state.running = false;
  state.note = 'force-stopped';
  for (const attempt of state.attempts) {
    if (attempt.closed) continue;
    // Marked even when the handle is not assigned yet: a probe still inside
    // launch() checks this flag as soon as its agent exists.
    attempt.forced = true;
    if (attempt.handle === null) continue;
    const handle = attempt.handle;
    attempt.handle = null;
    try { handle.agent.cancel({ kind: 'user' }, { keepInbox: false }); } catch (e) {}
    finish(ctx, attempt);
    handle.dispose().catch(() => {});
  }
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
        case 'force-stop':
          respondJson(response, 200, forceStop(ctx));
          return;
        case 'clear':
          respondJson(response, 200, clearHistory());
          return;
        default:
          throw new TypeError('action 必须是 start / stop / force-stop / clear');
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
