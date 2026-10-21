import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import test from 'node:test';
import {expressionPresetValues} from '../src/expressionPresets.mjs';
import {createMouthController,mouthRestWeight,mouthContour} from '../webui/src/rig/mouthExpression.mjs';

const contours={
  mouth_close:{left:40,right:140,top:[70,72,70],bottom:[71,73,71]},
  mouth_open:{left:40,right:140,top:[70,67,70],bottom:[71,120,71]},
  mouth_laugh:{left:30,right:150,top:[65,70,65],bottom:[66,125,66]},
  mouth_round:{left:70,right:110,top:[70,60,70],bottom:[71,125,71]},
};

test('mouth shape keeps speech independent, clears its resting opening and obeys camera closure',()=>{
  const c=createMouthController(contours);
  assert.equal(c.resolve({mouthOpen:0}).drawing,'mouth_close');
  assert.equal(c.resolve({mouthLaugh:1}).openness,.22);
  assert.equal(c.resolve({mouthRound:1}).openness,.4);
  assert.equal(c.resolve({mouthLaugh:1,mouthOpen:.8}).openness,.8);
  assert.equal(c.resolve({mouthLaugh:1},mouthRestWeight(0,1)).openness,0);
  assert.equal(c.resolve({mouthRound:1,expressionMouthOpen:.16},mouthRestWeight(0,1)).openness,0);
  assert.equal(c.resolve({mouthLaugh:0,mouthRound:0}).openness,0);
  assert.equal(c.resolve({mouthLaugh:1},mouthRestWeight(undefined,0)).openness,.22);
});

test('small input oscillations do not alternate mouth drawings at either handoff',()=>{
  const c=createMouthController(contours);
  c.resolve({mouthOpen:0,mouthEase:.5});
  const closed=new Set(Array.from({length:100},(_,i)=>c.resolve({mouthOpen:.1+(i%2?.004:-.004),mouthEase:.5}).drawing));
  assert.deepEqual([...closed],['mouth_close']);
  c.resolve({mouthOpen:.4,mouthEase:.5});
  const opened=new Set(Array.from({length:100},(_,i)=>c.resolve({mouthOpen:.1+(i%2?.004:-.004),mouthEase:.5}).drawing));
  assert.deepEqual([...opened],['mouth_open']);
  const seam=new Set(Array.from({length:100},(_,i)=>c.resolve({mouthOpen:.8,mouthLaugh:.5+(i%2?.006:-.006)}).drawing));
  assert.deepEqual([...seam],['mouth_close']);
  assert.equal(c.resolve({mouthOpen:.8,mouthLaugh:.8}).drawing,'mouth_laugh');
});

test('shape handoff uses matching geometry, while a full opening restores the selected drawing',()=>{
  const c=createMouthController(contours);
  const seam=c.resolve({mouthOpen:1,mouthLaugh:.5});
  for(const name of ['mouth_open','mouth_laugh']) {
    const p=contours[name],top=c.warp((p.left+p.right)/2,p.top[1],name,seam),bottom=c.warp((p.left+p.right)/2,p.bottom[1],name,seam);
    assert.equal(top.x,90);assert.equal(top.y,72);assert.equal(bottom.y,73);
  }
  const full=c.resolve({mouthOpen:1,mouthRound:1});
  assert.equal(full.drawing,'mouth_round');
  assert.equal(c.warp(90,60,'mouth_round',full).y,60);
  assert.equal(c.warp(90,125,'mouth_round',full).y,125);
});

test('rebuilding an avatar retains the hysteresis choice near a mouth handoff',()=>{
  const first=createMouthController(contours);
  first.resolve({mouthOpen:.4});
  const frame=first.resolve({mouthOpen:.1});
  assert.equal(frame.drawing,'mouth_open');
  const restored=createMouthController(contours);
  restored.setState(first.getState());
  assert.equal(restored.resolve({mouthOpen:.1}).drawing,frame.drawing);
});

