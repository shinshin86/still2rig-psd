interface Anchor {
  x0: number; x1: number; y0: number; y1: number; icx: number; icy: number;
  creaseCurve?: { x: number; y: number }[];
  upperLid?: { x: number; y: number }[];
  browCurve?: { x: number; y: number }[];
  browBounds?: { x0: number; x1: number; y0: number; y1: number } | null;
}
export function smileForSide(params: { eyeSmile?: number; eyeSmileL?: number; eyeSmileR?: number }, side: string | null | undefined): number;
export function shapeUpperLid(x: number, y: number, anchor: Anchor, params: { upperLid?: number; eyeWide?: number; lidTilt?: number; faceCenterX: number }, lash?: boolean, iris?: boolean, smileProgress?: number): { x: number; y: number };
export function shapeBrow(x: number, y: number, anchor: Anchor, side: string | null | undefined, params: { browWorry?: number; browAngry?: number; browFlat?: number }): { x: number; y: number };
export function composeTrackedExpression(key: string, base: number, value: number, weight: number): number;
export function shapeWink(x: number, y: number, anchor: Anchor & { closeY: number }, closure: number, lash?: boolean, iris?: boolean): { x: number; y: number };

export function morphClosedWink(x: number, y: number, anchor: Anchor & {
  closeY: number; closedBounds?: { x0: number; x1: number; y0: number; y1: number } | null;
  closedCurve?: { x: number; y: number }[] | null;
}, restore: number): { x: number; y: number };

export function upperLidShape(x: number, anchor: Anchor, params: { upperLid?: number; eyeWide?: number; lidTilt?: number; faceCenterX: number }, smileProgress?: number): {top:number;target:number;bottom:number;lower:number;wide:number;flatten:number;height:number};
