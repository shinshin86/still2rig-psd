import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

import { readPsd } from 'ag-psd';
import { chromium } from 'playwright';
import { mapFace } from '../src/tracking/pose.mjs';
import { runVoiceQa } from './voice-qa.mjs';
import { runLiveQa } from './live-qa.mjs';

const webuiRoot = path.resolve(import.meta.dirname, '..');
const repositoryRoot = path.resolve(webuiRoot, '..');
const outputRoot = path.join(repositoryRoot, '.still2rig-psd', 'webui-qa');
const jobsRoot = path.join(outputRoot, 'jobs');
const fixtureJobId = 'qa-generated-preview';
const fixtureJobRoot = path.join(jobsRoot, fixtureJobId);
const fixtureFile = path.join(fixtureJobRoot, 'output', `${fixtureJobId}.psd`);
const previewBuild = process.env.WEBUI_QA_SERVER === 'preview';
const qaRoot = path.join(outputRoot, previewBuild ? 'qa-preview' : 'qa');
const port = Number(process.env.WEBUI_QA_PORT || 4183);
const baseUrl = `http://127.0.0.1:${port}`;
const require = createRequire(import.meta.url);
const viteBin = path.join(path.dirname(require.resolve('vite/package.json')), 'bin', 'vite.js');

await fs.mkdir(qaRoot, { recursive: true });

function runNode(script, args = []) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], {
      cwd: webuiRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolve(output);
      else reject(new Error(output || `${script} exited with ${code}`));
    });
  });
}

await runNode(path.join(webuiRoot, 'scripts', 'generate-fixture.mjs'), [fixtureFile]);
await fs.writeFile(path.join(fixtureJobRoot, 'job.json'), `${JSON.stringify({
  schemaVersion: 1,
  jobId: fixtureJobId,
  createdAt: '2026-01-01T00:00:00.000Z',
  state: 'production-structure-ready',
  result: {
    productionReady: true,
    psd: `.still2rig-psd/jobs/${fixtureJobId}/output/${fixtureJobId}.psd`,
  },
}, null, 2)}\n`);

let serverLog = '';
function startServer() {
const child = spawn(process.execPath, [
  viteBin,
  ...(previewBuild ? ['preview'] : []),
  '--host',
  '127.0.0.1',
  '--port',
  String(port),
], {
  cwd: webuiRoot,
  env: {
    ...process.env,
    STILL2RIG_PSD_JOBS_ROOT: jobsRoot,
    STILL2RIG_PSD_OPEN_FOLDER_DRY_RUN: '1',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
child.stdout.on('data', (chunk) => { serverLog += chunk; });
child.stderr.on('data', (chunk) => { serverLog += chunk; });

return child;
}
let server = startServer();

async function waitForServer() {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const response = await fetch(baseUrl);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 125));
  }
  throw new Error(`Vite did not start.\n${serverLog}`);
}

async function canvasClientPoint(page, modelX, modelY) {
  return page.evaluate(({ modelX, modelY }) => {
    const canvas = document.querySelector('#rig-canvas');
    const rect = canvas.getBoundingClientRect();
    const view = window.rigQa.getViewTransform();
    const canvasX =
      (modelX - canvas.width / 2) * view.scale + canvas.width / 2 + view.offsetX;
    const canvasY =
      (modelY - canvas.height / 2) * view.scale + canvas.height / 2 + view.offsetY;
    return {
      x: rect.left + (canvasX / canvas.width) * rect.width,
      y: rect.top + (canvasY / canvas.height) * rect.height,
    };
  }, { modelX, modelY });
}

async function clickCanvasModelPoint(page, modelX, modelY) {
  const point = await canvasClientPoint(page, modelX, modelY);
  await page.mouse.click(point.x, point.y);
}

