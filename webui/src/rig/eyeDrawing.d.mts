export type EyeDrawing = 'neutral' | 'smile' | 'angry';
export interface EyeDrawingFrame {smile:number;angry:number;wink:number;locked:boolean}
export interface EyeDrawingSnapshot {drawing:EyeDrawing;shape:{smile:number;angry:number;wink:number};destination:{smile:number;angry:number;wink:number}|null;transition:{from:{smile:number;angry:number;wink:number};elapsed:number}|null;locked:boolean;closed:boolean;awaitClosure:boolean}
export function createEyeDrawingSlot(initial?: EyeDrawing): {
  getState(): EyeDrawing;
  setState(value: EyeDrawing): void;
  getFrame():EyeDrawingFrame;
  getSnapshot():EyeDrawingSnapshot;
  restore(state:EyeDrawingSnapshot):void;
  request(smile:number,angry:number,wink?:number):void;
  clearTarget():void;
  resolve(smile: number, angry: number, open?:number,dt?:number,wink?:number): EyeDrawing;
};
export function eyeDrawingAlpha(fade: string | null | undefined, baseName: string, drawing: EyeDrawing, blink: {open:number;closed:number}, fallback: number): number;
export function eyeSlotParameters<T extends {eyeSmile:number;eyeSmileL:number;eyeSmileR:number;eyeAngry:number;eyeWinkL:number;eyeWinkR:number}>(params:T,side:'L'|'R',drawing:EyeDrawing,frame?:EyeDrawingFrame):T;
