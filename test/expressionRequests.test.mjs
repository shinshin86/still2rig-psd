import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, test } from 'node:test';
import { readPngRgba } from '../src/psd.mjs';
import { readPsd, writePsdBuffer } from 'ag-psd';
import { PROJECT_ROOT, STATE_ROOT } from '../src/utils.mjs';

const roots = [];

function run(...args) {
  return spawnSync(process.execPath, [path.join(PROJECT_ROOT, 'bin', 'still2rig-psd.mjs'), ...args], {
    cwd: PROJECT_ROOT, encoding: 'utf8', maxBuffer: 20 * 1024 * 1024,
  });
}

function ok(...args) {
  const result = run(...args);
  const report = path.join(STATE_ROOT, 'jobs', args[1] || '', 'generated-expressions', 'report.json');
  assert.equal(result.status, 0, result.stderr + (result.status !== 0 && fs.existsSync(report) ? fs.readFileSync(report, 'utf8') : ''));
  return JSON.parse(result.stdout);
}

function python(script, ...args) {
  const result = spawnSync('python3', [path.join(PROJECT_ROOT, 'test', script), ...args], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
}

function fixture(...args) {
  fs.mkdirSync(STATE_ROOT, { recursive: true });
  const fixtureRoot = fs.mkdtempSync(path.join(STATE_ROOT, 'test-expression-'));
  roots.push(fixtureRoot);
  const layers = path.join(fixtureRoot, 'layers');
  python('generate_fixture.py', '--output', layers, '--without-expressions', ...args);
  const id = `expressions-${process.pid}-${Date.now()}`;
  const job = ok('prepare', path.join(layers, 'face.png'), '--name', id);
  const root = path.join(STATE_ROOT, 'jobs', id);
  roots.push(root);
  const archive = path.join(fixtureRoot, 'fixture.zip');
  python('make_result_bundle.py', '--layers', layers, '--archive', archive, '--input-sha256', job.input.sha256, '--job', id);
  ok('import', id, archive);
  ok('finalize', id);
  const requestDir = path.join(root, 'expression-requests');
  return { id, root, layers, requestDir, resultDir: path.join(requestDir, 'results') };
}

afterEach(() => {
  while (roots.length) fs.rmSync(roots.pop(), { recursive: true, force: true });
});

test('requests use the current neutral PSD canvas, face crops, alpha masks and relative provenance', () => {
  const f = fixture();
  // Source dimensions intentionally differ, as they do after See-through padding.
  const resized = spawnSync('python3', ['-c', 'from PIL import Image; import sys; p=sys.argv[1]; Image.open(p).resize((60,80)).save(p)', path.join(f.root, 'input', 'source.png')]);
  assert.equal(resized.status, 0);
  const result = ok('expression-requests', f.id);
  assert.deepEqual(result.canvas, [96, 96]);
  assert.match(result.next, /expression-candidates/);
  const requests = JSON.parse(fs.readFileSync(path.join(f.requestDir, 'requests.json')));
  assert.equal(requests.schemaVersion, 2);
  assert.equal(requests.jobId, f.id);
  assert.match(requests.layerSha256, /^[0-9a-f]{64}$/);
  assert.ok(!path.isAbsolute(requests.layerDir));
  for (const name of ['eye_close', 'mouth_open']) {
    const item = requests.variants[name];
    const input = readPngRgba(path.join(f.requestDir, item.input));
    const mask = readPngRgba(path.join(f.requestDir, item.mask));
    assert.deepEqual([input.width, input.height], item.size);
    assert.equal(input.width, (item.cropBox[2] - item.cropBox[0]) * item.scale);
    assert.equal(input.height, (item.cropBox[3] - item.cropBox[1]) * item.scale);
    assert.equal(item.scale, Math.min(4, Math.ceil(1024 / Math.max(item.cropBox[2] - item.cropBox[0], item.cropBox[3] - item.cropBox[1]))));
    assert.deepEqual([mask.width, mask.height], item.size);
    const alphas = Array.from(mask.data).filter((_, index) => index % 4 === 3);
    assert.ok(alphas.includes(0) && alphas.includes(255));
    assert.ok(fs.existsSync(path.join(f.requestDir, item.prompt)));
    assert.ok(fs.existsSync(path.join(f.requestDir, item.underlay)));
    assert.equal(item.result, `results/${name}.png`);
    // The input must show the neutral closed mouth on the PSD's canvas.
    const mouth = readPngRgba(path.join(f.root, 'processed', 'layers', 'mouth.png'));
    for (let y = 0; y < mouth.height; y += 1) {
      for (let x = 0; x < mouth.width; x += 1) {
        const offset = (y * mouth.width + x) * 4;
        if (mouth.data[offset + 3] !== 255) continue;
        const cropOffset = (((y - item.cropBox[1]) * item.scale + Math.floor(item.scale / 2)) * input.width
          + (x - item.cropBox[0]) * item.scale + Math.floor(item.scale / 2)) * 4;
        assert.equal(input.data[cropOffset + 3], 255);
        for (let c = 0; c < 3; c += 1) assert.ok(Math.abs(input.data[cropOffset + c] - mouth.data[offset + c]) <= 40);
      }
    }
  }
  assert.match(fs.readFileSync(path.join(f.requestDir, 'README.md'), 'utf8'), /permission/);
});

test('drops skin matching the underlay and keeps only registered mouth and eyelid artwork through QA', () => {
  const f = fixture();
  ok('expression-requests', f.id);
  python('edit_expression_fixture.py', f.requestDir, f.resultDir, 'artwork');
  const imported = ok('import-expressions', f.id);
  for (const name of imported.accepted) {
    const output = readPngRgba(path.join(PROJECT_ROOT, imported.outputDir, `${name}.png`));
    let visible = 0;
    for (let y = 0; y < 96; y += 1) {
      for (let x = 0; x < 96; x += 1) {
        const ink = name === 'mouth_open'
          ? x >= 42 && x <= 54 && y >= 49 && y <= 54
          : ((x >= 31 && x <= 43) || (x >= 53 && x <= 65)) && y >= 33 && y <= 36;
        const alpha = output.data[(y * 96 + x) * 4 + 3];
        const nearInk = name === 'mouth_open'
          ? x >= 41 && x <= 55 && y >= 48 && y <= 55
          : ((x >= 30 && x <= 44) || (x >= 52 && x <= 66)) && y >= 32 && y <= 37;
        if (ink) assert.ok(alpha >= 200, `${name} ink ${x},${y}`);
        if (!nearInk) assert.ok(alpha <= 16, `${name} skin ${x},${y}`);
        if (alpha > 16) visible += 1;
      }
    }
    const expected = name === 'mouth_open' ? 78 : 104;
    assert.ok(visible >= expected && visible <= expected * 1.5);
  }
  const repaired = ok('repair', f.id, '--expressions', imported.outputDir);
  assert.equal(repaired.qa.checks.expressionArtwork, true);
  assert.equal(repaired.qa.checks.expressionRegistration, true);
  assert.equal(repaired.qa.productionReady, true);
});

test('excludes overlapping front hair and headwear from requests and imported eyelids', () => {
  const f = fixture('--hair-over-eyes');
  assert.ok(fs.existsSync(path.join(f.root, 'processed', 'layers', 'headwear.png')));
  ok('expression-requests', f.id);
  const requests = JSON.parse(fs.readFileSync(path.join(f.requestDir, 'requests.json')));
  const item = requests.variants.eye_close;
  const input = readPngRgba(path.join(f.requestDir, item.input));
  const index = (((34 - item.cropBox[1]) * item.scale + 2) * input.width + (37 - item.cropBox[0]) * item.scale + 2) * 4;
  assert.deepEqual(Array.from(input.data.slice(index, index + 4)), [30, 120, 150, 255]);
  const underlay = readPngRgba(path.join(f.requestDir, item.underlay));
  assert.deepEqual(Array.from(underlay.data.slice(index, index + 4)), [250, 205, 175, 255]);
  python('edit_expression_fixture.py', f.requestDir, f.resultDir, 'artwork');
  const imported = ok('import-expressions', f.id);
  const eye = readPngRgba(path.join(PROJECT_ROOT, imported.outputDir, 'eye_close.png'));
  for (let offset = 0; offset < eye.data.length; offset += 4) {
    if (eye.data[offset + 3] > 250) for (let c = 0; c < 3; c += 1) assert.ok(Math.abs(eye.data[offset + c] - [80, 30, 25][c]) < 5);
  }
});

test('removes isolated speckles and uses configurable soft alpha for low-contrast edges', () => {
  const f = fixture();
  ok('expression-requests', f.id);
  python('edit_expression_fixture.py', f.requestDir, f.resultDir, 'speckle');
  const filtered = ok('import-expressions', f.id);
  assert.equal(filtered.variants.eye_close.removedNoisePixels, 16);
  assert.equal(filtered.variants.mouth_open.removedNoisePixels, 16);
  python('edit_expression_fixture.py', f.requestDir, f.resultDir, 'soft');
  const imported = ok('import-expressions', f.id);
  const mouth = readPngRgba(path.join(PROJECT_ROOT, imported.outputDir, 'mouth_open.png'));
  const alpha = mouth.data[(48 * 96 + 48) * 4 + 3];
  assert.ok(alpha > 0 && alpha < 255);
  ok('import-expressions', f.id, '--artwork-threshold', '20');
  const strict = readPngRgba(path.join(PROJECT_ROOT, imported.outputDir, 'mouth_open.png'));
  assert.ok(strict.data[(48 * 96 + 48) * 4 + 3] <= 20);
  assert.match(run('import-expressions', f.id, '--artwork-threshold', 'NaN').stderr, /Artwork threshold must be/);
  assert.match(run('import-expressions', f.id, '--minimum-component-pixels', '0').stderr, /at least 1/);
});

test('in-mask edits become full-canvas registered layers and still pass through existing QA', () => {
  const f = fixture();
  ok('expression-requests', f.id);
  python('edit_expression_fixture.py', f.requestDir, f.resultDir, 'inside');
  const imported = ok('import-expressions', f.id);
  assert.deepEqual(imported.accepted, ['eye_close', 'mouth_open']);
  assert.match(imported.next, /repair .* --expressions/);
  const requests = JSON.parse(fs.readFileSync(path.join(f.requestDir, 'requests.json')));
  for (const name of imported.accepted) {
    assert.equal(imported.variants[name].meanAbsoluteDiff, 0);
    const output = readPngRgba(path.join(PROJECT_ROOT, imported.outputDir, `${name}.png`));
    assert.deepEqual([output.width, output.height], [96, 96]);
    const item = requests.variants[name];
    const mask = readPngRgba(path.join(f.requestDir, item.mask));
    for (let y = 0; y < output.height; y += 1) {
      for (let x = 0; x < output.width; x += 1) {
        const cx = (x - item.cropBox[0]) * item.scale;
        const cy = (y - item.cropBox[1]) * item.scale;
        const allowed = cx >= 0 && cy >= 0 && cx < mask.width && cy < mask.height && mask.data[(cy * mask.width + cx) * 4 + 3] === 0;
        const alpha = output.data[(y * output.width + x) * 4 + 3];
        if (allowed) assert.ok(alpha >= 200);
        else assert.equal(alpha, 0);
      }
    }
  }
  const repaired = ok('repair', f.id, '--expressions', imported.outputDir);
  assert.equal(repaired.qa.checks.expressionRegistration, true);
  assert.equal(typeof repaired.qa.checks.expressionArtwork, 'boolean');
  assert.deepEqual(repaired.build.previewExpressions, []);
  // Synthetic filled masks are registered but too broad for the mouth artwork check.
  assert.equal(repaired.qa.productionReady, false);
});

for (const [mode, error] of [['outside', /outside the mask changed.*mean=.*p99=|global image misalignment/], ['aspect', /aspect ratio differs/]]) {
  test(`rejects ${mode} changes and leaves a failure report`, () => {
    const f = fixture();
    ok('expression-requests', f.id);
    python('edit_expression_fixture.py', f.requestDir, f.resultDir, mode);
    const result = run('import-expressions', f.id);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, error);
    const report = JSON.parse(fs.readFileSync(path.join(f.root, 'generated-expressions', 'report.json')));
    assert.equal(report.ok, false);
    assert.ok(!fs.existsSync(path.join(f.root, 'generated-expressions', 'eye_close.png')));
  });
}

