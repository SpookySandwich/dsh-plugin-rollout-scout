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
import net from 'node:net';
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

// The probe folder is a workspace cwd the user types in, and deletion resolves
// the logs of manifest-owned sessions through it. Root, home and harness-state
// paths remain too broad a boundary for recursive per-session removal, so they
// are refused outright even though cwd no longer establishes ownership.
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
// A pointer event that happened before the visual deadline still needs a few
// milliseconds to cross Electron's fetch/HTTP boundary. The irreversible
// cancel waits for that claim only; the card still finishes fading at FADE_MS.
const HOLD_CLAIM_GRACE_MS = 250;
const HOLD_CLAIM_CLOCK_SKEW_MS = 25;
// A probe that fails before it ever streams frees its slot immediately, so
// pump() launches a replacement that fails the same way. With a provider
// down or the folder unwritable that is an unbounded launch storm, so the
// run halts itself after this many failures with no successful start between.
const LAUNCH_FAILURE_LIMIT = 3;

// The host context, captured by `apply` so read-only lookups (settings, the
// live session store) do not have to be threaded through every operation.
let host = null;

const SESSION_REVISION = Symbol.for('dsh.rollout-scout.sessions-revision.v1');
const sessionRevision = globalThis[SESSION_REVISION] ?? { value: 0 };
globalThis[SESSION_REVISION] = sessionRevision;
const SNAPSHOT_REVISION = Symbol.for('dsh.rollout-scout.snapshot-revision.v1');
const snapshotRevision = globalThis[SNAPSHOT_REVISION] ?? { value: 0 };
globalThis[SNAPSHOT_REVISION] = snapshotRevision;

const state = {
  running: false,
  // Launching stopped but the run is resumable; distinct from never started.
  paused: false,
  config: { ...DEFAULT_CONFIG },
  attempts: [],
  // Probes launched in the current run; reset by start() for the stat.
  launched: 0,
  // Human-facing probe number. Mutation identity is a separate UUID.
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
};

/* ------------------------------------------------------ durable ownership -- */

// A folder is only a place where probes run; it is not proof that every
// conversation using that cwd belongs to this plugin. DSH creates a blank
// workspace placeholder there, and a person can open an ordinary conversation
// there too. The durable manifest is therefore the sole source of destructive
// authority: `owned` records ids generated by Rollout Scout, while `protected`
// is the subset the user asked it never to delete.
//
// The record rides with the probe folder because that is what it describes.
// Repointing the scout leaves the old folder with enough information to clean
// up its own probes after a reload without adopting unrelated conversations.
const STATE_FILE = '.rollout-scout.json';
const STATE_VERSION = 3;

// Ownership belongs to a folder, not whichever plugin instance happens to be
// current. The global registry joins hot-reloaded module instances in one
// process; an exclusive lock file and a fresh disk read extend the same RMW
// boundary across processes. A temporary-file rename remains the commit point.
const MANIFEST_REGISTRY = Symbol.for('dsh.rollout-scout.manifests.v3');
const manifestsByFolder = globalThis[MANIFEST_REGISTRY] ?? new Map();
globalThis[MANIFEST_REGISTRY] = manifestsByFolder;

function folderKey(folder) {
  return path.resolve(folder);
}

function manifestFor(folder) {
  const key = folderKey(folder);
  let record = manifestsByFolder.get(key);
  if (record === undefined) {
    record = {
      key,
      owned: new Set(),
      protected: new Set(),
      deleting: new Set(),
      deleteTasks: new Map(),
      pendingRetention: new Set(),
      loaded: false,
      loading: null,
      mutationTail: Promise.resolve(),
    };
    manifestsByFolder.set(key, record);
  }
  // Be tolerant of a record created by another copy of this same module while
  // a hot reload is crossing its apply/dispose boundary.
  record.deleting ??= new Set();
  record.deleteTasks ??= new Map();
  record.pendingRetention ??= new Set();
  record.mutationTail ??= Promise.resolve();
  return record;
}

function stateFilePath(folder) {
  return path.join(folder, STATE_FILE);
}

function idSet(raw, field) {
  if (!Array.isArray(raw)) {
    throw new Error(`保留记录缺少 ${field} / protection record is missing ${field}`);
  }
  const ids = new Set();
  for (const id of raw) {
    if (typeof id !== 'string' || id === '') {
      throw new Error(`保留记录中的 ${field} 无效 / protection record has an invalid ${field}`);
    }
    ids.add(id);
  }
  return ids;
}

function validateManifest(snapshot) {
  for (const id of snapshot.protected) {
    if (!snapshot.owned.has(id)) {
      throw new Error('保留记录中的 protected 必须属于 owned / protected ids must be owned');
    }
  }
  for (const id of snapshot.deleting) {
    if (!snapshot.owned.has(id)) {
      throw new Error('保留记录中的 deleting 必须属于 owned / deleting ids must be owned');
    }
    if (snapshot.protected.has(id)) {
      throw new Error('保留记录中的 deleting 不能属于 protected / deleting ids cannot be protected');
    }
  }
  return snapshot;
}

function parseManifest(text) {
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new Error('保留记录已损坏，拒绝执行 / protection record is corrupt', { cause: error });
  }
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('保留记录格式未知，拒绝执行 / unknown protection record format');
  }
  if (raw.version === 1) {
    const protectedIds = idSet(raw.protected, 'protected');
    return validateManifest({
      owned: new Set(protectedIds), protected: protectedIds, deleting: new Set(), upgrade: true,
    });
  }
  if (raw.version !== 2 && raw.version !== STATE_VERSION) {
    throw new Error('保留记录格式未知，拒绝执行 / unknown protection record format');
  }
  return validateManifest({
    owned: idSet(raw.owned, 'owned'),
    protected: idSet(raw.protected, 'protected'),
    deleting: raw.version === 2 ? new Set() : idSet(raw.deleting, 'deleting'),
    upgrade: raw.version !== STATE_VERSION,
  });
}

async function readManifestSnapshot(folder) {
  try {
    return parseManifest(await fs.readFile(stateFilePath(folder), 'utf8'));
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return { owned: new Set(), protected: new Set(), deleting: new Set(), upgrade: false };
    }
    // Parser/validator errors are already safe, user-facing manifest errors;
    // filesystem errors carry a code and need the read-context wrapper.
    if (!error?.code) throw error;
    throw new Error('无法读取保留记录 / cannot read protection record', { cause: error });
  }
}

function installManifestSnapshot(record, snapshot) {
  record.owned = snapshot.owned;
  record.protected = snapshot.protected;
  record.deleting = snapshot.deleting;
  record.loaded = true;
  return record;
}

const LOCK_WAIT_MS = 25;
const LOCK_TIMEOUT_MS = 15_000;

function leaseAddress(namespace, key) {
  const digest = crypto.createHash('sha256').update(`${namespace}\0${key}`).digest('hex').slice(0, 32);
  if (process.platform === 'win32') return `\\\\.\\pipe\\dsh-rollout-scout-${namespace}-${digest}`;
  if (process.platform === 'linux') return `\0dsh-rollout-scout-${namespace}-${digest}`;
  // macOS has no abstract Unix sockets. A deterministic high port may
  // over-serialize on a hash collision, which is safe; it can never admit two
  // owners. Separate ranges prevent a delete lease recursing into its own
  // manifest lease.
  const value = Number.parseInt(digest.slice(0, 8), 16);
  const base = namespace === 'manifest' ? 30_000 : 45_000;
  return { host: '127.0.0.1', port: base + (value % 10_000), exclusive: true };
}

/** OS-owned leases disappear on process crash, so stale takeover is unnecessary. */
async function acquireProcessLease(namespace, key) {
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  for (;;) {
    const server = net.createServer();
    server.unref();
    try {
      await new Promise((resolve, reject) => {
        const failed = (error) => { server.off('listening', opened); reject(error); };
        const opened = () => { server.off('error', failed); resolve(); };
        server.once('error', failed);
        server.once('listening', opened);
        server.listen(leaseAddress(namespace, key));
      });
      return () => new Promise((resolve, reject) => {
        server.close((error) => { if (error) reject(error); else resolve(); });
      });
    } catch (error) {
      try { server.close(); } catch (e) {}
      if (error?.code !== 'EADDRINUSE') throw error;
      if (Date.now() >= deadline) {
        throw new Error('保留记录正被另一进程占用 / protection record is leased by another process');
      }
      await new Promise((resolve) => setTimeout(resolve, LOCK_WAIT_MS));
    }
  }
}

function acquireManifestLock(folder) {
  return acquireProcessLease('manifest', folderKey(folder));
}

async function loadManifest(folder) {
  const record = manifestFor(folder);
  if (record.loaded) return record;
  if (record.loading !== null) return record.loading;
  record.loading = (async () => {
    const snapshot = await readManifestSnapshot(record.key);
    installManifestSnapshot(record, snapshot);
    // v1 carried only explicit Keep ids; v2 added ownership. Both migrate
    // conservatively, with no deletion transaction inferred.
    if (snapshot.upgrade) await mutateManifest(record.key, () => {});
    return record;
  })();
  try {
    return await record.loading;
  } finally {
    record.loading = null;
  }
}

