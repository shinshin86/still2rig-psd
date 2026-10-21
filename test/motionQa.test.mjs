import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  SEAM_COLOR,
  changedPixels,
  evaluateMotionQa,
  evaluateExpressionCaptures,
  erode,
  featureResiduals,
  loadMotionContract,
  motionLayerPreflight,
  seamPixels,
  silhouette,
  trackPatch,
} from '../src/motionQa.mjs';

function frame(width, height, fill = [255, 255, 255]) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let index = 0; index < width * height; index += 1) data.set([...fill, 255], index * 4);
  return { width, height, data };
}

function paint(target, x0, y0, x1, y1, color) {
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) target.data.set([...color, 255], (y * target.width + x) * 4);
  }
}

test('tracks a textured patch to its shifted position', () => {
  const reference = frame(120, 120);
  paint(reference, 40, 40, 60, 52, [30, 30, 30]);
  paint(reference, 46, 44, 52, 48, [200, 60, 60]);
  const moved = frame(120, 120);
  paint(moved, 47, 35, 67, 47, [30, 30, 30]);
  paint(moved, 53, 39, 59, 43, [200, 60, 60]);
  const result = trackPatch(reference, moved, { x0: 36, y0: 36, x1: 64, y1: 56 }, 20);
  assert.deepEqual([result.dx, result.dy], [7, -5]);
});

test('missing eye anchors and missing eye layers produce explicit failed checks', () => {
  const result = evaluateMotionQa({ reference: { frame: frame(20, 20), anchors: {} },
    captures: {}, hairTipMask: new Uint8Array(400), contract: loadMotionContract() });
  assert.equal(result.pass, false);
  assert.equal(result.checks.requiredFeatureAnchors, false);
  assert.ok(result.errors[0].includes('eyeL'));
  const missing = motionLayerPreflight([]);
  assert.equal(missing.pass, false);
  assert.ok(missing.missingLayers.includes('eyewhite'));
});

test('feature residuals ignore rigid head motion but catch a shifted mouth', () => {
  const reference = { eyeL: { x: 100, y: 100 }, eyeR: { x: 200, y: 100 }, mouth: { x: 150, y: 180 } };
  const angle = 0.08;
  const rotate = ({ x, y }) => ({
    x: 150 + (x - 150) * Math.cos(angle) - (y - 120) * Math.sin(angle) + 6,
    y: 120 + (x - 150) * Math.sin(angle) + (y - 120) * Math.cos(angle) - 3,
  });
  const rigid = featureResiduals(reference, {
    eyeL: rotate(reference.eyeL),
    eyeR: rotate(reference.eyeR),
    mouth: rotate(reference.mouth),
  });
  assert.ok(rigid.leftRightEyePx < 1e-6);
  assert.ok(rigid.mouthToEyesPx < 1e-6);
  const shifted = featureResiduals(reference, { ...reference, mouth: { x: 174, y: 180 } });
  assert.equal(Math.round(shifted.mouthToEyesPx), 24);
});

test('counts QA background pixels that open inside the eroded silhouette', () => {
  const neutral = frame(60, 60, SEAM_COLOR);
  paint(neutral, 10, 10, 50, 50, [240, 200, 180]);
  const interior = erode(silhouette(neutral), 60, 60, 3);
  const moving = frame(60, 60, SEAM_COLOR);
  paint(moving, 10, 10, 50, 50, [240, 200, 180]);
  paint(moving, 29, 20, 31, 30, SEAM_COLOR);
  assert.equal(seamPixels(moving, interior), 20);
  // Background reaching in from outside (edge motion) is not an enclosed seam.
  paint(moving, 10, 40, 30, 42, SEAM_COLOR);
  assert.equal(seamPixels(moving, interior), 20);
});

test('erodes a square mask by the requested radius', () => {
  const mask = new Uint8Array(20 * 20);
  for (let y = 5; y < 15; y += 1) mask.fill(1, y * 20 + 5, y * 20 + 15);
  const eroded = erode(mask, 20, 20, 2);
  assert.equal(eroded.reduce((sum, value) => sum + value, 0), 6 * 6);
  assert.equal(changedPixels(frame(4, 4), frame(4, 4, [0, 0, 0])), 16);
});

test('the motion contract lists every capture the adapter records', () => {
  const contract = loadMotionContract();
  assert.deepEqual(contract.requiredCaptures, [
    'neutral',
    'blink-four-state',
    'mouth-four-state',
    'lip-sync-continuous',
    'hair-physics-only',
    'full-body-idle',
    'drag-inertia',
  ]);
});

test('optional expression QA detects faint artwork, missing captures, frozen frames and leakage', () => {
  const neutral = frame(12, 12, [200, 170, 160]);
  const blush = frame(12, 12, [200, 170, 160]);
  paint(blush, 4, 4, 8, 8, [202, 168, 158]);
  const mask = new Uint8Array(144);
  for (let y = 4; y < 8; y += 1) mask.fill(1, y * 12 + 4, y * 12 + 8);
  const capture = after => ({ blush: [{ label: 'strength-0.00', frame: neutral }, { label: 'strength-1.00', frame: after }] });
  const good = evaluateExpressionCaptures(capture(blush), { blush: mask });
  assert.ok(Object.values(good.checks).every(Boolean));
  assert.equal(good.metrics.blush.changedPixels, 16);
  assert.equal(evaluateExpressionCaptures({}, { blush: mask }).checks.blushCaptured, false);
  assert.equal(evaluateExpressionCaptures(capture(neutral), { blush: mask }).checks.blushChanged, false);
  paint(blush, 0, 0, 4, 4, [10, 10, 10]);
  assert.equal(evaluateExpressionCaptures(capture(blush), { blush: mask }).checks.blushRegionStable, false);
  assert.deepEqual(evaluateExpressionCaptures({}, {}), { checks: {}, metrics: {} });
});

test('smile QA requires intermediate strengths, continued morphing and full-smile blink stability', () => {
  const neutral = frame(12, 12, [200, 170, 160]);
  const smile = frame(12, 12, [200, 170, 160]);
  paint(smile, 4, 4, 8, 8, [30, 20, 20]);
  const mask = new Uint8Array(144);
  for (let y = 4; y < 8; y += 1) mask.fill(1, y * 12 + 4, y * 12 + 8);
  const frames = [...Array.from({ length: 21 }, (_, i) => (i / 20).toFixed(2)), '0.48', '0.52'].map(strength => {
    const image = frame(12, 12, [200, 170, 160]);
    paint(image, 4, 4, 8, 8, [200 - Math.round(Number(strength) * 170), 20, 20]);
    return { label: `strength-${strength}`, frame: strength === '0.00' ? neutral : image };
  });
  frames.push({ label: 'strength-1.00-blink-half', frame: smile }, { label: 'strength-1.00-blink', frame: smile });
  const evaluate = values => evaluateExpressionCaptures({ 'eye-smile': values }, { 'eye-smile': mask });
  assert.ok(Object.values(evaluate(frames).checks).every(Boolean));
  assert.equal(evaluate(frames.filter(item => item.label !== 'strength-0.25')).checks.smileProgressionCaptured, false);
  assert.equal(evaluate(frames.map(item => item.label === 'strength-0.75' ? { ...item, frame: smile } : item)).checks.smileMorphProgresses, false);
  assert.equal(evaluate(frames.map(item => item.label.endsWith('blink-half') ? { ...item, frame: neutral } : item)).checks.smileBlinkStable, false);
});
