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
import { FIXTURES } from './fixtures.js';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const ROLLOUT_SCOUT_PATH = '/rollout-scout';

// DSH Desktop registers this namespace from its own notification plugin, in
// this same host context. Reading it tells the console whether a run is about
// to raise one system toast per finished probe; writing it is how the "turn
// them off" button in the pre-flight dialog works. A web-only harness never
// registers it, and then there is nothing to warn about.
const DESKTOP_NOTIFICATIONS_NS = 'dsh-desktop-notifications';

// Marks the probe prompt as ours rather than as something the user typed.
const PLUGIN_SOURCE = 'dsh-plugin-rollout-scout';

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
  // Discard when streaming TPS exceeds this value (chunks / sec).
  discardAboveTps: false,
  maxTps: 60,
  // Discard when first-token latency is below this threshold (too fast, in seconds).
  discardBelowTtft: false,
  minTtft: 2.0,
  // Probe conversations are named from the host, and the name lands in the
  // user's sidebar, so it follows the console's display language.
  locale: 'en',
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
  if (typeof source.discardAboveTps === 'boolean') config.discardAboveTps = source.discardAboveTps;
  if (Number.isFinite(source.maxTps)) config.maxTps = Math.min(300, Math.max(1, source.maxTps));
  if (typeof source.discardBelowTtft === 'boolean') config.discardBelowTtft = source.discardBelowTtft;
  if (Number.isFinite(source.minTtft)) config.minTtft = Math.min(60, Math.max(0.1, source.minTtft));
  if (source.locale === 'zh' || source.locale === 'en') config.locale = source.locale;
  if (!path.isAbsolute(config.folder)) throw new TypeError('folder 必须是绝对路径 / folder must be an absolute path');
  config.folder = assertSafeFolder(config.folder);
  return config;
}

/* ------------------------------------------------------------------- state -- */

const HISTORY_LIMIT = 120;
const WATCHDOG_MS = 240_000;
/** Fade on the card, then cancel. Hover during the fade pauses it. */
const FADE_MS = 3_200;
// A probe that fails before it ever streams frees its slot immediately, so
// pump() launches a replacement that fails the same way. With a provider
// down or the folder unwritable that is an unbounded launch storm, so the
// run halts itself after this many failures with no successful start between.
const LAUNCH_FAILURE_LIMIT = 3;

// The host context, captured by `apply` so read-only lookups (settings, the
// live session store) do not have to be threaded through every operation.
let host = null;

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
  // Identifies attempts from the same Start/Resume cycle. Historical catches
  // must not influence auto-pause decisions in a later run.
  runId: 0,
  note: null,
  // Consecutive launches that threw before reaching 'streaming'.
  launchFailures: 0,
  // Set with note 'launch-failed', so the console can show what broke.
  lastError: null,
  orphans: { live: 0, cold: 0, at: 0 },
  // What the last pause and the last sweep accounted for, for the console.
  culled: 0,
  reaped: 0,
  // The client uses this edge to refresh the shell's session baseline. It
  // covers automatic deletion too, not only deletions initiated by a button.
  sessionsRevision: 0,
};

/* ------------------------------------------------------- durable promises -- */

// The protected set is the one piece of plugin state that MUST outlive the
// process. Everything else can be rebuilt by looking at the folder, but
// "never touch this one" cannot be re-derived from anything on disk — and the
// sweep that cleans up after a plugin reload walks the folder, so without a
// durable record it would take the catch with it.
//
// It rides with the probe folder rather than with the plugin, because that is
// what it describes: repoint the scout somewhere new and the old folder keeps
// its own promises.
const STATE_FILE = '.rollout-scout.json';
const STATE_VERSION = 1;

// Protection belongs to a folder, not to whichever run happens to be current
// when an asynchronous turn ends. Each folder therefore owns its own cached
// set and write queue. The queue makes rapid Keep/Unkeep clicks persist in
// logical order; computing the body inside the queued write means the last
// write always reflects the newest in-memory set.
const protectionByFolder = new Map();

function folderKey(folder) {
  return path.resolve(folder);
}

function protectionFor(folder) {
  const key = folderKey(folder);
  let record = protectionByFolder.get(key);
  if (record === undefined) {
    record = { key, ids: new Set(), loaded: false, loading: null, writeTail: Promise.resolve() };
    protectionByFolder.set(key, record);
  }
  return record;
}

function stateFilePath(folder) {
  return path.join(folder, STATE_FILE);
}

async function loadPromises(folder) {
  const record = protectionFor(folder);
  if (record.loaded) return record.ids;
  if (record.loading !== null) return record.loading;
  record.loading = (async () => {
    let text;
    try {
      text = await fs.readFile(stateFilePath(record.key), 'utf8');
    } catch (error) {
      if (error && error.code === 'ENOENT') {
        record.loaded = true;
        return record.ids;
      }
      throw new Error(`无法读取保留记录 / cannot read protection record`, { cause: error });
    }
    let raw;
    try {
      raw = JSON.parse(text);
    } catch (error) {
      throw new Error(`保留记录已损坏，拒绝执行 / protection record is corrupt`, { cause: error });
    }
    if (typeof raw !== 'object' || raw === null || raw.version !== STATE_VERSION
        || !Array.isArray(raw.protected)) {
      throw new Error('保留记录格式未知，拒绝执行 / unknown protection record format');
    }
    for (const id of raw.protected) if (typeof id === 'string') record.ids.add(id);
    record.loaded = true;
    return record.ids;
  })();
  try {
    return await record.loading;
  } finally {
    record.loading = null;
  }
}

/** Atomically persist one folder's promises, in mutation order. */
function savePromises(folder) {
  const record = protectionFor(folder);
  const write = async () => {
    const body = JSON.stringify({
      version: STATE_VERSION,
      protected: [...record.ids],
    }, null, 2);
    await fs.mkdir(record.key, { recursive: true });
    const target = stateFilePath(record.key);
    const temporary = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporary, `${body}\n`);
      await fs.rename(temporary, target);
    } finally {
      await fs.rm(temporary, { force: true }).catch(() => {});
    }
  };
  const queued = record.writeTail.then(write, write);
  record.writeTail = queued.catch(() => {});
  return queued;
}

