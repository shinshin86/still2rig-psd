// Frame metrics for the renderer motion QA contract (configs/motion-qa-contract.json).
//
// Frames are { width, height, data } RGBA buffers captured from the preview
// renderer at 1:1 model scale, so PSD/anchor coordinates are frame pixels.
// MAE values are percentages of full scale (0-100), pixel counts are raw.

import fs from 'node:fs';
import path from 'node:path';
import { PROJECT_ROOT } from './utils.mjs';

export const CHANGE_THRESHOLD = 24;
export const SEAM_COLOR = [0, 255, 0];
export const SEAM_TOLERANCE = 40;
export const SILHOUETTE_EROSION_PX = 8;
export const TRACK_RADIUS_PX = 36;
export const HAIR_SEAM_MARGIN_PX = 16;
export const FRAME_MARGIN_PX = 4;

export function loadMotionContract() {
  return JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, 'configs', 'motion-qa-contract.json'), 'utf8'));
}

export function motionLayerPreflight(layers) {
  const missingLayers = ['face', 'eyewhite', 'irides', 'mouth_close']
    .filter((name) => !layers.some((layer) => layer.name === name && layer.imageData?.data?.some((value, index) => index % 4 === 3 && value > 16)));
  return {
    pass: missingLayers.length === 0,
    missingLayers,
    checks: { requiredFeatureLayers: missingLayers.length === 0 },
    errors: missingLayers.length ? [`Motion QA needs visible layers: ${missingLayers.join(', ')}.`] : [],
    metrics: {},
  };
}

export function padBox(box, pad, width, height, extraTop = 0) {
  return {
    x0: Math.max(0, Math.floor(box.x0 - pad)),
    y0: Math.max(0, Math.floor(box.y0 - pad - extraTop)),
    x1: Math.min(width, Math.ceil(box.x1 + pad)),
    y1: Math.min(height, Math.ceil(box.y1 + pad)),
  };
}

export function boxMask(width, height, boxes) {
  const mask = new Uint8Array(width * height);
  for (const box of boxes) {
    for (let y = box.y0; y < box.y1; y += 1) mask.fill(1, y * width + box.x0, y * width + box.x1);
  }
  return mask;
}

function pixelDelta(a, b, index) {
  const offset = index * 4;
  return Math.max(
    Math.abs(a.data[offset] - b.data[offset]),
    Math.abs(a.data[offset + 1] - b.data[offset + 1]),
    Math.abs(a.data[offset + 2] - b.data[offset + 2]),
  );
}

/** Count pixels inside `mask` (all pixels when null) whose max channel delta exceeds the threshold. */
export function changedPixels(a, b, mask = null, threshold = CHANGE_THRESHOLD) {
  let count = 0;
  const total = a.width * a.height;
  for (let index = 0; index < total; index += 1) {
    if (mask && !mask[index]) continue;
    if (pixelDelta(a, b, index) > threshold) count += 1;
  }
  return count;
}

/** Mean absolute RGB error as a percentage of full scale over pixels where `mask` is 1. */
export function maePercent(a, b, mask = null) {
  let sum = 0;
  let pixels = 0;
  const total = a.width * a.height;
  for (let index = 0; index < total; index += 1) {
    if (mask && !mask[index]) continue;
    const offset = index * 4;
    sum += Math.abs(a.data[offset] - b.data[offset])
      + Math.abs(a.data[offset + 1] - b.data[offset + 1])
      + Math.abs(a.data[offset + 2] - b.data[offset + 2]);
    pixels += 1;
  }
  return pixels ? (sum / (pixels * 3 * 255)) * 100 : 0;
}

export function invertMask(mask) {
  return mask.map((value) => (value ? 0 : 1));
}

function isSeamColor(frame, index) {
  const offset = index * 4;
  return Math.abs(frame.data[offset] - SEAM_COLOR[0]) <= SEAM_TOLERANCE
    && Math.abs(frame.data[offset + 1] - SEAM_COLOR[1]) <= SEAM_TOLERANCE
    && Math.abs(frame.data[offset + 2] - SEAM_COLOR[2]) <= SEAM_TOLERANCE;
}

