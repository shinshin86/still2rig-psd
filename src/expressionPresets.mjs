import config from '../configs/expression-presets.json' with { type: 'json' };

export const expressionParameterNames = Object.freeze([...config.parameters]);
export const expressionPresets = Object.freeze(config.presets.map(item => Object.freeze({
  ...item, values: Object.freeze({ ...item.values }),
})));

export function expressionPresetAvailability(id, parts = []) {
  const available = new Set(parts);
  const required = { angry: ['eyes_angry'], sad: ['eyes_sad'], shy: ['eyes_shy'],
    surprised: ['eyes_surprised'], flustered: ['eyes_flustered'], unamused: ['eyes_half'], joy: ['eye_smile'] };
  const missing = id === 'wink' ? !available.has('eye_smile') && !available.has('eye_close')
    : (required[id] ?? []).some(part => !available.has(part));
  return { available: !missing, reason: missing ? 'この表情の絵がありません' : '' };
}

/** Replace only expression controls; pose, blink and speech stay independent. */
export function expressionPresetValues(id, parts = []) {
  const preset = expressionPresets.find(item => item.id === id);
  if (!preset) throw new Error('Unknown expression.');
  const values = Object.fromEntries(expressionParameterNames.map(name => [name, 0]));
  Object.assign(values, preset.values);
  const available = new Set(parts);
  if (!available.has('eye_smile')) {
    values.eyeWinkL = available.has('eye_close') ? values.eyeSmileL : 0;
    values.eyeWinkR = available.has('eye_close') ? values.eyeSmileR : 0;
    values.eyeSmile = values.eyeSmileL = values.eyeSmileR = 0;
  }
  if (!available.has('mouth_round')) values.expressionMouthOpen = (values.mouthRound || 0) * 0.75;
  for (const [key, part] of [['eyeSurprised','eyes_surprised'],['eyeShy','eyes_shy'],['eyeFlustered','eyes_flustered'],['eyeHalf','eyes_half'],['eyeSad','eyes_sad'],['eyeAngry','eyes_angry'],['mouthFrown','mouth_frown'],['blush','blush'],['tears','tears'],['sweat','sweat'],['angerMark','anger_mark'],['mouthLaugh','mouth_laugh'],['mouthRound','mouth_round']]) {
    if (!available.has(part)) values[key] = 0;
  }
  return values;
}
