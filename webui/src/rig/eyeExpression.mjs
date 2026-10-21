const clamp = value => Math.max(0, Math.min(1, value));

export const SMILE_SWITCH = 0.5;

/** Raise the lower eyelid toward the smile, without showing closed-eye art. */
export function resolveEyeExpression(eyeOpen, smileStrength, available = true) {
  const strength = available ? clamp(smileStrength) : 0;
  const progress = clamp(strength / SMILE_SWITCH);
  const smileRestore = clamp((strength - SMILE_SWITCH) / (1 - SMILE_SWITCH));
  const open = clamp(eyeOpen);
  return {
    eyeOpen: open,
    smileProgress: progress,
    smileRestore,
    smileAlpha: strength >= SMILE_SWITCH ? 1 : 0,
    blinkBrow: (1 - open) * (1 - clamp(strength / SMILE_SWITCH)),
  };
}

export function upperLidY(curve, x, fallback) {
  if (!curve?.length) return fallback;
  if (x <= curve[0].x) return curve[0].y;
  for (let index = 1; index < curve.length; index++) {
    if (x <= curve[index].x) {
      const a = curve[index - 1], b = curve[index];
      return a.y + (b.y - a.y) * (x - a.x) / Math.max(1, b.x - a.x);
    }
  }
  return curve[curve.length - 1].y;
}

export function raiseLowerLid(y, x, anchor, progress, preserveUpperInk = false) {
  if (!progress) return y;
  const upper = upperLidY(anchor.upperLid, x, anchor.y0);
  const center = upperLidY(anchor.upperLid, anchor.icx, anchor.y0);
  const smile = upperLidY(anchor.smileLid, x, upper + (anchor.smileY ?? center) - center);
  const target = !anchor.smileLid?.length || anchor.smileY === undefined ? smile : anchor.smileY + (smile - anchor.smileY) * 0.35;
  const shift = (target - upper) * progress;
  const relative = y - upper;
  // Keep the upper lash's ink thickness; move only its lower edge upward.
  const band = preserveUpperInk ? (anchor.y1 - anchor.y0) * 0.12 : 0;
  return upper + shift + (relative <= band && preserveUpperInk
    ? relative : band + (relative - band) * (1 - progress));
}

/** Match the last open-eye contour first, then restore the smile drawing. */
export function morphSmile(x, y, anchor, restore) {
  if (restore >= 1) return { x, y };
  const source = anchor.smileLid;
  const open = anchor.upperLid;
  if (!source?.length || !open?.length) return { x, y };
  const sourceLeft = source[0].x, sourceRight = source.at(-1).x;
  const openLeft = open[0].x, openRight = open.at(-1).x;
  const mappedX = openLeft + (x - sourceLeft) * (openRight - openLeft) / Math.max(1, sourceRight - sourceLeft);
  const upper = upperLidY(open, mappedX, anchor.y0);
  const smile = upperLidY(source, mappedX, anchor.smileY ?? upper);
  const target = !anchor.smileLid?.length || anchor.smileY === undefined ? smile : anchor.smileY + (smile - anchor.smileY) * 0.35;
  const sourceUpper = upperLidY(source, x, anchor.smileY ?? upper);
  const relative = y - sourceUpper;
  // The crease above the eyelash translates with the contour but keeps its
  // separation and thickness. Only the main eyelash is thinned.
  const matchedY = target + relative * (relative < 0 ? 1 : 0.65);
  const t = restore * restore * (3 - 2 * restore);
  return { x: x + (mappedX - x) * (1 - t), y: y + (matchedY - y) * (1 - t) };
}

/** Hide disconnected outer marks while the smile is displaced from its source. */
export function smileInkVisibility(x, y, anchor, restore) {
  const bounds = anchor.smileInkBounds;
  if (!bounds || restore >= 1) return 1;
  const feather = Math.max(2, (anchor.y1 - anchor.y0) * 0.08);
  const smooth = v => { const t = clamp(v); return t * t * (3 - 2 * t); };
  const support = smooth((x - bounds.x0 + feather) / feather)
    * smooth((bounds.x1 + feather - x) / feather)
    * smooth((bounds.y1 + feather - y) / feather);
  const returnToSource = smooth((restore - 0.8) / 0.2);
  return support + (1 - support) * returnToSource;
}
