import test from 'node:test';
import assert from 'node:assert/strict';
import { readFace, mapFace, neutralInput, smoothInput, TrackingPose } from '../webui/src/tracking/pose.mjs';
const options = { mirror: false, sensitivity: 1, smoothing: 0.5 };
const face = (shapes = {}, angles = {}) => ({ yaw: 0, pitch: 0, roll: 0, shapes, ...angles });
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-6, `${actual} != ${expected}`);

test('face rotation removes column scale and rejects invalid matrices', () => {
  const a = Math.PI / 6;
  const raw = readFace([2 * Math.cos(a), 0, -2 * Math.sin(a), 0, 0, 3, 0, 0, 4 * Math.sin(a), 0, 4 * Math.cos(a), 0, 0, 0, 0, 1], []);
  near(raw.yaw, 30); near(raw.pitch, 0); near(raw.roll, 0);
  assert.equal(readFace(Array(16).fill(0), []), null);
  assert.equal(readFace(Array(16).fill(NaN), []), null);
});
test('neutral calibration, angular wrap, angle bounds and mirror', () => {
  const current = face({}, { yaw: -179, pitch: 90, roll: 90 });
  const neutral = face({}, { yaw: 179 });
  const mapped = mapFace(current, neutral, options);
  near(mapped.angleX, 2 / 20);
  assert.equal(mapped.angleY, -1); assert.equal(mapped.angleZ, 1);
  near(mapFace(current, neutral, { ...options, mirror: true }).angleX, -mapped.angleX);
  const self = mapFace(current, current, options);
  near(self.angleX, 0); near(self.angleY, 0); near(self.angleZ, 0);
});
test('blink closes immediately, normalizes neutral eyelids and swaps sides', () => {
  const current = face({ eyeBlinkLeft: 0.85, eyeBlinkRight: 0.25 });
  const neutral = face({ eyeBlinkRight: 0.25 });
  const normal = mapFace(current, neutral, options);
  assert.equal(normal.eyeOpenL, 0); assert.equal(normal.eyeOpenR, 1);
  const mirrored = mapFace(current, neutral, { ...options, mirror: true });
  assert.equal(mirrored.eyeOpenR, 0); assert.equal(mirrored.eyeOpenL, 1);
});
test('mouth, gaze and brows stay bounded and respond independently', () => {
  const value = mapFace(face({ jawOpen: 0.8, mouthClose: 0.3, mouthPucker: 0.6, browInnerUp: 0.7, eyeLookUpLeft: 1, eyeLookUpRight: 1, eyeLookOutRight: 1 }), null, options);
  near(value.mouthOpen, 0.5); near(value.mouthForm, 0.6); near(value.brow, 0.7);
  near(value.eyeY, -1); near(value.eyeX, 1);
  assert.equal(mapFace(face({ mouthSmileLeft: 1, mouthSmileRight: 1 }), null, options).mouthForm, -1);
});
test('smoothing is independent of sample rate and never delays blinks', () => {
  const target = { ...neutralInput, angleX: 0.7, eyeOpenL: 0 };
  const one = smoothInput(neutralInput, target, 0.1, 0.5);
  const half = smoothInput(neutralInput, target, 0.05, 0.5);
  near(smoothInput(half, target, 0.05, 0.5).angleX, one.angleX);
  assert.equal(half.eyeOpenL, 0);
});
test('face loss fades after grace interval and calibration needs a recent face', () => {
  const pose = new TrackingPose();
  assert.equal(pose.calibrate(0), false);
  pose.update(face(), 100);
  assert.equal(pose.calibrate(100), true);
  const tracking = pose.sample(400, 0.3, options);
  assert.equal(tracking.visible, true);
  pose.update(null, 550);
  assert.equal(pose.calibrate(601), false);
  const missing = pose.sample(650, 0.25, options);
  assert.equal(missing.visible, false);
  assert.ok(missing.weight < tracking.weight);
  assert.equal(pose.sample(2000, 2, options).weight, 0);
});

function pitchFace(degrees) {
  const a = degrees * Math.PI / 180;
  return readFace([1, 0, 0, 0, 0, Math.cos(a), Math.sin(a), 0, 0, -Math.sin(a), Math.cos(a), 0, 0, 0, 0, 1], []);
}
test('looking up raises the head and pupils in renderer coordinates, with either mirror setting', () => {
  const neutral = pitchFace(5);
  for (const mirror of [false, true]) {
    const settings = { ...options, mirror };
    const up = mapFace(pitchFace(-15), neutral, settings);
    const down = mapFace(pitchFace(25), neutral, settings);
    assert.ok(up.angleY > 0, 'upward pitch maps to the renderer positive/up direction');
    assert.ok(down.angleY < 0);
    const gazeUp = mapFace(face({ eyeLookUpLeft: 0.6, eyeLookUpRight: 0.6 }), null, settings);
    const gazeDown = mapFace(face({ eyeLookDownLeft: 0.6, eyeLookDownRight: 0.6 }), null, settings);
    assert.ok(gazeUp.eyeY < 0, 'negative eyeY moves pupils upward on screen');
    assert.ok(gazeDown.eyeY > 0);
  }
});
test('sensitivity supports three while the full head limit remains unchanged', () => {
  const small = face({}, { yaw: 4, pitch: -4, roll: 4 });
  const normal = mapFace(small, null, options);
  const stronger = mapFace(small, null, { ...options, sensitivity: 1.5 });
  const maximum = mapFace(small, null, { ...options, sensitivity: 3 });
  for (const key of ['angleX', 'angleY', 'angleZ']) {
    near(stronger[key], normal[key] * 1.5);
    near(maximum[key], normal[key] * 3);
  }
  near(mapFace(small, null, { ...options, sensitivity: 100 }).angleX, maximum.angleX);
  const limited = mapFace(face({}, { yaw: 80, pitch: -80, roll: 80 }), null, { ...options, sensitivity: 3 });
  for (const key of ['angleX', 'angleY', 'angleZ']) near(limited[key], 1);
});
test('horizontal pose, gaze and tilt flip together when mirroring is enabled', () => {
  const sample = face({ eyeLookOutRight: 0.4, eyeLookInLeft: 0.4 }, { yaw: 10, roll: 10 });
  const direct = mapFace(sample, null, options);
  const mirrored = mapFace(sample, null, { ...options, mirror: true });
  for (const key of ['angleX', 'angleZ', 'eyeX']) {
    assert.ok(direct[key] > 0);
    near(mirrored[key], -direct[key]);
  }
});

test('body motion and small gaze scores receive the stronger mapping', () => {
  const mapped = mapFace(face({ eyeLookOutRight: 0.15, eyeLookUpLeft: 0.2, eyeLookUpRight: 0.2 }, { yaw: 20, roll: 20 }), null, options);
  near(mapped.angleX, 1); near(mapped.angleZ, 1); near(mapped.body, 0.5);
  near(mapped.eyeX, 0.3); near(mapped.eyeY, -0.4);
});
