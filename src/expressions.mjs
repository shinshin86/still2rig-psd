import definitions from '../configs/expressions.json' with { type: 'json' };
import layerMap from '../configs/layer-map.json' with { type: 'json' };

const keys = ['name', 'label', 'requestLabel', 'prompt', 'editableLayers', 'mask', 'extraction', 'registration', 'split', 'placeholderFrom', 'checkFrontHair'];
const maskKeys = ['dilationRatio', 'minimumDilation', 'fillBounds', 'mouthLimits'];
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const exactKeys = (value, expected) => record(value) && Object.keys(value).length === expected.length && expected.every(key => Object.hasOwn(value, key));
const text = value => typeof value === 'string' && value.trim().length > 0;

export function validateExpressions(config, map) {
  const fail = () => { throw new Error('Invalid expression definitions. Check names, fields and types against the layer map.'); };
  if (!exactKeys(config, ['schemaVersion', 'expressions']) || config.schemaVersion !== 1 || !Array.isArray(config.expressions) || !config.expressions.length) fail();
  const targets = new Set(map.layers.map(entry => entry.target));
  const names = new Set();
  for (const item of config.expressions) {
    if (!exactKeys(item, keys) || !text(item.name) || !/^[a-z][a-z0-9_]*$/.test(item.name) || !targets.has(item.name) || names.has(item.name)
        || !text(item.label) || !Array.isArray(item.editableLayers) || item.editableLayers.some(name => !targets.has(name))
        || new Set(item.editableLayers).size !== item.editableLayers.length || !['eyes', 'mouth', 'none'].includes(item.registration)
        || typeof item.split !== 'boolean' || typeof item.checkFrontHair !== 'boolean'
        || !(item.placeholderFrom === null || (targets.has(item.placeholderFrom) && item.placeholderFrom !== item.name))) fail();
    if (item.prompt === null) {
      if (item.requestLabel !== null || item.mask !== null || item.extraction !== null || item.editableLayers.length) fail();
    } else {
      const mask = item.mask;
      if (!text(item.prompt) || !text(item.requestLabel) || !item.editableLayers.length || item.extraction !== 'diff'
          || !exactKeys(mask, maskKeys) || typeof mask.dilationRatio !== 'number' || !Number.isFinite(mask.dilationRatio) || mask.dilationRatio < 0 || mask.dilationRatio > 1
          || !Number.isInteger(mask.minimumDilation) || mask.minimumDilation < 0 || mask.minimumDilation > 128
          || typeof mask.fillBounds !== 'boolean' || typeof mask.mouthLimits !== 'boolean') fail();
    }
    names.add(item.name);
  }
  if (map.layers.some(entry => entry.requiredForProduction === true && !names.has(entry.target))) fail();
  return config.expressions.map(item => ({ ...item,
    editableLayers: [...item.editableLayers], mask: item.mask ? { ...item.mask } : null,
    sources: [...map.layers].reverse().filter(entry => entry.target === item.name).map(entry => entry.source),
    requiredForProduction: map.layers.some(entry => entry.target === item.name && entry.requiredForProduction === true),
  }));
}

export const expressions = validateExpressions(definitions, layerMap);
export const requestedExpressions = expressions.filter(item => item.prompt !== null);
