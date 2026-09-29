import fs from 'node:fs';
import path from 'node:path';
import { inspectPsd, readPngRgba } from './psd.mjs';
import { loadDefaults, readJson, relativeProjectPath, writeJson } from './utils.mjs';

function centroid(image, predicate = () => true, threshold = 16) {
  let sx = 0;
  let sy = 0;
  let weight = 0;
  let pixels = 0;
  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      if (!predicate(x, y)) continue;
      const alpha = image.data[(y * image.width + x) * 4 + 3];
      if (alpha <= threshold) continue;
      sx += x * alpha;
      sy += y * alpha;
      weight += alpha;
      pixels += 1;
    }
  }
  return weight ? { x: sx / weight, y: sy / weight, pixels } : null;
}

function distance(a, b) {
  if (!a || !b) return Number.POSITIVE_INFINITY;
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function findLayerFile(layerDir, names) {
  return names.map((name) => path.join(layerDir, name)).find((file) => fs.existsSync(file));
}

function artworkStats(image, alphaThreshold) {
  let left = image.width;
  let top = image.height;
  let right = 0;
  let bottom = 0;
  let visiblePixels = 0;
  let brightPixels = 0;
  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      const index = (y * image.width + x) * 4;
      if (image.data[index + 3] <= alphaThreshold) continue;
      visiblePixels += 1;
      left = Math.min(left, x);
      top = Math.min(top, y);
      right = Math.max(right, x + 1);
      bottom = Math.max(bottom, y + 1);
      const luminance = (image.data[index] * 299 + image.data[index + 1] * 587 + image.data[index + 2] * 114) / 1000;
      if (luminance > 235) brightPixels += 1;
    }
  }
  if (!visiblePixels) return { bbox: null, visiblePixels: 0, fillRatio: null, brightPixelRatio: null };
  const bboxPixels = (right - left) * (bottom - top);
  return {
    bbox: [left, top, right, bottom],
    visiblePixels,
    fillRatio: Number((visiblePixels / bboxPixels).toFixed(4)),
    brightPixelRatio: Number((brightPixels / visiblePixels).toFixed(4)),
  };
}

function mouthArtworkQuality(layerDir, canvasWidth, canvasHeight, quality) {
  const mouthOpenFile = findLayerFile(layerDir, ['mouth_open.png']);
  const mouthCloseFile = findLayerFile(layerDir, ['mouth_close.png', 'mouth.png']);
  const open = mouthOpenFile ? artworkStats(readPngRgba(mouthOpenFile), quality.alphaThreshold) : null;
  const close = mouthCloseFile ? artworkStats(readPngRgba(mouthCloseFile), quality.alphaThreshold) : null;
  const maximumVisiblePixels = Math.max(
    quality.mouthMaxVisiblePixelsFloor,
    Math.round(canvasWidth * canvasHeight * quality.mouthMaxVisiblePixelRatio),
  );
  const maximumWidth = Math.max(20, Math.round(canvasWidth * quality.mouthMaxWidthRatio));
  const maximumHeight = Math.max(12, Math.round(canvasHeight * quality.mouthMaxHeightRatio));
  const compact = (stats) => stats && stats.bbox
    && stats.visiblePixels <= maximumVisiblePixels
    && stats.bbox[2] - stats.bbox[0] <= maximumWidth
    && stats.bbox[3] - stats.bbox[1] <= maximumHeight;
  return {
    close,
    open,
    checks: {
      compactCloseMouth: Boolean(compact(close)),
      compactOpenMouth: Boolean(compact(open)),
      closedMouthIsLineArtwork: Boolean(close && close.fillRatio <= quality.mouthCloseMaxFillRatio),
      noBrightMouthFill: Boolean(
        close && open
        && close.brightPixelRatio <= quality.mouthMaxBrightPixelRatio
        && open.brightPixelRatio <= quality.mouthMaxBrightPixelRatio
      ),
    },
    thresholds: {
      maximumVisiblePixels,
      maximumWidth,
      maximumHeight,
      closeMaximumFillRatio: quality.mouthCloseMaxFillRatio,
      maximumBrightPixelRatio: quality.mouthMaxBrightPixelRatio,
    },
  };
}

