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
  assert.equal(result.status, 0, result.stderr);
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
  assert.match(result.next, /import-expressions/);
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
        const cropOffset = ((y - item.cropBox[1]) * input.width + x - item.cropBox[0]) * 4;
        assert.deepEqual(input.data.slice(cropOffset, cropOffset + 4), mouth.data.slice(offset, offset + 4));
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
        assert.equal(alpha, ink ? 255 : 0, `${name} pixel ${x},${y}`);
        if (alpha) visible += 1;
      }
    }
    assert.equal(visible, name === 'mouth_open' ? 78 : 104);
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
  const index = ((34 - item.cropBox[1]) * input.width + 37 - item.cropBox[0]) * 4;
  assert.deepEqual(Array.from(input.data.slice(index, index + 4)), [30, 120, 150, 255]);
  const underlay = readPngRgba(path.join(f.requestDir, item.underlay));
  assert.deepEqual(Array.from(underlay.data.slice(index, index + 4)), [250, 205, 175, 255]);
  python('edit_expression_fixture.py', f.requestDir, f.resultDir, 'artwork');
  const imported = ok('import-expressions', f.id);
  const eye = readPngRgba(path.join(PROJECT_ROOT, imported.outputDir, 'eye_close.png'));
  for (let offset = 0; offset < eye.data.length; offset += 4) {
    if (eye.data[offset + 3]) assert.deepEqual(Array.from(eye.data.slice(offset, offset + 3)), [80, 30, 25]);
  }
});

test('removes isolated speckles and uses configurable soft alpha for low-contrast edges', () => {
  const f = fixture();
  ok('expression-requests', f.id);
  python('edit_expression_fixture.py', f.requestDir, f.resultDir, 'speckle');
  const filtered = ok('import-expressions', f.id);
  assert.equal(filtered.variants.eye_close.removedNoisePixels, 1);
  assert.equal(filtered.variants.mouth_open.removedNoisePixels, 1);
  python('edit_expression_fixture.py', f.requestDir, f.resultDir, 'soft');
  const imported = ok('import-expressions', f.id);
  const mouth = readPngRgba(path.join(PROJECT_ROOT, imported.outputDir, 'mouth_open.png'));
  const alpha = mouth.data[(48 * 96 + 48) * 4 + 3];
  assert.ok(alpha > 0 && alpha < 255);
  ok('import-expressions', f.id, '--artwork-threshold', '20');
  const strict = readPngRgba(path.join(PROJECT_ROOT, imported.outputDir, 'mouth_open.png'));
  assert.equal(strict.data[(48 * 96 + 48) * 4 + 3], 0);
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
        const cx = x - item.cropBox[0];
        const cy = y - item.cropBox[1];
        const allowed = cx >= 0 && cy >= 0 && cx < mask.width && cy < mask.height && mask.data[(cy * mask.width + cx) * 4 + 3] === 0;
        assert.equal(output.data[(y * output.width + x) * 4 + 3], allowed ? 255 : 0);
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

for (const [mode, error] of [['outside', /outside the mask changed.*mean=.*p99=/], ['aspect', /aspect ratio differs/]]) {
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
  // A synthetic visible marker replaces the source mouth via the normal repair path.
  const marker = spawnSync('python3', ['-c',
    'from PIL import Image, ImageDraw; import sys; im=Image.new("RGBA",(96,96)); ImageDraw.Draw(im).rectangle((42,48,54,52),fill=(12,34,56,255)); im.save(sys.argv[1])',
    path.join(overrides, 'mouth_close.png')]);
  assert.equal(marker.status, 0);
  ok('repair', f.id, '--expressions', overrides);
  ok('expression-requests', f.id);
  const requests = JSON.parse(fs.readFileSync(path.join(f.requestDir, 'requests.json')));
  const item = requests.variants.mouth_open;
  const input = readPngRgba(path.join(f.requestDir, item.input));
  const index = ((50 - item.cropBox[1]) * input.width + 48 - item.cropBox[0]) * 4;
  assert.deepEqual(Array.from(input.data.slice(index, index + 4)), [12, 34, 56, 255]);
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
  const cleared = ok('repair', f.id, '--no-layer-overrides');
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
    assert.match(result.stderr, /global image misalignment/);
    const report = JSON.parse(fs.readFileSync(path.join(f.root, 'generated-expressions', 'report.json')));
    assert.equal(report.variants.eye_close.alignment.pass, false);
  });
}

test('ignores far context changes and input-transparent pixels outside the editable band', () => {
  const f = fixture('--without-back-hair');
  ok('expression-requests', f.id);
  python('edit_expression_fixture.py', f.requestDir, f.resultDir, 'context');
  const result = ok('import-expressions', f.id);
  assert.equal(result.variants.eye_close.meanAbsoluteDiff, 0);
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
