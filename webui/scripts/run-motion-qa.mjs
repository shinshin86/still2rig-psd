// Renderer adapter for configs/motion-qa-contract.json.
//
// Loads a PSD into the built-in preview renderer, records every required
// capture at 1:1 model scale on the solid QA background, and scores the frames
// with src/motionQa.mjs. Usage (normally through `still2rig-psd motion-qa`):
//
//   node scripts/run-motion-qa.mjs --psd FILE --out DIR [--reference-psd FILE]

import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

import { chromium } from 'playwright';

import { evaluateMotionQa, hairTipMaskFromLayers, loadMotionContract, visibleHairMaskFromLayers } from '../../src/motionQa.mjs';
import { decodePngRgba, inspectPsd } from '../../src/psd.mjs';

const webuiRoot = path.resolve(import.meta.dirname, '..');
const require = createRequire(import.meta.url);
const viteBin = path.join(path.dirname(require.resolve('vite/package.json')), 'bin', 'vite.js');

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 2) {
    if (!argv[index].startsWith('--')) throw new Error(`Unexpected argument: ${argv[index]}`);
    args[argv[index].slice(2)] = argv[index + 1];
  }
  if (!args.psd || !args.out) throw new Error('Usage: run-motion-qa.mjs --psd FILE --out DIR [--reference-psd FILE]');
  return args;
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function startServer(port, jobsRoot) {
  const server = spawn(process.execPath, [viteBin, '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
    cwd: webuiRoot,
    env: { ...process.env, STILL2RIG_PSD_JOBS_ROOT: jobsRoot },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  server.stdout.on('data', (chunk) => { log += chunk; });
  server.stderr.on('data', (chunk) => { log += chunk; });
  const baseUrl = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      if ((await fetch(baseUrl)).ok) return { server, baseUrl };
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 125));
  }
  server.kill();
  throw new Error(`Preview server did not start.\n${log}`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function loadPsd(page, file) {
  await page.evaluate(() => { if (window.rigQa) window.rigQa.ready = false; });
  await page.setInputFiles('#psd-file-input', file);
  await page.waitForFunction(() => window.rigQa?.ready === true || window.rigQa?.error, null, { timeout: 60_000 });
  const error = await page.evaluate(() => window.rigQa.error);
  if (error) throw new Error(`Renderer could not load ${path.basename(file)}: ${error}`);
  await page.evaluate(() => {
    window.rigQa.setAutoBlink(false);
    window.rigQa.setMode('static');
    window.rigQa.setBackground('solid');
    window.rigQa.setViewTransform(0, 0, 1);
    window.rigQa.setState(1, 0);
  });
  await sleep(800);
  return page.evaluate(() => ({
    anchors: window.rigQa.anchors,
    summary: window.rigQa.summary,
    canvas: { width: document.querySelector('#rig-canvas').width, height: document.querySelector('#rig-canvas').height },
  }));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const psdFile = path.resolve(args.psd);
  const referencePsd = path.resolve(args['reference-psd'] || args.psd);
  const outDir = path.resolve(args.out);
  const framesDir = path.join(outDir, 'frames');
  await fs.rm(outDir, { recursive: true, force: true });
  await fs.mkdir(framesDir, { recursive: true });

  const contract = loadMotionContract();
  const emptyJobsRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'still2rig-motion-qa-'));
  const { server, baseUrl } = await startServer(await freePort(), emptyJobsRoot);
  let browser;
  try {
    browser = await chromium.launch({
      headless: true,
      args: ['--use-angle=metal', '--enable-webgl', '--ignore-gpu-blocklist'],
    });

    // Size the page so the canvas element screenshot is exactly model scale.
    const probe = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await probe.goto(`${baseUrl}/?autoload=0`, { waitUntil: 'domcontentloaded' });
    const probeInfo = await loadPsd(probe, referencePsd);
    const cssWidth = await probe.evaluate(() => document.querySelector('#rig-canvas').getBoundingClientRect().width);
    await probe.close();
    const deviceScaleFactor = probeInfo.canvas.width / cssWidth;
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor });
    const consoleErrors = [];
    page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()); });
    await page.goto(`${baseUrl}/?autoload=0`, { waitUntil: 'domcontentloaded' });

    const canvas = page.locator('#rig-canvas');
    let frameCounter = 0;
    const capture = async (name, label) => {
      // Clip to an integer-aligned CSS box so the capture is exactly model scale.
      const rect = await canvas.boundingBox();
      const buffer = await page.screenshot({
        animations: 'allow',
        clip: { x: Math.round(rect.x), y: Math.round(rect.y), width: cssWidth, height: cssWidth },
      });
      const frame = decodePngRgba(buffer, `${name}-${label}.png`);
      if (frame.width !== probeInfo.canvas.width || frame.height !== probeInfo.canvas.height) {
        throw new Error(`Capture is ${frame.width}x${frame.height}, expected ${probeInfo.canvas.width}x${probeInfo.canvas.height}.`);
      }
      frameCounter += 1;
      const file = path.join(framesDir, `${String(frameCounter).padStart(3, '0')}-${name}-${label}.png`);
      await fs.writeFile(file, buffer);
      return { label, frame, file: path.relative(outDir, file) };
    };

    const reference = await loadPsd(page, referencePsd);
    const referenceFrame = (await capture('reference', 'neutral')).frame;
    const info = referencePsd === psdFile ? reference : await loadPsd(page, psdFile);

    const captures = {};
    const setState = (eye, mouth) => page.evaluate(([e, m]) => window.rigQa.setState(e, m), [eye, mouth]);
    const setMode = (mode) => page.evaluate((m) => window.rigQa.setMode(m), mode);

    await setMode('static');
    await setState(1, 0);
    await sleep(500);
    captures.neutral = [await capture('neutral', 'eye-1.00-mouth-0.00')];

    captures['blink-four-state'] = [];
    for (const eye of [1, 0.66, 0.33, 0]) {
      await setState(eye, 0);
      await sleep(350);
      captures['blink-four-state'].push(await capture('blink-four-state', `eye-${eye.toFixed(2)}`));
    }

    captures['mouth-four-state'] = [];
    for (const mouth of [0, 0.33, 0.66, 1]) {
      await setState(1, mouth);
      await sleep(350);
      captures['mouth-four-state'].push(await capture('mouth-four-state', `mouth-${mouth.toFixed(2)}`));
    }

    captures['lip-sync-continuous'] = [];
    for (let step = 0; step < 10; step += 1) {
      const mouth = 0.5 - 0.5 * Math.cos((2 * Math.PI * step) / 10);
      await setState(1, mouth);
      await sleep(90);
      captures['lip-sync-continuous'].push(await capture('lip-sync-continuous', `step-${step}-mouth-${mouth.toFixed(2)}`));
    }
    await setState(1, 0);

    captures['hair-physics-only'] = [];
    await setMode('physics');
    await sleep(400);
    for (let step = 0; step < 12; step += 1) {
      await sleep(250);
      captures['hair-physics-only'].push(await capture('hair-physics-only', `t-${step}`));
    }

    captures['full-body-idle'] = [];
    await setMode('idle-physics');
    await sleep(400);
    for (let step = 0; step < 12; step += 1) {
      await sleep(300);
      captures['full-body-idle'].push(await capture('full-body-idle', `t-${step}`));
    }

    captures['drag-inertia'] = [];
    await setMode('physics');
    await sleep(300);
    const box = await canvas.boundingBox();
    const startX = box.x + box.width * 0.5;
    const startY = box.y + box.height * 0.5;
    await page.mouse.move(startX, startY);
    await page.mouse.down();
    for (let step = 1; step <= 8; step += 1) {
      await page.mouse.move(startX + step * 18, startY + step * 4);
      await sleep(16);
    }
    await page.mouse.up();
    // Dragging also pans the view; restore 1:1 while the inertia keeps moving.
    await page.evaluate(() => window.rigQa.setViewTransform(0, 0, 1));
    const dragMotion = [];
    for (let step = 0; step < 10; step += 1) {
      dragMotion.push(await page.evaluate(() => window.rigQa.getDragMotion()));
      captures['drag-inertia'].push(await capture('drag-inertia', `after-release-${step}`));
      await sleep(120);
    }
    await setMode('static');

    const psd = inspectPsd(referencePsd);
    const hairTipMask = hairTipMaskFromLayers(psd.layers, info.canvas.width, info.canvas.height);
    const visibleHairMask = visibleHairMaskFromLayers(psd.layers, info.canvas.width, info.canvas.height);
    const evaluation = evaluateMotionQa({
      reference: { frame: referenceFrame, anchors: reference.anchors },
      captures,
      hairTipMask,
      visibleHairMask,
      contract,
    });
    const dragPeak = Math.max(...dragMotion.map((value) => Math.hypot(value.x, value.y)));
    const report = {
      schemaVersion: 1,
      adapter: 'still2rig-psd built-in preview renderer (Playwright, headless Chromium)',
      contract: 'configs/motion-qa-contract.json',
      psd: path.basename(psdFile),
      referencePsd: path.basename(referencePsd),
      canvas: info.canvas,
      ...evaluation,
      drag: { peakMotion: Number(dragPeak.toFixed(4)), responded: dragPeak > 0.001, samples: dragMotion },
      captures: Object.fromEntries(Object.entries(captures).map(([name, items]) => [name, items.map((item) => item.file)])),
      consoleErrors,
    };
    await fs.writeFile(path.join(outDir, 'motion-qa.json'), `${JSON.stringify(report, null, 2)}\n`);
    console.log(JSON.stringify({ pass: report.pass, metrics: report.metrics, checks: report.checks, report: path.join(outDir, 'motion-qa.json') }));
  } finally {
    await browser?.close();
    server.kill();
    fsSync.rmSync(emptyJobsRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error.stack || String(error));
  process.exitCode = 1;
});
