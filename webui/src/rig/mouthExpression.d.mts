export interface MouthContour {left:number;right:number;top:number[];bottom:number[]}
export interface MouthSelection {shape:string;isClosed:boolean;seamClosed:boolean}
export interface MouthFrame {drawing:string;openness:number;progress:number;weights:Record<string,number>;opening?:number;shapeGate?:number;frown?:number}
export function mouthContour(layer:{x:number;y:number;img:{width:number;height:number;data:Uint8ClampedArray}},outlineOnly?:boolean,lipLineOnly?:boolean):MouthContour|null;
export function createMouthController(contours:Record<string,MouthContour>):{
  getState():MouthSelection;
  setState(state:MouthSelection):void;
  resolve(params:{mouthLaugh?:number;mouthRound?:number;mouthFrown?:number;mouthOpen?:number;mouthEase?:number;expressionMouthOpen?:number},restWeight?:number):MouthFrame;
  warp(x:number,y:number,name:string,frame:MouthFrame):{x:number;y:number;visibility:number};
};
export function mouthRestWeight(trackedOpen:number|undefined,weight:number):number;