test('accepts proportional resizing and reports small outside-mask recompression noise', () => {
  const f = fixture();
  ok('expression-requests', f.id);
  python('edit_expression_fixture.py', f.requestDir, f.resultDir, 'resize');
  const resized = ok('import-expressions', f.id);
  assert.equal(resized.variants.eye_close.resultSize[0], resized.variants.eye_close.inputSize[0] * 2);
  python('edit_expression_fixture.py', f.requestDir, f.resultDir, 'noise');
  const noisy = ok('import-expressions', f.id);
  assert.ok(noisy.variants.eye_close.meanAbsoluteDiff > 0);
  const strict = run('import-expressions', f.id, '--max-outside-mean', '0');
  assert.notEqual(strict.status, 0);
  assert.match(strict.stderr, /outside the mask changed/);
});

test('rejects stale layer hashes and uses the latest repair', () => {
  const f = fixture();
  ok('expression-requests', f.id);
  python('edit_expression_fixture.py', f.requestDir, f.resultDir, 'inside');
  ok('repair', f.id);
  assert.match(run('import-expressions', f.id).stderr, /Current layers changed.*Rerun expression-requests/);
  const request = ok('expression-requests', f.id);
  assert.match(request.layerDir, /repairs\/repair-001\/after\/processed\/layers$/);
  fs.appendFileSync(path.join(PROJECT_ROOT, request.layerDir, 'face.png'), Buffer.from('stale'));
  assert.match(run('import-expressions', f.id).stderr, /Current layers changed/);
});

