// Optional real-browser leg of run-dsh-acceptance.mjs. Install playwright-core
// in an owned QA tools prefix and set DSH_QA_PLAYWRIGHT to its entry point.
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { checkScoutContrast } from './check-scout-contrast.mjs';

async function launchEdge(sandbox) {
  assert.ok(process.env.DSH_QA_PLAYWRIGHT);
  assert.ok(process.env.DSH_QA_BROWSER_EXE);
  const { chromium } = await import(pathToFileURL(process.env.DSH_QA_PLAYWRIGHT));
  const previousTemp = { TEMP: process.env.TEMP, TMP: process.env.TMP };
  let server;
  try {
    process.env.TEMP = process.env.TMP = sandbox;
    server = await chromium.launchServer({ executablePath: process.env.DSH_QA_BROWSER_EXE, headless: true });
  } finally {
    for (const [key, value] of Object.entries(previousTemp)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
  const pid = server.process().pid;
  const profile = server.process().spawnargs.find(arg => arg.startsWith('--user-data-dir='));
  console.log(`Owned Edge PID ${pid}; ${profile}; browser debugging pipe; QA WebSocket port ${new URL(server.wsEndpoint()).port}`);
  return { chromium, server, pid };
}

export async function checkUnsupportedCleanup({ entryUrl, sandbox, runtime, title }) {
  const { chromium, server, pid } = await launchEdge(sandbox);
  let browser;
  try {
    browser = await chromium.connect(server.wsEndpoint());
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'en-US' });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    await page.goto(entryUrl, { waitUntil: 'domcontentloaded' });
    const launcher = page.locator('.rsc-seat');
    await launcher.waitFor({ timeout: 90000 });
    await page.getByRole('button', { name: 'Continue', exact: true }).click({ timeout: 30000 });
    await launcher.click();
    await page.locator('.rsc-selfcheck').waitFor({ timeout: 15000 });
    await page.getByText('This DSH session storage cannot delete conversations', { exact: false }).waitFor();
    for (const name of ['Clear finished', 'Delete all sessions']) {
      assert.ok(await page.getByRole('button', { name, exact: true }).isDisabled(), `${name} is unavailable`);
    }
    assert.equal(await page.getByRole('button', { name: 'Sweep them', exact: true }).count(), 0);
    const autoDelete = page.getByRole('checkbox', { name: 'Delete old-model probes from disk', exact: true });
    assert.ok(await autoDelete.isDisabled() && !(await autoDelete.isChecked()), 'Automatic deletion is shown off');
    const card = page.locator('.rsc-item').filter({ hasText: title });
    await card.getByRole('button', { name: 'Kept', exact: true }).click();
    await page.locator('.rsc-stats').hover();
    await card.hover();
    await card.getByRole('button', { name: 'Keep', exact: true }).click();
    await card.getByRole('button', { name: 'Kept', exact: true }).waitFor({ timeout: 15000 });
    const out = process.env.DSH_QA_SCREENSHOTS || sandbox;
    await mkdir(out, { recursive: true });
    await page.screenshot({ path: join(out, `dsh-${runtime}-scout-sqlite.png`), mask: [page.locator('.rsc-input:not([type=number])')] });
    assert.deepEqual(errors, [], 'SQLite console has no page or console errors');
    console.log('PASS: SQLite console explains unsupported cleanup, disables cleanup controls, and Unkeep/Keep works in the real UI');
  } finally {
    try { await browser?.close(); } finally {
      await server.close();
      console.log(`Stopped owned Edge PID ${pid}`);
    }
  }
}

