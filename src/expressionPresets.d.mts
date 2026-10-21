export const expressionParameterNames: readonly string[];
export const expressionPresets: readonly { id: string; label: string; values: Readonly<Record<string, number>> }[];
export function expressionPresetValues(id: string, parts?: Iterable<string>): Record<string, number>;
