import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { installFixedMotionClock } from '../webui/scripts/fixed-motion-clock.mjs';

function simulation() {
  const context = vm.createContext({ performance: {} });
  vm.runInContext(`(${installFixedMotionClock.toString()})({ fps: 60, seed: 42 });
    globalThis.frames=[]; function render(t) { frames.push([t,Math.random()]); requestAnimationFrame(render); }
    requestAnimationFrame(render);`, context);
  return context;
}

test('motion clock repeats frame times and random samples regardless of capture delays', async () => {
  const first = simulation(), second = simulation();
  for (const ms of [800, 350, 16, 120]) {
    first.__motionQaClock.advance(ms);
    await new Promise(resolve => setTimeout(resolve, 2));
    second.__motionQaClock.advance(ms);
  }
  assert.equal(JSON.stringify(first.frames), JSON.stringify(second.frames));
  assert.equal(first.frames.length, 77);
  assert.equal(first.performance.now(), 77 * 1000 / 60);
  const before = first.performance.now();
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(first.performance.now(), before);
});

test('motion clock supports callback cancellation and defers new callbacks to the next tick', () => {
  const context = vm.createContext({ performance: {} });
  vm.runInContext(`(${installFixedMotionClock.toString()})({ fps: 60, seed: 42 });
    globalThis.events=[];
    requestAnimationFrame(()=>{ events.push('first'); cancelAnimationFrame(cancelled); requestAnimationFrame(()=>events.push('next')); });
    const cancelled=requestAnimationFrame(()=>events.push('cancelled'));`, context);
  context.__motionQaClock.advance(1000 / 60);
  assert.equal(JSON.stringify(context.events), '["first"]');
  context.__motionQaClock.advance(1000 / 60);
  assert.equal(JSON.stringify(context.events), '["first","next"]');
  assert.throws(() => context.__motionQaClock.advance(-1), /Invalid simulation interval/);
});
