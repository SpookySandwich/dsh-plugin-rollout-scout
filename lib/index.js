// dsh-plugin-rollout-scout — host half.
//
// Fishes for a limited-rollout conversation model by starting short probe
// conversations and reading their chain-of-thought live off the session/event
// firehose. A paragraph opening with "Let me" marks the old model. The
// rollout path summarises CoT with a small model: even paragraphs, bursty
// pauses, I'll/I'm openings — a leading "We need" is only a score penalty.
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
// "We need" / "we will" in an opening count against the score, but they are
// not a kill: the rollout path often runs a small model that summarises the
// chain-of-thought, and that summariser commonly starts "We need to build…".
const NEGATIVE_OPENING = /\b(?:let me|let us|let's|we need|we will|we should|we can|we'll|we're|we've|we)\b/i;
// Summariser CoT arrives as even, essay-sized paragraphs. Old-model dumps
// are one blob or a mix of tiny "Let me" lines and a long irregular dump.
const SHAPE_MIN_PARAS = 3;
const SHAPE_MIN_CHARS = 80;
const SHAPE_MAX_CV = 0.85;
// Output-pause-output: the summariser writes a burst, stalls, then another
// burst. Gaps shorter than this are treated as ordinary streaming jitter.
const PAUSE_MS = 1400;
const BURST_MIN_CHARS = 80;

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
function paragraphShape(paragraphs) {
  if (paragraphs.length < SHAPE_MIN_PARAS) return false;
  const lengths = paragraphs.map((p) => p.length);
  const long = lengths.filter((n) => n >= SHAPE_MIN_CHARS).length;
  if (long < SHAPE_MIN_PARAS) return false;
  const mean = lengths.reduce((a, b) => a + b, 0) / lengths.length;
  if (mean < SHAPE_MIN_CHARS) return false;
  let variance = 0;
  for (const n of lengths) variance += (n - mean) ** 2;
  const cv = Math.sqrt(variance / lengths.length) / mean;
  return cv <= SHAPE_MAX_CV;
}

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
    // probes green forever while the meter dropped to 0%. The override
    // works because DECISIVE_OLD is tested after this on every paragraph.
    if (index === 0 && DECISIVE_NEW_FIRST.test(opening)) decisive = 'new';
    if (DECISIVE_OLD.test(opening)) decisive = 'old';
    const positiveMatch = opening.match(POSITIVE_OPENING) ?? opening.match(POSITIVE_FOR);
    const negativeMatch = opening.match(NEGATIVE_OPENING);
    // "We need" in the first paragraph is a negative opening, not a
    // kill: the summariser often starts "We need to build…" and then
    // writes I'll / I'm for the rest. Only "Let me" as a paragraph
    // opening is decisive against.
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
  // decisive "Let me" opening pins it to zero. Even paragraph shape is
  // one extra positive — the summariser writes regular blocks.
  const regular = paragraphShape(paragraphs);
  const classified = positive + negative;
  const extra = regular ? 1 : 0;
  const score = decisive === 'new' ? 1
    : decisive === 'old' ? 0
    : (positive + extra + 1) / (classified + extra + 2);
  return { score, decisive, paragraphs: paragraphs.length, positive, negative, hits, regular };
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
  // Delete probes judged as the old model (session log removed from disk).
  autoDelete: false,
});

// The probe folder is a workspace cwd the user types in, and `delete-all`
// removes every session attached to it. Pointing it at the harness state
// directory or at a home/root path would put unrelated conversations — or
// unrelated files — inside that blast radius, so those are refused outright.
const DSH_HOME = path.resolve(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'));

function isInside(child, parent) {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function assertSafeFolder(folder) {
  const resolved = path.resolve(folder);
  if (path.dirname(resolved) === resolved) {
    throw new TypeError('folder 不能是磁盘根目录 / folder must not be a filesystem root');
  }
  if (resolved === path.resolve(os.homedir())) {
    throw new TypeError('folder 不能是用户主目录 / folder must not be the home directory');
  }
  if (isInside(resolved, DSH_HOME) || isInside(DSH_HOME, resolved)) {
    throw new TypeError(`folder 不能位于 ${DSH_HOME} 内 / folder must be outside ${DSH_HOME}`);
  }
  return resolved;
}

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
  if (typeof source.autoDelete === 'boolean') config.autoDelete = source.autoDelete;
  if (!path.isAbsolute(config.folder)) throw new TypeError('folder 必须是绝对路径 / folder must be an absolute path');
  config.folder = assertSafeFolder(config.folder);
  return config;
}

/* ------------------------------------------------------------------- state -- */

const HISTORY_LIMIT = 120;
const WATCHDOG_MS = 240_000;
/** Fade on the card, then cancel. Hover or click during the fade rescues it. */
const FADE_MS = 3_200;
// A probe that fails before it ever streams frees its slot immediately, so
// pump() launches a replacement that fails the same way. With a provider
// down or the folder unwritable that is an unbounded launch storm, so the
// run halts itself after this many failures with no successful start between.
const LAUNCH_FAILURE_LIMIT = 3;

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
  // Consecutive launches that threw before reaching 'streaming'.
  launchFailures: 0,
  // Set with note 'launch-failed', so the console can show what broke.
  lastError: null,
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
    regular: !!attempt.regular,
    pauses: attempt.pauses || 0,
    pinned: !!attempt.pinned,
    held: !!attempt.held,
  };
}

