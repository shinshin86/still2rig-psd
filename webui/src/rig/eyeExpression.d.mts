export const SMILE_SWITCH: number;
export function resolveEyeExpression(eyeOpen: number, smileStrength: number, available?: boolean): {
  eyeOpen: number;
  smileProgress: number;
  smileRestore: number;
  smileAlpha: number;
  blinkBrow: number;
};
export function upperLidY(curve: { x: number; y: number }[] | undefined, x: number, fallback: number): number;
export function raiseLowerLid(y: number, x: number, anchor: {
  y0: number; y1: number; icx: number; smileY?: number; upperLid?: { x: number; y: number }[]; smileLid?: { x: number; y: number }[];
}, progress: number, preserveUpperInk?: boolean): number;

export function morphSmile(x: number, y: number, anchor: {
  y0: number; y1?: number; smileInkBounds?: { x0: number; x1: number; y0: number; y1: number }; smileY?: number; upperLid?: { x: number; y: number }[]; smileLid?: { x: number; y: number }[];
}, restore: number): { x: number; y: number };

export function smileInkVisibility(x: number, y: number, anchor: {
  y0: number; y1: number; smileInkBounds?: { x0: number; x1: number; y0: number; y1: number };
}, restore: number): number;
