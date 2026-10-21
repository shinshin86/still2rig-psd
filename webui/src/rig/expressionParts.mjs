import { upperLidY } from './eyeExpression.mjs';
const clamp = (v, min = 0, max = 1) => Math.max(min, Math.min(max, v));

export function smileForSide(params, side) {
  return Math.max(params.eyeSmile || 0, (side === 'L' ? params.eyeSmileL : params.eyeSmileR) || 0);
}

/** Move the top boundary while preserving lash thickness and the lower lid. */
export function shapeUpperLid(x, y, anchor, params, lash = false, iris = false, smileProgress = 0) {
  const remaining = 1 - smileProgress;
  const lower = clamp(params.upperLid || 0) * remaining;
  const wide = clamp(params.eyeWide || 0) * remaining;
  if (!lower && !wide) return { x, y };
  const height = anchor.y1 - anchor.y0;
  if (iris) {
    const scale = 1 - wide * 0.18;
    return { x: anchor.icx + (x - anchor.icx) * scale, y: anchor.icy + (y - anchor.icy) * scale };
  }
  const top = upperLidY(anchor.upperLid, x, anchor.y0);
  const side = anchor.icx < params.faceCenterX ? 1 : -1;
  const inward = clamp((x - anchor.icx) / Math.max(1, (anchor.x1 - anchor.x0) / 2), -1, 1) * side;
  const flat = anchor.y0 + height * 0.45;
  const tilt = (params.lidTilt || 0) * inward * height * 0.3;
  const target = top + lower * (flat + tilt - top) - wide * height * 0.1;
  const bottom = anchor.y1 + wide * height * 0.06;
  const relative = y - top;
  const band = lash ? height * 0.12 : 0;
  const shaped = relative <= band && lash ? target + relative
    : target + band + (relative - band) * (bottom - target - band) / Math.max(1, anchor.y1 - top - band);
  return { x, y: shaped };
}

/** Mirror the inner brow displacement and bend along its length. */
export function shapeBrow(x, y, anchor, side, params) {
  const box = anchor.browBounds;
  const worry = clamp(params.browWorry || 0), angry = clamp(params.browAngry || 0), flat = clamp(params.browFlat || 0);
  if (!box || (!worry && !angry && !flat)) return { x, y };
  const u = clamp((x - box.x0) / Math.max(1, box.x1 - box.x0));
  const inner = side === 'L' ? u : 1 - u;
  const curve = inner ** 1.6;
  const amount = (anchor.y1 - anchor.y0) * 0.5;
  const center = (box.y0 + box.y1) / 2;
  const source = upperLidY(anchor.browCurve, x, center);
  const bend = 4 * inner * (1 - inner) * 0.15;
  const worryY = center + amount * (0.45 - 1.1 * inner + bend);
  const angryY = center + amount * (-0.5 + 1.2 * inner - bend);
  const offset = (worry * (worryY - source) + angry * (angryY - source) + flat * (center - source)) / Math.max(1, worry + angry + flat);
  return {
    x: x + (side === 'L' ? 1 : -1) * angry * curve * (box.x1 - box.x0) * 0.07,
    y: y + offset,
  };
}

export function composeTrackedExpression(key, base, value, weight) {
  return key === 'brow' || key === 'mouthForm'
    ? clamp(base + value * weight, -1, 1)
    : base + (value - base) * weight;
}

/** Close toward the actual blink anchor without thinning the upper ink to dots. */
export function shapeWink(x, y, anchor, closure, lash = false, iris = false) {
  const p = clamp(closure);
  if (!p) return { x, y };
  const close = anchor.closeY;
  if (!lash) return { x, y: close + (y - close) * (1 - p * (iris ? 0.85 : 1)) };
  const upper = upperLidY(anchor.upperLid, x, anchor.y0);
  const band = (anchor.y1 - anchor.y0) * 0.12;
  const closedBand = band;
  const top = upper + (close - closedBand / 2 - upper) * p;
  const relative = y - upper;
  const inkScale = 1 - p * (1 - closedBand / band);
  const left = anchor.upperLid?.[0]?.x ?? anchor.x0;
  const right = anchor.upperLid?.at(-1)?.x ?? anchor.x1;
  const bounds = anchor.closedBounds;
  const mappedX = bounds ? bounds.x0 + (x-left)*(bounds.x1-bounds.x0)/Math.max(1,right-left) : x;
  return { x: x + (mappedX-x)*p, y: relative <= band ? top + relative * inkScale
    : top + band * inkScale + (relative - band) * (1 - p) };
}

/** Keep blink ink thickness and endpoints while restoring its curved contour. */
export function morphClosedWink(x, y, anchor, restore) {
  if (restore >= 1 || !anchor.closedBounds) return { x, y };
  const center = upperLidY(anchor.closedCurve,x,anchor.closeY);
  const flatY = anchor.closeY + (y-center);
  const t=clamp(restore), eased=t*t*(3-2*t);
  return {x,y:flatY+(y-flatY)*eased};
}
