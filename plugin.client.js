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
// How long a discarded probe stays visible before it leaves the queue.
const LINGER_MS = 3200;

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

const STATUS_TONE = {
  starting: 'wait',
  streaming: 'wait',
  'kept-streaming': 'good',
  kept: 'good',
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
  /* -- launcher ---------------------------------------------------------- */
  '.rsc-launch{position:fixed;right:18px;bottom:18px;z-index:60;display:flex;align-items:center;gap:8px;padding:9px 15px;border-radius:999px;border:1px solid color-mix(in srgb,var(--dsw-alias-label-primary,#fff) 12%,transparent);background:color-mix(in srgb,var(--dsw-alias-bg-primary,#1e1e22) 80%,transparent);-webkit-backdrop-filter:blur(18px);backdrop-filter:blur(18px);box-shadow:0 8px 26px rgba(0,0,0,.3);color:var(--dsw-alias-label-secondary,#bbb);cursor:pointer;font:inherit;font-size:12.5px}',
  '.rsc-launch:hover{color:var(--dsw-alias-label-primary);border-color:color-mix(in srgb,var(--dsw-alias-label-primary,#fff) 26%,transparent)}',
  '.rsc-dot{flex:none;width:8px;height:8px;border-radius:50%;background:var(--dsw-alias-label-tertiary)}',
  '.rsc-launch[data-live]{border-color:var(--dsw-alias-accent-primary,#4b8dff)}',
  '.rsc-launch[data-live] .rsc-dot{background:var(--dsw-alias-accent-primary,#4b8dff);animation:rsc-pulse 1.4s ease-in-out infinite}',
  '@keyframes rsc-pulse{0%,100%{opacity:1}50%{opacity:.35}}',

  /* -- full-frame surface ------------------------------------------------ */
  '.rsc-full{position:fixed;inset:0;z-index:70;display:flex;flex-direction:column;background:color-mix(in srgb,var(--dsw-alias-bg-primary,#16161a) 94%,transparent);-webkit-backdrop-filter:blur(30px) saturate(1.4);backdrop-filter:blur(30px) saturate(1.4);color:var(--dsw-alias-label-primary);font-size:13px;animation:rsc-in 260ms cubic-bezier(.32,.72,0,1) both}',
  '@keyframes rsc-in{from{opacity:0;transform:scale(.99)}to{opacity:1;transform:none}}',
  '.rsc-top{display:flex;align-items:center;gap:14px;padding:16px 22px;border-bottom:1px solid color-mix(in srgb,var(--dsw-alias-label-tertiary,#888) 22%,transparent)}',
  '.rsc-h1{font-size:16px;font-weight:600}',
  '.rsc-sub{font-size:12.5px;color:var(--dsw-alias-label-tertiary);flex:1}',
  '.rsc-x{width:30px;height:30px;border:0;border-radius:9px;background:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer;font-size:15px}',
  '.rsc-x:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
  '.rsc-cols{flex:1;display:flex;min-height:0}',
  '.rsc-left{width:340px;flex:none;overflow-y:auto;padding:18px 20px 40px;display:flex;flex-direction:column;gap:13px;border-right:1px solid color-mix(in srgb,var(--dsw-alias-label-tertiary,#888) 18%,transparent)}',
  '.rsc-right{flex:1;min-width:0;overflow-y:auto;padding:18px 22px 60px}',

  /* -- form -------------------------------------------------------------- */
  '.rsc-label{font-size:11.5px;color:var(--dsw-alias-label-tertiary);margin-bottom:4px;display:block}',
  '.rsc-input,.rsc-select,.rsc-area{width:100%;box-sizing:border-box;border-radius:9px;border:1px solid color-mix(in srgb,var(--dsw-alias-label-tertiary,#888) 30%,transparent);background:color-mix(in srgb,var(--dsw-alias-label-tertiary,#888) 8%,transparent);color:var(--dsw-alias-label-primary);font:inherit;font-size:12.5px;padding:7px 9px;outline:none}',
  '.rsc-input:focus,.rsc-select:focus,.rsc-area:focus{border-color:var(--dsw-alias-accent-primary,#4b8dff)}',
  '.rsc-area{min-height:74px;resize:vertical;line-height:19px}',
  '.rsc-row{display:flex;gap:9px}',
  '.rsc-row>*{flex:1;min-width:0}',
  '.rsc-check{display:flex;align-items:flex-start;gap:8px;cursor:pointer;font-size:12.5px;line-height:17px}',
  '.rsc-check input{margin-top:1px;accent-color:var(--dsw-alias-accent-primary,#4b8dff)}',
  '.rsc-actions{display:flex;gap:9px;margin-top:3px}',
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
  '.rsc-item[data-leaving]{animation:rsc-row-out 3200ms ease-in both}',
  '@keyframes rsc-row-out{0%{opacity:1}70%{opacity:.5}100%{opacity:0}}',
  '.rsc-item{animation:rsc-row-in 300ms cubic-bezier(.32,.72,0,1) both;padding:11px 13px;border-radius:12px;background:color-mix(in srgb,var(--dsw-alias-label-tertiary,#888) 8%,transparent);border:1px solid transparent}',
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
        close: 'Close',
        setup: 'Probe setup',
        scoring: 'Scoring',
        prompt: 'Probe prompt',
        model: 'Model',
        effort: 'Reasoning effort',
        concurrency: 'Concurrency',
        folder: 'Folder for probe sessions',
        discardBelow: 'Discard below',
        keepAbove: 'Keep above',
        minOpenings: 'Min. openings',
        paragraphWindow: 'Give up after',
        paragraphs: '{count} paragraphs',
        forceStop: 'Force stop',
        forceStopHint: 'Stop launching and abort every conversation still in flight.',
        discardChinese: 'Discard Chinese chain-of-thought on sight',
        chineseCot: 'Chinese CoT',
        scoringHint: 'A paragraph opening with “I’ll” is decisive for the rollout model; one opening with “Let me” is decisive against — whichever appears first settles it. Otherwise the score is the share of classified openings reading as the rollout (“I am”, “I’m”, “I need”, “For”), acted on only once enough openings exist. A probe that opens this many paragraphs without a single positive one is given up on.',
        reason_decisive: 'decisive opening',
        reason_score: 'opening score',
        reason_window: 'no positive opening',
        reason_chinese: 'Chinese CoT',
        autoPauseOnMatch: 'Auto-pause on a strong match',
        autoDelete: 'Delete old-model probes from disk',
        start: 'Start',
        pause: 'Pause',
        resume: 'Resume',
        clear: 'Clear finished',
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
      },
      zh: {
        title: '灰度侦察',
        tagline: '开启一批临时会话，为它们的思维链打分，用来寻找灰度发布的模型。',
        launcher: '灰度侦察',
        close: '关闭',
        setup: '探测设置',
        scoring: '评分',
        prompt: '探测提示词',
        model: '模型',
        effort: '思考强度',
        concurrency: '并发数',
        folder: '探测会话存放目录',
        discardBelow: '低于此分即丢弃',
        keepAbove: '高于此分即保留',
        minOpenings: '最少开头数',
        paragraphWindow: '放弃阈值',
        paragraphs: '{count} 段',
        forceStop: '强制停止',
        forceStopHint: '停止发起，并中止所有进行中的会话。',
        discardChinese: '思维链为中文时立即丢弃',
        chineseCot: '中文思维链',
        scoringHint: '段落以「I’ll」开头即判定为灰度模型，以「Let me」开头即判定为旧模型——以先出现者为准。两者都没出现时，按已分类段落开头中读作灰度风格（「I am」「I’m」「I need」「For」）的比例打分，且开头数量足够后才据此判定。若在设定的段数内一个正向开头都没有出现，则放弃该探测。',
        reason_decisive: '决定性开头',
        reason_score: '开头评分',
        reason_window: '无正向开头',
        reason_chinese: '中文思维链',
        autoPauseOnMatch: '命中强匹配时自动暂停',
        autoDelete: '从磁盘删除判为旧模型的会话',
        start: '开始',
        pause: '暂停',
        resume: '继续',
        clear: '清空已结束',
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
      const tone = STATUS_TONE[a.status] || 'neutral';
      const clickable = !!a.sessionId && !a.deleted && sessions;
      const hits = a.hits || {};
      const hitKeys = Object.keys(hits);
      return React.createElement('div', {
        className: 'rsc-item',
        'data-id': a.id,
        'data-leaving': a.verdict === 'old' && a.endedAt ? '' : undefined,
        'data-tone': tone,
        'data-click': clickable || undefined,
        title: clickable ? t('openSession') : undefined,
        // Opening a conversation dismisses the console, otherwise the session
        // would load behind it.
        onClick: clickable ? function () {
          sessions.open(a.sessionId);
          openStore.set(false);
        } : undefined,
      },
        React.createElement('div', { className: 'rsc-item-head' },
          React.createElement('span', { className: 'rsc-item-dot', 'data-tone': tone }),
          React.createElement('span', { className: 'rsc-item-name' }, t('probe', { id: a.id })),
          React.createElement('span', { className: 'rsc-item-status' },
            t('status_' + a.status) + ' · ' + t('chars', { count: a.chars })
            + (a.deleted ? ' · ' + t('deleted') : '')),
          a.verdict ? React.createElement('span', {
            className: 'rsc-badge',
            'data-tone': a.verdict === 'rollout' ? 'good' : (a.verdict === 'old' ? 'bad' : undefined),
          }, t('verdict_' + a.verdict)) : null
        ),
        React.createElement(ScoreMeter, { score: a.score, config: props.config }),
        React.createElement('div', { className: 'rsc-evidence' },
          React.createElement('span', null, t('confidence')),
          React.createElement('span', { className: 'rsc-chip' }, t('paragraphs', { count: a.paragraphs || 0 })),
          a.reason ? React.createElement('span', { className: 'rsc-chip' }, t('reason_' + a.reason)) : null,
          a.chinese ? React.createElement('span', { className: 'rsc-chip', 'data-sign': 'neg' }, t('chineseCot')) : null,
          hitKeys.length === 0 && !a.chinese
            ? React.createElement('span', { className: 'rsc-chip' }, t('evidenceNone'))
            : hitKeys.map(function (k) {
              const negative = k === 'let me' || k === 'we need';
              return React.createElement('span', {
                key: k, className: 'rsc-chip', 'data-sign': negative ? 'neg' : 'pos',
              }, k + ' ×' + hits[k]);
            })
        ),
        a.error ? React.createElement('div', { className: 'rsc-error' }, a.error) : null,
        a.preview ? React.createElement('div', { className: 'rsc-prev' }, a.preview) : null
      );
    }

    /**
     * The ranked queue. Rows are reordered by score every poll, so each render
     * plays the move as a FLIP: measure where a row was, put it back there with
     * a transform, then release it to slide to its new place.
     */
    function ProbeQueue(props) {
      const listRef = React.useRef(null);
      const offsets = React.useRef(new Map());

      React.useLayoutEffect(function () {
        const list = listRef.current;
        if (!list) return;
        const next = new Map();
        const rows = list.children;
        for (let i = 0; i < rows.length; i++) {
          const row = rows[i];
          const id = row.getAttribute('data-id');
          const top = row.offsetTop;
          next.set(id, top);
          const previous = offsets.current.get(id);
          if (previous === undefined || previous === top) continue;
          row.style.transition = 'none';
          row.style.transform = 'translateY(' + (previous - top) + 'px)';
          requestAnimationFrame(function () {
            row.style.transition = 'transform 360ms cubic-bezier(.32,.72,0,1)';
            row.style.transform = '';
          });
        }
        offsets.current = next;
      });

      return React.createElement('div', { className: 'rsc-list', ref: listRef },
        props.attempts.map(function (a) {
          return React.createElement(AttemptCard, { key: a.id, attempt: a, config: props.config });
        })
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

      React.useEffect(function () {
        let alive = true;
        const tick = function () {
          api('GET').then(function (value) {
            if (alive) { setRemote(value); setError(null); }
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
        try {
          setRemote(await api('POST', Object.assign({ action: action }, extra)));
        } catch (e) { setError(String(e.message || e)); }
      }

      const note = remote && remote.note === 'hit' ? t('noteHit')
        : remote && remote.note === 'force-stopped' ? t('noteForceStopped')
        : remote && remote.note === 'paused' ? t('notePaused')
        : null;

      const kept = attempts.filter(function (a) { return a.verdict === 'rollout'; }).length;
      const discarded = attempts.filter(function (a) { return a.verdict === 'old'; }).length;
      const best = attempts.reduce(function (m, a) {
        return typeof a.score === 'number' && a.score > m ? a.score : m;
      }, 0);
      // Discarded probes leave the queue, but not instantly: a verdict can land
      // in under two seconds, and vanishing on the same tick makes the run look
      // like nothing happened. They fade out over LINGER_MS first.
      const now = Date.now();
      const queue = attempts
        .filter(function (a) {
          if (a.verdict !== 'old') return true;
          return !a.endedAt || (now - a.endedAt) < LINGER_MS;
        })
        .sort(function (a, b) { return (b.score - a.score) || (b.id - a.id); });
      const liveCount = remote ? remote.active : 0;

      return React.createElement('div', { className: 'rsc-full' },
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
          React.createElement('div', { className: 'rsc-left' },
            React.createElement('div', { className: 'rsc-hint' }, t('tagline')),
            React.createElement('div', { className: 'rsc-sectionhead' }, t('setup')),
            React.createElement(Field, { label: t('prompt') },
              React.createElement('textarea', {
                className: 'rsc-area', value: val('prompt'), disabled: running,
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
            React.createElement('div', { className: 'rsc-row' },
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
            React.createElement('div', { className: 'rsc-hint' }, t('scoringHint')),
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
            React.createElement('div', { className: 'rsc-actions' },
              running
                ? React.createElement('button', {
                  type: 'button', className: 'rsc-btn',
                  onClick: function () { call('pause'); },
                }, t('pause'))
                : React.createElement('button', {
                  type: 'button', className: 'rsc-btn', 'data-primary': '', disabled: !remote,
                  onClick: function () {
                    // Resume keeps the run and its config; Start begins a new one.
                    if (paused) call('resume');
                    else call('start', { config: Object.assign({}, config, form) });
                  },
                }, paused ? t('resume') : t('start')),
              React.createElement('button', {
                type: 'button', className: 'rsc-btn', 'data-danger': '',
                title: t('forceStopHint'), disabled: liveCount === 0,
                onClick: function () { call('force-stop'); },
              }, t('forceStop')),
              React.createElement('button', {
                type: 'button', className: 'rsc-btn', disabled: running,
                onClick: function () { call('clear'); },
              }, t('clear'))
            ),
            note ? React.createElement('div', { className: 'rsc-note' }, note) : null,
            error ? React.createElement('div', { className: 'rsc-error' }, error) : null
          ),
          React.createElement('div', { className: 'rsc-right' },
            React.createElement('div', { className: 'rsc-stats' },
              React.createElement(Stat, { value: remote ? remote.launched : 0, label: t('statLaunched') }),
              React.createElement(Stat, { value: remote ? remote.active : 0, label: t('statActive') }),
              React.createElement(Stat, { value: kept, label: t('statKept') }),
              React.createElement(Stat, { value: discarded, label: t('statDiscarded') }),
              React.createElement(Stat, { value: pct(best) + '%', label: t('statBest') })
            ),
            queue.length === 0
              ? React.createElement('div', { className: 'rsc-empty' },
                discarded > 0 ? t('emptyAllDiscarded', { count: discarded }) : t('empty'))
              : React.createElement(ProbeQueue, { attempts: queue, config: config })
          )
        )
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

    function useLive(open) {
      const [live, setLive] = React.useState(false);
      React.useEffect(function () {
        let alive = true;
        const tick = function () {
          api('GET').then(function (v) { if (alive) setLive(!!v.running); }).catch(function () {});
        };
        tick();
        const timer = setInterval(tick, open ? 4000 : 8000);
        return function () { alive = false; clearInterval(timer); };
      }, [open]);
      return live;
    }

    function Launcher() {
      const open = useOpen();
      const live = useLive(open);
      return React.createElement('button', {
        type: 'button',
        className: 'rsc-launch',
        'data-live': live || undefined,
        onClick: function () { openStore.set(!open); },
      },
        React.createElement('span', { className: 'rsc-dot' }),
        React.createElement('span', null, t('launcher'))
      );
    }

    function Surface() {
      const open = useOpen();
      return React.createElement(React.Fragment, null,
        React.createElement(Launcher),
        open ? React.createElement(ScoutView, { onClose: function () { openStore.set(false); } }) : null
      );
    }

    // Both the launcher and the console live on the frame-wide overlay layer:
    // it is the one root-scoped seat, so a single entry cannot half-register.
    slots.inject('shell.overlay', function () {
      return slots.register({ name: 'shell.overlay', id: 'rollout-scout', order: 120 }, Surface);
    });
  }
};