/** Pixels that are not the solid QA background. */
export function silhouette(frame) {
  const total = frame.width * frame.height;
  const mask = new Uint8Array(total);
  for (let index = 0; index < total; index += 1) mask[index] = isSeamColor(frame, index) ? 0 : 1;
  return mask;
}

/** Square erosion by `radius`, done as two separable passes. */
export function erode(mask, width, height, radius) {
  const horizontal = new Uint8Array(mask.length);
  for (let y = 0; y < height; y += 1) {
    const row = y * width;
    const lastZero = new Float64Array(width);
    let previousZero = -Infinity;
    for (let x = 0; x < width; x += 1) {
      if (!mask[row + x]) previousZero = x;
      lastZero[x] = previousZero;
    }
    let nextZero = Infinity;
    for (let x = width - 1; x >= 0; x -= 1) {
      if (!mask[row + x]) nextZero = x;
      horizontal[row + x] = Math.min(x - lastZero[x], nextZero - x) > radius ? 1 : 0;
    }
  }
  const result = new Uint8Array(mask.length);
  for (let x = 0; x < width; x += 1) {
    let previousZero = -Infinity;
    const lastZero = new Float64Array(height);
    for (let y = 0; y < height; y += 1) {
      if (!horizontal[y * width + x]) previousZero = y;
      lastZero[y] = previousZero;
    }
    let nextZero = Infinity;
    for (let y = height - 1; y >= 0; y -= 1) {
      if (!horizontal[y * width + x]) nextZero = y;
      result[y * width + x] = Math.min(y - lastZero[y], nextZero - y) > radius ? 1 : 0;
    }
  }
  return result;
}

/**
 * Background-colored pixels that open inside the neutral interior as enclosed
 * holes. Background connected to the outside (hair tips swinging out, the body
 * bobbing at the canvas edge) is expected motion, not a seam.
 */
export function seamPixels(frame, interior) {
  const { width, height } = frame;
  const total = width * height;
  const background = new Uint8Array(total);
  for (let index = 0; index < total; index += 1) background[index] = isSeamColor(frame, index) ? 1 : 0;
  const outside = new Uint8Array(total);
  const stack = [];
  for (let index = 0; index < total; index += 1) {
    const x = index % width;
    const y = (index - x) / width;
    // The canvas element draws a thin frame; treat its inner margin as outside.
    const onBorder = x < FRAME_MARGIN_PX || y < FRAME_MARGIN_PX
      || x >= width - FRAME_MARGIN_PX || y >= height - FRAME_MARGIN_PX;
    if (background[index] && (!interior[index] || onBorder)) {
      outside[index] = 1;
      stack.push(index);
    }
  }
  while (stack.length) {
    const index = stack.pop();
    const x = index % width;
    for (const next of [index - 1, index + 1, index - width, index + width]) {
      if (next < 0 || next >= total || outside[next] || !background[next]) continue;
      if ((next === index - 1 && x === 0) || (next === index + 1 && x === width - 1)) continue;
      outside[next] = 1;
      stack.push(next);
    }
  }
  let count = 0;
  for (let index = 0; index < total; index += 1) {
    if (interior[index] && background[index] && !outside[index]) count += 1;
  }
  return count;
}

function luminance(frame) {
  const total = frame.width * frame.height;
  const out = new Float32Array(total);
  for (let index = 0; index < total; index += 1) {
    const offset = index * 4;
    out[index] = 0.299 * frame.data[offset] + 0.587 * frame.data[offset + 1] + 0.114 * frame.data[offset + 2];
  }
  return out;
}

function patchCost(refLum, frameLum, width, box, dx, dy, step) {
  let sum = 0;
  let count = 0;
  for (let y = box.y0; y < box.y1; y += step) {
    const fy = y + dy;
    for (let x = box.x0; x < box.x1; x += step) {
      const diff = refLum[y * width + x] - frameLum[fy * width + x + dx];
      sum += diff * diff;
      count += 1;
    }
  }
  return sum / count;
}

