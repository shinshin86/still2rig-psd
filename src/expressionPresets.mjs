import config from '../configs/expression-presets.json' with { type: 'json' };

export const expressionParameterNames = Object.freeze([...config.parameters]);
export const expressionPresets = Object.freeze(config.presets.map(item => Object.freeze({
  ...item, values: Object.freeze({ ...item.values }),
})));

/** Replace only expression controls; pose, blink and speech stay independent. */
export function expressionPresetValues(id, parts = []) {
  const preset = expressionPresets.find(item => item.id === id);
  if (!preset) throw new Error('Unknown expression.');
  const values = Object.fromEntries(expressionParameterNames.map(name => [name, 0]));
  Object.assign(values, preset.values);
  const available = new Set(parts);
  if (!available.has('eye_smile')) {
    values.eyeNarrow = values.eyeSmile * 0.9;
    values.eyeWinkL = values.eyeSmileL;
    values.eyeWinkR = values.eyeSmileR;
    values.eyeSmile = values.eyeSmileL = values.eyeSmileR = 0;
  }
  if (!available.has('blush')) values.blush = 0;
  return values;
}
