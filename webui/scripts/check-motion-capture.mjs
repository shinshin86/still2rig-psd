// Run with `node webui/scripts/check-motion-capture.mjs`.
// A synthetic WebGL fixture verifies native portrait/landscape pixels and the
// unchanged square screenshot path without loading private character artwork.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { decodePngRgba } from '../../src/psd.mjs';
import { captureModelFrame } from './motion-capture.mjs';

const browser = await chromium.launch({ headless: true,
  args: ['--use-angle=metal', '--enable-webgl', '--ignore-gpu-blocklist'] });
try {
  const page = await browser.newPage({ viewport: { width: 300, height: 300 } });
  for (const [width, height] of [[80, 120], [120, 80], [80, 80]]) {
    await page.setContent(`<style>body{margin:0}canvas{width:80px;height:80px;object-fit:contain;background:#00ff00}</style><canvas id="rig-canvas" width="${width}" height="${height}"></canvas>`);
    await page.evaluate(() => {
      const c = document.querySelector('canvas');
      const gl = c.getContext('webgl', { preserveDrawingBuffer: true });
      gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
      gl.enable(gl.SCISSOR_TEST);
      gl.scissor(5, 5, c.width - 10, c.height - 10);
      gl.clearColor(1, 0, 0, 1); gl.clear(gl.COLOR_BUFFER_BIT);
      // An asymmetric marker detects a vertical flip or a stretched crop.
      gl.scissor(6, c.height - 12, 7, 6);
      gl.clearColor(0, 0, 1, 1); gl.clear(gl.COLOR_BUFFER_BIT); gl.finish();
    });
    const bytes = await captureModelFrame(page, page.locator('canvas'), 80, width !== height);
    const image = decodePngRgba(bytes, 'synthetic.png');
    assert.equal(image.width, width); assert.equal(image.height, height);
    const pixel = (x, y) => [...image.data.slice((y * width + x) * 4, (y * width + x + 1) * 4)];
    assert.deepEqual(pixel(0, 0), [0, 255, 0, 255]);
    assert.deepEqual(pixel(width - 1, height - 1), [0, 255, 0, 255]);
    assert.deepEqual(pixel(8, 8), [0, 0, 255, 255]);
    assert.deepEqual(pixel(width / 2, height / 2), [255, 0, 0, 255]);
    if (width === height) {
      const legacy = await page.screenshot({ animations: 'allow', clip: { x: 0, y: 0, width: 80, height: 80 } });
      assert.deepEqual(decodePngRgba(legacy, 'legacy.png').data, image.data);
    }
  }
  console.log('PASS: portrait/landscape retain native dimensions and pixels; square equals legacy screenshot.');
} finally {
  await browser.close();
}