/**
 * Find where the reference patch `box` moved to in `frame` (SSD on luminance,
 * coarse-to-fine). Returns the displacement in pixels.
 */
export function trackPatch(reference, frame, box, radius = TRACK_RADIUS_PX, cache = new Map()) {
  const width = reference.width;
  const height = reference.height;
  const refLum = cache.get(reference) || luminance(reference);
  cache.set(reference, refLum);
  const frameLum = cache.get(frame) || luminance(frame);
  cache.set(frame, frameLum);
  const inBounds = (dx, dy) => box.x0 + dx >= 0 && box.x1 + dx <= width && box.y0 + dy >= 0 && box.y1 + dy <= height;
  let best = { dx: 0, dy: 0, cost: Infinity };
  for (let dy = -radius; dy <= radius; dy += 3) {
    for (let dx = -radius; dx <= radius; dx += 3) {
      if (!inBounds(dx, dy)) continue;
      const cost = patchCost(refLum, frameLum, width, box, dx, dy, 2);
      if (cost < best.cost) best = { dx, dy, cost };
    }
  }
  // Refine at full resolution; coarse costs used a sparser sample, so restart.
  const coarse = best;
  best = { dx: coarse.dx, dy: coarse.dy, cost: Infinity };
  for (let dy = coarse.dy - 3; dy <= coarse.dy + 3; dy += 1) {
    for (let dx = coarse.dx - 3; dx <= coarse.dx + 3; dx += 1) {
      if (!inBounds(dx, dy)) continue;
      const cost = patchCost(refLum, frameLum, width, box, dx, dy, 1);
      if (cost < best.cost) best = { dx, dy, cost };
    }
  }
  return best;
}

function center(box) {
  return { x: (box.x0 + box.x1) / 2, y: (box.y0 + box.y1) / 2 };
}

/**
 * Relative feature residuals of one frame against the reference layout.
 * Eye distance is invariant to head translation/rotation; the mouth is
 * predicted from the eyes with a similarity transform.
 */
export function featureResiduals(referenceFeatures, frameFeatures) {
  const { eyeL: rL, eyeR: rR, mouth: rM } = referenceFeatures;
  const { eyeL: fL, eyeR: fR, mouth: fM } = frameFeatures;
  const refEye = { x: rR.x - rL.x, y: rR.y - rL.y };
  const frameEye = { x: fR.x - fL.x, y: fR.y - fL.y };
  const refDistance = Math.hypot(refEye.x, refEye.y);
  const frameDistance = Math.hypot(frameEye.x, frameEye.y);
  const eyeResidual = Math.abs(frameDistance - refDistance);
  const scale = frameDistance / refDistance;
  const angle = Math.atan2(frameEye.y, frameEye.x) - Math.atan2(refEye.y, refEye.x);
  const refMid = { x: (rL.x + rR.x) / 2, y: (rL.y + rR.y) / 2 };
  const frameMid = { x: (fL.x + fR.x) / 2, y: (fL.y + fR.y) / 2 };
  const vx = rM.x - refMid.x;
  const vy = rM.y - refMid.y;
  const predicted = {
    x: frameMid.x + scale * (vx * Math.cos(angle) - vy * Math.sin(angle)),
    y: frameMid.y + scale * (vx * Math.sin(angle) + vy * Math.cos(angle)),
  };
  return {
    leftRightEyePx: eyeResidual,
    mouthToEyesPx: Math.hypot(fM.x - predicted.x, fM.y - predicted.y),
  };
}

export function featureBoxes(anchors, width, height) {
  return {
    eyeL: padBox(anchors.eyeL, 4, width, height),
    eyeR: padBox(anchors.eyeR, 4, width, height),
    mouth: padBox(anchors.mouth, 10, width, height),
  };
}

function locateFeatures(reference, frame, boxes, cache) {
  const out = {};
  for (const [name, box] of Object.entries(boxes)) {
    const { dx, dy } = trackPatch(reference, frame, box, TRACK_RADIUS_PX, cache);
    const c = center(box);
    out[name] = { x: c.x + dx, y: c.y + dy };
  }
  return out;
}

