export function rmsLevel(samples: ArrayLike<number>): number;
export function mouthTarget(rms: number, sensitivity?: number): number;
export function smoothMouth(previous: number, target: number, dt: number): number;
