import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  SEAM_COLOR,
  changedPixels,
  evaluateMotionQa,
  evaluateExpressionCaptures,
  erode,
  featureResiduals,
  fixedFeatureComparison,
  loadMotionContract,
  motionLayerPreflight,
  seamPixels,
  silhouette,
  trackPatch,
} from '../src/motionQa.mjs';

function frame(width, height, fill = [255, 255, 255]) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let index = 0; index < width * height; index += 1) data.set([...fill, 255], index * 4);
  return { width, height, data };
}

function paint(target, x0, y0, x1, y1, color) {
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) target.data.set([...color, 255], (y * target.width + x) * 4);
  }
}

test('tracks a textured patch to its shifted position', () => {
  const reference = frame(120, 120);
  paint(reference, 40, 40, 60, 52, [30, 30, 30]);
  paint(reference, 46, 44, 52, 48, [200, 60, 60]);
  const moved = frame(120, 120);
  paint(moved, 47, 35, 67, 47, [30, 30, 30]);
  paint(moved, 53, 39, 59, 43, [200, 60, 60]);
  const result = trackPatch(reference, moved, { x0: 36, y0: 36, x1: 64, y1: 56 }, 20);
  assert.deepEqual([result.dx, result.dy], [7, -5]);
});

test('native SSD tracks one-pixel lips at every sampling phase inside the original radius', () => {
  for (const row of [40, 41]) for (const [dx, dy] of [[-16,-1],[13,2],[0,1],[24,0],[-35,0],[36,0]]) {
    const reference = frame(160, 120, [248,210,195]);
    paint(reference, 70, row, 82, row+1, [160,100,90]);
    const moved = frame(160, 120, [248,210,195]);
    paint(moved, 70+dx, row+dy, 82+dx, row+dy+1, [160,100,90]);
    const result = trackPatch(reference, moved, {x0:60,y0:30,x1:92,y1:57});
    assert.deepEqual([result.dx,result.dy], [dx,dy]);
    assert.equal(result.status, 'matched');
  }
});

test('flat, lost and ambiguous tracks are explicit instead of arbitrary positions', () => {
  assert.equal(trackPatch(frame(100,100),frame(100,100),{x0:40,y0:40,x1:50,y1:50}).status,'lost');
  const reference=frame(120,100),moved=frame(120,100);
  paint(reference,52,45,56,46,[30,20,20]);
  paint(moved,42,45,46,46,[30,20,20]);paint(moved,62,45,66,46,[30,20,20]);
  assert.equal(trackPatch(reference,moved,{x0:48,y0:40,x1:60,y1:50}).status,'ambiguous');
});

function fixedFixture() {
  const neutral=frame(160,140,[245,205,185]);
  paint(neutral,30,30,50,50,[50,35,25]);paint(neutral,36,34,41,42,[200,150,100]);
  paint(neutral,95,30,115,50,[60,40,30]);paint(neutral,102,35,108,42,[190,140,90]);
  paint(neutral,70,93,90,95,[110,60,45]);
  const anchors={eyeL:{x0:30,y0:30,x1:50,y1:50},eyeR:{x0:95,y0:30,x1:115,y1:50},mouth:{x0:70,y0:90,x1:90,y1:97}};
  return {neutral,anchors,empty:new Uint8Array(160*140)};
}

function evaluateFixedFixture(neutral, moving, anchors, inspectionNeutral, inspectionMoving) {
  const contract=loadMotionContract();
  const captures=Object.fromEntries(contract.requiredCaptures.map(name=>[name,
    (name==='blink-four-state'?['eye-1.00','eye-0.00']:name==='mouth-four-state'?['mouth-0.00','mouth-1.00']:['neutral'])
      .map(label=>({label,frame:name==='neutral'?neutral:moving,faceInspection:name==='neutral'?inspectionNeutral:inspectionMoving}))]));
  return evaluateMotionQa({reference:{frame:neutral,anchors},captures,hairTipMask:new Uint8Array(neutral.width*neutral.height),contract});
}

test('motion QA measures face-only pixels when foreground hair moves through an eye rectangle', () => {
  const {neutral,anchors,empty}=fixedFixture();
  const before={...neutral,data:neutral.data.slice()},after={...neutral,data:neutral.data.slice()};
  // Narrow old/new strands within the eye rectangle; eye art itself stays fixed.
  paint(before,25,24,28,55,[70,35,20]);paint(after,28,24,31,55,[70,35,20]);
  const result=evaluateFixedFixture(before,after,anchors,neutral,neutral);
  assert.equal(result.checks.fixedFeatureMeasurable,true);
  assert.equal(result.checks.fixedFeatureMae,true);
  assert.equal(result.metrics.fixedFeatureMaePercent,0);
  assert.ok(fixedFeatureComparison(before,after,anchors).maePercent>loadMotionContract().thresholds.fixedFeatureMaeMaximum);
  // Ordinary composition remains available for hair/seam checks.
  assert.ok(changedPixels(before,after)>0);
});