function frameOf(capture, label) {
  const entry = capture.find((item) => item.label === label);
  if (!entry) throw new Error(`Missing capture frame: ${label}`);
  return entry.frame;
}

const round = (value, digits = 3) => Number(value.toFixed(digits));

/**
 * Evaluate captured frames against the contract.
 *
 * @param {object} input
 * @param {object} input.reference   { frame, anchors } neutral render of the reference PSD
 * @param {object} input.captures    { [captureName]: [{ label, frame }] }
 * @param {Uint8Array} input.hairTipMask  hair tip band in frame coordinates
 * @param {object} input.contract
 */
export function evaluateMotionQa({ reference, captures, hairTipMask, visibleHairMask = null, expressionMasks = {}, expressionSetRequired = false, contract }) {
  const { width, height } = reference.frame;
  const anchors = reference.anchors;
  const missingFeatures = ['eyeL', 'eyeR', 'mouth'].filter((name) => {
    const box = anchors?.[name];
    return !box || !['x0', 'y0', 'x1', 'y1'].every((key) => Number.isFinite(box[key]))
      || box.x1 <= box.x0 || box.y1 <= box.y0;
  });
  if (missingFeatures.length) {
    return { pass: false, missingFeatures, metrics: {}, checks: { requiredFeatureAnchors: false },
      errors: [`Motion QA cannot locate features: ${missingFeatures.join(', ')}.`] };
  }
  const t = contract.thresholds;
  const missingCaptures = contract.requiredCaptures.filter((name) => !captures[name]?.length);
  if (missingCaptures.length) {
    return { pass: false, missingCaptures, metrics: {}, checks: {} };
  }

  // Blink: eye region must change; everything outside eyes and brows must not.
  const blink = captures['blink-four-state'];
  const eyeOpen = frameOf(blink, 'eye-1.00');
  const eyeClosed = frameOf(blink, 'eye-0.00');
  const eyeRegions = [padBox(anchors.eyeL, 16, width, height), padBox(anchors.eyeR, 16, width, height)];
  const eyeAndBrow = boxMask(width, height, [
    padBox(anchors.eyeL, 16, width, height, 70),
    padBox(anchors.eyeR, 16, width, height, 70),
  ]);
  const eyeChanged = changedPixels(eyeOpen, eyeClosed, boxMask(width, height, eyeRegions));
  const nonEyeMae = maePercent(eyeOpen, eyeClosed, invertMask(eyeAndBrow));

  // Mouth: mouth region must change between closed and open.
  const mouth = captures['mouth-four-state'];
  const mouthRegion = boxMask(width, height, [padBox(anchors.mouth, 20, width, height)]);
  const mouthChanged = changedPixels(frameOf(mouth, 'mouth-0.00'), frameOf(mouth, 'mouth-1.00'), mouthRegion);
  const nonMouthMae = maePercent(frameOf(mouth, 'mouth-0.00'), frameOf(mouth, 'mouth-1.00'), invertMask(mouthRegion));

  // Hair physics only: hair tips move while fixed facial features stay put.
  const neutral = captures.neutral[0].frame;
  const featureMask = boxMask(width, height, [
    padBox(anchors.eyeL, 6, width, height),
    padBox(anchors.eyeR, 6, width, height),
    padBox(anchors.mouth, 10, width, height),
  ]);
  let tipTotal = 0;
  for (const value of hairTipMask) tipTotal += value;
  let hairTipChangeRatio = 0;
  let fixedFeatureMae = 0;
  for (const { frame } of captures['hair-physics-only']) {
    if (tipTotal) hairTipChangeRatio = Math.max(hairTipChangeRatio, changedPixels(neutral, frame, hairTipMask) / tipTotal);
    fixedFeatureMae = Math.max(fixedFeatureMae, maePercent(neutral, frame, featureMask));
  }

  // Feature layout stability against the reference registration.
  const cache = new Map();
  const boxes = featureBoxes(anchors, width, height);
  const referenceFeatures = locateFeatures(reference.frame, reference.frame, boxes, cache);
  let leftRightEyeResidual = 0;
  let mouthToEyesResidual = 0;
  const residualFrames = [];
  for (const name of ['neutral', 'hair-physics-only', 'full-body-idle', 'drag-inertia']) {
    for (const { label, frame } of captures[name]) {
      const residual = featureResiduals(referenceFeatures, locateFeatures(reference.frame, frame, boxes, cache));
      leftRightEyeResidual = Math.max(leftRightEyeResidual, residual.leftRightEyePx);
      mouthToEyesResidual = Math.max(mouthToEyesResidual, residual.mouthToEyesPx);
      residualFrames.push({ capture: name, label, ...Object.fromEntries(Object.entries(residual).map(([k, v]) => [k, round(v)])) });
    }
    for (const { frame } of captures[name]) cache.delete(frame);
  }

  // Seams: QA background showing through inside the neutral silhouette.
  const interior = erode(silhouette(neutral), width, height, SILHOUETTE_EROSION_PX);
  if (visibleHairMask) {
    const hairZone = dilate(visibleHairMask, width, height, HAIR_SEAM_MARGIN_PX);
    for (let index = 0; index < interior.length; index += 1) if (hairZone[index]) interior[index] = 0;
  }
  let unexpectedSeams = 0;
  const seamByCapture = {};
  for (const name of contract.requiredCaptures) {
    let worst = 0;
    for (const { frame } of captures[name]) worst = Math.max(worst, seamPixels(frame, interior));
    seamByCapture[name] = worst;
    unexpectedSeams = Math.max(unexpectedSeams, worst);
  }

  const metrics = {
    eyeChangedPixels: eyeChanged,
    nonEyeMaePercent: round(nonEyeMae, 4),
    mouthChangedPixels: mouthChanged,
    nonMouthMaePercent: round(nonMouthMae, 4),
    hairTipChangeRatio: round(hairTipChangeRatio, 5),
    fixedFeatureMaePercent: round(fixedFeatureMae, 4),
    leftRightEyeRelativeResidualPx: round(leftRightEyeResidual),
    mouthToEyesRelativeResidualPx: round(mouthToEyesResidual),
    unexpectedSeamPixels: unexpectedSeams,
  };
  const checks = {
    eyeChangedPixels: eyeChanged >= t.eyeChangedPixelsMinimum,
    nonEyeMae: nonEyeMae <= t.nonEyeMaeMaximum,
    mouthChangedPixels: mouthChanged >= t.mouthChangedPixelsMinimum,
    hairTipChangeRatio: hairTipChangeRatio >= t.hairTipChangeRatioMinimum,
    fixedFeatureMae: fixedFeatureMae <= t.fixedFeatureMaeMaximum,
    leftRightEyeRelativeResidual: leftRightEyeResidual <= t.leftRightEyeRelativeResidualPxMaximum,
    mouthToEyesRelativeResidual: mouthToEyesResidual <= t.mouthToEyesRelativeResidualPxMaximum,
    unexpectedSeamPixels: unexpectedSeams <= t.unexpectedSeamPixelsMaximum,
  };
  const expressions = evaluateExpressionCaptures(captures, expressionMasks);
  Object.assign(checks, expressions.checks);
  if (expressionSetRequired) Object.assign(checks, evaluateExpressionSetCaptures(captures, anchors));
  return {
    pass: Object.values(checks).every(Boolean),
    missingCaptures,
    metrics,
    checks,
    thresholds: t,
    details: { seamByCapture, residualFrames, hairTipPixels: tipTotal, expressions: expressions.metrics },
    units: {
      mae: 'percent of full RGB scale (0-100)',
      changedPixels: `pixels whose max channel delta exceeds ${CHANGE_THRESHOLD}`,
      seams: `enclosed holes of solid QA background inside the neutral silhouette eroded by ${SILHOUETTE_EROSION_PX}px, outside visible hair (+${HAIR_SEAM_MARGIN_PX}px), where hair motion may legitimately reveal the background`,
    },
  };
}

