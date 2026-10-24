import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { writePsdBuffer } from 'ag-psd';
import { expressionOcclusion } from '../src/psd.mjs';
import { STATE_ROOT } from '../src/utils.mjs';

test('occlusion uses actual PSD order, offsets and alpha, excluding dynamic and translucent layers', () => {
  fs.mkdirSync(STATE_ROOT, { recursive: true });
  const root = fs.mkdtempSync(path.join(STATE_ROOT, 'test-occlusion-'));
  try {
    const file = path.join(root, 'fixture.psd');
    const pixel = (name, left, alpha = 255, extra = {}) => ({ name, left, top: 1, right: left + 1, bottom: 2,
      imageData: { width: 1, height: 1, data: new Uint8ClampedArray([10,20,30,alpha]) }, ...extra });
    fs.writeFileSync(file, writePsdBuffer({ width: 8, height: 4, children: [
      pixel('headwear', 0), // Behind the existing expression despite map order.
      pixel('eye_smile', 1), pixel('front hair', 2), pixel('edge', 3, 254),
      pixel('hidden', 4, 255, { hidden: true }), pixel('faint', 5, 255, { opacity: 0.5 }),
      pixel('eye_close', 6),
    ] }));
    const order = ['blush','eye_smile','eye_close','front hair','headwear','edge','hidden','faint'];
    const request = { variants: Object.fromEntries(['eye_smile', 'blush'].map(name => [name, { cropBox: [0,0,8,4] }])) };
    const result = expressionOcclusion(file, request, { layers: order.map(target => ({ target })) },
      ['blush','eye_smile','eye_close'].map(name => ({ name })));
    const smile = result.variants.eye_smile;
    assert.deepEqual(smile.layers, ['front hair']);
    assert.deepEqual([...Buffer.from(smile.alpha, 'base64')].flatMap((a, i) => a ? [i] : []), [10]);
    assert.equal(smile.targetPresent, true);
    assert.deepEqual(result.variants.blush.layers, ['headwear', 'front hair']);
    assert.equal(result.variants.blush.targetPresent, false);
    assert.match(result.psdSha256, /^[a-f0-9]{64}$/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
