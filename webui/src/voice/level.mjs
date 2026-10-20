const clamp = value => Math.max(0, Math.min(1, value));

export function rmsLevel(samples) {
  if (!samples.length) return 0;
  let energy = 0;
  for (const value of samples) energy += value * value;
  return Math.sqrt(energy / samples.length);
}

export function mouthTarget(rms, sensitivity = 1) {
  if (!Number.isFinite(rms) || rms <= 0 || !Number.isFinite(sensitivity)) return 0;
  const db = 20 * Math.log10(rms);
  // Keep the noise gate independent of sensitivity so quiet rooms stay still.
  if (db <= -48) return 0;
  return clamp((db + 48) / 30 * Math.max(0, sensitivity));
}

export function smoothMouth(previous, target, dt) {
  const next = previous + (target - previous) * (1 - Math.exp(-Math.max(0, dt) / (target > previous ? 0.035 : 0.12)));
  return target === 0 && next < 0.005 ? 0 : clamp(next);
}
