import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import test from 'node:test';
import {expressionPresetValues} from '../src/expressionPresets.mjs';

test('overlay validation rejects opaque, painted checkerboard, misplaced and hair-colored art',()=>{
 const r=spawnSync('python3',['-c',`
import sys
sys.path.insert(0,'scripts')
from PIL import Image,ImageDraw
from overlay_expression import validate_overlay_artwork
mask=Image.new('L',(100,100));ImageDraw.Draw(mask).rectangle((20,20,60,60),fill=255)
good=Image.new('RGBA',(100,100));ImageDraw.Draw(good).ellipse((30,30,45,55),fill=(100,180,255,190))
assert all(validate_overlay_artwork(good,mask,'sweat')['checks'].values())
for bad in [Image.new('RGBA',(100,100),'white'),Image.new('RGBA',(100,100),(220,220,220,255))]:
 try:validate_overlay_artwork(bad,mask,'sweat');raise AssertionError('background accepted')
 except ValueError:pass
for color,box in [((100,180,255,255),(5,5,10,10)),((140,100,65,255),(30,30,45,55)),((245,245,245,255),(25,25,58,58))]:
 bad=Image.new('RGBA',(100,100));ImageDraw.Draw(bad).rectangle(box,fill=color)
 try:validate_overlay_artwork(bad,mask,'sweat');raise AssertionError('bad art accepted')
 except ValueError:pass
`],{encoding:'utf8'});assert.equal(r.status,0,r.stderr);
});

test('overlays augment the intended faces only when matching artwork exists',()=>{
 const parts=['tears','sweat','anger_mark'];
 assert.equal(expressionPresetValues('sad',parts).tears,1);
 assert.equal(expressionPresetValues('flustered',parts).sweat,1);
 assert.equal(expressionPresetValues('angry',parts).angerMark,1);
 for(const id of ['sad','flustered','angry']){const p=expressionPresetValues(id,[]);assert.equal(p.tears,0);assert.equal(p.sweat,0);assert.equal(p.angerMark,0);}
});
