import test from 'node:test';
import assert from 'node:assert/strict';
import { createEyeDrawingSlot, eyeDrawingAlpha, eyeSlotParameters } from '../webui/src/rig/eyeDrawing.mjs';
import { drawnBlinkOpacity } from '../webui/src/rig/drawnEye.mjs';
import { SMILE_SWITCH } from '../webui/src/rig/eyeExpression.mjs';
import { createMouthController } from '../webui/src/rig/mouthExpression.mjs';
import { expressionParameterNames, expressionPresetValues } from '../src/expressionPresets.mjs';

test('interrupted presets keep one eye drawing per side and one mouth at 30 fps', () => {
  const parts=['eye_smile','eye_close','eyes_angry','mouth_laugh','mouth_frown'];
  const slots={L:createEyeDrawingSlot(),R:createEyeDrawingSlot()};
  const contour={left:0,right:10,top:[0,0],bottom:[1,1]};
  const mouth=createMouthController(Object.fromEntries(['mouth_open','mouth_close','mouth_laugh','mouth_frown'].map(name=>[name,contour])));
  let target=expressionPresetValues('neutral',parts),start={...target},current={...target},began=0;
  const events=[[0,'joy'],[600,'angry'],[700,'wink'],[800,'neutral'],[900,'joy'],[1000,'angry'],[1100,'wink'],[1200,'neutral'],[1600,'joy'],[1850,'angry'],[1950,'wink'],[2075,'neutral'],[2500,'angry']];
  let index=0;const seen={L:new Set(),R:new Set()};
  for(let frame=0;frame<120;frame++) {
    const at=frame*1000/30;
    while(index<events.length&&events[index][0]<=at) {
      start={...target};began=at;target.destination=expressionPresetValues(events[index++][1],parts);
    }
    const progress=Math.min(1,(at-began)/250),ease=progress*progress*(3-2*progress);
    for(const key of expressionParameterNames) {
      target[key]=start[key]+((target.destination?.[key]??start[key])-start[key])*ease;
      current[key]+=(target[key]-current[key])*14/30;
    }
    for(const side of ['L','R']) {
      const smile=Math.max(current.eyeSmile,current[`eyeSmile${side}`],current[`eyeWink${side}`]);
      const drawing=slots[side].resolve(smile,current.eyeAngry);seen[side].add(drawing);
      const blink=drawnBlinkOpacity(1);
      const alpha=['eyeOpen','eyeSmile','eyeAngry'].map(fade=>eyeDrawingAlpha(fade,'',drawing,blink,1));
      assert.equal(alpha.filter(a=>a>0).length,1,`frame ${frame}, ${side}`);
      const params=eyeSlotParameters(current,side,drawing);
      assert.ok(!(params.eyeAngry>0 && params.eyeSmile>0));
    }
    const result=mouth.resolve({...current,mouthOpen:0});
    assert.equal(['mouth_open','mouth_close','mouth_laugh','mouth_frown'].filter(name=>name===result.drawing).length,1);
  }
  assert.ok(seen.L.has('smile'));assert.ok(seen.R.has('smile'));
  assert.ok(seen.L.has('angry'));assert.ok(seen.R.has('angry'));
});

test('eye slot restores the displayed drawing and allows only the blink exception', () => {
  const slot=createEyeDrawingSlot();slot.resolve(0,1);slot.setState(slot.getState());
  assert.equal(slot.getState(),'angry');
  for(const open of [0,.05,.5,.95,1]) {
    const blink=drawnBlinkOpacity(open);
    const alpha=fade=>eyeDrawingAlpha(fade,'',slot.getState(),blink,1);
    assert.equal(alpha('eyeSmile'),0);assert.equal(alpha('eyeOpen'),0);
    assert.equal(alpha('eyeAngry')+alpha('eyeClose'),1);
    if(open===0)assert.equal(alpha('eyeAngry'),0);
    if(open===1)assert.equal(alpha('eyeClose'),0);
    assert.equal(eyeDrawingAlpha(undefined,'eyebrow','angry',blink,1),alpha('eyeClose'));
  }
  slot.resolve(1,0);assert.equal(slot.getState(),'smile');
  slot.resolve(0,0);assert.equal(slot.getState(),'neutral');
});

test('blink freezes an interrupted transition and commits the latest request at closure', () => {
  const slot=createEyeDrawingSlot();slot.request(0,1);
  slot.resolve(0,0,1,.1);
  const before=slot.getFrame();
  slot.resolve(0,1,.8,.033);
  slot.request(1,0);
  for(const open of [.6,.3]) {
    slot.resolve(0,1,open,.033);
    assert.equal(slot.getFrame().angry,before.angry);
    assert.equal(slot.getFrame().smile,before.smile);
  }
  assert.equal(slot.resolve(0,1,0,.033),'smile');
  assert.equal(slot.getFrame().smile,1);
  for(const open of [.2,.7,1])assert.equal(slot.resolve(0,1,open,.033),'smile');
  assert.equal(slot.getFrame().angry,0);
});

