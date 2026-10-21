import { expressionParameterNames, expressionPresetValues, expressionPresets } from '../../src/expressionPresets.mjs';

export const expressionPartCases = [
  ...['browWorry', 'browAngry', 'browFlat', 'upperLid', 'eyeWide', 'eyeNarrow', 'eyeWinkL', 'eyeWinkR', 'eyeSmileL', 'eyeSmileR', 'tears', 'sweat', 'angerMark'].map(key => ({ id: key, values: t => ({ [key]: t }) })),
  { id: 'lidTilt-inward', values: t => ({ upperLid: 0.7, lidTilt: t }) },
  { id: 'lidTilt-outward', values: t => ({ upperLid: 0.7, lidTilt: -t }) },
  { id: 'mouth-up', values: t => ({ mouthForm: t }) },
  { id: 'mouth-down', values: t => ({ mouthForm: -t }) },
];
export const expressionTransitionPairs = [['neutral','joy'],['joy','neutral'],['neutral','shy'],['shy','neutral'],['neutral','angry'],['angry','neutral'],['neutral','sad'],['sad','neutral'],['neutral','surprised'],['surprised','neutral'],['neutral','flustered'],['flustered','neutral'],['neutral','unamused'],['unamused','neutral'],['neutral','wink'],['wink','neutral'],['joy','angry'],['sad','surprised'],['wink','joy'],['unamused','surprised']];

/** Official renderer captures, shared by motion QA and close-up inspection. */
export async function captureExpressionSet({ page, capture, parts, settleMs = 350, partSteps = 20, pairs = expressionTransitionPairs, cases = expressionPartCases }) {
  const base = expressionPresetValues('neutral', parts), captures = {};
  const state = async (values, eye = 1, waitMs = settleMs) => {
    await page.evaluate(({ values, eye }) => window.rigQa.setState(eye, 0, values), { values: { ...base, ...values }, eye });
    await page.waitForTimeout(waitMs);
  };
  for (const item of cases) {
    const name = `part-${item.id}`; captures[name] = [];
    for (let i = 0; i <= partSteps; i++) {
      const t = i / partSteps; await state(item.values(t));
      captures[name].push(await capture(name, `strength-${t.toFixed(2)}`));
    }
  }
  for (const preset of expressionPresets) {
    const name = `preset-${preset.id}`; captures[name] = [];
    for (const eye of [1, 0.5, 0]) {
      // Let the preceding full blink settle before comparing eye pixels.
      await state(expressionPresetValues(preset.id, parts), eye, eye === 1 ? Math.max(settleMs, 1200) : settleMs);
      captures[name].push(await capture(name, `eye-${eye.toFixed(2)}`));
    }
  }
  for (const [from, to] of pairs) {
    const start = expressionPresetValues(from, parts), end = expressionPresetValues(to, parts);
    const name = `transition-${from}-${to}`; captures[name] = [];
    for (const t of [0, 0.25, 0.5, 0.75, 1]) {
      await state(Object.fromEntries(expressionParameterNames.map(key => [key, start[key] + (end[key] - start[key]) * t])));
      captures[name].push(await capture(name, `progress-${t.toFixed(2)}`));
    }
  }
  await state({});
  return captures;
}