const HAIR_LAYERS = ['front hair', 'back hair'];

function layerAlphaMask(layer, width, height, alphaThreshold) {
  const mask = new Uint8Array(width * height);
  if (!layer?.imageData) return mask;
  const { data } = layer.imageData;
  const left = layer.left || 0;
  const top = layer.top || 0;
  const layerWidth = layer.imageData.width;
  for (let index = 0; index < layer.imageData.width * layer.imageData.height; index += 1) {
    if (data[index * 4 + 3] <= alphaThreshold) continue;
    const x = left + (index % layerWidth);
    const y = top + Math.floor(index / layerWidth);
    if (x >= 0 && y >= 0 && x < width && y < height) mask[y * width + x] = 1;
  }
  return mask;
}

/** Hair tip band: the lowest quarter of the hair layers' vertical extent. */
export function hairTipMaskFromLayers(layers, width, height, alphaThreshold = 16) {
  const hair = new Uint8Array(width * height);
  for (const layer of layers.filter((candidate) => HAIR_LAYERS.includes(candidate.name))) {
    layerAlphaMask(layer, width, height, alphaThreshold).forEach((value, index) => { if (value) hair[index] = 1; });
  }
  let top = height;
  let bottom = -1;
  for (let index = 0; index < hair.length; index += 1) {
    if (!hair[index]) continue;
    const y = Math.floor(index / width);
    top = Math.min(top, y);
    bottom = Math.max(bottom, y);
  }
  if (bottom < 0) return hair;
  const bandTop = top + Math.floor((bottom - top) * 0.75);
  hair.fill(0, 0, bandTop * width);
  return hair;
}

