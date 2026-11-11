// Real-time square captures retain their screenshot path. Fixed-clock captures
// read native pixels directly: screenshot animation waits must not tick the rig.
// Non-square models also need native pixels to avoid CSS letterboxing.
export async function captureModelFrame(page, canvas, cssWidth, nativeCapture) {
  const rect = await canvas.boundingBox();
  // The UI contains portrait/landscape art inside a square CSS element.
  // Read non-square canvases at native size to avoid letterboxing or a
  // distorted model scale. Use the same solid QA background as screenshots.
  const fixedClock = await page.evaluate(() => Boolean(globalThis.__motionQaClock));
  return nativeCapture || fixedClock ? Buffer.from(await page.evaluate(() => {
    const source = document.querySelector('#rig-canvas');
    source.getContext('webgl').finish();
    const output = document.createElement('canvas');
    output.width = source.width;
    output.height = source.height;
    const context = output.getContext('2d');
    context.fillStyle = '#00ff00';
    context.fillRect(0, 0, output.width, output.height);
    context.drawImage(source, 0, 0);
    return output.toDataURL('image/png').split(',')[1];
  }), 'base64') : await page.screenshot({
    animations: 'allow',
    clip: { x: Math.round(rect.x), y: Math.round(rect.y), width: cssWidth, height: cssWidth },
  });
}
