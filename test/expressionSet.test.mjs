import assert from 'node:assert/strict';
import test from 'node:test';
import { expressionParameterNames, expressionPresets, expressionPresetValues, expressionPresetAvailability } from '../src/expressionPresets.mjs';
import { composeTrackedExpression, morphClosedWink, shapeBrow, shapeUpperLid, shapeWink, smileForSide } from '../webui/src/rig/expressionParts.mjs';
import { parseLiveState } from '../webui/src/live/protocol.mjs';
import { morphDrawnEye, drawnBlinkOpacity } from '../webui/src/rig/drawnEye.mjs';

const anchor = { x0: 20, x1: 80, y0: 30, y1: 70, icx: 50, icy: 50,
  upperLid: [{x:20,y:35},{x:50,y:30},{x:80,y:35}], browBounds:{x0:20,x1:80,y0:10,y1:20} };

test('all nine expressions replace only expression controls and skip absent artwork', () => {
  assert.equal(expressionPresets.length, 9);
  for (const preset of expressionPresets) {
    const values = expressionPresetValues(preset.id);
    assert.deepEqual(Object.keys(values), [...expressionParameterNames]);
    assert.equal(values.eyeSmile, 0); assert.equal(values.eyeSmileL, 0); assert.equal(values.blush, 0);
    assert.ok(Object.values(values).every(Number.isFinite));
    assert.ok(!('angleX' in values) && !('eyeOpenL' in values) && !('mouthOpen' in values));
  }
  assert.ok(Object.values(expressionPresetValues('neutral')).every(v=>v===0));
  assert.equal(expressionPresetValues('wink',['eye_smile']).eyeSmileL, 1);
  assert.equal(expressionPresetValues('wink',['eye_close']).eyeWinkL, 1);
  assert.equal(expressionPresetValues('joy',[]).eyeNarrow, 0);
  assert.throws(()=>expressionPresetValues('missing'));
});

test('anger uses only its artwork, without symbols or deformed neutral features', () => {
  const values=expressionPresetValues('angry',['eyes_angry','mouth_frown','anger_mark']);
  assert.equal(values.eyeAngry,1); assert.equal(values.mouthFrown,1);
  for(const key of ['browAngry','upperLid','lidTilt','mouthForm','angerMark'])assert.equal(values[key],0);
  assert.equal(expressionPresetValues('angry',['eyes_angry']).mouthFrown,0);
  assert.deepEqual(expressionPresetAvailability('angry',[]),{available:false,reason:'この表情の絵がありません'});
  assert.equal(expressionPresetAvailability('angry',['eyes_angry']).available,true);
});

test('drawn eyes share halfway bounds and return to unchanged artwork at the endpoints', () => {
  const features={eye:{x0:22,x1:78,y0:38,y1:68},brow:null,browCurve:[],browCut:30};
  assert.deepEqual(morphDrawnEye(20,30,anchor,features,0,false),{x:20,y:30});
  assert.deepEqual(morphDrawnEye(22,38,anchor,features,1,true),{x:22,y:38});
  assert.deepEqual(morphDrawnEye(20,30,anchor,features,.5,false),morphDrawnEye(22,38,anchor,features,.5,true));
  assert.deepEqual(morphDrawnEye(80,70,anchor,features,.5,false),morphDrawnEye(78,68,anchor,features,.5,true));
});

test('the drawn anger blink fades only between single-drawing endpoints', () => {
  assert.deepEqual(drawnBlinkOpacity(1),{open:1,closed:0});
  assert.deepEqual(drawnBlinkOpacity(0),{open:0,closed:1});
  assert.deepEqual(drawnBlinkOpacity(.5),{open:.5,closed:.5});
  for(const value of [-1,.1,.25,.75,.9,2]) {
    const frame=drawnBlinkOpacity(value);
    assert.equal(frame.open+frame.closed,1);
    assert.ok(frame.open>=0&&frame.open<=1);
  }
});

