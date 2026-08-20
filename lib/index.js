// dsh-plugin-rollout-scout — host half.
//
// Fishes for a limited-rollout conversation model by starting short probe
// conversations and reading their chain-of-thought live off the session/event
// firehose. A paragraph opening with "Let me" marks the old model and the
// probe is cancelled immediately; a chain-of-thought that opens with "I'll"
// marks a rollout catch, which is allowed to finish its turn and kept.
// The /rollout-scout route drives it: GET returns live state for the console,
// POST starts a run, pauses or resumes launching, force-stops everything in
// flight, or clears finished probes.

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
// The two decisive signals are not symmetric. "Let me" opening any paragraph
// settles the probe as the old model. "I'll" only proves the rollout model
// when it opens the WHOLE chain-of-thought: old-model reasoning happily opens
// a middle paragraph with "I'll create a single HTML file..." and then says
// "Let me build..." further down, so treating any "I'll" as proof produced
// false positives. Elsewhere it is one positive signal among several.
// Only the opening stretch of a paragraph is inspected — never its body.
const OPENING_CHARS = 48;
// The phrase rarely sits at character zero: the old model writes "The
// directory is empty. Let me create a 3D scene." and the new one "To avoid
// conflicts, I'll keep I18n.cs edits separate." Anchoring at the very start
// misses both, so the whole opening window is searched instead.
const DECISIVE_OLD = /\bLet me\b/i;
// Only meaningful on the first paragraph of the whole chain-of-thought.
const DECISIVE_NEW_FIRST = /^I'll\b/i;
// First-person planning voice. "I" is always capitalised, so these stay
// case-sensitive and cannot match inside another word.
const POSITIVE_OPENING = /\b(?:I'll|I will|I'm|I am|I've|I have|I need|I think|I also)\b/;
// "For" only counts when it actually opens the paragraph: lowercase "for"
// is far too common mid-sentence to mean anything.
const POSITIVE_FOR = /^For\b/;
// The rollout model reasons in the first person singular. Any "we" in the
// opening is the older voice, so the whole pronoun counts against rather than
// an enumerated list of "we need" / "we should" / "we can" phrasings.
const NEGATIVE_OPENING = /\b(?:let me|let us|let's|we need|we will|we should|we can|we'll|we're|we've|we)\b/i;

// A chain-of-thought that is actually *thinking* in Chinese is its own
// verdict, independent of the openings. Measured as a share of the letters
// rather than a raw count, so quoting a Chinese prompt inside otherwise
// English reasoning cannot trigger it. Punctuation, digits and whitespace
// are language-neutral and excluded from both sides.
const CJK = /[㐀-鿿豈-﫿]/g;
const LATIN = /[A-Za-z]/g;
// Below this many letters the share is too noisy to act on.
const LANGUAGE_MIN_CHARS = 24;

function chineseShare(text) {
  const cjk = (text.match(CJK) ?? []).length;
  const latin = (text.match(LATIN) ?? []).length;
  const total = cjk + latin;
  if (total < LANGUAGE_MIN_CHARS) return 0;
  return cjk / total;
}

/** Phrase chips need the sign from here: matching against lowercase
 *  literals on the client painted "We need" green even when it scored
 *  as the old model. */
function addHit(hits, phrase, sign) {
  const existing = hits[phrase];
  if (existing) existing.count += 1;
  else hits[phrase] = { count: 1, sign };
}

/**
 * Split a chain-of-thought into paragraphs whose openings are already
 * fixed. A paragraph opening stops changing once OPENING_CHARS have
 * arrived — waiting for a newline left single-blob chains-of-thought
 * (the common case) stuck at 50% with "no classified opening" until
 * the turn ended, which is why "We need respond in Chinese…" probes
 * sat under the keep mark without being discarded.
 */
function settledParagraphs(text, final) {
  const parts = text.split(/\n+/).map((p) => p.trim()).filter((p) => p !== '');
  if (final || parts.length === 0) return parts;
  const last = parts[parts.length - 1];
  if (last.length >= OPENING_CHARS) return parts;
  return parts.slice(0, -1);
}

/**
 * Classify by paragraph openings. `positive` counts paragraphs that open the
 * way the rollout model does; `paragraphs` is how many complete openings have
 * been seen, which is what the discard window measures against.
 */
function classify(text, final) {
  const paragraphs = settledParagraphs(text, final);
  const hits = {};
  let positive = 0;
  let negative = 0;
  let decisive = null;
  for (let index = 0; index < paragraphs.length; index += 1) {
    const paragraph = paragraphs[index];
    const opening = paragraph.slice(0, OPENING_CHARS);
    // Only the very first paragraph can prove the rollout model, and a
    // later "Let me" opening always overrides it: old-model reasoning
    // often starts with "I'll create a single HTML file…" then says
    // "Let me build…" further down. Locking the first I'll left those
    // probes green forever while the meter dropped to 0%.
    if (index === 0 && DECISIVE_NEW_FIRST.test(opening) && decisive !== 'old') {
      decisive = 'new';
    }
    if (DECISIVE_OLD.test(opening)) decisive = 'old';
    const positiveMatch = opening.match(POSITIVE_OPENING) ?? opening.match(POSITIVE_FOR);
    const negativeMatch = opening.match(NEGATIVE_OPENING);
    // The rollout model opens in the first person singular. A first
    // paragraph already speaking as "we" / "we need" is the older voice,
    // same class of tell as "Let me" — waiting for four of them left
    // one-paragraph probes unscored until the turn ended.
    if (index === 0 && decisive === null && negativeMatch && !positiveMatch) {
      decisive = 'old';
    }
    if (positiveMatch) {
      positive += 1;
      addHit(hits, positiveMatch[0], 'pos');
    } else if (negativeMatch) {
      negative += 1;
      addHit(hits, negativeMatch[0], 'neg');
    }
  }
  // Shown as confidence: the share of classified openings reading as the
  // rollout model, held near 0.5 until openings actually accumulate. A
  // decisive "Let me" opening pins it to zero.
  const classified = positive + negative;
  const score = decisive === 'new' ? 1 : decisive === 'old' ? 0 : (positive + 1) / (classified + 2);
  return { score, decisive, paragraphs: paragraphs.length, positive, negative, hits };
}

/* ------------------------------------------------------------------ config -- */

const DEFAULT_CONFIG = Object.freeze({
  // No default: the probe prompt is the user's to choose.
  prompt: '',
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
  // Pause launching after the first confident catch, so the run can be
  // resumed rather than restarted. Off by default: fishing usually wants to
  // keep going past one hit.
  autoPauseOnMatch: false,
  // Discard a chain-of-thought that is thinking in Chinese, whatever the
  // score — but only when Chinese dominates it, not when it merely quotes.
  discardChinese: true,
  chineseShare: 0.8,
  // Cancel probes judged as the old model. Off leaves them running so a
  // false negative can still be opened and read.
  autoDiscard: true,
  // Delete probes judged as the old model (session log removed from disk).
  autoDelete: false,
});

function sanitizeConfig(raw) {
  const source = typeof raw === 'object' && raw !== null ? raw : {};
  const config = { ...DEFAULT_CONFIG };
  if (typeof source.prompt === 'string') config.prompt = source.prompt;
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
  if (typeof source.autoPauseOnMatch === 'boolean') config.autoPauseOnMatch = source.autoPauseOnMatch;
  if (typeof source.discardChinese === 'boolean') config.discardChinese = source.discardChinese;
  if (Number.isFinite(source.chineseShare)) config.chineseShare = Math.min(1, Math.max(0.5, source.chineseShare));
  if (typeof source.autoDiscard === 'boolean') config.autoDiscard = source.autoDiscard;
  if (typeof source.autoDelete === 'boolean') config.autoDelete = source.autoDelete;
  if (!path.isAbsolute(config.folder)) throw new TypeError('folder 必须是绝对路径 / folder must be an absolute path');
  return config;
}

/* ------------------------------------------------------------------- state -- */

const HISTORY_LIMIT = 120;
const WATCHDOG_MS = 240_000;

const state = {
  running: false,
  // Launching stopped but the run is resumable; distinct from never started.
  paused: false,
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
    paused: state.paused,
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
  if (!state.config.autoDiscard) {
    // Flag only: leave the turn running so a suspected false negative
    // can be opened. A retracted keep goes back to ordinary streaming.
    if (attempt.status === 'kept-streaming') attempt.status = 'streaming';
    return;
  }
  attempt.status = 'discarding';
  try { attempt.handle.agent.cancel({ kind: 'user' }, { keepInbox: false }); } catch (e) {}
}

function keep(attempt, reason) {
  attempt.decided = true;
  attempt.verdict = 'rollout';
  attempt.reason = reason;
  attempt.status = 'kept-streaming';
  if (state.config.autoPauseOnMatch) {
    state.running = false;
    state.paused = true;
    state.note = 'hit';
  }
}

/**
 * A keep is provisional. If later openings read as the old model, retract
 * it so the probe is cancelled and auto-deleted like any other discard.
 * If auto-pause had frozen the run for this false catch, start fishing
 * again.
 */
function retractKeep(ctx, attempt, reason) {
  const pausedForHit = state.paused && state.note === 'hit';
  discard(attempt, reason);
  if (pausedForHit && !state.attempts.some((a) => a.verdict === 'rollout')) {
    state.running = true;
    state.paused = false;
    state.note = null;
    pump(ctx);
  }
}

/**
 * Live verdict, in priority order: a Chinese chain-of-thought, then the first
 * decisive paragraph opening, then — when neither has appeared — the soft
 * score, and finally the window rule for a probe that has opened many
 * paragraphs without ever reading promising.
 */
function wantsDiscard(attempt, result) {
  const config = state.config;
  if (config.discardChinese && chineseShare(attempt.reasoning) >= config.chineseShare) {
    return 'chinese';
  }
  if (result.decisive === 'old') return 'decisive';
  const openings = result.positive + result.negative;
  if (openings >= config.minOpenings && result.score <= config.discardBelow) return 'score';
  if (result.paragraphs >= config.paragraphWindow && result.positive === 0) return 'window';
  return null;
}

function evaluate(ctx, attempt, final) {
  const result = classify(attempt.reasoning, final);
  attempt.score = result.score;
  attempt.decisive = result.decisive;
  attempt.paragraphs = result.paragraphs;
  attempt.positive = result.positive;
  attempt.negative = result.negative;
  attempt.hits = result.hits;
  const reject = wantsDiscard(attempt, result);
  if (reject === 'chinese') attempt.chinese = true;

  // A keep is not final: "I'll" / a high score can land first, then a
  // later "Let me" opening reveals the old model. Retract so auto-delete
  // actually runs instead of leaving a green 灰度 card at 0%.
  if (attempt.decided) {
    if (attempt.verdict === 'rollout' && reject) {
      retractKeep(ctx, attempt, reject);
    }
    return;
  }
  if (reject) {
    discard(attempt, reject);
    return;
  }
  if (result.decisive === 'new') { keep(attempt, 'decisive'); return; }
  const openings = result.positive + result.negative;
  if (openings >= state.config.minOpenings && result.score >= state.config.keepAbove) {
    keep(attempt, 'score');
  }
}

function finish(ctx, attempt) {
  if (attempt.closed) return;
  attempt.closed = true;
  attempt.endedAt = Date.now();
  if (attempt.watchdog) { clearTimeout(attempt.watchdog); attempt.watchdog = null; }
  if (!attempt.forced) {
    // Re-run over the complete text so a short last paragraph still
    // counts, and so a keep can still be retracted if it ended "Let me".
    evaluate(ctx, attempt, true);
  }
  if (!attempt.decided) {
    // The gray zone (between discardBelow and keepAbove, or fewer than
    // minOpenings) is only for live probes still gathering evidence.
    // Once the turn has ended, a probe that was not kept is discarded —
    // otherwise the queue fills with 50% "inconclusive" meters sitting
    // under the keep mark.
    if (attempt.forced || attempt.error) {
      attempt.verdict = 'unknown';
    } else {
      const openings = attempt.positive + attempt.negative;
      if (openings >= state.config.minOpenings && attempt.score >= state.config.keepAbove) {
        attempt.verdict = 'rollout';
        attempt.reason = 'score';
      } else if (state.config.autoDiscard) {
        attempt.verdict = 'old';
        attempt.reason = attempt.positive === 0 ? 'window' : 'ended';
      } else {
        attempt.verdict = 'unknown';
        attempt.reason = 'ended';
      }
    }
  }
  if (attempt.verdict === 'rollout') {
    attempt.status = 'kept';
    if (state.config.autoPauseOnMatch) {
      state.running = false;
      state.paused = true;
      state.note = 'hit';
    }
  } else if (attempt.verdict === 'old' && state.config.autoDiscard) {
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
  if (state.config.prompt.trim() === '') {
    throw new TypeError('请先填写探测提示词 / enter a probe prompt first');
  }
  state.running = true;
  state.paused = false;
  state.launched = 0;
  state.note = null;
  // Probe numbers restart at 1 when the list is empty so a fresh run
  // after deleting sessions does not continue from 101.
  if (state.attempts.length === 0) state.sequence = 0;
  pump(ctx);
  return publicState();
}

/** Stop launching; probes already in flight run on to their own verdicts. */
function pause() {
  if (!state.running) return publicState();
  state.running = false;
  state.paused = true;
  state.note = 'paused';
  return publicState();
}

/** Resume launching under the config the run started with. */
function resume(ctx) {
  if (state.running) return publicState();
  state.running = true;
  state.paused = false;
  state.note = null;
  pump(ctx);
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
  state.paused = false;
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

async function clearHistory(ctx) {
  if (state.running) throw new Error('运行中不能清空 / cannot clear while running');
  const keep = [];
  const drop = [];
  for (const attempt of state.attempts) {
    if (attempt.status === 'starting' || attempt.status === 'streaming' || attempt.status === 'kept-streaming') {
      keep.push(attempt);
    } else {
      drop.push(attempt);
    }
  }
  state.attempts = keep;
  for (const attempt of drop) {
    try { await deleteAttempt(ctx, attempt); } catch (e) {}
  }
  if (state.attempts.length === 0) state.sequence = 0;
  return publicState();
}

/**
 * Delete every probe conversation on disk — including ones already
 * dropped from the in-memory list by a previous clear — and reset
 * numbering so the next run starts at probe 1.
 */
async function deleteAll(ctx) {
  if (state.running) throw new Error('运行中不能删除 / cannot delete while running');
  const folderNorm = path.resolve(state.config.folder);
  for (const attempt of state.attempts) {
    try { await attempt.handle?.dispose(); } catch (e) {}
    attempt.handle = null;
  }

  const workspace = ctx.workspaceRegistry.list().find((w) => {
    try { return path.resolve(w.path) === folderNorm; } catch (e) { return false; }
  });
  const ids = new Set();
  if (workspace && Array.isArray(workspace.sessionIds)) {
    for (const id of workspace.sessionIds) ids.add(id);
  } else if (workspace && workspace.sessionIds && typeof workspace.sessionIds[Symbol.iterator] === 'function') {
    for (const id of workspace.sessionIds) ids.add(id);
  }
  for (const attempt of state.attempts) {
    if (attempt.sessionId) ids.add(attempt.sessionId);
  }

  let headers = [];
  try { headers = await ctx.sessionPersistence.list(); } catch (e) {}
  for (const header of headers) {
    try {
      const location = ctx.sessionPersistence.locate(header);
      if (location !== undefined && typeof location.path === 'string') {
        const resolved = path.resolve(location.path);
        if (resolved === folderNorm || resolved.startsWith(folderNorm + path.sep)) {
          ids.add(header.id);
        }
      }
    } catch (e) {}
  }

  for (const sessionId of ids) {
    try { await workspace?.detachSession(sessionId); } catch (e) {}
    const header = headers.find((h) => h.id === sessionId);
    if (header !== undefined) {
      const location = ctx.sessionPersistence.locate(header);
      if (location !== undefined && typeof location.path === 'string') {
        await fs.rm(path.dirname(location.path), { recursive: true, force: true });
      }
    }
  }

  state.attempts = [];
  state.sequence = 0;
  state.launched = 0;
  state.paused = false;
  state.note = null;
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
        case 'pause':
          respondJson(response, 200, pause());
          return;
        case 'resume':
          respondJson(response, 200, resume(ctx));
          return;
        case 'force-stop':
          respondJson(response, 200, forceStop(ctx));
          return;
        case 'clear':
          respondJson(response, 200, await clearHistory(ctx));
          return;
        case 'delete-all':
          respondJson(response, 200, await deleteAll(ctx));
          return;
        default:
          throw new TypeError('action 必须是 start / pause / resume / force-stop / clear / delete-all');
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

// `classify` and `chineseShare` are exported so the classifier can be tested
// directly against recorded chains-of-thought without spending a real probe.
export { ROLLOUT_SCOUT_PATH, apply, chineseShare, classify, inject, name };
