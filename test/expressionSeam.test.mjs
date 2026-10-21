import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const run = script => {
  const result = spawnSync('python3', ['-c', `
import json, sys
sys.path.insert(0, 'scripts')
from PIL import Image, ImageDraw
from expression_seam import check_seam, feather_artwork
from import_expression_results import protected_band, local_band_diff
base=Image.new('RGBA',(96,96),(180,140,120,255))
mask=Image.new('L',base.size)
ImageDraw.Draw(mask).rectangle((28,28,67,67),fill=255)
${script}
`], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
};

test('seam accepts texture redraw that fails strict protected-band matching', () => {
  const result = run(`
changed=base.copy()
for y in range(96):
    for x in range(96):
        d=16 if (x+y)%2 else -16
        changed.putpixel((x,y),(180+d,140+d,120+d,255))
band=protected_band(base,mask,8)
strict=local_band_diff(base,changed,band,1)
print(json.dumps({'seam':check_seam(base,changed,mask,1),'strict':strict}))
`);
  assert.equal(result.seam.pass, true);
  assert.ok(result.strict.meanMatchedDiff > 6);
  assert.equal(result.seam.bandWidth, 3);
});

test('seam rejects interior edge steps, exterior bleed, localized boundary damage and global recoloring', () => {
  const results = run(`
reports={}
for kind in ('inner','outer','patch','color'):
    changed=base.copy(); draw=ImageDraw.Draw(changed)
    if kind=='inner': draw.rectangle((28,28,67,67),fill=(240,80,60,255))
    if kind=='outer':
        draw.rectangle((24,24,71,71),fill=(240,80,60,255));draw.rectangle((28,28,67,67),fill=(180,140,120,255))
    if kind=='patch': draw.rectangle((27,36,30,43),fill=(0,255,0,255))
    if kind=='color': changed=Image.new('RGBA',base.size,(40,220,40,255))
    reports[kind]=check_seam(base,changed,mask,1)
print(json.dumps(reports))
`);
  for (const result of Object.values(results)) assert.equal(result.pass, false);
  assert.ok(results.inner.failedChecks.some(key => key.startsWith('inner')));
  assert.ok(results.outer.failedChecks.some(key => key.startsWith('outer')));
  assert.ok(results.patch.failedChecks.some(key => key.endsWith('Tiles')));
  assert.ok(results.color.failedChecks.includes('outsideMean'));
});

test('seam feathering stays inside the editable area and ramps at native scale, including soft alpha', () => {
  const result = run(`
art=Image.new('RGBA',base.size,(220,40,50,255));art.putalpha(mask)
soft=Image.new('RGBA',base.size,(220,40,50,6));soft.putalpha(mask.point(lambda a: round(a*6/255)))
a=feather_artwork(art,mask);b=feather_artwork(soft,mask)
print(json.dumps({'ink':[a.getpixel((x,40))[3] for x in (27,28,29,30,31,68)],'soft':[b.getpixel((x,40))[3] for x in (27,28,29,30,31,68)]}))
`);
  assert.deepEqual(result.ink, [0,85,170,255,255,0]);
  assert.deepEqual(result.soft, [0,2,4,6,6,0]);
});
