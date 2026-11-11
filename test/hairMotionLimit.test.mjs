import assert from 'node:assert/strict';
import test from 'node:test';
import { updateHairMotionInput, limitHairMotion } from '../webui/src/rig/hairMotionLimit.mjs';

const pose = x => ({ angleX: x, angleY: 0, angleZ: 0 });
const fastTurn = () => updateHairMotionInput(updateHairMotionInput(null, pose(0), 0), pose(.5), 1 / 30);

test('ordinary head movement preserves the complete hair mesh exactly', () => {
  let input = null, state;
  for (let i = 0; i < 120; i++) {
    input = updateHairMotionInput(input, pose(.6 * Math.sin(i / 30)), i / 30);
    const reference = new Float32Array([200, 300, 220, 350, 250, 400]);
    const mesh = new Float32Array([200, 300, 260, 350, 340, 400]);
    const original = new Float32Array(mesh);
    state = limitHairMotion(mesh, reference, 400, input, state);
    assert.deepEqual(mesh, original);
    assert.equal(state.latched, false);
  }
});

test('fast turns bound the whole hair layer relative to its moving head without local hinges', () => {
  for (const width of [200, 400, 800]) {
    const reference = new Float32Array([300, 400, 320, 450, 350, 500]);
    const mesh = new Float32Array([300, 400, 420, 460, 650, 530]);
    const state = limitHairMotion(mesh, reference, width, fastTurn());
    assert.equal(state.latched, true);
    assert.ok(state.appliedPeak <= width * .1);
    assert.equal(mesh[0], reference[0]);
    assert.equal(mesh[1], reference[1]);
    for (let i = 0; i < mesh.length; i += 2) {
      assert.ok(Math.hypot(mesh[i] - reference[i], mesh[i + 1] - reference[i + 1]) <= width * .1 + .0001);
    }
    assert.ok(Math.abs((mesh[2] - reference[2]) / 100 - (mesh[4] - reference[4]) / 300) < .00001);
  }
});

test('elapsed hold time cannot release residual motion; calm hair restores ordinary motion', () => {
  const reference = new Float32Array([0, 0, 20, 20]);
  const first = fastTurn();
  let state = limitHairMotion(new Float32Array([0, 0, 220, 20]), reference, 400, first);
  const later = updateHairMotionInput(first, pose(.5), 3);
  state = limitHairMotion(new Float32Array([0, 0, 220, 20]), reference, 400, later, state);
  assert.equal(state.latched, true);
  assert.ok(state.appliedPeak <= 40);
  state = limitHairMotion(new Float32Array([0, 0, 25, 20]), reference, 400, later, state);
  assert.equal(state.latched, false);
  const mesh = new Float32Array([0, 0, 100, 20]);
  state = limitHairMotion(mesh, reference, 400, later, state);
  assert.equal(mesh[2], 100);
});

test('the soft limit joins the unmodified motion continuously at its knee', () => {
  const input = fastTurn(), reference = new Float32Array([0, 0]);
  const below = limitHairMotion(new Float32Array([14 - .001, 0]), reference, 400, input);
  const above = limitHairMotion(new Float32Array([14 + .001, 0]), reference, 400, input);
  assert.ok(Math.abs((above.appliedPeak - below.appliedPeak) - .002) < .00001);
});
