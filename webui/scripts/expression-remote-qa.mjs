import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { createHash } from 'node:crypto';
import { expressionPresets, expressionParameterNames, expressionPresetValues, expressionPresetAvailability } from '../../src/expressionPresets.mjs';
import { createExpressionTransition } from '../src/expressionTransition.mjs';

export async function runExpressionRemoteQa({ browser, baseUrl, psd, qaRoot }) {
  await fs.mkdir(qaRoot, { recursive: true });
  const errors = [], requests = [], pictures = [];
  const context = await browser.newContext({ viewport: { width: 1440, height: 1080 } });
  await context.addInitScript(() => Object.defineProperty(navigator, 'clipboard', {
    value: { writeText: async value => { window.__copiedExpressionText = value; } },
  }));
  await context.route('**/*', route => {
    if (!['localhost', '127.0.0.1'].includes(new URL(route.request().url()).hostname)) return route.abort();
    return route.continue();
  });
  context.on('page', page => page.on('pageerror', error => errors.push(error.message)));
  const controller = async () => {
    const page = await context.newPage();
    await page.goto(baseUrl + '/?autoload=0');
    await page.selectOption('#generated-psd-select', psd.id);
    await page.waitForFunction(() => window.rigQa?.ready || window.rigQa?.error, null, { timeout: 60000 });
    assert.equal(await page.evaluate(() => window.rigQa.error), null);
    await page.waitForFunction(() => document.querySelector('#expression-remote').dataset.connected === 'true');
    return page;
  };
  const parametersMatch = (actual, expected) => expressionParameterNames.every(key => Math.abs((actual?.[key] ?? 0) - expected[key]) < 0.00001);
  const waitSettings = (page, expected) => page.waitForFunction(({ expected, keys }) => {
    const parameters = window.streamQa.state().settings?.parameters;
    return keys.every(key => Math.abs((parameters?.[key] ?? 0) - expected[key]) < 0.00001);
  }, { expected, keys: expressionParameterNames }, { timeout: 10000 });
  try {
    const sender = await controller();
    const parts = await sender.evaluate(() => window.rigQa.summary.partsFound);
    assert.ok(expressionPresets.every(item => expressionPresetAvailability(item.id, parts).available));
    await sender.evaluate(() => { window.rigQa.setAutoBlink(false); window.rigQa.setMode('static'); window.rigQa.setProfileParameter('physAmp', 1.4); window.rigQa.setLiveEnabled(true); });
    const receiver = await context.newPage();
    await receiver.setViewportSize({ width: 1080, height: 1080 });
    await receiver.goto(`${baseUrl}/stream.html?psd=${encodeURIComponent(psd.id)}`);
    await receiver.waitForFunction(() => window.streamQa?.state().ready, null, { timeout: 60000 });
    await sender.locator('#expression-remote > summary').click();
    await sender.click('#expression-remote-copy-url');
    assert.equal(await sender.evaluate(() => window.__copiedExpressionText), baseUrl + '/__live/expression');
    await sender.click('#expression-remote-copy-secret');
    await sender.waitForFunction(() => document.querySelector('#expression-remote-status').textContent.startsWith('合言葉をコピーしました'));
    let secret = await sender.evaluate(() => window.__copiedExpressionText);
    assert.ok(/^[\w-]{43}$/.test(secret), 'The credential was copied successfully.');
    assert.equal(await sender.locator('.expression-panel').innerText().then(text => text.includes(secret)), false);
    await sender.locator('.expression-panel').screenshot({ path: path.join(qaRoot, 'panel-after.png') });
    const post = async (expression, bearer = false, extra = {}) => {
      const response = await fetch(baseUrl + '/__live/expression', { method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(bearer ? { Authorization: `Bearer ${secret}` } : { 'X-Studio-Token': secret }) },
        body: JSON.stringify({ expression, ...extra }) });
      const body = await response.json();
      assert.equal(response.status, 200, JSON.stringify(body));
      assert.equal([...response.headers].some(([key]) => key.startsWith('access-control-allow-')), false);
      requests.push({ requested: expression, response: body });
      return response;
    };
    const hashes = [];
    for (const [index, preset] of expressionPresets.entries()) {
      await post(preset.id, index % 2 === 1);
      await waitSettings(receiver, expressionPresetValues(preset.id, parts));
      assert.equal(await sender.locator(`[data-expression-preset="${preset.id}"]`).getAttribute('aria-pressed'), 'true');
      assert.equal(await sender.locator('#expression-status').textContent(), preset.label);
      assert.equal(await receiver.evaluate(() => window.streamQa.state().settings.parameters.physAmp), 1.4);
      const file = path.join(qaRoot, `preset-${preset.id}.png`);
      const pixels = await receiver.screenshot({ path: file, omitBackground: true });
      hashes.push(createHash('sha256').update(pixels).digest('hex')); pictures.push(path.relative(process.cwd(), file));
    }
    assert.equal(new Set(hashes).size, expressionPresets.length);

    // Actual background path: stop source animation frames, keep the Worker publisher alive.
    await sender.evaluate(() => {
      window.__expressionRaf = window.requestAnimationFrame;
      window.requestAnimationFrame = () => 0;
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    });
    await post('angry');
    await waitSettings(receiver, expressionPresetValues('angry', parts));
    await post('neutral');
    await waitSettings(receiver, expressionPresetValues('neutral', parts));
    await post('smile');
    await waitSettings(receiver, expressionPresetValues('joy', parts));
    const beforeRepeat = await receiver.evaluate(() => window.streamQa.state().settings.parameters);
    await post('joy');
    await receiver.waitForTimeout(100);
    assert.ok(parametersMatch(await receiver.evaluate(() => window.streamQa.state().settings.parameters), beforeRepeat));
    await receiver.screenshot({ path: path.join(qaRoot, 'hidden-controller-joy.png'), omitBackground: true });

    // Inspect smoothstep at 0.05 time steps through the existing controls' numeric step sizes.
    // Completion of the real timed transition was checked above with rAF disabled.
    const from = expressionPresetValues('neutral', parts), to = expressionPresetValues('joy', parts);
    const transition = createExpressionTransition(expressionParameterNames);
    transition.start(from, to, 0);
    const strip = [];
    for (let i = 0; i <= 20; i++) {
      const values = transition.sample(i * 250 / 20);
      const applied = await sender.evaluate(({ values, keys }) => {
        window.rigQa.setState(1, 0, values);
        return Object.fromEntries(keys.map(key => {
          const input = document.querySelector(`#parameter-${key}-number`);
          return [key, input ? Number(input.value) : values[key]];
        }));
      }, { values, keys: expressionParameterNames });
      await waitSettings(receiver, applied);
      // The stream consumes settings before its renderer commits a drawing-slot handoff.
      await receiver.waitForTimeout(350);
      const file = path.join(qaRoot, `transition-${(i / 20).toFixed(2)}.png`);
      await receiver.screenshot({ path: file, omitBackground: true });
      strip.push({ progress: i / 20, values: applied, image: path.relative(process.cwd(), file) });
    }

    await post('neutral'); await waitSettings(receiver, from);
    const second = await controller();
    await post('angry'); await waitSettings(receiver, expressionPresetValues('angry', parts));
    assert.equal(await sender.locator('[data-expression-preset="angry"]').getAttribute('aria-pressed'), 'true');
    assert.equal(await second.locator('[data-expression-preset="neutral"]').getAttribute('aria-pressed'), 'true');
    await sender.close();
    await post('surprise', false, { psd: psd.id });
    await second.waitForFunction(() => document.querySelector('[data-expression-preset="surprised"]').getAttribute('aria-pressed') === 'true');
    await waitSettings(receiver, expressionPresetValues('surprised', parts));

    await second.locator('#expression-remote > summary').click();
    await second.click('#expression-remote-rotate');
    await second.waitForFunction(() => document.querySelector('#expression-remote-status').textContent.includes('作り直しました'));
    const obsolete = await fetch(baseUrl + '/__live/expression', { method: 'POST', headers: { 'X-Studio-Token': secret }, body: '{"expression":"neutral"}' });
    assert.equal(obsolete.status, 401);
    await second.click('#expression-remote-copy-secret');
    await second.waitForFunction(() => document.querySelector('#expression-remote-status').textContent.startsWith('合言葉をコピーしました'));
    secret = await second.evaluate(() => window.__copiedExpressionText);
    await post('halfLidded'); await waitSettings(receiver, expressionPresetValues('unamused', parts));
    const crossOrigin = await fetch(baseUrl + '/__live/expression', { method: 'POST', headers: { Origin: 'https://example.com', 'X-Studio-Token': secret }, body: '{"expression":"neutral"}' });
    assert.equal(crossOrigin.status, 403);
    const options = await fetch(baseUrl + '/__live/expression', { method: 'OPTIONS' });
    assert.equal(options.status, 405);
    assert.equal([...options.headers].some(([key]) => key.startsWith('access-control-allow-')), false);
    assert.equal(errors.length, 0, errors.join('\n'));
    const report = { checks: { nineExpressionsReachStream: true, distinctRendering: true, buttonsAndStatusSynchronized: true,
      backgroundTransitionCompletes: true, sameExpressionKeepsCurrentValues: true, onlyLiveControllerReceives: true,
      lastControllerTakesOver: true, rotationInvalidatesOldCredential: true, noCorsOrForeignOrigin: true,
      nonExpressionSettingsPreserved: true, credentialNotDisplayed: true }, requests, pictures, strip, errors };
    await fs.writeFile(path.join(qaRoot, 'report.json'), JSON.stringify(report, null, 2));
    return report;
  } finally { await context.close(); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { url: { type: 'string', default: 'http://127.0.0.1:5173' }, job: { type: 'string' }, output: { type: 'string', default: '.still2rig-psd/expression-remote-review' } } });
  const items = (await (await fetch(values.url + '/api/generated-psds')).json()).items;
  const psd = items.find(item => item.jobId === values.job);
  if (!psd) throw new Error('Specify a saved PSD with --job.');
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ headless: true, args: ['--use-angle=metal', '--enable-webgl', '--ignore-gpu-blocklist'] });
  try {
    const report = await runExpressionRemoteQa({ browser, baseUrl: values.url, psd, qaRoot: path.resolve(values.output) });
    console.log(JSON.stringify(report.checks));
  } finally { await browser.close(); }
}
