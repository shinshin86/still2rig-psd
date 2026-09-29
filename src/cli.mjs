import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { readPsd, writePsdBuffer } from 'ag-psd';
import { buildPsd } from './psd.mjs';
import { colabBridgePaths, colabConnectionInfo } from './colab.mjs';
import { listJobs, loadJob, prepareJob, updateJob } from './job.mjs';
import { runQa } from './qa.mjs';
import {
  PROJECT_ROOT,
  jobRoot,
  loadDefaults,
  loadLayerMap,
  parseOptions,
  relativeProjectPath,
  sha256File,
  writeJson,
} from './utils.mjs';

function usage() {
  return `Still2Rig PSD 0.1.0

Usage:
  still2rig-psd doctor [--json]
  still2rig-psd prepare IMAGE [--name JOB]
  still2rig-psd colab-url [--json]
  still2rig-psd cell JOB CELL_FILE
  still2rig-psd import JOB RESULT.zip
  still2rig-psd finalize JOB [--expressions DIR | --preview-expressions DIR] [--layer-overrides DIR] [--preview-placeholders]
  still2rig-psd repair JOB [--expressions DIR | --preview-expressions DIR] [--layer-overrides DIR] [--preview-placeholders]
  still2rig-psd derive-expressions JOB
  still2rig-psd motion-qa JOB [--negative-fixture]
  still2rig-psd status [JOB] [--json]
  still2rig-psd self-test

Generated jobs stay under the ignored .still2rig-psd/jobs directory.`;
}

function commandResult(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  return {
    ok: result.status === 0,
    version: (result.stdout || result.stderr || '').trim().split('\n')[0] || null,
  };
}

function colabBridgeCheck() {
  const { tokenFile, stateFile } = colabBridgePaths();
  if (!fs.existsSync(stateFile)) {
    return {
      ok: true,
      status: 'not-running',
      port: null,
      browserConnected: false,
      note: 'The project bridge starts when Codex loads the trusted project configuration.',
    };
  }
  const result = spawnSync('colab-mcp-go', [
    'doctor', '--host', 'localhost', '--port', '0', '--token-file', tokenFile, '--json',
  ], { encoding: 'utf8' });
  let report;
  try {
    report = JSON.parse(result.stdout || '{}');
  } catch {
    return {
      ok: false,
      status: 'invalid-doctor-output',
      port: null,
      browserConnected: false,
    };
  }
  return {
    ok: result.status === 0 && report.status === 'ok',
    status: report.status || 'unknown',
    diagnosisCode: report.diagnosis_code || null,
    port: report.port?.number || null,
    listening: Boolean(report.port?.listening),
    browserConnected: Boolean(report.state?.data?.ws_connected),
  };
}

function doctor() {
  const [nodeMajor, nodeMinor] = process.versions.node.split('.').map(Number);
  const checks = {
    node: {
      ok: nodeMajor > 20 || (nodeMajor === 20 && nodeMinor >= 19),
      version: process.version,
    },
    python: commandResult('python3', ['--version']),
    pillow: commandResult('python3', ['-c', 'import PIL; print(PIL.__version__)']),
    colabMcpGo: commandResult('colab-mcp-go', ['--version']),
    colabBridge: colabBridgeCheck(),
    projectConfig: { ok: fs.existsSync(path.join(PROJECT_ROOT, '.codex', 'config.toml')), version: null },
  };
  return {
    ok: Object.values(checks).every((check) => check.ok),
    checks,
    fixes: [
      'Install local Python dependency: python3 -m pip install -r requirements-local.txt',
      'Install Colab MCP Go: go install github.com/shinshin86/colab-mcp-go/cmd/colab-mcp-go@v0.0.0-20260824110853-5c9e997958bf',
      'Trust this project and restart Codex so .codex/config.toml is loaded.',
    ],
  };
}

