export interface HairMotionInput {
  time: number; x: number; y: number; z: number; speed: number;
  holdUntil: number; lastFastTime: number;
}
export interface HairMotionLimitState {
  latched: boolean; lastTrigger: number; peak: number; appliedPeak: number;
  bound: number; factor: number;
}
export function updateHairMotionInput(previous: HairMotionInput | null,
  params: {angleX:number;angleY:number;angleZ:number}, time:number): HairMotionInput;
export function limitHairMotion(output:Float32Array, reference:Float32Array,
  faceWidth:number, input:HairMotionInput|null,
  previous?:HairMotionLimitState):HairMotionLimitState;
