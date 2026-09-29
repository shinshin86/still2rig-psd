import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { initializeCanvas, readPsd, writePsdBuffer } from 'ag-psd';
import { loadLayerMap, relativeProjectPath, sha256File, writeJson } from './utils.mjs';

function imageData(width, height) {
  return { width, height, data: new Uint8ClampedArray(width * height * 4) };
}

initializeCanvas(
  (width, height) => ({ width, height, getContext: () => ({ createImageData: imageData }) }),
  imageData,
);

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

export function readPngRgba(file) {
  return decodePngRgba(fs.readFileSync(file), path.basename(file));
}

export function decodePngRgba(buffer, label = 'PNG') {
  const file = label;
  if (buffer.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') throw new Error(`Not a PNG: ${path.basename(file)}`);
  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  const idat = [];
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.subarray(offset + 4, offset + 8).toString('ascii');
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    offset += 12 + length;
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      if (bitDepth !== 8 || data[10] !== 0 || data[11] !== 0 || data[12] !== 0) {
        throw new Error(`Unsupported PNG encoding: ${path.basename(file)}`);
      }
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
  }
  const channels = new Map([[0, 1], [2, 3], [4, 2], [6, 4]]).get(colorType);
  if (!channels) throw new Error(`Unsupported PNG color type ${colorType}: ${path.basename(file)}`);
  const inflated = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const raw = Buffer.alloc(height * stride);
  let inputOffset = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = inflated[inputOffset++];
    const row = raw.subarray(y * stride, (y + 1) * stride);
    const previous = y ? raw.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x += 1) {
      const value = inflated[inputOffset++];
      const left = x >= channels ? row[x - channels] : 0;
      const up = previous ? previous[x] : 0;
      const upLeft = previous && x >= channels ? previous[x - channels] : 0;
      if (filter === 0) row[x] = value;
      else if (filter === 1) row[x] = (value + left) & 255;
      else if (filter === 2) row[x] = (value + up) & 255;
      else if (filter === 3) row[x] = (value + Math.floor((left + up) / 2)) & 255;
      else if (filter === 4) row[x] = (value + paeth(left, up, upLeft)) & 255;
      else throw new Error(`Unsupported PNG filter ${filter}: ${path.basename(file)}`);
    }
  }
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let source = 0, target = 0; source < raw.length; source += channels, target += 4) {
    if (colorType === 0) {
      rgba[target] = raw[source]; rgba[target + 1] = raw[source]; rgba[target + 2] = raw[source]; rgba[target + 3] = 255;
    } else if (colorType === 2) {
      rgba[target] = raw[source]; rgba[target + 1] = raw[source + 1]; rgba[target + 2] = raw[source + 2]; rgba[target + 3] = 255;
    } else if (colorType === 4) {
      rgba[target] = raw[source]; rgba[target + 1] = raw[source]; rgba[target + 2] = raw[source]; rgba[target + 3] = raw[source + 1];
    } else {
      rgba[target] = raw[source]; rgba[target + 1] = raw[source + 1]; rgba[target + 2] = raw[source + 2]; rgba[target + 3] = raw[source + 3];
    }
  }
  return { width, height, data: rgba };
}

function hasVisiblePixels(data) {
  for (let index = 3; index < data.length; index += 4) if (data[index] > 16) return true;
  return false;
}

function composite(layers, width, height) {
  const result = imageData(width, height);
  for (const layer of layers) {
    const source = layer.imageData.data;
    const target = result.data;
    for (let index = 0; index < source.length; index += 4) {
      const sourceAlpha = source[index + 3] / 255;
      if (sourceAlpha === 0) continue;
      const targetAlpha = target[index + 3] / 255;
      const outAlpha = sourceAlpha + targetAlpha * (1 - sourceAlpha);
      for (let channel = 0; channel < 3; channel += 1) {
        const value = (source[index + channel] * sourceAlpha + target[index + channel] * targetAlpha * (1 - sourceAlpha)) / outAlpha;
        target[index + channel] = Math.round(value);
      }
      target[index + 3] = Math.round(outAlpha * 255);
    }
  }
  return result;
}

export function buildPsd({ layerDir, output, reportFile, previewPlaceholders = false, previewExpressionTargets = [] }) {
  const map = loadLayerMap();
  const orderedTargets = [];
  const selected = new Map();
  for (const entry of map.layers) {
    if (!orderedTargets.includes(entry.target)) orderedTargets.push(entry.target);
    const source = path.join(layerDir, entry.source);
    if (!fs.existsSync(source)) continue;
    if (!selected.has(entry.target) || entry.override) selected.set(entry.target, { ...entry, source });
  }
  const placeholders = [];
  if (previewPlaceholders && !selected.has('mouth_open') && selected.has('mouth_close')) {
    selected.set('mouth_open', { target: 'mouth_open', source: selected.get('mouth_close').source, placeholder: true });
    placeholders.push({ layer: 'mouth_open', copiedFrom: 'mouth_close' });
  }

  const requiredTargets = [...new Set(map.layers.filter((entry) => entry.required).map((entry) => entry.target))];
  const productionTargets = [...new Set(map.layers.filter((entry) => entry.requiredForProduction).map((entry) => entry.target))];
  const missingRequired = requiredTargets.filter((target) => !selected.has(target));
  if (missingRequired.length) throw new Error(`Missing required layers: ${missingRequired.join(', ')}`);

  const layers = [];
  let width = 0;
  let height = 0;
  for (const target of orderedTargets) {
    const item = selected.get(target);
    if (!item) continue;
    const data = readPngRgba(item.source);
    if (!hasVisiblePixels(data.data)) continue;
    if (!width) ({ width, height } = data);
    if (data.width !== width || data.height !== height) throw new Error(`Layer dimensions differ: ${path.basename(item.source)}`);
    layers.push({ name: target, left: 0, top: 0, right: width, bottom: height, imageData: data });
  }
  const names = layers.map((layer) => layer.name);
  const missingProduction = productionTargets.filter((target) => !names.includes(target));
  // Expression art derived from the neutral image is preview art, never production art.
  const previewExpressions = previewExpressionTargets
    .filter((target) => names.includes(target))
    .map((layer) => ({ layer, provenance: 'derived-preview' }));
  fs.mkdirSync(path.dirname(output), { recursive: true });
  const psd = { width, height, imageData: composite(layers, width, height), children: layers };
  fs.writeFileSync(output, writePsdBuffer(psd));
  const check = readPsd(new Uint8Array(fs.readFileSync(output)), {
    skipLayerImageData: true,
    skipCompositeImageData: true,
    skipThumbnail: true,
  });
  const writtenNames = (check.children || []).map((layer) => layer.name);
  if (JSON.stringify(writtenNames) !== JSON.stringify(names)) throw new Error('PSD layer order changed during round-trip validation.');
  const report = {
    schemaVersion: 1,
    output: relativeProjectPath(output),
    bytes: fs.statSync(output).size,
    sha256: sha256File(output),
    canvas: [width, height],
    layerOrder: names,
    placeholders,
    previewExpressions,
    missingProduction,
    productionReady: missingProduction.length === 0 && placeholders.length === 0 && previewExpressions.length === 0,
  };
  writeJson(reportFile, report);
  return report;
}

export function inspectPsd(file) {
  const psd = readPsd(new Uint8Array(fs.readFileSync(file)), {
    useImageData: true,
    skipCompositeImageData: true,
    skipThumbnail: true,
  });
  return {
    width: psd.width,
    height: psd.height,
    layers: (psd.children || []).map((layer) => ({ name: layer.name, left: layer.left || 0, top: layer.top || 0, imageData: layer.imageData })),
  };
}
