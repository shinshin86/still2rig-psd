import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, test } from 'node:test';
import { inspectPsd, readPngRgba } from '../src/psd.mjs';
import { PROJECT_ROOT, STATE_ROOT, sha256File } from '../src/utils.mjs';
const roots = [];
function run(...args) {
  return spawnSync(process.execPath, ['bin/still2rig-psd.mjs', ...args], { cwd: PROJECT_ROOT, encoding: 'utf8', maxBuffer: 25 * 1024 * 1024 });
}
function ok(...args) {
  const result = run(...args);
  assert.equal(result.status, 0, result.stderr + (result.status === 0 ? "" : result.stdout));
  return JSON.parse(result.stdout);
}
function python(...args) {
  const result = spawnSync('python3', args, { cwd: PROJECT_ROOT, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}
function fixture() {
  fs.mkdirSync(STATE_ROOT, { recursive: true });
  const root = fs.mkdtempSync(path.join(STATE_ROOT, 'test-additional-'));
  roots.push(root);
  const layers = path.join(root, 'layers');
  python('test/generate_fixture.py', '--output', layers, '--without-expressions');
  python('-c', 'from PIL import Image,ImageDraw; import sys; im=Image.new("RGBA",(96,96)); d=ImageDraw.Draw(im); d.rectangle((31,30,43,33),fill=(70,30,20,255)); d.rectangle((53,30,65,33),fill=(70,30,20,255)); im.save(sys.argv[1])', path.join(layers, 'eyelash.png'));
  python('-c', 'from PIL import Image,ImageDraw; import sys; im=Image.new("RGBA",(96,96)); ImageDraw.Draw(im).rectangle((20,5,76,20),fill=(85,45,25,255)); im.save(sys.argv[1])', path.join(layers, 'front hair.png'));
  const id = `additional-${process.pid}-${Date.now()}`;
  const job = ok('prepare', path.join(layers, 'face.png'), '--name', id);
  const jobRoot = path.join(STATE_ROOT, 'jobs', id); roots.push(jobRoot);
  const archive = path.join(root, 'fixture.zip');
  python('test/make_result_bundle.py', '--layers', layers, '--archive', archive, '--input-sha256', job.input.sha256, '--job', id);
  ok('import', id, archive); ok('finalize', id);
  const requests = path.join(jobRoot, 'expression-requests');
  return { root, layers, id, jobRoot, requests, results: path.join(requests, 'results') };
}
function edit(f, mode) { python('test/edit_expression_fixture.py', f.requests, f.results, mode); }
function nativeAlpha(file) { return Array.from(readPngRgba(file).data).filter((_, i) => i % 4 === 3); }
afterEach(() => { while (roots.length) fs.rmSync(roots.pop(), { recursive: true, force: true }); });

test('requests preserve the default pair and select additional expressions with their own masks', () => {
  const f = fixture();
  ok('expression-requests', f.id);
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(path.join(f.requests, 'requests.json'))).variants), ['eye_close', 'mouth_open']);
  ok('expression-requests', f.id, '--only', 'all');
  const variants = JSON.parse(fs.readFileSync(path.join(f.requests, 'requests.json'))).variants;
  assert.deepEqual(Object.keys(variants), ['eye_close', 'mouth_open', 'eye_smile', 'blush', 'tears', 'sweat', 'anger_mark']);
  assert.deepEqual(variants.eye_smile.protectedFeatures, { layers: ['eyebrow', 'front hair'], paddingPx: 4 });
  assert.ok(variants.eye_smile.editableBox[1] < variants.eye_close.editableBox[1]);
  const mask = readPngRgba(path.join(f.requests, 'blush/mask.png'));
  assert.ok(Array.from(mask.data).some((value, i) => i % 4 === 3 && value > 0 && value < 255));
  assert.match(run('expression-requests', f.id, '--only', 'blush,unknown').stderr, /Choose known expressions/);
  assert.match(run('expression-requests', f.id, '--only', 'blush,blush').stderr, /Choose known expressions/);
  assert.match(run('expression-requests', f.id, '--only', 'mouth_close').stderr, /Choose known expressions/);
});

