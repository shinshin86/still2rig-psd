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

test('outer tile damage remains diagnostic while inner tiles, band statistics and boundary jumps still gate import', () => {
  const result = run(`
changed=base.copy()
ImageDraw.Draw(changed).rectangle((24,40,26,47),fill=(70,140,120,255))
print(json.dumps(check_seam(base,changed,mask,1)))
`);
  assert.equal(result.pass, true);
  assert.ok(result.bands.outer.maximumTileMean > result.limits.boundaryTileMean);
  assert.equal(result.diagnostics.outerTiles.withinLimit, false);
  assert.equal(result.diagnostics.outerTiles.gatesImport, false);
  assert.equal(Object.hasOwn(result.checks, 'outerTiles'), false);
  assert.equal(result.checks.innerTiles, true);
  for (const name of ['outerMean', 'outerP95', 'innerMean', 'innerP95', 'boundaryJump', 'outsideMean']) {
    assert.equal(result.checks[name], true);
  }
});

test('outside P99 is diagnostic while outside mean and visible boundary defects still gate import', () => {
  const result = run(`
changed=base.copy();ImageDraw.Draw(changed).rectangle((0,0,12,12),fill=(0,0,0,255))
local=check_seam(base,changed,mask,1)
global_change=check_seam(base,Image.new('RGBA',base.size,(0,0,0,255)),mask,1)
print(json.dumps({'local':local,'global':global_change}))
`);
  assert.equal(result.local.pass, true);
  assert.ok(result.local.outside.percentile > result.local.limits.outsideP99);
  assert.equal(Object.hasOwn(result.local.checks, 'outsideP99'), false);
  assert.equal(result.local.diagnostics.outsideP99.withinLimit, false);
  assert.equal(result.local.diagnostics.outsideP99.gatesImport, false);
  assert.equal(result.global.checks.outsideMean, false);
  assert.equal(result.global.pass, false);
});

test('seam ignores only opaque coverage, retains visible defects and rejects fully-hidden boundaries', () => {
  const result = run(`
changed=base.copy();ImageDraw.Draw(changed).rectangle((25,34,31,43),fill=(0,255,0,255))
coverage=Image.new('L',base.size);ImageDraw.Draw(coverage).rectangle((23,32,33,45),fill=255)
hidden=check_seam(base,changed,mask,1,occlusion=coverage)
partial=check_seam(base,changed,mask,1,occlusion=coverage.point(lambda a: 254 if a else 0))
visible=changed.copy();ImageDraw.Draw(visible).rectangle((64,48,70,57),fill=(0,255,0,255))
full=check_seam(base,base,mask,1,occlusion=Image.new('L',base.size,255))
print(json.dumps({'hidden':hidden,'partial':partial,'visible':check_seam(base,visible,mask,1,occlusion=coverage),'full':full}))
`);
  assert.equal(result.hidden.pass, true);
  assert.ok(result.hidden.occlusion.ignoredFraction > 0 && result.hidden.occlusion.ignoredFraction < 0.5);
  assert.equal(result.partial.pass, false);
  assert.equal(result.partial.occlusion.ignoredPairs, 0);
  assert.equal(result.visible.pass, false);
  assert.equal(result.full.checks.boundaryVisibility, false);
  assert.equal(result.full.occlusion.ignoredFraction, 1);
});

test('visible boundary length gates heavily occluded artwork without weakening visible defect checks', () => {
  const result = run(`
coverage=Image.new('L',base.size);ImageDraw.Draw(coverage).rectangle((0,0,55,95),fill=255)
enough=check_seam(base,base,mask,1,occlusion=coverage)
changed=base.copy();ImageDraw.Draw(changed).rectangle((64,36,70,48),fill=(0,255,0,255))
defect=check_seam(base,changed,mask,1,occlusion=coverage)
ImageDraw.Draw(coverage).rectangle((0,0,66,95),fill=255)
short=check_seam(base,base,mask,1,occlusion=coverage)
print(json.dumps({'enough':enough,'defect':defect,'short':short}))
`);
  assert.ok(result.enough.occlusion.ignoredFraction > 0.5);
  assert.equal(result.enough.occlusion.visiblePairs, 64);
  assert.equal(result.enough.pass, true);
  assert.equal(result.defect.checks.boundaryVisibility, true);
  assert.equal(result.defect.pass, false);
  assert.ok(result.short.occlusion.visiblePairs < result.short.occlusion.minimumVisiblePairs);
  assert.equal(result.short.checks.boundaryVisibility, false);
});

test('blush stays four native pixels inside face contours and eye masks include lateral eyelash tips', () => {
  const result = run(`
from expression_masks import cheek_mask, expand_eye_sides
layers={}
for name,box in [('face',(12,8,83,87)),('eyewhite',(30,25,65,32)),('eyelash',(24,29,72,30)),('mouth_close',(42,59,53,61))]:
    im=Image.new('RGBA',base.size);ImageDraw.Draw(im).rectangle(box,fill=(180,140,120,255));layers[name]=im
cheeks=cheek_mask(layers,base.size)
layers['eyelash'].putpixel((73,29),(180,140,120,8))
eyes=expand_eye_sides(Image.new('L',base.size),layers,4)
print(json.dumps({'cheekBox':cheeks.getbbox(),'eyes':[eyes.getpixel((x,29)) for x in (19,20,24,72,77,78)]}))
`);
  assert.ok(result.cheekBox[0] >= 16 && result.cheekBox[2] <= 80);
  assert.deepEqual(result.eyes, [0,255,255,255,255,0]);
});


test('expanded eye masks exclude dilated eyebrow and hidden front-hair pixels at native scale', () => {
  const result = run(`
import tempfile
from pathlib import Path
from expression_masks import exclude_eye_obstacles
with tempfile.TemporaryDirectory() as directory:
    root=Path(directory)
    mapping={'layers':[{'source':'brow.png','target':'eyebrow'},{'source':'hair.png','target':'front hair'}]}
    for name,box in [('brow',(20,20,60,22)),('hair',(44,0,46,50))]:
        im=Image.new('RGBA',base.size); ImageDraw.Draw(im).rectangle(box,fill=(0,0,0,255));im.save(root/(name+'.png'))
    mask=Image.new('L',base.size);ImageDraw.Draw(mask).rectangle((10,10,80,70),fill=255)
    protected=exclude_eye_obstacles(mask,root,mapping)
    eye=Image.new('L',base.size);ImageDraw.Draw(eye).rectangle((42,40,48,43),fill=255)
    preserved=exclude_eye_obstacles(mask,root,mapping,eye_support=eye,eye_padding=4)
    print(json.dumps({'pixels':[protected.getpixel(p) for p in [(20,16),(20,26),(20,27),(40,45),(50,45),(51,45),(30,40)]],
                      'eyeEnvelope':[preserved.getpixel(p) for p in [(38,40),(52,40),(44,36),(44,47),(44,48),(20,20)]],
                      'empty':protected.getbbox() is None}))
`);
  assert.deepEqual(result.pixels, [0,0,255,0,0,255,255]);
  assert.equal(result.empty, false);
  assert.deepEqual(result.eyeEnvelope, [255,255,255,255,0,0]);
});