function expressionRegistration(layerDir, canvasWidth, tolerance) {
  const mouthOpenFile = findLayerFile(layerDir, ['mouth_open.png']);
  const mouthCloseFile = findLayerFile(layerDir, ['mouth_close.png', 'mouth.png']);
  const iridesFile = findLayerFile(layerDir, ['irides.png']);
  const eyeCloseFile = findLayerFile(layerDir, ['eye_close.png']);
  const mouthOpen = mouthOpenFile ? centroid(readPngRgba(mouthOpenFile)) : null;
  const mouthClose = mouthCloseFile ? centroid(readPngRgba(mouthCloseFile)) : null;
  const mouthError = distance(mouthOpen, mouthClose);
  const center = canvasWidth / 2;
  const irides = iridesFile ? readPngRgba(iridesFile) : null;
  const eyeClose = eyeCloseFile ? readPngRgba(eyeCloseFile) : null;
  const irisLeft = irides ? centroid(irides, (x) => x < center) : null;
  const irisRight = irides ? centroid(irides, (x) => x >= center) : null;
  const closeLeft = eyeClose ? centroid(eyeClose, (x) => x < center) : null;
  const closeRight = eyeClose ? centroid(eyeClose, (x) => x >= center) : null;
  const eyeLeftXError = irisLeft && closeLeft ? Math.abs(irisLeft.x - closeLeft.x) : Number.POSITIVE_INFINITY;
  const eyeRightXError = irisRight && closeRight ? Math.abs(irisRight.x - closeRight.x) : Number.POSITIVE_INFINITY;
  const eyeLeftYError = irisLeft && closeLeft ? Math.abs(irisLeft.y - closeLeft.y) : Number.POSITIVE_INFINITY;
  const eyeRightYError = irisRight && closeRight ? Math.abs(irisRight.y - closeRight.y) : Number.POSITIVE_INFINITY;
  return {
    present: { mouthOpen: Boolean(mouthOpen), mouthClose: Boolean(mouthClose), eyeCloseLeft: Boolean(closeLeft), eyeCloseRight: Boolean(closeRight) },
    errorsPx: {
      mouth: Number.isFinite(mouthError) ? Number(mouthError.toFixed(3)) : null,
      eyeLeftX: Number.isFinite(eyeLeftXError) ? Number(eyeLeftXError.toFixed(3)) : null,
      eyeRightX: Number.isFinite(eyeRightXError) ? Number(eyeRightXError.toFixed(3)) : null,
      eyeLeftY: Number.isFinite(eyeLeftYError) ? Number(eyeLeftYError.toFixed(3)) : null,
      eyeRightY: Number.isFinite(eyeRightYError) ? Number(eyeRightYError.toFixed(3)) : null,
    },
    checks: {
      mouthWithinTolerance: Number.isFinite(mouthError) && mouthError <= tolerance,
      eyesHorizontallyRegistered: eyeLeftXError <= tolerance && eyeRightXError <= tolerance,
      eyesVerticallyPlausible: eyeLeftYError <= tolerance * 4 && eyeRightYError <= tolerance * 4,
    },
    thresholds: { mouthDistance: tolerance, eyeHorizontal: tolerance, eyeVertical: tolerance * 4 },
  };
}

export function runQa({ psdFile, layerDir, buildReportFile, reportFile }) {
  const defaults = loadDefaults();
  const build = readJson(buildReportFile);
  const psd = inspectPsd(psdFile);
  const names = psd.layers.map((layer) => layer.name);
  const positions = new Map(names.map((name, index) => [name, index]));
  const required = ['face', 'eyewhite', 'irides', 'mouth_close'];
  const before = (back, front) => !positions.has(back) || !positions.has(front) || positions.get(back) < positions.get(front);
  const visible = psd.layers.every((layer) => {
    if (!layer.imageData) return false;
    for (let index = 3; index < layer.imageData.data.length; index += 4) if (layer.imageData.data[index] > defaults.quality.alphaThreshold) return true;
    return false;
  });
  const registration = expressionRegistration(layerDir, psd.width, defaults.quality.registrationTolerancePixels);
  const mouthArtwork = mouthArtworkQuality(layerDir, psd.width, psd.height, defaults.quality);
  const checks = {
    requiredLayers: required.every((name) => positions.has(name)),
    uniqueLayerNames: new Set(names).size === names.length,
    visibleLayerPixels: visible,
    armsBehindTopwear: before('handwear', 'topwear'),
    bodyBehindNeck: before('topwear', 'neck') && before('handwear', 'neck'),
    neckBehindFace: before('neck', 'face'),
    facePartsInFront: ['eyewhite', 'irides', 'eyelash', 'eyebrow', 'mouth_close', 'mouth_open', 'eye_close'].every((name) => before('face', name)),
    frontHairInFront: ['face', 'eyewhite', 'irides', 'mouth_close', 'eye_close'].every((name) => before(name, 'front hair')),
    productionExpressions: build.missingProduction.length === 0 && build.placeholders.length === 0 && (build.previewExpressions || []).length === 0,
    expressionRegistration: Object.values(registration.checks).every(Boolean),
    expressionArtwork: Object.values(mouthArtwork.checks).every(Boolean),
  };
  const blockingChecks = Object.fromEntries(Object.entries(checks).filter(([name]) => !['productionExpressions', 'expressionRegistration', 'expressionArtwork'].includes(name)));
  const structuralPass = Object.values(blockingChecks).every(Boolean);
  const productionReady = structuralPass && checks.productionExpressions && checks.expressionRegistration && checks.expressionArtwork;
  const report = {
    schemaVersion: 1,
    psd: relativeProjectPath(psdFile),
    canvas: [psd.width, psd.height],
    layerOrder: names,
    checks,
    structuralPass,
    productionReady,
    previewExpressions: build.previewExpressions || [],
    registration,
    mouthArtwork,
    limitations: [
      'Production readiness here covers PSD structure and expression registration, not deformation quality in a particular renderer.',
      'Paper-slip, hair physics, seams, and motion continuity are checked separately by `still2rig-psd motion-qa`, which records the built-in preview renderer against configs/motion-qa-contract.json.',
    ],
  };
  writeJson(reportFile, report);
  return report;
}
