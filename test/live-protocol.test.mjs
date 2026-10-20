import test from 'node:test';
import assert from 'node:assert/strict';
import { parseLiveState } from '../webui/src/live/protocol.mjs';
const state = () => ({ source: 'source-test-123', psd: 'opaque_psd', input: { angleX: 0.4, eyeOpenL: 0 }, weight: 1,
  settings: { mode: 'static', autoBlink: false, eyeOpen: 1, mouthOpen: 0, parameters: { physAmp: 2 }, tuning: { intensity: 1 } } });
test('live state bounds all permitted numbers and preserves separate settings', () => {
  const input = state(); input.input.angleX = 8; input.input.eyeOpenL = -3; input.weight = 5;
  input.settings.parameters.physAmp = 200; input.settings.tuning.intensity = 10;
  const parsed = parseLiveState(input);
  assert.equal(parsed.input.angleX, 1); assert.equal(parsed.input.eyeOpenL, 0); assert.equal(parsed.weight, 1);
  assert.equal(parsed.settings.parameters.physAmp, 3); assert.equal(parsed.settings.tuning.intensity, 1.5);
});
test('live state rejects media fields, unknown keys, wrong types and non-finite numbers', () => {
  for (const change of [value => { value.image = 'data:image/png;base64,private'; }, value => { value.input.landmarks = [1, 2]; },
    value => { value.input.angleX = Infinity; }, value => { value.weight = '1'; }, value => { value.settings.autoBlink = 1; },
    value => { value.settings.mode = 'other'; }, value => { value.settings.parameters.image = 1; }, value => { value.input = []; }]) {
    const value = state(); change(value); assert.throws(() => parseLiveState(value));
  }
});
test('live layer orders accept optional originals and bounded unique PSD IDs', () => {
  assert.equal(parseLiveState(state()).layerOrder, null);
  assert.equal(parseLiveState({ ...state(), layerOrder: null }).layerOrder, null);
  const layerOrder = ['0:face', '1:front hair', '2:顔'];
  assert.deepEqual(parseLiveState({ ...state(), layerOrder }).layerOrder, layerOrder);
  const full = { ...state(), layerOrder: Array.from({ length: 256 }, (_, i) => `${i}:part`) };
  assert.equal(parseLiveState(full).layerOrder.length, 256);
  assert.ok(Buffer.byteLength(JSON.stringify(full)) < 16384);
  for (const invalid of [[], ['0:face', '0:face'], ['0:' + 'a'.repeat(159)], ['0:face\n'], ['1:\u0085'], ['face'], [1], '0:face', {}, Array.from({ length: 257 }, (_, i) => `${i}:part`)]) {
    assert.throws(() => parseLiveState({ ...state(), layerOrder: invalid }));
  }
});