/* ------------------------------------------------------------- protection -- */

/** Fixed in place by the user; the classifier may not revise it. */
function settled(attempt) {
  return attempt.protectedCatch
    || (attempt.sessionId !== null && protectionFor(attempt.folder).ids.has(attempt.sessionId));
}

/** Protection is a disk-retention promise, not permission to spend forever. */
function deletable(attempt) {
  return !settled(attempt);
}

/** Session ids protected from deletion in one folder. */
function keptIds(folder) {
  const key = folderKey(folder);
  const ids = new Set(protectionFor(key).ids);
  for (const attempt of state.attempts) {
    if (attempt.folder === key && attempt.sessionId !== null && settled(attempt)) ids.add(attempt.sessionId);
  }
  return ids;
}

function markProtected(attempt) {
  attempt.protectedCatch = true;
  attempt.protectionDismissed = false;
  if (attempt.sessionId === null) return Promise.resolve();
  protectionFor(attempt.folder).ids.add(attempt.sessionId);
  return savePromises(attempt.folder);
}

function unmarkProtected(attempt) {
  attempt.protectedCatch = false;
  attempt.protectionDismissed = true;
  if (attempt.sessionId === null) return Promise.resolve();
  protectionFor(attempt.folder).ids.delete(attempt.sessionId);
  return savePromises(attempt.folder);
}

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
    held: !!attempt.held,
    tps: typeof attempt.tps === 'number' ? attempt.tps : null,
    ttft: typeof attempt.ttft === 'number' ? attempt.ttft : null,
    protected: settled(attempt),
    kept: settled(attempt) || attempt.verdict === 'rollout',
    title: attempt.title ?? null,
  };
}

/**
 * What DSH Desktop will do with a finished turn right now. `registered` is
 * false on a web-only harness, where the namespace nobody registered cannot
 * be read or written and the whole question is moot.
 */
function notificationState() {
  let value;
  try { value = host?.get('settings')?.get(DESKTOP_NOTIFICATIONS_NS); } catch (e) {}
  if (value === undefined || value === null || typeof value !== 'object') {
    return { registered: false, enabled: false, onTurnCompletion: false };
  }
  return {
    registered: true,
    enabled: value.enabled !== false,
    onTurnCompletion: value.notifyOnTurnCompletion !== false,
  };
}

/** The console's "turn them off" button. */
function muteNotifications(ctx) {
  const settings = ctx.get('settings');
  if (settings === undefined) throw new Error('设置服务不可用 / settings service unavailable');
  return settings.update(DESKTOP_NOTIFICATIONS_NS, { enabled: false }).then(publicState);
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
    // A session log is never safe to unlink while its create/dispose chain is
    // still live, regardless of whether the conversation is protected.
    blocking: state.attempts.filter(hasOwnedResources).length,
    attempts: state.attempts.map(publicAttempt),
    notifications: notificationState(),
    orphans: state.orphans,
    protectedCount: protectionFor(state.config.folder).ids.size,
    culled: state.culled,
    reaped: state.reaped,
    sessionsRevision: state.sessionsRevision,
  };
}

/* ---------------------------------------------------------------- attempts -- */

/**
 * The probe prompt, marked as plugin-sourced. DSH Desktop notifies only for a
 * turn a person opened: it arms on a `user/message` whose `source.kind` is
 * `user` and fires on the matching `turn/end`. The role stays `user` and
 * `followup` never reads the source, so the turn and the request are
 * unchanged — the prompt just is not mistaken for typing.
 */
function probeMessage(text) {
  return Object.freeze({
    id: crypto.randomUUID(),
    role: 'user',
    content: Object.freeze([Object.freeze({ type: 'text', text })]),
    source: Object.freeze({ kind: 'plugin', plugin: PLUGIN_SOURCE }),
  });
}

// A plugin-sourced prompt bypasses the automatic titler — which also saves it
// a small-model call per session — so the plugin names probes itself. A catch
// is renamed again on the way out: it is the one conversation the user has to
// be able to pick out of a sidebar full of probes, so it leads with a mark and
// carries its score.
const TITLES = {
  en: {
    probe: (n) => `Rollout probe ${n}`,
    catch: (n, pct) => `★ Rollout catch ${n} · ${pct}%`,
  },
  zh: {
    probe: (n) => `灰度探测 ${n}`,
    catch: (n, pct) => `★ 灰度命中 ${n} · ${pct}%`,
  },
};

/**
 * `sessionTitle.rename` needs the live session object and pins the title
 * against later automatic generation. Throws for a session the store no
 * longer holds, which is every probe from before a reload — so the explicit
 * rename action reports that rather than swallowing it.
 */
function renameSession(ctx, sessionId, title) {
  const session = ctx.sessions?.get(sessionId);
  if (session === undefined) throw new Error('会话已不在内存中 / session is no longer live');
  const service = ctx.get('sessionTitle');
  if (service === undefined) throw new Error('标题服务不可用 / session title service unavailable');
  service.rename(session, title);
}

function titleAttempt(ctx, attempt, stage) {
  const strings = TITLES[attempt.config.locale] ?? TITLES.en;
  const title = stage === 'catch'
    ? strings.catch(attempt.id, Math.round(attempt.score * 100))
    : strings.probe(attempt.id);
  try { renameSession(ctx, attempt.sessionId, title); } catch (e) {}
}

function isLive(attempt) {
  return hasOwnedResources(attempt) || (!attempt.closed && (attempt.status === 'starting'
    || attempt.status === 'streaming'
    || attempt.status === 'kept-streaming'
    || attempt.status === 'pending-discard'
    || attempt.status === 'discarding'));
}

/** True until agent creation and teardown have both crossed their boundary. */
function hasOwnedResources(attempt) {
  // A rejected disposer leaves liveness uncertain. Fail closed: never unlink
  // that log or start a replacement as though the slot were safely gone.
  return !!attempt.launching || attempt.handle !== null || !!attempt.disposing
    || attempt.cleanupError !== null;
}

/**
 * Every live turn consumes a real provider slot. A promising verdict changes
 * retention, not concurrency; excluding catches here allowed the loop to grow
 * past its configured concurrency without bound.
 */
