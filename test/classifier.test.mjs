// Regression tests for the paragraph-opening classifier, run against the real
// implementation. Every case is a chain-of-thought that was actually observed
// and labelled by hand.
//
//   node test/classifier.test.mjs
import { classify, chineseShare } from '../lib/index.js';

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
const newModel = `To avoid conflicts, I'll keep I18n.cs edits solely under one change and handle any additional edits separately if needed. I'm also noting the Antigravity dead catalog rules as report-only, and fixing the EffectiveValue credits hijack via a monetary-only BalanceAmount.

I've spotted a bigger conflict: HeroViewModelTests.cs is touched by both the chart work and the value-mode test changes, so I'm resolving this by having the chart-related change own the entire HeroViewModel.cs and HeroViewModelTests.cs files, including the value-mode updates.

Meanwhile, the money-related change should own the Core money files—ProviderPriority.cs, ProviderMoney.cs, Catalog.cs, the new CurrencyRates.cs, and various provider files—along with their corresponding test files.

Now I'm mapping out clear file ownership boundaries: the chart component owns HeroViewModel, UsageTimelineSegmentViewModel, UsageCylinder views, I18n helper keys, DashboardViewModel, and their tests.

I should use FormatCardLabel mapping in QuotaRowViewModel instead, and I'm noting the relevant test files to update for this change.

Now I'm pinning down the cross-agent interface contracts: BalanceAmount should only reflect monetary USD values with conversions for CNY and EUR.

Since C1 orders candidates before taking the top six, the initial ProviderSortPolicy ranking matters less — I'll keep it as a stable base.

For cadence-mode gray bars, I'm settling on a weight formula using tokens times overall availability with a minimum floor.`;

// Labelled OLD model: "Let me" opens the reasoning and recurs.
const oldModel = `The directory is empty. Let me create a 3D cyberpunk scene. I'll build a self-contained HTML file with Three.js from a CDN, featuring:

- A neon-lit cyberpunk city scene
- Buildings with glowing windows
- Neon signs
- Rain (particles)
- Fog / atmosphere

I'll create a single HTML file that uses Three.js via CDN import map. Let me make it really impressive with:

1. Neon grid floor
2. Procedural buildings with emissive windows
3. Neon signs (billboards)
4. Rain particles

Let me write a comprehensive, polished single-file scene. I'll use ES modules with import maps pointing to unpkg or jsdelivr CDN.

Let me use three.js via CDN. I'll use import map with three@0.160.0 or similar. Actually let me use a version that's stable and has the addons available.`;

// Old model: mid-CoT "I'll", then "Let me" openings later.
const illMidThenLetMe = `The user wants to generate a 3D cyberpunk city. This is a creative coding task.

I'll create a single HTML file with Three.js from CDN that renders a procedural city.

Let me build a nice complete scene. I'll use Three.js via CDN.

Let me write it carefully.`;

// Old model whose only "Let me" is the FINAL paragraph.
const letMeLastParagraph = `The user wants me to make a 3D cyberpunk scene.

I should:
1. Check the working directory structure
2. Understand the existing project

Let me start by listing files and reading package.json.`;

const opensWithIll = `I'll work through the constraints in order before writing anything.

For the second case the ordering matters, so I need to check it separately.

I am fairly confident the third branch is unreachable.`;

const englishQuotingChinese = `The user asks in Chinese: 三十四乘以二十七等于多少 — I need to compute that product.

I'm going to multiply it out in two parts and check the result.

I think the answer is straightforward once split into tens and units.

For clarity I have shown both partial products.`;

const chineseThinking = `用户想知道三十四乘以二十七等于多少。我需要一步一步计算。

先算三十四乘以二十，得到六百八十。然后算三十四乘以七。`;

// Old model: first-person plural openings. "We need" / "We will" are not
// rollout signals — the new model uses "I", not "we".
const weNeedOpenings = `We need to split this into two patches so the chart work stays isolated.

We will keep the first change scoped to the view models only.

We should also update the tests for the money path.

We're going to leave the ranking as a stable base.`;

// Single blob, no newlines — the live UI case: 700 chars of "We need…"
// with 0 paragraphs on screen because streaming used to drop the only one.
const weNeedBlob = 'We need respond in Chinese. User asks "做一个 3D 赛博朋克场景" meaning make a 3D cyberpunk scene. We need infer they want app in current directory. We can create HTML/JS.';

const blandFinished = `The user wants a 3D cyberpunk scene. This is a creative coding task in the current working directory as a single HTML file.`;

const cases = [
  ['LABELLED new model', newModel, 'keep'],
  ['LABELLED old model', oldModel, 'discard'],
  ['mid-CoT I-will, Let me later', illMidThenLetMe, 'discard'],
  ['Let me only in final paragraph', letMeLastParagraph, 'discard'],
  ['CoT opening with I-will', opensWithIll, 'keep'],
  ['English quoting Chinese', englishQuotingChinese, 'keep'],
  ['reasoning in Chinese', chineseThinking, 'discard'],
  ['We need / We will openings', weNeedOpenings, 'discard'],
  ['single-blob We need (no newlines)', weNeedBlob, 'discard'],
  ['finished with no I/we signal', blandFinished, 'discard'],
];

let failed = 0;
for (const [name, text, expected] of cases) {
  const got = verdict(text);
  const r = classify(text, true);
  const ok = got === expected;
  if (!ok) failed += 1;
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${got.padEnd(12)} want ${expected.padEnd(12)}`,
    `paras=${String(r.paragraphs).padEnd(3)} +${r.positive} -${r.negative}`,
    `score=${r.score.toFixed(2)} zh=${Math.round(chineseShare(text) * 100)}%  ${name}`,
  );
}
const liveBlob = classify(weNeedBlob, false);
if (liveBlob.paragraphs !== 1 || liveBlob.decisive !== 'old' || liveBlob.negative < 1) {
  failed += 1;
  console.log(
    `FAIL  streaming blob  paras=${liveBlob.paragraphs} decisive=${liveBlob.decisive} -${liveBlob.negative}  want paras=1 decisive=old negative>=1`,
  );
} else {
  console.log('PASS  streaming We-need blob is classified before the turn ends');
}

const shortLive = classify('We need', false);
if (shortLive.paragraphs !== 0) {
  failed += 1;
  console.log(`FAIL  short streaming opening counted paras=${shortLive.paragraphs} want 0`);
} else {
  console.log('PASS  streaming opening withheld until 48 characters');
}

const weHits = classify(weNeedOpenings, true).hits;
for (const [phrase, hit] of Object.entries(weHits)) {
  if (!hit || hit.sign !== 'neg') {
    failed += 1;
    console.log(`FAIL  hit "${phrase}" sign=${hit && hit.sign} want neg`);
  } else {
    console.log(`PASS  hit "${phrase}" ×${hit.count} sign=neg`);
  }
}

console.log(`\n${cases.length - failed}/${cases.length} passed`);
process.exit(failed === 0 ? 0 : 1);