/** Atomically commit one folder's ownership/protection transaction. */
function mutateManifest(folder, change) {
  const record = manifestFor(folder);
  const commit = async () => {
    const unlock = await acquireManifestLock(record.key);
    try {
      // Never mutate from a cached Set. An old plugin instance or another
      // process may have committed ownership since our last read.
      const disk = await readManifestSnapshot(record.key);
      const next = validateManifest({
        owned: new Set(disk.owned),
        protected: new Set(disk.protected),
        deleting: new Set(disk.deleting),
      });
      change(next);
      validateManifest(next);
      const body = JSON.stringify({
        version: STATE_VERSION,
        owned: [...next.owned].sort(),
        protected: [...next.protected].sort(),
        deleting: [...next.deleting].sort(),
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
      return installManifestSnapshot(record, next);
    } finally {
      await unlock();
    }
  };
  const queued = record.mutationTail.then(commit, commit);
  record.mutationTail = queued.catch(() => {});
  return queued;
}

/* ------------------------------------------------------------- protection -- */

/** An automatic or manual Keep intent blocks deletion before disk I/O starts. */
function hasRetentionIntent(attempt) {
  return attempt.retention.intent === 'auto' || attempt.retention.intent === 'manual';
}

/**
 * Effective retention is deliberately fail-closed. The user's intent is one
 * authority; the durable manifest is another. Either one vetoes deletion, so
 * a failed manifest write can report an error without turning Keep into an
 * accidental Delete.
 */
function retained(attempt) {
  return hasRetentionIntent(attempt)
    || (attempt.sessionId !== null && manifestFor(attempt.folder).protected.has(attempt.sessionId));
}

/** Retention vetoes deletion; Force Stop remains an independent execution control. */
function deletable(attempt) {
  return !retained(attempt);
}

function retentionError(attempt, error) {
  const message = error instanceof Error ? error.message : String(error);
  attempt.retention.durability = 'failed';
  attempt.retention.error = message;
  return message;
}

function retentionOpenError(attempt) {
  if (attempt.creationAbandoned || attempt.deletion !== 'none') {
    return '会话删除已经开始 / session deletion has already started';
  }
  if (attempt.sessionId === null) {
    if (attempt.execution === 'starting' && attempt.launching && !attempt.creationAbandoned) return null;
    return '该探测没有可保留的会话 / probe has no conversation to keep';
  }
  const record = manifestFor(attempt.folder);
  if (record.deleting.has(attempt.sessionId) || record.deleteTasks.has(attempt.sessionId)) {
    return '会话删除已经开始 / session deletion has already started';
  }
  if (attempt.ownershipTask === null && !attempt.ownershipClaimed) {
    return '会话已不再属于 Rollout Scout / session is no longer owned';
  }
  return null;
}

function assertRetentionOpen(attempt) {
  const error = retentionOpenError(attempt);
  if (error !== null) throw new Error(error);
}

const AUTO_KEEP_RETRY_MS = 12_000;

function clearRetentionRetry(attempt) {
  if (attempt.retentionRetry !== null) {
    clearTimeout(attempt.retentionRetry);
    attempt.retentionRetry = null;
  }
}

function scheduleAutomaticRetentionRetry(ctx, attempt) {
  clearRetentionRetry(attempt);
  if (attempt.retention.intent !== 'auto'
      || attempt.retention.durability !== 'failed'
      || (attempt.retention.operation !== 'protect'
        && attempt.retention.operation !== 'unprotect')) return;
  attempt.retentionRetry = setTimeout(async () => {
    attempt.retentionRetry = null;
    if (attempt.retention.intent !== 'auto'
        || attempt.retention.durability !== 'failed'
        || (attempt.retention.operation !== 'protect'
          && attempt.retention.operation !== 'unprotect')) return;
    const operation = attempt.retention.operation;
    try {
      if (operation === 'protect') await markProtected(attempt, 'auto');
      else {
        await unmarkProtected(attempt);
        reconcileAttempt(ctx, attempt, { immediate: isEnded(attempt) });
      }
    } catch (error) {
      scheduleAutomaticRetentionRetry(ctx, attempt);
    }
  }, AUTO_KEEP_RETRY_MS);
  attempt.retentionRetry?.unref?.();
}

async function markProtected(attempt, requestedIntent = 'manual') {
  assertRetentionOpen(attempt);
  clearRetentionRetry(attempt);
  const revision = ++attempt.retentionRevision;
  // Manual intent outranks the classifier's automatic Keep. Commit it before
  // awaiting anything: every destructive path observes this state.
  if (requestedIntent === 'manual' || attempt.retention.intent !== 'manual') {
    attempt.retention.intent = requestedIntent;
  }
  attempt.retention.durability = 'pending';
  attempt.retention.error = null;
  attempt.retention.operation = 'protect';
  if (attempt.sessionId !== null) {
    manifestFor(attempt.folder).pendingRetention.add(attempt.sessionId);
  }
  clearWatchdog(attempt);
  try {
    if (attempt.sessionId === null) return;
    if (attempt.ownershipTask !== null) await attempt.ownershipTask;
    assertRetentionOpen(attempt);
    await mutateManifest(attempt.folder, (next) => {
      if (!next.owned.has(attempt.sessionId)) {
        throw new Error('会话已不再属于 Rollout Scout / session is no longer owned');
      }
      if (next.deleting.has(attempt.sessionId)) {
        throw new Error('会话删除已经开始 / session deletion has already started');
      }
      next.protected.add(attempt.sessionId);
    });
    attempt.ownershipClaimed = true;
    if (attempt.retentionRevision === revision) {
      attempt.retention.durability = 'durable';
      attempt.retention.error = null;
      attempt.retention.operation = null;
      manifestFor(attempt.folder).pendingRetention.delete(attempt.sessionId);
    }
  } catch (error) {
    if (attempt.retentionRevision === revision) retentionError(attempt, error);
    throw error;
  }
}

async function unmarkProtected(attempt) {
  assertRetentionOpen(attempt);
  clearRetentionRetry(attempt);
  // Removing a promise is the inverse transaction: keep the old intent in
  // force until the manifest confirms removal. A failed Unkeep therefore also
  // fails closed instead of racing cleanup.
  const revision = ++attempt.retentionRevision;
  const previousIntent = hasRetentionIntent(attempt) ? attempt.retention.intent : 'manual';
  attempt.retention.intent = previousIntent;
  attempt.retention.durability = 'pending';
  attempt.retention.error = null;
  attempt.retention.operation = 'unprotect';
  try {
    if (attempt.sessionId !== null) {
      if (attempt.ownershipTask !== null) await attempt.ownershipTask;
      assertRetentionOpen(attempt);
      await mutateManifest(attempt.folder, (next) => {
        next.protected.delete(attempt.sessionId);
      });
    }
    if (attempt.retentionRevision === revision) {
      attempt.retention.intent = 'dismissed';
      attempt.retention.durability = 'none';
      attempt.retention.error = null;
      attempt.retention.operation = null;
      if (attempt.sessionId !== null) {
        manifestFor(attempt.folder).pendingRetention.delete(attempt.sessionId);
      }
    }
  } catch (error) {
    if (attempt.retentionRevision === revision) {
      attempt.retention.intent = previousIntent;
      retentionError(attempt, error);
    }
    throw error;
  }
}

/* ------------------------------------------------------- attempt state model -- */

// Attempt state has five independent axes. None is allowed to masquerade as
// another one:
//   execution  — whether provider/agent work can still be happening
//   verdict    — what the classifier concluded
//   discard    — whether cleanup was offered or irreversibly committed
//   retention  — Keep intent and its persistence phase
//   deletion   — whether physical cleanup has started or completed
// Temporary review leases guard the discard boundary without changing any of
// those axes. They expire and can never become durable retention.
// `status` is intentionally absent from the stored aggregate. It is a pure UI
// projection below, so a hover can never rewrite execution or classification.
const EXECUTION_PHASES = new Set(['starting', 'running', 'cancelling', 'ended']);
const DISCARD_PHASES = new Set(['none', 'offered', 'committed']);
const DELETION_PHASES = new Set(['none', 'deleting', 'deleted', 'failed']);
const VERDICTS = new Set([null, 'old', 'rollout', 'unknown']);
const RETENTION_INTENTS = new Set(['none', 'auto', 'manual', 'dismissed']);
const RETENTION_DURABILITY = new Set(['none', 'pending', 'durable', 'failed']);
const RETENTION_OPERATIONS = new Set([null, 'protect', 'unprotect']);

function isHeld(attempt) {
  return attempt.holdLeases.size > 0;
}

function isEnded(attempt) {
  return attempt.execution === 'ended';
}

/** Whether the recoverable visual grace is a valid state for this attempt. */
function fadeGraceEligible(attempt) {
  return attempt.verdict === 'old'
    && attempt.discard === 'offered'
    && deletable(attempt)
    && attempt.deletion === 'none'
    && attempt.stopReason === null
    && (attempt.execution === 'running' || isEnded(attempt));
}

function creationCancelled(attempt) {
  return attempt.stopReason !== null || isEnded(attempt)
    || attempt.launchController.signal.aborted;
}

function abandonUncreatedRetention(attempt) {
  clearRetentionRetry(attempt);
  attempt.retentionRevision += 1;
  attempt.retention.intent = 'dismissed';
  attempt.retention.durability = 'none';
  attempt.retention.error = null;
  attempt.retention.operation = null;
}

function attemptStatus(attempt) {
  const protectedConversation = retained(attempt);
  const draining = hasOwnedResources(attempt);

  if (attempt.deletion === 'failed') return 'error';
  if (isEnded(attempt) && (attempt.deletion === 'deleted'
      || (attempt.discard === 'committed' && !protectedConversation))) return 'discarded';
  if (isEnded(attempt) && attempt.stopReason !== null) {
    if (draining) return 'stopping';
    return attempt.stopReason === 'watchdog' ? 'error' : 'stopped';
  }
  if (attempt.execution === 'starting') return attempt.stopReason ? 'stopping' : 'starting';
  if (attempt.execution === 'cancelling') {
    return attempt.stopReason ? 'stopping' : 'discarding';
  }
  if (attempt.execution === 'running') {
    if (attempt.discard === 'committed') return 'discarding';
    if (attempt.discard === 'offered' && !isHeld(attempt) && !protectedConversation) {
      return 'pending-discard';
    }
    return attempt.verdict === 'rollout' ? 'kept-streaming' : 'streaming';
  }

  // execution === ended
  if (attempt.error !== null && attempt.discard !== 'committed') return 'error';
  if (attempt.verdict === 'rollout') return 'kept';
  if (protectedConversation) return 'pinned';
  if (attempt.verdict === 'old' && attempt.discard === 'offered' && !isHeld(attempt)) {
    return 'pending-discard';
  }
  return 'finished';
}

/** Pure invariant audit used by transition tests and diagnostic assertions. */
function attemptInvariantErrors(attempt) {
  const errors = [];
  if (!EXECUTION_PHASES.has(attempt.execution)) errors.push(`execution:${attempt.execution}`);
  if (!DISCARD_PHASES.has(attempt.discard)) errors.push(`discard:${attempt.discard}`);
  if (!DELETION_PHASES.has(attempt.deletion)) errors.push(`deletion:${attempt.deletion}`);
  if (!VERDICTS.has(attempt.verdict)) errors.push(`verdict:${attempt.verdict}`);
  if (!RETENTION_INTENTS.has(attempt.retention.intent)) {
    errors.push(`retention-intent:${attempt.retention.intent}`);
  }
  if (!RETENTION_DURABILITY.has(attempt.retention.durability)) {
    errors.push(`retention-durability:${attempt.retention.durability}`);
  }
  if (!RETENTION_OPERATIONS.has(attempt.retention.operation)) {
    errors.push(`retention-operation:${attempt.retention.operation}`);
  }
  if ((attempt.retention.durability === 'pending' || attempt.retention.durability === 'failed')
      && !hasRetentionIntent(attempt)) {
    errors.push('pending/failed retention requires keep intent');
  }
  if ((attempt.retention.durability === 'pending' || attempt.retention.durability === 'failed')
      !== (attempt.retention.operation !== null)) {
    errors.push('retention transition must name its operation');
  }
  const fadeArmed = attempt.fadeTimer !== null;
  const fadeHasDeadline = attempt.fadeDeadlineAt !== null;
  const fadeHasCommitAt = attempt.fadeCommitAt !== null;
  const fadeSuspended = attempt.fadeRemainingMs !== null;
  const fadeEligible = fadeGraceEligible(attempt);
  if (fadeArmed !== fadeHasDeadline || fadeArmed !== fadeHasCommitAt) {
    errors.push('fade timer, visual deadline and commit deadline must share ownership');
  }
  if (fadeArmed && fadeSuspended) {
    errors.push('fade cannot be armed and suspended together');
  }
  if (fadeSuspended && (!Number.isFinite(attempt.fadeRemainingMs)
      || attempt.fadeRemainingMs < 0 || attempt.fadeRemainingMs > FADE_MS)) {
    errors.push(`fade remaining:${attempt.fadeRemainingMs}`);
  }
  if (fadeArmed && (!fadeEligible || isHeld(attempt))) {
    errors.push('armed fade requires eligible unheld discard');
  }
  if (fadeSuspended && (!fadeEligible || !isHeld(attempt))) {
    errors.push('suspended fade requires eligible held discard');
  }
  if (fadeEligible && !isHeld(attempt) && !fadeArmed) {
    errors.push('eligible discard requires an armed fade');
  }
  if (fadeEligible && isHeld(attempt) && !fadeSuspended) {
    errors.push('held discard requires a suspended fade');
  }
  if (attempt.retention.intent === 'auto' && attempt.verdict !== 'rollout'
      && attempt.retention.operation !== 'unprotect') {
    errors.push('automatic retention requires rollout verdict');
  }
  if (attempt.discard !== 'none' && attempt.verdict !== 'old') {
    errors.push('discard requires old verdict');
  }
  if (attempt.execution === 'cancelling'
      && attempt.discard !== 'committed' && attempt.stopReason === null) {
    errors.push('ordinary cancellation requires committed discard');
  }
  if (isEnded(attempt) && attempt.verdict === 'old' && deletable(attempt)
      && !isHeld(attempt) && attempt.discard === 'none') {
    errors.push('ended ordinary old verdict must be reconciled');
  }
  if (attempt.deletion === 'deleted' && attempt.ownershipClaimed) {
    errors.push('deleted attempt cannot retain ownership claim');
  }
  if (attempt.reviewClosed && isHeld(attempt)) {
    errors.push('closed review epoch cannot retain active leases');
  }
  for (const [token, leaseRecord] of attempt.holdLeases) {
    if (typeof token !== 'string' || token.length === 0
        || leaseRecord === null || leaseRecord.timer === null
        || !Number.isFinite(leaseRecord.expiresAt)) {
      errors.push(`invalid review lease:${token}`);
    }
  }
  return errors;
}

function publicAttempt(attempt) {
  const status = attemptStatus(attempt);
  return {
    id: attempt.id,
    number: attempt.number,
    sessionId: attempt.sessionId,
    status,
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
    deleted: attempt.deletion === 'deleted',
    error: attempt.deletionError ?? attempt.retention.error ?? attempt.error,
    preview: attempt.reasoning.slice(0, 160),
    regular: !!attempt.regular,
    pauses: attempt.pauses || 0,
    held: isHeld(attempt),
    tps: typeof attempt.tps === 'number' ? attempt.tps : null,
    ttft: typeof attempt.ttft === 'number' ? attempt.ttft : null,
    protected: retained(attempt),
    kept: retained(attempt) || attempt.verdict === 'rollout',
    discardAt: status === 'pending-discard' && attempt.fadeTimer !== null
      ? attempt.fadeDeadlineAt : null,
    retention: { ...attempt.retention },
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
  // A delayed native timer cannot make a wall-clock-expired review visible as
  // active in a fresh snapshot. This uses the same terminal transition as
  // heartbeat, release, and destructive workflows.
  if (host !== null) {
    const now = Date.now();
    for (const attempt of [...state.attempts]) {
      expireOverdueReviewLeases(host, attempt, now);
    }
  }
  return {
    revision: ++snapshotRevision.value,
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
    invariantErrors: state.attempts.flatMap((attempt) =>
      attemptInvariantErrors(attempt).map((error) => `probe ${attempt.number}: ${error}`)),
    notifications: notificationState(),
    orphans: state.orphans,
    protectedCount: manifestFor(state.config.folder).protected.size,
    culled: state.culled,
    reaped: state.reaped,
    // Shared across hot-reloaded instances so a late deletion by the retiring
    // copy still refreshes the replacement UI's sidebar baseline.
    sessionsRevision: sessionRevision.value,
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
    ? strings.catch(attempt.number, Math.round(attempt.score * 100))
    : strings.probe(attempt.number);
  try { renameSession(ctx, attempt.sessionId, title); } catch (e) {}
}

function isLive(attempt) {
  return hasOwnedResources(attempt) || attempt.execution !== 'ended';
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
    const status = attemptStatus(attempt);
    const terminal = status === 'discarded' || status === 'finished'
      || status === 'stopped' || status === 'error';
    if (isEnded(attempt) && terminal && !isHeld(attempt) && !hasOwnedResources(attempt)
        && attempt.deletion !== 'deleting' && attempt.deletion !== 'failed'
        && attempt.deletionTask === null
        && deletable(attempt)) {
      closedOrdinary += 1;
      if (closedOrdinary > HISTORY_LIMIT) {
        resetFadeGrace(attempt);
        clearWatchdog(attempt);
        clearCancelTimer(attempt);
        clearRetentionRetry(attempt);
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
      // API identity is never reused. The human-facing number may restart at
      // 1, but a late request from an old card can never target a new probe.
      id: crypto.randomUUID(),
      number: state.sequence,
      runId: state.runId,
      config: Object.freeze({ ...state.config }),
      folder: folderKey(state.config.folder),
      sessionId: null,
      execution: 'starting',
      verdict: null,
      discard: 'none',
      stopReason: null,
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
      deletion: 'none',
      deletionTask: null,
      deletionError: null,
      error: null,
      handle: null,
      launching: true,
      launchTask: null,
      ownershipTask: null,
      ownershipClaimed: false,
      creationAbandoned: false,
      launchController: new AbortController(),
      disposing: false,
      disposal: null,
      cleanupError: null,
      streamed: false,
      watchdog: null,
      cancelTimer: null,
      pauses: 0,
      lastChunkAt: null,
      burstChars: 0,
      holdLeases: new Map(),
      releasedHolds: new Set(),
      reviewClosed: false,
      fadeTimer: null,
      fadeGeneration: 0,
      fadeDeadlineAt: null,
      fadeCommitAt: null,
      fadeRemainingMs: null,
      cancelSent: false,
      retention: {
        intent: 'none',
        durability: 'none',
        error: null,
        operation: null,
      },
      retentionRetry: null,
      retentionRevision: 0,
    };
    state.attempts.unshift(attempt);
    trimHistory();
    const task = launch(ctx, attempt).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      if (attempt.stopReason === null) attempt.error = message;
      // Only a launch that never reached 'streaming' counts towards the
      // breaker: a failure after the turn started is the probe's problem,
      // not a sign that launching itself is broken.
      if (!attempt.streamed && attempt.stopReason === null) {
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

  // Nothing has been created yet, so a stop that arrived during workspace or
  // model setup can end here without manufacturing a manifest entry.
  if (creationCancelled(attempt)) {
    attempt.creationAbandoned = true;
    abandonUncreatedRetention(attempt);
    return;
  }

  const sessionId = `session-${crypto.randomUUID()}`;
  attempt.sessionId = sessionId;
  // Ownership must reach disk before the harness can create any resource with
  // this id. A crash after this boundary leaves a recoverable owned orphan; a
  // crash before it cannot leave an untracked probe that cleanup may guess at.
  const ownershipTask = mutateManifest(attempt.folder, (next) => {
    next.owned.add(sessionId);
    if (hasRetentionIntent(attempt)) next.protected.add(sessionId);
  });
  attempt.ownershipTask = ownershipTask;
  try {
    await ownershipTask;
    attempt.ownershipClaimed = true;
    if (hasRetentionIntent(attempt)
        && manifestFor(attempt.folder).protected.has(sessionId)) {
      attempt.retention.durability = 'durable';
      attempt.retention.error = null;
      attempt.retention.operation = null;
    }
  } catch (error) {
    attempt.sessionId = null;
    throw error;
  } finally {
    if (attempt.ownershipTask === ownershipTask) attempt.ownershipTask = null;
  }

  // Stop/unload may have landed while the manifest write was in flight. No
  // harness resource exists yet, so close the durable claim and return instead
  // of creating an agent merely to cancel it. A failed relinquish keeps the id
  // owned and visible for a safe retry.
  if (creationCancelled(attempt)) {
    attempt.creationAbandoned = true;
    await mutateManifest(attempt.folder, (next) => {
      next.owned.delete(sessionId);
      next.protected.delete(sessionId);
      next.deleting.delete(sessionId);
    });
    attempt.ownershipClaimed = false;
    attempt.sessionId = null;
    abandonUncreatedRetention(attempt);
    return;
  }

  // Keep can land while the ownership write is in flight. Its action waits on
  // that write too, but this guard ensures creation never wins the race to the
  // next process boundary before the retention promise is durable.
  if (hasRetentionIntent(attempt) && !manifestFor(attempt.folder).protected.has(sessionId)) {
    await mutateManifest(attempt.folder, (next) => {
      next.owned.add(sessionId);
      next.protected.add(sessionId);
    });
    attempt.retention.durability = 'durable';
    attempt.retention.error = null;
    attempt.retention.operation = null;
  }

  // The late Keep write above is another asynchronous boundary.
  if (creationCancelled(attempt)) {
    attempt.creationAbandoned = true;
    await mutateManifest(attempt.folder, (next) => {
      next.owned.delete(sessionId);
      next.protected.delete(sessionId);
      next.deleting.delete(sessionId);
    });
    attempt.ownershipClaimed = false;
    attempt.sessionId = null;
    abandonUncreatedRetention(attempt);
    return;
  }

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
  attempt.handle = handle;
  // A stop/unload that landed while the agent was being created: never prompt.
  if (creationCancelled(attempt)) {
    beginDispose(attempt, true);
    return;
  }
  try { await workspace.attachSession(sessionId); } catch (e) {}

  // Attaching is asynchronous too; cancellation may have landed while it was
  // in progress. Do not cross the prompt boundary afterwards.
  if (creationCancelled(attempt)) {
    beginDispose(attempt, true);
    return;
  }

  attempt.execution = 'running';
  attempt.streamed = true;
  // One probe that got as far as its first turn clears the breaker.
  state.launchFailures = 0;
  titleAttempt(ctx, attempt, 'probe');
  attempt.promptSentAt = Date.now();
  armWatchdog(ctx, attempt);
  handle.agent.followup(probeMessage(config.prompt));
}

function onSessionEvent(ctx, attempt, event) {
  if (isEnded(attempt)) return;
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
 * The fade grace has one owner and three derived phases:
 *   idle       — no timer, deadline or saved remainder
 *   armed      — one timer and its absolute deadline
 *   suspended  — no timer, only the time saved by the first review lease
 *
 * Null the owner slot before clearing it. A callback that was already queued
 * must fail both its generation and identity checks before it can touch a
 * later grace period.
 */
function invalidateFadeTimer(attempt) {
  const timer = attempt.fadeTimer;
  if (timer === null && attempt.fadeDeadlineAt === null && attempt.fadeCommitAt === null) return;
  attempt.fadeGeneration += 1;
  attempt.fadeTimer = null;
  attempt.fadeDeadlineAt = null;
  attempt.fadeCommitAt = null;
  if (timer !== null) clearTimeout(timer);
}

/** End a grace epoch completely (Keep, commit, stop, deletion, unload). */
function resetFadeGrace(attempt) {
  if (attempt.fadeTimer === null && attempt.fadeDeadlineAt === null
      && attempt.fadeCommitAt === null && attempt.fadeRemainingMs === null) return;
  invalidateFadeTimer(attempt);
  attempt.fadeRemainingMs = null;
}

/** Pause, rather than renew, the current grace when the first review starts. */
function suspendFadeGrace(attempt) {
  if (attempt.fadeTimer === null && attempt.fadeDeadlineAt === null
      && attempt.fadeCommitAt === null && attempt.fadeRemainingMs !== null) return;
  let remaining = attempt.fadeRemainingMs;
  if (attempt.fadeDeadlineAt !== null) {
    remaining = Math.min(FADE_MS, Math.max(0, attempt.fadeDeadlineAt - Date.now()));
  } else if (remaining === null) {
    // A card can be hovered before its first old verdict. In that case the
    // full grace has not begun yet and starts only after the review is given
    // back.
    remaining = FADE_MS;
  }
  invalidateFadeTimer(attempt);
  attempt.fadeRemainingMs = remaining;
}

function sendCancel(attempt, agent = attempt.handle?.agent) {
  if (agent === undefined || attempt.cancelSent) return false;
  attempt.cancelSent = true;
  try { agent.cancel({ kind: 'user' }, { keepInbox: false }); } catch (e) {}
  return true;
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

function retireReviewLeases(attempt) {
  // This is an epoch-closing transition, not merely timer cleanup. Once Force
  // stop, unload or physical deletion crosses it, even a hold token the server
  // has never seen (because its request was delayed in transit) is rejected.
  attempt.reviewClosed = true;
  for (const [token, leaseRecord] of attempt.holdLeases) {
    clearTimeout(leaseRecord.timer);
    // A cancellation boundary can race a heartbeat already in flight. Retire
    // every live token before clearing it so that request cannot recreate the
    // review after Force stop or another overriding transition.
    attempt.releasedHolds.add(token);
  }
  attempt.holdLeases.clear();
}

function forgetReviewLeases(attempt) {
  retireReviewLeases(attempt);
  // Physical deletion is an irreversible gate checked before lease lookup;
  // only then is it safe to forget the protocol history with the row.
  attempt.releasedHolds.clear();
}

/**
 * Take the handle exactly once and track its asynchronous drain. Destructive
 * operations wait on this promise before touching the session log.
 */
function beginDispose(attempt, cancel) {
  if (cancel) {
    attempt.stopReason = attempt.stopReason ?? 'force';
    try { attempt.launchController?.abort(new Error('probe stopped')); } catch (e) {}
  }
  const handle = attempt.handle;
  if (handle === null) return attempt.disposal ?? Promise.resolve();
  attempt.handle = null;
  if (cancel) sendCancel(attempt, handle.agent);
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
  if (isEnded(attempt) || retained(attempt)) return;
  resetFadeGrace(attempt);
  attempt.error = 'watchdog timeout';
  attempt.stopReason = 'watchdog';
  attempt.execution = 'cancelling';
  sendCancel(attempt);
  clearCancelTimer(attempt);
  attempt.cancelTimer = setTimeout(() => {
    attempt.cancelTimer = null;
    if (!isEnded(attempt)) finish(ctx, attempt);
  }, DISCARD_GRACE_MS);
}

/** Arm against the original prompt time so Keep/Unkeep cannot extend a run. */
function armWatchdog(ctx, attempt) {
  clearWatchdog(attempt);
  if (isEnded(attempt) || retained(attempt) || attempt.promptSentAt === null) return;
  const remaining = Math.max(0, WATCHDOG_MS - (Date.now() - attempt.promptSentAt));
  attempt.watchdog = setTimeout(() => watchdogExpired(ctx, attempt), remaining);
}

/** How long a cancelled probe is given to deliver its `turn/end`. */
const DISCARD_GRACE_MS = 10_000;

function scheduleAutoDelete(ctx, attempt) {
  if (!attempt.config.autoDelete || !deletable(attempt) || !isEnded(attempt)) return;
  if (attempt.deletion === 'deleted') return;
  deleteAttempt(ctx, attempt).catch((error) => {
    attempt.deletionError = error instanceof Error ? error.message : String(error);
  });
}

function commitDiscard(ctx, attempt, options = {}) {
  if (attempt.verdict !== 'old' || !deletable(attempt)) return false;
  // This is the one irreversible discard boundary. Every caller — Pause,
  // watchdog completion, fade expiry, natural end and Unkeep — comes through
  // here, so none can accidentally bypass an active review lease.
  if (isHeld(attempt) && !options.overrideReview) {
    if (attempt.discard !== 'committed') attempt.discard = 'offered';
    if (fadeGraceEligible(attempt)) suspendFadeGrace(attempt);
    else resetFadeGrace(attempt);
    return false;
  }
  resetFadeGrace(attempt);
  if (attempt.discard === 'committed') {
    if (isEnded(attempt)) scheduleAutoDelete(ctx, attempt);
    return false;
  }
  attempt.discard = 'committed';
  if (isEnded(attempt)) {
    attempt.endedAt = attempt.endedAt ?? Date.now();
    scheduleAutoDelete(ctx, attempt);
    settle(ctx);
    return true;
  }

  attempt.execution = 'cancelling';
  sendCancel(attempt);
  // The long watchdog is pointless now — the turn is already cancelled. Swap
  // it for a short reaper so a cancel that never produces `turn/end` cannot
  // strand the attempt with a live agent handle.
  clearWatchdog(attempt);
  clearCancelTimer(attempt);
  attempt.cancelTimer = setTimeout(() => {
    attempt.cancelTimer = null;
    if (!isEnded(attempt)) finish(ctx, attempt);
  }, DISCARD_GRACE_MS);
  return true;
}

function scheduleFadeCommit(ctx, attempt, generation, delay) {
  let timer = null;
  timer = setTimeout(() => {
    if (generation !== attempt.fadeGeneration || attempt.fadeTimer !== timer) return;
    const untilCommit = attempt.fadeCommitAt - Date.now();
    // Wall-clock adjustment or an early timer must never widen or bypass the
    // bounded claim window. Keep the same generation/deadlines and replace
    // only the exact timer owner.
    if (untilCommit > 0) {
      scheduleFadeCommit(ctx, attempt, generation, untilCommit);
      return;
    }
    attempt.fadeTimer = null;
    attempt.fadeDeadlineAt = null;
    attempt.fadeCommitAt = null;
    // If review crossed the visual deadline just before its event was
    // observed, a zero remainder makes the eventual release commit
    // immediately.
    attempt.fadeRemainingMs = 0;
    if (attempt.verdict !== 'old' || retained(attempt)) {
      reconcileAttempt(ctx, attempt);
      return;
    }
    if (isHeld(attempt)) {
      suspendFadeGrace(attempt);
      return;
    }
    if (attempt.discard !== 'offered' || attempt.deletion !== 'none'
        || attempt.stopReason !== null
        || (attempt.execution !== 'running' && !isEnded(attempt))) {
      resetFadeGrace(attempt);
      return;
    }
    commitDiscard(ctx, attempt);
  }, delay);
  attempt.fadeTimer = timer;
}

/**
 * Ensure one visual grace period. Repeated classifier results are ordinary
 * reconciliation, not authority to move its deadline. A release may resume a
 * saved remainder, but it also creates at most one timer owner. The visual
 * deadline and the irreversible commit deadline deliberately differ by one
 * bounded local-request allowance.
 */
function offerFade(ctx, attempt) {
  if (attempt.verdict !== 'old' || attempt.discard === 'committed') return;
  attempt.discard = 'offered';
  if (retained(attempt)) {
    attempt.discard = 'none';
    resetFadeGrace(attempt);
    return;
  }
  if (isHeld(attempt)) {
    if (fadeGraceEligible(attempt)) suspendFadeGrace(attempt);
    else resetFadeGrace(attempt);
    return;
  }
  if (attempt.stopReason !== null || attempt.deletion !== 'none') {
    resetFadeGrace(attempt);
    return;
  }
  if (attempt.execution !== 'running' && !isEnded(attempt)) {
    resetFadeGrace(attempt);
    return;
  }
  if (attempt.fadeTimer !== null) return;

  const delay = Math.min(FADE_MS, Math.max(0,
    attempt.fadeRemainingMs === null ? FADE_MS : attempt.fadeRemainingMs));
  attempt.fadeRemainingMs = null;
  if (delay === 0) {
    commitDiscard(ctx, attempt);
    return;
  }

  const generation = attempt.fadeGeneration;
  const deadline = Date.now() + delay;
  attempt.fadeDeadlineAt = deadline;
  attempt.fadeCommitAt = deadline + HOLD_CLAIM_GRACE_MS;
  scheduleFadeCommit(ctx, attempt, generation, delay + HOLD_CLAIM_GRACE_MS);
}

/**
 * Converge every event (classification, end, hover release, Unkeep) on the
 * same disposition rules. Judgment is never suppressed by retention/review;
 * those axes only decide whether an old verdict may advance to cancellation.
 */
function reconcileAttempt(ctx, attempt, options = {}) {
  if (attempt.verdict !== 'old') {
    if (attempt.discard !== 'committed') {
      attempt.discard = 'none';
      resetFadeGrace(attempt);
    }
    return;
  }
  if (retained(attempt)) {
    if (attempt.discard !== 'committed') {
      attempt.discard = 'none';
      resetFadeGrace(attempt);
    }
    return;
  }
  if (isHeld(attempt)) {
    if (attempt.discard !== 'committed') attempt.discard = 'offered';
    if (fadeGraceEligible(attempt)) suspendFadeGrace(attempt);
    else resetFadeGrace(attempt);
    return;
  }
  if (attempt.stopReason !== null) {
    resetFadeGrace(attempt);
    if (isEnded(attempt)) commitDiscard(ctx, attempt);
    return;
  }
  if (attempt.discard === 'committed') {
    if (isEnded(attempt)) scheduleAutoDelete(ctx, attempt);
    return;
  }
  if (attempt.execution === 'starting') return;
  if (options.immediate) commitDiscard(ctx, attempt);
  else offerFade(ctx, attempt);
}

function retractAutomaticRetention(ctx, attempt) {
  if (attempt.retention.intent !== 'auto') return;
  if (attempt.retention.durability === 'none') {
    clearRetentionRetry(attempt);
    attempt.retentionRevision += 1;
    attempt.retention.intent = 'dismissed';
    attempt.retention.durability = 'none';
    attempt.retention.error = null;
    attempt.retention.operation = null;
    return;
  }
  unmarkProtected(attempt).then(() => {
    reconcileAttempt(ctx, attempt, { immediate: isEnded(attempt) });
  }).catch(() => scheduleAutomaticRetentionRetry(ctx, attempt));
}

function recordOld(ctx, attempt, reason) {
  const wasRollout = attempt.verdict === 'rollout';
  if (attempt.verdict !== 'old') {
    attempt.verdict = 'old';
    attempt.reason = reason;
  }
  // Automatic catches are provisional; a manual Keep is user authority.
  if (wasRollout) retractAutomaticRetention(ctx, attempt);
  reconcileAttempt(ctx, attempt);
  if (wasRollout && state.paused && state.note === 'hit'
      && !state.attempts.some((a) => a.runId === attempt.runId && a.verdict === 'rollout')) {
    state.running = true;
    state.paused = false;
    state.note = null;
    pump(ctx);
  }
}

function recordRollout(attempt, reason) {
  // An old verdict is terminal; positive evidence arriving later cannot
  // resurrect a cancellation that may already have crossed its boundary.
  if (attempt.verdict === 'old') return;
  resetFadeGrace(attempt);
  attempt.discard = 'none';
  attempt.verdict = 'rollout';
  attempt.reason = reason;
  if (attempt.retention.intent === 'none') {
    attempt.retentionRevision += 1;
    attempt.retention.intent = 'auto';
    attempt.retention.durability = 'none';
    attempt.retention.error = null;
    attempt.retention.operation = null;
  }
  if (attempt.config.autoPauseOnMatch && attempt.runId === state.runId) {
    state.running = false;
    state.paused = true;
    state.note = 'hit';
  }
}

function findAttempt(id) {
  const attempt = state.attempts.find((a) => a.id === id);
  if (attempt === undefined) throw new TypeError('找不到该探测 / probe not found');
  return attempt;
}

/**
 * The user taking a conversation out of this plugin's reach for good. Unlike
 * a pin — which is a hover-scale rescue that a later verdict can still walk
 * back — this is durable, survives a plugin reload, and is cleared only by
 * `unprotect`.
 */
async function protectAttempt(ctx, id) {
  const attempt = findAttempt(id);
  resetFadeGrace(attempt);
  try {
    await markProtected(attempt);
  } finally {
    reconcileAttempt(ctx, attempt, { immediate: isEnded(attempt) });
  }
  // Once cancellation was sent it cannot be undone. Protection still keeps
  // the conversation on disk, but the cancel reaper must close the handle.
  if (attempt.execution !== 'cancelling') clearWatchdog(attempt);
  return publicState();
}

/** Name a catch yourself. Keeping it is implied — naming it means you want it. */
async function renameAttempt(ctx, id, title) {
  const attempt = findAttempt(id);
  assertRetentionOpen(attempt);
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
  let unprotected = false;
  try {
    await unmarkProtected(attempt);
    unprotected = true;
  } finally {
    reconcileAttempt(ctx, attempt, { immediate: isEnded(attempt) });
  }
  if (unprotected && !isEnded(attempt) && attempt.execution !== 'cancelling') {
    armWatchdog(ctx, attempt);
  }
  return publicState();
}

const HOLD_LEASE_MS = 30_000;

function reviewResponse(action, id, lease, accepted, reason) {
  return Object.assign(publicState(), {
    review: { action, id, lease, accepted, reason },
  });
}

function reviewDeletionBlocked(attempt) {
  if (attempt.deletion !== 'none') return true;
  if (attempt.sessionId === null) return false;
  const record = manifestFor(attempt.folder);
  return record.deleting.has(attempt.sessionId)
    || record.deleteTasks.has(attempt.sessionId);
}

function reviewBoundaryReason(attempt) {
  if (attempt.reviewClosed) return 'review-closed';
  if (reviewDeletionBlocked(attempt)) return 'deleting';
  if (attempt.discard === 'committed') return 'discard-committed';
  if (attempt.stopReason !== null || attempt.execution === 'cancelling') return 'stopping';
  return null;
}

/**
 * Lease expiry is a wall-clock boundary, not a timer-callback boundary. Node
 * may service ready I/O before an overdue timer after a blocked event loop;
 * a heartbeat in that window must see the token as expired and tombstoned.
 */
function expireReviewLease(ctx, attempt, token, leaseRecord) {
  if (attempt.holdLeases.get(token) !== leaseRecord) return false;
  clearTimeout(leaseRecord.timer);
  attempt.holdLeases.delete(token);
  attempt.releasedHolds.add(token);
  if (isHeld(attempt)) return true;
  reconcileAttempt(ctx, attempt, {
    immediate: isEnded(attempt) || attempt.fadeRemainingMs === 0,
  });
  return true;
}

function expireOverdueReviewLeases(ctx, attempt, now = Date.now()) {
  let expired = 0;
  for (const [token, leaseRecord] of [...attempt.holdLeases]) {
    if (now < leaseRecord.expiresAt) continue;
    if (expireReviewLease(ctx, attempt, token, leaseRecord)) expired += 1;
  }
  return expired;
}

/**
 * Mouse entered: a fading card is rescued for exactly as long as the pointer
 * stays on it. The hold is a loan — release re-offers the fade — so a mouse
 * crossing the list can never keep anything alive. Durable protection has
 * one entry: the Keep button.
 */
function holdAttempt(ctx, id, lease, claim = {}) {
  const attempt = state.attempts.find((a) => a.id === id);
  // Clear/delete can remove a card while React is unmounting it. Gesture
  // cleanup is deliberately idempotent and never becomes a red UI error.
  if (attempt === undefined) {
    return reviewResponse('hold', id, lease, false, 'missing');
  }
  if (typeof lease !== 'string' || lease.length === 0 || lease.length > 160) {
    return reviewResponse('hold', id, lease, false, 'invalid-lease');
  }
  const token = lease;
  // A release may beat its hold over two HTTP requests. The tombstone makes
  // that order converge to released rather than leaving an immortal hold.
  if (attempt.releasedHolds.has(token)) {
    return reviewResponse('hold', id, token, false, 'released');
  }
  let previous = attempt.holdLeases.get(token);
  const now = Date.now();
  if (previous !== undefined && now >= previous.expiresAt) {
    expireReviewLease(ctx, attempt, token, previous);
    return reviewResponse('hold', id, token, false, 'released');
  }
  const boundary = reviewBoundaryReason(attempt);
  if (boundary !== null) {
    return reviewResponse('hold', id, token, false, boundary);
  }

  const mode = claim.mode;
  if (mode !== 'claim' && mode !== 'heartbeat') {
    return reviewResponse('hold', id, token, false, 'invalid-mode');
  }
  if (previous !== undefined && mode !== 'heartbeat') {
    return reviewResponse('hold', id, token, false, 'claim-already-active');
  }
  if (previous === undefined) {
    if (mode === 'heartbeat') {
      return reviewResponse('hold', id, token, false, 'heartbeat-missing');
    }
    const enteredAt = claim.enteredAt;
    if (typeof enteredAt !== 'number' || !Number.isFinite(enteredAt)
        || enteredAt > now + HOLD_CLAIM_CLOCK_SKEW_MS) {
      return reviewResponse('hold', id, token, false, 'invalid-claim-time');
    }
    if (attempt.fadeTimer !== null) {
      const observedDiscardAt = claim.observedDiscardAt;
      if (typeof observedDiscardAt !== 'number' || !Number.isFinite(observedDiscardAt)
          || observedDiscardAt !== attempt.fadeDeadlineAt) {
        return reviewResponse('hold', id, token, false, 'stale-deadline');
      }
      if (enteredAt > attempt.fadeDeadlineAt + HOLD_CLAIM_CLOCK_SKEW_MS) {
        return reviewResponse('hold', id, token, false, 'late-pointer');
      }
      // Timer callbacks are not scheduling authority. If the event loop was
      // busy past the bounded commit time, cross the boundary synchronously
      // rather than accepting an indefinitely late claim.
      if (now >= attempt.fadeCommitAt) {
        commitDiscard(ctx, attempt);
        return reviewResponse('hold', id, token, false, 'claim-window-expired');
      }
    } else if (claim.observedDiscardAt !== null) {
      return reviewResponse('hold', id, token, false, 'unexpected-deadline');
    }
  }
  // The renderer heartbeats while the pointer is stationary. Re-arm the same
  // token rather than creating more leases, so an intentional long review is
  // safe while an abandoned renderer still expires after 30 seconds.
  if (previous !== undefined) clearTimeout(previous.timer);
  const leaseRecord = { timer: null, expiresAt: now + HOLD_LEASE_MS };
  leaseRecord.timer = setTimeout(() => {
    expireReviewLease(ctx, attempt, token, leaseRecord);
  }, HOLD_LEASE_MS);
  attempt.holdLeases.set(token, leaseRecord);
  if (attempt.verdict === 'old' && attempt.discard !== 'committed') {
    attempt.discard = 'offered';
    if (fadeGraceEligible(attempt)) suspendFadeGrace(attempt);
    else resetFadeGrace(attempt);
  }
  return reviewResponse('hold', id, token, true,
    previous === undefined ? 'claimed' : 'heartbeat');
}

/** Mouse left: give back what the hover borrowed. */
function releaseAttempt(ctx, id, lease) {
  const attempt = state.attempts.find((a) => a.id === id);
  const token = typeof lease === 'string' && lease.length <= 160 ? lease : 'legacy';
  if (attempt === undefined) {
    return reviewResponse('release', id, token, true, 'missing');
  }
  const leaseRecord = attempt.holdLeases.get(token);
  if (leaseRecord !== undefined && Date.now() >= leaseRecord.expiresAt) {
    expireReviewLease(ctx, attempt, token, leaseRecord);
    return reviewResponse('release', id, token, true, 'expired');
  }
  const hadLease = leaseRecord !== undefined;
  if (leaseRecord !== undefined) {
    clearTimeout(leaseRecord.timer);
    attempt.holdLeases.delete(token);
  }
  // Keep the tombstone for the attempt's entire reachable lifetime, even when
  // a live timer was removed. An arbitrarily late heartbeat after mouseleave
  // must never recreate that lease. History trimming/deletion bounds the Set's
  // lifetime; evicting by count would make correctness depend on mouse usage.
  attempt.releasedHolds.add(token);
  // Only removal of a real active lease owns reconciliation. A duplicate,
  // expired, release-before-hold, or never-seen token is an idempotent
  // tombstone operation; allowing it to reconcile could re-arm a fade from a
  // reachable asynchronous intermediate state.
  if (!hadLease) {
    return reviewResponse('release', id, token, true, 'not-held');
  }
  if (isHeld(attempt)) {
    return reviewResponse('release', id, token, true, 'other-leases-active');
  }
  // Physical deletion, an already-committed discard, and an explicitly
  // retired review epoch are terminal. Release is only a tombstone there and
  // must not recreate a fade.
  if (attempt.reviewClosed) {
    return reviewResponse('release', id, token, true, 'review-closed');
  }
  if (attempt.discard === 'committed') {
    return reviewResponse('release', id, token, true, 'discard-committed');
  }
  if (reviewDeletionBlocked(attempt)) {
    return reviewResponse('release', id, token, true, 'deleting');
  }
  // A watchdog may stop a turn while review is active. finish() deliberately
  // leaves that old conversation offered because the lease still owns the
  // discard boundary. Once the final lease is released after turn/end, close
  // it immediately; a tombstone-only return here would strand the log forever.
  // A still-cancelling turn is converged by finish()/the cancel reaper and
  // must not be given a new visual fade in the meantime.
  if (attempt.stopReason !== null || attempt.execution === 'cancelling') {
    if (isEnded(attempt)) reconcileAttempt(ctx, attempt, { immediate: true });
    return reviewResponse('release', id, token, true,
      isEnded(attempt) ? 'released-stopped' : 'stopping');
  }
  // An explicit mouseleave resumes exactly the saved remainder, even if the
  // turn ended during review. This keeps host deletion aligned with the card's
  // continued fade rather than granting a fresh grace period.
  reconcileAttempt(ctx, attempt);
  return reviewResponse('release', id, token, true, 'released');
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

  if (reject) {
    recordOld(ctx, attempt, reject);
    return;
  }
  if (attempt.verdict !== null) return;
  if (result.decisive === 'new') { recordRollout(attempt, 'decisive'); return; }
  const openings = result.positive + result.negative;
  if (openings >= attempt.config.minOpenings && attempt.score >= attempt.config.keepAbove) {
    recordRollout(attempt, 'score');
    return;
  }
  // Summariser fingerprint: even paragraphs plus at least one stall
  // between bursts, and some first-person-singular openings.
  if (result.regular && (attempt.pauses || 0) >= 1 && result.positive >= 2 && result.decisive !== 'old') {
    recordRollout(attempt, 'shape');
  }
}

function finish(ctx, attempt) {
  if (isEnded(attempt)) return attempt.disposal ?? Promise.resolve();
  attempt.execution = 'ended';
  attempt.endedAt = Date.now();
  clearWatchdog(attempt);
  clearCancelTimer(attempt);
  if (attempt.stopReason === null) {
    evaluate(ctx, attempt, true);
  }
  if (attempt.verdict === null) {
    if (attempt.stopReason !== null || attempt.error) {
      attempt.verdict = 'unknown';
    } else {
      recordOld(ctx, attempt, attempt.positive === 0 ? 'window' : 'ended');
    }
  }

  if (attempt.stopReason !== null) {
    if (attempt.verdict === 'old' && deletable(attempt)) commitDiscard(ctx, attempt);
    else {
      attempt.discard = 'none';
      resetFadeGrace(attempt);
    }
  } else {
    reconcileAttempt(ctx, attempt);
  }

  if (attempt.verdict === 'rollout') {
    if (attempt.retention.intent === 'auto' && attempt.retention.durability === 'none') {
      // The retention axis owns both the fault and its retry. Do not copy the
      // error into the execution axis, or a successful retry would still
      // render the conversation as a permanently failed turn.
      markProtected(attempt, 'auto').catch(() => scheduleAutomaticRetentionRetry(ctx, attempt));
    }
    titleAttempt(ctx, attempt, 'catch');
  }
  const disposal = beginDispose(attempt, false);
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
  if (agent.status === 'running') {
    try {
      agent.cancel({ kind: 'user' }, { keepInbox: false });
    } catch (error) {
      throw new Error(`无法中止会话 ${sessionId} / cannot cancel session`, { cause: error });
    }
  }
  if (typeof agent.whenIdle === 'function') {
    await agent.whenIdle();
    return;
  }
  if (agent.status === 'running') {
    throw new Error(`会话 ${sessionId} 仍在写入 / session is still writing`);
  }
}

function workspaceContaining(ctx, sessionId, preferred) {
  if (preferred !== undefined && (preferred.sessionIds ?? []).includes(sessionId)) return preferred;
  return ctx.workspaceRegistry.list().find((workspace) =>
    (workspace.sessionIds ?? []).includes(sessionId));
}

/** In-memory Keep intent overlays the manifest while persistence is pending or failed. */
function retentionAttempt(folder, sessionId) {
  const key = folderKey(folder);
  if (manifestFor(key).pendingRetention.has(sessionId)) return true;
  return state.attempts.some((attempt) =>
    attempt.folder === key && attempt.sessionId === sessionId && hasRetentionIntent(attempt))
    ? true : undefined;
}

function reviewAttempt(ctx, folder, sessionId) {
  const key = folderKey(folder);
  const attempt = state.attempts.find((candidate) =>
    candidate.folder === key && candidate.sessionId === sessionId);
  if (attempt === undefined) return undefined;
  expireOverdueReviewLeases(ctx, attempt);
  return isHeld(attempt) ? attempt : undefined;
}

/**
 * Exercise the manifest's destructive authority for one id. The per-id
 * Promise lease coalesces overlapping auto/button deletes and keeps a
 * concurrent Keep from crossing the destructive boundary.
 * The id leaves the manifest only after log removal, workspace detachment and
 * the atomic manifest write all succeed; every retry is therefore idempotent.
 */
function deleteOwnedSession(ctx, sessionId, folder, headers, preferredWorkspace) {
  const record = manifestFor(folder);
  const existing = record.deleteTasks.get(sessionId);
  if (existing !== undefined) return existing;

  const deletion = (async () => {
    // Unlike an in-process Promise, this lease survives module boundaries and
    // is released by the OS on process crash. It spans the entire physical
    // transaction, so two DSH processes cannot cancel/detach the same session.
    const releaseProcessLease = await acquireProcessLease(
      'delete', `${folderKey(folder)}\0${sessionId}`);
    try {
      await loadManifest(folder);
      await record.mutationTail;
      if (retentionAttempt(folder, sessionId) !== undefined) {
        throw new Error(`会话 ${sessionId} 正在保留 / session has a pending Keep intent`);
      }
      if (reviewAttempt(ctx, folder, sessionId) !== undefined) {
        throw new Error(`会话 ${sessionId} 正在查看 / session has an active review lease`);
      }

      // Persist the point of no return before touching the log. After a crash,
      // only ids in this set may resume physical deletion; ordinary owned ids
      // remain safe until a cleanup action explicitly starts this transaction.
      let alreadyGone = false;
      await mutateManifest(folder, (next) => {
        if (!next.owned.has(sessionId)) {
          alreadyGone = true;
          return;
        }
        if (next.protected.has(sessionId)) {
          throw new Error(`会话 ${sessionId} 已保留 / session is protected`);
        }
        if (retentionAttempt(folder, sessionId) !== undefined) {
          throw new Error(`会话 ${sessionId} 正在保留 / session has a pending Keep intent`);
        }
        if (reviewAttempt(ctx, folder, sessionId) !== undefined) {
          throw new Error(`会话 ${sessionId} 正在查看 / session has an active review lease`);
        }
        next.deleting.add(sessionId);
      });
      if (alreadyGone) return;

      await quiesceUnownedAgent(ctx.agents?.get?.(sessionId), sessionId);
      await removeSessionLog(ctx, sessionId, headers, folder);
      const workspace = workspaceContaining(ctx, sessionId, preferredWorkspace);
      if (workspace !== undefined) await workspace.detachSession(sessionId);
      await mutateManifest(folder, (next) => {
        next.owned.delete(sessionId);
        next.protected.delete(sessionId);
        next.deleting.delete(sessionId);
      });
      sessionRevision.value += 1;
    } finally {
      await releaseProcessLease();
    }
  })();
  record.deleteTasks.set(sessionId, deletion);
  const release = () => {
    if (record.deleteTasks.get(sessionId) === deletion) record.deleteTasks.delete(sessionId);
  };
  deletion.then(release, release);
  return deletion;
}

/** Remove one probe once; every caller joins the same per-attempt boundary. */
function deleteAttempt(ctx, attempt) {
  expireOverdueReviewLeases(ctx, attempt);
  if (attempt.deletion === 'deleted') return Promise.resolve();
  if (attempt.deletionTask !== null) return attempt.deletionTask;
  if (retained(attempt) || isHeld(attempt)) return Promise.resolve();
  const sessionId = attempt.sessionId;
  if (sessionId === null) {
    resetFadeGrace(attempt);
    return Promise.resolve();
  }
  // Clear is only one caller. Put the timer boundary here so Clear,
  // Delete-all and automatic deletion cannot leave a detached fade callback
  // capable of mutating an attempt after physical cleanup has begun.
  resetFadeGrace(attempt);
  // Close card mutations before awaiting resource teardown. No log is touched
  // until awaitQuiescence succeeds, but Keep/hover/fade must already see the
  // deletion gate while that asynchronous boundary is pending.
  attempt.deletion = 'deleting';
  attempt.deletionError = null;
  const task = (async () => {
    try {
      await awaitQuiescence(attempt, false);
      const workspace = workspaceContaining(ctx, sessionId);
      let headers = [];
      try { headers = await ctx.sessionPersistence.list(); } catch (e) {}
      await deleteOwnedSession(ctx, sessionId, attempt.folder, headers, workspace);
      attempt.ownershipClaimed = false;
      attempt.deletion = 'deleted';
      attempt.deletionError = null;
      forgetReviewLeases(attempt);
      clearRetentionRetry(attempt);
    } catch (error) {
      attempt.deletion = 'failed';
      attempt.deletionError = error instanceof Error ? error.message : String(error);
      throw error;
    }
  })();
  attempt.deletionTask = task;
  const release = () => {
    if (attempt.deletionTask === task) attempt.deletionTask = null;
  };
  task.then(release, release);
  return task;
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
  // Durable ownership must be known before creation or deletion can act in
  // this folder. Legacy v1 Keep records are migrated at this boundary.
  manifestReady = loadManifest(config.folder);
  await manifestReady;
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
  const now = Date.now();
  for (const attempt of state.attempts) expireOverdueReviewLeases(ctx, attempt, now);
  const done = state.attempts.filter(deletable).filter(isLive).filter(
    (attempt) => attempt.verdict === 'old');
  let culled = 0;
  for (const attempt of done) {
    attempt.reason = attempt.reason ?? 'paused';
    if (commitDiscard(ctx, attempt)) culled += 1;
  }
  state.culled = culled;
  if (culled > 0) state.note = 'paused-culled';
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
  // Force Stop is the explicit override for temporary review. Close every
  // reachable attempt's review epoch before touching execution so an ended
  // card—or a hold request still in transit—cannot block the cleanup actions
  // that follow.
  for (const attempt of state.attempts) retireReviewLeases(attempt);
  // Ended cards are not visited by the live loop below. Once review is
  // retired they must still cross their ordinary terminal disposition, or an
  // old ended card would remain offered with neither a lease nor a timer.
  for (const attempt of state.attempts.filter(isEnded)) {
    reconcileAttempt(ctx, attempt, { immediate: true });
  }
  // Stopping spend and retaining data are independent. Even a protected
  // conversation is cancellable; its log and protection promise survive.
  for (const attempt of state.attempts.filter(isLive)) {
    resetFadeGrace(attempt);
    attempt.stopReason = 'force';
    try { attempt.launchController?.abort(new Error('force stop')); } catch (e) {}
    sendCancel(attempt);
    finish(ctx, attempt);
  }
  return publicState();
}

async function clearHistory(ctx) {
  if (state.running) throw new Error('运行中不能清空 / cannot clear while running');
  const now = Date.now();
  for (const attempt of state.attempts) expireOverdueReviewLeases(ctx, attempt, now);
  // Named for what they hold rather than `keep`, which is the verdict
  // function one scope up.
  const retained = [];
  const dropped = [];
  for (const attempt of state.attempts) {
    if (isLive(attempt) || !deletable(attempt) || isHeld(attempt)) {
      retained.push(attempt);
    } else {
      dropped.push(attempt);
    }
  }
  let failure = null;
  for (const attempt of dropped) {
    try {
      await deleteAttempt(ctx, attempt);
      // Priority review traffic may interleave while an earlier deletion is
      // awaiting quiescence or disk I/O. The initial dropped snapshot is only
      // work scheduling; it cannot authorize removal after an await. A hold
      // accepted in that window makes deleteAttempt() a no-op and must keep
      // the row reachable, with its lease and log intact.
      if (isHeld(attempt)
          || (attempt.sessionId !== null && attempt.deletion !== 'deleted')) {
        retained.push(attempt);
      }
    } catch (error) {
      attempt.deletionError = error instanceof Error ? error.message : String(error);
      retained.push(attempt);
      failure = failure ?? attempt.deletionError;
    }
  }
  state.attempts = retained.sort((a, b) => b.number - a.number);
  if (state.attempts.length === 0) state.sequence = 0;
  if (failure !== null) throw new Error(failure);
  return publicState();
}

/** The probe folder's workspace, when the registry has one. */
function probeWorkspace(ctx, folderNorm) {
  return ctx.workspaceRegistry.list().find((w) => {
    try { return path.resolve(w.path) === folderNorm; } catch (e) { return false; }
  });
}

// The listing used to stat every session directory on every count. Ownership
// now comes straight from the small manifest, but retain the throttle because
// the GET poll does not need to race a filesystem migration or active cleanup.
const ORPHAN_RECOUNT_MS = 10_000;

/**
 * Probe conversations in the folder this plugin is not tracking — what the
 * user sees as "I stopped and deleted everything and the sidebar is still
 * full". A session with no card is one no console button can reach, and the
 * shell's own menu offers Archive but not Delete.
 */
async function orphans(ctx, folder = state.config.folder) {
  const folderNorm = path.resolve(folder);
  const record = await loadManifest(folderNorm);
  const known = new Set();
  for (const attempt of state.attempts) {
    if (attempt.folder === folderNorm && attempt.sessionId) known.add(attempt.sessionId);
  }
  let headers = [];
  try { headers = await ctx.sessionPersistence.list(); } catch (e) {}
  const workspace = probeWorkspace(ctx, folderNorm);
  const ids = [...record.owned].filter((id) =>
    !record.protected.has(id) && !record.pendingRetention.has(id) && !known.has(id));
  return { ids, headers, workspace };
}

async function countOrphans(ctx, force) {
  if (!force && Date.now() - state.orphans.at < ORPHAN_RECOUNT_MS) return state.orphans;
  const folder = folderKey(state.config.folder);
  const { ids } = await orphans(ctx, folder);
  let live = 0;
  for (const id of ids) {
    if (ctx.agents?.get?.(id)?.status === 'running') live += 1;
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
      await deleteOwnedSession(ctx, id, state.config.folder, headers, workspace);
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
  const now = Date.now();
  for (const attempt of state.attempts) {
    if (attempt.folder === folderNorm) expireOverdueReviewLeases(ctx, attempt, now);
  }
  if (state.attempts.some((a) => a.folder === folderNorm && isLive(a))) {
    throw new Error('仍有探测在进行中，请先强制停止 / probes are still live — force stop first');
  }
  const trackedAttempts = state.attempts.filter((a) => a.folder === folderNorm);
  const targets = trackedAttempts.filter((a) =>
    deletable(a) && !isHeld(a)
    && a.deletion !== 'deleted');
  const gateTrackedDeletion = (attempt) => {
    if (attempt.deletion === 'deleted' || attempt.deletion === 'deleting') return;
    resetFadeGrace(attempt);
    clearWatchdog(attempt);
    clearCancelTimer(attempt);
    attempt.deletion = 'deleting';
    attempt.deletionError = null;
  };
  // Establish every tracked deletion gate before the first await. Priority
  // review requests can interleave with this serialized action, so gating one
  // target at a time would leave later rows claimable while an earlier disk
  // transaction drains.
  for (const attempt of targets) {
    gateTrackedDeletion(attempt);
  }

  let failure = null;
  const blocked = new Set();
  for (const attempt of targets) {
    try {
      await awaitQuiescence(attempt, false);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      attempt.deletion = 'failed';
      attempt.deletionError = message;
      if (attempt.sessionId !== null) blocked.add(attempt.sessionId);
      failure = failure ?? message;
    }
  }

  const workspace = probeWorkspace(ctx, folderNorm);
  let headers = [];
  try { headers = await ctx.sessionPersistence.list(); } catch (e) {}
  const manifest = await loadManifest(folderNorm);
  await manifest.mutationTail;
  const ids = [...manifest.owned].filter((id) =>
    !manifest.protected.has(id)
    && !blocked.has(id)
    && retentionAttempt(folderNorm, id) === undefined
    && reviewAttempt(ctx, folderNorm, id) === undefined);
  // `targets` was an early scheduling snapshot. A card that was held then may
  // have been released or expired during quiescence and consequently joined
  // the authoritative manifest id set. Gate every tracked row selected by
  // that final set synchronously, before the first physical-deletion await.
  const selectedIds = new Set(ids);
  for (const attempt of trackedAttempts) {
    if (attempt.sessionId !== null && selectedIds.has(attempt.sessionId)) {
      gateTrackedDeletion(attempt);
    }
  }
  // One session failing to unlink must not strand the rest: keep going and
  // report afterwards, once the list has already been reset.
  const removed = new Set();
  const markTrackedDeleted = (sessionId) => {
    for (const attempt of trackedAttempts) {
      if (attempt.sessionId !== sessionId) continue;
      attempt.ownershipClaimed = false;
      attempt.deletion = 'deleted';
      attempt.deletionError = null;
      forgetReviewLeases(attempt);
      clearRetentionRetry(attempt);
    }
  };
  const markTrackedFailure = (sessionId, message) => {
    for (const attempt of trackedAttempts) {
      if (attempt.sessionId !== sessionId || attempt.deletion === 'deleted') continue;
      attempt.deletion = 'failed';
      attempt.deletionError = message;
    }
  };
  for (const sessionId of ids) {
    try {
      // A background auto-delete can finish after the snapshot above. That is
      // already a successful outcome, not an ownership failure for this button.
      await manifest.mutationTail;
      if (!manifest.owned.has(sessionId)) {
        removed.add(sessionId);
        markTrackedDeleted(sessionId);
        continue;
      }
      await deleteOwnedSession(ctx, sessionId, folderNorm, headers, workspace);
      removed.add(sessionId);
      markTrackedDeleted(sessionId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      markTrackedFailure(sessionId, message);
      failure = failure ?? message;
    }
  }

  // Keep protected, other-folder, and failed cards reachable. Removing a card
  // before its log succeeds is how invisible sidebar ghosts are created.
  state.attempts = state.attempts.filter((attempt) => {
    if (attempt.folder !== folderNorm || !deletable(attempt) || isHeld(attempt)) return true;
    if (attempt.deletion === 'deleted') return false;
    if (attempt.deletion === 'failed') return true;
    if (attempt.sessionId === null) return false;
    if (removed.has(attempt.sessionId)) {
      markTrackedDeleted(attempt.sessionId);
      return false;
    }
    attempt.deletion = 'failed';
    attempt.deletionError = attempt.deletionError ?? 'session deletion did not complete';
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

async function withDestructiveProcessLease(action, operation) {
  const release = await acquireProcessLease(
    'operation', `${folderKey(state.config.folder)}\0${action}`);
  try {
    return await operation();
  } finally {
    await release();
  }
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
const ACTION_QUEUE = Symbol.for('dsh.rollout-scout.actions.v1');
const actionQueue = globalThis[ACTION_QUEUE] ?? { tail: Promise.resolve() };
globalThis[ACTION_QUEUE] = actionQueue;
let manifestReady = Promise.resolve();

function serializeAction(action) {
  const queued = actionQueue.tail.then(action, action);
  actionQueue.tail = queued.catch(() => {});
  return queued;
}

async function runAction(ctx, body) {
  // Start validates and loads its selected folder itself, so a corrupt record
  // in an abandoned/default folder cannot prevent switching away from it.
  if (body.action !== 'start' && body.action !== 'self-check'
      && body.action !== 'mute-notifications') await manifestReady;
  switch (body.action) {
    case 'start': return start(ctx, body.config);
    case 'pause': return pause(ctx);
    case 'resume': return resume(ctx);
    case 'force-stop': return forceStop(ctx);
    case 'clear': return withDestructiveProcessLease('clear', () => clearHistory(ctx));
    case 'delete-all': return withDestructiveProcessLease('delete-all', () => deleteAll(ctx));
    case 'protect': return protectAttempt(ctx, body.id);
    case 'unprotect': return unprotectAttempt(ctx, body.id);
    case 'rename': return renameAttempt(ctx, body.id, body.title);
    case 'self-check': return selfCheck(body.config);
    case 'reap': return withDestructiveProcessLease('reap', () => reapOrphans(ctx));
    case 'mute-notifications': return muteNotifications(ctx);
    default: throw new TypeError('未知 action / unknown action');
  }
}

/**
 * Pointer review is a deadline claim, not an ordinary console mutation. It
 * must never wait behind a manifest migration, Keep write, or destructive
 * action queue entry: by then the visual deadline may already have crossed.
 * Both transitions are synchronous and rely on lease tombstones plus the
 * deletion gates for ordering.
 */
function runReviewAction(ctx, body) {
  switch (body.action) {
    case 'hold': return holdAttempt(ctx, body.id, body.lease, body);
    case 'release': return releaseAttempt(ctx, body.id, body.lease);
    default: throw new TypeError('未知 review action / unknown review action');
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
      // Review traffic has its own priority lane. Parsing and same-origin
      // validation still happen first, but it bypasses both manifestReady and
      // the global action queue so a pointer entry can be judged inside the
      // bounded claim window.
      if (body !== null && typeof body === 'object'
          && (body.action === 'hold' || body.action === 'release')) {
        respondJson(response, 200, runReviewAction(ctx, body));
      } else {
        respondJson(response, 200, await serializeAction(() => runAction(ctx, body)));
      }
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
    respondJson(response, badRequest ? 400 : 409, { error: message, state: publicState() });
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
  for (const attempt of state.attempts) {
    clearRetentionRetry(attempt);
    retireReviewLeases(attempt);
  }
  for (const attempt of state.attempts.filter(isEnded)) {
    reconcileAttempt(ctx, attempt, { immediate: true });
  }
  for (const attempt of state.attempts.filter(isLive)) {
    resetFadeGrace(attempt);
    clearWatchdog(attempt);
    clearCancelTimer(attempt);
    attempt.stopReason = 'unload';
    try { attempt.launchController?.abort(new Error('plugin unloaded')); } catch (e) {}
    sendCancel(attempt);
    finish(ctx, attempt);
  }
}

function apply(ctx) {
  host = ctx;
  manifestReady = loadManifest(state.config.folder);
  // Keep the original rejecting promise for runAction while preventing an
  // unhandled-rejection report before the first button request arrives.
  manifestReady.catch(() => {});
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
