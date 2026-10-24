import assert from 'node:assert/strict';
import test from 'node:test';
import { morphSmile, raiseLowerLid, resolveEyeExpression, SMILE_SWITCH, smileInkVisibility, upperLidY } from '../webui/src/rig/eyeExpression.mjs';

test('smile keeps the blink input separate and uses one drawing while its two geometry stages keep progressing', () => {
  for (const eye of [0, 0.5, 1]) {
    const legacy = { eyeOpen: eye, smileProgress: 0, smileRestore: 0, smileAlpha: 0, blinkBrow: 1 - eye };
    assert.deepEqual(resolveEyeExpression(eye, 0), legacy);
    for (const strength of [0, 0.25, 0.5, 0.75, 1]) assert.deepEqual(resolveEyeExpression(eye, strength, false), legacy);
    assert.deepEqual(resolveEyeExpression(eye, 1), { eyeOpen: eye, smileProgress: 1, smileRestore: 1, smileAlpha: 1, blinkBrow: 0 });
    assert.equal(resolveEyeExpression(eye, 0.5).smileAlpha, 1);
    assert.equal(resolveEyeExpression(eye, SMILE_SWITCH).smileAlpha, 1);
    assert.equal(resolveEyeExpression(eye, 0.48).smileAlpha, 0);
    assert.equal(resolveEyeExpression(eye, SMILE_SWITCH - 0.000001).smileAlpha, 0);
  }
  const sequence = Array.from({ length: 101 }, (_, index) => resolveEyeExpression(1, index / 100));
  for (let index = 1; index < sequence.length; index += 1) {
    assert.ok(sequence[index].smileProgress >= sequence[index - 1].smileProgress);
    assert.ok(sequence[index].smileAlpha >= sequence[index - 1].smileAlpha);
    assert.ok(sequence[index].smileAlpha === 0 || sequence[index].smileAlpha === 1);
  }
});

test('lower lid rises toward the smile while the upper ink and asymmetric lid curve stay in place', () => {
  const anchor = { y0: 30, y1: 70, icx: 50, smileY: 30, closeY: 60,
    upperLid: [{ x: 20, y: 34 }, { x: 50, y: 30 }, { x: 80, y: 38 }] };
  assert.equal(upperLidY(anchor.upperLid, 65, 0), 34);
  for (const progress of [0, 0.25, 0.5, 0.75, 1]) {
    assert.equal(raiseLowerLid(32, 50, anchor, progress, true), 32);
    assert.equal(raiseLowerLid(34, 20, anchor, progress, true), 34);
    assert.equal(raiseLowerLid(38, 80, anchor, progress, true), 38);
    assert.equal(raiseLowerLid(70, 50, anchor, progress), 70 - 40 * progress);
  }
  const shifted = { ...anchor, smileY: 28 };
  assert.equal(raiseLowerLid(32, 50, shifted, 1, true), 30);
  assert.equal(raiseLowerLid(70, 50, shifted, 1), 28);
  const curved = { ...anchor, smileLid: [{ x: 20, y: 33 }, { x: 50, y: 29 }, { x: 80, y: 36 }] };
  assert.equal(raiseLowerLid(70, 50, curved, 1), 29.65);
  assert.equal(raiseLowerLid(38, 80, curved, 1, true), 32.1);
});

test('smile contour starts at the narrowed-eye width and restores the original artwork at one', () => {
  const anchor = { y0: 30, smileY: 40,
    upperLid: [{ x: 20, y: 35 }, { x: 50, y: 30 }, { x: 80, y: 35 }],
    smileLid: [{ x: 10, y: 50 }, { x: 50, y: 40 }, { x: 90, y: 50 }] };
  assert.deepEqual(morphSmile(50, 48, anchor, 1), { x: 50, y: 48 });
  assert.equal(morphSmile(10, 50, anchor, 0).x, 20);
  const start = morphSmile(50, 48, anchor, 0), half = morphSmile(50, 48, anchor, 0.5);
  assert.ok(start.y < half.y && half.y < 48);
  const sequence = [0.5, 0.6, 0.7, 0.8, 0.9, 1].map(s => resolveEyeExpression(1, s));
  assert.ok(sequence.every((v, i) => i === 0 || v.smileRestore > sequence[i - 1].smileRestore));
  assert.deepEqual(morphSmile(50, 48, { y0: 30 }, 0), { x: 50, y: 48 });
});

test('smile morph preserves the crease separation and hides detached outside marks while displaced', () => {
  const anchor = { y0: 30, y1: 80, smileY: 40,
    smileInkBounds: { x0: 20, x1: 80, y0: 40, y1: 50 },
    upperLid: [{ x: 20, y: 30 }, { x: 80, y: 30 }],
    smileLid: [{ x: 20, y: 40 }, { x: 80, y: 40 }] };
  const top = morphSmile(50, 40, anchor, 0);
  const crease = morphSmile(50, 30, anchor, 0);
  assert.equal(top.y - crease.y, 10);
  assert.equal(smileInkVisibility(90, 60, anchor, 0), 0);
  assert.equal(smileInkVisibility(50, 60, anchor, 0), 0);
  assert.equal(smileInkVisibility(90, 60, anchor, 1), 1);
  assert.equal(smileInkVisibility(50, 30, anchor, 0), 1);
});