test('neutral request compositing honors mouth_close overrides in the PSD layer map', () => {
  const f = fixture();
  const overrides = path.join(f.root, 'expression-overrides');
  fs.mkdirSync(overrides);
  // Valid closed-mouth ink replaces the source mouth via the normal repair path.
  const marker = spawnSync('python3', ['-c',
    'from PIL import Image, ImageDraw; import sys; im=Image.new("RGBA",(96,96)); ImageDraw.Draw(im).arc((40,46,56,55),10,170,fill=(12,34,56,255),width=3); im.save(sys.argv[1])',
    path.join(overrides, 'mouth_close.png')]);
  assert.equal(marker.status, 0);
  ok('repair', f.id, '--expressions', overrides);
  ok('expression-requests', f.id);
  const requests = JSON.parse(fs.readFileSync(path.join(f.requestDir, 'requests.json')));
  const item = requests.variants.mouth_open;
  const input = readPngRgba(path.join(f.requestDir, item.input));
  // Compare independently composed/resized pixels, including Lanczos ringing
  // around the thin ink, rather than expecting the native color to survive.
  const expectedFile = path.join(overrides, 'expected-input.png');
  const expected = spawnSync('python3', ['-c',
    'from PIL import Image; import json,sys; face=Image.open(sys.argv[1]).convert("RGBA"); mouth=Image.open(sys.argv[2]).convert("RGBA"); item=json.loads(sys.argv[3]); Image.alpha_composite(face,mouth).crop(tuple(item["cropBox"])).resize(tuple(item["size"]),Image.Resampling.LANCZOS).save(sys.argv[4])',
    path.join(f.layers, 'face.png'), path.join(overrides, 'mouth_close.png'), JSON.stringify(item), expectedFile]);
  assert.equal(expected.status, 0);
  const expectedInput = readPngRgba(expectedFile);
  const index = (((54 - item.cropBox[1]) * item.scale + 2) * input.width + (48 - item.cropBox[0]) * item.scale + 2) * 4;
  assert.deepEqual(Array.from(input.data.slice(index, index + 4)), Array.from(expectedInput.data.slice(index, index + 4)));
});

