// Regenerate the README console screenshots.
//
// Renders the real `lib/client.js` bundle in headless Chrome against a stubbed
// route, so the images track the shipped UI instead of drifting from it. The
// probe cards are staged; the self-check numbers are not — they come from the
// actual classifier via `selfCheck`, so a screenshot cannot claim a detection
// rate the code does not produce.
//
//   node scripts/shoot.mjs
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'assets');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'rollout-shot-'));

const REACT_DIR = path.join(os.homedir(), '.dsh/profiles/node_modules');
const react = path.join(REACT_DIR, 'react/umd/react.production.min.js');
const reactDom = path.join(REACT_DIR, 'react-dom/umd/react-dom.production.min.js');
for (const f of [react, reactDom]) {
  if (!fs.existsSync(f)) throw new Error(`missing ${f} — needs a DSH profile installed`);
}

const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].find((p) => fs.existsSync(p));
if (CHROME === undefined) throw new Error('no Chrome or Edge found');

const { selfCheck } = await import('../lib/index.js');
const report = selfCheck({ folder: path.join(os.homedir(), 'rollout-scout') });

/** blendedScore's formula, so the meter always agrees with the chips beside it. */
function blended({ positive = 0, negative = 0, regular = false, pauses = 0 }) {
  const extra = (regular ? 1 : 0) + (pauses >= 1 ? 1 : 0);
  return (positive + extra + 1) / (positive + negative + extra + 2);
}

/** A run mid-flight: mostly old-model probes, one catch, one still undecided. */
function attempt(over) {
  return {
    id: 1, sessionId: 's', status: 'streaming', verdict: null,
    decisive: null, reason: null, paragraphs: 0, positive: 0, negative: 0,
    hits: {}, chinese: false, chars: 0, startedAt: 0, endedAt: null,
    deleted: false, error: null, preview: '', regular: false, pauses: 0,
    pinned: false, held: false, tps: null, ttft: null, protected: false,
    kept: false, title: null, ...over,
  };
}

const attempts = [
  // The rollout model's usual signature is first-person singular. Four of the
  // five labelled catches open that way; only one opens "We need", so the hero
  // card shows the common case and the second shows the summariser exception.
  attempt({
    id: 14, sessionId: 's14', status: 'kept', verdict: 'rollout',
    reason: 'score', paragraphs: 6, positive: 4, negative: 0, chars: 1840,
    hits: { "I'll": { count: 2, sign: 'pos' }, "I'm": { count: 1, sign: 'pos' }, 'I need': { count: 1, sign: 'pos' } },
    regular: true, pauses: 2, tps: 46.2, ttft: 4.1, protected: true, kept: true,
    title: null, catchTitle: true,
    preview: "To avoid conflicts, I'll keep the integrator separate from the shader so each can be checked on its own. I'm treating the lensing pass as the risky part, so that one goes first.",
  }),
  attempt({
    id: 13, sessionId: 's13', status: 'kept-streaming', verdict: 'rollout',
    reason: 'shape', paragraphs: 4, positive: 3, negative: 1, chars: 906,
    regular: true, pauses: 1, tps: 48.9, ttft: 3.6,
    hits: { "I'll": { count: 1, sign: 'pos' }, 'I need': { count: 1, sign: 'pos' }, 'We need': { count: 1, sign: 'neg' } },
    preview: "We need to build a single-page demo with physically accurate ray tracing. I'll lay out the constraints first, then decide which parts can be done in one pass.",
  }),
  attempt({
    id: 12, sessionId: 's12', status: 'streaming', verdict: null,
    paragraphs: 3, positive: 0, negative: 2, chars: 604, tps: 58.4, ttft: 2.9,
    hits: { 'We need': { count: 1, sign: 'neg' }, "Let's": { count: 1, sign: 'neg' } },
    preview: "We need to figure out what they want here. We can probably get away with a single file, but let's check the directory first.",
  }),
  attempt({
    id: 11, sessionId: 's11', status: 'streaming', verdict: null,
    paragraphs: 1, positive: 0, negative: 0, chars: 148, tps: 44.1, ttft: 5.2,
    hits: {},
    preview: 'Considering how much of the pipeline actually needs to be drawn before the diagram stops being useful.',
  }),
  attempt({
    id: 10, sessionId: 's10', status: 'starting', verdict: null,
    paragraphs: 0, chars: 0, preview: '',
  }),
  // Discarded probes are filtered out of the queue but still counted, so the
  // stat row has to see them or the tiles do not add up.
  ...Array.from({ length: 8 }, (_, i) => attempt({
    id: 9 - i, sessionId: 'd' + i, status: 'discarded', verdict: 'old',
    score: 0, reason: 'decisive', decisive: 'old', chars: 300,
  })),
].map((a) => (a.score === undefined ? { ...a, score: blended(a) } : a));


const state = {
  running: true, paused: false, launched: 14, note: null, lastError: null,
  active: 4, blocking: 3, attempts,
  notifications: { registered: true, enabled: false, onTurnCompletion: true },
  orphans: { live: 0, cold: 0, at: Date.now() }, protectedCount: 1,
  culled: 0, reaped: 0,
  config: {
    prompt: 'Build a single-page visualisation of GPU microarchitecture.',
    concurrency: 4, provider: 'deepseek-official', model: 'deepseek-v4-pro',
    reasoningEffort: 'high', folder: 'C:\\Users\\you\\rollout-scout',
    discardBelow: 0.35, keepAbove: 0.7, minOpenings: 4, paragraphWindow: 10,
    autoPauseOnMatch: false, discardChinese: true, chineseShare: 0.8,
    autoDelete: false, discardAboveTps: true, maxTps: 60,
    discardBelowTtft: true, minTtft: 2, locale: 'en',
  },
};