test('empty/missing face renders fail, and genuine facial motion with static hair still fails', () => {
  const {neutral,anchors,empty}=fixedFixture();
  const absent={...neutral,data:new Uint8ClampedArray(neutral.data.length)};
  const noFace=evaluateFixedFixture(neutral,neutral,anchors,absent,absent);
  assert.equal(noFace.checks.fixedFeatureMae,false);
  assert.equal(noFace.metrics.fixedFeatureMaePercent,null);
  assert.equal(fixedFeatureComparison(null,neutral,anchors).reason,'missing-face-inspection-frame');
  const moved=frame(160,140,[245,205,185]);
  for(let y=0;y<140;y++)for(let x=0;x<152;x++)moved.data.set(neutral.data.subarray((y*160+x)*4,(y*160+x)*4+4),(y*160+x+8)*4);
  const result=evaluateFixedFixture(neutral,moved,anchors,neutral,moved);
  assert.equal(result.checks.fixedFeatureMeasurable,true);
  assert.equal(result.checks.fixedFeatureMae,false);
  assert.ok(result.metrics.fixedFeatureMaePercent>loadMotionContract().thresholds.fixedFeatureMaeMaximum);
});

test('the motion gate rejects a real +24px mouth shift and lost feature tracking', () => {
  const {neutral,anchors,empty}=fixedFixture();
  const moved={...neutral,data:neutral.data.slice()};
  paint(moved,70,93,90,95,[245,205,185]);paint(moved,94,93,114,95,[110,60,45]);
  const contract=loadMotionContract();
  const evaluate=target=>evaluateMotionQa({reference:{frame:neutral,anchors},
    captures:Object.fromEntries(contract.requiredCaptures.map(name=>[name,(name==='blink-four-state'?['eye-1.00','eye-0.00']:name==='mouth-four-state'?['mouth-0.00','mouth-1.00']:['neutral']).map(label=>({label,frame:target,faceInspection:target}))])),hairTipMask:empty,contract});
  const result=evaluate(moved);
  assert.equal(result.checks.mouthToEyesRelativeResidual,false);
  assert.ok(result.metrics.mouthToEyesRelativeResidualPx>20);
  const lost=evaluate(frame(160,140));
  assert.equal(lost.checks.featureTracking,false);
  assert.equal(lost.checks.mouthToEyesRelativeResidual,false);
  assert.ok(lost.details.trackingFailures.length>0);
});

test('missing eye anchors and missing eye layers produce explicit failed checks', () => {
  const result = evaluateMotionQa({ reference: { frame: frame(20, 20), anchors: {} },
    captures: {}, hairTipMask: new Uint8Array(400), contract: loadMotionContract() });
  assert.equal(result.pass, false);
  assert.equal(result.checks.requiredFeatureAnchors, false);
  assert.ok(result.errors[0].includes('eyeL'));
  const missing = motionLayerPreflight([]);
  assert.equal(missing.pass, false);
  assert.ok(missing.missingLayers.includes('eyewhite'));
});

test('feature residuals ignore rigid head motion but catch a shifted mouth', () => {
  const reference = { eyeL: { x: 100, y: 100 }, eyeR: { x: 200, y: 100 }, mouth: { x: 150, y: 180 } };
  const angle = 0.08;
  const rotate = ({ x, y }) => ({
    x: 150 + (x - 150) * Math.cos(angle) - (y - 120) * Math.sin(angle) + 6,
    y: 120 + (x - 150) * Math.sin(angle) + (y - 120) * Math.cos(angle) - 3,
  });
  const rigid = featureResiduals(reference, {
    eyeL: rotate(reference.eyeL),
    eyeR: rotate(reference.eyeR),
    mouth: rotate(reference.mouth),
  });
  assert.ok(rigid.leftRightEyePx < 1e-6);
  assert.ok(rigid.mouthToEyesPx < 1e-6);
  const shifted = featureResiduals(reference, { ...reference, mouth: { x: 174, y: 180 } });
  assert.equal(Math.round(shifted.mouthToEyesPx), 24);
});

