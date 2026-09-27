import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, test } from 'node:test';
import { buildPsd } from '../src/psd.mjs';
import { prepareJob } from '../src/job.mjs';
import { runQa } from '../src/qa.mjs';
import { PROJECT_ROOT, STATE_ROOT } from '../src/utils.mjs';

const roots = [];

function tempRoot(name) {
  fs.mkdirSync(STATE_ROOT, { recursive: true });
  const root = fs.mkdtempSync(path.join(STATE_ROOT, `test-${name}-`));
  roots.push(root);
  return root;
}

function fixture(root, ...args) {
  const layerDir = path.join(root, 'layers');
  const result = spawnSync('python3', [
    path.join(PROJECT_ROOT, 'test', 'generate_fixture.py'),
    '--output', layerDir,
    ...args,
  ], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return layerDir;
}

function buildAndQa(root, layerDir, previewPlaceholders = false) {
  const psdFile = path.join(root, 'output', 'fixture.psd');
  const buildReportFile = path.join(root, 'reports', 'build.json');
  const qaReportFile = path.join(root, 'reports', 'qa.json');
  const build = buildPsd({ layerDir, output: psdFile, reportFile: buildReportFile, previewPlaceholders });
  const qa = runQa({ psdFile, layerDir, buildReportFile, reportFile: qaReportFile });
  return { build, qa, psdFile };
}

afterEach(() => {
  while (roots.length) fs.rmSync(roots.pop(), { recursive: true, force: true });
});

test('builds a production-structure-ready PSD with safe body/neck/face order', () => {
  const root = tempRoot('ready');
  const result = buildAndQa(root, fixture(root));
  assert.equal(result.qa.structuralPass, true);
  assert.equal(result.qa.productionReady, true);
  assert.equal(result.build.placeholders.length, 0);
  assert.ok(result.build.layerOrder.indexOf('handwear') < result.build.layerOrder.indexOf('topwear'));
  assert.ok(result.build.layerOrder.indexOf('topwear') < result.build.layerOrder.indexOf('neck'));
  assert.equal(result.qa.checks.armsBehindTopwear, true);
  assert.ok(result.build.layerOrder.indexOf('neck') < result.build.layerOrder.indexOf('face'));
  assert.ok(fs.statSync(result.psdFile).size > 1000);
});

test('rejects the 24px shifted mouth negative fixture', () => {
  const root = tempRoot('shifted');
  const result = buildAndQa(root, fixture(root, '--mouth-shift', '24'));
  assert.equal(result.qa.structuralPass, true);
  assert.equal(result.qa.registration.checks.mouthWithinTolerance, false);
  assert.equal(result.qa.productionReady, false);
});

test('rejects a filled face-colored closed-mouth patch', () => {
  const root = tempRoot('mouth-patch');
  const result = buildAndQa(root, fixture(root, '--mouth-patch'));
  assert.equal(result.qa.structuralPass, true);
  assert.equal(result.qa.mouthArtwork.checks.compactCloseMouth, false);
  assert.equal(result.qa.mouthArtwork.checks.closedMouthIsLineArtwork, false);
  assert.equal(result.qa.mouthArtwork.checks.noBrightMouthFill, false);
  assert.equal(result.qa.productionReady, false);
});

test('labels expression placeholders as preview-only', () => {
  const root = tempRoot('preview');
  const result = buildAndQa(root, fixture(root, '--without-expressions'), true);
  assert.equal(result.qa.structuralPass, true);
  assert.equal(result.build.placeholders.length, 1);
  assert.deepEqual(result.build.missingProduction, ['eye_close']);
  assert.equal(result.qa.productionReady, false);
});

test('keeps derived preview expressions out of production readiness', () => {
  const root = tempRoot('preview-expressions');
  const layerDir = fixture(root);
  const psdFile = path.join(root, 'output', 'fixture.psd');
  const buildReportFile = path.join(root, 'reports', 'build.json');
  const build = buildPsd({
    layerDir,
    output: psdFile,
    reportFile: buildReportFile,
    previewExpressionTargets: ['mouth_open', 'eye_close'],
  });
  const qa = runQa({ psdFile, layerDir, buildReportFile, reportFile: path.join(root, 'reports', 'qa.json') });
  assert.deepEqual(build.previewExpressions.map((entry) => entry.layer), ['mouth_open', 'eye_close']);
  assert.equal(build.productionReady, false);
  assert.equal(qa.structuralPass, true);
  assert.equal(qa.checks.productionExpressions, false);
  assert.equal(qa.productionReady, false);
});

test('runs prepare, verified import, and finalize through the public CLI', () => {
  const fixtureRoot = tempRoot('e2e-fixture');
  const layerDir = fixture(fixtureRoot);
  const jobId = `e2e-${process.pid}-${Date.now()}`;
  const source = path.join(layerDir, 'face.png');
  const manifest = prepareJob(source, jobId);
  const jobDir = path.join(STATE_ROOT, 'jobs', jobId);
  roots.push(jobDir);
  const archive = path.join(fixtureRoot, `${jobId}.zip`);
  const packed = spawnSync('python3', [
    path.join(PROJECT_ROOT, 'test', 'make_result_bundle.py'),
    '--layers', layerDir,
    '--archive', archive,
    '--input-sha256', manifest.input.sha256,
    '--job', jobId,
  ], { encoding: 'utf8' });
  assert.equal(packed.status, 0, packed.stderr);
  const imported = spawnSync('node', [path.join(PROJECT_ROOT, 'bin', 'still2rig-psd.mjs'), 'import', jobId, archive], {
    cwd: PROJECT_ROOT,
    encoding: 'utf8',
  });
  assert.equal(imported.status, 0, imported.stderr);
  const overrideDir = path.join(fixtureRoot, 'layer-overrides');
  fs.mkdirSync(overrideDir);
  fs.copyFileSync(path.join(layerDir, 'topwear.png'), path.join(overrideDir, 'topwear.png'));
  const finalized = spawnSync('node', [
    path.join(PROJECT_ROOT, 'bin', 'still2rig-psd.mjs'),
    'finalize', jobId,
    '--layer-overrides', overrideDir,
  ], {
    cwd: PROJECT_ROOT,
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
  });
  assert.equal(finalized.status, 0, finalized.stderr);
  const job = JSON.parse(fs.readFileSync(path.join(jobDir, 'job.json'), 'utf8'));
  const finalizedQa = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, job.result.qaReport), 'utf8'));
  assert.equal(job.state, 'production-structure-ready', JSON.stringify(finalizedQa, null, 2));
  assert.equal(job.result.productionReady, true);
  assert.ok(fs.existsSync(path.join(PROJECT_ROOT, job.result.psd)));
  const inspection = JSON.parse(fs.readFileSync(path.join(jobDir, 'reports', 'layer-inspection.json'), 'utf8'));
  assert.deepEqual(inspection.layerOverrides, ['topwear.png']);

  const repaired = spawnSync('node', [
    path.join(PROJECT_ROOT, 'bin', 'still2rig-psd.mjs'),
    'repair', jobId,
    '--layer-overrides', overrideDir,
  ], {
    cwd: PROJECT_ROOT,
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
  });
  assert.equal(repaired.status, 0, repaired.stderr);
  const repairedJob = JSON.parse(fs.readFileSync(path.join(jobDir, 'job.json'), 'utf8'));
  assert.equal(repairedJob.result.repairs.length, 1);
  assert.ok(fs.existsSync(path.join(PROJECT_ROOT, repairedJob.result.repairs[0].before.psd)));
  assert.ok(fs.existsSync(path.join(PROJECT_ROOT, repairedJob.result.psd)));
});
