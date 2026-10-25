/** A shared wall-clock transition for animation frames and background snapshots. */
export function createExpressionTransition(keys, duration = 250) {
  let transition = null;
  return {
    start(current, target, at) {
      transition = { from: { ...current }, to: { ...target }, at };
    },
    sample(now) {
      if (!transition) return null;
      const { from, to, at } = transition;
      const progress = Math.max(0, Math.min(1, (now - at) / duration));
      const eased = progress * progress * (3 - 2 * progress);
      const values = Object.fromEntries(keys.map(key => [key, from[key] + (to[key] - from[key]) * eased]));
      if (progress === 1) transition = null;
      return values;
    },
    active() { return transition !== null; },
    cancel() { transition = null; },
  };
}
