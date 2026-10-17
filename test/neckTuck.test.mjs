import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, test } from 'node:test';
import { PROJECT_ROOT, STATE_ROOT } from '../src/utils.mjs';

const roots = [];

afterEach(() => {
  while (roots.length) fs.rmSync(roots.pop(), { recursive: true, force: true });
});

function python(args) {
  const result = spawnSync('python3', args, { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

// prepare(raw, root) runs after the fixture is written and returns extra inspect_layers.py args.
function inspect(name, fixtureArgs, prepare = () => []) {
  fs.mkdirSync(STATE_ROOT, { recursive: true });
  const root = fs.mkdtempSync(path.join(STATE_ROOT, `test-neck-${name}-`));
  roots.push(root);
  const raw = path.join(root, 'raw');
  python([path.join(PROJECT_ROOT, 'test', 'generate_fixture.py'), '--output', raw, ...fixtureArgs]);
  const output = path.join(root, 'layers');
  python([
    path.join(PROJECT_ROOT, 'scripts', 'inspect_layers.py'),
    '--raw-root', raw,
    '--output-dir', output,
    '--report', path.join(root, 'inspection.json'),
    '--contact-sheet', path.join(root, 'sheet.jpg'),
    ...prepare(raw, root),
  ]);
  const report = JSON.parse(fs.readFileSync(path.join(root, 'inspection.json'), 'utf8'));
  return { output, report };
}

// Returns the neck alpha at a pixel of the cleaned layer.
function neckAlpha(output, x, y) {
  return Number(python(['-c', [
    'import sys',
    'from PIL import Image',
    'print(Image.open(sys.argv[1]).convert("RGBA").getpixel((int(sys.argv[2]), int(sys.argv[3])))[3])',
  ].join('\n'), path.join(output, 'neck.png'), String(x), String(y)]));
}

test('hides the neck where the source shows the collar in front of it', () => {
  const { output, report } = inspect('collar', ['--collar-source']);
  assert.equal(report.neckTuck.applied, true);
  assert.ok(report.neckTuck.hiddenPixels >= 17 * 7, JSON.stringify(report.neckTuck));
  assert.equal(neckAlpha(output, 48, 75), 0);
  assert.equal(neckAlpha(output, 48, 69), 255);
  const neckRow = report.layers.find((row) => row.name === 'neck.png');
  assert.equal(neckRow.bbox[3], 72);
});

test('keeps the neck where a front layer explains the source colour', () => {
  const { output, report } = inspect('hair', ['--collar-source', '--hair-over-collar']);
  assert.equal(report.neckTuck.applied, true);
  assert.equal(neckAlpha(output, 43, 75), 255);
  assert.equal(neckAlpha(output, 52, 75), 0);
});

test('leaves the neck alone when the source shows no clothing over it', () => {
  const { output, report } = inspect('plain', []);
  assert.equal(report.neckTuck.applied, false);
  assert.match(report.neckTuck.reason, /source image is missing/);
  assert.equal(neckAlpha(output, 48, 75), 255);
  // A source that matches the neck everywhere must not hide anything either.
  const matching = inspect('plain-source', [], (raw) => {
    python(['-c', [
      'import sys',
      'from PIL import Image',
      'raw = sys.argv[1]',
      'out = Image.new("RGBA", (96, 96), (0, 0, 0, 0))',
      'for name in ("topwear.png", "neck.png", "face.png"):',
      '    out.alpha_composite(Image.open(f"{raw}/{name}").convert("RGBA"))',
      'out.save(f"{raw}/src_img.png")',
    ].join('\n'), raw]);
    return [];
  });
  assert.equal(matching.report.neckTuck.applied, false);
  assert.equal(matching.report.neckTuck.overlapPixels > 0, true);
  assert.equal(neckAlpha(matching.output, 48, 75), 255);
});

test('does not alter a neck supplied as a layer override', () => {
  const { output, report } = inspect('override', ['--collar-source'], (raw, root) => {
    const overrides = path.join(root, 'overrides');
    fs.mkdirSync(overrides);
    fs.copyFileSync(path.join(raw, 'neck.png'), path.join(overrides, 'neck.png'));
    return ['--layer-overrides', overrides];
  });
  assert.deepEqual(report.layerOverrides, ['neck.png']);
  assert.equal(report.neckTuck.applied, false);
  assert.equal(neckAlpha(output, 48, 75), 255);
});
