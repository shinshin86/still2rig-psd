// Installed before application code. Capture/encoding time never advances the rig.
export function installFixedMotionClock({ fps = 60, seed = 20261105 } = {}) {
  let tick = 0, serial = 0, randomState = seed >>> 0;
  const queue = new Map();
  const now = () => tick * 1000 / fps;
  Object.defineProperty(performance, 'now', { configurable: true, value: now });
  Date.now = () => Date.UTC(2026, 0, 1) + now();
  Math.random = () => {
    randomState = (Math.imul(1664525, randomState) + 1013904223) >>> 0;
    return randomState / 4294967296;
  };
  globalThis.requestAnimationFrame = callback => { queue.set(++serial, callback); return serial; };
  globalThis.cancelAnimationFrame = id => queue.delete(id);
  const flush = () => {
    for (const id of [...queue.keys()]) {
      const callback = queue.get(id);
      if (!callback) continue;
      queue.delete(id);
      callback(now());
    }
  };
  globalThis.__motionQaClock = {
    // File loading also awaits animation frames. Serve them at frozen time;
    // parsing speed must not advance simulation time.
    flush,
    advance(milliseconds) {
      if (!Number.isFinite(milliseconds) || milliseconds < 0) throw new Error('Invalid simulation interval');
      const frames = Math.round(milliseconds * fps / 1000);
      for (let frame = 0; frame < frames; frame++) {
        tick++;
        flush();
      }
      return this.snapshot();
    },
    resetRandom() { randomState = seed >>> 0; },
    snapshot() { return { fps, seed, tick, timeMs: now(), randomState }; },
  };
}

export const advanceMotionClock = (page, milliseconds) => page.evaluate(
  ms => globalThis.__motionQaClock.advance(ms), milliseconds);
