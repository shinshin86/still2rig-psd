// Limit independent hair motion relative to the same head pose. Ordinary
// movement remains untouched until a fast turn; release only after settling.
export function updateHairMotionInput(previous, params, time) {
  const elapsed = previous ? Math.max(1e-6, time - previous.time) : 1 / 30;
  const speed = previous ? Math.max(
    Math.abs(params.angleX - previous.x),
    Math.abs(params.angleY - previous.y),
    Math.abs(params.angleZ - previous.z),
  ) / elapsed : 0;
  return { time, x: params.angleX, y: params.angleY, z: params.angleZ, speed,
    holdUntil: speed > 1.6 ? time + 1.8 : previous?.holdUntil ?? -1,
    lastFastTime: speed > 1.6 ? time : previous?.lastFastTime ?? -1 };
}

export function limitHairMotion(output, reference, faceWidth, input, previous = {}) {
  let peak = 0;
  for (let i = 0; i < output.length; i += 2) {
    peak = Math.max(peak, Math.hypot(output[i] - reference[i], output[i + 1] - reference[i + 1]));
  }
  const bound = faceWidth * .10;
  const knee = bound * .35;
  let latched = previous.latched ?? false;
  let lastTrigger = previous.lastTrigger ?? -1;
  if ((input?.lastFastTime ?? -1) > lastTrigger) {
    latched = true;
    lastTrigger = input.lastFastTime;
  }
  if (latched && input && input.time > input.holdUntil && peak <= knee) latched = false;
  const bounded = peak <= knee ? peak : knee + (bound - knee) * Math.tanh((peak - knee) / (bound - knee));
  const desired = peak + (bounded - peak) * (latched ? 1 : 0);
  const factor = peak > 1e-6 ? desired / peak : 1;
  // One factor for the entire layer preserves the displacement field; local
  // face pins would create hinges where the binding strength changes.
  if (factor < 1) {
    for (let i = 0; i < output.length; i++) output[i] = reference[i] + (output[i] - reference[i]) * factor;
  }
  return { latched, lastTrigger, peak, appliedPeak: desired, bound, factor };
}
