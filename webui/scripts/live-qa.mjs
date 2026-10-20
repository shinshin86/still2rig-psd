import path from 'node:path';

export async function runLiveQa({ browser, baseUrl, psd, fixtureFile, qaRoot, restart }) {
  const external = [];
  const errors = [];
  const context = await browser.newContext({ viewport: { width: 1080, height: 1080 }, permissions: ['clipboard-read', 'clipboard-write'] });
  await context.route('**/*', route => {
    if (!['localhost', '127.0.0.1'].includes(new URL(route.request().url()).hostname)) { external.push(route.request().url()); return route.abort(); }
    return route.continue();
  });
  const sender = await context.newPage();
  await sender.goto(baseUrl);
  await sender.waitForFunction(() => window.rigQa?.ready);
  await sender.click('#camera-tab');
  // Capture and sampling must work with page animation frames disabled.
  await sender.evaluate(() => {
    window.__liveRaf = window.requestAnimationFrame;
    window.requestAnimationFrame = () => 0;
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
  });
  const model = await (await fetch(`${baseUrl}/api/face-model/status`)).json();
  let backgroundCapture = { skipped: !model.ready };
  if (model.ready) {
    await sender.click('#camera-start');
    await sender.waitForFunction(() => window.rigQa.getCameraState().state === 'missing', null, { timeout: 45000 });
    backgroundCapture = { skipped: false, ...await sender.evaluate(() => window.rigQa.getCameraState()) };
    await sender.click('#camera-stop');
  }
  await sender.evaluate(() => { window.rigQa.setLiveEnabled(false); window.requestAnimationFrame = window.__liveRaf; delete document.hidden; });
  await sender.waitForTimeout(1650);

  const headers = { Origin: baseUrl, 'Content-Type': 'application/json', 'X-Still2Rig-Action': 'live-state' };
  const payload = { source: 'qa-state-test', psd, input: { angleX: 7 }, weight: 4,
    settings: { mode: 'static', autoBlink: false, eyeOpen: 1, mouthOpen: 0, parameters: { physAmp: 99 }, tuning: { intensity: 1 } } };
  const post = async (body, changes = {}) => fetch(`${baseUrl}/api/live/state`, { method: 'POST', headers: { ...headers, ...changes }, body: typeof body === 'string' ? body : JSON.stringify(body) });
  const wrongOrigin = (await post(payload, { Origin: 'https://example.com' })).status;
  const wrongAction = (await post(payload, { 'X-Still2Rig-Action': 'open-generated-folder' })).status;
  const tooLarge = (await post('x'.repeat(17000))).status;
  const badFields = (await post({ ...payload, image: 'private-image' })).status;
  const badType = (await post({ ...payload, weight: 'one' })).status;
  const unknownPsd = (await post({ ...payload, psd: 'unknown' })).status;
  const crossEvents = (await fetch(`${baseUrl}/api/live/events?psd=${psd}`, { headers: { Origin: 'https://example.com' } })).status;
  const abort = new AbortController();
  const events = await fetch(`${baseUrl}/api/live/events?psd=${psd}`, { signal: abort.signal });
  const reader = events.body.getReader();
  const clampedStatus = (await post(payload)).status;
  let clamped;
  let text = '';
  const deadline = setTimeout(() => abort.abort(), 5000);
  try {
    while (!clamped) {
      const { value, done } = await reader.read(); if (done) break;
      text += new TextDecoder().decode(value);
      for (const event of text.split('\n\n')) if (event.startsWith('data: ')) {
        const state = JSON.parse(event.slice(6)); if (state.source === payload.source) clamped = state;
      }
    }
  } finally { clearTimeout(deadline); abort.abort(); await reader.cancel().catch(() => {}); }
  const competingSource = (await post({ ...payload, source: 'other-source' })).status;
  await sender.waitForTimeout(1650);
  // The source URL and settings must come from the actual camera-panel controls.
  await sender.click('#stream-copy');
  const streamUrl = await sender.evaluate(() => navigator.clipboard.readText());
  const receiver = await context.newPage();
  for (const page of [sender, receiver]) {
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  }
  await receiver.goto(streamUrl);
  await receiver.waitForFunction(() => window.streamQa?.state().ready);
  await sender.evaluate(() => {
    window.rigQa.setAutoBlink(false); window.rigQa.setMode('static');
    window.rigQa.setMotionTuning({ hairAmplitudeScale: 0.65 });
    window.rigQa.setProfileParameter('physAmp', 1.4);
  });
  await receiver.waitForFunction(() => window.streamQa.state().settings?.tuning.hairAmplitudeScale === 0.65);
  const settings = await receiver.evaluate(() => window.streamQa.state().settings);
  const neutral = { angleX: 0, angleY: 0, angleZ: 0, body: 0, eyeOpenL: 1, eyeOpenR: 1, eyeX: 0, eyeY: 0, mouthOpen: 0, mouthForm: 0, brow: 0 };
  await sender.evaluate(input => window.rigQa.setTrackingInput(input, 1), neutral);
  await receiver.waitForTimeout(600);
  const layout = await receiver.evaluate(() => new Promise(resolve => requestAnimationFrame(() => {
    const canvas = document.querySelector('#avatar');
    const gl = canvas.getContext('webgl');
    const alphas = [];
    for (const [x, y] of [[0, 0], [canvas.width - 1, 0], [0, canvas.height - 1], [canvas.width - 1, canvas.height - 1]]) {
      const pixel = new Uint8Array(4); gl.readPixels(x, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel); alphas.push(pixel[3]);
    }
    const before = new Uint8Array(canvas.width * canvas.height * 4);
    gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, before); window.__streamBefore = before;
    resolve({ alphas, text: document.body.innerText.trim(), width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight, viewport: [innerWidth, innerHeight], background: getComputedStyle(document.body).backgroundColor });
  })));
  await receiver.screenshot({ path: path.join(qaRoot, 'stream-transparent.png'), omitBackground: true });
  await sender.evaluate(input => window.rigQa.setTrackingInput(input, 1), { ...neutral, angleX: 1, angleY: 0.6, mouthOpen: 1 });
  await receiver.waitForTimeout(600);
  const changedPixels = await receiver.evaluate(() => new Promise(resolve => requestAnimationFrame(() => {
    const canvas = document.querySelector('#avatar'); const gl = canvas.getContext('webgl');
    const pixels = new Uint8Array(canvas.width * canvas.height * 4);
    gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    let count = 0; for (let i = 0; i < pixels.length; i += 4) if (Math.abs(pixels[i] - window.__streamBefore[i]) + Math.abs(pixels[i+1] - window.__streamBefore[i+1]) + Math.abs(pixels[i+2] - window.__streamBefore[i+2]) > 12) count++;
    resolve(count);
  })));
  await receiver.screenshot({ path: path.join(qaRoot, 'stream-tracking.png'), omitBackground: true });
  // Sending must also survive a stopped source-page animation loop.
  await sender.evaluate(() => { window.requestAnimationFrame = () => 0; });
  const beforeBackground = await receiver.evaluate(() => window.streamQa.state().weight);
  await sender.evaluate(input => window.rigQa.setTrackingInput(input, 0.6), { ...neutral, angleX: -1 });
  await receiver.waitForFunction(() => Math.abs(window.streamQa.state().weight - 0.6) < 0.01);
  const backgroundSending = beforeBackground > 0.9;
  const green = await context.newPage();
  const greenUrl = new URL(streamUrl); greenUrl.searchParams.set('bg', 'green');
  await green.goto(greenUrl.href); await green.waitForFunction(() => window.streamQa?.state().ready);
  const greenBackground = await green.evaluate(() => getComputedStyle(document.body).backgroundColor);
  await green.screenshot({ path: path.join(qaRoot, 'stream-green.png') });
  await sender.waitForFunction(() => document.querySelector('#stream-status').textContent.includes('2つ接続中'));
  const connections = await sender.locator('#stream-status').textContent();
  await sender.screenshot({ path: path.join(qaRoot, 'stream-controls-desktop.png') });
  await sender.setViewportSize({ width: 375, height: 812 });
  await sender.screenshot({ path: path.join(qaRoot, 'stream-controls-mobile.png'), fullPage: true });
  await sender.evaluate(() => window.rigQa.setLiveEnabled(false));
  await receiver.waitForFunction(() => !window.streamQa.state().active && window.streamQa.state().weight < 0.005, null, { timeout: 6000 });
  const idle = await receiver.evaluate(() => window.streamQa.state());
  await sender.evaluate(input => window.rigQa.setTrackingInput(input, 1), neutral);
  await receiver.waitForFunction(() => window.streamQa.state().active && window.streamQa.state().weight > 0.99);
  const resumed = await receiver.evaluate(() => window.streamQa.state().active);
  await sender.evaluate(() => window.rigQa.setLiveEnabled(false));

  // A connected stream must receive edits even after camera publishing has stopped.
  await sender.evaluate(input => {
    window.requestAnimationFrame = window.__liveRaf;
    window.rigQa.setTrackingInput(input, 0);
    window.rigQa.setAutoBlink(false); window.rigQa.setMode('static');
  }, neutral);
  await receiver.waitForFunction(() => window.streamQa.state().active && window.streamQa.state().weight === 0);
  await receiver.waitForTimeout(500);
  const readPixels = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => {
    const canvas = document.querySelector('#avatar'); const gl = canvas.getContext('webgl');
    const pixels = new Uint8Array(canvas.width * canvas.height * 4);
    gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    resolve(Array.from(pixels));
  })));
  const orderBefore = await readPixels(receiver);
  await receiver.screenshot({ path: path.join(qaRoot, 'stream-layer-order-before.png'), omitBackground: true });
  await sender.evaluate(() => window.rigQa.setLiveEnabled(false));
  await sender.click('#layer-edit-tab');
  await sender.click('#open-layer-list');
  await sender.locator('.layer-order-item').filter({ has: sender.locator('strong', { hasText: /^腕・手$/ }) }).click();
  await sender.getByRole('button', { name: '服の手前にする', exact: true }).click();
  await sender.waitForFunction(() => document.body.dataset.layerProcessing !== 'true' && window.rigQa.getLayerEditorState().dirty);
  const editedOrder = await sender.evaluate(() => window.rigQa.getLayerEditorState().currentOrder);
  await receiver.waitForFunction(order => JSON.stringify(window.streamQa.state().layerOrder) === JSON.stringify(order), editedOrder);
  await receiver.waitForTimeout(500);
  const orderAfter = await readPixels(receiver);
  const orderChangedPixels = orderAfter.filter((value, i) => i % 4 === 0 && orderAfter.slice(i, i+3).some((v, j) => Math.abs(v - orderBefore[i+j]) > 12)).length;
  await receiver.screenshot({ path: path.join(qaRoot, 'stream-layer-order-after.png'), omitBackground: true });
  await sender.click('#before-after-toggle');
  await sender.waitForFunction(() => document.body.dataset.layerProcessing !== 'true' && window.rigQa.getLayerEditorState().showingOriginal);
  const comparisonKeepsEdited = await receiver.evaluate(order => JSON.stringify(window.streamQa.state().layerOrder) === JSON.stringify(order), editedOrder);
  await sender.click('#before-after-toggle');
  await sender.waitForFunction(() => document.body.dataset.layerProcessing !== 'true' && !window.rigQa.getLayerEditorState().showingOriginal);
  await sender.click('#reset-layer-edit');
  await sender.waitForFunction(() => document.body.dataset.layerProcessing !== 'true' && !window.rigQa.getLayerEditorState().dirty);
  await receiver.waitForFunction(() => window.streamQa.state().layerOrder === null);
  await receiver.waitForTimeout(500);
  const orderReset = await readPixels(receiver);
  const resetChangedBytes = orderReset.filter((value, i) => Math.abs(value - orderBefore[i]) > 3).length;
  await sender.locator('.layer-order-item').filter({ has: sender.locator('strong', { hasText: /^腕・手$/ }) }).click();
  await sender.getByRole('button', { name: '服の手前にする', exact: true }).click();
  await receiver.waitForFunction(order => JSON.stringify(window.streamQa.state().layerOrder) === JSON.stringify(order), editedOrder);
  await sender.evaluate(() => window.rigQa.setLiveEnabled(false));
  await receiver.close(); await green.close();
  // The pose channel expires, but the order must survive independently.
  await sender.waitForTimeout(11200);
  const orderReopened = await context.newPage();
  await orderReopened.goto(streamUrl);
  await orderReopened.waitForFunction(order => JSON.stringify(window.streamQa?.state().layerOrder) === JSON.stringify(order), editedOrder);
  const persistedOrder = await orderReopened.evaluate(() => ({ ...window.streamQa.state() }));
  await orderReopened.close();

  await sender.click('#reset-layer-edit');
  await sender.waitForFunction(() => document.body.dataset.layerProcessing !== 'true' && !window.rigQa.getLayerEditorState().dirty);
  await sender.evaluate(() => window.rigQa.setLiveEnabled(false));
  await sender.setInputFiles('#psd-file-input', fixtureFile);
  await sender.waitForFunction(() => window.rigQa.ready && document.querySelector('#stream-copy').disabled);
  const localFile = await sender.evaluate(() => ({ copyDisabled: document.querySelector('#stream-copy').disabled, openDisabled: document.querySelector('#stream-open').disabled, note: document.querySelector('#stream-note').textContent }));
  const invalid = await context.newPage(); await invalid.goto(`${baseUrl}/stream.html?psd=missing`);
  await invalid.waitForFunction(() => window.streamQa?.state().error);
  const invalidMessage = await invalid.locator('#error').textContent();
  // Close every old connection before restarting, then reopen the exact same URL.
  await Promise.all(browser.contexts().flatMap(item => item.pages()).map(page => page.close()));
  await restart();
  const reopened = await browser.newPage({ viewport: { width: 1080, height: 1080 } });
  await reopened.goto(streamUrl); await reopened.waitForFunction(() => window.streamQa?.state().ready);
  const restartReady = await reopened.evaluate(() => window.streamQa.state().ready);
  await reopened.close();
  return {
    checks: {
      streamReflectsLayerEdits: orderChangedPixels > 100 && comparisonKeepsEdited,
      streamRestoresOriginalOrder: resetChangedBytes === 0,
      streamRetainsOrderWithoutCamera: !persistedOrder.active && JSON.stringify(persistedOrder.layerOrder) === JSON.stringify(editedOrder),
      streamUsesStableGeneratedPsd: new URL(streamUrl).searchParams.get('psd') === psd && restartReady,
      streamHasOnlyTransparentCharacter: layout.alphas.every(alpha => alpha === 0) && layout.text === '' && layout.width === layout.viewport[0] && layout.height === layout.viewport[1],
      streamShowsGreenBackground: greenBackground === 'rgb(0, 255, 0)',
      streamReceivesPoseAndSettings: changedPixels > 100 && settings.parameters.physAmp === 1.4 && settings.tuning.hairAmplitudeScale === 0.65,
      streamReturnsToIdleAfterSilence: !idle.active && idle.weight < 0.005 && resumed,
      streamRejectsUntrustedState: wrongOrigin === 403 && wrongAction === 403 && crossEvents === 403 && tooLarge === 413 && badFields === 400 && badType === 400 && unknownPsd === 404,
      streamClampsNumbers: clampedStatus === 200 && clamped?.input.angleX === 1 && clamped.weight === 1 && clamped.settings.parameters.physAmp === 3,
      streamProtectsActiveSource: competingSource === 409,
      streamDisablesLocalFileButtons: localFile.copyDisabled && localFile.openDisabled && localFile.note.includes('一覧から'),
      streamCountsConnections: connections.includes('2つ接続中'),
      streamWorksWithoutSourceAnimationFrames: backgroundSending && (backgroundCapture.skipped || (backgroundCapture.state === 'missing' && backgroundCapture.liveTracks === 1)),
      streamExplainsMissingPsd: invalidMessage.includes('見つかりません'),
      streamRequestsStayLocal: external.length === 0,
      streamHasNoErrors: errors.length === 0,
    },
    layout, changedPixels, orderChangedPixels, resetChangedBytes, persistedOrder, settings, idle, localFile, backgroundCapture, backgroundSending, connections, external, errors,
  };
}
