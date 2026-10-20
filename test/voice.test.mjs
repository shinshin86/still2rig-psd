import test from 'node:test';
import assert from 'node:assert/strict';
import { mouthTarget, rmsLevel, smoothMouth } from '../webui/src/voice/level.mjs';

test('voice measures RMS and gates silence and quiet environmental noise at every sensitivity', () => {
  assert.equal(rmsLevel([]), 0);
  assert.equal(rmsLevel([0, 0]), 0);
  assert.equal(rmsLevel([-0.5, 0.5]), 0.5);
  for (const gain of [0.25, 1, 3]) {
    for (const rms of [0, 0.001, 10 ** (-48 / 20)]) assert.equal(mouthTarget(rms, gain), 0);
  }
  assert.equal(mouthTarget(NaN), 0);
  assert.equal(mouthTarget(Infinity), 0);
});
test('voice sensitivity scales audible input and clamps the output', () => {
  const rms = 10 ** (-36 / 20);
  assert.ok(Math.abs(mouthTarget(rms, 1) - 0.4) < 1e-10);
  assert.ok(Math.abs(mouthTarget(rms, 2) - 0.8) < 1e-10);
  assert.equal(mouthTarget(1, 3), 1);
  assert.equal(mouthTarget(rms, -1), 0);
});
test('attack is quicker than release and smoothing is consistent across sampling intervals', () => {
  assert.ok(smoothMouth(0, 1, 0.05) > 1 - smoothMouth(1, 0, 0.05));
  for (const [initial, target] of [[0, 1], [1, 0.2]]) {
    let sampled = initial;
    for (let i = 0; i < 10; i++) sampled = smoothMouth(sampled, target, 0.01);
    assert.ok(Math.abs(sampled - smoothMouth(initial, target, 0.1)) < 1e-10);
  }
  assert.equal(smoothMouth(0.1, 1, 0), 0.1);
  let resting = 1;
  for (let i = 0; i < 100; i++) resting = smoothMouth(resting, 0, 0.034);
  assert.equal(resting, 0);
});
