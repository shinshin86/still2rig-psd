import fs from 'node:fs';
import path from 'node:path';

import { initializeCanvas, writePsdBuffer } from 'ag-psd';

const output = process.argv[2];
if (!output) throw new Error('Usage: node scripts/generate-fixture.mjs <output.psd>');

const width = 256;
const height = 256;

function imageData() {
  return { width, height, data: new Uint8ClampedArray(width * height * 4) };
}

initializeCanvas(
  (canvasWidth, canvasHeight) => ({
    width: canvasWidth,
    height: canvasHeight,
    getContext: () => ({
      createImageData: () => ({
        width: canvasWidth,
        height: canvasHeight,
        data: new Uint8ClampedArray(canvasWidth * canvasHeight * 4),
      }),
    }),
  }),
  (canvasWidth, canvasHeight) => ({
    width: canvasWidth,
    height: canvasHeight,
    data: new Uint8ClampedArray(canvasWidth * canvasHeight * 4),
  }),
);

function setPixel(target, x, y, color) {
  if (x < 0 || y < 0 || x >= width || y >= height) return;
  const offset = (y * width + x) * 4;
  target.data[offset] = color[0];
  target.data[offset + 1] = color[1];
  target.data[offset + 2] = color[2];
  target.data[offset + 3] = color[3];
}

function rectangle(target, x0, y0, x1, y1, color) {
  for (let y = y0; y <= y1; y += 1) {
    for (let x = x0; x <= x1; x += 1) setPixel(target, x, y, color);
  }
}

function ellipse(target, cx, cy, rx, ry, color) {
  for (let y = Math.floor(cy - ry); y <= Math.ceil(cy + ry); y += 1) {
    for (let x = Math.floor(cx - rx); x <= Math.ceil(cx + rx); x += 1) {
      const dx = (x - cx) / rx;
      const dy = (y - cy) / ry;
      if (dx * dx + dy * dy <= 1) setPixel(target, x, y, color);
    }
  }
}

function makeLayer(name, draw) {
  const data = imageData();
  draw(data);
  return {
    name,
    left: 0,
    top: 0,
    right: width,
    bottom: height,
    imageData: data,
  };
}

const hairBack = [73, 42, 31, 255];
const hairFront = [96, 55, 40, 255];
const skin = [248, 202, 174, 255];
const shirt = [48, 58, 78, 255];
const eyeWhite = [249, 249, 249, 255];
const eye = [44, 132, 156, 255];
const line = [68, 36, 30, 255];

const children = [
  makeLayer('back hair', (data) => ellipse(data, 128, 94, 99, 90, hairBack)),
  makeLayer('handwear', (data) => {
    rectangle(data, 48, 170, 82, 245, skin);
    rectangle(data, 174, 170, 208, 245, skin);
    rectangle(data, 66, 196, 190, 218, skin);
  }),
  makeLayer('topwear', (data) => {
    ellipse(data, 128, 244, 96, 82, shirt);
    rectangle(data, 62, 190, 194, 255, shirt);
  }),
  makeLayer('neck', (data) => rectangle(data, 108, 137, 148, 195, skin)),
  makeLayer('ears', (data) => {
    ellipse(data, 62, 96, 12, 23, skin);
    ellipse(data, 194, 96, 12, 23, skin);
  }),
  makeLayer('face', (data) => ellipse(data, 128, 89, 67, 73, skin)),
  makeLayer('eyewhite', (data) => {
    ellipse(data, 101, 78, 15, 10, eyeWhite);
    ellipse(data, 155, 78, 15, 10, eyeWhite);
  }),
  makeLayer('irides', (data) => {
    ellipse(data, 101, 79, 7, 9, eye);
    ellipse(data, 155, 79, 7, 9, eye);
  }),
  makeLayer('eyelash', (data) => {
    rectangle(data, 86, 68, 116, 71, line);
    rectangle(data, 140, 68, 170, 71, line);
  }),
  makeLayer('eyebrow', (data) => {
    rectangle(data, 88, 58, 114, 60, line);
    rectangle(data, 142, 58, 168, 60, line);
  }),
  makeLayer('eye_close', (data) => {
    rectangle(data, 87, 78, 115, 81, line);
    rectangle(data, 141, 78, 169, 81, line);
  }),
  makeLayer('mouth_close', (data) => rectangle(data, 117, 118, 139, 120, [142, 57, 58, 255])),
  makeLayer('mouth_open', (data) => ellipse(data, 128, 119, 12, 7, [112, 35, 43, 255])),
  makeLayer('nose', (data) => rectangle(data, 127, 99, 129, 104, [220, 155, 135, 255])),
  makeLayer('front hair', (data) => {
    ellipse(data, 128, 39, 88, 42, hairFront);
    rectangle(data, 72, 30, 93, 105, hairFront);
    rectangle(data, 96, 26, 115, 92, hairFront);
    rectangle(data, 118, 24, 136, 86, hairFront);
    rectangle(data, 162, 30, 183, 108, hairFront);
  }),
];

if (process.argv.includes('--exposed-eyes')) {
  children[children.findIndex(layer => layer.name === 'front hair')] = makeLayer('front hair', data => {
    ellipse(data, 128, 32, 88, 28, hairFront);
    rectangle(data, 72, 30, 81, 105, hairFront);
    rectangle(data, 178, 30, 183, 108, hairFront);
  });
}

if (process.argv.includes('--expressions')) {
  const blush = makeLayer('blush', (data) => {
    for (const cx of [96, 158]) {
      for (let y = 94; y <= 114; y += 1) for (let x = cx - 16; x <= cx + 16; x += 1) {
        const radius = ((x - cx) / 16) ** 2 + ((y - 104) / 10) ** 2;
        if (radius < 1) setPixel(data, x, y, [230, 60, 90, Math.round(90 * (1 - radius))]);
      }
    }
  });
  children.splice(children.findIndex(layer => layer.name === 'eyewhite'), 0, blush);
  const smile = makeLayer('eye_smile', (data) => {
    for (const cx of [101, 155]) for (let dx = -14; dx <= 14; dx += 1) {
      const y = 76 + Math.round(Math.abs(dx) * 0.45);
      rectangle(data, cx + dx, y, cx + dx, y + 2, line);
    }
  });
  children.splice(children.findIndex(layer => layer.name === 'eye_close') + 1, 0, smile);
}

const composite = imageData();
for (const child of children) {
  for (let offset = 0; offset < child.imageData.data.length; offset += 4) {
    const alpha = child.imageData.data[offset + 3] / 255;
    if (!alpha) continue;
    const targetAlpha = composite.data[offset + 3] / 255;
    const outAlpha = alpha + targetAlpha * (1 - alpha);
    for (let channel = 0; channel < 3; channel += 1) {
      composite.data[offset + channel] = Math.round(
        (child.imageData.data[offset + channel] * alpha +
          composite.data[offset + channel] * targetAlpha * (1 - alpha)) /
          outAlpha,
      );
    }
    composite.data[offset + 3] = Math.round(outAlpha * 255);
  }
}

fs.mkdirSync(path.dirname(path.resolve(output)), { recursive: true });
fs.writeFileSync(output, writePsdBuffer({ width, height, imageData: composite, children }));
console.log(output);
