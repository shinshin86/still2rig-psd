import fs from 'node:fs';
import path from 'node:path';
import { expressions } from './expressions.mjs';
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

const mouthDefinition = expressions.find(item => item.registration === 'mouth');
const eyeDefinition = expressions.find(item => item.registration === 'eyes');
const mouthReference = expressions.find(item => item.name === mouthDefinition.editableLayers[0]);

function overlayExpressionQuality(layerDir, definition, quality) {
  const image = readPngRgba(findLayerFile(layerDir,definition.sources));
  const art = artworkStats(image,8);
  const face = artworkStats(readPngRgba(findLayerFile(layerDir,['face.png'])),8);
  const eyes = ['eyewhite.png','irides.png','eyelash.png'].map(name=>findLayerFile(layerDir,[name])).filter(Boolean).map(file=>artworkStats(readPngRgba(file),16).bbox).filter(Boolean);
  const eye = {bbox:[Math.min(...eyes.map(b=>b[0])),Math.min(...eyes.map(b=>b[1])),Math.max(...eyes.map(b=>b[2])),Math.max(...eyes.map(b=>b[3]))]};
  const [x0,,x1] = face.bbox, width=x1-x0;
  const top=eye.bbox[1],height=eye.bbox[3]-top;
  const region = definition.mask.region;
  const bounds = region==='tears' ? [eye.bbox[0],eye.bbox[3]-2,eye.bbox[2],eye.bbox[3]+(face.bbox[3]-face.bbox[1])*.22+2]
    : region==='temple' ? [x0+width*.86-2,top-height*.35-2,x1+width*.06+2,top+height*.9+2]
    : [x0+width*.63-2,top-height*1.9-2,x0+width*.90+2,top-height*.85+2];
  let transparent=0,warm=0,solid=0;
  for(let i=0;i<image.data.length;i+=4){const [r,g,b,a]=image.data.subarray(i,i+4);if(!a)transparent++;if(a>=128){solid++;if(r-g>10&&g-b>8&&r<Math.max(1,g)*2)warm++;}}
  return { artwork:art, allowedBounds:bounds, checks:{ artworkPresent:art.visiblePixels>=8,
    transparentBackground:transparent/(image.width*image.height)>=.9,
    overlayWithinRegion:Boolean(art.bbox)&&art.bbox[0]>=bounds[0]&&art.bbox[1]>=bounds[1]&&art.bbox[2]<=bounds[2]&&art.bbox[3]<=bounds[3],
    noSkinOrHairColor:warm/Math.max(1,solid)<.03 } };
}

function mouthArtworkQuality(layerDir, canvasWidth, canvasHeight, quality) {
  const mouthOpenFile = findLayerFile(layerDir, mouthDefinition.sources);
  const mouthCloseFile = findLayerFile(layerDir, mouthReference.sources);
  const open = mouthOpenFile ? artworkStats(readPngRgba(mouthOpenFile), quality.alphaThreshold) : null;
  const close = mouthCloseFile ? artworkStats(readPngRgba(mouthCloseFile), quality.alphaThreshold) : null;
  const faceFile = findLayerFile(layerDir, ['face.png']);
  const face = faceFile ? artworkStats(readPngRgba(faceFile), quality.alphaThreshold) : null;
  const faceWidth = face?.bbox ? face.bbox[2] - face.bbox[0] : 0;
  const faceHeight = face?.bbox ? face.bbox[3] - face.bbox[1] : 0;
  // A lip line is shallow/sparse (16% x 3%, 0.15% area); an opening can
  // be taller/filled (18% x 10%, 1.2% area). Canvas padding cannot change
  // these limits. Floors retain useful checks on tiny synthetic previews.
  const limits = (state) => ({
    maximumVisiblePixels: Math.max(quality.mouthMaxVisiblePixelsFloor, Math.round(faceWidth * faceHeight * quality[`mouth${state}MaxFacePixelRatio`])),
    maximumWidth: Math.max(quality.mouthMaxWidthFloor, Math.round(faceWidth * quality[`mouth${state}MaxFaceWidthRatio`])),
    maximumHeight: Math.max(quality.mouthMaxHeightFloor, Math.round(faceHeight * quality[`mouth${state}MaxFaceHeightRatio`])),
  });
  const closeLimits = limits('Close');
  const openLimits = limits('Open');
  const compact = (stats, cap) => face?.bbox && stats?.bbox
    && stats.visiblePixels <= cap.maximumVisiblePixels
    && stats.bbox[2] - stats.bbox[0] <= cap.maximumWidth
    && stats.bbox[3] - stats.bbox[1] <= cap.maximumHeight;
  return {
    close,
    open,
    checks: {
      compactCloseMouth: Boolean(compact(close, closeLimits)),
      compactOpenMouth: Boolean(compact(open, openLimits)),
      closedMouthIsLineArtwork: Boolean(close && close.fillRatio <= quality.mouthCloseMaxFillRatio),
      noBrightMouthFill: Boolean(
        close && open
        && close.brightPixelRatio <= quality.mouthMaxBrightPixelRatio
        && open.brightPixelRatio <= quality.mouthMaxBrightPixelRatio
      ),
    },
    thresholds: {
      faceBox: face?.bbox || null,
      close: closeLimits,
      open: openLimits,
      closeMaximumFillRatio: quality.mouthCloseMaxFillRatio,
      maximumBrightPixelRatio: quality.mouthMaxBrightPixelRatio,
    },
  };
}