function publicState() {
  return {
    running: state.running,
    paused: state.paused,
    config: state.config,
    launched: state.launched,
    note: state.note,
    lastError: state.lastError,
    active: state.attempts.filter((a) => isLive(a)).length,
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

function isLive(attempt) {
  if (attempt.closed) return false;
  return attempt.status === 'starting'
    || attempt.status === 'streaming'
    || attempt.status === 'kept-streaming'
    || attempt.status === 'pending-discard';
}

function activeCount() {
  let n = 0;
  for (const a of state.attempts) {
    if (isLive(a)) n += 1;
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
      streamed: false,
      watchdog: null,
      pauses: 0,
      lastChunkAt: null,
      burstChars: 0,
      pinned: false,
      held: false,
      fadeTimer: null,
    };
    state.attempts.unshift(attempt);
    if (state.attempts.length > HISTORY_LIMIT) {
      for (const dropped of state.attempts.slice(HISTORY_LIMIT)) clearFade(dropped);
      state.attempts.length = HISTORY_LIMIT;
    }
    launch(ctx, attempt).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      attempt.status = 'error';
      attempt.error = message;
      attempt.endedAt = Date.now();
      attempt.closed = true;
      // Only a launch that never reached 'streaming' counts towards the
      // breaker: a failure after the turn started is the probe's problem,
      // not a sign that launching itself is broken.
      if (!attempt.streamed) {
        state.launchFailures += 1;
        if (state.launchFailures >= LAUNCH_FAILURE_LIMIT) {
          state.running = false;
          state.paused = true;
          state.note = 'launch-failed';
          state.lastError = message;
        }
      }
      settle(ctx);
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
  attempt.streamed = true;
  // One probe that got as far as its first turn clears the breaker.
  state.launchFailures = 0;
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
      const now = Date.now();
      const text = chunk.text || '';
      if (attempt.lastChunkAt !== null && text.length > 0
          && now - attempt.lastChunkAt >= PAUSE_MS
          && attempt.burstChars >= BURST_MIN_CHARS) {
        attempt.pauses += 1;
        attempt.burstChars = 0;
      }
      attempt.lastChunkAt = now;
      attempt.burstChars += text.length;
      attempt.reasoning += text;
      evaluate(ctx, attempt);
    }
    return;
  }
  if (event.type === 'turn/end') {
    finish(ctx, attempt);
  }
}

function clearFade(attempt) {
  if (attempt.fadeTimer) {
    clearTimeout(attempt.fadeTimer);
    attempt.fadeTimer = null;
  }
}

function clearWatchdog(attempt) {
  if (attempt.watchdog) {
    clearTimeout(attempt.watchdog);
    attempt.watchdog = null;
  }
}

/** How long a cancelled probe is given to deliver its `turn/end`. */
const DISCARD_GRACE_MS = 10_000;

function commitDiscard(ctx, attempt) {
  clearFade(attempt);
  attempt.decided = true;
  attempt.verdict = 'old';
  if (attempt.closed) {
    attempt.status = 'discarded';
    attempt.endedAt = attempt.endedAt ?? Date.now();
    if (state.config.autoDelete) {
      deleteAttempt(ctx, attempt).catch((error) => {
        attempt.error = error instanceof Error ? error.message : String(error);
      });
    }
    settle(ctx);
    return;
  }
  attempt.status = 'discarding';
  try { attempt.handle.agent.cancel({ kind: 'user' }, { keepInbox: false }); } catch (e) {}
  // The long watchdog is pointless now — the turn is already cancelled. Swap
  // it for a short reaper so a cancel that never produces `turn/end` cannot
  // strand the attempt in 'discarding' with its agent handle still open.
  clearWatchdog(attempt);
  attempt.watchdog = setTimeout(() => {
    attempt.watchdog = null;
    if (!attempt.closed) finish(ctx, attempt);
  }, DISCARD_GRACE_MS);
}