export async function checkBrowser({ entryUrl, sandbox, runtime }) {
  const { chromium, server, pid } = await launchEdge(sandbox);
  let browser;
  try {
    browser = await chromium.connect(server.wsEndpoint());
    const locale = runtime === '0.2.2-rc.1' ? 'fr-FR' : 'en-US';
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    await page.goto(entryUrl, { waitUntil: 'domcontentloaded' });
    const launcher = page.locator('.rsc-seat');
    await launcher.waitFor({ timeout: 90000 });
    // Fresh official profiles display their preview notice asynchronously.
    await page.getByRole('button', { name: locale === 'fr-FR' ? 'Continuer' : 'Continue', exact: true }).click({ timeout: 30000 });
    await launcher.click();
    await page.locator('.rsc-item').first().waitFor({ timeout: 15000 });
    await page.locator('.rsc-area').fill('QA saved Scout prompt');
    await page.reload({ waitUntil: 'domcontentloaded' });
    await launcher.click();
    await page.locator('.rsc-item').first().waitFor({ timeout: 15000 });
    assert.equal(await page.locator('.rsc-area').inputValue(), 'QA saved Scout prompt');
    assert.equal(await launcher.count(), 1);
    assert.equal(await page.locator('.rsc-full').count(), 1);
    assert.equal(await page.locator('style[data-plugin="dsh-plugin-rollout-scout"]').count(), 1);
    await page.locator('.rsc-full').evaluate(async element => {
      await Promise.all(element.getAnimations({ subtree: true }).map(animation => animation.finished));
    });
    assert.match(await page.locator('body').innerText(), /I'll validate this offline probe/);
    assert.doesNotMatch(await page.locator('.rsc-item').first().innerText(), /<signature>/);
    assert.equal(await page.locator('html').getAttribute('lang'), locale === 'fr-FR' ? 'fr' : 'en');
    assert.ok(await page.getByText('Probe setup', { exact: true }).isVisible(), 'Scout falls back to English');
    const out = process.env.DSH_QA_SCREENSHOTS || sandbox;
    await mkdir(out, { recursive: true });
    for (const scheme of ['light', 'dark']) {
      await page.emulateMedia({ colorScheme: scheme });
      await page.waitForFunction(dark => document.body.hasAttribute('data-ds-dark-theme') === dark, scheme === 'dark');
      const colors = await page.locator('.rsc-full').evaluate(element => {
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = 1;
        const context = canvas.getContext('2d', { willReadFrequently: true });
        function rgb(value) {
          context.clearRect(0, 0, 1, 1);
          context.fillStyle = value;
          context.fillRect(0, 0, 1, 1);
          return Array.from(context.getImageData(0, 0, 1, 1).data);
        }
        const style = getComputedStyle(element);
        const foreground = rgb(style.color);
        const background = rgb(style.backgroundColor);
        const base = rgb(style.getPropertyValue('--dsw-alias-bg-base'));
        const alpha = background[3] / 255;
        const composite = background.slice(0, 3).map((value, i) => value * alpha + base[i] * (1 - alpha));
        function luminance(values) {
          return values.slice(0, 3).map(value => {
            const channel = value / 255;
            return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
          }).reduce((sum, value, i) => sum + value * [0.2126, 0.7152, 0.0722][i], 0);
        }
        const a = luminance(foreground), b = luminance(composite);
        return { foreground: style.color, background: style.backgroundColor,
          contrast: (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05) };
      });
      assert.ok(colors.contrast >= 4.5, `Scout primary text must remain readable (${scheme}): ${JSON.stringify(colors)}`);
      console.log(`PASS: ${scheme} theme primary text contrast ${colors.contrast.toFixed(2)}:1`);
      await checkScoutContrast(page, scheme);
      await page.screenshot({ path: join(out, `dsh-${runtime}-scout-${scheme}.png`), mask: [page.locator('.rsc-input:not([type=number])')] });
    }
    await page.emulateMedia({ colorScheme: 'light' });
    await page.waitForFunction(() => !document.body.hasAttribute('data-ds-dark-theme'));
    assert.equal((await page.locator('.rsc-full').boundingBox()).y, 0);
    await page.evaluate(() => {
      document.documentElement.setAttribute('data-windows-titlebar', '');
      document.documentElement.style.setProperty('--dsh-windows-titlebar-height', '40px');
    });
    for (const [fullscreen, top] of [[false, 40], [true, 0]]) {
      await page.evaluate(value => document.documentElement.toggleAttribute('data-fullscreen', value), fullscreen);
      assert.equal((await page.locator('.rsc-full').boundingBox()).y, top, `Scout clears the Windows caption (fullscreen=${fullscreen})`);
    }
    await page.evaluate(() => {
      for (const name of ['data-windows-titlebar', 'data-fullscreen']) document.documentElement.removeAttribute(name);
      document.documentElement.style.removeProperty('--dsh-windows-titlebar-height');
    });
    for (const size of [{ width: 1440, height: 1000 }, { width: 1000, height: 760 }]) {
      await page.setViewportSize(size);
      const box = await page.getByRole('button', { name: 'Force stop', exact: true }).boundingBox();
      assert.ok(box && box.x >= 0 && box.y >= 0 && box.x + box.width <= size.width && box.y + box.height <= size.height,
        `Action footer fits ${size.width}x${size.height}`);
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.locator('.rsc-item').first().click();
    await page.getByText('Offline Scout acceptance reply.', { exact: true }).waitFor({ timeout: 30000 });
    await page.screenshot({ path: join(out, `dsh-${runtime}-conversation.png`) });
    assert.deepEqual(errors, [], 'Official host navigation has no page or console errors');
    console.log(`PASS: Edge ${await browser.version()}, official launcher, ${locale} host, signed preview, 1440/1000px layout, retained-session navigation; no page or console errors`);
  } finally {
    try { await browser?.close(); } finally {
      await server.close();
      console.log(`Stopped owned Edge PID ${pid}`);
    }
  }
}
