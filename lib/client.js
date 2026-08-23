window.__ModuleLoader__.load({
  id: 'dsh-plugin-rollout-scout',
  factory: (require) => {
    const React = require('react');
    const styles = {
      insert(css) {
        if (typeof document === 'undefined') return function () {};
        const prev = document.querySelector('style[data-plugin="dsh-plugin-rollout-scout"]');
        if (prev) {
          prev.textContent = css;
          return function () { prev.remove(); };
        }
        const tag = document.createElement('style');
        tag.dataset.plugin = 'dsh-plugin-rollout-scout';
        tag.textContent = css;
        document.head.appendChild(tag);
        return function () { tag.remove(); };
      }
    };
    return (function () {
// dsh-plugin-rollout-scout — client half.
//
// A full-frame console that drives the host's probe loop: enter a prompt,
// pick model / concurrency / folder, press Start, and watch probes stream.
// Each probe carries a live rollout confidence built from how its paragraphs
// open; probes that read as the old model are cancelled mid-thought, and
// confident catches are kept. Start toggles to Pause, which stops launching
// while letting live probes finish, and back to Resume.

const ROUTE = '/rollout-scout';
const POLL_MS = 800;

// The shell's own icon set, so the sidebar row reads as part of the app rather
// than as a plugin bolted on. Optional: an inline glyph stands in if the
// package is not resolvable from the plugin sandbox.
let primitives = null;
try {
  if (typeof require === 'function') primitives = require('@deepseek-ai/dsh-client-ui-primitives');
} catch (e) {}

// The console covers the whole window, so it is mounted on <body> rather than
// left inside the shell's overlay layer. `position:fixed` resolves against the
// viewport only while no ancestor establishes a containing block — a single
// transform, filter, contain or container-type anywhere above it silently
// re-anchors the surface to that element's box and it stops short of the
// window edge. Portalling removes the dependency instead of tracking it.
let reactDom = null;
try {
  if (typeof require === 'function') reactDom = require('react-dom');
} catch (e) {}

function realGlobal() {
  try { if (typeof window !== 'undefined' && window) return window; } catch (e) {}
  try { if (typeof globalThis !== 'undefined' && globalThis) return globalThis; } catch (e) {}
  return null;
}

async function api(method, body) {
  const g = realGlobal();
  const res = await g.fetch(ROUTE, method === 'GET' ? { cache: 'no-store' } : {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body),
  });
  const value = await res.json().catch(function () { return {}; });
  if (!res.ok) throw new Error(value.error || ('HTTP ' + res.status));
  return value;
}

const FORM_KEY = 'dsh-plugin-rollout-scout:form';
// Rides in the same saved form blob as the rest of the console's preferences.
const QUIET_KEY = 'preflightDismissed';

function loadForm() {
  const g = realGlobal();
  try {
    const raw = g && g.localStorage && g.localStorage.getItem(FORM_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (e) {
    return {};
  }
}

function saveForm(form) {
  const g = realGlobal();
  try { if (g && g.localStorage) g.localStorage.setItem(FORM_KEY, JSON.stringify(form)); } catch (e) {}
}

// Statuses where the probe can still be discarded, so hovering it is
// meaningful. Hover on any other card is just a mouse passing over a
// finished row and must not generate traffic.
const RESCUABLE = {
  starting: true,
  streaming: true,
  'kept-streaming': true,
  'pending-discard': true,
};

const STATUS_TONE = {
  starting: 'wait',
  streaming: 'wait',
  'kept-streaming': 'good',
  kept: 'good',
  'pending-discard': 'bad',
  pinned: 'wait',
  discarding: 'bad',
  discarded: 'bad',
  finished: 'neutral',
  stopped: 'neutral',
  error: 'bad',
};

function pct(score) {
  return Math.round((typeof score === 'number' ? score : 0.5) * 100);
}

const CSS = [
  /* -- sidebar seat ------------------------------------------------------ *
   * Geometry is copied from the shell's own Settings trigger row so the two
   * sit flush at the sidebar foot: same height, radius, gap and negative
   * margins in the wide column, same 36px circle in the 56px rail.
   *
   * Tracked against dsh 0.1.1-rc.2. That row was 34px tall with different
   * insets in 0.1.0-rc.x, so on an older harness this sits a few pixels
   * short of Settings — cosmetic, and it corrects itself on upgrade.       */
  '.rsc-seat{box-sizing:border-box;cursor:pointer;width:calc(100% + 4px);height:42px;color:var(--dsw-alias-label-primary);background:0 0;border:none;border-radius:12px;flex:none;align-items:center;gap:8px;margin:4px -2px;padding:0 10px 0 8px;font-family:inherit;font-size:14px;line-height:22px;display:flex;overflow:hidden}',
  '.rsc-seat:hover{background:var(--dsw-alias-interactive-bg-hover)}',
  '.rsc-seat[data-rail]{border-radius:50%;justify-content:center;gap:0;width:36px;height:36px;margin:8px 0 10px;padding:0}',
  '.rsc-seat[data-open]{background:var(--dsw-specific-sidebar-nav-item-active,var(--dsw-alias-interactive-bg-hover))}',
  '.rsc-seat-icon{flex:none;position:relative;display:inline-flex;align-items:center;justify-content:center}',
  '.rsc-seat-label{flex:1;min-width:0;text-align:left;white-space:nowrap;overflow:hidden}',
  '.rsc-seat-meta{flex:none;font-size:11.5px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums;white-space:nowrap}',
  /* The rail hides the label, so the run has to read from the icon alone. */
  '.rsc-pip{position:absolute;top:-2px;right:-3px;width:7px;height:7px;border-radius:50%;box-shadow:0 0 0 2px var(--dsw-specific-sidebar-fill,#1e1e22)}',
  '.rsc-pip[data-tone=live]{background:var(--dsw-alias-accent-primary,#4b8dff);animation:rsc-pulse 1.4s ease-in-out infinite}',
  '.rsc-pip[data-tone=paused]{background:var(--dsw-alias-label-secondary,#bbb)}',
  '.rsc-pip[data-tone=caught]{background:#3fbf6f}',
  '@keyframes rsc-pulse{0%,100%{opacity:1}50%{opacity:.35}}',
  '.rsc-seat-badge{flex:none;min-width:17px;height:17px;padding:0 5px;border-radius:999px;background:#3fbf6f;color:#04210f;font-size:11px;font-weight:700;display:inline-flex;align-items:center;justify-content:center}',

  /* -- full-frame surface ------------------------------------------------ */
  '.rsc-full{position:fixed;inset:0;z-index:70;display:flex;flex-direction:column;background:color-mix(in srgb,var(--dsw-alias-bg-primary,#16161a) 94%,transparent);-webkit-backdrop-filter:blur(30px) saturate(1.4);backdrop-filter:blur(30px) saturate(1.4);color:var(--dsw-alias-label-primary);font-size:13px;animation:rsc-in 260ms cubic-bezier(.32,.72,0,1) both}',
  '@keyframes rsc-in{from{opacity:0;transform:scale(.99)}to{opacity:1;transform:none}}',
  /* DSH Desktop uses Electron's Windows title-bar overlay. The native window
   * buttons therefore sit over the renderer instead of taking layout space.
   * Electron exposes the unobstructed title-bar rectangle through these env()
   * values; derive the occupied strip from it and keep the normal 22px inset
   * as breathing room. Browsers and non-overlay shells take the fallbacks. */
  '.rsc-top{display:flex;align-items:center;gap:14px;padding:16px max(22px,calc(100vw - env(titlebar-area-x,0px) - env(titlebar-area-width,100vw) + 22px)) 16px 22px;border-bottom:1px solid color-mix(in srgb,var(--dsw-alias-label-tertiary,#888) 22%,transparent)}',
  '.rsc-h1{font-size:16px;font-weight:600}',
  '.rsc-sub{font-size:12.5px;color:var(--dsw-alias-label-tertiary);flex:1}',
  '.rsc-x{width:30px;height:30px;border:0;border-radius:9px;background:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer;font-size:15px}',
  '.rsc-x:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
  '.rsc-cols{flex:1;display:flex;min-height:0}',
  '.rsc-leftwrap{width:340px;flex:none;min-height:0;display:flex;flex-direction:column;border-right:1px solid color-mix(in srgb,var(--dsw-alias-label-tertiary,#888) 18%,transparent)}',
  '.rsc-left{flex:1;min-height:0;overflow-y:auto;padding:18px 20px 30px;display:flex;flex-direction:column;gap:13px}',
  '.rsc-right{flex:1;min-width:0;overflow-y:auto;padding:18px 22px 30px}',

  /* -- form -------------------------------------------------------------- */
  '.rsc-label{font-size:11.5px;color:var(--dsw-alias-label-tertiary);margin-bottom:4px;display:block}',
  '.rsc-input,.rsc-select,.rsc-area{width:100%;box-sizing:border-box;border-radius:9px;border:1px solid color-mix(in srgb,var(--dsw-alias-label-tertiary,#888) 30%,transparent);background:color-mix(in srgb,var(--dsw-alias-label-tertiary,#888) 8%,transparent);color:var(--dsw-alias-label-primary);font:inherit;font-size:12.5px;padding:7px 9px;outline:none}',
  '.rsc-input:focus,.rsc-select:focus,.rsc-area:focus{border-color:var(--dsw-alias-accent-primary,#4b8dff)}',
  '.rsc-area{min-height:74px;resize:vertical;line-height:19px}',
  '.rsc-row{display:flex;gap:9px}',
  '.rsc-row>*{flex:1;min-width:0}',
  '.rsc-check{display:flex;align-items:flex-start;gap:8px;cursor:pointer;font-size:12.5px;line-height:17px}',
  '.rsc-check input{margin-top:1px;accent-color:var(--dsw-alias-accent-primary,#4b8dff)}',
  '.rsc-check-input{display:flex;align-items:center;gap:8px;font-size:12.5px;line-height:17px}',
  '.rsc-check-input .rsc-check{flex:1;min-width:0}',
  '.rsc-check-input .rsc-input{width:68px;flex:none;padding:4px 7px;font-size:12px}',
  '.rsc-unit{font-size:11.5px;color:var(--dsw-alias-label-tertiary);flex:none}',
  /* Scoring takes four numbers; at 340px a single row wraps their labels and
   * knocks the inputs out of alignment, so they pair off instead. */
  '.rsc-grid2{display:grid;grid-template-columns:1fr 1fr;gap:9px}',
  '.rsc-selfcheck{font-size:11.5px;padding:7px 10px;border-radius:9px;cursor:pointer;background:color-mix(in srgb,#3fbf6f 14%,transparent);color:#3fbf6f}',
  '.rsc-selfcheck[data-bad]{background:color-mix(in srgb,#e5a23d 16%,transparent);color:#e5a23d}',
  '.rsc-selfcheck-rows{margin-top:7px;display:flex;flex-direction:column;gap:3px;font-size:11px;color:var(--dsw-alias-label-tertiary)}',
  '.rsc-selfcheck-row{display:flex;gap:7px;align-items:baseline}',
  '.rsc-selfcheck-row>span:first-child{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
  '.rsc-selfcheck-row[data-miss]{color:var(--dsw-alias-status-error,#e5484d)}',
  '.rsc-selfcheck-row b{font-variant-numeric:tabular-nums;font-weight:600}',
  /* Actions sit below the scroll, always reachable, ordered by weight: the
   * primary action alone on top, the two run controls beside it, and the
   * destructive one as text rather than a third slab competing for the eye. */
  '.rsc-foot{flex:none;border-top:1px solid color-mix(in srgb,var(--dsw-alias-label-tertiary,#888) 18%,transparent);padding:12px 20px 14px;display:flex;flex-direction:column;gap:8px;background:inherit}',
  '.rsc-actions{display:flex;gap:9px;margin-top:3px}',
  '.rsc-btn[data-wide]{width:100%;flex:none;padding:10px 0;font-size:13.5px;font-weight:600}',
  '.rsc-btn[data-quiet]{border-color:transparent;background:color-mix(in srgb,var(--dsw-alias-label-tertiary,#888) 12%,transparent)}',
  '.rsc-btn[data-quiet]:hover{background:color-mix(in srgb,var(--dsw-alias-label-tertiary,#888) 22%,transparent)}',
  '.rsc-textbtn{align-self:flex-start;border:0;background:0 0;padding:2px 0;font:inherit;font-size:11.5px;color:var(--dsw-alias-label-tertiary);cursor:pointer;text-decoration:underline;text-underline-offset:3px}',
  '.rsc-textbtn:hover:not([disabled]){color:var(--dsw-alias-status-error,#e5484d)}',
  '.rsc-textbtn[disabled]{opacity:.45;cursor:default}',
  /* Long explanations and rarely-touched switches fold away instead of
   * sitting between the controls they describe. */
  '.rsc-fold{border-radius:9px;background:color-mix(in srgb,var(--dsw-alias-label-tertiary,#888) 7%,transparent)}',
  '.rsc-fold>summary{cursor:pointer;list-style:none;padding:7px 10px;font-size:11.5px;color:var(--dsw-alias-label-secondary,#bbb)}',
  '.rsc-fold>summary::-webkit-details-marker{display:none}',
  '.rsc-fold>summary:before{content:"▸";display:inline-block;margin-right:6px;transition:transform 140ms ease}',
  '.rsc-fold[open]>summary:before{transform:rotate(90deg)}',
  '.rsc-fold-body{padding:0 10px 10px;display:flex;flex-direction:column;gap:10px}',
  '.rsc-btn{flex:1;padding:9px 0;border-radius:999px;border:1px solid color-mix(in srgb,var(--dsw-alias-label-tertiary,#888) 34%,transparent);background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;cursor:pointer;transition:background 140ms ease}',
  '.rsc-btn:hover{background:var(--dsw-alias-interactive-bg-hover)}',
  '.rsc-btn[data-primary]{background:var(--dsw-alias-accent-primary,#4b8dff);border-color:transparent;color:#fff}',
  '.rsc-btn[data-danger]{border-color:color-mix(in srgb,var(--dsw-alias-status-error,#e5484d) 55%,transparent);color:var(--dsw-alias-status-error,#e5484d)}',
  '.rsc-btn[disabled]{opacity:.45;cursor:default}',
  '.rsc-hint{font-size:11.5px;line-height:16px;color:var(--dsw-alias-label-tertiary)}',
  '.rsc-note{font-size:12px;color:var(--dsw-alias-label-tertiary)}',
  '.rsc-error{font-size:12px;color:var(--dsw-alias-status-error,#e5484d)}',
  '.rsc-sectionhead{font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:var(--dsw-alias-label-tertiary);margin-top:4px}',

  /* -- probe cards ------------------------------------------------------- */
  '.rsc-stats{display:flex;gap:10px;margin-bottom:14px;flex-wrap:wrap}',
  '.rsc-stat{padding:9px 14px;border-radius:12px;background:color-mix(in srgb,var(--dsw-alias-label-tertiary,#888) 10%,transparent);min-width:92px}',
  '.rsc-stat-v{font-size:19px;font-weight:600;font-variant-numeric:tabular-nums}',
  '.rsc-stat-k{font-size:11px;color:var(--dsw-alias-label-tertiary);margin-top:1px}',
  '.rsc-list{display:flex;flex-direction:column;gap:8px}',
  '@keyframes rsc-row-in{from{opacity:0;transform:translateY(-6px)}to{opacity:1;transform:none}}',
  '@keyframes rsc-row-out{from{opacity:1}to{opacity:.18}}',
  '@keyframes rsc-leave-line{from{transform:scaleX(1)}to{transform:scaleX(0)}}',
  '.rsc-item{position:relative;overflow:hidden;animation:rsc-row-in 300ms cubic-bezier(.32,.72,0,1) both;padding:11px 13px;border-radius:12px;background:color-mix(in srgb,var(--dsw-alias-label-tertiary,#888) 8%,transparent);border:1px solid transparent}',
  '.rsc-item[data-leaving]{animation:rsc-row-out 3200ms linear forwards}',
  '.rsc-item[data-leaving]::after{content:"";position:absolute;left:0;right:0;bottom:0;height:2px;background:var(--dsw-alias-status-error,#e5484d);transform-origin:left center;animation:rsc-leave-line 3200ms linear forwards}',
  '.rsc-item[data-tone=good]{border-color:color-mix(in srgb,#3fbf6f 45%,transparent)}',
  '.rsc-item[data-tone=bad]{opacity:.72}',
  '.rsc-item[data-click]{cursor:pointer}',
  '.rsc-item[data-click]:hover{background:color-mix(in srgb,var(--dsw-alias-label-tertiary,#888) 15%,transparent)}',
  '.rsc-item-head{display:flex;align-items:center;gap:9px}',
  '.rsc-item-dot{flex:none;width:8px;height:8px;border-radius:50%}',
  '.rsc-item-dot[data-tone=wait]{background:var(--dsw-alias-accent-primary,#4b8dff);animation:rsc-pulse 1.4s ease-in-out infinite}',
  '.rsc-item-dot[data-tone=good]{background:#3fbf6f}',
  '.rsc-item-dot[data-tone=bad]{background:var(--dsw-alias-status-error,#e5484d)}',
  '.rsc-item-dot[data-tone=neutral]{background:var(--dsw-alias-label-tertiary,#888)}',
  '.rsc-item-name{font-size:13px;font-weight:600;flex:1}',
  '.rsc-item-status{font-size:11.5px;color:var(--dsw-alias-label-tertiary)}',
  '.rsc-badge{font-size:10.5px;padding:2px 9px;border-radius:999px;background:color-mix(in srgb,var(--dsw-alias-label-tertiary,#888) 18%,transparent);color:var(--dsw-alias-label-secondary,#bbb)}',
  '.rsc-badge[data-tone=good]{background:color-mix(in srgb,#3fbf6f 22%,transparent);color:#3fbf6f}',
  '.rsc-badge[data-tone=bad]{background:color-mix(in srgb,var(--dsw-alias-status-error,#e5484d) 18%,transparent);color:var(--dsw-alias-status-error,#e5484d)}',

  /* -- score meter ------------------------------------------------------- */
  '.rsc-score{display:flex;align-items:center;gap:10px;margin-top:9px}',
  '.rsc-meter{position:relative;flex:1;height:7px;border-radius:999px;background:color-mix(in srgb,var(--dsw-alias-label-tertiary,#888) 20%,transparent);overflow:hidden}',
  '.rsc-meter-fill{position:absolute;left:0;top:0;bottom:0;border-radius:999px;transition:width 260ms cubic-bezier(.32,.72,0,1),background 260ms ease}',
  '.rsc-meter-mark{position:absolute;top:-2px;bottom:-2px;width:1px;background:color-mix(in srgb,var(--dsw-alias-label-primary,#fff) 40%,transparent)}',
  '.rsc-score-v{font-size:12.5px;font-weight:600;font-variant-numeric:tabular-nums;min-width:38px;text-align:right}',
  '.rsc-evidence{font-size:11px;color:var(--dsw-alias-label-tertiary);margin-top:5px;display:flex;gap:8px;flex-wrap:wrap}',
  '.rsc-chip{padding:1px 7px;border-radius:999px;background:color-mix(in srgb,var(--dsw-alias-label-tertiary,#888) 16%,transparent)}',
  '.rsc-chip[data-sign=neg]{background:color-mix(in srgb,var(--dsw-alias-status-error,#e5484d) 16%,transparent);color:var(--dsw-alias-status-error,#e5484d)}',
  '.rsc-chip[data-sign=pos]{background:color-mix(in srgb,#3fbf6f 16%,transparent);color:#3fbf6f}',
  '.rsc-prev{font-size:11.5px;line-height:17px;color:var(--dsw-alias-label-tertiary);margin-top:7px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}',
  '.rsc-empty{color:var(--dsw-alias-label-tertiary);padding:40px 0;text-align:center;font-size:13px}',

  /* -- protection + orphans ---------------------------------------------- */
  '.rsc-lock{margin-left:auto;flex:none;border:0;border-radius:7px;padding:2px 7px;font:inherit;font-size:10.5px;cursor:pointer;background:color-mix(in srgb,var(--dsw-alias-label-tertiary,#888) 16%,transparent);color:var(--dsw-alias-label-secondary,#bbb)}',
  '.rsc-lock:hover{background:color-mix(in srgb,var(--dsw-alias-label-tertiary,#888) 28%,transparent)}',
  '.rsc-lock[data-on]{background:color-mix(in srgb,#3fbf6f 22%,transparent);color:#3fbf6f}',
  '.rsc-item[data-locked]{border-color:color-mix(in srgb,#3fbf6f 45%,transparent);opacity:1}',
  '.rsc-banner{display:flex;align-items:center;gap:10px;padding:9px 12px;margin-bottom:12px;border-radius:10px;font-size:12px;background:color-mix(in srgb,var(--dsw-alias-label-tertiary,#888) 12%,transparent)}',
  '.rsc-banner span{flex:1;min-width:0}',
  '.rsc-banner button{flex:none;border:0;border-radius:7px;padding:4px 11px;font:inherit;font-size:11.5px;cursor:pointer;background:var(--dsw-alias-accent-primary,#4b8dff);color:#fff}',
  '.rsc-banner button[disabled]{opacity:.45;cursor:default}',
  '.rsc-rename{margin-top:8px}',

  /* -- pre-flight dialog -------------------------------------------------- */
  '.rsc-scrim{position:fixed;inset:0;z-index:80;display:flex;align-items:center;justify-content:center;background:color-mix(in srgb,#000 45%,transparent);animation:rsc-in 160ms ease both}',
  '.rsc-modal{width:440px;max-width:calc(100vw - 40px);border-radius:16px;padding:22px;background:var(--dsw-alias-bg-primary,#1e1e22);border:1px solid color-mix(in srgb,var(--dsw-alias-label-tertiary,#888) 24%,transparent);box-shadow:0 24px 64px rgba(0,0,0,.45);display:flex;flex-direction:column;gap:13px}',
  '.rsc-modal-h{font-size:15px;font-weight:600}',
  '.rsc-modal-p{font-size:12.5px;line-height:19px;color:var(--dsw-alias-label-secondary,#bbb)}',
  '.rsc-modal-state{display:flex;align-items:center;gap:9px;padding:10px 12px;border-radius:10px;font-size:12px;background:color-mix(in srgb,var(--dsw-alias-label-tertiary,#888) 10%,transparent)}',
  '.rsc-modal-state[data-tone=warn]{background:color-mix(in srgb,#e5a23d 16%,transparent);color:#e5a23d}',
  '.rsc-modal-state[data-tone=ok]{background:color-mix(in srgb,#3fbf6f 15%,transparent);color:#3fbf6f}',
  '.rsc-modal-state span{flex:1;min-width:0}',
  '.rsc-modal-state button{flex:none;border:0;border-radius:7px;padding:4px 11px;font:inherit;font-size:11.5px;cursor:pointer;background:currentColor;color:var(--dsw-alias-bg-primary,#1e1e22)}',
  '.rsc-modal-foot{display:flex;align-items:center;gap:10px;margin-top:2px}',
  '.rsc-modal-foot .rsc-check{flex:1;min-width:0}',
  '.rsc-modal-foot .rsc-btn{flex:none;padding:8px 18px}',
  '.rsc-link{font-size:11.5px;color:var(--dsw-alias-label-tertiary);text-decoration:none}',
  '.rsc-link:hover{color:var(--dsw-alias-label-primary)}',
].join('');

return {
  apply(ctx) {
    const slots = ctx.get('slots');
    if (slots === undefined) return;
    ctx.effect(function () { return styles.insert(CSS); });

    let sessions = null;
    try { sessions = ctx.get('sessions'); } catch (e) {}

    const I18N_NS = 'dsh-plugin-rollout-scout';
    const I18N = {
      en: {
        title: 'Rollout Scout',
        tagline: 'Start throwaway conversations and score their chain-of-thought to find a limited-rollout model.',
        launcher: 'Rollout Scout',
        pillRunning: 'Scouting {active} · {launched} tried',
        pillPaused: 'Paused · {launched} tried',
        pillDone: 'Idle · {launched} tried',
        pillBest: 'Best rollout confidence so far: {score}%',
        seatLive: '{active} live',
        close: 'Close',
        setup: 'Probe setup',
        scoring: 'Scoring',
        prompt: 'Probe prompt',
        promptPlaceholder: 'Ask something that makes it reason at length',
        model: 'Model',
        effort: 'Reasoning effort',
        concurrency: 'Concurrency',
        folder: 'Folder for probe sessions',
        discardBelow: 'Discard below',
        keepAbove: 'Keep above',
        minOpenings: 'Min. openings',
        paragraphWindow: 'Give up after',
        paragraphs: '{count} paragraphs',
        paragraphs_one: '{count} paragraph',
        forceStop: 'Force stop',
        forceStopHint: 'Stop launching and abort every conversation still in flight.',
        discardChinese: 'Discard when the chain-of-thought is mostly Chinese (80%+)',
        chineseCot: 'Chinese CoT',
        scoringHint: '“Let me” opening a paragraph is decisive against. “I’ll” opening the whole chain-of-thought is decisive for. “We need” at the start is only a negative opening — the summariser often restates the task that way, then writes I’ll / I’m in even paragraphs with pauses between bursts.',
        shapeRegular: 'even paragraphs',
        shapeBurst: '{count} pauses',
        shapeBurst_one: '{count} pause',
        reason_shape: 'summariser shape',
        reason_decisive: 'decisive opening',
        reason_score: 'opening score',
        reason_window: 'no positive opening',
        reason_chinese: 'Chinese CoT',
        reason_ended: 'finished without a keep',
        reason_tps: 'high TPS',
        reason_ttft_fast: 'first token too fast',
        discardAboveTps: 'Discard when TPS exceeds',
        tpsUnit: 'chunks/s',
        discardBelowTtft: 'Discard when first token <',
        secUnit: 's',
        timingHint: 'Rollout models generate at ~40–50 chunks/s with distinctive latency. Discarding out-of-range probes saves tokens early.',
        tpsChip: '{tps} chunks/s',
        ttftChip: 'TTFT {ttft}s',
        autoPauseOnMatch: 'Auto-pause on a strong match',
        autoDelete: 'Delete old-model probes from disk',
        start: 'Start',
        pause: 'Pause',
        resume: 'Resume',
        clear: 'Clear finished',
        deleteAll: 'Delete all sessions',
        deleteAllHint: 'Remove every probe conversation from disk — including ones already cleared from this list — and reset numbering to 1.',
        deleteAllBlocked: 'Probes are still live. Force stop first — deleting a session log while its turn is running would corrupt it.',
        effortDefault: 'Provider default',
        statLaunched: 'Launched',
        statActive: 'Live',
        statKept: 'Kept',
        statDiscarded: 'Discarded',
        statBest: 'Best score',
        running: 'Scouting — {active} live, {launched} launched',
        idle: 'Idle',
        noteHit: 'Caught one — launching paused. Press Resume to continue.',
        noteForceStopped: 'Force stopped. Every probe in flight was aborted.',
        notePaused: 'Paused. Live probes will finish on their own; press Resume to keep fishing.',
        noteLaunchFailed: 'Three probes in a row failed to start, so launching stopped. Press Resume to try again. Last error: {error}',
        probe: 'Probe {id}',
        confidence: 'rollout confidence',
        evidenceNone: 'no classified opening yet',
        chars: '{count} chars',
        deleted: 'deleted',
        openSession: 'Click to open this conversation',
        empty: 'No probes yet. Set a prompt and press Start.',
        emptyAllDiscarded: 'All {count} probes so far were discarded. Still fishing.',
        status_stopped: 'stopped',
        verdict_rollout: 'ROLLOUT',
        verdict_old: 'old model',
        verdict_unknown: 'inconclusive',
        status_starting: 'starting',
        status_streaming: 'thinking',
        'status_kept-streaming': 'finishing',
        status_kept: 'kept',
        status_discarding: 'cancelling',
        status_discarded: 'discarded',
        status_finished: 'finished',
        status_error: 'error',
        'status_pending-discard': 'thinking',
        status_pinned: 'watching',
        localeCode: 'en',
        scoringHelp: 'How scoring works',
        selfCheck: 'Self-check {agreed}/{total} · known rollout kept {kept}/{rollout}',
        selfCheckBad: 'Self-check {agreed}/{total} — your thresholds disagree with {n} labelled samples',
        selfCheckHint: 'Runs {total} hand-labelled chains-of-thought through the classifier under the settings above. No tokens, no probes — it is how you can tell "nothing found" apart from "nothing findable".',
        selfCheckWant: 'want',
        protect: 'Keep',
        protectOn: 'Kept',
        protectHint: 'Exempt this conversation from every stop and delete in this console.',
        unprotectHint: 'Kept. Click to hand it back to the ordinary rules.',
        notePausedCulled: 'Paused. {count} probes already judged as the old model were cancelled; the undecided ones run on.',
        noteReaped: 'Swept {count} untracked probe conversations out of the folder.',
        orphans: '{count} probe conversations in this folder are not tracked by this console.',
        orphansLive: '{count} untracked ({live} still running).',
        reap: 'Sweep them',
        reapBusy: 'Stop the run first',
        preflightTitle: 'Before you start',
        preflightBody: 'A run opens one conversation per probe. Probe prompts are sent as plugin messages, so DSH Desktop will not raise a system notification for them — but anything else you have running still will.',
        notifOn: 'Desktop notifications are on.',
        notifOff: 'Desktop notifications are off.',
        notifNone: 'This harness has no desktop notifications.',
        notifMute: 'Turn off',
        dontShowAgain: 'Do not show this again',
        preflightGo: 'Start run',
        cancel: 'Cancel',
        rename: 'Rename',
        renamePrompt: 'Name this conversation',
      },
      zh: {
        title: '灰度侦察',
        tagline: '开启一批临时会话，为它们的思维链打分，用来寻找灰度发布的模型。',
        launcher: '灰度侦察',
        pillRunning: '侦察中 {active} · 已试 {launched}',
        pillPaused: '已暂停 · 已试 {launched}',
        pillDone: '空闲 · 已试 {launched}',
        pillBest: '目前最高灰度置信度：{score}%',
        seatLive: '{active} 个进行中',
        close: '关闭',
        setup: '探测设置',
        scoring: '评分',
        prompt: '探测提示词',
        promptPlaceholder: '写一个能让它充分推理的问题',
        model: '模型',
        effort: '思考强度',
        concurrency: '并发数',
        folder: '探测会话存放目录',
        discardBelow: '低于此分即丢弃',
        keepAbove: '高于此分即保留',
        minOpenings: '最少开头数',
        paragraphWindow: '放弃阈值',
        paragraphs: '{count} 段',
        paragraphs_one: '{count} 段',
        forceStop: '强制停止',
        forceStopHint: '停止发起，并中止所有进行中的会话。',
        discardChinese: '思维链以中文为主（80% 以上）时丢弃',
        chineseCot: '中文思维链',
        scoringHint: '段落以「Let me」开头即判定为旧模型；整条思维链以「I’ll」开头即判定为灰度。开头的「We need」只记负分——总结模型常这样复述任务，随后用规整的 I’ll / I’m 段落、一阵一阵地输出。',
        shapeRegular: '规整段落',
        shapeBurst: '{count} 次停顿',
        shapeBurst_one: '{count} 次停顿',
        reason_shape: '总结链形态',
        reason_decisive: '决定性开头',
        reason_score: '开头评分',
        reason_window: '无正向开头',
        reason_chinese: '中文思维链',
        reason_ended: '结束时未命中',
        reason_tps: 'TPS 过高',
        reason_ttft_fast: '首字过快',
        discardAboveTps: '生成速度 (TPS) 超过上限时丢弃',
        tpsUnit: '字/秒',
        discardBelowTtft: '首字延迟低于下限时丢弃',
        secUnit: '秒',
        timingHint: '灰度模型吐字速度常在 40~50 字/秒且首字延迟有特征，超出范围及早丢弃可大幅节省 Token。',
        tpsChip: '{tps} 字/秒',
        ttftChip: '首字 {ttft}秒',
        autoPauseOnMatch: '命中强匹配时自动暂停',
        autoDelete: '从磁盘删除判为旧模型的会话',
        start: '开始',
        pause: '暂停',
        resume: '继续',
        clear: '清空已结束',
        deleteAll: '删除全部会话',
        deleteAllHint: '从磁盘删除所有探测会话（包括已经从列表清掉的），并把编号从 1 重新计。',
        deleteAllBlocked: '仍有探测在进行中，请先强制停止——删除正在写入的会话文件会损坏它。',
        effortDefault: '服务商默认',
        statLaunched: '已发起',
        statActive: '进行中',
        statKept: '已保留',
        statDiscarded: '已丢弃',
        statBest: '最高分',
        running: '侦察中 — {active} 进行中，已发起 {launched}',
        idle: '空闲',
        noteHit: '已命中——发起已暂停，点击「继续」继续。',
        noteForceStopped: '已强制停止，所有进行中的探测均已中止。',
        notePaused: '已暂停，进行中的探测会自行结束；点击「继续」可继续钓。',
        noteLaunchFailed: '连续三个探测启动失败，已停止发起。点击「继续」重试。最后的错误：{error}',
        probe: '探测 {id}',
        confidence: '灰度置信度',
        evidenceNone: '暂无可分类开头',
        chars: '{count} 字',
        deleted: '已删除',
        openSession: '点击打开该会话',
        empty: '还没有探测。填写提示词后点击「开始」。',
        emptyAllDiscarded: '目前 {count} 个探测全部被丢弃，仍在继续。',
        status_stopped: '已停止',
        verdict_rollout: '灰度',
        verdict_old: '旧模型',
        verdict_unknown: '无法判定',
        status_starting: '启动中',
        status_streaming: '思考中',
        'status_kept-streaming': '收尾中',
        status_kept: '已保留',
        status_discarding: '中止中',
        status_discarded: '已丢弃',
        status_finished: '已结束',
        status_error: '出错',
        'status_pending-discard': '思考中',
        status_pinned: '看着',
        localeCode: 'zh',
        scoringHelp: '评分是怎么算的',
        selfCheck: '自检 {agreed}/{total} · 已知灰度样本保留 {kept}/{rollout}',
        selfCheckBad: '自检 {agreed}/{total} —— 当前阈值与 {n} 条标注样本不一致',
        selfCheckHint: '用上面的设置，把 {total} 条人工标注的思维链跑一遍分类器。不消耗 Token、不发起探测——这是分辨「没找到」和「根本找不到」的办法。',
        selfCheckWant: '应为',
        protect: '保留',
        protectOn: '已保留',
        protectHint: '让这个会话不受本控制台任何停止与删除操作的影响。',
        unprotectHint: '已保留。点击可交回常规规则处理。',
        notePausedCulled: '已暂停。已判定为旧模型的 {count} 个探测已中止；尚未判定的继续跑完。',
        noteReaped: '已清理该目录下 {count} 个未被跟踪的探测会话。',
        orphans: '该目录下有 {count} 个探测会话不在本控制台的跟踪范围内。',
        orphansLive: '{count} 个未跟踪（其中 {live} 个仍在运行）。',
        reap: '清理',
        reapBusy: '请先停止运行',
        preflightTitle: '开始之前',
        preflightBody: '每个探测都会开启一个会话。探测提示词以插件消息发送，因此 DSH Desktop 不会为它们弹出系统通知——但你其它正在跑的会话仍然会。',
        notifOn: '桌面通知已开启。',
        notifOff: '桌面通知已关闭。',
        notifNone: '当前环境没有桌面通知。',
        notifMute: '关闭通知',
        dontShowAgain: '不再提示',
        preflightGo: '开始',
        cancel: '取消',
        rename: '重命名',
        renamePrompt: '为该会话命名',
      },
    };
    let t = function (key, params) {
      let out = I18N.en[key] !== undefined ? I18N.en[key] : key;
      if (params) for (const k in params) out = out.replace('{' + k + '}', String(params[k]));
      return out;
    };
    try {
      const locale = ctx.get('locale');
      if (locale && typeof locale.register === 'function' && typeof locale.bind === 'function') {
        ctx.effect(function () { return locale.register(I18N_NS, I18N); });
        t = locale.bind(I18N_NS);
      }
    } catch (e) {}

    /** English pluralises, Chinese does not; both go through the same key. */
    function n(key, count) {
      return t(count === 1 ? key + '_one' : key, { count: count });
    }

    function Field(props) {
      return React.createElement('div', null,
        React.createElement('span', { className: 'rsc-label' }, props.label),
        props.children
      );
    }

    function scoreColor(score, config) {
      if (config && score >= config.keepAbove) return '#3fbf6f';
      if (config && score <= config.discardBelow) return 'var(--dsw-alias-status-error,#e5484d)';
      return 'var(--dsw-alias-accent-primary,#4b8dff)';
    }

    /** The score meter: fill plus the two threshold marks, so the number is
     *  readable against the rules that will act on it. */
    function ScoreMeter(props) {
      const config = props.config;
      return React.createElement('div', { className: 'rsc-score' },
        React.createElement('div', { className: 'rsc-meter' },
          React.createElement('div', {
            className: 'rsc-meter-fill',
            style: { width: pct(props.score) + '%', background: scoreColor(props.score, config) },
          }),
          config ? React.createElement('div', {
            className: 'rsc-meter-mark', style: { left: pct(config.discardBelow) + '%' },
          }) : null,
          config ? React.createElement('div', {
            className: 'rsc-meter-mark', style: { left: pct(config.keepAbove) + '%' },
          }) : null
        ),
        React.createElement('span', {
          className: 'rsc-score-v',
          style: { color: scoreColor(props.score, config) },
        }, pct(props.score) + '%')
      );
    }

    function AttemptCard(props) {
      const a = props.attempt;
      // Electron's renderer does not implement window.prompt, so naming a
      // catch happens in place on the card.
      const [naming, setNaming] = React.useState(null);
      const tone = STATUS_TONE[a.status] || 'neutral';
      const clickable = !!a.sessionId && !a.deleted && sessions;
      const hits = a.hits || {};
      const hitKeys = Object.keys(hits);
      const leaving = a.status === 'pending-discard' && !a.protected;
      // Rescue only applies while the probe is still cancellable; hover on a
      // finished row must not generate traffic. The hold is released on
      // unmount too — clicking into a conversation closes the console, so
      // mouseleave never fires for that card.
      const rescuable = !!RESCUABLE[a.status] && !a.protected;
      const hovered = React.useRef(false);
      React.useEffect(function () {
        return function () {
          if (hovered.current && props.onRelease) props.onRelease(a.id);
        };
      }, []);
      return React.createElement('div', {
        className: 'rsc-item',
        'data-id': a.id,
        'data-leaving': leaving ? '' : undefined,
        'data-locked': a.protected ? '' : undefined,
        'data-tone': tone,
        'data-click': clickable || undefined,
        title: clickable ? t('openSession') : undefined,
        onMouseEnter: rescuable && props.onHold ? function () { hovered.current = true; props.onHold(a.id); } : undefined,
        // Also released when the card is no longer rescuable but the host
        // still has it held: a probe that finishes under the pointer would
        // otherwise never see the mouse leave.
        onMouseLeave: (rescuable || a.held) && props.onRelease
          ? function () { hovered.current = false; props.onRelease(a.id); }
          : undefined,
        onClick: clickable ? function () {
          sessions.open(a.sessionId);
          openStore.set(false);
        } : undefined,
      },
        React.createElement('div', { className: 'rsc-item-head' },
          React.createElement('span', { className: 'rsc-item-dot', 'data-tone': tone }),
          React.createElement('span', { className: 'rsc-item-name' }, a.title || t('probe', { id: a.id })),
          React.createElement('span', { className: 'rsc-item-status' },
            t('status_' + a.status) + ' · ' + t('chars', { count: a.chars })
            + (a.deleted ? ' · ' + t('deleted') : '')),
          a.verdict ? React.createElement('span', {
            className: 'rsc-badge',
            'data-tone': a.verdict === 'rollout' ? 'good' : (a.verdict === 'old' ? 'bad' : undefined),
          }, t('verdict_' + a.verdict)) : null,
          a.protected && props.onRename && naming === null ? React.createElement('button', {
            type: 'button',
            className: 'rsc-lock',
            title: t('renamePrompt'),
            onClick: function (event) {
              event.stopPropagation();
              setNaming(a.title || '');
            },
          }, t('rename')) : null,
          React.createElement('button', {
            type: 'button',
            className: 'rsc-lock',
            'data-on': a.protected ? '' : undefined,
            title: a.protected ? t('unprotectHint') : t('protectHint'),
            onClick: function (event) {
              event.stopPropagation();
              if (props.onProtect) props.onProtect(a.id, !a.protected);
            },
          }, a.protected ? t('protectOn') : t('protect'))
        ),
        naming !== null ? React.createElement('input', {
          className: 'rsc-input rsc-rename',
          value: naming,
          autoFocus: true,
          placeholder: t('renamePrompt'),
          onClick: function (event) { event.stopPropagation(); },
          onChange: function (event) { setNaming(event.target.value); },
          onKeyDown: function (event) {
            if (event.key === 'Escape') { setNaming(null); return; }
            if (event.key !== 'Enter') return;
            const text = String(naming).trim();
            setNaming(null);
            if (text !== '') props.onRename(a.id, text);
          },
          onBlur: function () { setNaming(null); },
        }) : null,
        React.createElement(ScoreMeter, { score: a.score, config: props.config }),
        React.createElement('div', { className: 'rsc-evidence' },
          React.createElement('span', null, t('confidence')),
          React.createElement('span', { className: 'rsc-chip' }, n('paragraphs', a.paragraphs || 0)),
          a.ttft !== null && a.ttft !== undefined ? React.createElement('span', {
            className: 'rsc-chip',
            'data-sign': a.reason === 'ttft_fast' ? 'neg' : undefined,
          }, t('ttftChip', { ttft: a.ttft })) : null,
          a.tps !== null && a.tps !== undefined ? React.createElement('span', {
            className: 'rsc-chip',
            'data-sign': a.reason === 'tps' ? 'neg' : undefined,
          }, t('tpsChip', { tps: a.tps })) : null,
          a.reason ? React.createElement('span', {
            className: 'rsc-chip',
            'data-sign': a.reason === 'tps' || a.reason === 'ttft_fast' ? 'neg' : undefined,
          }, t('reason_' + a.reason)) : null,
          a.chinese ? React.createElement('span', { className: 'rsc-chip', 'data-sign': 'neg' }, t('chineseCot')) : null,
          a.regular ? React.createElement('span', { className: 'rsc-chip', 'data-sign': 'pos' }, t('shapeRegular')) : null,
          a.pauses ? React.createElement('span', { className: 'rsc-chip', 'data-sign': 'pos' }, n('shapeBurst', a.pauses)) : null,
          hitKeys.length === 0 && !a.chinese && a.tps === null && a.ttft === null
            ? React.createElement('span', { className: 'rsc-chip' }, t('evidenceNone'))
            : hitKeys.map(function (k) {
              const hit = hits[k];
              const count = hit && typeof hit === 'object' ? hit.count : hit;
              const tagged = hit && typeof hit === 'object' ? hit.sign : null;
              const negPhrase = /^(let me|let us|let's|we)\b/i.test(String(k));
              const sign = tagged === 'neg' || negPhrase ? 'neg' : 'pos';
              return React.createElement('span', {
                key: k, className: 'rsc-chip', 'data-sign': sign,
              }, k + ' ×' + count);
            })
        ),
        a.error ? React.createElement('div', { className: 'rsc-error' }, a.error) : null,
        a.preview ? React.createElement('div', { className: 'rsc-prev' }, a.preview) : null
      );
    }

    /** Newest first, launch order. Never resorted, so a card stays put. */
    function ProbeQueue(props) {
      return React.createElement('div', { className: 'rsc-list' },
        props.attempts.map(function (a) {
          return React.createElement(AttemptCard, {
            key: a.id, attempt: a, config: props.config,
            onHold: props.onHold, onRelease: props.onRelease,
            onProtect: props.onProtect, onRename: props.onRename,
          });
        })
      );
    }

    /**
     * Shown before a run unless the user has dismissed it for good. The
     * notification line reads the harness's own setting rather than guessing,
     * so on a web build it says there is nothing to worry about instead of
     * warning about a feature that does not exist.
     */
    function Preflight(props) {
      const [quiet, setQuiet] = React.useState(false);
      const n = props.notifications || {};
      const tone = !n.registered ? null : (n.enabled ? 'warn' : 'ok');
      const line = !n.registered ? t('notifNone') : (n.enabled ? t('notifOn') : t('notifOff'));
      return React.createElement('div', {
        className: 'rsc-scrim',
        onClick: function (e) { if (e.target === e.currentTarget) props.onCancel(); },
      },
        React.createElement('div', { className: 'rsc-modal', role: 'dialog', 'aria-modal': 'true' },
          React.createElement('div', { className: 'rsc-modal-h' }, t('preflightTitle')),
          React.createElement('div', { className: 'rsc-modal-p' }, t('preflightBody')),
          React.createElement('div', { className: 'rsc-modal-state', 'data-tone': tone || undefined },
            React.createElement('span', null, line),
            n.registered && n.enabled
              ? React.createElement('button', {
                type: 'button', onClick: props.onMute,
              }, t('notifMute'))
              : null
          ),
          React.createElement('div', { className: 'rsc-modal-foot' },
            React.createElement('label', { className: 'rsc-check' },
              React.createElement('input', {
                type: 'checkbox', checked: quiet,
                onChange: function (e) { setQuiet(e.target.checked); },
              }),
              React.createElement('span', null, t('dontShowAgain'))
            ),
            React.createElement('button', {
              type: 'button', className: 'rsc-btn', onClick: props.onCancel,
            }, t('cancel')),
            React.createElement('button', {
              type: 'button', className: 'rsc-btn', 'data-primary': '',
              onClick: function () { props.onConfirm(quiet); },
            }, t('preflightGo'))
          )
        )
      );
    }

    /**
     * Runs the labelled corpus through the host's real classifier under the
     * settings currently in the form, so editing a threshold immediately shows
     * whether it would still catch a known rollout sample.
     */
    function SelfCheck(props) {
      const [report, setReport] = React.useState(null);
      const [open, setOpen] = React.useState(false);
      const config = props.config;
      React.useEffect(function () {
        let alive = true;
        const timer = setTimeout(function () {
          api('POST', { action: 'self-check', config: config })
            .then(function (v) { if (alive) setReport(v); })
            .catch(function () { if (alive) setReport(null); });
        }, 250);
        return function () { alive = false; clearTimeout(timer); };
      }, [JSON.stringify(config)]);
      if (report === null) return null;
      const bad = report.agreed < report.total;
      return React.createElement('div', null,
        React.createElement('div', {
          className: 'rsc-selfcheck',
          'data-bad': bad ? '' : undefined,
          title: t('selfCheckHint', { total: report.total }),
          onClick: function () { setOpen(!open); },
        }, bad
          ? t('selfCheckBad', { agreed: report.agreed, total: report.total, n: report.total - report.agreed })
          : t('selfCheck', {
            agreed: report.agreed, total: report.total,
            kept: report.rolloutKept, rollout: report.rolloutTotal,
          })),
        open ? React.createElement('div', { className: 'rsc-selfcheck-rows' },
          report.results.map(function (x) {
            return React.createElement('div', {
              key: x.id, className: 'rsc-selfcheck-row', 'data-miss': x.agrees ? undefined : '',
            },
              React.createElement('span', null, x.title),
              React.createElement('b', null, x.score + '%'),
              React.createElement('span', null, t('verdict_' + x.verdict)),
              x.agrees ? null : React.createElement('span', null,
                t('selfCheckWant') + ' ' + t('verdict_' + x.label))
            );
          })
        ) : null
      );
    }

    function Stat(props) {
      return React.createElement('div', { className: 'rsc-stat' },
        React.createElement('div', { className: 'rsc-stat-v' }, props.value),
        React.createElement('div', { className: 'rsc-stat-k' }, props.label)
      );
    }

    function ScoutView(props) {
      const [remote, setRemote] = React.useState(null);
      const [error, setError] = React.useState(null);
      const [form, setForm] = React.useState(function () { return loadForm(); });
      const [preflight, setPreflight] = React.useState(false);

      // Every action returns the whole state, and so does the poll. Without
      // ordering, a poll issued before a hover write could land after it and
      // paint the pre-write state back over the card. Tickets are handed out
      // in request order and a reply older than the newest applied is dropped.
      const seq = React.useRef({ issued: 0, applied: 0 });
      function ticket() {
        seq.current.issued += 1;
        return seq.current.issued;
      }
      function applyState(at, value) {
        if (at < seq.current.applied) return;
        seq.current.applied = at;
        setRemote(value);
      }

      React.useEffect(function () {
        let alive = true;
        const tick = function () {
          const at = ticket();
          api('GET').then(function (value) {
            if (alive) { applyState(at, value); setError(null); }
          }).catch(function (e) {
            if (alive) setError(String(e.message || e));
          });
        };
        tick();
        const timer = setInterval(tick, POLL_MS);
        return function () { alive = false; clearInterval(timer); };
      }, []);

      const config = remote ? remote.config : null;
      function val(key) {
        if (form[key] !== undefined) return form[key];
        if (config) return config[key];
        return '';
      }
      function patch(key, value) {
        const next = Object.assign({}, form);
        next[key] = value;
        setForm(next);
        saveForm(next);
      }
      function num(key, value, float) {
        const n = float ? parseFloat(value) : parseInt(value, 10);
        patch(key, Number.isFinite(n) ? n : undefined);
      }

      const running = !!(remote && remote.running);
      const paused = !!(remote && remote.paused);
      const attempts = remote ? remote.attempts : [];

      async function call(action, extra) {
        setError(null);
        const at = ticket();
        try {
          applyState(at, await api('POST', Object.assign({ action: action }, extra)));
          // Deleting a cold conversation emits no live session event, so the
          // shell's sidebar keeps its stale row until the next full list
          // pull. Ask for that pull whenever an action removed conversations.
          if (action === 'reap' || action === 'delete-all' || action === 'clear') {
            try {
              if (sessions && typeof sessions.refresh === 'function') sessions.refresh();
            } catch (e) {}
          }
        } catch (e) { setError(String(e.message || e)); }
      }

      const note = remote && remote.note === 'hit' ? t('noteHit')
        : remote && remote.note === 'force-stopped' ? t('noteForceStopped')
        : remote && remote.note === 'paused' ? t('notePaused')
        : remote && remote.note === 'paused-culled'
          ? t('notePausedCulled', { count: remote.culled || 0 })
        : remote && remote.note === 'reaped'
          ? t('noteReaped', { count: remote.reaped || 0 })
        : remote && remote.note === 'launch-failed'
          ? t('noteLaunchFailed', { error: remote.lastError || '' })
          : null;

      // Start opens the pre-flight unless it has been dismissed for good.
      function beginRun() {
        if (loadForm()[QUIET_KEY]) startRun();
        else setPreflight(true);
      }
      function startRun() {
        setPreflight(false);
        const locale = t('localeCode') === 'zh' ? 'zh' : 'en';
        call('start', { config: Object.assign({}, config, form, { locale: locale }) });
      }

      const orphans = (remote && remote.orphans) || { live: 0, cold: 0 };
      const orphanTotal = orphans.live + orphans.cold;

      const kept = attempts.filter(function (a) { return a.verdict === 'rollout'; }).length;
      const discarded = attempts.filter(function (a) { return a.status === 'discarded'; }).length;
      const best = attempts.reduce(function (m, a) {
        return typeof a.score === 'number' && a.score > m ? a.score : m;
      }, 0);
      const queue = attempts
        .filter(function (a) {
          if (a.protected || a.status === 'pending-discard') return true;
          return a.status !== 'discarded';
        });
      const liveCount = remote ? remote.active : 0;
      // A kept probe stays live on purpose, so it never blocks a delete.
      const blocking = remote ? remote.blocking : 0;

      return React.createElement('div', { className: 'rsc-full', onClick: props.onSurfaceClick },
        React.createElement('div', { className: 'rsc-top' },
          React.createElement('span', { className: 'rsc-h1' }, t('title')),
          React.createElement('span', { className: 'rsc-sub' },
            running ? t('running', { active: remote.active, launched: remote.launched }) : t('idle')),
          React.createElement('a', {
            className: 'rsc-link',
            href: 'https://github.com/SpookySandwich/dsh-plugin-rollout-scout',
            target: '_blank', rel: 'noreferrer',
          }, 'GitHub ↗'),
          React.createElement('button', {
            type: 'button', className: 'rsc-x', title: t('close'), onClick: props.onClose,
          }, '✕')
        ),
        React.createElement('div', { className: 'rsc-cols' },
          React.createElement('div', { className: 'rsc-leftwrap' },
          React.createElement('div', { className: 'rsc-left' },
            React.createElement('div', { className: 'rsc-hint' }, t('tagline')),
            React.createElement('div', { className: 'rsc-sectionhead' }, t('setup')),
            React.createElement(Field, { label: t('prompt') },
              React.createElement('textarea', {
                className: 'rsc-area', value: val('prompt'), disabled: running,
                placeholder: t('promptPlaceholder'),
                onChange: function (e) { patch('prompt', e.target.value); },
              })
            ),
            React.createElement('div', { className: 'rsc-row' },
              React.createElement(Field, { label: t('model') },
                React.createElement('select', {
                  className: 'rsc-select', value: val('model'), disabled: running,
                  onChange: function (e) { patch('model', e.target.value); },
                },
                  React.createElement('option', { value: 'deepseek-v4-pro' }, 'DeepSeek-V4-Pro'),
                  React.createElement('option', { value: 'deepseek-v4-flash' }, 'DeepSeek-V4-Flash')
                )
              ),
              React.createElement(Field, { label: t('effort') },
                React.createElement('select', {
                  className: 'rsc-select', value: val('reasoningEffort'), disabled: running,
                  onChange: function (e) { patch('reasoningEffort', e.target.value); },
                },
                  React.createElement('option', { value: 'high' }, 'High'),
                  React.createElement('option', { value: 'max' }, 'Max'),
                  React.createElement('option', { value: 'off' }, 'Off'),
                  React.createElement('option', { value: 'default' }, t('effortDefault'))
                )
              )
            ),
            React.createElement(Field, { label: t('concurrency') },
              React.createElement('input', {
                className: 'rsc-input', type: 'number', min: 1, max: 6,
                value: val('concurrency'), disabled: running,
                onChange: function (e) { num('concurrency', e.target.value); },
              })
            ),
            React.createElement(Field, { label: t('folder') },
              React.createElement('input', {
                className: 'rsc-input', value: val('folder'), disabled: running,
                onChange: function (e) { patch('folder', e.target.value); },
              })
            ),
            React.createElement('div', { className: 'rsc-sectionhead' }, t('scoring')),
            React.createElement('div', { className: 'rsc-grid2' },
              React.createElement(Field, { label: t('discardBelow') },
                React.createElement('input', {
                  className: 'rsc-input', type: 'number', step: 0.05, min: 0.05, max: 0.9,
                  value: val('discardBelow'), disabled: running,
                  onChange: function (e) { num('discardBelow', e.target.value, true); },
                })
              ),
              React.createElement(Field, { label: t('keepAbove') },
                React.createElement('input', {
                  className: 'rsc-input', type: 'number', step: 0.05, min: 0.5, max: 0.99,
                  value: val('keepAbove'), disabled: running,
                  onChange: function (e) { num('keepAbove', e.target.value, true); },
                })
              ),
              React.createElement(Field, { label: t('minOpenings') },
                React.createElement('input', {
                  className: 'rsc-input', type: 'number', min: 1, max: 40,
                  value: val('minOpenings'), disabled: running,
                  onChange: function (e) { num('minOpenings', e.target.value); },
                })
              ),
              React.createElement(Field, { label: t('paragraphWindow') },
                React.createElement('input', {
                  className: 'rsc-input', type: 'number', min: 2, max: 200,
                  value: val('paragraphWindow'), disabled: running,
                  onChange: function (e) { num('paragraphWindow', e.target.value); },
                })
              )
            ),
            React.createElement(SelfCheck, { config: Object.assign({}, config, form) }),
            React.createElement('details', { className: 'rsc-fold' },
              React.createElement('summary', null, t('scoringHelp')),
              React.createElement('div', { className: 'rsc-fold-body' },
                React.createElement('div', { className: 'rsc-hint' }, t('scoringHint'))
              )
            ),
            React.createElement('div', { className: 'rsc-check-input' },
              React.createElement('label', { className: 'rsc-check' },
                React.createElement('input', {
                  type: 'checkbox', checked: !!val('discardAboveTps'), disabled: running,
                  onChange: function (e) { patch('discardAboveTps', e.target.checked); },
                }),
                React.createElement('span', null, t('discardAboveTps'))
              ),
              React.createElement('input', {
                className: 'rsc-input', type: 'number', min: 5, max: 300, step: 5,
                value: val('maxTps'), disabled: running || !val('discardAboveTps'),
                onChange: function (e) { num('maxTps', e.target.value); },
              }),
              React.createElement('span', { className: 'rsc-unit' }, t('tpsUnit'))
            ),
            React.createElement('div', { className: 'rsc-check-input' },
              React.createElement('label', { className: 'rsc-check' },
                React.createElement('input', {
                  type: 'checkbox', checked: !!val('discardBelowTtft'), disabled: running,
                  onChange: function (e) { patch('discardBelowTtft', e.target.checked); },
                }),
                React.createElement('span', null, t('discardBelowTtft'))
              ),
              React.createElement('input', {
                className: 'rsc-input', type: 'number', min: 0.1, max: 60, step: 0.1,
                value: val('minTtft'), disabled: running || !val('discardBelowTtft'),
                onChange: function (e) { num('minTtft', e.target.value, true); },
              }),
              React.createElement('span', { className: 'rsc-unit' }, t('secUnit'))
            ),
            React.createElement('div', { className: 'rsc-hint' }, t('timingHint')),
            React.createElement('label', { className: 'rsc-check' },
              React.createElement('input', {
                type: 'checkbox', checked: !!val('autoPauseOnMatch'), disabled: running,
                onChange: function (e) { patch('autoPauseOnMatch', e.target.checked); },
              }),
              React.createElement('span', null, t('autoPauseOnMatch'))
            ),
            React.createElement('label', { className: 'rsc-check' },
              React.createElement('input', {
                type: 'checkbox', checked: !!val('discardChinese'), disabled: running,
                onChange: function (e) { patch('discardChinese', e.target.checked); },
              }),
              React.createElement('span', null, t('discardChinese'))
            ),
            React.createElement('label', { className: 'rsc-check' },
              React.createElement('input', {
                type: 'checkbox', checked: !!val('autoDelete'), disabled: running,
                onChange: function (e) { patch('autoDelete', e.target.checked); },
              }),
              React.createElement('span', null, t('autoDelete'))
            ),
            note ? React.createElement('div', {
              className: remote.note === 'launch-failed' ? 'rsc-error' : 'rsc-note',
            }, note) : null,
            error ? React.createElement('div', { className: 'rsc-error' }, error) : null
          ),
          React.createElement('div', { className: 'rsc-foot' },
            running
              ? React.createElement('button', {
                type: 'button', className: 'rsc-btn', 'data-wide': '', 'data-quiet': '',
                onClick: function () { call('pause'); },
              }, t('pause'))
              : React.createElement('button', {
                type: 'button', className: 'rsc-btn', 'data-wide': '', 'data-primary': '',
                disabled: !remote || String(val('prompt') || '').trim() === '',
                onClick: function () {
                  // Resume keeps the run and its config; Start begins a new one.
                  if (paused) call('resume');
                  else beginRun();
                },
              }, paused ? t('resume') : t('start')),
            React.createElement('div', { className: 'rsc-actions' },
              React.createElement('button', {
                type: 'button', className: 'rsc-btn', 'data-danger': '',
                title: t('forceStopHint'), disabled: blocking === 0,
                onClick: function () { call('force-stop'); },
              }, t('forceStop')),
              React.createElement('button', {
                type: 'button', className: 'rsc-btn', disabled: running,
                onClick: function () { call('clear'); },
              }, t('clear'))
            ),
            React.createElement('button', {
              type: 'button', className: 'rsc-textbtn',
              // Live probes are still writing their session logs, so the host
              // refuses this. Show it as disabled rather than as an error
              // after the click.
              disabled: running || blocking > 0,
              title: blocking > 0 ? t('deleteAllBlocked') : t('deleteAllHint'),
              onClick: function () { call('delete-all'); },
            }, t('deleteAll'))
          )
          ),
          React.createElement('div', { className: 'rsc-right' },
            React.createElement('div', { className: 'rsc-stats' },
              React.createElement(Stat, { value: remote ? remote.launched : 0, label: t('statLaunched') }),
              React.createElement(Stat, { value: remote ? remote.active : 0, label: t('statActive') }),
              React.createElement(Stat, { value: kept, label: t('statKept') }),
              React.createElement(Stat, { value: discarded, label: t('statDiscarded') }),
              React.createElement(Stat, { value: pct(best) + '%', label: t('statBest') })
            ),
            orphanTotal > 0
              ? React.createElement('div', { className: 'rsc-banner' },
                React.createElement('span', null, orphans.live > 0
                  ? t('orphansLive', { count: orphanTotal, live: orphans.live })
                  : t('orphans', { count: orphanTotal })),
                React.createElement('button', {
                  type: 'button', disabled: running,
                  title: running ? t('reapBusy') : undefined,
                  onClick: function () { call('reap'); },
                }, t('reap'))
              )
              : null,
            queue.length === 0
              ? React.createElement('div', { className: 'rsc-empty' },
                discarded > 0 ? t('emptyAllDiscarded', { count: discarded }) : t('empty'))
              : React.createElement(ProbeQueue, {
                attempts: queue, config: config,
                onHold: function (id) { call('hold', { id: id }); },
                onRelease: function (id) { call('release', { id: id }); },
                onProtect: function (id, on) { call(on ? 'protect' : 'unprotect', { id: id }); },
                onRename: function (id, title) { call('rename', { id: id, title: title }); },
              })
          )
        ),
        preflight ? React.createElement(Preflight, {
          notifications: remote ? remote.notifications : null,
          onMute: function () { call('mute-notifications'); },
          onCancel: function () { setPreflight(false); },
          onConfirm: function (quiet) {
            if (quiet) patch(QUIET_KEY, true);
            startRun();
          },
        }) : null
      );
    }

    // Open state is shared between the launcher and the full view.
    const openStore = {
      value: false,
      listeners: [],
      set(next) {
        this.value = next;
        for (let i = 0; i < this.listeners.length; i++) {
          try { this.listeners[i](); } catch (e) {}
        }
      },
      subscribe(fn) {
        const listeners = this.listeners;
        listeners.push(fn);
        return function () {
          const at = listeners.indexOf(fn);
          if (at !== -1) listeners.splice(at, 1);
        };
      },
    };

    function useOpen() {
      const [, force] = React.useReducer(function (x) { return x + 1; }, 0);
      React.useEffect(function () { return openStore.subscribe(force); }, []);
      return openStore.value;
    }

    /**
     * The run lives on the host, so it continues while the console is closed.
     * The launcher keeps polling a summary of it either way — closed, it is
     * the only thing telling you the run is still going.
     */
    function useSummary(open) {
      const [summary, setSummary] = React.useState(null);
      React.useEffect(function () {
        let alive = true;
        const tick = function () {
          api('GET').then(function (v) {
            if (!alive) return;
            setSummary({
              running: !!v.running,
              paused: !!v.paused,
              active: v.active || 0,
              launched: v.launched || 0,
              kept: (v.attempts || []).filter(function (a) { return a.verdict === 'rollout'; }).length,
              best: (v.attempts || []).reduce(function (m, a) {
                return typeof a.score === 'number' && a.score > m ? a.score : m;
              }, 0),
            });
          }).catch(function () {});
        };
        tick();
        const timer = setInterval(tick, open ? 4000 : 2000);
        return function () { alive = false; clearInterval(timer); };
      }, [open]);
      return summary;
    }

    /**
     * The shell's Think glyph — the same mark the chat puts beside a
     * chain-of-thought, which is exactly what this plugin reads. Sized the way
     * the Settings row sizes its own icon: the 16 variant at 16 in the wide
     * column, the 14 variant at 18 in the rail.
     */
    function ScoutIcon(props) {
      const rail = props.rail;
      const Icon = primitives
        && (rail ? primitives.IconThinkOutline14 : primitives.IconThinkOutline16);
      if (Icon) return React.createElement(Icon, { size: rail ? 18 : 16 });
      // Concentric sweep, in case the primitives package is not resolvable.
      const size = rail ? 18 : 16;
      return React.createElement('svg', {
        width: size, height: size, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true',
      },
        React.createElement('circle', {
          cx: 8, cy: 8, r: 6.25, stroke: 'currentColor', strokeWidth: 1.3, opacity: 0.55,
        }),
        React.createElement('circle', { cx: 8, cy: 8, r: 2, fill: 'currentColor' })
      );
    }

    /**
     * The launcher, seated at the sidebar foot beside Settings. `wide` is the
     * shell's fold state: false means the 56px rail, where the label is gone
     * and the run has to be legible from the icon and its status pip alone.
     */
    function SidebarSeat(props) {
      const wide = props.wide !== false;
      const open = useOpen();
      const s = useSummary(open);
      const running = !!(s && s.running);
      const paused = !!(s && s.paused);
      const caught = !!(s && s.kept > 0);
      const tone = caught ? 'caught' : running ? 'live' : paused ? 'paused' : null;
      const title = !s || (!running && !paused && s.launched === 0) ? t('launcher')
        : running ? t('pillRunning', { active: s.active, launched: s.launched })
        : paused ? t('pillPaused', { launched: s.launched })
        : t('pillDone', { launched: s.launched });
      return React.createElement('button', {
        type: 'button',
        className: 'rsc-seat',
        'data-rail': wide ? undefined : '',
        'data-open': open ? '' : undefined,
        'aria-haspopup': 'dialog',
        'aria-expanded': open,
        'aria-label': t('launcher'),
        title: s && s.launched > 0 ? title + ' · ' + t('pillBest', { score: pct(s.best) }) : title,
        onClick: function () { openStore.set(!open); },
      },
        React.createElement('span', { className: 'rsc-seat-icon' },
          React.createElement(ScoutIcon, { rail: !wide }),
          tone ? React.createElement('span', { className: 'rsc-pip', 'data-tone': tone }) : null
        ),
        wide ? React.createElement('span', { className: 'rsc-seat-label' }, t('launcher')) : null,
        wide && caught
          ? React.createElement('span', { className: 'rsc-seat-badge' }, s.kept)
          : wide && running
            ? React.createElement('span', { className: 'rsc-seat-meta' }, t('seatLive', { active: s.active }))
            : null
      );
    }

    /** The full-frame console. Opened from the seat, closed from its own ✕. */
    function ConsoleSurface() {
      const open = useOpen();
      if (!open) return null;
      const view = React.createElement(ScoutView, {
        onClose: function () { openStore.set(false); },
        onSurfaceClick: function (event) {
          const g = realGlobal();
          const seat = g && g.document && g.document.querySelector('.rsc-seat');
          if (!seat || typeof seat.getBoundingClientRect !== 'function') return;
          const rect = seat.getBoundingClientRect();
          if (event.clientX >= rect.left && event.clientX <= rect.right
              && event.clientY >= rect.top && event.clientY <= rect.bottom) {
            openStore.set(false);
          }
        },
      });
      const g = realGlobal();
      const body = g && g.document && g.document.body;
      if (!reactDom || typeof reactDom.createPortal !== 'function' || !body) return view;
      return reactDom.createPortal(view, body);
    }

    // The launcher is a sidebar footer action — a declared seat beside
    // Settings, rather than a pill floating over the composer's send button.
    slots.inject('sidebar.footer.action', function () {
      return slots.register({ name: 'sidebar.footer.action', id: 'rollout-scout', order: 120 }, SidebarSeat);
    });

    // The console itself still needs the frame-wide layer: it covers the whole
    // window, which nothing inside the sidebar column could do.
    slots.inject('shell.overlay', function () {
      return slots.register({ name: 'shell.overlay', id: 'rollout-scout', order: 120 }, ConsoleSurface);
    });
  }
};

    })();
  }
});
