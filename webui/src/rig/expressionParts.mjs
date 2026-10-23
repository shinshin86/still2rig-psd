import { upperLidY } from './eyeExpression.mjs';
const clamp = (v, min = 0, max = 1) => Math.max(min, Math.min(max, v));

export function smileForSide(params, side) {
  return Math.max(params.eyeSmile || 0, (side === 'L' ? params.eyeSmileL : params.eyeSmileR) || 0);
}

/** Share a straightening lid contour between the lash, whites and its shadow. */
export function upperLidShape(x, anchor, params, smileProgress = 0) {
  const remaining = 1 - smileProgress;
  const lower = clamp(params.upperLid || 0) * remaining;
  const wide = clamp(params.eyeWide || 0) * remaining;
  const height = anchor.y1 - anchor.y0;
  const top = upperLidY(anchor.upperLid, x, anchor.y0);
  const center = (anchor.x0 + anchor.x1) / 2;
  const side = center < params.faceCenterX ? 1 : -1;
  const inward = clamp((x-center) / Math.max(1,(anchor.x1-anchor.x0)/2),-1,1)*side;
  const flatten = 1-(1-lower)**2;
  const tilt = (params.lidTilt || 0)*inward*height*.24;
  const target = top+flatten*(anchor.y0+height*.45+tilt-top)-wide*height*.1;
  const bottom = anchor.y1+wide*height*.06-lower*height*(.035+.07*Math.max(0,params.lidTilt||0));
  return {top,target,bottom,lower,wide,flatten,height};
}

/** Flatten the upper ink and move the crease independently without thinning it. */
export function shapeUpperLid(x, y, anchor, params, lash = false, iris = false, smileProgress = 0) {
  const g=upperLidShape(x,anchor,params,smileProgress);
  if (!g.lower && !g.wide) return {x,y};
  if (iris) {
    const scale=1-g.wide*.18;
    return {x:anchor.icx+(x-anchor.icx)*scale,y:anchor.icy+(y-anchor.icy)*scale};
  }
  let relative=y-g.top;
  const band=lash?g.height*.12:0;
  const creaseCurve=anchor.creaseCurve;
  const onCrease=creaseCurve?.length && x>=creaseCurve[0].x && x<=creaseCurve.at(-1).x;
  if(lash && onCrease && relative<0) {
    const crease=upperLidY(creaseCurve,x,g.top-g.height*.12);
    const center=(anchor.x0+anchor.x1)/2;
    const centerGap=upperLidY(anchor.upperLid,center,anchor.y0)-upperLidY(creaseCurve,center,anchor.y0-g.height*.12);
    const gap=g.top-crease;
    const flatGap=Math.max(g.height*.055,gap+(centerGap-gap)*g.flatten)*(1+.12*g.lower);
    const creaseTarget=g.target-flatGap;
    const inkBand=g.height*.035;
    const blend=clamp((y-crease-inkBand)/Math.max(1,gap-inkBand));
    const creaseY=y+(creaseTarget-crease)*(1-blend)+(g.target-g.top)*blend;
    const feather=g.height*.2;
    const fade=v=>{const t=clamp(v);return t*t*(3-2*t);};
    const support=fade((x-creaseCurve[0].x)/feather)*fade((creaseCurve.at(-1).x-x)/feather);
    const normalY=g.target+relative;
    return {x,y:normalY+(creaseY-normalY)*support};
  }
  const shaped=relative<=band&&lash?g.target+relative
    :g.target+band+(relative-band)*(g.bottom-g.target-band)/Math.max(1,anchor.y1-g.top-band);
  return {x,y:shaped};
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