test('imports a single result from DIR and rejects modified request masks and invalid thresholds', () => {
  const f = fixture();
  ok('expression-requests', f.id);
  const alternate = path.join(f.root, 'alternate-results');
  python('edit_expression_fixture.py', f.requestDir, alternate, 'inside');
  fs.rmSync(path.join(alternate, 'mouth_open.png'));
  const imported = ok('import-expressions', f.id, alternate);
  assert.deepEqual(imported.accepted, ['eye_close']);
  assert.equal(imported.variants.mouth_open.status, 'missing');
  assert.match(run('import-expressions', f.id, alternate, '--max-outside-mean', 'NaN').stderr, /finite numbers/);
  fs.appendFileSync(path.join(f.requestDir, 'eye_close', 'mask.png'), Buffer.from('changed'));
  assert.match(run('import-expressions', f.id, alternate).stderr, /input, mask or underlay changed/);
  ok('expression-requests', f.id);
  fs.appendFileSync(path.join(f.requestDir, 'eye_close', 'underlay.png'), Buffer.from('changed'));
  assert.match(run('import-expressions', f.id, alternate).stderr, /input, mask or underlay changed/);
});

test('repair records and inherits overrides, resolves legacy records and supports explicit removal', () => {
  const f = fixture();
  const overrides = path.join(f.root, 'overrides');
  fs.mkdirSync(overrides);
  const changed = spawnSync('python3', ['-c',
    'from PIL import Image; import sys; im=Image.open(sys.argv[1]); r,g,b,a=im.split(); Image.merge("RGBA",(b,g,r,a)).save(sys.argv[2])',
    path.join(f.layers, 'topwear.png'), path.join(overrides, 'topwear.png')]);
  assert.equal(changed.status, 0);
  const first = ok('repair', f.id, '--layer-overrides', overrides);
  assert.match(first.options.layerOverrides, /\/overrides$/);
  const inherited = ok('repair', f.id, '--expressions', f.layers);
  assert.equal(inherited.inheritedOptions.fromRepair, first.repairId);
  assert.equal(inherited.options.expressions, path.relative(PROJECT_ROOT, f.layers));
  const currentTopwear = path.join(f.root, 'repairs', inherited.repairId, 'after', 'processed', 'layers', 'topwear.png');
  assert.deepEqual(readPngRgba(currentTopwear).data, readPngRgba(path.join(overrides, 'topwear.png')).data);
  const manifestFile = path.join(f.root, 'job.json');
  const manifest = JSON.parse(fs.readFileSync(manifestFile));
  delete manifest.result.repairs.at(-1).options;
  fs.writeFileSync(manifestFile, JSON.stringify(manifest));
  const legacy = ok('repair', f.id);
  assert.equal(legacy.inheritedOptions.legacy, true);
  fs.rmSync(path.join(overrides, 'topwear.png'));
  assert.match(run('repair', f.id).stderr, /Previous layer overrides are missing/);
  const cleared = ok('repair', f.id, '--no-layer-overrides', '--no-expressions');
  assert.equal(cleared.options.layerOverrides, null);
  assert.deepEqual(cleared.inheritedOptions, {});
  const rawTopwear = path.join(f.root, 'repairs', cleared.repairId, 'after', 'processed', 'layers', 'topwear.png');
  assert.deepEqual(readPngRgba(rawTopwear).data, readPngRgba(path.join(f.layers, 'topwear.png')).data);
});

