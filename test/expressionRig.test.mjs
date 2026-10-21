import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const sandbox = { module: { exports: {} } };
vm.runInNewContext(fs.readFileSync(new URL('../webui/public/rigger.js', import.meta.url), 'utf8'), sandbox);
const rigger = sandbox.module.exports;
function layer(name, boxes, alpha = 255) {
  const width = 128; const height = 128;
  const data = new Uint8ClampedArray(width * height * 4);
  for (const [x0, y0, x1, y1] of boxes) for (let y = y0; y < y1; y += 1) for (let x = x0; x < x1; x += 1) {
    data.set([190, 70, 80, alpha], (y * width + x) * 4);
  }
  return { name, imageData: { width, height, data }, left: 0, top: 0 };
}
const psd = () => ({ width: 128, height: 128, children: [
  layer('face', [[20, 10, 108, 110]]),
  layer('eyewhite', [[30, 35, 50, 45], [78, 35, 98, 45]]),
  layer('eye_close', [[30, 42, 50, 45], [78, 42, 98, 45]]),
  layer('mouth_close', [[57, 80, 71, 84]]),
] });

test('smiling eyes split per side without changing closed-eye anchors; faint blush survives cleanup', () => {
  const input = psd(); const baseline = rigger.buildRig(input);
  input.children.push(layer('eye_smile', [[30, 30, 50, 33], [78, 30, 98, 33]]));
  input.children.push(layer('blush', [[28, 55, 31, 58], [96, 55, 99, 58]], 6));
  rigger.cleanPsdLayers(input);
  const rig = rigger.buildRig(input);
  assert.equal(rig.anchors.eyeL.closeY, baseline.anchors.eyeL.closeY);
  assert.equal(rig.anchors.eyeR.closeY, baseline.anchors.eyeR.closeY);
  const smile = rig.layers.filter(part => part.fade === 'eyeSmile');
  assert.equal(smile.length, 2);
  assert.deepEqual(Array.from(smile, part => part.side).sort(), ['L', 'R']);
  assert.ok(smile.every(part => part.group === 'head' && part.phys === null));
  const blush = rig.layers.find(part => part.name === 'blush');
  assert.ok(blush); assert.equal(blush.fade, 'blush'); assert.equal(blush.group, 'head');
  assert.equal(blush.phys, null); assert.equal(blush.side, null);
  assert.equal(Math.max(...Array.from(blush.img.data).filter((_, index) => index % 4 === 3)), 6);
  assert.ok(!rig.warnings.some(warning => /eye_smile|blush/.test(warning)));
});
