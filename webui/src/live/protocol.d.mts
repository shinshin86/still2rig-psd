import type { TrackingInput } from '../tracking/pose.mjs';
import type { Anime25MotionTuning } from '../rig/anime25Renderer';
import type { PsdMotionParameters } from '../psdMotionProfile';
export interface LiveSettings {
  mode: 'static' | 'physics' | 'idle-physics'; autoBlink: boolean; eyeOpen: number; mouthOpen: number;
  parameters: Partial<PsdMotionParameters>; tuning: Partial<Anime25MotionTuning & { intensity: number }>;
}
export interface LiveState {
  voiceMouth?: number | null;
  layerOrder?: string[] | null; source: string; psd: string; input: Partial<TrackingInput> | null; weight: number; settings: LiveSettings;
}
export const trackingRanges: Record<string, [number, number]>;
export function parseLiveState(value: unknown): LiveState;

export function parseLayerOrder(value: unknown): string[] | null;