for (const mode of ['shifted', 'scaled']) {
  test(`rejects globally ${mode} expression results`, () => {
    const f = fixture();
    ok('expression-requests', f.id);
    python('edit_expression_fixture.py', f.requestDir, f.resultDir, mode);
    const result = run('import-expressions', f.id);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /global image misalignment|outside the mask changed/);
    const report = JSON.parse(fs.readFileSync(path.join(f.root, 'generated-expressions', 'report.json')));
    if (mode === 'shifted') assert.equal(report.variants.eye_close.alignment.pass, false);
    const seam = run('import-expressions', f.id, '--protected-check', 'seam', '--read-only');
    assert.notEqual(seam.status, 0);
    if (mode === 'shifted') assert.equal(JSON.parse(seam.stdout).variants.eye_close.alignment.pass, false);
  });
}

test('ignores far context changes and input-transparent pixels outside the editable band', () => {
  const f = fixture('--without-back-hair');
  ok('expression-requests', f.id);
  python('edit_expression_fixture.py', f.requestDir, f.resultDir, 'context');
  const result = ok('import-expressions', f.id);
  assert.ok(result.variants.eye_close.meanAbsoluteDiff < 0.1);
  assert.equal(result.variants.eye_close.alignment.pass, true);
  const repaired = ok('repair', f.id, '--expressions', result.outputDir);
  assert.equal(repaired.qa.productionReady, true);
  const requests = JSON.parse(fs.readFileSync(path.join(f.requestDir, 'requests.json')));
  assert.deepEqual(requests.variants.mouth_open.mouthLimits.open, repaired.qa.mouthArtwork.thresholds.open);
});