function runPython(script, args) {
  const result = spawnSync('python3', [path.join(PROJECT_ROOT, 'scripts', script), ...args], {
    cwd: PROJECT_ROOT,
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
  });
  if (result.status !== 0) throw new Error((result.stderr || result.stdout || `${script} failed`).trim());
  return (result.stdout || '').trim();
}

function importBundle(jobId, archiveValue) {
  const { root, manifest } = loadJob(jobId);
  if (!archiveValue) throw new Error('Usage: still2rig-psd import JOB RESULT.zip');
  const archive = path.resolve(archiveValue);
  if (!fs.statSync(archive).isFile()) throw new Error('Result archive is not a file.');
  const destination = path.join(root, 'raw', 'imported');
  const output = runPython('import_colab_bundle.py', [
    '--archive', archive,
    '--destination', destination,
    '--expected-input-sha256', manifest.input.sha256,
  ]);
  const result = JSON.parse(output.split('\n').at(-1));
  updateJob(jobId, (job) => ({
    ...job,
    state: 'imported',
    result: {
      archiveName: path.basename(archive),
      archiveSha256: result.archiveSha256,
      runManifest: relativeProjectPath(path.join(destination, 'run-manifest.json')),
    },
  }));
  return result;
}

function assembleArtifacts({ jobId, root, options, outputPsd, layerDir, reportsRoot }) {
  const imported = path.join(root, 'raw', 'imported');
  if (!fs.existsSync(path.join(imported, 'run-manifest.json'))) throw new Error('Import a verified Colab bundle before finalizing.');
  const inspectionReport = path.join(reportsRoot, 'layer-inspection.json');
  const contactSheet = path.join(reportsRoot, 'layer-contact-sheet.jpg');
  const defaults = loadDefaults();
  const inspectArgs = [
    '--raw-root', imported,
    '--output-dir', layerDir,
    '--report', inspectionReport,
    '--contact-sheet', contactSheet,
    '--alpha-threshold', String(defaults.quality.alphaThreshold),
    '--minimum-component-pixels', String(defaults.quality.minimumComponentPixels),
    '--drop-optional-below', String(defaults.quality.dropOptionalBelowPixels),
  ];
  if (options.expressions && options['preview-expressions']) {
    throw new Error('Use either --expressions (drawn artwork) or --preview-expressions (derived preview artwork), not both.');
  }
  const expressionDir = options.expressions || options['preview-expressions'];
  if (expressionDir) inspectArgs.push('--expressions', path.resolve(expressionDir));
  if (options['layer-overrides']) inspectArgs.push('--layer-overrides', path.resolve(options['layer-overrides']));
  runPython('inspect_layers.py', inspectArgs);
  const buildReportFile = path.join(reportsRoot, 'psd-build.json');
  const build = buildPsd({
    layerDir,
    output: outputPsd,
    reportFile: buildReportFile,
    previewPlaceholders: Boolean(options['preview-placeholders']),
    previewExpressionTargets: options['preview-expressions'] ? previewExpressionTargets(inspectionReport) : [],
  });
  const qaReportFile = path.join(reportsRoot, 'qa-report.json');
  const qa = runQa({ psdFile: outputPsd, layerDir, buildReportFile, reportFile: qaReportFile });
  return { build, qa, outputPsd, qaReportFile, contactSheet, buildReportFile, inspectionReport };
}

const EXPRESSION_TARGETS = {
  'mouth_open.png': 'mouth_open',
  'mouth_close.png': 'mouth_close',
  'eye_close.png': 'eye_close',
};

function previewExpressionTargets(inspectionReport) {
  const report = JSON.parse(fs.readFileSync(inspectionReport, 'utf8'));
  return (report.expressionFiles || []).map((name) => EXPRESSION_TARGETS[name]).filter(Boolean);
}

