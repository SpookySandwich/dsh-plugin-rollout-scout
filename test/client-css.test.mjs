// Small source-to-artifact contract checks for shell integration CSS. These
// rules depend on host geometry that the classifier/route tests cannot render.
import fs from 'node:fs';

const source = fs.readFileSync(new URL('../plugin.client.js', import.meta.url), 'utf8');
const built = fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');

let checks = 0;
let failed = 0;

function check(ok, message) {
  checks += 1;
  if (ok) console.log('ok  ', message);
  else {
    failed += 1;
    console.log('FAIL', message);
  }
}

const safeRight = 'max(22px,calc(100vw - env(titlebar-area-x,0px) - env(titlebar-area-width,100vw) + 22px))';

check(
  source.includes(safeRight),
  'console header derives its right inset from Electron title-bar geometry',
);
check(
  built.includes(safeRight),
  'generated client ships the title-bar-safe header inset',
);
check(
  !source.includes('.rsc-top{display:flex;align-items:center;gap:14px;padding:16px 22px;'),
  'the unsafe fixed right inset cannot return unnoticed',
);
check(
  source.includes(".rsc-leftwrap{width:340px;flex:none;min-height:0;display:flex;flex-direction:column;")
    && source.includes(".rsc-left{flex:1;min-height:0;overflow-y:auto;padding:18px 20px 30px;"),
  'the settings column scrolls inside a fixed-width shell, so the action footer stays put',
);
check(
  source.includes("g.document.querySelector('.rsc-seat')")
    && source.includes('onClick: props.onSurfaceClick'),
  'the console forwards clicks through the live launcher rectangle',
);