test('missing round art uses a separate resting floor that neutral clears',()=>{
  const values=expressionPresetValues('surprised',[]);
  assert.equal(values.mouthRound,0);assert.equal(values.expressionMouthOpen,.75);
  assert.equal(Object.hasOwn(values,'mouthOpen'),false);
  const c=createMouthController({mouth_close:contours.mouth_close,mouth_open:contours.mouth_open});
  assert.equal(c.resolve(values).openness,.75);
  assert.equal(c.resolve(values,mouthRestWeight(0,1)).openness,0);
  assert.equal(c.resolve(expressionPresetValues('neutral',[])).openness,0);
  assert.equal(expressionPresetValues('joy',[]).mouthForm,.65);
});

test('isolated mouth import registers only a bounded offset and rejects a skin patch',()=>{
  const r=spawnSync('python3',['-c',`
import sys
sys.path.insert(0,'scripts')
from PIL import Image,ImageDraw
from overlay_expression import register_mouth_overlay,alpha_centroid,validate_overlay_artwork
skin=Image.new('RGBA',(100,100),(255,224,205,255))
mask=Image.new('L',(100,100));ImageDraw.Draw(mask).rectangle((20,50,80,90),fill=255)
reference=Image.new('RGBA',(100,100));ImageDraw.Draw(reference).line((40,70,60,70),fill=(70,30,30,255))
source=Image.new('RGBA',(100,100));ImageDraw.Draw(source).ellipse((43,57,63,75),fill=(120,45,50,255))
registered,details=register_mouth_overlay(source,reference,[0,0,100,100],(100,100))
assert abs(alpha_centroid(registered)[0]-50)<.1 and abs(alpha_centroid(registered)[1]-70)<.1
assert details['dxNative']==-3 and details['dyNative']==4
assert all(validate_overlay_artwork(registered,mask,'mouth_round',skin)['checks'].values())
bad=Image.new('RGBA',(100,100));ImageDraw.Draw(bad).rectangle((35,55,65,85),fill=(255,224,205,255))
try:validate_overlay_artwork(bad,mask,'mouth_round',skin);raise AssertionError('skin accepted')
except ValueError:pass
try:register_mouth_overlay(source,reference,[30,0,130,100],(100,100));raise AssertionError('unbounded move accepted')
except ValueError:pass
`],{encoding:'utf8'});assert.equal(r.status,0,r.stderr);
});


test('lip registration ignores pale extraction residue around the mouth ink',()=>{
  const data=new Uint8ClampedArray(100*20*4);
  const paint=(x,y,color)=>data.set([...color,255],(y*100+x)*4);
  for(let x=0;x<100;x++)paint(x,2,[255,230,210]);
  for(let x=30;x<70;x++)for(let y=8;y<18;y++)paint(x,y,[110,45,50]);
  const layer={x:0,y:0,img:{width:100,height:20,data}};
  assert.equal(mouthContour(layer).left,0);
  assert.equal(mouthContour(layer,true).left,30);
  assert.equal(mouthContour(layer,true).right,70);
});


test('a separate lower-lip edge does not thicken the closed-mouth handoff',()=>{
 const data=new Uint8ClampedArray(20*20*4);
 for(let x=2;x<18;x++){data.set([80,40,30,200],(5*20+x)*4);data.set([130,100,90,80],(15*20+x)*4);}
 const layer={x:0,y:0,img:{width:20,height:20,data}};
 assert.equal(mouthContour(layer,true).bottom[8],16);
 const line=mouthContour(layer,true,true);
 assert.equal((line.top[8]+line.bottom[8])/2,5.5);
 assert.ok(line.bottom[8]-line.top[8]<1.2);
});

test('closed lip fill folds behind its ink before a drawing handoff',()=>{
 const c=createMouthController(contours),begin=c.resolve({mouthOpen:0}),end=c.resolve({mouthOpen:.09});
 assert.equal(c.warp(90,85,'mouth_close',begin).y,85);
 assert.equal(c.warp(90,85,'mouth_close',end).y,73);
 assert.equal(c.warp(90,72,'mouth_close',end).y,72);
});
