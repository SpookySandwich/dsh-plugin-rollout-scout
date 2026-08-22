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
  source.includes('.rsc-left{width:340px;flex:none;overflow-y:auto;padding:18px 20px 40px;margin-bottom:110px;'),
  'console controls leave the sidebar footer toggle zone clear',
);
check(
  source.includes("g.document.querySelector('.rsc-seat')")
    && source.includes('onClick: props.onSurfaceClick'),
  'the console forwards clicks through the live launcher rectangle',
);

console.log(`\n${checks - failed}/${checks} passed`);
process.exit(failed === 0 ? 0 : 1);