test('motion QA writes a failed report instead of crashing when eyewhite is missing', () => {
  const f = fixture();
  const file = path.join(f.root, 'output', `${f.id}.psd`);
  const psd = readPsd(new Uint8Array(fs.readFileSync(file)), { useImageData: true, skipThumbnail: true });
  psd.children = psd.children.filter((layer) => layer.name !== 'eyewhite');
  fs.writeFileSync(file, writePsdBuffer(psd));
  const result = run('motion-qa', f.id);
  assert.notEqual(result.status, 0);
  const output = JSON.parse(result.stdout);
  assert.equal(output.pass, false);
  assert.equal(output.checks.requiredFeatureLayers, false);
  assert.match(output.errors.join(' '), /eyewhite/);
  assert.ok(!result.stderr.includes('x0'));
  assert.ok(fs.existsSync(path.join(f.root, 'reports', 'motion-qa', 'motion-qa.json')));
});

test('repair inherits production art across layer repairs, honors preview replacement and explicit removal', () => {
  const f = fixture();
  ok('expression-requests', f.id);
  python('edit_expression_fixture.py', f.requestDir, f.resultDir, 'artwork');
  const art = ok('import-expressions', f.id);
  const first = ok('repair', f.id, '--expressions', art.outputDir);
  assert.equal(first.qa.productionReady, true);
  const overrides = path.join(f.root, 'overrides');
  fs.mkdirSync(overrides);
  fs.copyFileSync(path.join(f.layers, 'topwear.png'), path.join(overrides, 'topwear.png'));
  const inherited = ok('repair', f.id, '--layer-overrides', overrides);
  assert.equal(inherited.inheritedOptions.expressions, art.outputDir);
  assert.equal(inherited.inheritedOptions.fromRepair, first.repairId);
  assert.equal(inherited.qa.productionReady, true);
  for (const name of ['eye_close.png', 'mouth_open.png']) {
    const before = path.join(f.root, 'repairs', first.repairId, 'after', 'processed', 'layers', name);
    const after = path.join(f.root, 'repairs', inherited.repairId, 'after', 'processed', 'layers', name);
    assert.deepEqual(readPngRgba(before).data, readPngRgba(after).data);
  }
  const manifestFile = path.join(f.root, 'job.json');
  const manifest = JSON.parse(fs.readFileSync(manifestFile));
  delete manifest.result.repairs.at(-1).options;
  fs.writeFileSync(manifestFile, JSON.stringify(manifest));
  const legacy = ok('repair', f.id);
  assert.equal(legacy.inheritedOptions.legacy, true);
  assert.equal(legacy.inheritedOptions.expressions, art.outputDir);
  assert.equal(legacy.qa.productionReady, true);
  const previewDir = path.join(f.root, 'preview-expressions');
  fs.mkdirSync(previewDir);
  for (const name of ['eye_close.png', 'mouth_open.png']) fs.copyFileSync(path.join(PROJECT_ROOT, art.outputDir, name), path.join(previewDir, name));
  fs.rmSync(path.join(PROJECT_ROOT, art.outputDir, 'eye_close.png'));
  assert.match(run('repair', f.id).stderr, /Previous expression artwork is missing/);
  assert.match(run('repair', f.id, '--no-expressions', '--expressions', art.outputDir).stderr, /not both/);
  const replaced = ok('repair', f.id, '--preview-expressions', previewDir);
  assert.equal(replaced.options.expressions, null);
  assert.equal(replaced.options.previewExpressions, path.relative(PROJECT_ROOT, previewDir));
  assert.equal(replaced.qa.productionReady, false);
  const inheritedPreview = ok('repair', f.id);
  assert.equal(inheritedPreview.inheritedOptions.previewExpressions, path.relative(PROJECT_ROOT, previewDir));
  assert.equal(inheritedPreview.qa.checks.productionExpressions, false);
  const removed = ok('repair', f.id, '--no-expressions');
  assert.equal(removed.options.expressions, null);
  assert.equal(removed.options.previewExpressions, null);
  assert.equal(removed.qa.productionReady, false);
  assert.equal(ok('repair', f.id).options.expressions, null);
});

