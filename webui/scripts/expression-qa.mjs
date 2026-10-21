import path from 'node:path';

export async function runExpressionQa({ browser, baseUrl, fixtureFile, expressionFile, expressionWithoutClose, qaRoot }) {
  const errors = [];
  const external = [];
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.route('**/*', route => {
    if (new URL(route.request().url()).origin !== baseUrl) {
      external.push(route.request().url()); return route.abort();
    }
    return route.continue();
  });
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${baseUrl}/?autoload=0`);
  const load = async file => {
    await page.evaluate(() => { window.rigQa.ready = false; });
    await page.setInputFiles('#psd-file-input', file);
    await page.waitForFunction(() => window.rigQa?.ready);
    await page.evaluate(() => {
      window.rigQa.setAutoBlink(false); window.rigQa.setMode('static');
      window.rigQa.resetProfileParameters(); window.rigQa.setState(1, 0);
      window.rigQa.setViewTransform(0, 0, 1);
      document.querySelector('#advanced-parameters').open = true;
      document.querySelector('[data-parameter-group="eyes"]').open = true;
    });
    await page.waitForTimeout(600);
  };
  const controls = () => page.evaluate(() => Object.fromEntries(['eyeSmile', 'blush'].map(key => [key, {
    disabled: document.querySelector(`#parameter-${key}`).disabled,
    numberDisabled: document.querySelector(`#parameter-${key}-number`).disabled,
    reason: document.querySelector(`#parameter-${key}-reason`).innerText,
    reasonHidden: document.querySelector(`#parameter-${key}-reason`).hidden,
    value: window.rigQa.getProfileParameters()[key],
  }])));
  const capture = async name => {
    await page.waitForTimeout(600);
    await page.evaluate(name => new Promise(resolve => requestAnimationFrame(() => {
      const canvas = document.querySelector('#rig-canvas');
      const gl = canvas.getContext('webgl');
      const data = new Uint8Array(canvas.width * canvas.height * 4);
      gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, data);
      window.__expressionFrames ??= {};
      window.__expressionFrames[name] = { data, width: canvas.width, height: canvas.height };
      resolve();
    })), name);
  };
  const difference = (before, after, region = [0, 0, 256, 256]) => page.evaluate(({ before, after, region }) => {
    const a = window.__expressionFrames[before]; const b = window.__expressionFrames[after];
    let inside = 0; let outside = 0; let totalDelta = 0;
    for (let index = 0; index < a.width * a.height; index += 1) {
      const offset = index * 4;
      const delta = Math.max(...[0, 1, 2, 3].map(c => Math.abs(a.data[offset + c] - b.data[offset + c])));
      totalDelta += delta;
      if (delta <= 1) continue;
      const x = index % a.width; const y = a.height - 1 - Math.floor(index / a.width);
      if (x >= region[0] && x <= region[2] && y >= region[1] && y <= region[3]) inside += 1;
      else outside += 1;
    }
    return { inside, outside, totalDelta };
  }, { before, after, region });
  const state = (eyeSmile, blush, eye = 1) => page.evaluate(args => window.rigQa.setState(args.eye, 0, args), { eyeSmile, blush, eye });

  await load(fixtureFile);
  const missing = await controls();
  await capture('missing-neutral');
  for (const eye of [0.5, 0]) {
    await state(0, 0, eye); await capture(`missing-blink-${eye}`);
  }
  await state(0, 0);
  await state(1, 1); await capture('missing-values');
  const absentPixels = await difference('missing-neutral', 'missing-values');
  await page.locator('#parameter-blush-number').evaluate(input => input.scrollIntoView({ block: 'center' }));
  await page.screenshot({ path: path.join(qaRoot, 'expressions-unavailable.png'), fullPage: true });

  await load(expressionFile);
  const available = await controls();
  await capture('neutral');
  const neutralMatchesLegacy = await difference('missing-neutral', 'neutral');
  const zeroSmileBlinks = [];
  for (const eye of [0.5, 0]) {
    await state(0, 0, eye); await capture(`zero-blink-${eye}`);
    zeroSmileBlinks.push(await difference(`missing-blink-${eye}`, `zero-blink-${eye}`));
  }
  await state(0.25, 0); await capture('smile-quarter');
  await state(0.5, 0); await capture('smile-half');
  for (const strength of [0, 0.25, 0.5, 0.48, 0.5, 0.52, 0.75, 1]) for (const eye of [1, 0.5, 0]) {
    await state(strength, 0, eye);
    await capture(`smile-${strength}-blink-${eye}`);
    await page.locator('#rig-canvas').screenshot({ path: path.join(qaRoot, `expression-smile-${strength}-blink-${eye}.png`) });
  }
  await state(1, 0); await capture('smile');
  const thresholdSwitch = await difference('smile-0.5-blink-1', 'smile');
  const thresholdBefore = await difference('smile-0.48-blink-1', 'smile', [70, 65, 180, 100]);
  const thresholdAfter = await difference('smile-0.52-blink-1', 'smile');
  const lowerLid = await page.evaluate(() => {
    const names = ['neutral', 'smile-quarter', 'smile-half', 'smile-0.48-blink-1'];
    return Object.fromEntries(names.map(name => {
      const frame = window.__expressionFrames[name];
      const eyes = [[86, 116], [140, 170]].map(([x0, x1]) => {
        let whiteBottom = -1, white = 0, iris = 0, upperInk = 100, closedInk = 0;
        for (let y = 65; y <= 92; y++) for (let x = x0; x <= x1; x++) {
          const i = ((frame.height - 1 - y) * frame.width + x) * 4;
          const [r,g,b] = frame.data.slice(i, i + 3);
          if (r > 235 && g > 235 && b > 235) { white++; whiteBottom = Math.max(whiteBottom, y); }
          if (b > r + 35 && g > r + 30 && b > 110) iris++;
          if (r < 120 && g < 100 && b < 90 && x >= x0 + 10 && x <= x1 - 10) {
            upperInk = Math.min(upperInk, y);
            if (y >= 78 && y <= 81) closedInk++;
          }
        }
        return { white, whiteBottom, iris, upperInk, closedInk };
      });
      return [name, eyes];
    }));
  });
  await page.locator('#rig-canvas').screenshot({ path: path.join(qaRoot, 'expression-smile.png') });
  await state(1, 0, 0); await capture('smile-blink');
  const smile = await difference('neutral', 'smile', [70, 55, 180, 100]);
  const smileHalf = await difference('neutral', 'smile-half');
  const smileBlink = await difference('smile', 'smile-blink');
  await state(0, 0.5); await capture('blush-half');
  await state(0, 1); await capture('blush');
  await page.locator('#rig-canvas').screenshot({ path: path.join(qaRoot, 'expression-blush.png') });
  const blush = await difference('neutral', 'blush', [76, 90, 178, 118]);
  const blushHalf = await difference('neutral', 'blush-half');
  await state(1, 0);
  const eyeTransforms = {};
  for (const [key, value] of Object.entries({ eyeCY: 0.6, eyeCAng: 0.8, eyeScaleR: 1.4, angleX: 0.5 })) {
    await page.evaluate(([key, value]) => window.rigQa.setProfileParameter(key, value), [key, value]);
    await capture(key); eyeTransforms[key] = await difference('smile', key);
    await page.evaluate(key => window.rigQa.setProfileParameter(key, key === 'eyeScaleR' ? 1 : 0), key);
  }
  await state(0, 0); await capture('restored');
  const restored = await difference('neutral', 'restored');
  await page.locator('#parameter-eyeSmile-number').fill('1');
  await page.locator('#parameter-eyeSmile-number').dispatchEvent('change');
  await page.locator('#parameter-blush-number').fill('0.7');
  await page.locator('#parameter-blush-number').dispatchEvent('change');
  const sliders = await controls();
  await capture('both');
  await page.locator('#parameter-blush-number').evaluate(input => input.scrollIntoView({ block: 'center' }));
  await page.screenshot({ path: path.join(qaRoot, 'expressions-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 375, height: 812 });
  await page.screenshot({ path: path.join(qaRoot, 'expressions-mobile.png'), fullPage: true });
  const mobile = await page.evaluate(() => ({ width: document.documentElement.scrollWidth, viewport: innerWidth,
    controlsFit: ['eyeSmile', 'blush'].every(key => {
      const box = document.querySelector(`#parameter-${key}-number`).getBoundingClientRect();
      return box.left >= 0 && box.right <= innerWidth;
    }) }));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.evaluate(() => window.rigQa.setWorkspaceMode('layers'));
  await page.locator('#layer-order-details').evaluate(details => { details.open = true; });
  const selections = {};
  for (const [name, label] of [['eye_smile', '笑い目'], ['blush', '頬の赤らみ']]) {
    await page.locator('.layer-order-item').filter({ hasText: label }).click();
    await capture(`selected-${name}`);
    selections[name] = await page.evaluate(() => window.rigQa.getLayerEditorState());
    await page.locator('#rig-canvas').screenshot({ path: path.join(qaRoot, `expression-selected-${name}.png`) });
  }
  await page.evaluate(() => { window.rigQa.setWorkspaceMode('motion'); window.rigQa.setState(1, 0, { eyeSmile: 0, blush: 0 }); });
  await capture('after-selection');
  const afterSelection = await difference('neutral', 'after-selection');

  // Load the generated entry, so the same PSD is available to the stream receiver.
  const items = (await (await fetch(`${baseUrl}/api/generated-psds`)).json()).items;
  const psd = items.find(item => item.name === path.basename(expressionFile)).id;
  await page.evaluate(() => { window.rigQa.ready = false; });
  await page.selectOption('#generated-psd-select', psd);
  await page.waitForFunction(() => window.rigQa?.ready && window.rigQa.summary.partsFound.includes('eye_smile'));
  await page.evaluate(() => {
    window.rigQa.setAutoBlink(false); window.rigQa.setMode('static');
    window.rigQa.setState(1, 0, { eyeSmile: 0, blush: 0 }); window.rigQa.setLiveEnabled(true);
  });
  const receiver = await context.newPage();
  receiver.on('pageerror', error => errors.push(error.message));
  await receiver.goto(`${baseUrl}/stream.html?psd=${encodeURIComponent(psd)}`);
  await receiver.waitForFunction(() => window.streamQa?.state().ready);
  const streamCapture = () => receiver.evaluate(() => new Promise(resolve => requestAnimationFrame(() => {
    const canvas = document.querySelector('#avatar'); const gl = canvas.getContext('webgl');
    const data = new Uint8Array(canvas.width * canvas.height * 4);
    gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, data);
    resolve(Array.from(data));
  })));
  await receiver.waitForTimeout(600);
  const streamBefore = await streamCapture();
  await state(0.7, 0.6);
  await receiver.waitForFunction(() => window.streamQa.state().settings?.parameters.eyeSmile === 0.7 && window.streamQa.state().settings?.parameters.blush === 0.6);
  await receiver.waitForTimeout(600);
  const streamAfter = await streamCapture();
  const streamChanged = streamBefore.some((value, index) => Math.abs(value - streamAfter[index]) > 1);
  const streamSettings = await receiver.evaluate(() => window.streamQa.state().settings.parameters);
  await page.evaluate(() => window.rigQa.setLiveEnabled(false));
  await load(expressionWithoutClose);
  const withoutCloseParts = await page.evaluate(() => window.rigQa.summary.partsFound);
  for (const strength of [0.48, 0.5, 0.52, 1]) {
    await state(strength, 0); await capture(`no-close-${strength}`);
    await page.locator('#rig-canvas').screenshot({ path: path.join(qaRoot, `expression-no-close-${strength}.png`) });
  }
  await state(0.5, 0, 0); await capture('no-close-blink');
  const noCloseSwitch = await difference('no-close-0.5', 'smile-0.5-blink-1');
  const noCloseThreshold = await difference('no-close-0.48', 'no-close-0.5');
  const noCloseAfter = await difference('no-close-0.52', 'smile-0.52-blink-1');
  const noCloseBlink = await difference('no-close-0.5', 'no-close-blink');
  await context.close();

  return { missing, available, absentPixels, neutralMatchesLegacy, zeroSmileBlinks, lowerLid, thresholdSwitch, thresholdBefore, thresholdAfter, smile, smileHalf, smileBlink, blush, blushHalf,
    eyeTransforms, restored, sliders, mobile, selections, afterSelection, streamSettings,
    withoutCloseParts, noCloseSwitch, noCloseThreshold, noCloseAfter, noCloseBlink, errors, external,
    checks: {
      missingExpressionsDisabledWithReasons: Object.values(missing).every(item => item.disabled && item.numberDisabled && !item.reasonHidden && item.reason.includes('絵がありません')),
      absentExpressionsPreservePixels: absentPixels.inside === 0 && neutralMatchesLegacy.inside === 0,
      zeroSmilePreservesLegacyBlinks: zeroSmileBlinks.every(diff => diff.totalDelta === 0),
      smileRaisesLowerLid: [0, 1].every(side => {
        const before = lowerLid.neutral[side], quarter = lowerLid['smile-quarter'][side], half = lowerLid['smile-half'][side];
        return half.whiteBottom < quarter.whiteBottom && quarter.whiteBottom < before.whiteBottom &&
          half.iris < quarter.iris && quarter.iris < before.iris && Math.abs(half.upperInk - before.upperInk) <= 4;
      }),
      smileNeverUsesClosedArtwork: ['smile-quarter','smile-half','smile-0.48-blink-1'].every(name =>
        lowerLid[name].every(eye => eye.closedInk === 0)),
      smileMorphContinuesAfterSwitch: thresholdSwitch.totalDelta > 0 && thresholdAfter.totalDelta > 0,
      smileSwitchWorksWithoutClosedArtwork: !withoutCloseParts.includes('eye_close') && noCloseThreshold.totalDelta > 0 &&
        noCloseSwitch.totalDelta === 0 && noCloseAfter.totalDelta === 0 && noCloseBlink.totalDelta === 0,
      expressionControlsEnabled: Object.values(available).every(item => !item.disabled && !item.numberDisabled && item.reasonHidden && item.value === 0),
      smileChangesOnlyEyes: smile.inside > 10 && smile.outside === 0,
      smileIgnoresBlinkAtFullStrength: smileBlink.inside === 0,
      blushChangesOnlyCheeks: blush.inside > 10 && blush.outside === 0,
      expressionStrengthsFollowStages: smileHalf.totalDelta > 0 && smileHalf.totalDelta < smile.totalDelta && blushHalf.totalDelta > 0 && blushHalf.totalDelta < blush.totalDelta,
      smileFollowsEyeAndHeadControls: Object.values(eyeTransforms).every(diff => diff.inside > 0),
      expressionsRestoreNeutral: restored.inside === 0 && afterSelection.inside === 0,
      expressionSlidersWork: sliders.eyeSmile.value === 1 && sliders.blush.value === 0.7,
      expressionMobileFits: mobile.width <= mobile.viewport && mobile.controlsFit,
      expressionLayerSelection: selections.eye_smile.selectedLayer === 'eye_smile' && selections.blush.selectedLayer === 'blush',
      expressionsReachStream: streamSettings.eyeSmile === 0.7 && streamSettings.blush === 0.6 && streamChanged,
      expressionQaStaysLocal: external.length === 0 && errors.length === 0,
    } };
}
