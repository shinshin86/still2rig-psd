const unit = [0, 1];
const signed = [-1, 1];
export const trackingRanges = Object.fromEntries([
  ...['angleX', 'angleY', 'angleZ', 'body', 'eyeX', 'eyeY', 'mouthForm', 'brow'].map(key => [key, signed]),
  ...['eyeOpenL', 'eyeOpenR', 'mouthOpen'].map(key => [key, unit]),
]);
const parameterRanges = {
  ...trackingRanges, eyeSmile: unit, eyeSmileL: unit, eyeSmileR: unit, browWorry: unit, browAngry: unit, browFlat: unit, upperLid: unit, lidTilt: signed, eyeWide: unit, eyeNarrow: unit, eyeWinkL: unit, eyeWinkR: unit, blush: unit, armY: signed, armPos: signed, irisScale: [0.5, 1.3], eyeEase: unit,
  eyeCY: signed, eyeCAng: signed, eyeScaleL: [0.5, 1.5], eyeScaleR: [0.5, 1.5],
  browAngL: signed, browAngR: signed, browAngSym: signed,
  mouthCY: signed, mouthEase: unit, mouthCAng: signed, mouthScale: [0.5, 1.5],
  physAmp: [0, 3], soft: [0, 3], fhAmp: [0, 3], fhSoft: [0, 2],
  bangL: signed, bangC: signed, bangR: signed, bust: [0, 4], bustY: [-3, 3],
};
const tuningRanges = Object.fromEntries(['idleScale', 'breathScale', 'hairWindScale', 'hairAmplitudeScale', 'dragScale'].map(key => [key, [0, 1.5]]));
Object.assign(tuningRanges, { hairSoftnessScale: [0, 1.2], intensity: [0, 1.5] });
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const keysOnly = (value, keys) => record(value) && Object.keys(value).every(key => keys.includes(key));
function number(value, min, max) {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error('Invalid number');
  return Math.max(min, Math.min(max, value));
}
function numbers(value, ranges) {
  if (!record(value) || Object.keys(value).some(key => !Object.hasOwn(ranges, key))) throw new Error('Invalid fields');
  return Object.fromEntries(Object.entries(value).map(([key, n]) => [key, number(n, ...ranges[key])]));
}
export function parseLayerOrder(value) {
  if (value == null) return null;
  if (!Array.isArray(value) || value.length < 1 || value.length > 256 ||
      value.some(id => typeof id !== 'string' || id.length > 160 || !/^\d+:[^\x00-\x1f\x7f-\x9f]*$/u.test(id)) ||
      new Set(value).size !== value.length) throw new Error('Invalid layer order');
  return [...value];
}
export function parseLiveState(value) {
  if (!keysOnly(value, ['source', 'psd', 'input', 'weight', 'settings', 'layerOrder', 'voiceMouth'])) throw new Error('Invalid state');
  if (typeof value.source !== 'string' || !/^[a-zA-Z0-9_-]{8,80}$/.test(value.source)) throw new Error('Invalid source');
  if (typeof value.psd !== 'string' || !/^[a-zA-Z0-9_-]{1,1024}$/.test(value.psd)) throw new Error('Invalid PSD');
  const s = value.settings;
  if (!keysOnly(s, ['mode', 'autoBlink', 'eyeOpen', 'mouthOpen', 'parameters', 'tuning']) ||
      !['static', 'physics', 'idle-physics'].includes(s.mode) || typeof s.autoBlink !== 'boolean') throw new Error('Invalid settings');
  return {
    source: value.source, psd: value.psd, layerOrder: parseLayerOrder(value.layerOrder),
    input: value.input === null ? null : numbers(value.input, trackingRanges),
    weight: number(value.weight, 0, 1),
    voiceMouth: value.voiceMouth == null ? null : number(value.voiceMouth, 0, 1),
    settings: { mode: s.mode, autoBlink: s.autoBlink, eyeOpen: number(s.eyeOpen, 0, 1), mouthOpen: number(s.mouthOpen, 0, 1),
      parameters: numbers(s.parameters, parameterRanges), tuning: numbers(s.tuning, tuningRanges) },
  };
}