function expressionRegistration(layerDir, canvasWidth, tolerance, mouthTarget = mouthDefinition, eyeTarget = eyeDefinition) {
  const mouthOpenFile = findLayerFile(layerDir, mouthTarget.sources);
  const reference = expressions.find(item => item.name === mouthTarget.editableLayers[0]);
  const mouthCloseFile = findLayerFile(layerDir, reference.sources);
  const iridesFile = findLayerFile(layerDir, ['irides.png']);
  const eyeCloseFile = findLayerFile(layerDir, eyeTarget.sources);
  const mouthOpen = mouthOpenFile ? centroid(readPngRgba(mouthOpenFile)) : null;
  const mouthClose = mouthCloseFile ? centroid(readPngRgba(mouthCloseFile)) : null;
  const mouthError = distance(mouthOpen, mouthClose);
  const center = canvasWidth / 2;
  const irides = iridesFile ? readPngRgba(iridesFile) : null;
  const eyeOutline = ['eyelash.png', 'eyewhite.png'].map((name) => findLayerFile(layerDir, [name]))
    .filter(Boolean).map((file) => readPngRgba(file));
  const union = eyeOutline.length ? { ...eyeOutline[0], data: new Uint8ClampedArray(eyeOutline[0].data.length) } : null;
  for (const image of eyeOutline) {
    for (let offset = 3; offset < image.data.length; offset += 4) union.data[offset] = Math.max(union.data[offset], image.data[offset]);
  }
  const eyeClose = eyeCloseFile ? readPngRgba(eyeCloseFile) : null;
  const outlineLeft = union ? centroid(union, (x) => x < center) : null;
  const outlineRight = union ? centroid(union, (x) => x >= center) : null;
  const irisLeft = outlineLeft || (irides ? centroid(irides, (x) => x < center) : null);
  const irisRight = outlineRight || (irides ? centroid(irides, (x) => x >= center) : null);
  const closeLeft = eyeClose ? centroid(eyeClose, (x) => x < center) : null;
  const closeRight = eyeClose ? centroid(eyeClose, (x) => x >= center) : null;
  const eyeLeftXError = irisLeft && closeLeft ? Math.abs(irisLeft.x - closeLeft.x) : Number.POSITIVE_INFINITY;
  const eyeRightXError = irisRight && closeRight ? Math.abs(irisRight.x - closeRight.x) : Number.POSITIVE_INFINITY;
  const eyeLeftYError = irisLeft && closeLeft ? Math.abs(irisLeft.y - closeLeft.y) : Number.POSITIVE_INFINITY;
  const eyeRightYError = irisRight && closeRight ? Math.abs(irisRight.y - closeRight.y) : Number.POSITIVE_INFINITY;
  return {
    eyeReference: { left: outlineLeft ? 'eyelash ∪ eyewhite' : 'irides', right: outlineRight ? 'eyelash ∪ eyewhite' : 'irides' },
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

function softExpressionQuality(layerDir, definition, quality) {
  const file = findLayerFile(layerDir, definition.sources);
  const image = readPngRgba(file);
  const face = readPngRgba(findLayerFile(layerDir, ['face.png']));
  const features = [...['eyewhite.png', 'irides.png', 'eyelash.png'].map(name => findLayerFile(layerDir, [name])), findLayerFile(layerDir, mouthReference.sources)]
    .filter(Boolean).map(readPngRgba);
  let pixels = 0, outside = 0, overlap = 0, maximum = 0;
  for (let i = 3; i < image.data.length; i += 4) {
    const alpha = image.data[i];
    if (!alpha) continue;
    pixels++;
    maximum = Math.max(maximum, alpha);
    if (face.data[i] <= quality.alphaThreshold) outside++;
    if (features.some(feature => feature.data[i] > quality.alphaThreshold)) overlap++;
  }
  return {
    checks: { insideFace: outside === 0, avoidsEyesAndMouth: pixels > 0 && overlap / pixels <= quality.softExpressionMaximumFeatureOverlap,
      opacityWithinLimit: maximum <= Math.round(quality.softExpressionMaximumAlpha * 255) },
    metrics: { visiblePixels: pixels, outsideFacePixels: outside, featureOverlapPixels: overlap, maximumAlpha: maximum / 255 },
    thresholds: { maximumAlpha: quality.softExpressionMaximumAlpha, maximumFeatureOverlap: quality.softExpressionMaximumFeatureOverlap },
  };
}

export function runQa({ psdFile, layerDir, buildReportFile, reportFile }) {
  const defaults = loadDefaults();
  const build = readJson(buildReportFile);
  const psd = inspectPsd(psdFile);
  const names = psd.layers.map((layer) => layer.name);
  const positions = new Map(names.map((name, index) => [name, index]));
  const required = ['face', 'eyewhite', 'irides', mouthReference.name];
  const before = (back, front) => !positions.has(back) || !positions.has(front) || positions.get(back) < positions.get(front);
  const visible = psd.layers.every((layer) => {
    if (!layer.imageData) return false;
    const threshold = expressions.some(item => item.name === layer.name && item.extraction === 'soft') ? 0 : defaults.quality.alphaThreshold;
    for (let index = 3; index < layer.imageData.data.length; index += 4) if (layer.imageData.data[index] > threshold) return true;
    return false;
  });
  const registration = expressionRegistration(layerDir, psd.width, defaults.quality.registrationTolerancePixels);
  for (const definition of expressions) {
    if (definition.registration === 'none' || definition === mouthDefinition || definition === eyeDefinition
        || !findLayerFile(layerDir, definition.sources)) continue;
    const isMouth = definition.registration === 'mouth';
    const detail = definition.extraction === 'overlay' ? overlayExpressionQuality(layerDir,definition,defaults.quality)
      : definition.registration === 'face' ? softExpressionQuality(layerDir, definition, defaults.quality)
      : expressionRegistration(layerDir, psd.width, defaults.quality.registrationTolerancePixels,
        isMouth ? definition : mouthDefinition, isMouth ? eyeDefinition : definition);
    const checks = definition.registration === 'face' ? { ...detail.checks }
      : Object.fromEntries(Object.entries(detail.checks).filter(([name]) => isMouth ? name.startsWith('mouth') : name.startsWith('eyes')));
    checks.inFrontOfFace = before('face', definition.name);
    checks.behindFrontHair = !definition.checkFrontHair || before(definition.name, 'front hair');
    if (definition.extraction === 'overlay' && !definition.checkFrontHair) checks.inFrontOfHair = before('front hair',definition.name);
    registration.additionalExpressions ??= {};
    registration.additionalExpressions[definition.name] = { ...detail, checks, pass: Object.values(checks).every(Boolean) };
    if (definition.requiredForProduction) registration.checks[`${definition.name}Registered`] = Object.values(checks).every(Boolean);
  }
  const mouthArtwork = mouthArtworkQuality(layerDir, psd.width, psd.height, defaults.quality);
  const checks = {
    requiredLayers: required.every((name) => positions.has(name)),
    uniqueLayerNames: new Set(names).size === names.length,
    visibleLayerPixels: visible,
    armsBehindTopwear: before('handwear', 'topwear'),
    bodyBehindNeck: before('topwear', 'neck') && before('handwear', 'neck'),
    neckBehindFace: before('neck', 'face'),
    facePartsInFront: ['eyewhite', 'irides', 'eyelash', 'eyebrow', ...expressions.filter(item => item.requiredForProduction || item.prompt === null).map(item => item.name)].every((name) => before('face', name)),
    frontHairInFront: ['face', 'eyewhite', 'irides', ...expressions.filter(item => item.checkFrontHair && (item.requiredForProduction || item.prompt === null)).map(item => item.name)].every((name) => before(name, 'front hair')),
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