test('additional imports keep the original artwork and thin blush survives repair and PSD assembly', () => {
  const f = fixture();
  ok('expression-requests', f.id); edit(f, 'artwork');
  const original = ok('import-expressions', f.id);
  const directory = path.join(PROJECT_ROOT, original.outputDir);
  const before = ['eye_close.png', 'mouth_open.png'].map(name => sha256File(path.join(directory, name)));
  const baseRepair = ok('repair', f.id, '--expressions', original.outputDir);
  assert.equal(baseRepair.qa.productionReady, true);
  ok('expression-requests', f.id, '--only', 'eye_smile,blush'); edit(f, 'additional-faint');
  const imported = ok('import-expressions', f.id, '--protected-check', 'strict');
  assert.deepEqual(imported.accepted, ['eye_smile', 'blush']);
  assert.deepEqual(['eye_close.png', 'mouth_open.png'].map(name => sha256File(path.join(directory, name))), before);
  const partial = path.join(f.root, 'additional-only'); fs.mkdirSync(partial);
  for (const name of ['eye_smile', 'blush']) fs.copyFileSync(path.join(directory, `${name}.png`), path.join(partial, `${name}.png`));
  const repaired = ok('repair', f.id, '--expressions', partial);
  assert.equal(repaired.qa.productionReady, true);
  assert.equal(repaired.expressionProvenance.eye_close.inheritedFromRepair, baseRepair.repairId);
  assert.equal(repaired.expressionProvenance.eye_close.kind, 'supplied-artwork');
  for (const name of ['eye_close.png', 'mouth_open.png']) assert.deepEqual(readPngRgba(path.join(f.jobRoot, 'repairs', repaired.repairId, 'after/processed/layers', name)).data, readPngRgba(path.join(directory, name)).data);
  for (const name of ['eye_smile', 'blush']) assert.equal(repaired.qa.registration.additionalExpressions[name].pass, true);
  const alpha = nativeAlpha(path.join(f.jobRoot, 'repairs', repaired.repairId, 'after/processed/layers/blush.png'));
  assert.ok(Math.max(...alpha) > 0 && Math.max(...alpha) <= 16);
  assert.ok(inspectPsd(path.join(f.jobRoot, 'output', `${f.id}.psd`)).layers.some(item => item.name === 'blush'));
  assert.ok(repaired.build.layerOrder.indexOf('blush') < repaired.build.layerOrder.indexOf('mouth_close'));
  assert.ok(repaired.build.layerOrder.indexOf('eye_smile') < repaired.build.layerOrder.indexOf('front hair'));
  const derived = ok('derive-expressions', f.id);
  assert.ok(!fs.existsSync(path.join(PROJECT_ROOT, derived.outputDir, 'eye_smile.png')));
  assert.ok(!fs.existsSync(path.join(PROJECT_ROOT, derived.outputDir, 'blush.png')));
});

test('partial repair snapshots preserve drawn and derived artwork and explicit removal still clears it', () => {
  const f = fixture();
  const derived = ok('derive-expressions', f.id);
  const preview = ok('repair', f.id, '--preview-expressions', derived.outputDir);
  ok('expression-requests', f.id, '--only', 'blush'); edit(f, 'additional');
  const imported = ok('import-expressions', f.id);
  const partial = path.join(f.root, 'blush-only'); fs.mkdirSync(partial);
  fs.copyFileSync(path.join(PROJECT_ROOT, imported.outputDir, 'blush.png'), path.join(partial, 'blush.png'));
  const repaired = ok('repair', f.id, '--expressions', partial);
  assert.equal(repaired.qa.productionReady, false);
  assert.deepEqual(repaired.build.previewExpressions.map(item => item.layer), ['eye_close', 'mouth_open']);
  assert.equal(repaired.expressionProvenance.eye_close.kind, 'derived-preview');
  assert.equal(repaired.expressionProvenance.eye_close.inheritedFromRepair, preview.repairId);
  assert.equal(repaired.expressionProvenance.blush.kind, 'supplied-artwork');
  const again = ok('repair', f.id);
  assert.equal(again.qa.productionReady, false);
  assert.equal(again.expressionProvenance.eye_close.kind, 'derived-preview');
  assert.equal(again.expressionProvenance.eye_close.inheritedFromRepair, repaired.repairId);
  const removed = ok('repair', f.id, '--no-expressions');
  assert.equal(removed.build.layerOrder.includes('blush'), false);
  assert.equal(removed.build.layerOrder.includes('eye_close'), false);
});