test('retains tiny supplied nose highlights and ink but removes below-threshold alpha', () => {
  const f = fixture();
  const overrides = path.join(f.root, 'overrides');
  fs.mkdirSync(overrides);
  const made = spawnSync('python3', ['-c',
    'from PIL import Image, ImageDraw; import sys; im=Image.new("RGBA",(96,96)); d=ImageDraw.Draw(im); d.rectangle((47,42,48,43), fill=(255,255,255,100)); d.rectangle((47,46,48,49),fill=(100,60,40,255)); im.putpixel((49,44),(255,255,255,16)); im.save(sys.argv[1])',
    path.join(overrides, 'nose.png')]);
  assert.equal(made.status, 0);
  const repaired = ok('repair', f.id, '--layer-overrides', overrides);
  const nose = readPngRgba(path.join(f.root, 'repairs', repaired.repairId, 'after', 'processed', 'layers', 'nose.png'));
  assert.equal(Array.from(nose.data).filter((value, index) => index % 4 === 3 && value > 16).length, 12);
  assert.equal(nose.data[(42 * 96 + 47) * 4 + 3], 100);
  assert.equal(nose.data[(47 * 96 + 47) * 4 + 3], 255);
  assert.equal(nose.data[(44 * 96 + 49) * 4 + 3], 0);
});

test('enlarges a normal-sized crop toward 1024 with the same mask and underlay scale', () => {
  const f = fixture('--scale', '8');
  ok('expression-requests', f.id);
  const requests = JSON.parse(fs.readFileSync(path.join(f.requestDir, 'requests.json')));
  for (const item of Object.values(requests.variants)) {
    assert.ok(item.scale > 1 && item.scale <= 4);
    assert.ok(Math.max(...item.size) >= 1024);
    const underlay = readPngRgba(path.join(f.requestDir, item.underlay));
    assert.deepEqual([underlay.width, underlay.height], item.size);
    assert.match(fs.readFileSync(path.join(f.requestDir, item.prompt), 'utf8'), new RegExp(`${item.size[0]}x${item.size[1]}`));
  }
});

