import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../webui/src/tracking/face-worker.js', import.meta.url), 'utf8');
async function workerHarness({ gpuInitFails = false, cpuInitFails = false, detect }) {
  const messages = [];
  const delegates = [];
  const self = { postMessage: message => messages.push(message) };
  let closedFrames = 0;
  const api = {
    FilesetResolver: { forVisionTasks: async () => ({}) },
    FaceLandmarker: { createFromOptions: async (_files, options) => {
      const delegate = options.baseOptions.delegate;
      delegates.push(delegate);
      if ((delegate === 'GPU' && gpuInitFails) || (delegate === 'CPU' && cpuInitFails)) throw new Error('Initialization failed');
      return { close() {}, detectForVideo: () => {
        detect(delegate);
        return { facialTransformationMatrixes: [], faceBlendshapes: [] };
      } };
    } },
  };
  vm.runInNewContext(source, { self, performance: { now: () => 0 }, importScripts() { self.exports = api; } });
  await self.onmessage({ data: { type: 'init' } });
  return {
    messages, delegates,
    get closedFrames() { return closedFrames; },
    async frame() { await self.onmessage({ data: { type: 'frame', timestamp: 1, frame: { close() { closedFrames++; } } } }); },
  };
}

test('CPU inference tolerates three bad frames and resets the count after success', async () => {
  let failing = true;
  const worker = await workerHarness({ gpuInitFails: true, detect() { if (failing) throw new Error('Bad frame'); } });
  for (let i = 0; i < 3; i++) await worker.frame();
  assert.equal(worker.messages.filter(message => message.type === 'error').length, 0);
  failing = false;
  await worker.frame();
  failing = true;
  for (let i = 0; i < 3; i++) await worker.frame();
  assert.equal(worker.messages.filter(message => message.type === 'error').length, 0);
  await worker.frame();
  assert.equal(worker.messages.filter(message => message.type === 'error').length, 1);
  assert.equal(worker.messages.filter(message => message.type === 'result').length, 1);
  assert.equal(worker.messages.filter(message => message.type === 'consumed').length, 8);
  assert.equal(worker.closedFrames, 8);
});

test('GPU inference failure switches to CPU and lets transient CPU frames recover', async () => {
  let cpuFrames = 0;
  const worker = await workerHarness({ detect(delegate) {
    if (delegate === 'GPU' || ++cpuFrames <= 2) throw new Error('Bad frame');
  } });
  for (let i = 0; i < 3; i++) await worker.frame();
  assert.deepEqual(worker.delegates, ['GPU', 'CPU']);
  assert.equal(worker.messages.filter(message => message.type === 'error').length, 0);
  assert.equal(worker.messages.filter(message => message.type === 'result').length, 1);
  assert.equal(worker.closedFrames, 3);
});

test('unrecoverable CPU initialization fails immediately and still closes the frame', async () => {
  const worker = await workerHarness({ cpuInitFails: true, detect() { throw new Error('Bad GPU frame'); } });
  await worker.frame();
  assert.equal(worker.messages.filter(message => message.type === 'error').length, 1);
  assert.equal(worker.closedFrames, 1);
});