/**
 * Hair that is visible in the neutral pose: front hair, plus back hair not
 * covered by any other layer. Background opening here is hair motion.
 */
export function visibleHairMaskFromLayers(layers, width, height, alphaThreshold = 16) {
  const visible = new Uint8Array(width * height);
  const covered = new Uint8Array(width * height);
  for (const layer of layers) {
    if (HAIR_LAYERS.includes(layer.name)) continue;
    layerAlphaMask(layer, width, height, alphaThreshold).forEach((value, index) => { if (value) covered[index] = 1; });
  }
  const front = layerAlphaMask(layers.find((layer) => layer.name === 'front hair'), width, height, alphaThreshold);
  const back = layerAlphaMask(layers.find((layer) => layer.name === 'back hair'), width, height, alphaThreshold);
  for (let index = 0; index < visible.length; index += 1) {
    visible[index] = front[index] || (back[index] && !covered[index]) ? 1 : 0;
  }
  return visible;
}

export function dilate(mask, width, height, radius) {
  return invertMask(erode(invertMask(mask), width, height, radius));
}

/** Optional expression regions include a small sampling margin at native scale. */
export function expressionMasksFromLayers(layers, width, height, anchors) {
  const masks = {};
  if (layers.some(layer => layer.name === 'eye_smile' && layerAlphaMask(layer, width, height, 8).some(Boolean))) {
    masks['eye-smile'] = boxMask(width, height, [anchors.eyeL, anchors.eyeR]
      .map(box => padBox(box, 16, width, height)));
  }
  for (const name of ['tears','sweat','anger_mark']) {
    const alpha = layerAlphaMask(layers.find(layer=>layer.name===name),width,height,0);
    if(alpha.some(Boolean)) masks[name] = dilate(alpha,width,height,8);
  }
  for (const name of ['mouth_laugh','mouth_round']) {
    if (!layers.some(layer=>layer.name===name)) continue;
    const union=new Uint8Array(width*height);
    for(const layer of layers.filter(layer=>/^mouth_(close|open|laugh|round)$/.test(layer.name))) {
      layerAlphaMask(layer,width,height,8).forEach((a,i)=>{if(a)union[i]=1;});
    }
    masks[name]=dilate(union,width,height,16);
  }
  const blush = layerAlphaMask(layers.find(layer => layer.name === 'blush'), width, height, 0);
  if (blush.some(Boolean)) masks.blush = dilate(blush, width, height, 4);
  return masks;
}

