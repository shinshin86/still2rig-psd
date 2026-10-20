export const neutralInput = Object.freeze({
  angleX: 0, angleY: 0, angleZ: 0, body: 0,
  eyeOpenL: 1, eyeOpenR: 1, eyeX: 0, eyeY: 0, mouthOpen: 0, mouthForm: 0, brow: 0,
});
const clamp = (n, low = -1, high = 1) => Math.min(high, Math.max(low, Number.isFinite(n) ? n : 0));
const delta = (a, b) => ((a - b + 540) % 360) - 180;

export function readFace(matrix, categories) {
  if (!matrix || matrix.length !== 16 || !matrix.every(Number.isFinite)) return null;
  const rotation = [...matrix];
  for (let column = 0; column < 3; column++) {
    const start = column * 4;
    const scale = Math.hypot(...rotation.slice(start, start + 3));
    if (scale < 1e-6) return null;
    for (let row = 0; row < 3; row++) rotation[start + row] /= scale;
  }
  const degrees = 180 / Math.PI;
  return {
    yaw: Math.atan2(rotation[8], rotation[10]) * degrees,
    pitch: Math.asin(clamp(-rotation[9])) * degrees,
    roll: Math.atan2(rotation[1], rotation[5]) * degrees,
    shapes: Object.fromEntries(categories.map(({ categoryName, score }) => [categoryName, clamp(score, 0, 1)])),
  };
}

export function mapFace(face, neutral, options) {
  const sample = name => face.shapes[name] ?? 0;
  const base = name => neutral?.shapes[name] ?? 0;
  const change = name => sample(name) - base(name);
  const pair = prefix => (change(`${prefix}Left`) + change(`${prefix}Right`)) / 2;
  const direction = options.mirror ? -1 : 1;
  const gain = clamp(options.sensitivity, 0.25, 3);
  // Full travel represents 20 degrees at unit sensitivity.
  const angleX = clamp(delta(face.yaw, neutral?.yaw ?? 0) / 20 * gain * direction);
  // Upward pitch is negative; positive renderer angleY lifts the face.
  const angleY = clamp(-delta(face.pitch, neutral?.pitch ?? 0) / 20 * gain);
  const angleZ = clamp(delta(face.roll, neutral?.roll ?? 0) / 20 * gain * direction);
  const eye = side => {
    const blink = sample(`eyeBlink${side}`);
    return blink >= 0.8 ? 0 : clamp((1 - blink) / Math.max(0.2, 1 - base(`eyeBlink${side}`)), 0, 1);
  };
  return {
    angleX, angleY, angleZ, body: (angleX + angleZ) * 0.25,
    eyeOpenL: eye(options.mirror ? 'Right' : 'Left'),
    eyeOpenR: eye(options.mirror ? 'Left' : 'Right'),
    eyeX: clamp((change('eyeLookOutRight') - change('eyeLookInRight') + change('eyeLookInLeft') - change('eyeLookOutLeft')) * direction * 2),
    // Canvas Y grows downward, so looking up needs negative eyeY.
    eyeY: clamp((pair('eyeLookDown') - pair('eyeLookUp')) * 2),
    mouthOpen: clamp((change('jawOpen') - Math.max(0, change('mouthClose'))) * gain / Math.max(0.2, 1 - base('jawOpen')), 0, 1),
    mouthForm: clamp((change('mouthPucker') + change('mouthFunnel') - pair('mouthSmile') - pair('mouthStretch')) * gain),
    brow: clamp((change('browInnerUp') + pair('browOuterUp') - pair('browDown')) * gain),
  };
}

export function smoothInput(current, target, dt, smoothing) {
  const tau = clamp(smoothing, 0, 1) * 0.25;
  const alpha = tau > 0 ? 1 - Math.exp(-Math.max(0, dt) / tau) : 1;
  return Object.fromEntries(Object.entries(target).map(([name, value]) => [
    name, name === 'eyeOpenL' || name === 'eyeOpenR' ? value : current[name] + (value - current[name]) * alpha,
  ]));
}

export class TrackingPose {
  face = null;
  neutral = null;
  seen = -Infinity;
  input = { ...neutralInput };
  weight = 0;
  update(face, now) {
    if (face) { this.face = face; this.seen = now; }
  }
  calibrate(now) {
    if (!this.face || now - this.seen > 500) return false;
    this.neutral = structuredClone(this.face);
    return true;
  }
  sample(now, dt, options) {
    const visible = !!this.face && now - this.seen <= 500;
    if (visible) this.input = smoothInput(this.input, mapFace(this.face, this.neutral, options), dt, options.smoothing);
    const targetWeight = visible ? 1 : 0;
    this.weight += (targetWeight - this.weight) * (1 - Math.exp(-Math.max(0, dt) / 0.15));
    if (!visible && this.weight < 0.005) this.weight = 0;
    return { input: { ...this.input }, weight: this.weight, visible };
  }
}