/** Start the fade. The turn keeps running until the animation ends. */
function offerFade(ctx, attempt, reason) {
  if (attempt.pinned || attempt.held) return;
  if (attempt.status === 'pending-discard' || attempt.status === 'discarding') return;
  attempt.decided = true;
  attempt.verdict = 'old';
  attempt.reason = reason;
  attempt.status = 'pending-discard';
  clearFade(attempt);
  attempt.fadeTimer = setTimeout(() => {
    attempt.fadeTimer = null;
    if (attempt.pinned || attempt.held) return;
    if (attempt.status !== 'pending-discard') return;
    commitDiscard(ctx, attempt);
  }, FADE_MS);
}

function keep(attempt, reason) {
  clearFade(attempt);
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

function retractKeep(ctx, attempt, reason) {
  if (attempt.pinned || attempt.held) return;
  const pausedForHit = state.paused && state.note === 'hit';
  offerFade(ctx, attempt, reason);
  if (pausedForHit && !state.attempts.some((a) => a.verdict === 'rollout')) {
    state.running = true;
    state.paused = false;
    state.note = null;
    pump(ctx);
  }
}

function findAttempt(id) {
  const attempt = state.attempts.find((a) => a.id === Number(id));
  if (attempt === undefined) throw new TypeError('找不到该探测 / probe not found');
  return attempt;
}

/** Click, or hover on a fading card: keep it running. */
function pinAttempt(id) {
  const attempt = findAttempt(id);
  clearFade(attempt);
  attempt.pinned = true;
  attempt.held = true;
  if (attempt.closed) {
    attempt.status = 'pinned';
  } else if (attempt.status === 'pending-discard' || attempt.status === 'discarding') {
    attempt.status = 'streaming';
  }
  return publicState();
}

/** Mouse entered: do not discard. Fading cards are rescued. */
function holdAttempt(id) {
  const attempt = findAttempt(id);
  attempt.held = true;
  if (attempt.status === 'pending-discard') return pinAttempt(id);
  return publicState();
}

/** Mouse left. Pinned rows stay. Others may start fading. */
function releaseAttempt(ctx, id) {
  const attempt = findAttempt(id);
  attempt.held = false;
  if (attempt.pinned || attempt.closed) return publicState();
  if (attempt.decided && attempt.verdict === 'old'
      && attempt.status !== 'pending-discard' && attempt.status !== 'discarding') {
    offerFade(ctx, attempt, attempt.reason);
  }
  return publicState();
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
  if (openings >= config.minOpenings && attempt.score <= config.discardBelow) return 'score';
  if (result.paragraphs >= config.paragraphWindow && result.positive === 0) return 'window';
  return null;
}

function blendedScore(result, attempt) {
  if (result.decisive === 'new') return 1;
  if (result.decisive === 'old') return 0;
  const pauseExtra = (attempt.pauses || 0) >= 1 ? 1 : 0;
  if (pauseExtra === 0) return result.score;
  const classified = result.positive + result.negative;
  const extra = (result.regular ? 1 : 0) + pauseExtra;
  return (result.positive + extra + 1) / (classified + extra + 2);
}

function evaluate(ctx, attempt, final) {
  const result = classify(attempt.reasoning, final);
  attempt.decisive = result.decisive;
  attempt.paragraphs = result.paragraphs;
  attempt.positive = result.positive;
  attempt.negative = result.negative;
  attempt.hits = result.hits;
  attempt.regular = result.regular;
  attempt.score = blendedScore(result, attempt);
  const reject = wantsDiscard(attempt, result);
  if (reject === 'chinese') attempt.chinese = true;

  if (attempt.pinned || attempt.held) return;

  if (attempt.decided) {
    if (attempt.verdict === 'rollout' && reject) {
      retractKeep(ctx, attempt, reject);
    }
    return;
  }
  if (reject) {
    offerFade(ctx, attempt, reject);
    return;
  }
  if (result.decisive === 'new') { keep(attempt, 'decisive'); return; }
  const openings = result.positive + result.negative;
  if (openings >= state.config.minOpenings && attempt.score >= state.config.keepAbove) {
    keep(attempt, 'score');
    return;
  }
  // Summariser fingerprint: even paragraphs plus at least one stall
  // between bursts, and some first-person-singular openings.
  if (result.regular && (attempt.pauses || 0) >= 1 && result.positive >= 2 && result.decisive !== 'old') {
    keep(attempt, 'shape');
  }
}

function finish(ctx, attempt) {
  if (attempt.closed) return;
  attempt.closed = true;
  attempt.endedAt = Date.now();
  clearWatchdog(attempt);
  if (!attempt.forced) {
    evaluate(ctx, attempt, true);
  }
  if (attempt.status === 'pending-discard') {
    if (attempt.forced) {
      clearFade(attempt);
      attempt.status = 'discarded';
    }
    settle(ctx);
    return;
  }
  if (attempt.pinned) {
    attempt.status = 'pinned';
    settle(ctx);
    return;
  }
  if (!attempt.decided) {
    if (attempt.forced || attempt.error) {
      attempt.verdict = 'unknown';
    } else {
      const openings = attempt.positive + attempt.negative;
      if (openings >= state.config.minOpenings && attempt.score >= state.config.keepAbove) {
        attempt.verdict = 'rollout';
        attempt.reason = 'score';
      } else if (attempt.held) {
        attempt.verdict = 'old';
        attempt.reason = attempt.positive === 0 ? 'window' : 'ended';
      } else {
        offerFade(ctx, attempt, attempt.positive === 0 ? 'window' : 'ended');
        settle(ctx);
        return;
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
  } else if (attempt.verdict === 'old' && !attempt.pinned && !attempt.held) {
    attempt.status = 'discarded';
    if (state.config.autoDelete) {
      deleteAttempt(ctx, attempt).catch((error) => {
        attempt.error = error instanceof Error ? error.message : String(error);
      });
    }
  } else {
    attempt.status = attempt.error ? 'error' : (attempt.forced ? 'stopped' : (attempt.pinned ? 'pinned' : 'finished'));
  }
  settle(ctx);
}

/** A slot just freed up: try to refill it. */
function settle(ctx) {
  pump(ctx);
}

/**
 * Delete one session's log from disk. The harness gives each session its own
 * directory (…/sessions/<workspace>/<sessionId>/session.jsonl.zstd), so the
 * directory is what has to go — but that layout is not a contract, and a
 * recursive remove of the parent would take every sibling session with it if
 * the log ever became a flat file in a shared directory. The directory is
 * therefore only removed when it demonstrably belongs to this session;
 * otherwise just the log file goes.
 */
async function removeSessionLog(ctx, sessionId, headers) {
  const header = headers.find((h) => h.id === sessionId);
  if (header === undefined) return;
  let location;
  try { location = ctx.sessionPersistence.locate(header); } catch (e) { return; }
  if (location === undefined || typeof location.path !== 'string') return;
  const dir = path.dirname(location.path);
  if (path.basename(dir) === sessionId) {
    await fs.rm(dir, { recursive: true, force: true });
  } else {
    await fs.rm(location.path, { force: true });
  }
}

/** Remove a discarded probe entirely: live agent, workspace slot, on-disk log. */
async function deleteAttempt(ctx, attempt) {
  const sessionId = attempt.sessionId;
  if (sessionId === null) return;
  const workspace = ctx.workspaceRegistry.list().find((w) => w.sessionIds.includes(sessionId));
  try { await workspace?.detachSession(sessionId); } catch (e) {}
  try { await attempt.handle?.dispose(); } catch (e) {}
  attempt.handle = null;
  let headers = [];
  try { headers = await ctx.sessionPersistence.list(); } catch (e) {}
  await removeSessionLog(ctx, sessionId, headers);
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
  state.lastError = null;
  state.launchFailures = 0;
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
  state.lastError = null;
  // A resume after the breaker tripped is the user saying "try again".
  state.launchFailures = 0;
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
  state.lastError = null;
  state.launchFailures = 0;
  for (const attempt of state.attempts) {
    clearFade(attempt);
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
  // Named for what they hold rather than `keep`, which is the verdict
  // function one scope up.
  const retained = [];
  const dropped = [];
  for (const attempt of state.attempts) {
    if (isLive(attempt) || attempt.pinned) {
      retained.push(attempt);
    } else {
      dropped.push(attempt);
    }
  }
  state.attempts = retained;
  for (const attempt of dropped) {
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
  // `running` is false while paused, but paused probes keep streaming: deleting
  // a session log out from under a live turn corrupts it and leaves an orphaned
  // agent writing to a directory that no longer exists. Clearing has always
  // refused to touch live probes; deleting has to refuse too.
  if (state.attempts.some((a) => isLive(a))) {
    throw new Error('仍有探测在进行中，请先强制停止 / probes are still live — force stop first');
  }
  const folderNorm = path.resolve(state.config.folder);
  for (const attempt of state.attempts) {
    clearFade(attempt);
    clearWatchdog(attempt);
    try { await attempt.handle?.dispose(); } catch (e) {}
    attempt.handle = null;
  }

  const workspace = ctx.workspaceRegistry.list().find((w) => {
    try { return path.resolve(w.path) === folderNorm; } catch (e) { return false; }
  });
  // Two sources, both scoped to the probe workspace: the sessions it still
  // holds — which is what carries probes from earlier runs that a previous
  // clear dropped from the in-memory list — plus the ones this run launched.
  // Scanning every session header for a path under the probe folder used to
  // be a third source, but session logs live under the harness state
  // directory, never under the workspace cwd, so it never matched anything.
  const ids = new Set();
  for (const id of workspace?.sessionIds ?? []) ids.add(id);
  for (const attempt of state.attempts) {
    if (attempt.sessionId) ids.add(attempt.sessionId);
  }

  let headers = [];
  try { headers = await ctx.sessionPersistence.list(); } catch (e) {}
  // One session failing to unlink must not strand the rest: keep going and
  // report afterwards, once the list has already been reset.
  let failure = null;
  for (const sessionId of ids) {
    try { await workspace?.detachSession(sessionId); } catch (e) {}
    try {
      await removeSessionLog(ctx, sessionId, headers);
    } catch (error) {
      failure = failure ?? (error instanceof Error ? error.message : String(error));
    }
  }

  state.attempts = [];
  state.sequence = 0;
  state.launched = 0;
  state.paused = false;
  state.note = null;
  state.lastError = null;
  state.launchFailures = 0;
  if (failure !== null) throw new Error(failure);
  return publicState();
}

/* -------------------------------------------------------------------- http -- */

// Actions here start conversations and delete session logs, and the route
// listens on a local port that any page in the browser can reach. Without a
// check, a page the user happens to be visiting could POST `delete-all` as a
// CORS "simple request": it could not read the reply, but the deletion would
// still happen. Two things prevent that. Requiring a JSON content type takes
// the request out of the simple set, so the browser must preflight it — and
// no CORS headers are ever sent, so the preflight fails. Rejecting a
// cross-origin `Origin` closes the gap for any client that skips preflight.
const MAX_BODY_BYTES = 256 * 1024;

function sameOrigin(request) {
  const origin = request.headers.origin;
  // Same-origin fetches send no Origin header at all.
  if (origin === undefined || origin === 'null') return true;
  let host;
  try { ({ host } = new URL(origin)); } catch (e) { return false; }
  return host === request.headers.host;
}

function isJsonBody(request) {
  const type = request.headers['content-type'];
  if (typeof type !== 'string') return false;
  return type.split(';')[0].trim().toLowerCase() === 'application/json';
}

function requestJson(request) {
  return new Promise((resolve, reject) => {
    const decoder = new TextDecoder();
    let text = '';
    let bytes = 0;
    request.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > MAX_BODY_BYTES) {
        reject(new TypeError('请求体过大 / request body too large'));
        request.destroy();
        return;
      }
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
    if (!sameOrigin(request)) {
      respondJson(response, 403, { error: '跨源请求被拒绝 / cross-origin request refused' });
      return;
    }
    if (request.method === 'GET') {
      respondJson(response, 200, publicState());
      return;
    }
    if (request.method === 'POST') {
      if (!isJsonBody(request)) {
        respondJson(response, 415, {
          error: 'content-type 必须是 application/json / content-type must be application/json',
        });
        return;
      }
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
        case 'pin':
          respondJson(response, 200, pinAttempt(body.id));
          return;
        case 'hold':
          respondJson(response, 200, holdAttempt(body.id));
          return;
        case 'release':
          respondJson(response, 200, releaseAttempt(ctx, body.id));
          return;
        default:
          throw new TypeError('action 必须是 start / pause / resume / force-stop / clear / delete-all / pin / hold / release');
      }
    }
    response.writeHead(405);
    response.end();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // Bad input is the caller's fault (400); anything else is a state
    // conflict (409). A malformed body throws SyntaxError out of JSON.parse,
    // which used to be reported as a conflict.
    const badRequest = error instanceof TypeError || error instanceof SyntaxError;
    respondJson(response, badRequest ? 400 : 409, { error: message });
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
// directly against recorded chains-of-thought without spending a real probe;
// `sanitizeConfig` so the folder guard can be tested without touching disk.
export { ROLLOUT_SCOUT_PATH, apply, chineseShare, classify, inject, name, sanitizeConfig };
