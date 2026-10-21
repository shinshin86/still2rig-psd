import { expressions } from '../../src/expressions.mjs';
import {
  readPsd,
  writePsd,
  type Layer,
  type PixelData,
  type Psd,
} from 'ag-psd';

export interface EditablePsdLayer {
  id: string;
  name: string;
  label: string;
}

export interface EditablePsdSummary {
  layers: EditablePsdLayer[];
  editable: boolean;
  reason: string | null;
}

export interface ReorderedPsdResult {
  buffer: ArrayBuffer;
  layerNames: string[];
}

const LAYER_LABELS: Record<string, string> = {
  'back hair': '後ろ髪',
  bottomwear: '下半身・下の服',
  handwear: '腕・手',
  topwear: '上半身・服',
  neck: '首',
  ears: '耳',
  face: '顔',
  eyewhite: '白目',
  irides: '瞳',
  eyelash: 'まつ毛',
  eyebrow: '眉',
  nose: '鼻',
  facedetail: '顔の細部',
  ...Object.fromEntries(expressions.map(item => [item.name, item.label])),
  'front hair': '前髪',
  headwear: '髪飾り・帽子',
};

function normalizedName(name: string): string {
  return name.normalize('NFKC').trim().toLowerCase();
}

export function layerLabel(name: string): string {
  return LAYER_LABELS[normalizedName(name)] ?? (name.trim() || '名前のない部分');
}

function layerId(index: number, name: string): string {
  return `${index}:${name}`;
}

function readForEditing(buffer: ArrayBuffer, imageData: boolean): Psd {
  return readPsd(new Uint8Array(buffer.slice(0)), {
    useImageData: imageData,
    skipLayerImageData: !imageData,
    skipCompositeImageData: true,
    skipThumbnail: true,
    skipLinkedFilesData: true,
  });
}

export function inspectEditablePsd(buffer: ArrayBuffer): EditablePsdSummary {
  const psd = readForEditing(buffer, false);
  const children = psd.children ?? [];
  const layers = children.map((layer, index) => ({
    id: layerId(index, layer.name ?? ''),
    name: layer.name ?? '',
    label: layerLabel(layer.name ?? ''),
  }));
  const group = children.find((layer) => (layer.children?.length ?? 0) > 0);
  const missingName = layers.find((layer) => layer.name.trim().length === 0);
  const duplicateNames = new Set<string>();
  const seenNames = new Set<string>();
  for (const layer of layers) {
    const name = normalizedName(layer.name);
    if (seenNames.has(name)) duplicateNames.add(name);
    seenNames.add(name);
  }
  let reason: string | null = null;
  if (layers.length < 2) {
    reason = '重なりを変更できる部分が2つ以上ありません。';
  } else if (group) {
    reason = 'グループを含むPSDは、現在の簡単修正では扱えません。';
  } else if (missingName) {
    reason = '名前のない部分があるため、安全に並びを保存できません。';
  } else if (duplicateNames.size > 0) {
    reason = '同じ名前の部分が複数あるため、安全に並びを保存できません。';
  }
  return { layers, editable: reason === null, reason };
}

export function applyPsdLayerOrder(psd: Psd, order: readonly string[]): void {
  psd.children = applyOrder(psd.children ?? [], order);
}

function applyOrder(children: Layer[], order: readonly string[]): Layer[] {
  const byId = new Map(
    children.map((layer, index) => [layerId(index, layer.name ?? ''), layer]),
  );
  if (order.length !== children.length || new Set(order).size !== order.length) {
    throw new Error('部分の並びに不足または重複があります。');
  }
  const reordered = order.map((id) => byId.get(id));
  if (reordered.some((layer) => !layer)) {
    throw new Error('元のPSDと一致しない部分が含まれています。');
  }
  return reordered as Layer[];
}

function compositeLayers(
  layers: readonly Layer[],
  width: number,
  height: number,
): PixelData {
  const result: PixelData = {
    width,
    height,
    data: new Uint8ClampedArray(width * height * 4),
  };
  for (const layer of layers) {
    if (layer.hidden || !layer.imageData) continue;
    if (layer.blendMode && layer.blendMode !== 'normal') {
      throw new Error(`「${layerLabel(layer.name ?? '')}」の合成方法にはまだ対応していません。`);
    }
    if (layer.clipping) {
      throw new Error(`「${layerLabel(layer.name ?? '')}」の切り抜き設定にはまだ対応していません。`);
    }
    const source = layer.imageData;
    const left = layer.left ?? 0;
    const top = layer.top ?? 0;
    const layerOpacity = layer.opacity ?? 1;
    for (let y = 0; y < source.height; y += 1) {
      const targetY = y + top;
      if (targetY < 0 || targetY >= height) continue;
      for (let x = 0; x < source.width; x += 1) {
        const targetX = x + left;
        if (targetX < 0 || targetX >= width) continue;
        const sourceOffset = (y * source.width + x) * 4;
        const targetOffset = (targetY * width + targetX) * 4;
        const sourceAlpha = (source.data[sourceOffset + 3] / 255) * layerOpacity;
        if (sourceAlpha <= 0) continue;
        const targetAlpha = result.data[targetOffset + 3] / 255;
        const outputAlpha = sourceAlpha + targetAlpha * (1 - sourceAlpha);
        for (let channel = 0; channel < 3; channel += 1) {
          result.data[targetOffset + channel] = Math.round(
            (source.data[sourceOffset + channel] * sourceAlpha +
              result.data[targetOffset + channel] * targetAlpha * (1 - sourceAlpha)) /
              outputAlpha,
          );
        }
        result.data[targetOffset + 3] = Math.round(outputAlpha * 255);
      }
    }
  }
  return result;
}

export function buildReorderedPsd(
  sourceBuffer: ArrayBuffer,
  order: readonly string[],
): ReorderedPsdResult {
  const psd = readForEditing(sourceBuffer, true);
  const children = psd.children ?? [];
  psd.children = applyOrder(children, order);
  psd.imageData = compositeLayers(psd.children, psd.width, psd.height);
  psd.canvas = undefined;
  const buffer = writePsd(psd, {
    generateThumbnail: false,
    noBackground: true,
  });
  const check = readPsd(new Uint8Array(buffer.slice(0)), {
    skipLayerImageData: true,
    skipCompositeImageData: true,
    skipThumbnail: true,
    skipLinkedFilesData: true,
  });
  const writtenNames = (check.children ?? []).map((layer) => layer.name ?? '');
  const expectedNames = psd.children.map((layer) => layer.name ?? '');
  if (JSON.stringify(writtenNames) !== JSON.stringify(expectedNames)) {
    throw new Error('保存後に部分の並びが変わってしまいました。元のPSDは変更されていません。');
  }
  return { buffer, layerNames: writtenNames };
}

export function editedPsdFileName(fileName: string): string {
  const base = fileName.replace(/\.psd$/i, '') || 'avatar';
  return `${base}-重なり修正版.psd`;
}
