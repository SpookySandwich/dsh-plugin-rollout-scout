// Execute the exact DOM geometry helper shipped in plugin.client.js against a
// deterministic scroll model. This catches the two layout cases behind the UI
// contract: insertion above an anchored row, and removal above it while the
// scroll container is already clamped at zero.
import fs from 'node:fs';

const source = fs.readFileSync(new URL('../plugin.client.js', import.meta.url), 'utf8');
const start = source.indexOf('function stabilizeVisualAnchor(');
const endMarker = '\n}\n\nfunction pct(';
const end = source.indexOf(endMarker, start);
if (start === -1 || end === -1) throw new Error('cannot locate stabilizeVisualAnchor');
const body = source.slice(start, end + 2);
const stabilizeVisualAnchor = new Function(`${body}\nreturn stabilizeVisualAnchor;`)();

let checks = 0;
let failed = 0;
function check(value, message) {
  checks += 1;
  if (!value) failed += 1;
  console.log(`${value ? 'PASS' : 'FAIL'}  ${message}`);
}

function model({ id = 'hovered', baseTop, targetTop, maxScroll }) {
  let scroll = 0;
  let margin = 0;
  const card = {
    getAttribute(name) { return name === 'data-id' ? id : null; },
    getBoundingClientRect() { return { top: baseTop + margin - scroll }; },
  };
  const scroller = {
    querySelectorAll() { return [card]; },
    get scrollTop() { return scroll; },
    set scrollTop(value) { scroll = Math.max(0, Math.min(maxScroll, value)); },
  };
  return {
    anchor: { id, top: targetTop }, card, scroller,
    get margin() { return margin; },
    set margin(value) { margin = value; },
    get scrollTop() { return scroll; },
  };
}

const insertion = model({ baseTop: 300, targetTop: 200, maxScroll: 1000 });
let residual = stabilizeVisualAnchor(insertion.scroller, insertion.anchor);
check(Math.abs(residual) < 0.001 && insertion.scrollTop === 100,
  'an insertion above is absorbed by scroll and the hovered row keeps its Y');

const removalAtTop = model({ baseTop: 100, targetTop: 200, maxScroll: 1000 });
residual = stabilizeVisualAnchor(removalAtTop.scroller, removalAtTop.anchor);
check(residual === -100 && removalAtTop.scrollTop === 0,
  'scroll clamping reports the exact upward residual');
removalAtTop.margin = Math.max(0, removalAtTop.margin - residual);
residual = stabilizeVisualAnchor(removalAtTop.scroller, removalAtTop.anchor);
check(Math.abs(residual) < 0.001 && removalAtTop.card.getBoundingClientRect().top === 200,
  'the margin fallback restores the row when scrollTop cannot go negative');

check(stabilizeVisualAnchor({ querySelectorAll: () => [] }, { id: 'gone', top: 10 }) === null,
  'a missing row is an explicit no-op rather than a bad scroll');

console.log(`\n${checks - failed}/${checks} passed`);
process.exit(failed === 0 ? 0 : 1);