function finalize(jobId, options) {
  const { root } = loadJob(jobId);
  const outputPsd = path.join(root, 'output', `${jobId}.psd`);
  if (fs.existsSync(outputPsd)) throw new Error('This job is already finalized. Use repair to preserve the existing result.');
  const assembled = assembleArtifacts({
    jobId,
    root,
    options,
    outputPsd,
    layerDir: path.join(root, 'processed', 'layers'),
    reportsRoot: path.join(root, 'reports'),
  });
  updateJob(jobId, (job) => ({
    ...job,
    updatedAt: new Date().toISOString(),
    state: assembled.qa.productionReady ? 'production-structure-ready' : 'preview-or-repair-required',
    result: {
      ...job.result,
      psd: relativeProjectPath(outputPsd),
      psdSha256: sha256File(outputPsd),
      qaReport: relativeProjectPath(assembled.qaReportFile),
      contactSheet: relativeProjectPath(assembled.contactSheet),
      productionReady: assembled.qa.productionReady,
      previewExpressions: assembled.build.previewExpressions,
    },
  }));
  return { jobId, build: assembled.build, qa: assembled.qa };
}

function nextRepairId(root) {
  const repairsRoot = path.join(root, 'repairs');
  if (!fs.existsSync(repairsRoot)) return 'repair-001';
  const numbers = fs.readdirSync(repairsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => /^repair-(\d{3})$/.exec(entry.name))
    .filter(Boolean)
    .map((match) => Number(match[1]));
  return `repair-${String((numbers.length ? Math.max(...numbers) : 0) + 1).padStart(3, '0')}`;
}

function copyResultArtifact(value, destination) {
  if (!value) return null;
  const source = path.resolve(PROJECT_ROOT, value);
  if (!fs.existsSync(source) || !fs.statSync(source).isFile()) return null;
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(source, destination);
  return destination;
}

function repair(jobId, options) {
  const { root, manifest } = loadJob(jobId);
  if (!manifest.result?.psd) throw new Error('Finalize the job before repairing it.');
  const currentPsd = path.resolve(PROJECT_ROOT, manifest.result.psd);
  if (!fs.existsSync(currentPsd) || !fs.statSync(currentPsd).isFile()) throw new Error('The current PSD is missing.');
  const repairId = nextRepairId(root);
  const repairRoot = path.join(root, 'repairs', repairId);
  const afterRoot = path.join(repairRoot, 'after');
  const assembled = assembleArtifacts({
    jobId,
    root,
    options,
    outputPsd: path.join(afterRoot, 'output', `${jobId}.psd`),
    layerDir: path.join(afterRoot, 'processed', 'layers'),
    reportsRoot: path.join(afterRoot, 'reports'),
  });

  const beforeRoot = path.join(repairRoot, 'before');
  const beforePsd = path.join(beforeRoot, 'output', path.basename(currentPsd));
  fs.mkdirSync(path.dirname(beforePsd), { recursive: true });
  fs.copyFileSync(currentPsd, beforePsd);
  copyResultArtifact(manifest.result.qaReport, path.join(beforeRoot, 'reports', 'qa-report.json'));
  copyResultArtifact(manifest.result.contactSheet, path.join(beforeRoot, 'reports', 'layer-contact-sheet.jpg'));

  fs.copyFileSync(assembled.outputPsd, currentPsd);
  assembled.build.output = relativeProjectPath(currentPsd);
  assembled.qa.psd = relativeProjectPath(currentPsd);
  writeJson(assembled.buildReportFile, assembled.build);
  writeJson(assembled.qaReportFile, assembled.qa);

  const createdAt = new Date().toISOString();
  const before = {
    psd: relativeProjectPath(beforePsd),
    psdSha256: manifest.result.psdSha256 || sha256File(beforePsd),
  };
  const after = {
    psd: relativeProjectPath(currentPsd),
    psdSha256: sha256File(currentPsd),
    qaReport: relativeProjectPath(assembled.qaReportFile),
    contactSheet: relativeProjectPath(assembled.contactSheet),
    productionReady: assembled.qa.productionReady,
    previewExpressions: assembled.build.previewExpressions,
  };
  updateJob(jobId, (job) => ({
    ...job,
    updatedAt: createdAt,
    state: assembled.qa.productionReady ? 'production-structure-ready' : 'preview-or-repair-required',
    result: {
      ...job.result,
      ...after,
      repairs: [...(job.result.repairs || []), { repairId, createdAt, before, after }],
    },
  }));
  return { jobId, repairId, before, build: assembled.build, qa: assembled.qa, result: after };
}

