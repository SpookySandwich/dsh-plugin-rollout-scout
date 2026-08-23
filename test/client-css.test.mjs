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

console.log(`\n${checks - failed}/${checks} passed`);
process.exit(failed === 0 ? 0 : 1);