test('counts QA background pixels that open inside the eroded silhouette', () => {
  const neutral = frame(60, 60, SEAM_COLOR);
  paint(neutral, 10, 10, 50, 50, [240, 200, 180]);
  const interior = erode(silhouette(neutral), 60, 60, 3);
  const moving = frame(60, 60, SEAM_COLOR);
  paint(moving, 10, 10, 50, 50, [240, 200, 180]);
  paint(moving, 29, 20, 31, 30, SEAM_COLOR);
  assert.equal(seamPixels(moving, interior), 20);
  // Background reaching in from outside (edge motion) is not an enclosed seam.
  paint(moving, 10, 40, 30, 42, SEAM_COLOR);
  assert.equal(seamPixels(moving, interior), 20);
});

test('erodes a square mask by the requested radius', () => {
  const mask = new Uint8Array(20 * 20);
  for (let y = 5; y < 15; y += 1) mask.fill(1, y * 20 + 5, y * 20 + 15);
  const eroded = erode(mask, 20, 20, 2);
  assert.equal(eroded.reduce((sum, value) => sum + value, 0), 6 * 6);
  assert.equal(changedPixels(frame(4, 4), frame(4, 4, [0, 0, 0])), 16);
});

test('the motion contract lists every capture the adapter records', () => {
  const contract = loadMotionContract();
  assert.deepEqual(contract.requiredCaptures, [
    'neutral',
    'blink-four-state',
    'mouth-four-state',
    'lip-sync-continuous',
    'hair-physics-only',
    'full-body-idle',
    'drag-inertia',
  ]);
});

test('optional expression QA detects faint artwork, missing captures, frozen frames and leakage', () => {
  const neutral = frame(12, 12, [200, 170, 160]);
  const blush = frame(12, 12, [200, 170, 160]);
  paint(blush, 4, 4, 8, 8, [202, 168, 158]);
  const mask = new Uint8Array(144);
  for (let y = 4; y < 8; y += 1) mask.fill(1, y * 12 + 4, y * 12 + 8);
  const capture = after => ({ blush: [{ label: 'strength-0.00', frame: neutral }, { label: 'strength-1.00', frame: after }] });
  const good = evaluateExpressionCaptures(capture(blush), { blush: mask });
  assert.ok(Object.values(good.checks).every(Boolean));
  assert.equal(good.metrics.blush.changedPixels, 16);
  assert.equal(evaluateExpressionCaptures({}, { blush: mask }).checks.blushCaptured, false);
  assert.equal(evaluateExpressionCaptures(capture(neutral), { blush: mask }).checks.blushChanged, false);
  paint(blush, 0, 0, 4, 4, [10, 10, 10]);
  assert.equal(evaluateExpressionCaptures(capture(blush), { blush: mask }).checks.blushRegionStable, false);
  assert.deepEqual(evaluateExpressionCaptures({}, {}), { checks: {}, metrics: {} });
});

test('smile QA requires intermediate strengths, continued morphing and full-smile blink stability', () => {
  const neutral = frame(12, 12, [200, 170, 160]);
  const smile = frame(12, 12, [200, 170, 160]);
  paint(smile, 4, 4, 8, 8, [30, 20, 20]);
  const mask = new Uint8Array(144);
  for (let y = 4; y < 8; y += 1) mask.fill(1, y * 12 + 4, y * 12 + 8);
  const frames = [...Array.from({ length: 21 }, (_, i) => (i / 20).toFixed(2)), '0.48', '0.52'].map(strength => {
    const image = frame(12, 12, [200, 170, 160]);
    paint(image, 4, 4, 8, 8, [200 - Math.round(Number(strength) * 170), 20, 20]);
    return { label: `strength-${strength}`, frame: strength === '0.00' ? neutral : image };
  });
  frames.push({ label: 'strength-1.00-blink-half', frame: smile }, { label: 'strength-1.00-blink', frame: smile });
  const evaluate = values => evaluateExpressionCaptures({ 'eye-smile': values }, { 'eye-smile': mask });
  assert.ok(Object.values(evaluate(frames).checks).every(Boolean));
  assert.equal(evaluate(frames.filter(item => item.label !== 'strength-0.25')).checks.smileProgressionCaptured, false);
  assert.equal(evaluate(frames.map(item => item.label === 'strength-0.75' ? { ...item, frame: smile } : item)).checks.smileMorphProgresses, false);
  assert.equal(evaluate(frames.map(item => item.label.endsWith('blink-half') ? { ...item, frame: neutral } : item)).checks.smileBlinkStable, false);
});
