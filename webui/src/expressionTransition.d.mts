export function createExpressionTransition(keys: readonly string[], duration?: number): {
  start(current: Record<string, number>, target: Record<string, number>, at: number): void;
  sample(now: number): Record<string, number> | null;
  active(): boolean;
  cancel(): void;
};