function activeCount() {
  let n = 0;
  for (const a of state.attempts) {
    if (isLive(a)) n += 1;
  }
  return n;
}

/** Never evict a live or protected card; doing so loses its lifecycle handle. */
function trimHistory() {
  let closedOrdinary = 0;
  const retained = [];
  for (const attempt of state.attempts) {
    const terminal = attempt.status === 'discarded' || attempt.status === 'finished'
      || attempt.status === 'stopped' || attempt.status === 'error';
    if (attempt.closed && terminal && !attempt.held && !hasOwnedResources(attempt)
        && deletable(attempt)) {
      closedOrdinary += 1;
      if (closedOrdinary > HISTORY_LIMIT) {
        clearFade(attempt);
        clearWatchdog(attempt);
        clearCancelTimer(attempt);
        continue;
      }
    }
    retained.push(attempt);
  }
  state.attempts = retained;
}

/** Keep the concurrency slots full for as long as the run is active. */
function pump(ctx) {
  if (!state.running) return;
  while (state.running && activeCount() < state.config.concurrency) {
    state.launched += 1;
    state.sequence += 1;
    const attempt = {
      id: state.sequence,
      runId: state.runId,
      config: Object.freeze({ ...state.config }),
      folder: folderKey(state.config.folder),
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
      promptSentAt: null,
      firstChunkAt: null,
      chunkCount: 0,
      tps: null,
      ttft: null,
      endedAt: null,
      deleted: false,
      error: null,
      handle: null,
      launching: true,
      launchTask: null,
      launchController: new AbortController(),
      disposing: false,
      disposal: null,
      cleanupError: null,
      decided: false,
      closed: false,
      streamed: false,
      watchdog: null,
      cancelTimer: null,
      pauses: 0,
      lastChunkAt: null,
      burstChars: 0,
      held: false,
      holdLeases: new Set(),
      releasedHolds: new Set(),
      fadeTimer: null,
      protectedCatch: false,
      protectionDismissed: false,
    };
    state.attempts.unshift(attempt);
    trimHistory();
    const task = launch(ctx, attempt).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      if (!attempt.forced) attempt.error = message;
      // Only a launch that never reached 'streaming' counts towards the
      // breaker: a failure after the turn started is the probe's problem,
      // not a sign that launching itself is broken.
      if (!attempt.streamed && !attempt.forced) {
        state.launchFailures += 1;
        if (state.launchFailures >= LAUNCH_FAILURE_LIMIT) {
          state.running = false;
          state.paused = true;
          state.note = 'launch-failed';
          state.lastError = message;
        }
      }
      finish(ctx, attempt);
    }).finally(() => {
      attempt.launching = false;
      maybeQuiesced(attempt);
      // A pre-stream failure was still counted as launching when finish()
      // ran. Revisit the pump after crossing that boundary, especially at
      // concurrency 1 where no sibling failure exists to do it for us.
      settle(ctx);
    });
    attempt.launchTask = task;
  }
}

async function launch(ctx, attempt) {
  const config = attempt.config;
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
    signal: attempt.launchController.signal,
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
  if (attempt.protectedCatch) {
    protectionFor(attempt.folder).ids.add(sessionId);
    savePromises(attempt.folder).catch((error) => {
      attempt.error = error instanceof Error ? error.message : String(error);
    });
  }
  // A stop/unload that landed while the agent was being created: never prompt.
  if (attempt.forced || attempt.closed || attempt.launchController.signal.aborted) {
    beginDispose(attempt, true);
    return;
  }
  try { await workspace.attachSession(sessionId); } catch (e) {}

  // Attaching is asynchronous too; cancellation may have landed while it was
  // in progress. Do not cross the prompt boundary afterwards.
  if (attempt.forced || attempt.closed || attempt.launchController.signal.aborted) {
    beginDispose(attempt, true);
    return;
  }

  attempt.status = 'streaming';
  attempt.streamed = true;
  // One probe that got as far as its first turn clears the breaker.
  state.launchFailures = 0;
  titleAttempt(ctx, attempt, 'probe');
  attempt.promptSentAt = Date.now();
  armWatchdog(ctx, attempt);
  handle.agent.followup(probeMessage(config.prompt));
}