function currentLayerDir(root, manifest) {
  const repairs = manifest.result?.repairs || [];
  const latest = repairs.length ? repairs[repairs.length - 1].repairId : null;
  const dir = latest
    ? path.join(root, 'repairs', latest, 'after', 'processed', 'layers')
    : path.join(root, 'processed', 'layers');
  if (!fs.existsSync(dir)) throw new Error('Finalize the job before deriving expressions.');
  return dir;
}

function deriveExpressions(jobId) {
  const { root, manifest } = loadJob(jobId);
  const outputDir = path.join(root, 'preview-expressions');
  const report = path.join(outputDir, 'report.json');
  runPython('build_preview_expressions.py', [
    '--layer-dir', currentLayerDir(root, manifest),
    '--output-dir', outputDir,
    '--report', report,
  ]);
  return {
    jobId,
    outputDir: relativeProjectPath(outputDir),
    report: relativeProjectPath(report),
    next: `still2rig-psd repair ${jobId} --preview-expressions ${relativeProjectPath(outputDir)}`,
    note: 'Derived preview art. The PSD stays productionReady=false until drawn expression art is supplied with --expressions.',
  };
}

function shiftedMouthFixture(psdFile, output) {
  // Contract negative fixture: shift mouth_close by +24px in a temporary copy.
  const psd = readPsd(new Uint8Array(fs.readFileSync(psdFile)), { useImageData: true, skipThumbnail: true });
  const mouth = (psd.children || []).find((layer) => layer.name === 'mouth_close');
  if (!mouth?.imageData) throw new Error('The PSD has no mouth_close layer for the negative fixture.');
  const { width, height, data } = mouth.imageData;
  const shifted = new Uint8ClampedArray(data.length);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x + 24 < width; x += 1) {
      shifted.set(data.subarray((y * width + x) * 4, (y * width + x) * 4 + 4), (y * width + x + 24) * 4);
    }
  }
  mouth.imageData = { width, height, data: shifted };
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, writePsdBuffer(psd));
  return output;
}