test('upper lid narrows from above, slightly raises the lower boundary and preserves lash thickness', () => {
  for (const strength of [0,.25,.5,.75,1]) {
    const p={upperLid:strength,faceCenterX:100};
    const top=shapeUpperLid(50,30,anchor,p,true), band=shapeUpperLid(50,34,anchor,p,true);
    assert.equal(band.y-top.y,4);
    assert.ok(shapeUpperLid(50,70,anchor,p).y<=70 && shapeUpperLid(50,70,anchor,p).y>=68);
    assert.ok(top.y>=30 && top.y<=48);
    assert.deepEqual(shapeUpperLid(50,30,anchor,p,true,false,1),{x:50,y:30});
  }
  const wide=shapeUpperLid(60,60,anchor,{eyeWide:1,faceCenterX:100},false,true);
  assert.ok(wide.x<60 && wide.y<60);
  assert.ok(shapeUpperLid(80,35,anchor,{upperLid:1,lidTilt:1,faceCenterX:100}).y > shapeUpperLid(20,35,anchor,{upperLid:1,lidTilt:1,faceCenterX:100}).y);
});

test('brow shape bends inner and outer ends differently and mirrors across the face', () => {
  const left=shapeBrow(80,15,anchor,'L',{browWorry:1});
  const outer=shapeBrow(20,15,anchor,'L',{browWorry:1});
  const right=shapeBrow(20,15,anchor,'R',{browWorry:1});
  assert.equal(left.y,right.y); assert.ok(left.y<15 && outer.y>15);
  const angry=shapeBrow(80,15,anchor,'L',{browAngry:1});assert.ok(angry.y>15 && angry.x>80);
  assert.ok(shapeBrow(50,15,anchor,'L',{browAngry:1}).y !== (angry.y+shapeBrow(20,15,anchor,'L',{browAngry:1}).y)/2);
});

test('wink affects one side and camera mouth and brow add without replacing the expression', () => {
  const p={eyeSmile:0,eyeSmileL:1,eyeSmileR:0};assert.equal(smileForSide(p,'L'),1);assert.equal(smileForSide(p,'R'),0);
  assert.equal(composeTrackedExpression('mouthForm',.6,.2,1),.8);
  assert.equal(composeTrackedExpression('brow',.6,.8,1),1);
  assert.equal(composeTrackedExpression('eyeOpenL',1,0,1),0);
  assert.equal(composeTrackedExpression('angleX',.5,-.5,1),-.5);
});

test('live state preserves bounded expression parts and rejects unrecognized controls', () => {
  const state={source:'source_123',psd:'test',input:null,weight:0,settings:{mode:'static',autoBlink:false,eyeOpen:1,mouthOpen:0,parameters:{eyeSmileL:1,eyeSmileR:0,browAngry:2,upperLid:.5,lidTilt:-2,eyeWide:.7},tuning:{}}};
  const parsed=parseLiveState(state); assert.equal(parsed.settings.parameters.browAngry,1);assert.equal(parsed.settings.parameters.lidTilt,-1);
  assert.throws(()=>parseLiveState({...state,settings:{...state.settings,parameters:{unknown:1}}}));
});

test('motion QA rejects missing part, blink or transition captures and a wink moving both eyes', async () => {
  const {evaluateExpressionSetCaptures}=await import('../src/motionQa.mjs');
  const {expressionPartCases,expressionTransitionPairs}=await import('../webui/scripts/expression-set-captures.mjs');
  const frame={width:100,height:100,data:new Uint8ClampedArray(40000)}, captures={};
  for(const item of expressionPartCases) captures[`part-${item.id}`]=[0,.5,1].map(t=>({label:`strength-${t.toFixed(2)}`,frame}));
  for(const item of expressionPresets) captures[`preset-${item.id}`]=[1,.5,0].map(t=>({label:`eye-${t.toFixed(2)}`,frame}));
  for(const [a,b] of expressionTransitionPairs) captures[`transition-${a}-${b}`]=[0,.25,.5,.75,1].map(t=>({label:`progress-${t.toFixed(2)}`,frame}));
  const evaluate=()=>evaluateExpressionSetCaptures(captures,{eyeR:anchor});
  assert.ok(Object.values(evaluate()).every(Boolean));
  captures['part-upperLid'].pop(); assert.equal(evaluate().expressionPartsCaptured,false);
  captures['preset-joy'].pop();assert.equal(evaluate().expressionPresetsCaptured,false);
  captures['transition-joy-angry'].pop();assert.equal(evaluate().expressionTransitionsCaptured,false);
  const moved={...frame,data:new Uint8ClampedArray(frame.data)};moved.data[(50*100+50)*4]=50;
  captures['preset-wink'][0].frame=moved;assert.equal(evaluate().winkKeepsOtherEye,false);
});

