import path from 'node:path';

export async function runVoiceQa({ browser, baseUrl, qaRoot, fixtureFile }) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const external = [], errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await context.route('**/*', route => {
    if (!['localhost', '127.0.0.1'].includes(new URL(route.request().url()).hostname)) {
      external.push(route.request().url()); return route.abort();
    }
    return route.continue();
  });
  await page.goto(baseUrl);
  await page.waitForFunction(() => window.rigQa?.ready);
  await page.click('#camera-tab');
  await page.evaluate(() => {
    window.__voiceClosedContexts = [];
    const close = AudioContext.prototype.close;
    AudioContext.prototype.close = function() { window.__voiceClosedContexts.push(this); return close.call(this); };
    window.__audioConstraints = [];
    const gum = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = constraints => { window.__audioConstraints.push(constraints); return gum(constraints); };
  });
  await page.locator('#voice-controls').screenshot({ path: path.join(qaRoot, 'voice-desktop.png') });
  const pixels = () => page.evaluate(() => {
    const canvas = document.querySelector('#rig-canvas'); const gl = canvas.getContext('webgl');
    const data = new Uint8Array(canvas.width * canvas.height * 4);
    gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, data);
    return Array.from(data);
  });
  const difference = (a, b) => a.filter((v, i) => Math.abs(v - b[i]) > 8).length;
  await page.evaluate(() => {
    window.rigQa.setAutoBlink(false); window.rigQa.setMode('static'); window.rigQa.setState(1, 0);
  });
  await page.waitForTimeout(500);
  const closed = await pixels();
  await page.evaluate(() => window.rigQa.setVoiceMouth(1));
  await page.waitForTimeout(500);
  const open = await pixels();
  await page.locator('#rig-canvas').screenshot({ path: path.join(qaRoot, 'voice-mouth-open.png') });
  await page.evaluate(() => window.rigQa.setVoiceMouth(null));
  await page.waitForTimeout(500);
  const restored = await pixels();
  await page.locator('#rig-canvas').screenshot({ path: path.join(qaRoot, 'voice-mouth-restored.png') });
  await page.evaluate(() => window.rigQa.setTrackingInput({ mouthOpen: 0.8, mouthForm: 0.3, angleX: 0.3 }, 0.4));
  await page.waitForTimeout(500);
  const camera = await pixels();
  await page.evaluate(() => window.rigQa.setVoiceMouth(0.1));
  await page.waitForTimeout(500);
  const smallerVoice = await pixels();
  await page.evaluate(() => window.rigQa.setVoiceMouth(1));
  await page.waitForTimeout(500);
  const largerVoice = await pixels();
  await page.evaluate(() => { window.rigQa.setVoiceMouth(null); window.rigQa.setTrackingInput(null, 0); });
  await page.evaluate(() => { window.__gum = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices); });
  const failureStates = [];
  for (const [name, expected] of [['NotAllowedError', 'denied'], ['NotFoundError', 'unavailable'], ['NotReadableError', 'busy']]) {
    await page.evaluate(name => { navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException('', name)); }, name);
    await page.click('#voice-start');
    await page.waitForFunction(state => window.rigQa.getVoiceState().state === state, expected);
    failureStates.push(await page.locator('#voice-state').textContent());
  }
  await page.evaluate(() => {
    navigator.mediaDevices.getUserMedia = constraints => new Promise((resolve, reject) => {
      window.__gum(constraints).then(stream => {
        window.__lateVoice = stream;
        setTimeout(() => resolve(stream), 300);
      }, reject);
    });
  });
  await page.click('#voice-start'); await page.click('#voice-stop');
  await page.waitForFunction(() => window.__lateVoice?.getTracks().every(track => track.readyState === 'ended'));
  const cancelled = await page.evaluate(() => window.rigQa.getVoiceState());
  await page.evaluate(() => { navigator.mediaDevices.getUserMedia = window.__gum; });
  await page.click('#voice-start');
  await page.waitForFunction(() => window.rigQa.getVoiceState().state === 'listening');
  await page.waitForFunction(() => document.querySelector('#voice-meter').value > 0.05);
  const running = await page.evaluate(() => ({ ...window.rigQa.getVoiceState(),
    message: document.querySelector('#voice-state').textContent,
    disabled: document.querySelector('#mouth-control').disabled,
  }));
  await page.locator('#voice-controls').screenshot({ path: path.join(qaRoot, 'voice-running.png') });
  // Worker clock must keep analyzing audio without page animation frames.
  await page.evaluate(() => { window.__raf = window.requestAnimationFrame; window.requestAnimationFrame = () => 0; document.querySelector('#voice-meter').value = 0; });
  await page.waitForFunction(() => document.querySelector('#voice-meter').value > 0.05);
  await page.evaluate(() => { window.requestAnimationFrame = window.__raf; });
  await page.click('#motion-tab');
  const motionContinues = await page.evaluate(() => window.rigQa.getVoiceState().active && !document.querySelector('#motion-camera-conflict').hidden && !document.querySelector('#camera-active-indicator').hidden);
  await page.click('#camera-tab'); await page.click('#voice-stop');
  const explicitStop = await page.evaluate(() => ({ ...window.rigQa.getVoiceState(), mouthEnabled: !document.querySelector('#mouth-control').disabled }));
  await page.click('#voice-start');
  await page.waitForFunction(() => window.rigQa.getVoiceState().state === 'listening');
  await page.click('#layer-edit-tab');
  const layerStopped = await page.evaluate(() => window.rigQa.getVoiceState());
  await page.click('#camera-tab'); await page.click('#voice-start');
  await page.waitForFunction(() => window.rigQa.getVoiceState().state === 'listening');
  await page.setInputFiles('#psd-file-input', fixtureFile);
  await page.waitForFunction(() => window.rigQa.ready && !window.rigQa.getVoiceState().active);
  const psdStopped = await page.evaluate(() => window.rigQa.getVoiceState());
  await page.click('#camera-tab');
  await page.evaluate(() => {
    document.querySelector('#voice-device-field').hidden = false;
    document.querySelector('#voice-device').replaceChildren(new Option('確認用マイク', 'test'));
  });
  const matchingStyle = await page.evaluate(() => {
    const voice = getComputedStyle(document.querySelector('#voice-device'));
    const camera = getComputedStyle(document.querySelector('#camera-device'));
    return ['backgroundColor', 'borderRadius', 'padding', 'fontSize', 'minHeight'].every(key => voice[key] === camera[key]);
  });
  await page.locator('#voice-controls').screenshot({ path: path.join(qaRoot, 'voice-device-desktop.png') });
  await page.setViewportSize({ width: 375, height: 812 });
  await page.locator('#voice-controls').scrollIntoViewIfNeeded();
  await page.locator('#voice-controls').screenshot({ path: path.join(qaRoot, 'voice-mobile.png') });
  const mobileFits = await page.evaluate(() => {
    const rect = document.querySelector('#voice-controls').getBoundingClientRect();
    return document.documentElement.scrollWidth === 375 && rect.left >= 0 && rect.right <= 375;
  });
  await page.evaluate(() => { document.querySelector('#voice-device').replaceChildren(); });
  await page.click('#voice-start');
  await page.waitForFunction(() => window.rigQa.getVoiceState().state === 'listening');
  await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
  const pagehide = await page.evaluate(() => window.rigQa.getVoiceState());
  await page.waitForFunction(() => window.__voiceClosedContexts.length >= 6 && window.__voiceClosedContexts.every(context => context.state === 'closed'));
  const resourceSafety = await page.evaluate(() => ({
    closedContexts: window.__voiceClosedContexts.length,
    audioOnly: window.__audioConstraints.length > 0 && window.__audioConstraints.every(c => c.video === false && c.audio.echoCancellation && c.audio.noiseSuppression && c.audio.autoGainControl === false),
  }));
  await context.close();
  return { checks: {
    voiceOpensAndRestoresMouth: difference(closed, open) > 100 && difference(closed, restored) === 0,
    voiceKeepsCameraWeightAndUsesMaximum: difference(camera, smallerVoice) === 0 && difference(camera, largerVoice) > 100,
    voiceReportsCaptureAndPermissionErrors: failureStates[0].includes('許可') && failureStates[1].includes('見つかりません') && failureStates[2].includes('ほかのアプリ'),
    voiceCancelsPendingPermission: cancelled.state === 'off' && cancelled.liveTracks === 0,
    voiceStartsAndContinuesWithoutAnimationFrames: running.state === 'listening' && running.liveTracks === 1 && running.message.includes('聞き取っています') && running.disabled,
    voiceStopsInLayersAndOnPsdAndPagehide: [layerStopped, psdStopped, pagehide].every(state => state.state === 'off' && state.liveTracks === 0),
    voiceContinuesInMotionTab: motionContinues,
    voiceStopRestoresControlsAndClosesAudio: explicitStop.state === 'off' && explicitStop.liveTracks === 0 && explicitStop.mouthEnabled && resourceSafety.closedContexts >= 6 && resourceSafety.audioOnly,
    voiceDeviceMatchesCamera: matchingStyle,
    voiceFitsMobile: mobileFits,
    voiceHasNoExternalRequestsOrErrors: external.length === 0 && errors.length === 0,
  }, failureStates, running, cancelled, explicitStop, resourceSafety, layerStopped, psdStopped, pagehide, external, errors };
}