test('soft import rejects protected edits and caps opacity without affecting base production readiness', () => {
  const f = fixture();
  ok('expression-requests', f.id); edit(f, 'artwork');
  const original = ok('import-expressions', f.id);
  ok('repair', f.id, '--expressions', original.outputDir);
  ok('expression-requests', f.id, '--only', 'blush'); edit(f, 'additional-outside');
  assert.notEqual(run('import-expressions', f.id, '--protected-check', 'strict').status, 0);
  edit(f, 'additional-strong');
  const imported = ok('import-expressions', f.id, '--protected-check', 'strict');
  assert.ok(Math.max(...nativeAlpha(path.join(PROJECT_ROOT, imported.outputDir, 'blush.png'))) <= 153);
  const bad = path.join(f.root, 'bad-art'); fs.mkdirSync(bad);
  python('-c', 'from PIL import Image; import sys; im=Image.new("RGBA",(96,96)); im.putpixel((0,0),(255,0,0,255)); im.putpixel((35,34),(255,0,0,255)); im.save(sys.argv[1])', path.join(bad, 'blush.png'));
  const repaired = ok('repair', f.id, '--expressions', bad);
  const detail = repaired.qa.registration.additionalExpressions.blush;
  assert.equal(detail.pass, false);
  assert.equal(detail.checks.insideFace, false);
  assert.equal(detail.checks.opacityWithinLimit, false);
  assert.equal(detail.checks.avoidsEyesAndMouth, false);
  assert.equal(repaired.qa.productionReady, true);
});

test('soft extraction reconstructs faint color changes and does not retain neutral noise', () => {
  const result = JSON.parse(python('-c', `
import json,sys
sys.path.insert(0,"scripts")
from PIL import Image
from soft_expression import extract_soft_artwork
base=Image.new("RGBA",(3,1),(250,205,175,255)); changed=base.copy()
changed.putpixel((0,0),(250,201,173,255)); changed.putpixel((1,0),(249,204,174,255))
mask=Image.new("L",(3,1),255)
art,report=extract_soft_artwork(changed,base,mask)
composite=Image.alpha_composite(base,art)
print(json.dumps({"alpha":[art.getpixel((x,0))[3] for x in range(3)],"error":max(abs(composite.getpixel((0,0))[c]-changed.getpixel((0,0))[c]) for c in range(3)),"maximum":report["maximumAlpha"]}))
`));
  assert.ok(result.alpha[0] > 0 && result.alpha[0] <= 16);
  assert.deepEqual(result.alpha.slice(1), [0, 0]);
  assert.ok(Math.abs(result.error) <= 1);
  assert.equal(result.maximum, 0.6);
});


test('seam defaults and strict overrides export read-only previews without changing job files', () => {
  const f = fixture();
  ok('expression-requests', f.id, '--only', 'blush'); edit(f, 'additional-faint');
  const protectedFiles = ['job.json', 'output/' + f.id + '.psd', 'expression-requests/requests.json'];
  const before = protectedFiles.map(file => sha256File(path.join(f.jobRoot, file)));
  const preview = path.join(f.root, 'preview');
  const seam = ok('import-expressions', f.id, '--read-only', '--preview-dir', preview);
  assert.equal(seam.variants.blush.protectedCheck, 'seam');
  assert.equal(seam.variants.blush.seam.pass, true);
  assert.equal(seam.variants.blush.status, 'accepted');
  assert.ok(fs.existsSync(path.join(PROJECT_ROOT, seam.variants.blush.preview.composite)));
  assert.ok(!fs.existsSync(path.join(f.jobRoot, 'generated-expressions')));
  const strict = run('import-expressions', f.id, '--read-only', '--protected-check', 'strict');
  assert.equal(strict.status, 0, strict.stderr + strict.stdout);
  assert.equal(JSON.parse(strict.stdout).variants.blush.protectedCheck, 'strict');
  assert.deepEqual(protectedFiles.map(file => sha256File(path.join(f.jobRoot, file))), before);
  for (const args of [['--protected-check', 'other'], ['--preview-dir', preview],
    ['--read-only', '--preview-dir', f.jobRoot]]) assert.notEqual(run('import-expressions', f.id, ...args).status, 0);
});


test('smiling eyes contained inside the boundary bands pass the default seam check', () => {
  const f = fixture();
  ok('expression-requests', f.id, '--only', 'eye_smile');
  python('-c', `import json,sys
from pathlib import Path
from PIL import Image, ImageDraw
root=Path(sys.argv[1]); item=json.loads((root/'requests.json').read_text())['variants']['eye_smile']
s=item['scale']; left,top,_,_=item['cropBox']
im=Image.open(root/'eye_smile/underlay.png').convert('RGBA'); d=ImageDraw.Draw(im)
for cx in (37,59):
    d.line([((cx-3-left)*s,(35-top)*s),((cx-left)*s,(33-top)*s),((cx+3-left)*s,(35-top)*s)],fill=(80,30,25,255),width=s)
(root/'results').mkdir(exist_ok=True); im.save(root/'results/eye_smile.png')`, f.requests);
  const report = ok('import-expressions', f.id, '--read-only');
  assert.equal(report.variants.eye_smile.seam.pass, true);
  assert.ok(report.variants.eye_smile.artworkPixels > 0);
});