function onSessionEvent(ctx, attempt, event) {
  if (attempt.closed) return;
  if (event.type === 'assistant/chunk') {
    const chunk = event.data.chunk;
    if (chunk.type === 'reasoning-delta') {
      const now = Date.now();
      const text = chunk.text || '';
      if (attempt.firstChunkAt === null) {
        attempt.firstChunkAt = now;
        if (attempt.promptSentAt !== null) {
          attempt.ttft = Math.round((now - attempt.promptSentAt) / 100) / 10;
        }
      }
      attempt.chunkCount = (attempt.chunkCount || 0) + 1;
      const elapsedSec = (now - attempt.firstChunkAt) / 1000;
      if (attempt.chunkCount >= 8 && elapsedSec >= 0.4) {
        attempt.tps = Math.round((attempt.chunkCount / elapsedSec) * 10) / 10;
      }
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

/**
 * The agent handle's disposer is the exact Cordis effect disposer, and those
 * are single-shot: a repeat call returns undefined instead of a promise, so it
 * cannot be chained onto. The owner fiber can also have triggered it already.
 */
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

function clearCancelTimer(attempt) {
  if (attempt.cancelTimer) {
    clearTimeout(attempt.cancelTimer);
    attempt.cancelTimer = null;
  }
}

/**
 * Take the handle exactly once and track its asynchronous drain. Destructive
 * operations wait on this promise before touching the session log.
 */
function beginDispose(attempt, cancel) {
  if (cancel) {
    attempt.forced = true;
    try { attempt.launchController?.abort(new Error('probe stopped')); } catch (e) {}
  }
  const handle = attempt.handle;
  if (handle === null) return attempt.disposal ?? Promise.resolve();
  attempt.handle = null;
  if (cancel) {
    try { handle.agent.cancel({ kind: 'user' }, { keepInbox: false }); } catch (e) {}
  }
  attempt.disposing = true;
  let disposed;
  try {
    disposed = handle.dispose();
  } catch (error) {
    disposed = Promise.reject(error);
  }
  const task = Promise.resolve(disposed).catch((error) => {
    attempt.cleanupError = error instanceof Error ? error.message : String(error);
  }).finally(() => {
    attempt.disposing = false;
    maybeQuiesced(attempt);
  });
  attempt.disposal = task;
  return task;
}

function maybeQuiesced(attempt) {
  if (hasOwnedResources(attempt)) return;
  if (attempt.status === 'stopping') attempt.status = 'stopped';
  trimHistory();
  // finish() deliberately keeps a draining disposer inside the concurrency
  // count. Refill only after that disposer crosses its boundary.
  if (host !== null) settle(host);
}

/** Wait until no create/dispose chain can still write this attempt's log. */
async function awaitQuiescence(attempt, cancel) {
  if (cancel) beginDispose(attempt, true);
  if (attempt.launchTask !== null) await attempt.launchTask;
  if (attempt.handle !== null) beginDispose(attempt, cancel);
  if (attempt.disposal !== null) await attempt.disposal;
  if (hasOwnedResources(attempt)) throw new Error('探测仍在释放资源 / probe resources are still draining');
  if (attempt.cleanupError !== null) throw new Error(attempt.cleanupError);
}

function watchdogExpired(ctx, attempt) {
  attempt.watchdog = null;
  if (attempt.closed || settled(attempt)) return;
  attempt.error = 'watchdog timeout';
  attempt.status = 'stopping';
  try { attempt.handle?.agent.cancel({ kind: 'user' }, { keepInbox: false }); } catch (e) {}
  clearCancelTimer(attempt);
  attempt.cancelTimer = setTimeout(() => {
    attempt.cancelTimer = null;
    if (!attempt.closed) finish(ctx, attempt);
  }, DISCARD_GRACE_MS);
}

/** Arm against the original prompt time so Keep/Unkeep cannot extend a run. */
function armWatchdog(ctx, attempt) {
  clearWatchdog(attempt);
  if (attempt.closed || settled(attempt) || attempt.promptSentAt === null) return;
  const remaining = Math.max(0, WATCHDOG_MS - (Date.now() - attempt.promptSentAt));
  attempt.watchdog = setTimeout(() => watchdogExpired(ctx, attempt), remaining);
}

/** How long a cancelled probe is given to deliver its `turn/end`. */
const DISCARD_GRACE_MS = 10_000;

function commitDiscard(ctx, attempt) {
  clearFade(attempt);
  if (settled(attempt)) return;
  attempt.decided = true;
  attempt.verdict = 'old';
  if (attempt.closed) {
    attempt.status = 'discarded';
    attempt.endedAt = attempt.endedAt ?? Date.now();
    if (attempt.config.autoDelete) {
      deleteAttempt(ctx, attempt).catch((error) => {
        attempt.error = error instanceof Error ? error.message : String(error);
      });
    }
    settle(ctx);
    return;
  }
  attempt.status = 'discarding';
  try { attempt.handle?.agent.cancel({ kind: 'user' }, { keepInbox: false }); } catch (e) {}
  // The long watchdog is pointless now — the turn is already cancelled. Swap
  // it for a short reaper so a cancel that never produces `turn/end` cannot
  // strand the attempt in 'discarding' with its agent handle still open.
  clearWatchdog(attempt);
  clearCancelTimer(attempt);
  attempt.cancelTimer = setTimeout(() => {
    attempt.cancelTimer = null;
    if (!attempt.closed) finish(ctx, attempt);
  }, DISCARD_GRACE_MS);
}

/** Start the fade. The turn keeps running until the animation ends. */
function offerFade(ctx, attempt, reason) {
  if (attempt.held || settled(attempt)) return;
  if (attempt.status === 'pending-discard' || attempt.status === 'discarding') return;
  attempt.decided = true;
  attempt.verdict = 'old';
  attempt.reason = reason;
  attempt.status = 'pending-discard';
  clearFade(attempt);
  attempt.fadeTimer = setTimeout(() => {
    attempt.fadeTimer = null;
    if (attempt.held || settled(attempt)) return;
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
  if (attempt.config.autoPauseOnMatch && attempt.runId === state.runId) {
    state.running = false;
    state.paused = true;
    state.note = 'hit';
  }
}

function retractKeep(ctx, attempt, reason) {
  if (attempt.held || settled(attempt)) return;
  const pausedForHit = state.paused && state.note === 'hit';
  offerFade(ctx, attempt, reason);
  if (pausedForHit && !state.attempts.some(
    (a) => a.runId === attempt.runId && a.verdict === 'rollout')) {
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

/**
 * The user taking a conversation out of this plugin's reach for good. Unlike
 * a pin — which is a hover-scale rescue that a later verdict can still walk
 * back — this is durable, survives a plugin reload, and is cleared only by
 * `unprotect`.
 */
async function protectAttempt(id) {
  const attempt = findAttempt(id);
  clearFade(attempt);
  await markProtected(attempt);
  // Once cancellation was sent it cannot be undone. Protection still keeps
  // the conversation on disk, but the cancel reaper must be allowed to close
  // the handle. Before that boundary, protection can safely rescue the fade.
  if (attempt.status === 'pending-discard') {
    attempt.status = attempt.closed ? 'pinned' : 'streaming';
  }
  if (attempt.status !== 'discarding' && attempt.status !== 'stopping') clearWatchdog(attempt);
  return publicState();
}

/** Name a catch yourself. Keeping it is implied — naming it means you want it. */
async function renameAttempt(ctx, id, title) {
  const attempt = findAttempt(id);
  const text = typeof title === 'string' ? title.trim() : '';
  if (text === '') throw new TypeError('标题不能为空 / title must not be empty');
  if (attempt.sessionId === null) throw new Error('该探测还没有会话 / probe has no session yet');
  let resumed = null;
  try {
    if (ctx.sessions?.get(attempt.sessionId) === undefined) {
      if (typeof ctx.agents?.resume !== 'function') {
        throw new Error('会话已不在内存中 / session is no longer live');
      }
      resumed = await ctx.agents.resume({
        resumeSessionId: attempt.sessionId,
        agentOptions: {
          provider: attempt.config.provider,
          model: attempt.config.model,
        },
      });
    }
    renameSession(ctx, attempt.sessionId, text);
    attempt.title = text;
    await markProtected(attempt);
  } finally {
    if (resumed !== null) {
      try { await Promise.resolve(resumed.dispose()); } catch (e) {}
    }
  }
  return publicState();
}

/** Hand a kept conversation back to the ordinary rules. */
async function unprotectAttempt(ctx, id) {
  const attempt = findAttempt(id);
  await unmarkProtected(attempt);
  if (attempt.closed) {
    if (attempt.decided && attempt.verdict === 'old') commitDiscard(ctx, attempt);
  } else if (attempt.status !== 'discarding' && attempt.status !== 'stopping') {
    armWatchdog(ctx, attempt);
    if (attempt.decided && attempt.verdict === 'old') offerFade(ctx, attempt, attempt.reason);
  }
  return publicState();
}

/**
 * Mouse entered: a fading card is rescued for exactly as long as the pointer
 * stays on it. The hold is a loan — release re-offers the fade — so a mouse
 * crossing the list can never keep anything alive. Durable protection has
 * one entry: the Keep button.
 */
function holdAttempt(id, lease) {
  const attempt = state.attempts.find((a) => a.id === Number(id));
  // Clear/delete can remove a card while React is unmounting it. Gesture
  // cleanup is deliberately idempotent and never becomes a red UI error.
  if (attempt === undefined) return publicState();
  const token = typeof lease === 'string' && lease.length <= 160 ? lease : 'legacy';
  // A release may beat its hold over two HTTP requests. The tombstone makes
  // that order converge to released rather than leaving an immortal hold.
  if (attempt.releasedHolds.has(token)) {
    attempt.releasedHolds.delete(token);
    return publicState();
  }
  attempt.holdLeases.add(token);
  attempt.held = attempt.holdLeases.size > 0;
  if (attempt.status === 'pending-discard' && !attempt.closed) {
    clearFade(attempt);
    attempt.status = 'streaming';
  }
  return publicState();
}

/** Mouse left: give back what the hover borrowed. */
function releaseAttempt(ctx, id, lease) {
  const attempt = state.attempts.find((a) => a.id === Number(id));
  if (attempt === undefined) return publicState();
  const token = typeof lease === 'string' && lease.length <= 160 ? lease : 'legacy';
  if (!attempt.holdLeases.delete(token)) attempt.releasedHolds.add(token);
  attempt.held = attempt.holdLeases.size > 0;
  if (attempt.held) return publicState();
  if (attempt.closed) {
    // A turn can finish while hover has temporarily changed pending-discard
    // back to streaming. The loan is still returned when the pointer leaves.
    if (attempt.decided && attempt.verdict === 'old' && deletable(attempt)) {
      commitDiscard(ctx, attempt);
    }
    return publicState();
  }
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
function wantsDiscard(attempt, result, customConfig) {
  const config = customConfig ?? attempt.config ?? state.config;
  if (config.discardChinese && chineseShare(attempt.reasoning) >= config.chineseShare) {
    return 'chinese';
  }
  if (config.discardBelowTtft && typeof attempt.ttft === 'number' && attempt.ttft < config.minTtft) {
    return 'ttft_fast';
  }
  if (config.discardAboveTps && typeof attempt.tps === 'number' && attempt.tps > config.maxTps) {
    return 'tps';
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

  if (attempt.held || settled(attempt)) return;

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
  if (openings >= attempt.config.minOpenings && attempt.score >= attempt.config.keepAbove) {
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
  if (attempt.closed) return attempt.disposal ?? Promise.resolve();
  attempt.closed = true;
  attempt.endedAt = Date.now();
  clearWatchdog(attempt);
  clearCancelTimer(attempt);
  if (!attempt.forced) {
    evaluate(ctx, attempt, true);
  }
  if (attempt.status === 'pending-discard') {
    if (attempt.forced) {
      clearFade(attempt);
      attempt.status = 'discarded';
    }
  } else if (settled(attempt) && attempt.verdict !== 'rollout') {
    attempt.status = 'pinned';
  } else if (!attempt.decided) {
    if (attempt.forced || attempt.error) {
      attempt.verdict = 'unknown';
    } else {
      const openings = attempt.positive + attempt.negative;
      if (openings >= attempt.config.minOpenings && attempt.score >= attempt.config.keepAbove) {
        attempt.verdict = 'rollout';
        attempt.reason = 'score';
      } else if (attempt.held) {
        attempt.verdict = 'old';
        attempt.reason = attempt.positive === 0 ? 'window' : 'ended';
      } else {
        offerFade(ctx, attempt, attempt.positive === 0 ? 'window' : 'ended');
      }
    }
  }

  if (attempt.status === 'pending-discard') {
    // The closed card owns only its fade now; the agent handle is released
    // below and release/timeout will commit the disk outcome later.
  } else if (attempt.verdict === 'rollout') {
    attempt.status = 'kept';
    if (!attempt.protectionDismissed) {
      markProtected(attempt).catch((error) => {
        attempt.error = error instanceof Error ? error.message : String(error);
      });
    }
    titleAttempt(ctx, attempt, 'catch');
    if (attempt.config.autoPauseOnMatch && attempt.runId === state.runId) {
      state.running = false;
      state.paused = true;
      state.note = 'hit';
    }
  } else if (attempt.verdict === 'old' && !settled(attempt) && !attempt.held) {
    attempt.status = 'discarded';
    if (attempt.config.autoDelete) {
      deleteAttempt(ctx, attempt).catch((error) => {
        attempt.error = error instanceof Error ? error.message : String(error);
      });
    }
  } else {
    attempt.status = attempt.error ? 'error' : (attempt.forced ? 'stopped' : (settled(attempt) ? 'pinned' : 'finished'));
  }
  const disposal = beginDispose(attempt, false);
  if (attempt.forced && hasOwnedResources(attempt)) attempt.status = 'stopping';
  settle(ctx);
  return disposal;
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
async function removeSessionLog(ctx, sessionId, headers, cwd) {
  // The listing is a convenience, not a requirement: `locate` is a pure path
  // computation over `{ id, cwd }`. Depending on it alone left behind the log
  // of any session it had not caught up with — and a log whose workspace slot
  // is gone is an ungrouped sidebar row with no Delete in its menu.
  const header = headers.find((h) => h.id === sessionId)
    ?? (cwd === undefined ? undefined : { id: sessionId, cwd });
  if (header === undefined) throw new Error(`找不到会话记录 ${sessionId} / session record not found`);
  let location;
  try { location = ctx.sessionPersistence.locate(header); } catch (error) {
    throw new Error(`无法定位会话 ${sessionId} / cannot locate session`, { cause: error });
  }
  if (location === undefined || typeof location.path !== 'string') {
    throw new Error(`无法定位会话 ${sessionId} / cannot locate session`);
  }
  const dir = path.dirname(location.path);
  if (path.basename(dir) === sessionId) {
    await fs.rm(dir, { recursive: true, force: true });
  } else {
    await fs.rm(location.path, { force: true });
  }
}

/**
 * An orphan has no disposer capability, but the live agent still exposes its
 * cancellation boundary. Wait for it to become idle before unlinking a log it
 * may be flushing. A cancellation that cannot prove quiescence fails closed.
 */
async function quiesceUnownedAgent(agent, sessionId) {
  if (agent === undefined) return;
  try {
    agent.cancel({ kind: 'user' }, { keepInbox: false });
  } catch (error) {
    throw new Error(`无法中止会话 ${sessionId} / cannot cancel session`, { cause: error });
  }
  if (typeof agent.whenIdle === 'function') {
    await agent.whenIdle();
    return;
  }
  if (agent.status === 'running') {
    throw new Error(`会话 ${sessionId} 仍在写入 / session is still writing`);
  }
}

/** Remove a discarded probe entirely: live agent, workspace slot, on-disk log. */
async function deleteAttempt(ctx, attempt) {
  const sessionId = attempt.sessionId;
  if (sessionId === null) return;
  await awaitQuiescence(attempt, false);
  const workspace = ctx.workspaceRegistry.list().find((w) => w.sessionIds.includes(sessionId));
  let headers = [];
  try { headers = await ctx.sessionPersistence.list(); } catch (e) {}
  await removeSessionLog(ctx, sessionId, headers, attempt.folder);
  try { await workspace?.detachSession(sessionId); } catch (e) {}
  attempt.deleted = true;
  state.sessionsRevision += 1;
}

/**
 * Run the labelled corpus through the shipped decision path under a given
 * config. The detector is otherwise unfalsifiable from the console: every
 * probe so far has been discarded, and nothing on screen separates "this
 * account is on the old model" from "a threshold or a regex is broken and
 * nothing could ever be kept". This answers that in one line, for free, and
 * re-answers it whenever a threshold is edited.
 *
 * It calls `classify` and `wantsDiscard` — the same functions a live probe
 * goes through — rather than reimplementing the ladder, so a change to either
 * shows up here immediately.
 */
function selfCheck(rawConfig) {
  const config = sanitizeConfig({ ...rawConfig, prompt: 'x' });
  const results = FIXTURES.map((fixture) => {
    const result = classify(fixture.text, true);
    const attempt = {
      reasoning: fixture.text,
      score: result.score,
      pauses: 0,
      tps: null,
      ttft: null,
    };
    attempt.score = blendedScore(result, attempt);
    const reject = wantsDiscard(attempt, result, config);
    const openings = result.positive + result.negative;
    const verdict = reject !== null ? 'old'
      : result.decisive === 'new' ? 'rollout'
      : openings >= config.minOpenings && attempt.score >= config.keepAbove ? 'rollout'
      : 'old';
    return {
      id: fixture.id,
      title: fixture.title,
      label: fixture.label,
      verdict,
      agrees: verdict === fixture.label,
      score: Math.round(attempt.score * 100),
      reason: reject ?? (verdict === 'rollout' ? (result.decisive === 'new' ? 'decisive' : 'score') : 'ended'),
    };
  });
  const rollout = results.filter((r) => r.label === 'rollout');
  return {
    total: results.length,
    agreed: results.filter((r) => r.agrees).length,
    rolloutTotal: rollout.length,
    rolloutKept: rollout.filter((r) => r.verdict === 'rollout').length,
    results,
  };
}

/* -------------------------------------------------------------- operations -- */

async function start(ctx, rawConfig) {
  if (state.running) throw new Error('已在运行 / already running');
  if (state.paused) throw new Error('探测已暂停，请继续或强制停止 / run is paused — resume or force stop it');
  if (state.attempts.some(hasOwnedResources)) {
    throw new Error('上一轮仍在释放资源 / previous run is still draining');
  }
  const config = sanitizeConfig(rawConfig);
  if (config.prompt.trim() === '') {
    throw new TypeError('请先填写探测提示词 / enter a probe prompt first');
  }
  // Protection must be loaded before any run or sweep can act in this folder.
  protectionReady = loadPromises(config.folder);
  await protectionReady;
  state.config = config;
  state.orphans = { live: 0, cold: 0, at: 0 };
  state.running = true;
  state.paused = false;
  state.runId += 1;
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

/**
 * Stop launching. Probes we are still unsure about run on to their own
 * verdicts — that is the whole reason pause is not force-stop — but a probe
 * already judged as the old model is cancelled here and now.
 *
 * Leaving those running was the expensive half of the old behaviour: pausing
 * is the user saying "stop spending", and a probe whose verdict is settled
 * has nothing left to tell us, so every token it draws afterwards is waste.
 * A fading card is committed immediately rather than being given the rest of
 * its animation, and a protected catch is never touched.
 */
function pause(ctx) {
  if (!state.running && !state.paused) return publicState();
  state.running = false;
  state.paused = true;
  state.note = 'paused';
  const done = state.attempts.filter(deletable).filter(isLive).filter(
    (a) => (a.decided && a.verdict === 'old') || a.status === 'pending-discard');
  for (const attempt of done) {
    attempt.reason = attempt.reason ?? 'paused';
    commitDiscard(ctx, attempt);
  }
  state.culled = done.length;
  if (done.length > 0) state.note = 'paused-culled';
  return publicState();
}

/** Resume launching under the config the run started with. */
function resume(ctx) {
  if (state.running) return publicState();
  if (!state.paused) throw new Error('没有可继续的暂停任务 / no paused run to resume');
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
  // Stopping spend and retaining data are independent. Even a protected
  // conversation is cancellable; its log and protection promise survive.
  for (const attempt of state.attempts.filter(isLive)) {
    clearFade(attempt);
    attempt.forced = true;
    try { attempt.launchController?.abort(new Error('force stop')); } catch (e) {}
    try { attempt.handle?.agent.cancel({ kind: 'user' }, { keepInbox: false }); } catch (e) {}
    finish(ctx, attempt);
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
    if (isLive(attempt) || !deletable(attempt)) {
      retained.push(attempt);
    } else {
      dropped.push(attempt);
    }
  }
  let failure = null;
  for (const attempt of dropped) {
    try {
      await deleteAttempt(ctx, attempt);
    } catch (error) {
      attempt.error = error instanceof Error ? error.message : String(error);
      retained.push(attempt);
      failure = failure ?? attempt.error;
    }
  }
  state.attempts = retained.sort((a, b) => b.id - a.id);
  if (state.attempts.length === 0) state.sequence = 0;
  if (failure !== null) throw new Error(failure);
  return publicState();
}

/**
 * Every probe conversation in the folder, from the three places one can hide:
 * a workspace slot (survives a `clear`), the live session store (survives a
 * plugin reload, since agents are owned by the harness), and the persistence
 * listing (survives both). Sessions are matched on their recorded `cwd` —
 * matching on log path finds nothing, because logs live under the harness
 * state directory rather than under the workspace.
 */
function probeSessionIds(ctx, folderNorm, headers, workspace) {
  const roots = new Set([folderNorm]);
  if (workspace !== undefined) {
    try { roots.add(path.resolve(workspace.path)); } catch (e) {}
  }
  const matches = (cwd) => {
    if (typeof cwd !== 'string') return false;
    try { return roots.has(path.resolve(cwd)); } catch (e) { return false; }
  };
  const ids = new Set();
  for (const id of workspace?.sessionIds ?? []) ids.add(id);
  for (const attempt of state.attempts) {
    if (attempt.folder === folderNorm && attempt.sessionId) ids.add(attempt.sessionId);
  }
  try {
    for (const session of ctx.sessions?.list() ?? []) {
      if (matches(session.header?.cwd)) ids.add(session.id);
    }
  } catch (e) {}
  for (const header of headers) {
    if (matches(header.cwd)) ids.add(header.id);
  }
  for (const id of keptIds(folderNorm)) ids.delete(id);
  return ids;
}

/** The probe folder's workspace, when the registry has one. */
function probeWorkspace(ctx, folderNorm) {
  return ctx.workspaceRegistry.list().find((w) => {
    try { return path.resolve(w.path) === folderNorm; } catch (e) { return false; }
  });
}

// A count walks the persistence listing, which stats every session directory
// the harness holds, so it is rate-limited well below the console's poll.
const ORPHAN_RECOUNT_MS = 10_000;

/**
 * Probe conversations in the folder this plugin is not tracking — what the
 * user sees as "I stopped and deleted everything and the sidebar is still
 * full". A session with no card is one no console button can reach, and the
 * shell's own menu offers Archive but not Delete.
 */
async function orphans(ctx, folder = state.config.folder) {
  const folderNorm = path.resolve(folder);
  const known = new Set();
  for (const attempt of state.attempts) {
    if (attempt.folder === folderNorm && attempt.sessionId) known.add(attempt.sessionId);
  }
  let headers = [];
  try { headers = await ctx.sessionPersistence.list(); } catch (e) {}
  const workspace = probeWorkspace(ctx, folderNorm);
  const ids = [...probeSessionIds(ctx, folderNorm, headers, workspace)]
    .filter((id) => !known.has(id));
  return { ids, headers, workspace };
}

async function countOrphans(ctx, force) {
  if (!force && Date.now() - state.orphans.at < ORPHAN_RECOUNT_MS) return state.orphans;
  const folder = folderKey(state.config.folder);
  const { ids } = await orphans(ctx, folder);
  let live = 0;
  for (const id of ids) {
    if (ctx.sessions?.get(id) !== undefined) live += 1;
  }
  if (folder !== folderKey(state.config.folder)) return state.orphans;
  state.orphans = { live, cold: ids.length - live, at: Date.now() };
  return state.orphans;
}

/**
 * Cancel the turn of anything still live so it stops drawing tokens, drop the
 * workspace slot, unlink the log. A live orphan's agent belongs to the
 * harness, not to this plugin — the handle that could dispose it died with
 * the plugin instance that made it — so the session object survives in the
 * store until the app restarts. Cancelling is the part that matters.
 */
async function reapOrphans(ctx) {
  if (state.running) throw new Error('运行中不能清理 / cannot sweep while running');
  const { ids, headers, workspace } = await orphans(ctx);
  let failure = null;
  let reaped = 0;
  for (const id of ids) {
    try {
      await quiesceUnownedAgent(ctx.agents?.get?.(id), id);
      await removeSessionLog(ctx, id, headers, state.config.folder);
      try { await workspace?.detachSession(id); } catch (e) {}
      state.sessionsRevision += 1;
      reaped += 1;
    } catch (error) {
      failure = failure ?? (error instanceof Error ? error.message : String(error));
    }
  }
  state.note = 'reaped';
  state.reaped = reaped;
  await countOrphans(ctx, true);
  if (failure !== null) throw new Error(failure);
  return publicState();
}

/**
 * Delete every probe conversation on disk — including ones already
 * dropped from the in-memory list by a previous clear — and reset
 * numbering so the next run starts at probe 1.
 */
async function deleteAll(ctx) {
  if (state.running) throw new Error('运行中不能删除 / cannot delete while running');
  // Deleting a session log out from under a live turn corrupts it and leaves
  // an agent writing to a directory that is gone. Protection changes which
  // logs are retained, but every owned agent must finish draining first.
  const folderNorm = path.resolve(state.config.folder);
  if (state.attempts.some((a) => a.folder === folderNorm && isLive(a))) {
    throw new Error('仍有探测在进行中，请先强制停止 / probes are still live — force stop first');
  }
  const targets = state.attempts.filter((a) => a.folder === folderNorm && deletable(a));
  for (const attempt of targets) {
    clearFade(attempt);
    clearWatchdog(attempt);
    clearCancelTimer(attempt);
    await awaitQuiescence(attempt, false);
  }

  const workspace = probeWorkspace(ctx, folderNorm);
  let headers = [];
  try { headers = await ctx.sessionPersistence.list(); } catch (e) {}
  const ids = probeSessionIds(ctx, folderNorm, headers, workspace);
  // One session failing to unlink must not strand the rest: keep going and
  // report afterwards, once the list has already been reset.
  let failure = null;
  const removed = new Set();
  for (const sessionId of ids) {
    // Anything still live here is an orphan from an earlier plugin instance
    // — this run's own probes were required to be finished before we got
    // this far. Cancel it so the log stops being written to before it goes.
    try {
      await quiesceUnownedAgent(ctx.agents?.get?.(sessionId), sessionId);
      await removeSessionLog(ctx, sessionId, headers, state.config.folder);
      try { await workspace?.detachSession(sessionId); } catch (e) {}
      removed.add(sessionId);
      state.sessionsRevision += 1;
    } catch (error) {
      failure = failure ?? (error instanceof Error ? error.message : String(error));
    }
  }

  // Keep protected, other-folder, and failed cards reachable. Removing a card
  // before its log succeeds is how invisible sidebar ghosts are created.
  state.attempts = state.attempts.filter((attempt) => {
    if (attempt.folder !== folderNorm || !deletable(attempt)) return true;
    if (attempt.sessionId === null) return false;
    if (removed.has(attempt.sessionId)) return false;
    attempt.error = attempt.error ?? 'session deletion did not complete';
    return true;
  });
  if (state.attempts.length === 0) state.sequence = 0;
  state.launched = 0;
  state.paused = false;
  state.note = null;
  state.lastError = null;
  state.launchFailures = 0;
  await countOrphans(ctx, true);
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

// Button requests can overlap (double click, polling UI plus a second window).
// Serialize host mutations so Start cannot enter halfway through Delete and a
// late Clear cannot erase attempts created by a newer run.
let actionTail = Promise.resolve();
let protectionReady = Promise.resolve();

function serializeAction(action) {
  const queued = actionTail.then(action, action);
  actionTail = queued.catch(() => {});
  return queued;
}

async function runAction(ctx, body) {
  // Start validates and loads its selected folder itself, so a corrupt record
  // in an abandoned/default folder cannot prevent switching away from it.
  if (body.action !== 'start' && body.action !== 'self-check'
      && body.action !== 'mute-notifications') await protectionReady;
  switch (body.action) {
    case 'start': return start(ctx, body.config);
    case 'pause': return pause(ctx);
    case 'resume': return resume(ctx);
    case 'force-stop': return forceStop(ctx);
    case 'clear': return clearHistory(ctx);
    case 'delete-all': return deleteAll(ctx);
    case 'hold': return holdAttempt(body.id, body.lease);
    case 'release': return releaseAttempt(ctx, body.id, body.lease);
    case 'protect': return protectAttempt(body.id);
    case 'unprotect': return unprotectAttempt(ctx, body.id);
    case 'rename': return renameAttempt(ctx, body.id, body.title);
    case 'self-check': return selfCheck(body.config);
    case 'reap': return reapOrphans(ctx);
    case 'mute-notifications': return muteNotifications(ctx);
    default: throw new TypeError('未知 action / unknown action');
  }
}

async function handleRoute(ctx, request, response) {
  try {
    if (!sameOrigin(request)) {
      respondJson(response, 403, { error: '跨源请求被拒绝 / cross-origin request refused' });
      return;
    }
    if (request.method === 'GET') {
      // Refreshes for the next poll rather than in-band: the scan stats every
      // session directory the harness has, and a status read must not wait on
      // it or fail with it.
      countOrphans(ctx).catch(() => {});
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
      respondJson(response, 200, await serializeAction(() => runAction(ctx, body)));
      return;
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

/**
 * Probe agents are owned by the harness's agent service, not by this plugin's
 * fiber, so they outlive a reload or an upgrade — which is how a folder ends
 * up full of conversations no console can reach. Tearing every owned live
 * probe down on unload keeps that from happening in the first place; durable
 * protection preserves the log, never the running process.
 */
function releaseOnUnload(ctx) {
  // Close the pump gate before any finish() call frees a slot.
  state.running = false;
  state.paused = false;
  for (const attempt of state.attempts.filter(isLive)) {
    clearFade(attempt);
    clearWatchdog(attempt);
    clearCancelTimer(attempt);
    attempt.forced = true;
    try { attempt.launchController?.abort(new Error('plugin unloaded')); } catch (e) {}
    try { attempt.handle?.agent.cancel({ kind: 'user' }, { keepInbox: false }); } catch (e) {}
    finish(ctx, attempt);
  }
}

function apply(ctx) {
  host = ctx;
  protectionReady = loadPromises(state.config.folder);
  // Keep the original rejecting promise for runAction while preventing an
  // unhandled-rejection report before the first button request arrives.
  protectionReady.catch(() => {});
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: ROLLOUT_SCOUT_PATH,
    handler: (request, response) => handleRoute(ctx, request, response),
  }), 'rollout-scout: HTTP route');
  ctx.effect(() => () => releaseOnUnload(ctx), 'rollout-scout: release probes');
}

// `classify` and `chineseShare` are exported so the classifier can be tested
// directly against recorded chains-of-thought without spending a real probe;
// `sanitizeConfig` so the folder guard can be tested without touching disk;
// `wantsDiscard` so discard rules (TPS, TTFT, etc.) can be tested directly;
// `selfCheck` so the screenshot script reports real numbers rather than
// numbers someone typed into a mock.
export {
  ROLLOUT_SCOUT_PATH, apply, chineseShare, classify, inject, name,
  sanitizeConfig, selfCheck, wantsDiscard,
};