/** Fail absent/stuck expressions and changes beyond their own art region. */
export function evaluateExpressionCaptures(captures, masks) {
  const checks = {};
  const metrics = {};
  for (const [name, mask] of Object.entries(masks)) {
    const frames = captures[name] || [];
    const before = frames.find(item => item.label === 'strength-0.00')?.frame;
    const after = frames.find(item => item.label === 'strength-1.00')?.frame;
    checks[`${name}Captured`] = Boolean(before && after);
    if (!before || !after) continue;
    // One RGB level detects subtle blush without the opaque-ink threshold.
    const changed = changedPixels(before, after, mask, 1);
    const nonRegion = maePercent(before, after, invertMask(mask));
    metrics[name] = { changedPixels: changed, nonRegionMaePercent: round(nonRegion, 4), changeThreshold: 1 };
    checks[`${name}Changed`] = changed > 0;
    checks[`${name}RegionStable`] = nonRegion <= 0.35;
    if (['tears','sweat','anger_mark','mouth_laugh','mouth_round'].includes(name)) {
      checks[`${name}ProgressionCaptured`] = Array.from({length:21},(_,i)=>(i/20).toFixed(2))
        .every(strength=>frames.some(item=>item.label===`strength-${strength}`));
      checks[`${name}BlinkCaptured`] = ['strength-1.00-blink-0.5','strength-1.00-blink-0']
        .every(label=>frames.some(item=>item.label===label));
    }
    if (name === 'eye-smile') {
      const blink = frames.find(item => item.label === 'strength-1.00-blink')?.frame;
      const halfBlink = frames.find(item => item.label === 'strength-1.00-blink-half')?.frame;
      checks.smileProgressionCaptured = [...Array.from({ length: 21 }, (_, i) => (i / 20).toFixed(2)), '0.48', '0.52'].every(strength =>
        frames.some(item => item.label === `strength-${strength}`));
      const morphChanges = Object.fromEntries(['0.50', '0.75', '0.95'].map(strength => {
        const frame = frames.find(item => item.label === `strength-${strength}`)?.frame;
        return [strength, frame ? changedPixels(after, frame, mask, 1) : null];
      }));
      metrics[name].morphChangedPixels = morphChanges;
      checks.smileMorphProgresses = Object.values(morphChanges).every(count => count !== null && count > 0);
      checks.smileBlinkStable = Boolean(blink && halfBlink) && changedPixels(after, blink, null, 1) === 0
        && changedPixels(after, halfBlink, null, 1) === 0;
    }
  }
  return { checks, metrics };
}

/** Coverage and unilateral-eye checks; naturalness still needs visual review. */
export function evaluateExpressionSetCaptures(captures, anchors) {
  const has = (name, labels) => labels.every(label => (captures[name] || []).some(item => item.label === label));
  const parts = ['browWorry','browAngry','browFlat','upperLid','eyeWide','eyeNarrow','eyeWinkL','eyeWinkR','eyeSmileL','eyeSmileR','lidTilt-inward','lidTilt-outward','mouth-up','mouth-down','tears','sweat','angerMark','mouthLaugh','mouthRound'];
  const presets = ['neutral','joy','shy','angry','sad','surprised','flustered','unamused','wink'];
  const pairs = ['neutral-joy','joy-neutral','joy-angry','sad-surprised','wink-joy','unamused-surprised'];
  const neutral = captures['preset-neutral']?.find(item => item.label === 'eye-1.00')?.frame;
  const wink = captures['preset-wink']?.find(item => item.label === 'eye-1.00')?.frame;
  const mask = neutral && anchors.eyeR ? boxMask(neutral.width, neutral.height, [anchors.eyeR]) : null;
  return {
    expressionPartsCaptured: parts.every(id=>has(`part-${id}`,['strength-0.00','strength-0.50','strength-1.00'])),
    expressionPresetsCaptured: presets.every(id=>has(`preset-${id}`,['eye-1.00','eye-0.50','eye-0.00'])),
    expressionTransitionsCaptured: pairs.every(id=>has(`transition-${id}`,['progress-0.00','progress-0.25','progress-0.50','progress-0.75','progress-1.00'])),
    winkKeepsOtherEye: Boolean(neutral && wink && mask) && changedPixels(neutral, wink, mask, 1) === 0,
  };
}
