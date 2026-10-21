export interface ExpressionDefinition {
  name: string;
  label: string;
  requestLabel: string | null;
  prompt: string | null;
  editableLayers: string[];
  mask: { dilationRatio: number; minimumDilation: number; fillBounds: boolean; mouthLimits: boolean } | null;
  extraction: 'diff' | null;
  registration: 'eyes' | 'mouth' | 'none';
  split: boolean;
  placeholderFrom: string | null;
  checkFrontHair: boolean;
  sources: string[];
  requiredForProduction: boolean;
}
export function validateExpressions(config: unknown, map: { layers: { target: string; source: string; requiredForProduction?: boolean }[] }): ExpressionDefinition[];
export const expressions: ExpressionDefinition[];
export const requestedExpressions: ExpressionDefinition[];
