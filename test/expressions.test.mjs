import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { buildPsd } from '../src/psd.mjs';
import { runQa } from '../src/qa.mjs';
import { expressions, requestedExpressions, validateExpressions } from '../src/expressions.mjs';
import { loadLayerMap, PROJECT_ROOT, readJson, STATE_ROOT } from '../src/utils.mjs';

const definitions = () => readJson(path.join(PROJECT_ROOT, 'configs/expressions.json'));
function pythonValidation(config, map) {
  return spawnSync('python3', ['-c',
    'import json,sys; sys.path.insert(0,"scripts"); from expression_definitions import validate_expressions; c,m=json.load(sys.stdin); print(json.dumps(validate_expressions(c,m)))'],
  { cwd: PROJECT_ROOT, input: JSON.stringify([config, map]), encoding: 'utf8' });
}

test('Python and Node resolve the same expression definitions from the layer map', () => {
  const result = pythonValidation(definitions(), loadLayerMap());
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), expressions);
  assert.deepEqual(requestedExpressions.map(item => item.name), ['eye_close', 'mouth_open']);
  assert.deepEqual(expressions.filter(item => item.requiredForProduction).map(item => item.name), ['eye_close', 'mouth_open']);
  assert.deepEqual(expressions.find(item => item.name === 'mouth_close').sources, ['mouth_close.png', 'mouth.png']);
  const map = loadLayerMap();
  map.layers.filter(item => item.target === 'eye_close').forEach(item => { item.requiredForProduction = false; });
  assert.equal(validateExpressions(definitions(), map)[0].requiredForProduction, false);
});

test('both readers reject unknown fields, missing fields, unsafe names and invalid nested types', () => {
  const changes = [
    c => { c.unknown = true; }, c => { c.schemaVersion = 2; }, c => { c.expressions = []; },
    c => { c.expressions.push(c.expressions[0]); }, c => { c.expressions.shift(); }, c => { c.expressions[0].unknown = true; },
    c => { c.expressions[0].requiredForProduction = true; }, c => { delete c.expressions[0].label; },
    c => { c.expressions[0].name = 'unknown'; }, c => { c.expressions[0].name = '../eye_close'; },
    c => { c.expressions[0].label = false; }, c => { c.expressions[0].label = ''; },
    c => { c.expressions[0].editableLayers = ['unknown']; }, c => { c.expressions[0].editableLayers = [1]; },
    c => { c.expressions[0].editableLayers = ['face', 'face']; },
    c => { c.expressions[0].extraction = 'thin'; }, c => { c.expressions[0].registration = 'unknown'; },
    c => { c.expressions[0].protectedCheck = 'unknown'; }, c => { delete c.expressions[0].protectedCheck; }, c => { c.expressions[0].split = 1; }, c => { c.expressions[0].checkFrontHair = 1; },
    c => { c.expressions[0].placeholderFrom = 'unknown'; }, c => { c.expressions[0].placeholderFrom = 'eye_close'; },
    c => { c.expressions[0].mask.unknown = true; }, c => { c.expressions[0].mask.dilationRatio = '0.04'; },
    c => { c.expressions[0].mask.dilationRatio = true; }, c => { c.expressions[0].mask.dilationRatio = -0.1; },
    c => { c.expressions[0].mask.minimumDilation = 0.5; }, c => { c.expressions[0].mask.minimumDilation = true; },
    c => { c.expressions[0].mask.fillBounds = 1; }, c => { c.expressions[0].prompt = null; },
    c => { c.expressions[2].extraction = 'diff'; }, c => { c.expressions[0].requestLabel = null; },
  ];
  for (const [index, change] of changes.entries()) {
    const config = definitions(); change(config);
    assert.throws(() => validateExpressions(config, loadLayerMap()), undefined, `Node case ${index}`);
    assert.notEqual(pythonValidation(config, loadLayerMap()).status, 0, `Python case ${index}`);
  }
});

test('a temporary expression definition produces a masked request without changing application code', () => {
  fs.mkdirSync(STATE_ROOT, { recursive: true });
  const root = fs.mkdtempSync(path.join(STATE_ROOT, 'test-expression-definition-'));
  try {
    const result = spawnSync('python3', ['-c', `
import json,sys
from pathlib import Path
sys.path.insert(0,"scripts")
from expression_definitions import load_expressions
from build_expression_requests import build_requests
from PIL import Image
root=Path(sys.argv[1]).resolve(); layers=root/"layers"
layers.mkdir()
for name in ("face", "eyewhite", "irides", "eyelash", "mouth"):
    Image.new("RGBA",(32,32),(20,30,40,255)).save(layers/(name+".png"))
mapping=json.loads(Path("configs/layer-map.json").read_text())
mapping["layers"].insert(-2,{"source":"test_expression.png","target":"test_expression"})
config=json.loads(Path("configs/expressions.json").read_text())
dummy={**config["expressions"][0],"name":"test_expression","label":"確認用の表情","registration":"none","split":False}
config["expressions"].append(dummy)
map_file=root/"layer-map.json"; map_file.write_text(json.dumps(mapping))
definition_file=root/"expressions.json"; definition_file.write_text(json.dumps(config))
definitions=load_expressions(mapping,definition_file)
report=build_requests("synthetic-definition",layers,map_file,root/"requests",definitions,only="eye_close,mouth_open,test_expression")
print(json.dumps({"variants":list(report["variants"]),"required":definitions[-1]["requiredForProduction"]}))
`, path.relative(PROJECT_ROOT, root)], { cwd: PROJECT_ROOT, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { variants: ['eye_close', 'mouth_open', 'test_expression'], required: false });
    assert.ok(fs.existsSync(path.join(root, 'requests/test_expression/mask.png')));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('additional eye definitions use the same registration check without changing existing report fields', () => {
  fs.mkdirSync(STATE_ROOT, { recursive: true });
  const root = fs.mkdtempSync(path.join(STATE_ROOT, 'test-expression-registration-'));
  const count = expressions.length;
  const python = (...args) => {
    const result = spawnSync('python3', args, { cwd: PROJECT_ROOT, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  };
  try {
    const layerDir = path.join(root, 'layers');
    python('test/generate_fixture.py', '--output', layerDir);
    const psdFile = path.join(root, 'fixture.psd');
    const buildReportFile = path.join(root, 'build-report.json');
    const reportFile = path.join(root, 'qa-report.json');
    buildPsd({ layerDir, output: psdFile, reportFile: buildReportFile });
    const config = definitions(), map = loadLayerMap();
    config.expressions.push({ ...config.expressions[0], name: 'test_eye', label: 'Test eyes' });
    map.layers.push({ source: 'test_eye.png', target: 'test_eye' });
    expressions.push(validateExpressions(config, map).at(-1));
    fs.copyFileSync(path.join(layerDir, 'eye_close.png'), path.join(layerDir, 'test_eye.png'));
    const registered = runQa({ psdFile, layerDir, buildReportFile, reportFile });
    assert.equal(registered.registration.additionalExpressions.test_eye.pass, true);
    assert.equal(registered.registration.checks.eyesHorizontallyRegistered, true);
    python('-c', 'from PIL import Image; import sys; im=Image.open(sys.argv[1]); im.transform(im.size,Image.Transform.AFFINE,(1,0,-24,0,1,0)).save(sys.argv[1])', path.join(layerDir, 'test_eye.png'));
    const shifted = runQa({ psdFile, layerDir, buildReportFile, reportFile });
    assert.equal(shifted.registration.additionalExpressions.test_eye.pass, false);
    assert.equal(shifted.registration.checks.eyesHorizontallyRegistered, true);
  } finally {
    expressions.length = count;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