test('requests on reopening start their transition at full opening and survive restoration', () => {
  const slot=createEyeDrawingSlot('smile');slot.request(1,0);
  slot.resolve(1,0,.5);slot.resolve(1,0,0);slot.resolve(1,0,.3);
  slot.request(0,1);
  const replacement=createEyeDrawingSlot();replacement.restore(slot.getSnapshot());
  assert.equal(replacement.resolve(0,1,.6),'smile');
  assert.equal(replacement.getFrame().angry,0);
  assert.equal(replacement.resolve(0,1,1,.05),'smile');
  assert.ok(replacement.getFrame().angry>0);
  assert.equal(replacement.resolve(0,1,1,.2),'angry');
  assert.equal(replacement.getFrame().angry,1);
});

test('a blink leaves smiling eyes unchanged instead of fading to the closed drawing', () => {
  for(const open of [0,.25,.5,.75,1]) {
    const blink=drawnBlinkOpacity(open);
    const alpha=fade=>eyeDrawingAlpha(fade,'','smile',blink,1);
    assert.equal(alpha('eyeOpen'),0);assert.equal(alpha('eyeAngry'),0);
    assert.equal(alpha('eyeSmile'),1);assert.equal(alpha('eyeClose'),0);
  }
});

test('sad artwork replaces other eyes and commits at closure without a neutral-face substitute',()=>{
  const slot=createEyeDrawingSlot();slot.request(0,0,0,1);
  assert.equal(slot.resolve(0,0,1,.25,0,1),'sad');
  for(const open of [1,.5,0]){
    const blink=drawnBlinkOpacity(open);
    assert.equal(eyeDrawingAlpha('eyeSad','','sad',blink,1),blink.open);
    assert.equal(eyeDrawingAlpha('eyeAngry','','sad',blink,1),0);
    assert.equal(eyeDrawingAlpha('eyeSmile','','sad',blink,1),0);
    assert.equal(eyeDrawingAlpha('eyeOpen','','sad',blink,1),0);
  }
  slot.resolve(0,0,.5,.033,0,1);slot.request(0,1);
  assert.equal(slot.resolve(0,1,.25,.033),'sad');
  assert.equal(slot.resolve(0,1,0,.033),'angry');
  const preset=expressionPresetValues('sad',['eyes_sad','mouth_frown','tears']);
  assert.equal(preset.eyeSad,1);assert.equal(preset.mouthFrown,1);assert.equal(preset.tears,1);
  for(const key of ['browWorry','upperLid','lidTilt','mouthForm'])assert.equal(preset[key],0);
  assert.equal(expressionPresetValues('sad',[]).eyeSad,0);
});

test('every drawn expression remains exclusive through interrupted transitions and blinks',async()=>{
  const {drawnEyeDefinitions}=await import('../webui/src/rig/eyeDrawing.mjs');
  const parts=drawnEyeDefinitions.map(def=>def.part);
  const slot=createEyeDrawingSlot();
  for(const def of drawnEyeDefinitions){
    slot.requestFrame({[def.drawing]:1});
    for(let n=0;n<5;n++)slot.resolveFrame({},1,.02);
    const before=slot.getFrame(),drawing=slot.getState();
    slot.resolveFrame({},.7);slot.requestFrame({[def.drawing]:1});
    slot.resolveFrame({},.3);
    assert.equal(slot.getState(),drawing);
    for(const key of Object.keys(before).filter(key=>key!=='locked'))assert.equal(slot.getFrame()[key],before[key]);
    slot.resolveFrame({},0);assert.equal(slot.getState(),def.drawing);
    for(const open of [0,.3,.7,1]){
      slot.resolveFrame({},open);
      const blink=drawnBlinkOpacity(open);
      for(const other of drawnEyeDefinitions)assert.equal(eyeDrawingAlpha(other.parameter,'',slot.getState(),blink,1),other===def?blink.open:0);
      assert.equal(eyeDrawingAlpha('eyeOpen','',slot.getState(),blink,1),0);
      assert.equal(eyeDrawingAlpha(undefined,'eyebrow',slot.getState(),blink,1),blink.closed);
    }
  }
  for(const [id,key] of [['shy','eyeShy'],['surprised','eyeSurprised'],['flustered','eyeFlustered'],['unamused','eyeHalf']]){
    const values=expressionPresetValues(id,parts);
    assert.equal(values[key],1);assert.equal(expressionPresetValues(id,[])[key],0);
    for(const legacy of ['upperLid','browWorry','browFlat','brow','eyeWide','mouthForm'])assert.equal(values[legacy],0);
  }
});

test('open eyes stay below the smile switch point while the slot still shows them', () => {
  for(const smile of [.5,.5004,.8]) {
    assert.ok(eyeSlotParameters({eyeSmile:smile},'L','neutral').eyeSmile<SMILE_SWITCH);
    assert.equal(eyeSlotParameters({eyeSmile:smile},'L','smile').eyeSmile,smile);
  }
});