// position:fixed only means "the viewport" while nothing above it establishes
// a containing block. Mounting on <body> is what makes the full-frame surface
// independent of whatever the shell and its other plugins put in the tree.
check(
  source.includes("require('react-dom')") && source.includes('reactDom.createPortal(view, body)'),
  'the console mounts on document.body rather than inside the shell overlay layer',
);
check(
  built.includes('createPortal'),
  'the generated client ships the portal',
);
check(
  source.includes('const sessionsRevision = remote ? remote.sessionsRevision : null;')
    && source.includes('sessions.refresh()'),
  'every host-side deletion, including auto-delete, can refresh the sidebar baseline',
);
check(
  source.includes("return call('hold', Object.assign({ id: id, lease: lease }, claim));")
    && source.includes('enteredAt: enteredAt,')
    && source.includes('observedDiscardAt: observedDiscardAt,')
    && source.includes('a.discardAt === null || a.discardAt === undefined')
    && source.includes('bestEffortRelease()'),
  'hover rescue sends one fully described claim and a release tombstone',
);
check(
  source.includes('carryHoldUntilPointerMoves(review)')
    && source.includes("doc.addEventListener('pointermove', record.release")
    && source.includes('unsubscribe = review.onClose(detach);')
    && source.includes('review.useTransport({'),
  'opening a hovered conversation carries the same epoch until the pointer moves inside',
);
check(
  source.includes("disabled: liveCount === 0")
    && !source.includes("title: t('forceStopHint'), disabled: blocking === 0"),
  'Force stop stays available for a protected live conversation',
);
check(
  source.includes("retention.durability === 'failed'")
    && source.includes("retention.operation === 'unprotect'")
    && source.includes("t(unkeepTransition ? 'unprotectRetry' : 'protectRetry')")
    && source.includes('props.onProtect(a.id, protectionAction)'),
  'a failed Keep or Unkeep exposes the matching retry action instead of toggling backwards',
);
check(
  source.includes('const appliedRevision = React.useRef(-1)')
    && source.includes('revision < appliedRevision.current')
    && source.includes('if (e && e.state) applyState(e.state)')
    && !source.includes('function ticket()'),
  'host snapshot revisions prevent poll/action response order from repainting stale state',
);
check(
  source.includes("remote.note === 'paused-culled'\n          ? t('notePausedCulled', { count: remote.culled || 0 })")
    && source.includes("remote.note === 'reaped'\n          ? t('noteReaped', { count: remote.reaped || 0 })"),
  'Pause culls and orphan cleanup remain distinct user-facing outcomes',
);
check(
  source.includes('const HOLD_REFRESH_MS = 10_000')
    && source.includes("request('heartbeat')")
    && source.includes("if (mode === 'claim' && phase === 'claiming')")
    && source.includes('refresh = setInterval(function ()')
    && source.includes('clearInterval(refresh)'),
  'stationary and carried reviews heartbeat only after their initial claim ACK',
);
check(
  source.includes('const [visualAnchor, setVisualAnchor] = React.useState(null)')
    && source.includes('const visualAnchorRef = React.useRef(null)')
    && source.includes('const queueScrollRef = React.useRef(null)')
    && source.includes('React.useLayoutEffect(function ()')
    && source.includes('scroller.scrollTop += delta')
    && source.includes('(current.offset || 0) - residual')
    && source.includes("style: props.anchor ? { paddingBottom: '100vh' } : undefined")
    && source.includes('anchor: visualAnchor')
    && !source.includes('queueSnapshot')
    && !source.includes('visualHolds')
    && source.includes('onVisualHold: beginVisualHold')
    && source.includes('onVisualRelease: endVisualHold')
    && source.includes('onMouseEnter: props.onVisualHold')
    && source.includes('props.onVisualHold(a.id, hoverLease.current, event.currentTarget);')
    && !source.includes('const RESCUABLE')
    && source.includes('const reviewEpoch = React.useRef(null);')
    && source.includes('const review = createReviewLease({')
    && source.includes('if (reviewEpoch.current !== rejected) return;')
    && source.includes("if (review.phase === 'rejected') return false;")
    && source.includes('if (review === reviewEpoch.current && pending === review.latestAck)')
    && source.includes('boundedReviewAck(function ()')
    && !source.includes('value !== null')
    && source.includes('&& !(await waitForCurrentReview())) return;')
    && source.includes('return value;')
    && source.includes('return null;')
    && source.includes('onMouseLeave: props.onVisualRelease ? endHover : undefined'),
  'only the hovered row is viewport-anchored while the canonical queue keeps moving',
);
check(
  source.includes("const shownStatus = anchored && !a.protected ? 'hovered' : a.status")
    && source.includes("status_hovered: 'pinned'")
    && source.includes("status_hovered: '固定中'")
    && source.includes('&& !a.protected && !a.held && !anchored')
    && source.includes("'data-anchored': anchored ? '' : undefined")
    && source.includes('.rsc-item[data-anchored]{animation:none;opacity:1;'),
  'local hover immediately cancels fading without hiding a retained card state',
);
check(
  source.includes('const showRetentionControl = a.protected || anchored || retentionPending || retentionFailed;')
    && source.includes("showRetentionControl ? React.createElement('button', {")
    && built.includes('const showRetentionControl = a.protected || anchored || retentionPending || retentionFailed;')
    && built.includes("showRetentionControl ? React.createElement('button', {")
    && !source.includes("status_hovered: '悬停固定'"),
  'ordinary rows hide Keep while fixed, retained, and recovery states expose it',
);
check(
  source.includes("var(--rsc-fade-ms,3200ms)")
    && source.includes('if (a.discardAt === null || a.discardAt === undefined) return null;')
    && source.includes('}, [a.discardAt]);')
    && source.includes("cardStyle['--rsc-fade-ms'] = fadeDurationMs + 'ms';")
    && source.includes("'status_pending-discard': 'fading'")
    && source.includes("'status_pending-discard': '淡出中'")
    && !source.includes('animation:rsc-row-out 3200ms')
    && built.includes("var(--rsc-fade-ms,3200ms)")
    && built.includes('}, [a.discardAt]);'),
  'host discard deadlines drive one memoized fade animation instead of every poll restarting it',
);
check(
  source.includes('overflow-anchor:none;scrollbar-gutter:stable'),
  'browser scroll anchoring and scrollbar reflow cannot fight the explicit row anchor',
);

console.log(`\n${checks - failed}/${checks} passed`);
process.exit(failed === 0 ? 0 : 1);
