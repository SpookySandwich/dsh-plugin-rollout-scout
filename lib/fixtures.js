// Hand-labelled chains-of-thought, kept where both the test and the console
// can reach them. The console runs them through the shipped classifier so a
// run can be checked against known answers without spending a probe — which
// is the only way to tell "found nothing" apart from "cannot find anything".

export const newModel = `To avoid conflicts, I'll keep I18n.cs edits solely under one change and handle any additional edits separately if needed. I'm also noting the Antigravity dead catalog rules as report-only, and fixing the EffectiveValue credits hijack via a monetary-only BalanceAmount.

I've spotted a bigger conflict: HeroViewModelTests.cs is touched by both the chart work and the value-mode test changes, so I'm resolving this by having the chart-related change own the entire HeroViewModel.cs and HeroViewModelTests.cs files, including the value-mode updates.

Meanwhile, the money-related change should own the Core money files—ProviderPriority.cs, ProviderMoney.cs, Catalog.cs, the new CurrencyRates.cs, and various provider files—along with their corresponding test files.

Now I'm mapping out clear file ownership boundaries: the chart component owns HeroViewModel, UsageTimelineSegmentViewModel, UsageCylinder views, I18n helper keys, DashboardViewModel, and their tests.

I should use FormatCardLabel mapping in QuotaRowViewModel instead, and I'm noting the relevant test files to update for this change.

Now I'm pinning down the cross-agent interface contracts: BalanceAmount should only reflect monetary USD values with conversions for CNY and EUR.

Since C1 orders candidates before taking the top six, the initial ProviderSortPolicy ranking matters less — I'll keep it as a stable base.

For cadence-mode gray bars, I'm settling on a weight formula using tokens times overall availability with a minimum floor.`;

// Labelled OLD model: "Let me" opens the reasoning and recurs.
export const oldModel = `The directory is empty. Let me create a 3D cyberpunk scene. I'll build a self-contained HTML file with Three.js from a CDN, featuring:

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
export const illMidThenLetMe = `The user wants to generate a 3D cyberpunk city. This is a creative coding task.

I'll create a single HTML file with Three.js from CDN that renders a procedural city.

Let me build a nice complete scene. I'll use Three.js via CDN.

Let me write it carefully.`;

// Old model whose only "Let me" is the FINAL paragraph.
export const letMeLastParagraph = `The user wants me to make a 3D cyberpunk scene.

I should:
1. Check the working directory structure
2. Understand the existing project

Let me start by listing files and reading package.json.`;

export const opensWithIll = `I'll work through the constraints in order before writing anything.

For the second case the ordering matters, so I need to check it separately.

I am fairly confident the third branch is unreachable.`;

export const englishQuotingChinese = `The user asks in Chinese: 三十四乘以二十七等于多少 — I need to compute that product.

I'm going to multiply it out in two parts and check the result.

I think the answer is straightforward once split into tens and units.

For clarity I have shown both partial products.`;

export const chineseThinking = `用户想知道三十四乘以二十七等于多少。我需要一步一步计算。

先算三十四乘以二十，得到六百八十。然后算三十四乘以七。`;

// Old model: first-person plural openings. "We need" / "We will" are not
// rollout signals — the new model uses "I", not "we".
export const weNeedOpenings = `We need to split this into two patches so the chart work stays isolated.

We will keep the first change scoped to the view models only.

We should also update the tests for the money path.

We're going to leave the ranking as a stable base.`;

// Single blob, no newlines — the live UI case: 700 chars of "We need…"
// with 0 paragraphs on screen because streaming used to drop the only one.
export const weNeedBlob = 'We need respond in Chinese. User asks "做一个 3D 赛博朋克场景" meaning make a 3D cyberpunk scene. We need infer they want app in current directory. We can create HTML/JS.';

export const blandFinished = `The user wants a 3D cyberpunk scene. This is a creative coding task in the current working directory as a single HTML file.`;

// The live false-keep: opens like the rollout model, then "Let me" appears.
export const illFirstThenLetMe = `I'll work through this in a single HTML file with Three.js from a CDN.

Let me start by setting up the scene and the camera.

Let me add the earth mesh next.`;

// Observed new-model CoT: long first-person planning, "For"/"I'll"/"I'm"
// openings, and a trailing "Let me start writing the file" that is NOT a
// paragraph opening. Must keep — that Let me must not flip the verdict.
export const newModelLetMeInBody = `For mode A N=10 or 20, I'll simulate the linear plant using the structural matrices.

For mode B's eigenvalues, I'm using a Jacobi eigensolver on dense matrices up to 65×65.

The key insight is that the full plant is not diagonalized—it's represented in the original coordinate system.

For the convergence analysis, I'm running independent simulations for N=8, 16, 32, and 64.

For the UI, I'm adding a convergence results panel with a small table and a bar chart.

For the control period and integration step, I'm using 5 ms and 1 ms respectively.

Now I'm setting up the UI layout with a top bar for mode selection and status, a left panel for simulation. I'm keeping the height and width sensible for 1080p and 4K displays with responsive CSS. Let me start writing the file in two parts, beginning with the physics core and self-tests, then running the Node tests.`;

// Observed summariser CoT: starts "We need to build…" then even I'll/I'm
// paragraphs. Must keep — that opening we is the summariser restating the
// task, not the old model's voice.
export const weNeedThenIll = `We need to build a single-page HTML demo of a black hole with physically accurate ray tracing using the Schwarzschild metric to simulate gravitational lensing around the event horizon.

I'll integrate the geodesic equation using RK4 steps, checking at each step whether the ray crosses the disk, reaches the horizon, or escapes to the sky.

Now I'm turning to the disk emission model, using the standard Shakura-Sunyaev temperature profile for a thin Keplerian accretion disk.

For the observed redshift, I need to account for both gravitational and Doppler effects in the Schwarzschild geometry.

Now I'm checking the formula g = sqrt(1 - 3M/r) / (1 - Ω * b_axial) where b_axial is the normalized axial angular momentum.`;

export const FIXTURES = [
  { id: 'newModel', title: 'LABELLED new model', label: 'rollout', text: newModel },
  { id: 'oldModel', title: 'LABELLED old model', label: 'old', text: oldModel },
  { id: 'illMidThenLetMe', title: 'mid-CoT I-will, Let me later', label: 'old', text: illMidThenLetMe },
  { id: 'letMeLastParagraph', title: 'Let me only in final paragraph', label: 'old', text: letMeLastParagraph },
  { id: 'opensWithIll', title: 'CoT opening with I-will', label: 'rollout', text: opensWithIll },
  { id: 'englishQuotingChinese', title: 'English quoting Chinese', label: 'rollout', text: englishQuotingChinese },
  { id: 'chineseThinking', title: 'reasoning in Chinese', label: 'old', text: chineseThinking },
  { id: 'weNeedOpenings', title: 'We need / We will openings', label: 'old', text: weNeedOpenings },
  { id: 'weNeedBlob', title: 'single-blob We need (no newlines)', label: 'old', text: weNeedBlob },
  { id: 'blandFinished', title: 'finished with no I/we signal', label: 'old', text: blandFinished },
  { id: 'illFirstThenLetMe', title: 'I-will first, Let me later', label: 'old', text: illFirstThenLetMe },
  { id: 'newModelLetMeInBody', title: 'new model with Let me only in paragraph body', label: 'rollout', text: newModelLetMeInBody },
  { id: 'weNeedThenIll', title: 'rollout CoT that opens We need then I-voice', label: 'rollout', text: weNeedThenIll },
];
