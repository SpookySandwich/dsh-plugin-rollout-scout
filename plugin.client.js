// dsh-plugin-rollout-scout — client half.
//
// A floating panel (shell.overlay slot) that drives the host's probe loop:
// enter a prompt, pick model / concurrency / folder, press Start, and watch
// probes stream, get discarded the moment their chain-of-thought says
// "Let me" too often, or get kept as likely rollout catches.

const ROUTE = '/rollout-scout';
const POLL_MS = 800;

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
  error: 'bad',
};

const CSS = [
  '.rsc-root{position:fixed;right:18px;bottom:18px;z-index:60;display:flex;flex-direction:column;align-items:flex-end;gap:10px;pointer-events:none;font-size:13px;color:var(--dsw-alias-label-primary)}',
  '.rsc-root>*{pointer-events:auto}',
  '.rsc-launch{display:inline-flex;align-items:center;gap:7px;padding:9px 14px;border-radius:999px;border:1px solid color-mix(in srgb,var(--dsw-alias-label-primary,#fff) 12%,transparent);background:color-mix(in srgb,var(--dsw-alias-bg-primary,#1e1e22) 78%,transparent);-webkit-backdrop-filter:blur(18px) saturate(1.4);backdrop-filter:blur(18px) saturate(1.4);box-shadow:0 8px 26px rgba(0,0,0,.3);color:var(--dsw-alias-label-primary);cursor:pointer;font-size:12.5px}',
  '.rsc-launch:hover{border-color:color-mix(in srgb,var(--dsw-alias-label-primary,#fff) 24%,transparent)}',
  '.rsc-launch[data-live]{border-color:var(--dsw-alias-accent-primary,#4b8dff)}',
  '.rsc-dot{width:8px;height:8px;border-radius:50%;background:var(--dsw-alias-label-tertiary)}',
  '.rsc-launch[data-live] .rsc-dot{background:var(--dsw-alias-accent-primary,#4b8dff);animation:rsc-pulse 1.4s ease-in-out infinite}',
  '@keyframes rsc-pulse{0%,100%{opacity:1}50%{opacity:.35}}',

  '.rsc-panel{width:400px;max-height:min(72vh,680px);display:flex;flex-direction:column;border-radius:16px;border:1px solid color-mix(in srgb,var(--dsw-alias-label-primary,#fff) 11%,transparent);background:color-mix(in srgb,var(--dsw-alias-bg-primary,#1e1e22) 80%,transparent);-webkit-backdrop-filter:blur(26px) saturate(1.5);backdrop-filter:blur(26px) saturate(1.5);box-shadow:0 22px 60px rgba(0,0,0,.42);overflow:hidden}',
  '.rsc-head{display:flex;align-items:center;gap:8px;padding:12px 14px 10px}',
  '.rsc-title{font-size:14px;font-weight:600;flex:1}',
  '.rsc-x{width:26px;height:26px;border:0;border-radius:8px;background:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer;font-size:14px}',
  '.rsc-x:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
  '.rsc-body{overflow-y:auto;padding:0 14px 12px;display:flex;flex-direction:column;gap:10px}',
  '.rsc-label{font-size:11.5px;color:var(--dsw-alias-label-tertiary);margin-bottom:3px;display:block}',
  '.rsc-input,.rsc-select,.rsc-area{width:100%;box-sizing:border-box;border-radius:9px;border:1px solid color-mix(in srgb,var(--dsw-alias-label-tertiary,#888) 32%,transparent);background:color-mix(in srgb,var(--dsw-alias-label-tertiary,#888) 8%,transparent);color:var(--dsw-alias-label-primary);font:inherit;font-size:12.5px;padding:7px 9px;outline:none}',
  '.rsc-input:focus,.rsc-select:focus,.rsc-area:focus{border-color:var(--dsw-alias-accent-primary,#4b8dff)}',
  '.rsc-area{min-height:56px;resize:vertical}',
  '.rsc-row{display:flex;gap:8px}',
  '.rsc-row>*{flex:1;min-width:0}',
  '.rsc-checks{display:flex;flex-direction:column;gap:6px}',
  '.rsc-check{display:flex;align-items:center;gap:8px;cursor:pointer;font-size:12.5px}',
  '.rsc-check input{accent-color:var(--dsw-alias-accent-primary,#4b8dff)}',
  '.rsc-actions{display:flex;gap:8px;align-items:center}',
  '.rsc-btn{flex:1;padding:8px 0;border-radius:999px;border:1px solid color-mix(in srgb,var(--dsw-alias-label-tertiary,#888) 34%,transparent);background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;cursor:pointer}',
  '.rsc-btn:hover{background:var(--dsw-alias-interactive-bg-hover)}',
  '.rsc-btn[data-primary]{background:var(--dsw-alias-accent-primary,#4b8dff);border-color:transparent;color:#fff}',
  '.rsc-btn[data-primary]:hover{filter:brightness(1.08)}',
  '.rsc-btn[data-danger]{border-color:color-mix(in srgb,var(--dsw-alias-status-error,#e5484d) 55%,transparent);color:var(--dsw-alias-status-error,#e5484d)}',
  '.rsc-btn[disabled]{opacity:.5;cursor:default}',
  '.rsc-note{font-size:12px;color:var(--dsw-alias-label-tertiary)}',
  '.rsc-error{font-size:12px;color:var(--dsw-alias-status-error,#e5484d)}',

  '.rsc-list{display:flex;flex-direction:column;gap:6px}',
  '.rsc-item{display:flex;align-items:center;gap:8px;padding:7px 9px;border-radius:10px;background:color-mix(in srgb,var(--dsw-alias-label-tertiary,#888) 8%,transparent)}',
  '.rsc-item[data-click]{cursor:pointer}',
  '.rsc-item[data-click]:hover{background:color-mix(in srgb,var(--dsw-alias-label-tertiary,#888) 15%,transparent)}',
  '.rsc-item-dot{flex:none;width:8px;height:8px;border-radius:50%}',
  '.rsc-item-dot[data-tone=wait]{background:var(--dsw-alias-accent-primary,#4b8dff);animation:rsc-pulse 1.4s ease-in-out infinite}',
  '.rsc-item-dot[data-tone=good]{background:#3fbf6f}',
  '.rsc-item-dot[data-tone=bad]{background:var(--dsw-alias-status-error,#e5484d)}',
  '.rsc-item-dot[data-tone=neutral]{background:var(--dsw-alias-label-tertiary,#888)}',
  '.rsc-item-main{flex:1;min-width:0}',
  '.rsc-item-line{display:flex;gap:8px;align-items:baseline}',
  '.rsc-item-name{font-size:12.5px;font-weight:600}',
  '.rsc-item-stats{font-size:11px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}',
  '.rsc-item-prev{font-size:11px;color:var(--dsw-alias-label-tertiary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
  '.rsc-badge{flex:none;font-size:10.5px;padding:2px 8px;border-radius:999px;background:color-mix(in srgb,var(--dsw-alias-label-tertiary,#888) 18%,transparent);color:var(--dsw-alias-label-secondary,#bbb)}',
  '.rsc-badge[data-tone=good]{background:color-mix(in srgb,#3fbf6f 22%,transparent);color:#3fbf6f}',
  '.rsc-badge[data-tone=bad]{background:color-mix(in srgb,var(--dsw-alias-status-error,#e5484d) 18%,transparent);color:var(--dsw-alias-status-error,#e5484d)}',
  '.rsc-foot{display:flex;justify-content:space-between;align-items:center;padding:0 14px 10px}',
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
        launcher: 'Scout',
        prompt: 'Probe prompt',
        model: 'Model',
        effort: 'Reasoning',
        concurrency: 'Concurrency',
        folder: 'Folder for probe sessions',
        letMeThreshold: 'Discard at "Let me" ×',
        confidenceThreshold: 'Keep at signals ×',
        maxAttempts: 'Max probes',
        stopAfterHit: 'Stop after first catch',
        autoDelete: 'Auto-delete old-model probes',
        start: 'Start',
        stop: 'Stop',
        clear: 'Clear',
        running: 'Scouting… {active} live · {launched} launched',
        idle: 'Idle',
        noteHit: 'Caught one! Launching paused.',
        noteMax: 'Probe cap reached.',
        noteStopped: 'Stopped — live probes will finish.',
        probe: 'Probe {id}',
        deleted: 'deleted',
        empty: 'No probes yet. Press Start to begin fishing.',
        verdict_rollout: 'ROLLOUT',
        verdict_old: 'old',
        verdict_unknown: '?',
        status_starting: 'starting',
        status_streaming: 'thinking',
        'status_kept-streaming': 'finishing',
        status_kept: 'kept',
        status_discarding: 'stopping',
        status_discarded: 'discarded',
        status_finished: 'finished',
        status_error: 'error',
      },
      zh: {
        title: '灰度侦察',
        launcher: '侦察',
        prompt: '探测提示词',
        model: '模型',
        effort: '思考强度',
        concurrency: '并发数',
        folder: '探测会话存放目录',
        letMeThreshold: '“Let me” ×N 即丢弃',
        confidenceThreshold: '信号 ×N 即保留',
        maxAttempts: '最大探测数',
        stopAfterHit: '命中一次后停止',
        autoDelete: '自动删除旧模型会话',
        start: '开始',
        stop: '停止',
        clear: '清空',
        running: '侦察中… {active} 进行 · 已发起 {launched}',
        idle: '空闲',
        noteHit: '钓到了！已暂停发起新探测。',
        noteMax: '已达探测上限。',
        noteStopped: '已停止——进行中的探测将自行结束。',
        probe: '探测 {id}',
        deleted: '已删除',
        empty: '还没有探测。点击开始钓灰度模型。',
        verdict_rollout: '灰度',
        verdict_old: '旧模型',
        verdict_unknown: '?',
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

    function AttemptRow(props) {
      const a = props.attempt;
      const tone = STATUS_TONE[a.status] || 'neutral';
      const clickable = !!a.sessionId && !a.deleted && sessions;
      return React.createElement('div', {
        className: 'rsc-item',
        'data-click': clickable || undefined,
        onClick: clickable ? function () { sessions.open(a.sessionId); } : undefined,
        title: a.preview || undefined,
      },
        React.createElement('span', { className: 'rsc-item-dot', 'data-tone': tone }),
        React.createElement('span', { className: 'rsc-item-main' },
          React.createElement('span', { className: 'rsc-item-line' },
            React.createElement('span', { className: 'rsc-item-name' }, t('probe', { id: a.id })),
            React.createElement('span', { className: 'rsc-item-stats' },
              t('status_' + a.status)
              + ' · Let me ×' + a.letMe
              + ' · ✓×' + a.signals
              + ' · ' + a.chars + 'ch'
              + (a.deleted ? ' · ' + t('deleted') : '')
              + (a.error ? ' · ' + a.error : '')
            )
          ),
          a.preview ? React.createElement('span', { className: 'rsc-item-prev' }, a.preview) : null
        ),
        a.verdict ? React.createElement('span', {
          className: 'rsc-badge',
          'data-tone': a.verdict === 'rollout' ? 'good' : (a.verdict === 'old' ? 'bad' : undefined),
        }, t('verdict_' + a.verdict)) : null
      );
    }

    function ScoutPanel(props) {
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
      function num(key, value) {
        const n = parseInt(value, 10);
        patch(key, Number.isFinite(n) ? n : undefined);
      }

      const running = !!(remote && remote.running);
      const attempts = remote ? remote.attempts : [];

      async function onStart() {
        setError(null);
        try {
          setRemote(await api('POST', { action: 'start', config: Object.assign({}, config, form) }));
        } catch (e) { setError(String(e.message || e)); }
      }
      async function onStop() {
        setError(null);
        try { setRemote(await api('POST', { action: 'stop' })); }
        catch (e) { setError(String(e.message || e)); }
      }
      async function onClear() {
        setError(null);
        try { setRemote(await api('POST', { action: 'clear' })); }
        catch (e) { setError(String(e.message || e)); }
      }

      const note = remote && remote.note === 'hit' ? t('noteHit')
        : remote && remote.note === 'max-attempts' ? t('noteMax')
        : remote && remote.note === 'stopped' ? t('noteStopped')
        : null;

      return React.createElement('div', { className: 'rsc-panel' },
        React.createElement('div', { className: 'rsc-head' },
          React.createElement('span', { className: 'rsc-title' }, t('title')),
          React.createElement('span', { className: 'rsc-note' },
            running ? t('running', { active: remote.active, launched: remote.launched }) : t('idle')),
          React.createElement('button', { type: 'button', className: 'rsc-x', onClick: props.onClose }, '✕')
        ),
        React.createElement('div', { className: 'rsc-body' },
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
                React.createElement('option', { value: 'default' }, 'Default')
              )
            ),
            React.createElement(Field, { label: t('concurrency') },
              React.createElement('input', {
                className: 'rsc-input', type: 'number', min: 1, max: 6,
                value: val('concurrency'), disabled: running,
                onChange: function (e) { num('concurrency', e.target.value); },
              })
            )
          ),
          React.createElement(Field, { label: t('folder') },
            React.createElement('input', {
              className: 'rsc-input', value: val('folder'), disabled: running,
              onChange: function (e) { patch('folder', e.target.value); },
            })
          ),
          React.createElement('div', { className: 'rsc-row' },
            React.createElement(Field, { label: t('letMeThreshold') },
              React.createElement('input', {
                className: 'rsc-input', type: 'number', min: 1, max: 20,
                value: val('letMeThreshold'), disabled: running,
                onChange: function (e) { num('letMeThreshold', e.target.value); },
              })
            ),
            React.createElement(Field, { label: t('confidenceThreshold') },
              React.createElement('input', {
                className: 'rsc-input', type: 'number', min: 1, max: 50,
                value: val('confidenceThreshold'), disabled: running,
                onChange: function (e) { num('confidenceThreshold', e.target.value); },
              })
            ),
            React.createElement(Field, { label: t('maxAttempts') },
              React.createElement('input', {
                className: 'rsc-input', type: 'number', min: 1, max: 200,
                value: val('maxAttempts'), disabled: running,
                onChange: function (e) { num('maxAttempts', e.target.value); },
              })
            )
          ),
          React.createElement('div', { className: 'rsc-checks' },
            React.createElement('label', { className: 'rsc-check' },
              React.createElement('input', {
                type: 'checkbox', checked: !!val('stopAfterHit'), disabled: running,
                onChange: function (e) { patch('stopAfterHit', e.target.checked); },
              }),
              React.createElement('span', null, t('stopAfterHit'))
            ),
            React.createElement('label', { className: 'rsc-check' },
              React.createElement('input', {
                type: 'checkbox', checked: !!val('autoDelete'), disabled: running,
                onChange: function (e) { patch('autoDelete', e.target.checked); },
              }),
              React.createElement('span', null, t('autoDelete'))
            )
          ),
          React.createElement('div', { className: 'rsc-actions' },
            running
              ? React.createElement('button', { type: 'button', className: 'rsc-btn', 'data-danger': '', onClick: onStop }, t('stop'))
              : React.createElement('button', { type: 'button', className: 'rsc-btn', 'data-primary': '', onClick: onStart, disabled: !remote }, t('start')),
            React.createElement('button', { type: 'button', className: 'rsc-btn', onClick: onClear, disabled: running }, t('clear'))
          ),
          note ? React.createElement('div', { className: 'rsc-note' }, note) : null,
          error ? React.createElement('div', { className: 'rsc-error' }, error) : null,
          React.createElement('div', { className: 'rsc-list' },
            attempts.length === 0
              ? React.createElement('div', { className: 'rsc-note' }, t('empty'))
              : attempts.map(function (a) { return React.createElement(AttemptRow, { key: a.id, attempt: a }); })
          )
        ),
        React.createElement('div', { className: 'rsc-foot' },
          React.createElement('span'),
          React.createElement('a', {
            className: 'rsc-link',
            href: 'https://github.com/SpookySandwich/dsh-plugin-rollout-scout',
            target: '_blank', rel: 'noreferrer',
          }, 'GitHub ↗')
        )
      );
    }

    function ScoutOverlay() {
      const [open, setOpen] = React.useState(false);
      const [live, setLive] = React.useState(false);

      // Keep the launcher dot honest even while the panel is closed.
      React.useEffect(function () {
        if (open) return undefined;
        let alive = true;
        const tick = function () {
          api('GET').then(function (v) { if (alive) setLive(!!v.running); }).catch(function () {});
        };
        tick();
        const timer = setInterval(tick, 5000);
        return function () { alive = false; clearInterval(timer); };
      }, [open]);

      return React.createElement('div', { className: 'rsc-root' },
        open ? React.createElement(ScoutPanel, { onClose: function () { setOpen(false); } }) : null,
        React.createElement('button', {
          type: 'button',
          className: 'rsc-launch',
          'data-live': live || undefined,
          onClick: function () { setOpen(!open); },
        },
          React.createElement('span', { className: 'rsc-dot' }),
          t('launcher')
        )
      );
    }

    slots.inject('shell.overlay', function () {
      return slots.register(
        { name: 'shell.overlay', id: 'rollout-scout', order: 120 },
        ScoutOverlay
      );
    });
  }
};
