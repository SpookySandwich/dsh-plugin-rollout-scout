// Exercise npm's prerelease peer resolver against the actual packed plugin.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

assert.ok(process.env.npm_execpath, 'Run through npm run check:peers');
const root = resolve(import.meta.dirname, '..');
const sandbox = mkdtempSync(join(process.env.DSH_QA_SANDBOX_ROOT || tmpdir(), 'rollout-scout-peers-'));
function npm(args, cwd) {
  const result = spawnSync(process.execPath, [process.env.npm_execpath, ...args], {
    cwd, encoding: 'utf8', timeout: 120000,
  });
  assert.equal(result.status, 0, result.error?.message || result.stderr || result.stdout);
  return result.stdout;
}
try {
  const [pack] = JSON.parse(npm(['pack', '--json', '--silent', '--pack-destination', sandbox], root));
  for (const version of ['0.2.0-rc.2', '0.2.1-rc.2', '0.2.1-rc.5', '0.2.2-rc.1', '0.2.2-rc.3']) {
    const target = join(sandbox, version);
    mkdirSync(target);
    npm(['install', '--package-lock-only', '--strict-peer-deps', '--ignore-scripts', '--no-audit', '--no-fund',
      `@deepseek-ai/dsh@${version}`, join(sandbox, pack.filename)], target);
    console.log(`PASS: packed plugin resolves with official DSH ${version} under strict npm peers`);
  }
} finally {
  rmSync(sandbox, { recursive: true, force: true });
}