test('compensates bounded subpixel shift and uniform scale before artwork extraction', () => {
  const f = fixture();
  ok('expression-requests', f.id);
  python('edit_expression_fixture.py', f.requestDir, f.resultDir, 'small-drift');
  const imported = ok('import-expressions', f.id);
  const alignment = imported.variants.eye_close.alignment;
  assert.equal(alignment.applied, true);
  assert.ok(Math.abs(alignment.appliedDx - 0.75) <= 0.5);
  assert.ok(Math.abs(alignment.appliedDy + 0.5) <= 0.5);
  assert.ok(Math.abs(alignment.appliedScale - 1.01) <= 0.01);
  const repaired = ok('repair', f.id, '--expressions', imported.outputDir);
  assert.equal(repaired.qa.checks.expressionRegistration, true);
  assert.equal(repaired.qa.productionReady, true);
});

for (const mode of ['removed-brow', 'moved-brow', 'skin-patch']) {
  test(`rejects ${mode} entirely inside the protected band, including with relaxed global metrics`, () => {
    const f = fixture('--band-features');
    ok('expression-requests', f.id);
    python('edit_expression_fixture.py', f.requestDir, f.resultDir, mode);
    const result = run('import-expressions', f.id);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /outside the mask changed|global image misalignment/);
    const localOnly = run('import-expressions', f.id, '--max-outside-mean', '255', '--max-outside-p99', '255');
    assert.notEqual(localOnly.status, 0);
    const report = JSON.parse(fs.readFileSync(path.join(f.root, 'generated-expressions', 'report.json')));
    assert.ok(report.variants.eye_close.maxLocalMeanDiff > report.thresholds.maxBandLocalMean
      || report.variants.eye_close.maxFlatMeanDiff > report.thresholds.maxBandFlatMean);
  });
}

test('read-only evaluation checks historical provenance without changing job files or existing outputs', () => {
  const f = fixture();
  ok('expression-requests', f.id);
  python('edit_expression_fixture.py', f.requestDir, f.resultDir, 'artwork');
  const imported = ok('import-expressions', f.id);
  ok('repair', f.id, '--expressions', imported.outputDir);
  const reportFile = path.join(PROJECT_ROOT, imported.report);
  const jobFile = path.join(f.root, 'job.json');
  const before = [fs.readFileSync(reportFile), fs.readFileSync(jobFile)];
  assert.match(run('import-expressions', f.id).stderr, /Current layers changed/);
  // The live failed import updates only its report; capture that state too.
  before[0] = fs.readFileSync(reportFile);
  const evaluated = ok('import-expressions', f.id, '--read-only');
  assert.equal(evaluated.ok, true);
  assert.equal(evaluated.readOnly, true);
  assert.deepEqual(fs.readFileSync(reportFile), before[0]);
  assert.deepEqual(fs.readFileSync(jobFile), before[1]);
  assert.match(run('import-expressions', f.id, '--request-dir', f.requestDir).stderr, /only available with --read-only/);
  fs.appendFileSync(path.join(f.requestDir, 'eye_close', 'mask.png'), 'stale');
  const failed = run('import-expressions', f.id, '--read-only');
  assert.notEqual(failed.status, 0);
  assert.match(JSON.parse(failed.stdout).error, /input, mask or underlay changed/);
  assert.deepEqual(fs.readFileSync(reportFile), before[0]);
});

test('accepts near-opaque generated alpha while rejecting lost visible ink', () => {
  const f = fixture('--band-features');
  ok('expression-requests', f.id);
  python('edit_expression_fixture.py', f.requestDir, f.resultDir, 'alpha-jitter');
  const accepted = ok('import-expressions', f.id);
  assert.equal(accepted.ok, true);
  assert.match(accepted.comparison, /shared opaque white background/);
  assert.ok(accepted.variants.eye_close.meanMatchedDiff < 6);
  python('edit_expression_fixture.py', f.requestDir, f.resultDir, 'lost-alpha');
  assert.notEqual(run('import-expressions', f.id).status, 0);
});