let browser;
try {
  await waitForServer();
  const libraryResponse = await fetch(`${baseUrl}/api/generated-psds`);
  const libraryPayload = await libraryResponse.json();
  const unknownPsdStatus = (await fetch(`${baseUrl}/api/generated-psds/not-a-real-id`)).status;
  const apiGeneratedId = libraryPayload.items?.[0]?.id;
  if (!apiGeneratedId) throw new Error('Generated PSD API did not return a fixture ID.');
  const openFolderHeaders = {
    'Content-Type': 'application/json',
    'X-Still2Rig-Action': 'open-generated-folder',
    Origin: baseUrl,
  };
  const openFolderResponse = await fetch(`${baseUrl}/api/generated-psds/open-folder`, {
    method: 'POST',
    headers: openFolderHeaders,
    body: JSON.stringify({ id: apiGeneratedId }),
  });
  const openFolderPayload = await openFolderResponse.json();
  const unknownOpenFolderStatus = (await fetch(`${baseUrl}/api/generated-psds/open-folder`, {
    method: 'POST',
    headers: openFolderHeaders,
    body: JSON.stringify({ id: 'not-a-real-id' }),
  })).status;
  const crossOriginOpenFolderStatus = (await fetch(`${baseUrl}/api/generated-psds/open-folder`, {
    method: 'POST',
    headers: { ...openFolderHeaders, Origin: 'https://example.com' },
    body: JSON.stringify({ id: apiGeneratedId }),
  })).status;
  browser = await chromium.launch({
    headless: true,
    args: ['--use-angle=metal', '--enable-webgl', '--ignore-gpu-blocklist', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const consoleErrors = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });

  await page.goto(`${baseUrl}?autoload=0`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () => document.querySelectorAll('#generated-psd-select option').length > 1,
  );
  const waitingState = await page.evaluate(() => ({
    ready: window.rigQa?.ready,
    status: document.querySelector('#status')?.textContent,
    avatarReady: document.body.dataset.avatarReady,
    generatedOptions: document.querySelectorAll('#generated-psd-select option').length - 1,
    openFolderDisabled: document.querySelector('#generated-psd-open-folder')?.disabled,
    cameraTabDisabled: document.querySelector('#camera-tab')?.disabled,
    layerTabDisabled: document.querySelector('#layer-edit-tab')?.disabled,
    expressionRequestHidden: document.querySelector('#expression-request-control')?.hidden,
    emptyStateOpacity: getComputedStyle(document.querySelector('.empty-state')).opacity,
    legacyBadgeCount: document.querySelectorAll('.badge').length,
    titleParent: document.querySelector('h1')?.parentElement?.className,
  }));
  await page.screenshot({ path: path.join(qaRoot, 'waiting-with-library.png') });

  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  const startRequestInitiallyOpen = await page.evaluate(() => document.querySelector('#start-request')?.open);
  await page.click('#start-request > summary');
  const copyStartRequest = async (recipient) => {
    await page.click(`[data-start-recipient="${recipient}"]`);
    await page.click('#start-request-copy');
    await page.waitForFunction(() => document.querySelector('#start-request-status')?.textContent?.includes('コピーしました'));
    return page.evaluate(async () => ({
      message: await navigator.clipboard.readText(),
      stepName: document.querySelector('[data-start-recipient-name]')?.textContent,
      expressionClaudePressed: document.querySelector('[data-recipient="claude"]')?.getAttribute('aria-pressed'),
    }));
  };
  const claudeStartRequest = await copyStartRequest('claude');
  await page.screenshot({ path: path.join(qaRoot, 'start-request-claude.png') });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () => document.querySelectorAll('#generated-psd-select option').length > 1,
  );
  const startRecipientAfterReload = await page.evaluate(() =>
    document.querySelector('[data-start-recipient="claude"]')?.getAttribute('aria-pressed'));
  await page.click('#start-request > summary');
  const codexStartRequest = await copyStartRequest('codex');
  await page.screenshot({ path: path.join(qaRoot, 'start-request-codex.png') });
  await page.click('#start-request > summary');

  const generatedId = await page.locator('#generated-psd-select option').nth(1).getAttribute('value');
  if (!generatedId) throw new Error('Generated PSD option was not available.');
  await page.selectOption('#generated-psd-select', generatedId);
  await page.waitForFunction(
    () => window.rigQa?.ready === true && window.rigQa?.error === null,
    null,
    { timeout: 30_000 },
  );
  const selectedGeneratedState = await page.evaluate(() => ({
    modelName: document.querySelector('#model-name')?.textContent,
    selectedValue: document.querySelector('#generated-psd-select')?.value,
    openFolderDisabled: document.querySelector('#generated-psd-open-folder')?.disabled,
    expressionRequestHidden: document.querySelector('#expression-request-control')?.hidden,
    expressionRequestOpen: document.querySelector('#expression-request-control')?.open,
    expressionRequestBodyHidden: document.querySelector('#expression-request-body')?.hidden,
    emptyStateOpacity: getComputedStyle(document.querySelector('.empty-state')).opacity,
  }));
  const selectedGeneratedProductionReady = await page.evaluate(async (id) => {
    const response = await fetch('/api/generated-psds', { cache: 'no-store' });
    const body = await response.json();
    return body.items.find((item) => item.id === id)?.productionReady ?? null;
  }, generatedId);
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.evaluate(() => { document.querySelector('#expression-request-control').open = true; });
  const copyExpressionRequest = async (recipient) => {
    await page.click(`[data-recipient="${recipient}"]`);
    await page.click('#expression-request-copy');
    await page.waitForFunction(() => document.querySelector('#expression-request-status')?.textContent?.includes('コピーしました'));
    return page.evaluate(async () => ({
      message: await navigator.clipboard.readText(),
      disclosureHidden: document.querySelector('#expression-request-disclosure')?.hidden,
      codexStepsHidden: document.querySelector('[data-recipient-steps="codex"]')?.hidden,
      claudeStepsHidden: document.querySelector('[data-recipient-steps="claude"]')?.hidden,
    }));
  };
  const claudeExpressionRequest = await copyExpressionRequest('claude');
  const codexExpressionRequest = await copyExpressionRequest('codex');
  const expressionRequestMessage = codexExpressionRequest.message;
  const choice = value => page.locator(`[data-expression-choice="${value}"]`);
  await choice('eye_close,mouth_open').uncheck();
  const emptyExpressionSelectionDisabled = await page.locator('#expression-request-copy').isDisabled();
  await choice('eye_smile').check(); await choice('blush').check();
  const additionalCodexRequest = await copyExpressionRequest('codex');
  const additionalClaudeRequest = await copyExpressionRequest('claude');
  await page.locator('#expression-request-control').screenshot({ path: path.join(qaRoot, 'additional-expression-choices-desktop.png') });
  await choice('eye_smile').uncheck(); await choice('blush').uncheck(); await choice('eye_close,mouth_open').check();
  await page.click('[data-recipient="codex"]');
  await page.waitForFunction(() =>
    document.body.dataset.avatarReady === 'true' &&
    getComputedStyle(document.querySelector('.empty-state')).opacity === '0',
  );
  const expressionRequestEmptyStateOpacity = await page.locator('.empty-state').evaluate(
    (element) => getComputedStyle(element).opacity,
  );
  await page.screenshot({ path: path.join(qaRoot, 'expression-request-review-1.png') });
  await page.click('[data-recipient="claude"]');
  await page.screenshot({ path: path.join(qaRoot, 'expression-request-claude.png') });
  await page.click('[data-recipient="codex"]');
  await page.evaluate(() => { document.querySelector('#expression-request-control').open = false; });
  await page.click('#generated-psd-open-folder');
  await page.waitForFunction(
    () => document.querySelector('#generated-psd-note')?.textContent?.includes('保存先を開きました'),
  );
  const openFolderUiState = await page.evaluate(() => ({
    label: document.querySelector('#generated-psd-open-folder')?.textContent,
    disabled: document.querySelector('#generated-psd-open-folder')?.disabled,
    note: document.querySelector('#generated-psd-note')?.textContent,
  }));
  await page.waitForTimeout(220);
  const initialLayout = await page.evaluate(() => {
    const header = document.querySelector('.app-header')?.getBoundingClientRect();
    const stage = document.querySelector('.stage')?.getBoundingClientRect();
    const panel = document.querySelector('.control-panel')?.getBoundingClientRect();
    const canvas = document.querySelector('#rig-canvas')?.getBoundingClientRect();
    return {
      headerBottom: header?.bottom,
      stageTop: stage?.top,
      stageBottom: stage?.bottom,
      stageWidth: stage?.width,
      panelWidth: panel?.width,
      canvasTop: canvas?.top,
      canvasBottom: canvas?.bottom,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      zoomLabel: document.querySelector('#zoom-value')?.value,
      view: window.rigQa.getViewTransform(),
    };
  });
  await page.screenshot({ path: path.join(qaRoot, 'generated-loaded.png') });

  await page.click('#layer-edit-tab');
  await page.waitForTimeout(220);
  const layerEditorInitial = await page.evaluate(() => ({
    state: window.rigQa.getLayerEditorState(),
    modeLabel: document.querySelector('#layer-edit-tab')?.getAttribute('aria-selected'),
    motionHidden: document.querySelector('#motion-panel')?.hidden,
    editorHidden: document.querySelector('#layer-edit-panel')?.hidden,
    visibleRows: document.querySelectorAll('.layer-order-item').length,
    topLabel: document.querySelector('.layer-depth-label')?.textContent,
    selectedName: document.querySelector('#selected-layer-name')?.textContent,
    saveDisabled: document.querySelector('#save-layer-edit')?.disabled,
    frontDisabled: document.querySelector('#move-layer-front')?.disabled,
    pickHint: document.querySelector('.layer-canvas-hint')?.textContent,
    selectionCopy: [
      document.querySelector('.layer-canvas-hint')?.textContent,
      document.querySelector('.layer-selection-step')?.textContent,
      document.querySelector('#selected-layer-help')?.textContent,
    ].join(' '),
    selectedCardTop: document.querySelector('#selected-layer-card')?.getBoundingClientRect().top,
    selectedCardBottom: document.querySelector('#selected-layer-card')?.getBoundingClientRect().bottom,
    viewportHeight: window.innerHeight,
  }));
  await page.screenshot({ path: path.join(qaRoot, 'layer-editor-initial.png') });

  await page.evaluate(() => window.rigQa.setLayerProcessingPreview(true));
  await page.waitForFunction(
    () => Number(getComputedStyle(document.querySelector('#layer-processing-overlay')).opacity) > 0.95,
    null,
    { timeout: 2_000 },
  );
  const layerProcessingDesktop = await page.evaluate(() => {
    const canvas = document.querySelector('#rig-canvas')?.getBoundingClientRect();
    const overlay = document.querySelector('#layer-processing-overlay')?.getBoundingClientRect();
    const overlayStyle = getComputedStyle(document.querySelector('#layer-processing-overlay'));
    return {
      active: document.body.dataset.layerProcessing,
      ariaHidden: document.querySelector('#layer-processing-overlay')?.getAttribute('aria-hidden'),
      canvasBusy: document.querySelector('#rig-canvas')?.getAttribute('aria-busy'),
      stageBusy: document.querySelector('.stage')?.getAttribute('aria-busy'),
      title: document.querySelector('#layer-processing-title')?.textContent,
      detail: document.querySelector('#layer-processing-detail')?.textContent,
      opacity: Number(overlayStyle.opacity),
      pointerEvents: overlayStyle.pointerEvents,
      spinnerAnimation: getComputedStyle(document.querySelector('.layer-processing-spinner')).animationName,
      boundsDifference: canvas && overlay ? {
        left: Math.abs(canvas.left - overlay.left),
        top: Math.abs(canvas.top - overlay.top),
        width: Math.abs(canvas.width - overlay.width),
        height: Math.abs(canvas.height - overlay.height),
      } : null,
    };
  });
  await page.screenshot({ path: path.join(qaRoot, 'layer-processing-desktop.png') });
  await page.evaluate(() => window.rigQa.setLayerProcessingPreview(false));
  const layerProcessingDismissed = await page.evaluate(() => ({
    active: document.body.dataset.layerProcessing,
    ariaHidden: document.querySelector('#layer-processing-overlay')?.getAttribute('aria-hidden'),
    canvasBusy: document.querySelector('#rig-canvas')?.getAttribute('aria-busy'),
    opacity: Number(getComputedStyle(document.querySelector('#layer-processing-overlay')).opacity),
  }));

  await page.click('#open-layer-list');
  await page.waitForFunction(() => document.querySelector('#layer-order-details')?.open === true);
  await page.waitForTimeout(500);
  const layerOrderOpenedWithoutOverlap = await page.evaluate(() => {
    const panel = document.querySelector('.control-panel');
    const header = document.querySelector('.app-header');
    const selectedCard = document.querySelector('#selected-layer-card');
    const details = document.querySelector('#layer-order-details');
    const summary = document.querySelector('#layer-order-details > summary');
    if (!panel || !header || !selectedCard || !details || !summary) return null;
    const panelRect = panel.getBoundingClientRect();
    const headerRect = header.getBoundingClientRect();
    const selectedRect = selectedCard.getBoundingClientRect();
    const detailsRect = details.getBoundingClientRect();
    const summaryRect = summary.getBoundingClientRect();
    const pointTarget = document.elementFromPoint(
      summaryRect.left + Math.min(20, summaryRect.width / 2),
      summaryRect.top + Math.min(12, summaryRect.height / 2),
    );
    return {
      panelScrollTop: panel.scrollTop,
      windowScrollY: window.scrollY,
      headerTop: headerRect.top,
      headerBottom: headerRect.bottom,
      selectedPosition: getComputedStyle(selectedCard).position,
      selectedBottom: selectedRect.bottom,
      panelTop: panelRect.top,
      panelBottom: panelRect.bottom,
      detailsTop: detailsRect.top,
      summaryTop: summaryRect.top,
      summaryBottom: summaryRect.bottom,
      summaryIsTopmost: summary.contains(pointTarget),
      selectedOverlapsSummary:
        selectedRect.bottom > summaryRect.top && selectedRect.top < summaryRect.bottom,
    };
  });
  await page.screenshot({ path: path.join(qaRoot, 'layer-order-open-no-overlap.png') });

  const layerFlowVisibility = [];
  for (const selector of ['#common-fixes', '#before-after-toggle', '.layer-save-bar', '#layer-order-details']) {
    await page.evaluate((targetSelector) => {
      const panel = document.querySelector('.control-panel');
      const target = document.querySelector(targetSelector);
      if (!panel || !target) return;
      const panelRect = panel.getBoundingClientRect();
      const targetRect = target.getBoundingClientRect();
      panel.scrollTop += targetRect.top - panelRect.top;
    }, selector);
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(resolve)));
    layerFlowVisibility.push(await page.evaluate((targetSelector) => {
      const panel = document.querySelector('.control-panel');
      const target = document.querySelector(targetSelector);
      const selectedCard = document.querySelector('#selected-layer-card');
      if (!panel || !target || !selectedCard) return { selector: targetSelector, visible: false };
      const panelRect = panel.getBoundingClientRect();
      const targetRect = target.getBoundingClientRect();
      const selectedRect = selectedCard.getBoundingClientRect();
      const pointTarget = document.elementFromPoint(
        targetRect.left + Math.min(18, targetRect.width / 2),
        Math.max(panelRect.top + 8, targetRect.top + 8),
      );
      return {
        selector: targetSelector,
        visible:
          targetRect.top >= panelRect.top - 1 &&
          targetRect.top < panelRect.bottom &&
          target.contains(pointTarget),
        selectedCardOutOfTheWay: selectedRect.bottom <= targetRect.top + 1,
      };
    }, selector));
  }

  const dragOrderBefore = await page.evaluate(() => window.rigQa.getLayerEditorState().currentOrder);
  const dragSourceHandle = page.locator('.layer-order-item .layer-drag-handle').nth(0);
  const dragTargetRow = page.locator('.layer-order-item').nth(2);
  await dragTargetRow.evaluate((row) => {
    const panel = document.querySelector('.control-panel');
    if (!panel) return;
    const panelRect = panel.getBoundingClientRect();
    const rowRect = row.getBoundingClientRect();
    panel.scrollTop += rowRect.top - panelRect.top - panelRect.height / 2;
  });
  const dragSourceBox = await dragSourceHandle.boundingBox();
  const dragTargetBox = await dragTargetRow.boundingBox();
  if (!dragSourceBox || !dragTargetBox) throw new Error('Layer drag controls were not visible.');
  await page.mouse.move(
    dragSourceBox.x + dragSourceBox.width / 2,
    dragSourceBox.y + dragSourceBox.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(
    dragSourceBox.x + dragSourceBox.width / 2 + 12,
    dragSourceBox.y + dragSourceBox.height / 2 + 12,
    { steps: 5 },
  );
  await page.mouse.move(
    dragTargetBox.x + dragTargetBox.width / 2,
    dragTargetBox.y + dragTargetBox.height - 4,
    { steps: 12 },
  );
  await page.waitForFunction(() => document.querySelector('.layer-drop-indicator'));
  await page.waitForTimeout(160);
  const layerOrderDragging = await page.evaluate(() => ({
    bodyState: document.body.dataset.layerOrderDragging,
    indicatorText: document.querySelector('.layer-drop-indicator')?.textContent,
    grabbedRows: document.querySelectorAll('.layer-order-item[aria-grabbed="true"]').length,
    selectedRows: document.querySelectorAll('.layer-order-item[aria-selected="true"]').length,
    sourceOpacity: Number(getComputedStyle(document.querySelector('.layer-order-item[aria-grabbed="true"]')).opacity),
    sourceRowDraggable: document.querySelector('.layer-order-item[aria-grabbed="true"]')?.draggable,
    sourceHandleDraggable: document.querySelector('.layer-order-item[aria-grabbed="true"] .layer-drag-handle')?.draggable,
    instruction: document.querySelector('.layer-order-instruction')?.textContent,
  }));
  await page.screenshot({ path: path.join(qaRoot, 'layer-order-drag-target.png') });
  await page.mouse.up();
  await page.waitForFunction(
    () => window.rigQa.getLayerEditorState().dirty === true,
    null,
    { timeout: 30_000 },
  );
  await page.waitForFunction(() => document.body.dataset.layerProcessing !== 'true');
  const layerOrderDropped = await page.evaluate(() => ({
    state: window.rigQa.getLayerEditorState(),
    dragging: document.body.dataset.layerOrderDragging,
    indicatorCount: document.querySelectorAll('.layer-drop-indicator').length,
    announcement: document.querySelector('#layer-edit-status')?.textContent,
  }));

  await page.locator('.layer-order-item .layer-drag-handle').first().dispatchEvent('pointerdown', {
    pointerType: 'touch',
    pointerId: 7,
    isPrimary: true,
    bubbles: true,
  });
  const layerOrderTouchNotice = await page.evaluate(() => ({
    hidden: document.querySelector('#layer-order-touch-notice')?.hidden,
    text: document.querySelector('#layer-order-touch-notice')?.textContent,
    role: document.querySelector('#layer-order-touch-notice')?.getAttribute('role'),
    ariaLive: document.querySelector('#layer-order-touch-notice')?.getAttribute('aria-live'),
  }));
  await page.screenshot({ path: path.join(qaRoot, 'layer-order-touch-notice.png') });

  await page.click('#reset-layer-edit');
  await page.waitForFunction(
    () => window.rigQa.getLayerEditorState().dirty === false,
    null,
    { timeout: 30_000 },
  );
  await page.waitForFunction(() => document.body.dataset.layerProcessing !== 'true');
  const layerOrderResetAfterDrag = await page.evaluate(() => window.rigQa.getLayerEditorState());

  await clickCanvasModelPoint(page, 128, 145);
  await page.waitForFunction(() => window.rigQa.getLayerEditorState().selectedLayer === 'face');
  const layerEditorCanvasSelection = await page.evaluate(() => ({
    state: window.rigQa.getLayerEditorState(),
    selectedName: document.querySelector('#selected-layer-name')?.textContent,
    selectedBadge: document.querySelector('#selected-part-badge')?.textContent,
    markerHidden: document.querySelector('#canvas-selection-marker')?.hidden,
    candidateMenuHidden: document.querySelector('#canvas-pick-menu')?.hidden,
    candidateCount: document.querySelectorAll('#canvas-pick-options button').length,
    selectedRows: document.querySelectorAll('.layer-order-item[aria-selected="true"]').length,
    frontDisabled: document.querySelector('#move-layer-front')?.disabled,
    backDisabled: document.querySelector('#move-layer-back')?.disabled,
  }));
  await page.screenshot({ path: path.join(qaRoot, 'layer-editor-canvas-selected.png') });
  await page.waitForFunction(
    () => window.rigQa.getLayerEditorState().layerFocus === null,
    null,
    { timeout: 2_000 },
  );
  await page.evaluate(() => new Promise((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(resolve)),
  ));
  const layerEditorFocusReleased = await page.evaluate(() => ({
    state: window.rigQa.getLayerEditorState(),
    markerHidden: document.querySelector('#canvas-selection-marker')?.hidden,
    selectedBadge: document.querySelector('#selected-part-badge')?.textContent,
  }));
  await page.screenshot({ path: path.join(qaRoot, 'layer-editor-canvas-selected-settled.png') });

  await clickCanvasModelPoint(page, 6, 6);
  const layerEditorEmptyClick = await page.evaluate(() => ({
    selectedLayer: window.rigQa.getLayerEditorState().selectedLayer,
    title: document.querySelector('#canvas-pick-title')?.textContent,
    menuHidden: document.querySelector('#canvas-pick-menu')?.hidden,
  }));

  await page.evaluate(() => window.rigQa.setViewTransform(22, -14, 1.35));
  await clickCanvasModelPoint(page, 128, 145);
  const zoomedCanvasSelection = await page.evaluate(() => window.rigQa.getLayerEditorState().selectedLayer);
  await page.evaluate(() => window.rigQa.setViewTransform(0, 0, 0.9));

  await clickCanvasModelPoint(page, 55, 180);
  await page.waitForFunction(() => window.rigQa.getLayerEditorState().selectedLayer === 'handwear');
  await page.waitForFunction(
    () => window.rigQa.getLayerEditorState().layerFocus === null,
    null,
    { timeout: 2_000 },
  );
  await page.evaluate(() => new Promise((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(resolve)),
  ));
  const layerEditorHandSelection = await page.evaluate(() => ({
    selectedLayer: window.rigQa.getLayerEditorState().selectedLayer,
    selectedName: document.querySelector('#selected-layer-name')?.textContent,
    markerHidden: document.querySelector('#canvas-selection-marker')?.hidden,
  }));
  await page.evaluate(() => {
    const canvas = document.querySelector('#rig-canvas');
    const gl = canvas.getContext('webgl');
    const pixels = new Uint8Array(canvas.width * canvas.height * 4);
    gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    window.__still2rigLayerOriginalFrame = pixels;
  });
  await page.screenshot({ path: path.join(qaRoot, 'layer-editor-hand-selected.png') });

  await page.getByRole('button', { name: '服の手前にする' }).click();
  await page.waitForFunction(
    () => window.rigQa.getLayerEditorState().dirty === true,
    null,
    { timeout: 30_000 },
  );
  await page.waitForFunction(() => document.body.dataset.layerProcessing !== 'true');
  const layerEditorChanged = await page.evaluate(() => ({
    state: window.rigQa.getLayerEditorState(),
    status: document.querySelector('#status')?.textContent,
    phase: document.querySelector('#phase')?.textContent,
    saveDisabled: document.querySelector('#save-layer-edit')?.disabled,
    announcement: document.querySelector('#layer-edit-status')?.textContent,
    processingActive: document.body.dataset.layerProcessing,
    processingAriaHidden: document.querySelector('#layer-processing-overlay')?.getAttribute('aria-hidden'),
  }));
  const layerEditorVisualChange = await page.evaluate(() => {
    const canvas = document.querySelector('#rig-canvas');
    const gl = canvas.getContext('webgl');
    const before = window.__still2rigLayerOriginalFrame;
    const after = new Uint8Array(canvas.width * canvas.height * 4);
    gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, after);
    let changedPixels = 0;
    for (let offset = 0; offset < after.length; offset += 4) {
      if (
        after[offset] !== before[offset] ||
        after[offset + 1] !== before[offset + 1] ||
        after[offset + 2] !== before[offset + 2] ||
        after[offset + 3] !== before[offset + 3]
      ) changedPixels += 1;
    }
    return { changedPixelRatio: changedPixels / (canvas.width * canvas.height) };
  });
  await page.screenshot({ path: path.join(qaRoot, 'layer-editor-changed.png') });

  await page.click('#before-after-toggle');
  await page.waitForFunction(
    () => window.rigQa.getLayerEditorState().showingOriginal === true,
    null,
    { timeout: 30_000 },
  );
  await page.waitForTimeout(500);
  const layerEditorOriginalPreview = await page.evaluate(() => ({
    state: window.rigQa.getLayerEditorState(),
    previewBadge: document.querySelector('#preview-mode-badge')?.textContent,
    moveDisabled: document.querySelector('#move-layer-back')?.disabled,
    toggleLabel: document.querySelector('#before-after-toggle')?.textContent,
    badgeBackground: getComputedStyle(document.querySelector('#preview-mode-badge')).backgroundColor,
  }));
  const layerEditorOriginalMatch = await page.evaluate(() => {
    const canvas = document.querySelector('#rig-canvas');
    const gl = canvas.getContext('webgl');
    const expected = window.__still2rigLayerOriginalFrame;
    const actual = new Uint8Array(canvas.width * canvas.height * 4);
    gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, actual);
    let changedPixels = 0;
    for (let offset = 0; offset < actual.length; offset += 4) {
      if (
        actual[offset] !== expected[offset] ||
        actual[offset + 1] !== expected[offset + 1] ||
        actual[offset + 2] !== expected[offset + 2] ||
        actual[offset + 3] !== expected[offset + 3]
      ) changedPixels += 1;
    }
    return { changedPixelRatio: changedPixels / (canvas.width * canvas.height) };
  });
  await page.screenshot({ path: path.join(qaRoot, 'layer-editor-original-preview.png') });
  await page.click('#before-after-toggle');
  await page.waitForFunction(
    () => window.rigQa.getLayerEditorState().showingOriginal === false,
    null,
    { timeout: 30_000 },
  );
  await page.waitForTimeout(500);

  const downloadPromise = page.waitForEvent('download');
  await page.click('#save-layer-edit');
  const download = await downloadPromise;
  const downloadedPath = await download.path();
  if (!downloadedPath) throw new Error('Edited PSD download did not provide a file path.');
  await page.waitForFunction(() => document.body.dataset.layerProcessing !== 'true');
  const savedPsd = readPsd(new Uint8Array(await fs.readFile(downloadedPath)), {
    skipLayerImageData: true,
    skipCompositeImageData: true,
    skipThumbnail: true,
  });
  const layerEditorSaved = await page.evaluate(() => ({
    state: window.rigQa.getLayerEditorState(),
    status: document.querySelector('#status')?.textContent,
    message: document.querySelector('#layer-edit-status')?.textContent,
  }));
  const downloadedLayerNames = (savedPsd.children ?? []).map((layer) => layer.name);

  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () => window.rigQa?.ready === true && window.rigQa?.error === null,
    null,
    { timeout: 30_000 },
  );
  const autoLoadedState = await page.evaluate(() => ({
    modelName: document.querySelector('#model-name')?.textContent,
    selectedValue: document.querySelector('#generated-psd-select')?.value,
  }));

  const fixtureBase64 = (await fs.readFile(fixtureFile)).toString('base64');
  const transfer = await page.evaluateHandle((base64) => {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    const dataTransfer = new DataTransfer();
    dataTransfer.items.add(new File([bytes], 'uploaded-fixture.psd', {
      type: 'image/vnd.adobe.photoshop',
    }));
    return dataTransfer;
  }, fixtureBase64);
  await page.dispatchEvent('body', 'dragenter', { dataTransfer: transfer });
  await page.waitForTimeout(180);
  const overlayVisible =
    (await page.locator('#drop-overlay').getAttribute('aria-hidden')) === 'false';
  await page.screenshot({ path: path.join(qaRoot, 'drop-overlay.png') });
  await page.dispatchEvent('body', 'drop', { dataTransfer: transfer });
  await page.waitForFunction(
    () => window.rigQa?.ready === true &&
      window.rigQa?.error === null &&
      document.querySelector('#model-name')?.textContent === 'uploaded-fixture.psd',
    null,
    { timeout: 30_000 },
  );
  await page.waitForTimeout(500);
  const summary = await page.evaluate(() => window.rigQa.summary);
  const localFolderButtonDisabled = await page.locator('#generated-psd-open-folder').isDisabled();
  const localExpressionRequestState = await page.evaluate(() => ({
    hidden: document.querySelector('#expression-request-control')?.hidden,
    open: document.querySelector('#expression-request-control')?.open,
    bodyHidden: document.querySelector('#expression-request-body')?.hidden,
    summary: document.querySelector('#expression-request-summary')?.textContent,
  }));
  await page.screenshot({ path: path.join(qaRoot, 'uploaded.png') });
  const canvas = page.locator('#rig-canvas');

  const autoBlinkDefaultsOn = await page.evaluate(() => window.rigQa.getAutoBlink());
  await page.click('#blink-toggle');
  const autoBlinkDisabled = await page.evaluate(() => ({
    enabled: window.rigQa.getAutoBlink(),
    pressed: document.querySelector('#blink-toggle')?.getAttribute('aria-pressed'),
    label: document.querySelector('#blink-value')?.value,
  }));
  await page.click('#blink-toggle');
  await page.waitForFunction(
    () => window.rigQa.getEyeOpen().left < 0.2 && window.rigQa.getEyeOpen().right < 0.2,
    null,
    { timeout: 5_000 },
  );
  const blinkClosed = await page.evaluate(() => window.rigQa.getEyeOpen());
  await canvas.screenshot({ path: path.join(qaRoot, 'blink-closed.png') });
  await page.waitForFunction(
    () => window.rigQa.getEyeOpen().left > 0.9 && window.rigQa.getEyeOpen().right > 0.9,
    null,
    { timeout: 5_000 },
  );
  const blinkReopened = await page.evaluate(() => window.rigQa.getEyeOpen());
  await canvas.screenshot({ path: path.join(qaRoot, 'blink-open.png') });
  await page.click('#blink-toggle');

  await page.locator('#advanced-parameters').evaluate((details) => { details.open = true; });
  await page.locator('[data-parameter-group="face"]').evaluate((details) => { details.open = true; });
  const advancedInitial = await page.evaluate(() => ({
    itemCount: document.querySelectorAll('.advanced-item').length,
    groupCount: document.querySelectorAll('.parameter-group').length,
    angleZ: window.rigQa.getProfileParameters().angleZ,
    physAmp: window.rigQa.getProfileParameters().physAmp,
    fhSoft: window.rigQa.getProfileParameters().fhSoft,
    numberValue: document.querySelector('#parameter-angleZ-number')?.value,
  }));
  await page.evaluate(() => {
    const canvas = document.querySelector('#rig-canvas');
    const gl = canvas.getContext('webgl');
    const pixels = new Uint8Array(canvas.width * canvas.height * 4);
    gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    window.__still2rigAdvancedFrame = pixels;
  });
  await page.locator('#parameter-angleZ-number').fill('0.55');
  await page.locator('#parameter-angleZ-number').dispatchEvent('change');
  await page.waitForTimeout(520);
  const advancedAdjusted = await page.evaluate(() => {
    const canvas = document.querySelector('#rig-canvas');
    const gl = canvas.getContext('webgl');
    const before = window.__still2rigAdvancedFrame;
    const after = new Uint8Array(canvas.width * canvas.height * 4);
    gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, after);
    let changedPixels = 0;
    for (let offset = 0; offset < after.length; offset += 4) {
      if (
        after[offset] !== before[offset] ||
        after[offset + 1] !== before[offset + 1] ||
        after[offset + 2] !== before[offset + 2] ||
        after[offset + 3] !== before[offset + 3]
      ) changedPixels += 1;
    }
    return {
      angleZ: window.rigQa.getProfileParameters().angleZ,
      rangeValue: document.querySelector('#parameter-angleZ')?.value,
      numberValue: document.querySelector('#parameter-angleZ-number')?.value,
      changedPixelRatio: changedPixels / (canvas.width * canvas.height),
    };
  });
  await page.locator('#advanced-parameters').screenshot({ path: path.join(qaRoot, 'advanced-parameters.png') });
  await page.click('#advanced-reset');
  await page.waitForTimeout(420);
  const advancedResetState = await page.evaluate(() => ({
    angleZ: window.rigQa.getProfileParameters().angleZ,
    physAmp: window.rigQa.getProfileParameters().physAmp,
    fhSoft: window.rigQa.getProfileParameters().fhSoft,
    numberValue: document.querySelector('#parameter-angleZ-number')?.value,
  }));
  await page.locator('#advanced-parameters').evaluate((details) => { details.open = false; });

  await page.click('[data-motion-preset="calm"]');
  await page.click('[data-mode="physics"]');
  await page.waitForTimeout(1800);
  await canvas.screenshot({ path: path.join(qaRoot, 'calm-a.png') });
  await page.evaluate(() => {
    const canvas = document.querySelector('#rig-canvas');
    const gl = canvas.getContext('webgl');
    const pixels = new Uint8Array(canvas.width * canvas.height * 4);
    gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    window.__still2rigQaFrame = pixels;
  });
  await page.waitForTimeout(900);
  await canvas.screenshot({ path: path.join(qaRoot, 'calm-b.png') });
  const motionMetrics = await page.evaluate(() => {
    const canvas = document.querySelector('#rig-canvas');
    const gl = canvas.getContext('webgl');
    const before = window.__still2rigQaFrame;
    const after = new Uint8Array(canvas.width * canvas.height * 4);
    gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, after);
    let changedPixels = 0;
    let absoluteError = 0;
    for (let offset = 0; offset < after.length; offset += 4) {
      let pixelChanged = false;
      for (let channel = 0; channel < 4; channel += 1) {
        const delta = Math.abs(after[offset + channel] - before[offset + channel]);
        absoluteError += delta;
        pixelChanged ||= delta > 0;
      }
      if (pixelChanged) changedPixels += 1;
    }
    return {
      changedPixelRatio: changedPixels / (canvas.width * canvas.height),
      meanAbsoluteError: absoluteError / after.length,
    };
  });
  const tuning = await page.evaluate(() => window.rigQa.getMotionTuning());

  const box = await canvas.boundingBox();
  if (!box) throw new Error('Canvas bounding box was not available.');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 80, box.y + box.height / 2 + 45, { steps: 6 });
  await page.mouse.up();
  const drag = await page.evaluate(() => window.rigQa.getViewTransform());
  await page.locator('#zoom-control').evaluate((input) => {
    input.value = '135';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  const zoom = await page.evaluate(() => window.rigQa.getViewTransform());
  await page.screenshot({ path: path.join(qaRoot, 'operated.png') });

  const mobileConsoleErrors = [];
  const mobilePage = await browser.newPage({
    viewport: { width: 375, height: 812 },
    isMobile: true,
    hasTouch: true,
  });
  mobilePage.on('console', (message) => {
    if (message.type() === 'error') mobileConsoleErrors.push(message.text());
  });
  await mobilePage.goto(`${baseUrl}?autoload=0`, { waitUntil: 'domcontentloaded' });
  await mobilePage.waitForFunction(
    () => document.querySelectorAll('#generated-psd-select option').length > 1,
  );
  const mobileWaitingLayout = await mobilePage.evaluate(() => {
    const header = document.querySelector('.app-header')?.getBoundingClientRect();
    const source = document.querySelector('.header-source')?.getBoundingClientRect();
    const stage = document.querySelector('.stage')?.getBoundingClientRect();
    const canvas = document.querySelector('#rig-canvas')?.getBoundingClientRect();
    const emptyState = document.querySelector('.empty-state')?.getBoundingClientRect();
    const fileButton = document.querySelector('#psd-file-button')?.getBoundingClientRect();
    return {
      viewportWidth: window.innerWidth,
      scrollWidth: document.documentElement.scrollWidth,
      headerBottom: header?.bottom,
      sourceBottom: source?.bottom,
      stageTop: stage?.top,
      canvasTop: canvas?.top,
      canvasBottom: canvas?.bottom,
      emptyTop: emptyState?.top,
      emptyBottom: emptyState?.bottom,
      fileButtonHeight: fileButton?.height,
      legacyBadgeCount: document.querySelectorAll('.badge').length,
    };
  });
  await mobilePage.screenshot({ path: path.join(qaRoot, 'mobile-waiting.png'), fullPage: true });
  await mobilePage.selectOption('#generated-psd-select', generatedId);
  await mobilePage.waitForFunction(
    () => window.rigQa?.ready === true && window.rigQa?.error === null,
    null,
    { timeout: 30_000 },
  );
  await mobilePage.waitForTimeout(220);
  const mobileLoadedLayout = await mobilePage.evaluate(() => {
    const stage = document.querySelector('.stage')?.getBoundingClientRect();
    const panel = document.querySelector('.control-panel')?.getBoundingClientRect();
    return {
      stageBottom: stage?.bottom,
      panelTop: panel?.top,
      modelName: document.querySelector('#model-name')?.textContent,
      emptyStateOpacity: getComputedStyle(document.querySelector('.empty-state')).opacity,
    };
  });
  await mobilePage.screenshot({ path: path.join(qaRoot, 'mobile-loaded.png'), fullPage: true });
  await mobilePage.evaluate(() => { document.querySelector('#expression-request-control').open = true; });
  const mobileExpressionRequestFits = await mobilePage.locator('#expression-request-control').evaluate(
    (element) => element.scrollWidth <= element.clientWidth,
  );
  await mobilePage.screenshot({ path: path.join(qaRoot, 'mobile-expression-request.png'), fullPage: true });
  await mobilePage.locator('#expression-request-control').screenshot({ path: path.join(qaRoot, 'additional-expression-choices-mobile.png') });
  await mobilePage.evaluate(() => { document.querySelector('#expression-request-control').open = false; });
  await mobilePage.click('#layer-edit-tab');
  await mobilePage.waitForTimeout(220);
  await mobilePage.evaluate(() => window.rigQa.setLayerProcessingPreview(true));
  await mobilePage.waitForFunction(
    () => Number(getComputedStyle(document.querySelector('#layer-processing-overlay')).opacity) > 0.95,
    null,
    { timeout: 2_000 },
  );
  const mobileLayerProcessing = await mobilePage.evaluate(() => {
    const canvas = document.querySelector('#rig-canvas')?.getBoundingClientRect();
    const overlay = document.querySelector('#layer-processing-overlay')?.getBoundingClientRect();
    const card = document.querySelector('.layer-processing-card')?.getBoundingClientRect();
    return {
      active: document.body.dataset.layerProcessing,
      viewportWidth: window.innerWidth,
      scrollWidth: document.documentElement.scrollWidth,
      opacity: Number(getComputedStyle(document.querySelector('#layer-processing-overlay')).opacity),
      title: document.querySelector('#layer-processing-title')?.textContent,
      boundsDifference: canvas && overlay ? {
        left: Math.abs(canvas.left - overlay.left),
        top: Math.abs(canvas.top - overlay.top),
        width: Math.abs(canvas.width - overlay.width),
        height: Math.abs(canvas.height - overlay.height),
      } : null,
      cardInsideOverlay: Boolean(card && overlay &&
        card.left >= overlay.left && card.right <= overlay.right &&
        card.top >= overlay.top && card.bottom <= overlay.bottom),
    };
  });
  await mobilePage.screenshot({ path: path.join(qaRoot, 'mobile-layer-processing.png'), fullPage: true });
  await mobilePage.evaluate(() => window.rigQa.setLayerProcessingPreview(false));
  const mobileFacePoint = await canvasClientPoint(mobilePage, 128, 145);
  await mobilePage.touchscreen.tap(mobileFacePoint.x, mobileFacePoint.y);
  await mobilePage.waitForFunction(
    () => window.rigQa.getLayerEditorState().selectedLayer === 'face',
  );
  const mobileCanvasSelection = await mobilePage.evaluate(() => ({
    selectedLayer: window.rigQa.getLayerEditorState().selectedLayer,
    selectedName: document.querySelector('#selected-layer-name')?.textContent,
    markerHidden: document.querySelector('#canvas-selection-marker')?.hidden,
    candidateCount: document.querySelectorAll('#canvas-pick-options button').length,
    candidateButtonHeight:
      document.querySelector('#canvas-pick-options button')?.getBoundingClientRect().height,
  }));
  const mobileLayerEditorLayout = await mobilePage.evaluate(() => {
    const panel = document.querySelector('.control-panel')?.getBoundingClientRect();
    const frontButton = document.querySelector('#move-layer-front')?.getBoundingClientRect();
    const backButton = document.querySelector('#move-layer-back')?.getBoundingClientRect();
    const saveButton = document.querySelector('#save-layer-edit')?.getBoundingClientRect();
    return {
      scrollWidth: document.documentElement.scrollWidth,
      viewportWidth: window.innerWidth,
      panelWidth: panel?.width,
      frontButtonHeight: frontButton?.height,
      backButtonHeight: backButton?.height,
      saveButtonHeight: saveButton?.height,
      editorHidden: document.querySelector('#layer-edit-panel')?.hidden,
      motionHidden: document.querySelector('#motion-panel')?.hidden,
      detailsOpen: document.querySelector('#layer-order-details')?.open,
    };
  });
  await mobilePage.screenshot({ path: path.join(qaRoot, 'mobile-layer-editor.png'), fullPage: true });
  await mobilePage.close();

  const compactPage = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const compactConsoleErrors = [];
  compactPage.on('console', (message) => {
    if (message.type() === 'error') compactConsoleErrors.push(message.text());
  });
  await compactPage.goto(`${baseUrl}?autoload=0`, { waitUntil: 'domcontentloaded' });
  await compactPage.waitForFunction(
    () => document.querySelectorAll('#generated-psd-select option').length > 1,
  );
  await compactPage.selectOption('#generated-psd-select', generatedId);
  await compactPage.waitForFunction(
    () => window.rigQa?.ready === true && window.rigQa?.error === null,
    null,
    { timeout: 30_000 },
  );
  await compactPage.click('#layer-edit-tab');
  await compactPage.waitForTimeout(220);
  await compactPage.screenshot({ path: path.join(qaRoot, 'layer-editor-1280x720.png') });
  await clickCanvasModelPoint(compactPage, 128, 145);
  await compactPage.waitForFunction(
    () => window.rigQa.getLayerEditorState().selectedLayer === 'face',
  );
  const compactSelectionFlow = await compactPage.evaluate(() => {
    const card = document.querySelector('#selected-layer-card')?.getBoundingClientRect();
    const frontButton = document.querySelector('#move-layer-front')?.getBoundingClientRect();
    const backButton = document.querySelector('#move-layer-back')?.getBoundingClientRect();
    return {
      selectedLayer: window.rigQa.getLayerEditorState().selectedLayer,
      cardTop: card?.top,
      cardBottom: card?.bottom,
      frontTop: frontButton?.top,
      frontBottom: frontButton?.bottom,
      backTop: backButton?.top,
      backBottom: backButton?.bottom,
      viewportHeight: window.innerHeight,
    };
  });
  const compactDragStart = await canvasClientPoint(compactPage, 128, 145);
  await compactPage.mouse.move(compactDragStart.x, compactDragStart.y);
  await compactPage.mouse.down();
  await compactPage.mouse.move(compactDragStart.x + 48, compactDragStart.y + 28, { steps: 4 });
  await compactPage.mouse.up();
  const compactLayerDrag = await compactPage.evaluate(() => ({
    selectedLayer: window.rigQa.getLayerEditorState().selectedLayer,
    view: window.rigQa.getViewTransform(),
  }));
  await compactPage.screenshot({ path: path.join(qaRoot, 'layer-editor-1280x720-selected.png') });
  await compactPage.locator('#save-layer-edit').scrollIntoViewIfNeeded();
  const compactLayerEditorLayout = await compactPage.evaluate(() => {
    const panel = document.querySelector('.control-panel');
    const panelRect = panel?.getBoundingClientRect();
    const saveButton = document.querySelector('#save-layer-edit')?.getBoundingClientRect();
    const frontButton = document.querySelector('#move-layer-front')?.getBoundingClientRect();
    const backButton = document.querySelector('#move-layer-back')?.getBoundingClientRect();
    const sourceActions = document.querySelector('.source-actions');
    return {
      scrollWidth: document.documentElement.scrollWidth,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      panelScrollTop: panel?.scrollTop,
      panelScrollable: Boolean(panel && panel.scrollHeight > panel.clientHeight),
      panelRight: panelRect?.right,
      saveTop: saveButton?.top,
      saveBottom: saveButton?.bottom,
      frontButtonHeight: frontButton?.height,
      backButtonHeight: backButton?.height,
      sourceActionsFit: Boolean(
        sourceActions && sourceActions.scrollWidth <= sourceActions.clientWidth,
      ),
      detailsOpen: document.querySelector('#layer-order-details')?.open,
    };
  });
  await compactPage.screenshot({ path: path.join(qaRoot, 'layer-editor-1280x720-save.png') });
  await compactPage.close();

  const cameraPage = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const externalRequests = [];
  const cameraErrors = [];
  const cameraDiagnostics = [];
  cameraPage.on('console', message => {
    // Emscripten writes this successful CPU initialization notice to stderr.
    if (message.text() === 'INFO: Created TensorFlow Lite XNNPACK delegate for CPU.') cameraDiagnostics.push(message.text());
    else if (message.type() === 'error') cameraErrors.push(message.text());
  });
  cameraPage.on('pageerror', error => cameraErrors.push(error.message));
  await cameraPage.context().route('**/*', route => {
    const host = new URL(route.request().url()).hostname;
    if (host !== 'localhost' && host !== '127.0.0.1') {
      externalRequests.push(route.request().url());
      return route.abort();
    }
    return route.continue();
  });
  let modelPosts = 0;
  cameraPage.on('request', request => {
    if (request.url().endsWith('/api/face-model') && request.method() === 'POST') modelPosts++;
  });
  const modelStatus = await (await fetch(`${baseUrl}/api/face-model/status`)).json();
  const rejectedModelPost = (await fetch(`${baseUrl}/api/face-model`, {
    method: 'POST', headers: { ...openFolderHeaders, 'X-Still2Rig-Action': 'prepare-face-model', Origin: 'https://example.com' },
  })).status;
  const rejectedModelAsset = (await fetch(`${baseUrl}/api/face-assets/not-allowed.js`)).status;
  const wrongModelAction = (await fetch(`${baseUrl}/api/face-model`, {
    method: 'POST', headers: openFolderHeaders,
  })).status;
  const wrongFolderAction = (await fetch(`${baseUrl}/api/generated-psds/open-folder`, {
    method: 'POST', headers: { ...openFolderHeaders, 'X-Still2Rig-Action': 'prepare-face-model' },
    body: JSON.stringify({ id: apiGeneratedId }),
  })).status;
  const preparedModelStatus = modelStatus.ready ? (await fetch(`${baseUrl}/api/face-model`, {
    method: 'POST', headers: { ...openFolderHeaders, 'X-Still2Rig-Action': 'prepare-face-model' },
  })).status : null;

  // Exercise first-use UI without downloading or changing the real cached model.
  let preparedByButton = false;
  let prepareAction;
  await cameraPage.route('**/api/face-model/status', route => route.fulfill({ json: { ready: preparedByButton } }));
  await cameraPage.route('**/api/face-model', route => {
    if (route.request().method() !== 'POST') return route.continue();
    prepareAction = route.request().headers()['x-still2rig-action'];
    preparedByButton = true;
    return route.fulfill({ json: { ready: true, downloaded: true } });
  });
  await cameraPage.goto(`${baseUrl}?autoload=0`);
  await cameraPage.waitForFunction(() => window.rigQa !== undefined);
  await cameraPage.evaluate(() => window.rigQa.setWorkspaceMode('camera'));
  const cameraTabBeforeLoad = await cameraPage.evaluate(() => ({ disabled: document.querySelector('#camera-tab').disabled, mode: document.body.dataset.workspaceMode }));
  await cameraPage.selectOption('#generated-psd-select', apiGeneratedId);
  await cameraPage.waitForFunction(() => window.rigQa?.ready === true);
  await cameraPage.click('#camera-tab');
  await cameraPage.waitForFunction(() => document.querySelector('#camera-state').textContent.includes('最初に'));
  const automaticModelPosts = modelPosts;
  await cameraPage.locator('#camera-controls').screenshot({ path: path.join(qaRoot, 'camera-first-use.png') });
  await cameraPage.click('#camera-prepare');
  await cameraPage.waitForFunction(() => document.querySelector('#camera-prepare').hidden);
  const explicitModelPosts = modelPosts;
  await cameraPage.unroute('**/api/face-model/status');
  await cameraPage.unroute('**/api/face-model');
  await cameraPage.goto(baseUrl);
  await cameraPage.waitForFunction(() => window.rigQa?.ready === true);
  await cameraPage.click('#camera-tab');
  await cameraPage.screenshot({ path: path.join(qaRoot, 'camera-tab-desktop.png') });
  const cameraInitiallyLoadedMessage = await cameraPage.locator('#camera-state').textContent();
  await cameraPage.evaluate(() => {
    window.rigQa.setMode('static'); window.rigQa.setAutoBlink(false); window.rigQa.setState(1, 0);
  });
  const trackingNeutral = { angleX: 0, angleY: 0, angleZ: 0, body: 0, eyeOpenL: 1, eyeOpenR: 1, eyeX: 0, eyeY: 0, mouthOpen: 0, mouthForm: 0, brow: 0 };
  const captureTrackingPixels = async () => cameraPage.evaluate(() => {
    const canvas = document.querySelector('#rig-canvas');
    const gl = canvas.getContext('webgl');
    const pixels = new Uint8Array(canvas.width * canvas.height * 4);
    gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    window.__cameraPixels = pixels;
  });
  const compareTrackingPixels = async () => cameraPage.evaluate(() => {
    const canvas = document.querySelector('#rig-canvas');
    const gl = canvas.getContext('webgl');
    const pixels = new Uint8Array(canvas.width * canvas.height * 4);
    gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    let changed = 0;
    for (let i = 0; i < pixels.length; i += 4) {
      if (Math.abs(pixels[i] - window.__cameraPixels[i]) + Math.abs(pixels[i+1] - window.__cameraPixels[i+1]) + Math.abs(pixels[i+2] - window.__cameraPixels[i+2]) > 12) changed++;
    }
    return changed;
  });
  await cameraPage.waitForTimeout(800);
  await captureTrackingPixels();
  await cameraPage.evaluate(input => window.rigQa.setTrackingInput(input, 0), { ...trackingNeutral, angleX: 1, eyeOpenL: 0, mouthOpen: 1 });
  await cameraPage.waitForTimeout(300);
  const trackingZeroDifference = await compareTrackingPixels();
  const cameraSensitivity = await cameraPage.locator('#camera-sensitivity').evaluate(input => ({ value: Number(input.value), max: Number(input.max) }));
  const faceInput = (pitch, shapes = {}) => mapFace({ yaw: 0, pitch, roll: 0, shapes }, null, { mirror: true, sensitivity: 1.5, smoothing: 0 });
  const measureIris = () => cameraPage.evaluate(() => {
    const canvas = document.querySelector('#rig-canvas');
    const gl = canvas.getContext('webgl');
    const pixels = new Uint8Array(canvas.width * canvas.height * 4);
    gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    let count = 0, sumY = 0;
    for (let y = 0; y < canvas.height; y++) for (let x = 0; x < canvas.width; x++) {
      const i = (y * canvas.width + x) * 4;
      if (pixels[i+1] > pixels[i] + 20 && pixels[i+2] > pixels[i] + 20 && pixels[i+1] > 80 && pixels[i] < 130) {
        count++; sumY += canvas.height - 1 - y;
      }
    }
    return { count, y: count ? sumY / count : null };
  });
  await cameraPage.evaluate(input => window.rigQa.setTrackingInput(input, 1), trackingNeutral);
  await cameraPage.waitForTimeout(400);
  const directionNeutral = await measureIris();
  await cameraPage.locator('#rig-canvas').screenshot({ path: path.join(qaRoot, 'camera-direction-neutral.png') });
  const trackingDirections = {};
  for (const [name, input] of Object.entries({
    'head-up': faceInput(-18), 'head-down': faceInput(18),
    'gaze-up': faceInput(0, { eyeLookUpLeft: 0.8, eyeLookUpRight: 0.8 }),
    'gaze-down': faceInput(0, { eyeLookDownLeft: 0.8, eyeLookDownRight: 0.8 }),
  })) {
    await cameraPage.evaluate(value => window.rigQa.setTrackingInput(value, 1), input);
    await cameraPage.waitForTimeout(400);
    trackingDirections[name] = await measureIris();
    await cameraPage.locator('#rig-canvas').screenshot({ path: path.join(qaRoot, `camera-direction-${name}.png`) });
  }
  const trackingDifferences = {};
  for (const [name, values] of Object.entries({ head: { angleX: 0.6, angleZ: 0.4 }, blink: { eyeOpenL: 0, eyeOpenR: 0 }, mouth: { mouthOpen: 1 } })) {
    await cameraPage.evaluate(input => window.rigQa.setTrackingInput(input, 1), trackingNeutral);
    await cameraPage.waitForTimeout(400);
    await captureTrackingPixels();
    await cameraPage.evaluate(input => window.rigQa.setTrackingInput(input, 1), { ...trackingNeutral, ...values });
    await cameraPage.waitForTimeout(400);
    trackingDifferences[name] = await compareTrackingPixels();
    await cameraPage.locator('#rig-canvas').screenshot({ path: path.join(qaRoot, `camera-input-${name}.png`) });
  }
  await cameraPage.evaluate(() => window.rigQa.setTrackingInput(null, 0));
  await cameraPage.waitForTimeout(800);
  await captureTrackingPixels();
  await cameraPage.waitForTimeout(250);
  const trackingStoppedDifference = await compareTrackingPixels();
  let cameraFailureStates = [];
  let cancelledStart;
  let fakeCamera = { skipped: !modelStatus.ready, reason: modelStatus.ready ? null : 'Place the verified model locally with the face-model CLI before running camera inference QA.' };
  if (modelStatus.ready) {
    await cameraPage.evaluate(() => { window.__originalGetUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices); });
    for (const [error, expected] of [['NotAllowedError', 'denied'], ['NotFoundError', 'unavailable']]) {
      await cameraPage.evaluate(name => {
        navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException('QA camera error', name));
      }, error);
      await cameraPage.click('#camera-start');
      await cameraPage.waitForFunction(value => window.rigQa.getCameraState().state === value, expected);
      cameraFailureStates.push(await cameraPage.evaluate(() => window.rigQa.getCameraState()));
    }
    // A delayed permission reply must not reopen a camera after Stop was pressed.
    await cameraPage.evaluate(() => {
      navigator.mediaDevices.getUserMedia = async constraints => {
        await new Promise(resolve => setTimeout(resolve, 200));
        const stream = await window.__originalGetUserMedia(constraints);
        window.__cancelledCameraStream = stream;
        return stream;
      };
    });
    await cameraPage.click('#camera-start');
    await cameraPage.click('#camera-stop');
    await cameraPage.waitForFunction(() => window.__cancelledCameraStream?.getTracks().every(track => track.readyState === 'ended'));
    cancelledStart = await cameraPage.evaluate(() => window.rigQa.getCameraState());
    await cameraPage.evaluate(() => { navigator.mediaDevices.getUserMedia = window.__originalGetUserMedia; });
    await cameraPage.click('#camera-start');
    await cameraPage.waitForFunction(() => ['missing', 'tracking', 'model-error', 'camera-error', 'denied', 'unavailable'].includes(window.rigQa.getCameraState().state), null, { timeout: 45000 });
    const running = await cameraPage.evaluate(() => ({
      ...window.rigQa.getCameraState(),
      message: document.querySelector('#camera-state').textContent,
      eyeDisabled: document.querySelector('#eye-control').disabled,
      mouthDisabled: document.querySelector('#mouth-control').disabled,
      previewHidden: document.querySelector('#camera-video').hidden,
      advancedDisabled: [...document.querySelectorAll('#advanced-parameters input[type="range"]')]
        .filter(input => input.disabled).map(input => input.id.replace('parameter-', '')),
      advancedEditable: [...document.querySelectorAll('#advanced-parameters input[type="range"]')]
        .filter(input => !input.disabled).map(input => input.id.replace('parameter-', '')),
    }));
    await cameraPage.locator('#camera-controls').screenshot({ path: path.join(qaRoot, 'camera-running.png') });
    await cameraPage.evaluate(() => { window.__cameraCanvas = document.querySelector('#rig-canvas'); });
    await cameraPage.click('#motion-tab');
    const tabMotion = await cameraPage.evaluate(() => ({
      ...window.rigQa.getCameraState(),
      mode: document.body.dataset.workspaceMode,
      motionHidden: document.querySelector('#motion-panel').hidden,
      cameraHidden: document.querySelector('#camera-panel').hidden,
      indicatorHidden: document.querySelector('#camera-active-indicator').hidden,
      conflictHidden: document.querySelector('#motion-camera-conflict').hidden,
      sameCanvas: window.__cameraCanvas === document.querySelector('#rig-canvas'),
    }));
    await cameraPage.screenshot({ path: path.join(qaRoot, 'camera-motion-running.png') });

    await cameraPage.evaluate(() => {
      document.querySelector('#advanced-parameters').open = true;
      for (const details of document.querySelectorAll('.parameter-group')) details.open = true;
    });
    for (const [name, value] of [['physAmp', '1.5'], ['eyeCY', '0.2'], ['mouthScale', '1.1'], ['bust', '2']]) {
      await cameraPage.locator(`#parameter-${name}-number`).fill(value);
      await cameraPage.locator(`#parameter-${name}-number`).press('Tab');
    }
    running.adjustedParameters = await cameraPage.evaluate(() => window.rigQa.getProfileParameters());
    for (const group of ['eyes', 'mouth', 'physics']) {
      await cameraPage.locator(`[data-parameter-group="${group}"]`).screenshot({ path: path.join(qaRoot, `camera-editable-${group}.png`) });
    }
    await cameraPage.evaluate(() => { document.querySelector('#advanced-parameters').open = false; });

    await cameraPage.click('#camera-tab');
    await cameraPage.click('#camera-stop');
    const stopped = await cameraPage.evaluate(() => ({
      ...window.rigQa.getCameraState(),
      videoCleared: document.querySelector('#camera-video').srcObject === null,
      eyeDisabled: document.querySelector('#eye-control').disabled,
    }));
    await cameraPage.click('#camera-start');
    await cameraPage.waitForFunction(() => window.rigQa.getCameraState().state !== 'starting');
    await cameraPage.click('#layer-edit-tab');
    const tabLayers = await cameraPage.evaluate(() => ({
      ...window.rigQa.getCameraState(),
      mode: document.body.dataset.workspaceMode,
      cameraHidden: document.querySelector('#camera-panel').hidden,
      indicatorHidden: document.querySelector('#camera-active-indicator').hidden,
      sameCanvas: window.__cameraCanvas === document.querySelector('#rig-canvas'),
    }));
    await cameraPage.click('#camera-tab');
    await cameraPage.click('#camera-start');
    await cameraPage.waitForFunction(() => window.rigQa.getCameraState().state !== 'starting');
    await cameraPage.evaluate(() => window.dispatchEvent(new Event('pagehide')));
    const pagehide = await cameraPage.evaluate(() => window.rigQa.getCameraState());
    fakeCamera = { skipped: false, running, stopped, tabMotion, tabLayers, pagehide };
  } else console.log('SKIP camera inference: verified local model is not available.');
  // Exercise the multiple-camera selector without requiring physical devices.
  const cameraDeviceStyle = await cameraPage.evaluate(() => {
    document.querySelector('#camera-device-field').hidden = false;
    const device = document.querySelector('#camera-device');
    device.replaceChildren(new Option('内蔵カメラ', 'qa-internal'), new Option('外付けカメラ', 'qa-external'));
    device.disabled = false;
    const cameraStyle = getComputedStyle(device);
    const sourceStyle = getComputedStyle(document.querySelector('#generated-psd-select'));
    const properties = ['color', 'backgroundColor', 'borderColor', 'borderRadius', 'padding', 'fontFamily', 'fontSize'];
    return {
      matches: properties.every(property => cameraStyle[property] === sourceStyle[property]),
      height: device.getBoundingClientRect().height,
    };
  });
  await cameraPage.locator('#camera-controls').screenshot({ path: path.join(qaRoot, 'camera-device-desktop.png') });
  await cameraPage.setViewportSize({ width: 375, height: 812 });
  await cameraPage.locator('#camera-controls').scrollIntoViewIfNeeded();
  const cameraMobile = await cameraPage.evaluate(() => {
    const rect = document.querySelector('#camera-controls').getBoundingClientRect();
    return { scrollWidth: document.documentElement.scrollWidth, viewport: innerWidth, left: rect.left, right: rect.right };
  });
  await cameraPage.locator('#camera-controls').screenshot({ path: path.join(qaRoot, 'camera-mobile.png') });
  await cameraPage.locator('#camera-controls').screenshot({ path: path.join(qaRoot, 'camera-device-mobile.png') });
  await cameraPage.screenshot({ path: path.join(qaRoot, 'camera-tab-mobile.png'), fullPage: true });

  const cameraLoadedMessage = await cameraPage.locator('#camera-state').textContent();
  const cameraTabsLayout = await cameraPage.evaluate(() => {
    const tabs = [...document.querySelectorAll('.workspace-mode-tabs button')];
    return {
      count: tabs.length,
      selected: tabs.filter(tab => tab.getAttribute('aria-selected') === 'true').map(tab => tab.id),
      sameRow: tabs.every(tab => Math.abs(tab.getBoundingClientRect().top - tabs[0].getBoundingClientRect().top) < 1),
      labelsFit: tabs.every(tab => tab.scrollWidth <= tab.clientWidth),
      ownPanel: document.querySelector('#camera-panel #camera-controls') !== null && !document.querySelector('#motion-panel #camera-controls'),
      motionHidden: document.querySelector('#motion-panel').hidden,
      cameraHidden: document.querySelector('#camera-panel').hidden,
    };
  });
  // Capture full-travel poses for the flat-layer seam review.
  await cameraPage.setViewportSize({ width: 1440, height: 900 });
  await cameraPage.evaluate(() => window.rigQa.setWorkspaceMode('motion'));
  for (const key of ['angleX', 'angleY', 'angleZ']) for (const sign of [-1, 1]) {
    await cameraPage.evaluate(input => window.rigQa.setTrackingInput(input, 1), { ...trackingNeutral, [key]: sign });
    await cameraPage.waitForTimeout(400);
    await cameraPage.locator('#rig-canvas').screenshot({ path: path.join(qaRoot, `tracking-limit-${key}-${sign < 0 ? 'minus' : 'plus'}.png`) });
  }
  await cameraPage.evaluate(() => window.rigQa.setLiveEnabled(false));
  const voice = await runVoiceQa({ browser, baseUrl, qaRoot, fixtureFile });
  const live = await runLiveQa({ browser, baseUrl, psd: apiGeneratedId, fixtureFile, qaRoot, restart: async () => {
    const previous = server;
    await new Promise(resolve => { previous.once('exit', resolve); previous.kill('SIGTERM'); });
    server = startServer(); await waitForServer();
  } });
  const checks = {
    ...live.checks,
    ...voice.checks,
    cameraDeviceSharesSelectStyle: cameraDeviceStyle.matches && cameraDeviceStyle.height >= 44,
    cameraSensitivityStartsStronger: cameraSensitivity.value === 1.5 && cameraSensitivity.max === 3,
    trackingVerticalDirectionsMatchCanvas: directionNeutral.count > 0 &&
      Object.values(trackingDirections).every(value => value.count > 0) &&
      trackingDirections['head-up'].y < directionNeutral.y && trackingDirections['head-down'].y > directionNeutral.y &&
      trackingDirections['gaze-up'].y < directionNeutral.y && trackingDirections['gaze-down'].y > directionNeutral.y,
    cameraOnlyDisablesTrackedControls: fakeCamera.skipped || (
      ['angleX', 'angleY', 'angleZ', 'body', 'eyeX', 'eyeY', 'mouthForm', 'brow'].every(name => fakeCamera.running.advancedDisabled.includes(name)) &&
      fakeCamera.running.advancedDisabled.length === 8 &&
      ['physAmp', 'soft', 'bust', 'eyeCY', 'eyeScaleL', 'mouthCY', 'mouthScale'].every(name => fakeCamera.running.advancedEditable.includes(name)) &&
      fakeCamera.running.adjustedParameters.physAmp === 1.5 && fakeCamera.running.adjustedParameters.eyeCY === 0.2 &&
      fakeCamera.running.adjustedParameters.mouthScale === 1.1 && fakeCamera.running.adjustedParameters.bust === 2),
    cameraUsesOwnTab: cameraTabsLayout.count === 3 && cameraTabsLayout.selected.join() === 'camera-tab' && cameraTabsLayout.ownPanel && cameraTabsLayout.motionHidden && !cameraTabsLayout.cameraHidden,
    cameraTabFitsMobile: cameraTabsLayout.sameRow && cameraTabsLayout.labelsFit,
    cameraTabNeedsPsd: waitingState.cameraTabDisabled && waitingState.layerTabDisabled && cameraTabBeforeLoad.disabled && cameraTabBeforeLoad.mode === 'motion',
    cameraContinuesInMotionTab: fakeCamera.skipped || (fakeCamera.tabMotion.active && fakeCamera.tabMotion.liveTracks === 1 && fakeCamera.tabMotion.mode === 'motion' && !fakeCamera.tabMotion.motionHidden && fakeCamera.tabMotion.cameraHidden && !fakeCamera.tabMotion.indicatorHidden && !fakeCamera.tabMotion.conflictHidden && fakeCamera.tabMotion.sameCanvas),
    cameraStopsInLayersTab: fakeCamera.skipped || (fakeCamera.tabLayers.state === 'off' && fakeCamera.tabLayers.liveTracks === 0 && fakeCamera.tabLayers.mode === 'layers' && fakeCamera.tabLayers.cameraHidden && fakeCamera.tabLayers.indicatorHidden && fakeCamera.tabLayers.sameCanvas),
    cameraLoadedMessageMatchesState: !modelStatus.ready || (cameraLoadedMessage === 'カメラは停止しています。' && cameraInitiallyLoadedMessage === 'カメラは停止しています。'),
    cameraActionsAreEndpointSpecific: wrongModelAction === 403 && wrongFolderAction === 403 && prepareAction === 'prepare-face-model' && (preparedModelStatus === null || preparedModelStatus === 200),
    cameraPreparationRequiresClick: automaticModelPosts === 0 && explicitModelPosts === 1 && preparedByButton,
    cameraEndpointsAreRestricted: rejectedModelPost === 403 && rejectedModelAsset === 404,
    trackingInputMovesHeadEyesAndMouth: Object.values(trackingDifferences).every(value => value > 10),
    trackingOffKeepsStaticPixels: trackingZeroDifference === 0 && trackingStoppedDifference === 0,
    cameraStartStopAndPagehide: fakeCamera.skipped || (
      fakeCamera.running.state === 'missing' && fakeCamera.running.liveTracks === 1 &&
      fakeCamera.running.eyeDisabled && fakeCamera.running.mouthDisabled && fakeCamera.running.previewHidden &&
      fakeCamera.stopped.state === 'off' && fakeCamera.stopped.liveTracks === 0 && fakeCamera.stopped.videoCleared && !fakeCamera.stopped.eyeDisabled &&
      fakeCamera.pagehide.state === 'off' && fakeCamera.pagehide.liveTracks === 0),
    cameraNeverRequestsExternalAssets: externalRequests.length === 0,
    cameraMobileFits: cameraMobile.scrollWidth === 375 && cameraMobile.left >= 0 && cameraMobile.right <= 375,
    cameraHasNoErrors: cameraErrors.length === 0,
    cameraDistinguishesPermissionAndMissingDevice: fakeCamera.skipped || (cameraFailureStates[0]?.state === 'denied' && cameraFailureStates[1]?.state === 'unavailable'),
    cameraStopCancelsPendingStart: fakeCamera.skipped || (cancelledStart?.state === 'off' && cancelledStart?.liveTracks === 0),
    startRequestCopiesConversionMessage:
      startRequestInitiallyOpen === false &&
      codexStartRequest.message.startsWith('$still2rig-psd') &&
      codexStartRequest.message.includes('Google Colab') &&
      codexStartRequest.message.endsWith('画像ファイルの場所: ') &&
      !codexStartRequest.message.includes('Claude Code') &&
      !codexStartRequest.message.includes(repositoryRoot) &&
      codexStartRequest.stepName === 'Codex' &&
      claudeStartRequest.message.includes('.agents/skills/still2rig-psd/SKILL.md') &&
      !claudeStartRequest.message.includes('$still2rig-psd') &&
      claudeStartRequest.message.endsWith('画像ファイルの場所: ') &&
      claudeStartRequest.stepName === 'Claude Code',
    startRequestSharesSavedRecipient:
      claudeStartRequest.expressionClaudePressed === 'true' &&
      startRecipientAfterReload === 'true' &&
      codexStartRequest.expressionClaudePressed === 'false',
    additionalExpressionSelection:
      emptyExpressionSelectionDisabled &&
      additionalCodexRequest.message.includes('--only eye_smile,blush') &&
      additionalCodexRequest.message.includes('笑い目・頬の赤らみ') &&
      additionalCodexRequest.message.includes('results/eye_smile.png と blush.png') &&
      additionalCodexRequest.message.includes('同意済み') &&
      additionalClaudeRequest.message.includes('--only eye_smile,blush') &&
      additionalClaudeRequest.message.includes('そこで止まって') &&
      !additionalClaudeRequest.message.includes('同意済み'),
    expressionRequestCopiesCurrentSavedPsd:
      waitingState.expressionRequestHidden === true &&
      selectedGeneratedState.expressionRequestHidden === false &&
      expressionRequestMessage.includes(`expression-requests ${fixtureJobId}`) &&
      expressionRequestMessage.includes(`import-expressions ${fixtureJobId}`) &&
      expressionRequestMessage.includes(`repair ${fixtureJobId} --expressions`) &&
      expressionRequestMessage.includes('同意済み') &&
      expressionRequestMessage.includes('imagegen') &&
      !expressionRequestMessage.includes('Claude Code') &&
      !expressionRequestMessage.includes(repositoryRoot) &&
      codexExpressionRequest.disclosureHidden === false &&
      codexExpressionRequest.codexStepsHidden === false &&
      codexExpressionRequest.claudeStepsHidden === true &&
      selectedGeneratedState.expressionRequestBodyHidden === false &&
      selectedGeneratedState.expressionRequestOpen === (selectedGeneratedProductionReady !== true) &&
      mobileExpressionRequestFits === true,
    expressionRequestClaudeStopsBeforeGeneration:
      claudeExpressionRequest.message.includes(`expression-requests ${fixtureJobId}`) &&
      claudeExpressionRequest.message.includes('画像を生成できません') &&
      claudeExpressionRequest.message.includes('そこで止まって') &&
      !claudeExpressionRequest.message.includes('同意済み') &&
      !claudeExpressionRequest.message.includes('$still2rig-psd') &&
      !claudeExpressionRequest.message.includes(repositoryRoot) &&
      claudeExpressionRequest.disclosureHidden === true &&
      claudeExpressionRequest.codexStepsHidden === true &&
      claudeExpressionRequest.claudeStepsHidden === false,
    expressionRequestExplainsLocalPsd:
      localExpressionRequestState.hidden === false &&
      localExpressionRequestState.open === false &&
      localExpressionRequestState.bodyHidden === true &&
      Boolean(localExpressionRequestState.summary?.includes('このツールで変換したPSD')),
    expressionRequestScreenshotHasNoEmptyOverlay: expressionRequestEmptyStateOpacity === '0',
    startsWithoutBundledArtwork:
      waitingState.ready === false &&
      waitingState.status === '待機中' &&
      waitingState.avatarReady === 'false',
    legacyWebglBadgeRemoved:
      waitingState.legacyBadgeCount === 0 && waitingState.titleParent === 'brand-block',
    generatedLibraryListsOutputs: waitingState.generatedOptions === 1,
    generatedLibraryHidesLocalPaths:
      libraryResponse.ok &&
      libraryPayload.items?.length === 1 &&
      !Object.hasOwn(libraryPayload.items[0], 'file') &&
      !JSON.stringify(libraryPayload).includes(repositoryRoot),
    generatedFolderApiOpensOnlyKnownOutputs:
      openFolderResponse.ok &&
      openFolderPayload.ok === true &&
      unknownOpenFolderStatus === 404 &&
      crossOriginOpenFolderStatus === 403 &&
      !JSON.stringify(openFolderPayload).includes(repositoryRoot),
    generatedFolderButtonMatchesSelection:
      waitingState.openFolderDisabled === true &&
      selectedGeneratedState.openFolderDisabled === false &&
      openFolderUiState.label === '保存先を開く' &&
      openFolderUiState.disabled === false &&
      openFolderUiState.note?.includes(`${fixtureJobId}.psd の保存先を開きました。`) &&
      localFolderButtonDisabled === true,
    unknownGeneratedPsdIsRejected: unknownPsdStatus === 404,
    generatedSelectorLoadsPsd:
      selectedGeneratedState.modelName === `${fixtureJobId}.psd` &&
      selectedGeneratedState.selectedValue === generatedId,
    latestGeneratedPsdAutoLoads:
      autoLoadedState.modelName === `${fixtureJobId}.psd` &&
      autoLoadedState.selectedValue === generatedId,
    previewStartsNearTop:
      typeof initialLayout.canvasTop === 'number' && initialLayout.canvasTop < 175,
    previewFitsViewport:
      typeof initialLayout.canvasBottom === 'number' &&
      initialLayout.canvasBottom <= initialLayout.viewportHeight - 30,
    avatarStartsWithMargin:
      Math.abs(initialLayout.view.scale - 0.9) < 0.001 && initialLayout.zoomLabel === '90%',
    previewIsVisuallyDominant:
      initialLayout.stageWidth / initialLayout.viewportWidth > 0.68 &&
      initialLayout.panelWidth <= 400 &&
      Math.abs(initialLayout.headerBottom - initialLayout.stageTop) < 1,
    layerEditorSeparatesWorkModes:
      layerEditorInitial.modeLabel === 'true' &&
      layerEditorInitial.motionHidden === true &&
      layerEditorInitial.editorHidden === false,
    layerEditorUsesPlainFrontBackLanguage:
      layerEditorInitial.topLabel === '手前' &&
      layerEditorInitial.selectedName === 'まだ選んでいません' &&
      layerEditorInitial.pickHint === '人物の直したい部分をクリックして選択' &&
      layerEditorInitial.visibleRows === 15,
    layerEditorUsesDesktopOnlySelectionGuidance:
      !layerEditorInitial.pickHint?.match(/^[①-⑳]/) &&
      !layerEditorInitial.pickHint?.includes('ドラッグで表示位置') &&
      !layerEditorInitial.selectionCopy.includes('タップ'),
    layerEditorStartsSafe:
      layerEditorInitial.state.dirty === false &&
      layerEditorInitial.state.selectedLayer === null &&
      layerEditorInitial.frontDisabled === true &&
      layerEditorInitial.saveDisabled === true,
    layerProcessingOverlayCoversPreview:
      layerProcessingDesktop.active === 'true' &&
      layerProcessingDesktop.ariaHidden === 'false' &&
      layerProcessingDesktop.canvasBusy === 'true' &&
      layerProcessingDesktop.stageBusy === 'true' &&
      layerProcessingDesktop.title === '重なりを変更しています' &&
      layerProcessingDesktop.detail?.includes('数秒かかることがあります') &&
      layerProcessingDesktop.opacity > 0.95 &&
      layerProcessingDesktop.pointerEvents === 'auto' &&
      layerProcessingDesktop.spinnerAnimation !== 'none' &&
      layerProcessingDesktop.boundsDifference &&
      Object.values(layerProcessingDesktop.boundsDifference).every((value) => value < 1),
    layerProcessingOverlayAlwaysDismisses:
      layerProcessingDismissed.active === 'false' &&
      layerProcessingDismissed.ariaHidden === 'true' &&
      layerProcessingDismissed.canvasBusy === 'false' &&
      layerProcessingDismissed.opacity === 0,
    layerPanelScrollDoesNotCoverContent:
      layerOrderOpenedWithoutOverlap?.panelScrollTop > 0 &&
      layerOrderOpenedWithoutOverlap.windowScrollY === 0 &&
      Math.abs(layerOrderOpenedWithoutOverlap.headerTop) < 1 &&
      Math.abs(layerOrderOpenedWithoutOverlap.headerBottom - layerOrderOpenedWithoutOverlap.panelTop) < 1 &&
      layerOrderOpenedWithoutOverlap.selectedPosition === 'static' &&
      layerOrderOpenedWithoutOverlap.selectedBottom <= layerOrderOpenedWithoutOverlap.panelTop + 1 &&
      layerOrderOpenedWithoutOverlap.summaryTop >= layerOrderOpenedWithoutOverlap.panelTop - 1 &&
      layerOrderOpenedWithoutOverlap.summaryBottom <= layerOrderOpenedWithoutOverlap.panelBottom &&
      layerOrderOpenedWithoutOverlap.summaryIsTopmost === true &&
      layerOrderOpenedWithoutOverlap.selectedOverlapsSummary === false,
    layerPanelSectionsRemainReachable:
      layerFlowVisibility.length === 4 &&
      layerFlowVisibility.every((item) => item.visible && item.selectedCardOutOfTheWay),
    layerOrderDragShowsClearDropTarget:
      layerOrderDragging.bodyState === 'true' &&
      layerOrderDragging.indicatorText === 'ここに移動' &&
      layerOrderDragging.grabbedRows === 1 &&
      layerOrderDragging.selectedRows === 1 &&
      layerOrderDragging.sourceOpacity < 0.6 &&
      layerOrderDragging.sourceRowDraggable === false &&
      layerOrderDragging.sourceHandleDraggable === true &&
      layerOrderDragging.instruction?.includes('右端の点々') &&
      layerOrderDragging.instruction?.includes('PCのみ'),
    layerOrderDragCommitsOnlyOnDrop:
      JSON.stringify(layerOrderDropped.state.currentOrder) !== JSON.stringify(dragOrderBefore) &&
      layerOrderDropped.state.dirty === true &&
      layerOrderDropped.dragging === 'false' &&
      layerOrderDropped.indicatorCount === 0 &&
      layerOrderDropped.announcement?.includes('重なりを変更しました'),
    layerOrderTouchExplainsDesktopRequirement:
      layerOrderTouchNotice.hidden === false &&
      layerOrderTouchNotice.text?.includes('タッチ操作での並べ替えには対応していません') &&
      layerOrderTouchNotice.text?.includes('PCのマウス') &&
      layerOrderTouchNotice.role === 'status' &&
      layerOrderTouchNotice.ariaLive === 'polite',
    layerOrderDragCanBeUndoneSafely:
      layerOrderResetAfterDrag.dirty === false &&
      JSON.stringify(layerOrderResetAfterDrag.currentOrder) === JSON.stringify(dragOrderBefore),
    canvasClickSelectsVisibleLayer:
      layerEditorCanvasSelection.state.selectedLayer === 'face' &&
      layerEditorCanvasSelection.state.layerFocus === 'face' &&
      layerEditorCanvasSelection.selectedName === '顔' &&
      layerEditorCanvasSelection.selectedBadge === '選択中：顔' &&
      layerEditorCanvasSelection.markerHidden === false &&
      layerEditorCanvasSelection.candidateMenuHidden === false &&
      layerEditorCanvasSelection.candidateCount >= 2 &&
      layerEditorCanvasSelection.selectedRows === 1 &&
      layerEditorCanvasSelection.frontDisabled === false &&
      layerEditorCanvasSelection.backDisabled === false,
    canvasSelectionFocusIsTemporary:
      layerEditorFocusReleased.state.selectedLayer === 'face' &&
      layerEditorFocusReleased.state.layerFocus === null &&
      layerEditorFocusReleased.markerHidden === false &&
      layerEditorFocusReleased.selectedBadge === '選択中：顔',
    emptyCanvasClickExplainsNextStep:
      layerEditorEmptyClick.selectedLayer === 'face' &&
      layerEditorEmptyClick.menuHidden === false &&
      layerEditorEmptyClick.title === 'ここには選べる部分がありません',
    canvasPickingRespectsZoomAndDrag:
      zoomedCanvasSelection === 'face' &&
      compactLayerDrag.selectedLayer === 'face' &&
      Math.abs(compactLayerDrag.view.offsetX) > 5 &&
      Math.abs(compactLayerDrag.view.offsetY) > 5,
    canvasClickSelectsArm:
      layerEditorHandSelection.selectedLayer === 'handwear' &&
      layerEditorHandSelection.selectedName === '腕・手' &&
      layerEditorHandSelection.markerHidden === false,
    layerEditorReordersAndMarksUnsaved:
      layerEditorChanged.state.dirty === true &&
      layerEditorChanged.status === '未保存' &&
      layerEditorChanged.phase === '未保存の変更があります' &&
      layerEditorChanged.saveDisabled === false &&
      layerEditorChanged.announcement?.includes('手前へ') &&
      layerEditorChanged.processingActive === 'false' &&
      layerEditorChanged.processingAriaHidden === 'true' &&
      layerEditorVisualChange.changedPixelRatio > 0.001,
    layerEditorComparesWithoutEditing:
      layerEditorOriginalPreview.state.showingOriginal === true &&
      layerEditorOriginalPreview.previewBadge === '変更前' &&
      layerEditorOriginalPreview.moveDisabled === true &&
      layerEditorOriginalPreview.toggleLabel === '修正後に戻す' &&
      layerEditorOriginalPreview.badgeBackground === 'rgb(255, 210, 124)' &&
      layerEditorOriginalPreview.state.layerFocus === null &&
      layerEditorOriginalMatch.changedPixelRatio < 0.0001,
    layerEditorDownloadsVerifiedCopy:
      download.suggestedFilename() === 'qa-generated-preview-重なり修正版.psd' &&
      layerEditorSaved.state.dirty === false &&
      layerEditorSaved.status === '保存済み' &&
      layerEditorSaved.message?.includes('元のPSDはそのまま') &&
      JSON.stringify(downloadedLayerNames) ===
        JSON.stringify(layerEditorChanged.state.currentOrder.map((id) => id.slice(id.indexOf(':') + 1))),
    dropOverlayAppears: overlayVisible,
    localPsdUploadLoads:
      summary?.canvasWidth === 256 &&
      summary?.missingRequiredParts?.length === 0,
    autoBlinkDefaultsOn,
    autoBlinkCanBeDisabled:
      autoBlinkDisabled.enabled === false &&
      autoBlinkDisabled.pressed === 'false' &&
      autoBlinkDisabled.label === 'OFF',
    autoBlinkClosesAndReopens:
      blinkClosed.left < 0.2 &&
      blinkClosed.right < 0.2 &&
      blinkReopened.left > 0.9 &&
      blinkReopened.right > 0.9,
    advancedParametersExposeInternalDefaults:
      advancedInitial.itemCount === 32 &&
      advancedInitial.groupCount === 4 &&
      advancedInitial.angleZ === 0 &&
      advancedInitial.physAmp === 2 &&
      advancedInitial.fhSoft === 0.4 &&
      advancedInitial.numberValue === '0.00',
    advancedParameterUpdatesRenderer:
      Math.abs(advancedAdjusted.angleZ - 0.55) < 0.001 &&
      advancedAdjusted.rangeValue === '0.55' &&
      advancedAdjusted.numberValue === '0.55' &&
      advancedAdjusted.changedPixelRatio > 0.001,
    advancedParametersResetToDefaults:
      advancedResetState.angleZ === 0 &&
      advancedResetState.physAmp === 2 &&
      advancedResetState.fhSoft === 0.4 &&
      advancedResetState.numberValue === '0.00',
    calmPresetReachesRenderer:
      Math.abs(tuning.intensity - 0.65) < 0.001 &&
      Math.abs(tuning.hairWindScale - 0.5) < 0.001,
    calmHairStillMoves:
      motionMetrics.changedPixelRatio > 0.001 &&
      motionMetrics.meanAbsoluteError > 0.01,
    // Pointer deltas are converted from CSS pixels to the PSD canvas space.
    avatarDragWorks: Math.abs(drag.offsetX) > 25 && Math.abs(drag.offsetY) > 12,
    zoomWorks: Math.abs(zoom.scale - 1.35) < 0.001,
    mobileSourceComesBeforePreview:
      mobileWaitingLayout.sourceBottom <= mobileWaitingLayout.stageTop + 1 &&
      mobileWaitingLayout.headerBottom <= mobileWaitingLayout.stageTop + 1,
    mobileWaitingCardFitsCanvas:
      mobileWaitingLayout.emptyTop >= mobileWaitingLayout.canvasTop &&
      mobileWaitingLayout.emptyBottom <= mobileWaitingLayout.canvasBottom,
    mobileHasNoHorizontalOverflow:
      mobileWaitingLayout.scrollWidth <= mobileWaitingLayout.viewportWidth,
    mobileControlsRemainTouchSized:
      mobileWaitingLayout.fileButtonHeight >= 44,
    mobileLoadedPsd:
      mobileLoadedLayout.modelName === `${fixtureJobId}.psd` &&
      mobileLoadedLayout.stageBottom <= mobileLoadedLayout.panelTop + 1 &&
      mobileLoadedLayout.emptyStateOpacity === '0',
    mobileLayerEditorRemainsUsable:
      mobileLayerEditorLayout.editorHidden === false &&
      mobileLayerEditorLayout.motionHidden === true &&
      mobileLayerEditorLayout.scrollWidth <= mobileLayerEditorLayout.viewportWidth &&
      mobileLayerEditorLayout.frontButtonHeight >= 44 &&
      mobileLayerEditorLayout.backButtonHeight >= 44 &&
      mobileLayerEditorLayout.saveButtonHeight >= 44 &&
      mobileLayerEditorLayout.detailsOpen === false,
    mobileTapSelectsVisibleLayer:
      mobileCanvasSelection.selectedLayer === 'face' &&
      mobileCanvasSelection.selectedName === '顔' &&
      mobileCanvasSelection.markerHidden === false &&
      mobileCanvasSelection.candidateCount >= 2 &&
      mobileCanvasSelection.candidateButtonHeight >= 44,
    mobileLayerProcessingFitsPreview:
      mobileLayerProcessing.active === 'true' &&
      mobileLayerProcessing.scrollWidth <= mobileLayerProcessing.viewportWidth &&
      mobileLayerProcessing.opacity > 0.95 &&
      mobileLayerProcessing.title === '重なりを変更しています' &&
      mobileLayerProcessing.cardInsideOverlay === true &&
      mobileLayerProcessing.boundsDifference &&
      Object.values(mobileLayerProcessing.boundsDifference).every((value) => value < 1),
    compactSelectionActionsStayVisible:
      compactSelectionFlow.selectedLayer === 'face' &&
      compactSelectionFlow.cardTop >= 0 &&
      compactSelectionFlow.cardBottom <= compactSelectionFlow.viewportHeight &&
      compactSelectionFlow.frontTop >= 0 &&
      compactSelectionFlow.frontBottom <= compactSelectionFlow.viewportHeight &&
      compactSelectionFlow.backTop >= 0 &&
      compactSelectionFlow.backBottom <= compactSelectionFlow.viewportHeight,
    compactDesktopLayerEditorRemainsUsable:
      compactLayerEditorLayout.scrollWidth <= compactLayerEditorLayout.viewportWidth &&
      compactLayerEditorLayout.panelRight <= compactLayerEditorLayout.viewportWidth &&
      compactLayerEditorLayout.panelScrollable === true &&
      compactLayerEditorLayout.panelScrollTop > 0 &&
      compactLayerEditorLayout.saveTop >= 0 &&
      compactLayerEditorLayout.saveBottom <= compactLayerEditorLayout.viewportHeight &&
      compactLayerEditorLayout.frontButtonHeight >= 44 &&
      compactLayerEditorLayout.backButtonHeight >= 44 &&
      compactLayerEditorLayout.sourceActionsFit === true &&
      compactLayerEditorLayout.detailsOpen === false,
    noConsoleErrors: consoleErrors.length === 0,
    noMobileConsoleErrors: mobileConsoleErrors.length === 0,
    noCompactConsoleErrors: compactConsoleErrors.length === 0,
  };
  const report = {
    live,
    voice,
    camera: { cameraDeviceStyle, cameraSensitivity, directionNeutral, trackingDirections, cameraInitiallyLoadedMessage, cameraLoadedMessage, cameraTabsLayout, cameraTabBeforeLoad, wrongModelAction, wrongFolderAction, prepareAction, preparedModelStatus, fakeCamera, cameraFailureStates, cancelledStart, trackingDifferences, trackingZeroDifference, trackingStoppedDifference, cameraMobile, cameraErrors, cameraDiagnostics, externalRequests },
    pass: Object.values(checks).every(Boolean),
    checks,
    waitingState,
    libraryPayload,
    unknownPsdStatus,
    openFolderPayload,
    unknownOpenFolderStatus,
    crossOriginOpenFolderStatus,
    openFolderUiState,
    localFolderButtonDisabled,
    selectedGeneratedState,
    expressionRequestEmptyStateOpacity,
    autoLoadedState,
    initialLayout,
    layerEditorInitial,
    layerProcessingDesktop,
    layerProcessingDismissed,
    layerOrderOpenedWithoutOverlap,
    layerFlowVisibility,
    dragOrderBefore,
    layerOrderDragging,
    layerOrderDropped,
    layerOrderTouchNotice,
    layerOrderResetAfterDrag,
    layerEditorCanvasSelection,
    layerEditorFocusReleased,
    layerEditorEmptyClick,
    zoomedCanvasSelection,
    layerEditorHandSelection,
    layerEditorChanged,
    layerEditorOriginalPreview,
    layerEditorVisualChange,
    layerEditorOriginalMatch,
    layerEditorSaved,
    downloadedLayerNames,
    summary,
    autoBlinkDefaultsOn,
    autoBlinkDisabled,
    blinkClosed,
    blinkReopened,
    advancedInitial,
    advancedAdjusted,
    advancedResetState,
    tuning,
    motionMetrics,
    drag,
    zoom,
    mobileWaitingLayout,
    mobileLoadedLayout,
    mobileLayerEditorLayout,
    mobileCanvasSelection,
    mobileLayerProcessing,
    compactSelectionFlow,
    compactLayerDrag,
    compactLayerEditorLayout,
    consoleErrors,
    mobileConsoleErrors,
    compactConsoleErrors,
  };
  await fs.writeFile(path.join(qaRoot, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
  if (!report.pass) process.exitCode = 1;
} finally {
  await browser?.close();
  server.kill('SIGTERM');
}
