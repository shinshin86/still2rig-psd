import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  SEAM_COLOR,
  changedPixels,
  erode,
  featureResiduals,
  loadMotionContract,
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
