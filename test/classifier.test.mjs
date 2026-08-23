// Regression tests for the paragraph-opening classifier, run against the real
// implementation. Every case is a chain-of-thought that was actually observed
// and labelled by hand.
//
//   node test/classifier.test.mjs
import os from 'node:os';
import path from 'node:path';
import { classify, chineseShare, sanitizeConfig, wantsDiscard } from '../lib/index.js';
import {
  FIXTURES, weNeedBlob, weNeedOpenings, weNeedThenIll,
} from '../lib/fixtures.js';

const CONFIG = {
  discardBelow: 0.35,
  keepAbove: 0.7,
  minOpenings: 4,
  paragraphWindow: 10,
  chineseShare: 0.8,
};

/** Mirrors the host's decision order for a completed turn. */
function verdict(text) {
  if (chineseShare(text) >= CONFIG.chineseShare) return 'discard';
  const r = classify(text, true);
  if (r.decisive === 'new') return 'keep';
  if (r.decisive === 'old') return 'discard';
  const openings = r.positive + r.negative;
  if (openings >= CONFIG.minOpenings) {
    if (r.score <= CONFIG.discardBelow) return 'discard';
    if (r.score >= CONFIG.keepAbove) return 'keep';
  }
  if (r.paragraphs >= CONFIG.paragraphWindow && r.positive === 0) return 'discard';
  // A completed turn that was not kept is discarded — the gray zone is
  // only for live probes still gathering openings.
  return 'discard';
}

// ---------------------------------------------------------------- samples --

// Labelled NEW model: flowing first-person prose, no "Let me" anywhere.
// The corpus lives in lib/fixtures.js because the console runs it too: the
// samples the user watches being classified are the ones asserted on here.
const cases = FIXTURES.map((f) => [f.title, f.text, f.label === 'rollout' ? 'keep' : 'discard']);

let failed = 0;
// Counted separately from `cases`: the assertions below the table are checks
// too, and folding them into the case count printed a denominator that did
// not match what actually ran.
let checks = 0;

function check(ok, message) {
  checks += 1;
  if (!ok) failed += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${message}`);
}

for (const [name, text, expected] of cases) {
  const got = verdict(text);
  const r = classify(text, true);
  const ok = got === expected;
  checks += 1;
  if (!ok) failed += 1;
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${got.padEnd(12)} want ${expected.padEnd(12)}`,
    `paras=${String(r.paragraphs).padEnd(3)} +${r.positive} -${r.negative}`,
    `score=${r.score.toFixed(2)} zh=${Math.round(chineseShare(text) * 100)}%  ${name}`,
  );
}
const liveBlob = classify(weNeedBlob, false);
check(
  liveBlob.paragraphs === 1 && liveBlob.negative >= 1 && liveBlob.decisive !== 'old',
  liveBlob.paragraphs === 1 && liveBlob.negative >= 1 && liveBlob.decisive !== 'old'
    ? 'streaming We-need blob is scored negative without an instant kill'
    : `streaming blob  paras=${liveBlob.paragraphs} decisive=${liveBlob.decisive} -${liveBlob.negative}  want paras=1 negative>=1 not-decisive-old`,
);

const shortLive = classify('We need', false);
check(
  shortLive.paragraphs === 0,
  shortLive.paragraphs === 0
    ? 'streaming opening withheld until 48 characters'
    : `short streaming opening counted paras=${shortLive.paragraphs} want 0`,
);

const weHits = classify(weNeedOpenings, true).hits;
for (const [phrase, hit] of Object.entries(weHits)) {
  check(
    !!hit && hit.sign === 'neg',
    hit && hit.sign === 'neg'
      ? `hit "${phrase}" ×${hit.count} sign=neg`
      : `hit "${phrase}" sign=${hit && hit.sign} want neg`,
  );
}

const summarised = classify(weNeedThenIll, true);
check(
  summarised.decisive !== 'old' && verdict(weNeedThenIll) === 'keep',
  summarised.decisive === 'old'
    ? 'summariser CoT starting We need was decisive-old'
    : verdict(weNeedThenIll) !== 'keep'
      ? `summariser CoT verdict=${verdict(weNeedThenIll)} want keep score=${summarised.score.toFixed(2)} +${summarised.positive} -${summarised.negative} regular=${summarised.regular}`
      : `summariser CoT We-need opener is keep (regular=${summarised.regular} score=${summarised.score.toFixed(2)})`,
);

