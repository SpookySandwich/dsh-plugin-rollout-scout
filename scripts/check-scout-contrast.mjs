import assert from 'node:assert/strict';

// Runs in a real browser. Include nested tint backgrounds and effective opacity.
export function measureContrast(selectors) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 1;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  const rgb = value => {
    context.clearRect(0, 0, 1, 1);
    context.fillStyle = value;
    context.fillRect(0, 0, 1, 1);
    const data = [...context.getImageData(0, 0, 1, 1).data];
    return [...data.slice(0, 3), data[3] / 255];
  };
  const over = (a, b) => [...a.slice(0, 3).map((v, i) => v * a[3] + b[i] * (1 - a[3])), 1];
  const luminance = c => c.slice(0, 3).map(v => v / 255).map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4)
    .reduce((sum, v, i) => sum + v * [.2126, .7152, .0722][i], 0);
  return selectors.flatMap(selector => {
    const elements = [...document.querySelectorAll(selector)];
    if (!elements.length) return [{ selector, missing: true }];
    return elements.map(element => {
      const layers = [];
      let opacity = 1;
      for (let node = element; node; node = node.parentElement) {
        const style = getComputedStyle(node);
        layers.push(rgb(style.backgroundColor));
        opacity *= Number(style.opacity);
      }
      let background = rgb(getComputedStyle(document.body).getPropertyValue('--dsw-alias-bg-base'));
      for (const layer of layers.reverse()) background = over(layer, background);
      const ink = rgb(getComputedStyle(element).color);
      ink[3] *= opacity;
      const a = luminance(over(ink, background)), b = luminance(background);
      return { selector, contrast: (Math.max(a, b) + .05) / (Math.min(a, b) + .05), opacity };
    });
  });
}

export async function checkScoutContrast(page, scheme) {
  const check = async (name, selectors) => {
    const rows = await page.evaluate(measureContrast, selectors);
    for (const row of rows) assert.ok(!row.missing && row.contrast >= 4.5,
      `${scheme} ${name}: ${JSON.stringify(row)}`);
    console.log(`PASS: ${scheme} ${name}; minimum ${Math.min(...rows.map(row => row.contrast)).toFixed(2)}:1`);
  };
  await page.locator('.rsc-selfcheck').waitFor();
  await check('semantic console text', ['.rsc-badge[data-tone=good]', '.rsc-lock[data-on]',
    '.rsc-chip[data-sign=pos]', '.rsc-selfcheck', '.rsc-score-v', '.rsc-btn[data-primary]']);
  const inputs = page.locator('.rsc-input[type=number]');
  let threshold;
  for (let i = 0; i < await inputs.count(); i++) if (await inputs.nth(i).inputValue() === '0.7') threshold = inputs.nth(i);
  assert.ok(threshold, 'Keep threshold must be present');
  await threshold.fill('0.99');
  await page.locator('.rsc-selfcheck[data-bad]').waitFor();
  await check('self-check disagreement', ['.rsc-selfcheck[data-bad]']);
  await threshold.fill('0.7');
  await page.locator('.rsc-selfcheck[data-bad]').waitFor({ state: 'detached' });
  // Desktop notification availability is simulated markup using the shipped
  // styles in the official Web host. This is not a Native Desktop test.
  for (const tone of ['warn', 'ok']) {
    await page.evaluate(tone => {
      const scrim = document.createElement('div');
      scrim.id = 'qa-preflight'; scrim.className = 'rsc-scrim'; scrim.style.animation = 'none';
      const modal = document.createElement('div'); modal.className = 'rsc-modal';
      const state = document.createElement('div'); state.className = 'rsc-modal-state'; state.dataset.tone = tone;
      const text = document.createElement('span'); text.textContent = 'Simulated notification state';
      const button = document.createElement('button'); button.textContent = 'Mute';
      state.append(text, button); modal.append(state); scrim.append(modal); document.body.append(scrim);
    }, tone);
    try { await check(`simulated preflight ${tone}/mute`, ['#qa-preflight span', '#qa-preflight button']); }
    finally { await page.locator('#qa-preflight').evaluate(element => element.remove()); }
  }
}