function page(locale) {
  const title = locale === 'zh' ? '★ 灰度命中 14 · 88%' : '★ Rollout catch 14 · 88%';
  const staged = {
    ...state,
    config: { ...state.config, locale },
    attempts: state.attempts.map((a) => (a.catchTitle ? { ...a, title } : a)),
  };
  return `<!doctype html><html lang="${locale}"><head><meta charset="utf-8">
<style>
  /* DSH's dark design tokens, read out of dsh-client-ui-theme. Most of the
   * plugin's colour rules reference these WITHOUT a fallback, which is correct
   * inside the app but resolves to unset here - the text then inherits and
   * renders black on black. The screenshot has to supply what the shell does. */
  :root{
    --dsw-alias-label-primary:#f9fafb;
    --dsw-alias-label-secondary:#cfd3d6;
    --dsw-alias-label-tertiary:#adb2b8;
    --dsw-alias-bg-base:#151517;
    --dsw-alias-bg-primary:#1b1b1c;
    --dsw-alias-interactive-bg-hover:#ffffff14;
    --dsw-alias-accent-primary:#4b8dff;
    --dsw-alias-status-error:#e5484d;
    --dsw-specific-sidebar-fill:#1b1b1c;
    --dsw-specific-sidebar-nav-item-active:#43454a;
  }
  html,body{height:100%;margin:0;background:#151517;font-family:Inter,-apple-system,"Segoe UI",system-ui,"Microsoft YaHei",sans-serif}
  #root{height:100%}
  /* Screenshots must not depend on when the capture lands: without this the
   * entry animation and the button transitions paint mid-flight, and the two
   * locales come out with different button fills from the same state. */
  *,*::before,*::after{animation:none!important;transition:none!important}
</style></head><body><div id="root"></div>
<script src="${new URL('file://' + react.replace(/\\/g, '/'))}"></script>
<script src="${new URL('file://' + reactDom.replace(/\\/g, '/'))}"></script>
<script>
  const STATE = ${JSON.stringify(staged)};
  const REPORT = ${JSON.stringify(report)};
  window.fetch = function (url, init) {
    const body = init && init.body ? JSON.parse(init.body) : null;
    const value = body && body.action === 'self-check' ? REPORT : STATE;
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(value) });
  };
  window.__ModuleLoader__ = { load(mod) { window.__mod = mod; } };
</script>
<script src="${new URL('file://' + path.join(root, 'lib/client.js').replace(/\\/g, '/'))}"></script>
<script>
  const plugin = window.__mod.factory(function (name) {
    if (name === 'react') return React;
    if (name === 'react-dom') return ReactDOM;
    throw new Error('no ' + name);
  });
  const seats = {};
  const ctx = {
    effect(fn) { return fn(); },
    get(service) {
      if (service === 'slots') {
        return {
          inject(_name, fn) { return fn(); },
          register(spec, Component) { seats[spec.name] = Component; return function () {}; },
        };
      }
      if (service === 'locale') {
        return {
          register() { return function () {}; },
          bind(ns) {
            return function (key, params) {
              const dict = window.__I18N && window.__I18N[${JSON.stringify(locale)}];
              let outv = (dict && dict[key] !== undefined) ? dict[key] : key;
              if (params) for (const k in params) outv = outv.replace('{' + k + '}', String(params[k]));
              return outv;
            };
          },
        };
      }
      return undefined;
    },
  };
  plugin.apply(ctx);
  const root = ReactDOM.createRoot(document.getElementById('root'));
  root.render(React.createElement(function () {
    return React.createElement('div', null,
      React.createElement(seats['sidebar.footer.action'], {}),
      React.createElement(seats['shell.overlay'], {}));
  }));
  setTimeout(function () {
    const seat = document.querySelector('.rsc-seat');
    if (seat) seat.click();
    setTimeout(function () { document.title = 'ready'; }, 700);
  }, 250);
</script></body></html>`;
}

// The plugin keeps its dictionaries inside apply(); expose them for the stub.
const clientSource = fs.readFileSync(path.join(root, 'lib/client.js'), 'utf8');
const patched = clientSource.replace(
  'let t = function (key, params) {',
  'window.__I18N = I18N;\n    let t = function (key, params) {',
);
fs.writeFileSync(path.join(root, 'lib/client.js'), patched);

const shots = [['en', 'console.png'], ['zh', 'console-zh.png']];
try {
  for (const [locale, file] of shots) {
    const html = path.join(work, `${locale}.html`);
    fs.writeFileSync(html, page(locale));
    execFileSync(CHROME, [
      '--headless=new', '--disable-gpu', '--hide-scrollbars',
      '--force-device-scale-factor=2',
      '--virtual-time-budget=4000',
      '--window-size=1360,860',
      `--screenshot=${path.join(work, file)}`,
      `file:///${html.replace(/\\/g, '/')}`,
    ], { stdio: 'pipe' });
    fs.copyFileSync(path.join(work, file), path.join(out, file));
    const bytes = fs.statSync(path.join(out, file)).size;
    console.log(`wrote assets/${file} (${(bytes / 1024).toFixed(0)} KB)`);
  }
} finally {
  fs.writeFileSync(path.join(root, 'lib/client.js'), clientSource);
}
