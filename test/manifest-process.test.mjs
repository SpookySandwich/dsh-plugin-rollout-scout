// Independent Node processes exercise the OS-owned manifest/delete leases.
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const FOLDER = path.join(os.tmpdir(), 'rollout-scout-manifest-process-test');
const helper = path.resolve('test/helpers/manifest-child.mjs');
let checks = 0;
let failed = 0;
function check(ok, message) {
  checks += 1;
  if (!ok) failed += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${message}`);
}

function runChild(mode, marker) {
  return new Promise((resolve, reject) => {
    const childProcess = spawn(process.execPath, [helper, mode, FOLDER, marker], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    childProcess.stderr.on('data', (chunk) => { stderr += chunk; });
    childProcess.once('error', reject);
    childProcess.once('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`child ${mode} exited ${code}: ${stderr}`));
    });
  });
}

async function untilFile(file, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await fs.access(file).then(() => true, () => false)) return;
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${file}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

await fs.rm(FOLDER, { recursive: true, force: true });
await fs.mkdir(FOLDER, { recursive: true });
const firstMarker = path.join(FOLDER, 'first');
const secondMarker = path.join(FOLDER, 'second');

await Promise.all([runChild('create', firstMarker), runChild('create', secondMarker)]);
const firstId = await fs.readFile(firstMarker, 'utf8');
const secondId = await fs.readFile(secondMarker, 'utf8');
let manifest = JSON.parse(await fs.readFile(path.join(FOLDER, '.rollout-scout.json'), 'utf8'));
check(firstId !== secondId && manifest.owned.includes(firstId) && manifest.owned.includes(secondId),
  'independent processes serialize fresh-read ownership commits without losing either id');
// Delete children start one loader probe so their plugin instance reads this
// non-default folder. Keep those setup probes out of the assertion by giving
// the sibling a durable protected marker.
manifest.protected = [secondId];
await fs.writeFile(path.join(FOLDER, '.rollout-scout.json'), `${JSON.stringify(manifest, null, 2)}\n`);

for (const id of [firstId, secondId]) {
  await fs.mkdir(path.join(FOLDER, 'logs', id), { recursive: true });
  await fs.writeFile(path.join(FOLDER, 'logs', id, 'session.jsonl'), `${id}\n`);
}

const deleteA = runChild('delete', firstMarker);
await untilFile(`${firstMarker}.entered`);
const deleteB = runChild('delete', firstMarker);
await new Promise((resolve) => setTimeout(resolve, 150));
check(!(await fs.access(`${secondMarker}.entered`).then(() => true, () => false)),
  'a second process cannot enter the same physical delete while the first owns its lease');
await fs.writeFile(`${firstMarker}.release`, 'go');
await Promise.all([deleteA, deleteB]);
manifest = JSON.parse(await fs.readFile(path.join(FOLDER, '.rollout-scout.json'), 'utf8'));
check(!manifest.owned.includes(firstId) && manifest.owned.includes(secondId),
  'cross-process duplicate delete converges idempotently and preserves the sibling ownership');
check(!manifest.deleting.includes(firstId),
  'the winning process closes the durable deleting transaction');

await fs.rm(FOLDER, { recursive: true, force: true });
console.log(`\n${checks - failed}/${checks} passed`);
process.exit(failed === 0 ? 0 : 1);
