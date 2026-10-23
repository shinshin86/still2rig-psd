export type DrawnEye = 'angry'|'sad'|'surprised'|'shy'|'flustered'|'half';
export type EyeDrawing = 'neutral'|'smile'|DrawnEye;
export type EyeShape = Record<Exclude<EyeDrawing,'neutral'>|'wink',number>;
export type DrawnEyeParameter = 'eyeAngry'|'eyeSad'|'eyeSurprised'|'eyeShy'|'eyeFlustered'|'eyeHalf';
export const drawnEyeDefinitions: readonly {drawing:DrawnEye;part:string;parameter:DrawnEyeParameter}[];
export type EyeDrawingFrame = EyeShape & {locked:boolean};
export interface EyeDrawingSnapshot {drawing:EyeDrawing;shape:EyeShape;destination:EyeShape|null;transition:{from:EyeShape;elapsed:number}|null;locked:boolean;closed:boolean;awaitClosure:boolean}
export function createEyeDrawingSlot(initial?:EyeDrawing): {
  getState():EyeDrawing;
  setState(value:EyeDrawing):void;
  getFrame():EyeDrawingFrame;
  getSnapshot():EyeDrawingSnapshot;
  restore(state:EyeDrawingSnapshot):void;
  request(smile:number,angry:number,wink?:number,sad?:number):void;
  requestFrame(values:Partial<EyeShape>):void;
  clearTarget():void;
  resolve(smile:number,angry:number,open?:number,dt?:number,wink?:number,sad?:number):EyeDrawing;
  resolveFrame(values:Partial<EyeShape>,open?:number,dt?:number):EyeDrawing;
};
export function eyeDrawingAlpha(fade:string|null|undefined,baseName:string,drawing:EyeDrawing,blink:{open:number;closed:number},fallback:number):number;
export function eyeSlotParameters<T extends {eyeSmile:number;eyeSmileL:number;eyeSmileR:number;eyeAngry:number;eyeSad?:number;eyeWinkL:number;eyeWinkR:number}>(params:T,side:'L'|'R',drawing:EyeDrawing,frame?:EyeDrawingFrame):T;