// ------------------------------------------------------------ timing guards --
const baseAttempt = {
  reasoning: 'I need to check the parameters carefully.',
  ttft: null,
  tps: null,
  score: 0.5,
};
const baseResult = classify(baseAttempt.reasoning, false);

// TPS checks
const tpsDiscard = wantsDiscard(
  { ...baseAttempt, tps: 85.0 },
  baseResult,
  { discardChinese: false, discardAboveTps: true, maxTps: 60 },
);
check(tpsDiscard === 'tps', `high TPS (85 > 60) triggers discard: ${tpsDiscard}`);

const tpsKeep = wantsDiscard(
  { ...baseAttempt, tps: 45.0 },
  baseResult,
  { discardChinese: false, discardAboveTps: true, maxTps: 60, minOpenings: 4, paragraphWindow: 10 },
);
check(tpsKeep === null, `normal rollout TPS (45 <= 60) is not discarded by TPS: ${tpsKeep}`);

const tpsDisabled = wantsDiscard(
  { ...baseAttempt, tps: 120.0 },
  baseResult,
  { discardChinese: false, discardAboveTps: false, maxTps: 60, minOpenings: 4, paragraphWindow: 10 },
);
check(tpsDisabled === null, `high TPS is ignored when toggle is off: ${tpsDisabled}`);

// TTFT checks
const ttftFastDiscard = wantsDiscard(
  { ...baseAttempt, ttft: 0.8 },
  baseResult,
  { discardChinese: false, discardBelowTtft: true, minTtft: 2.0 },
);
check(ttftFastDiscard === 'ttft_fast', `fast first token (0.8s < 2.0s) triggers discard: ${ttftFastDiscard}`);

const ttftFastKeep = wantsDiscard(
  { ...baseAttempt, ttft: 2.4 },
  baseResult,
  { discardChinese: false, discardBelowTtft: true, minTtft: 2.0, minOpenings: 4, paragraphWindow: 10 },
);
check(ttftFastKeep === null, `sufficient TTFT (2.4s >= 2.0s) is not discarded: ${ttftFastKeep}`);

// ------------------------------------------------------------ config guard --
// `delete-all` removes every session attached to the probe folder, so a folder
// that overlaps the harness state directory, the home directory or a drive
// root has to be refused before a run can ever start.
const OK_FOLDER = path.join(os.tmpdir(), 'rollout-scout-test');

function rejects(folder, label) {
  let threw = false;
  try { sanitizeConfig({ prompt: 'x', folder }); } catch (e) { threw = e instanceof TypeError; }
  check(threw, threw ? `folder refused: ${label}` : `folder ACCEPTED but should be refused: ${label}`);
}

// The shipped default has to survive its own guard.
const fallback = sanitizeConfig({ prompt: 'x' });
check(path.isAbsolute(fallback.folder), `the default folder is accepted: ${fallback.folder}`);
check(fallback.discardAboveTps === false && fallback.maxTps === 60, `default TPS config intact (maxTps=${fallback.maxTps})`);
check(fallback.discardBelowTtft === false && fallback.minTtft === 2.0, `default minTtft config intact (minTtft=${fallback.minTtft})`);

rejects(path.parse(os.homedir()).root, 'filesystem root');
rejects(os.homedir(), 'home directory');
rejects(path.join(os.homedir(), '.dsh'), 'harness state directory');
rejects(path.join(os.homedir(), '.dsh', 'sessions'), 'inside the harness state directory');
rejects('relative/path', 'relative path');

const good = sanitizeConfig({
  prompt: 'x',
  folder: OK_FOLDER,
  concurrency: 99,
  keepAbove: 0.8,
  discardAboveTps: true,
  maxTps: 55,
  discardBelowTtft: true,
  minTtft: 2.5,
});
check(good.folder === path.resolve(OK_FOLDER), `folder accepted and resolved: ${good.folder}`);
check(good.concurrency === 6, `concurrency clamped to ${good.concurrency} (max 6)`);
check(good.maxTps === 55 && good.minTtft === 2.5, 'custom timing config sanitized and retained');

let inverted = false;
try { sanitizeConfig({ prompt: 'x', folder: OK_FOLDER, keepAbove: 0.5, discardBelow: 0.6 }); } catch (e) { inverted = true; }
check(inverted, 'keepAbove below discardBelow is refused');

console.log(`\n${checks - failed}/${checks} passed`);
process.exit(failed === 0 ? 0 : 1);
