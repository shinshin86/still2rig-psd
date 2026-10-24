export interface DrawnEyeFeatures {
  eye: {x0:number;x1:number;y0:number;y1:number};
  brow: {x0:number;x1:number;y0:number;y1:number}|null;
  browCurve: {x:number;y:number}[];
  browCut: number;
}
export function drawnBlinkOpacity(eyeOpen:number): {open:number;closed:number};
export function drawnEyeFeatures(layer: {img:{width:number;height:number;data:ArrayLike<number>};x:number;y:number}, anchor: {x0:number;x1:number;y0:number;y1:number;browBounds?:{x0:number;x1:number;y0:number;y1:number}|null}): DrawnEyeFeatures;
export function morphDrawnEye(x:number,y:number,anchor:{x0:number;x1:number;y0:number;y1:number;browBounds?:{x0:number;x1:number;y0:number;y1:number}|null;browCurve?:{x:number;y:number}[]},features:DrawnEyeFeatures|undefined,strength:number,drawing:boolean,brow?:boolean): {x:number;y:number};