test('flattening a curved brow preserves ink thickness instead of squeezing it', () => {
  const curved={...anchor,browCurve:[{x:20,y:18},{x:50,y:10},{x:80,y:18}]};
  for(const x of [20,50,80]) {
    const a=shapeBrow(x,12,curved,'L',{browFlat:1}), b=shapeBrow(x,16,curved,'L',{browFlat:1});
    assert.equal(b.y-a.y,4);
  }
  const angryInner=shapeBrow(80,18,curved,'L',{browAngry:1});
  const angryOuter=shapeBrow(20,18,curved,'L',{browAngry:1});
  assert.ok(angryInner.y>angryOuter.y+15);
});

test('fallback wink reaches the closed-eye anchor with visible upper ink and no remaining white eye', () => {
  const a={...anchor,closeY:65};
  assert.deepEqual(shapeWink(50,30,a,0,true),{x:50,y:30});
  const top=shapeWink(50,30,a,1,true), bottom=shapeWink(50,34.8,a,1,true);
  assert.ok(bottom.y-top.y>=2);
  assert.ok(Math.abs((top.y+bottom.y)/2-a.closeY)<2);
  assert.equal(shapeWink(50,70,a,1).y,65);
  assert.equal(shapeWink(50,30,a,1).y,65);
});

test('blink artwork preserves ink thickness and endpoints throughout the handoff', () => {
  const a={...anchor,closeY:65,closedBounds:{x0:25,x1:75,y0:60,y1:70},closedCurve:[{x:25,y:65},{x:75,y:65}]};
  assert.deepEqual(morphClosedWink(30,62,a,1),{x:30,y:62});
  const top=morphClosedWink(50,60,a,0),bottom=morphClosedWink(50,70,a,0);
  assert.equal(bottom.y-top.y,10);assert.equal((top.y+bottom.y)/2,65);
  for (const restore of [0,.25,.5,.75,1]) {
    assert.equal(morphClosedWink(25,65,a,restore).x,25);
    assert.equal(morphClosedWink(50,70,a,restore).y-morphClosedWink(50,60,a,restore).y,10);
  }
});


test('lowered lids flatten the crease, preserve both ink bands and tighten the lower boundary',()=>{
  const a={...anchor,creaseCurve:[{x:20,y:25},{x:50,y:20},{x:80,y:25}]};
  const p={upperLid:1,faceCenterX:100};
  const center=shapeUpperLid(50,20,a,p,true),edge=shapeUpperLid(40,20+5/3,a,p,true);
  assert.ok(Math.abs(center.y-edge.y)<.001);
  assert.equal(shapeUpperLid(50,21,a,p,true).y-center.y,1);
  const lash=shapeUpperLid(50,30,a,p,true);
  assert.ok(center.y>20 && center.y<lash.y-2);
  assert.ok(center.y-20<lash.y-30);
  const angry={...p,lidTilt:1};
  assert.ok(shapeUpperLid(50,70,a,angry).y<shapeUpperLid(50,70,a,p).y);
  for(let i=0;i<=20;i++) {
    const values={...angry,upperLid:i/20};
    assert.ok(shapeUpperLid(50,34,a,values,true).y-shapeUpperLid(50,30,a,values,true).y>=3.99);
  }
});
