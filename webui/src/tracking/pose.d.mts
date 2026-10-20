export interface TrackingInput {
  angleX: number; angleY: number; angleZ: number; body: number;
  eyeOpenL: number; eyeOpenR: number; eyeX: number; eyeY: number;
  mouthOpen: number; mouthForm: number; brow: number;
}
export interface RawFace { yaw: number; pitch: number; roll: number; shapes: Record<string, number> }
export interface TrackingOptions { mirror: boolean; sensitivity: number; smoothing: number }
export const neutralInput: Readonly<TrackingInput>;
export function readFace(matrix: number[] | undefined, categories: { categoryName: string; score: number }[]): RawFace | null;
export function mapFace(face: RawFace, neutral: RawFace | null, options: TrackingOptions): TrackingInput;
export function smoothInput(current: TrackingInput, target: TrackingInput, dt: number, smoothing: number): TrackingInput;
export class TrackingPose {
  update(face: RawFace | null, now: number): void;
  calibrate(now: number): boolean;
  sample(now: number, dt: number, options: TrackingOptions): { input: TrackingInput; weight: number; visible: boolean };
}