function motionQa(jobId, options) {
  const { root, manifest } = loadJob(jobId);
  if (!manifest.result?.psd) throw new Error('Finalize the job before running motion QA.');
  const psdFile = path.resolve(PROJECT_ROOT, manifest.result.psd);
  const negative = Boolean(options['negative-fixture']);
  const outDir = path.join(root, 'reports', negative ? 'motion-qa-negative' : 'motion-qa');
  const renderPsd = negative ? shiftedMouthFixture(psdFile, path.join(root, 'reports', 'motion-qa-negative-fixture.psd')) : psdFile;
  const result = spawnSync(process.execPath, [
    path.join(PROJECT_ROOT, 'webui', 'scripts', 'run-motion-qa.mjs'),
    '--psd', renderPsd,
    '--reference-psd', psdFile,
    '--out', outDir,
  ], { cwd: path.join(PROJECT_ROOT, 'webui'), encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
  if (negative) fs.rmSync(renderPsd, { force: true });
  if (result.status !== 0) throw new Error((result.stderr || result.stdout || 'motion QA failed to run').trim());
  const reportFile = path.join(outDir, 'motion-qa.json');
  const report = JSON.parse(fs.readFileSync(reportFile, 'utf8'));
  if (negative) {
    const behavedAsExpected = report.pass === false && report.checks.mouthToEyesRelativeResidual === false;
    return { jobId, negativeFixture: 'shift mouth_close by +24px', expected: 'FAIL', result: report.pass ? 'PASS' : 'FAIL', behavedAsExpected, report: relativeProjectPath(reportFile), metrics: report.metrics };
  }
  updateJob(jobId, (job) => ({
    ...job,
    updatedAt: new Date().toISOString(),
    result: {
      ...job.result,
      motionQa: {
        pass: report.pass,
        psdSha256: sha256File(psdFile),
        report: relativeProjectPath(reportFile),
        failedChecks: Object.entries(report.checks).filter(([, ok]) => !ok).map(([name]) => name),
      },
    },
  }));
  return { jobId, pass: report.pass, checks: report.checks, metrics: report.metrics, report: relativeProjectPath(reportFile) };
}

function selfTest() {
  const map = loadLayerMap();
  const targets = map.layers.map((entry) => entry.target);
  const index = (name) => targets.indexOf(name);
  const checks = {
    bodyBeforeNeck: index('topwear') < index('neck'),
    armsBehindTopwear: index('handwear') < index('topwear'),
    neckBeforeFace: index('neck') < index('face'),
    faceBeforeEyes: index('face') < index('eyewhite'),
    expressionsBeforeFrontHair: index('eye_close') < index('front hair'),
    pinnedRevision: /^[0-9a-f]{40}$/.test(loadDefaults().seeThrough.revision),
    privateStateIgnored: fs.readFileSync(path.join(PROJECT_ROOT, '.gitignore'), 'utf8').split(/\r?\n/).includes('.still2rig-psd/'),
  };
  return { ok: Object.values(checks).every(Boolean), checks };
}

function print(value, json) {
  if (json || typeof value !== 'string') console.log(JSON.stringify(value, null, 2));
  else console.log(value);
}

export async function main(argv = process.argv.slice(2)) {
  const command = argv[0];
  const { positional, options } = parseOptions(argv.slice(1));
  if (!command || ['help', '-h', '--help'].includes(command)) {
    console.log(usage());
    return;
  }
  if (command === 'doctor') {
    const result = doctor();
    print(result, options.json);
    if (!result.ok) process.exitCode = 1;
  } else if (command === 'prepare') {
    print(prepareJob(positional[0], options.name), true);
  } else if (command === 'colab-url') {
    print(colabConnectionInfo(), options.json);
  } else if (command === 'cell') {
    const [jobId, cellName] = positional;
    if (!jobId || !cellName || !/^0[1-4]-(upload|setup|run|download)\.py$/.test(cellName)) throw new Error('Usage: still2rig-psd cell JOB 01-upload.py');
    const file = path.join(jobRoot(jobId), 'colab', cellName);
    if (!fs.existsSync(file)) throw new Error(`Unknown cell: ${cellName}`);
    process.stdout.write(fs.readFileSync(file, 'utf8'));
  } else if (command === 'import') {
    print(importBundle(positional[0], positional[1]), true);
  } else if (command === 'finalize') {
    print(finalize(positional[0], options), true);
  } else if (command === 'repair') {
    print(repair(positional[0], options), true);
  } else if (command === 'motion-qa') {
    const result = motionQa(positional[0], options);
    print(result, true);
    if (options['negative-fixture'] ? !result.behavedAsExpected : !result.pass) process.exitCode = 1;
  } else if (command === 'derive-expressions') {
    print(deriveExpressions(positional[0]), true);
  } else if (command === 'status') {
    print(positional[0] ? loadJob(positional[0]).manifest : listJobs(), options.json);
  } else if (command === 'self-test') {
    const result = selfTest();
    print(result, true);
    if (!result.ok) process.exitCode = 1;
  } else {
    throw new Error(`Unknown command: ${command}\n\n${usage()}`);
  }
}
