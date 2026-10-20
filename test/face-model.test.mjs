import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { faceModelReady, FACE_MODEL_BYTES } from '../src/face-model.mjs';

test('model readiness rejects missing, short, symlink and wrong-hash assets', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'still2rig-face-model-'));
  try {
    const file = path.join(root, 'model.task');
    assert.equal(await faceModelReady(file), false);
    await fs.writeFile(file, Buffer.alloc(FACE_MODEL_BYTES));
    assert.equal(await faceModelReady(file), false);
    const link = path.join(root, 'link.task');
    await fs.symlink(file, link);
    assert.equal(await faceModelReady(link), false);
    await fs.writeFile(file, 'short');
    assert.equal(await faceModelReady(file), false);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('corrupt downloads never replace a model and leave no temporary files', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'still2rig-face-download-'));
  const previousRoot = process.env.STILL2RIG_PSD_MODELS_ROOT;
  const previousFetch = globalThis.fetch;
  try {
    process.env.STILL2RIG_PSD_MODELS_ROOT = root;
    const { ensureFaceModel } = await import('../src/face-model.mjs?download-failure-test');
    let fetches = 0;
    globalThis.fetch = async () => { fetches++; return new Response(Buffer.alloc(FACE_MODEL_BYTES)); };
    const first = ensureFaceModel();
    const second = ensureFaceModel();
    assert.equal(first, second, 'simultaneous callers share a download');
    await assert.rejects(first, /SHA-256 mismatch/);
    assert.equal(fetches, 1);
    assert.deepEqual(await fs.readdir(path.join(root, 'mediapipe')), []);
    globalThis.fetch = async () => new Response(Buffer.alloc(FACE_MODEL_BYTES + 1));
    await assert.rejects(ensureFaceModel(), /size mismatch/);
    assert.deepEqual(await fs.readdir(path.join(root, 'mediapipe')), []);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousRoot === undefined) delete process.env.STILL2RIG_PSD_MODELS_ROOT;
    else process.env.STILL2RIG_PSD_MODELS_ROOT = previousRoot;
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('model hash results are reused only while file metadata is unchanged', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'still2rig-face-cache-'));
  const file = path.join(root, 'model.task');
  const readFile = fs.readFile.bind(fs);
  let reads = 0;
  t.mock.method(fs, 'readFile', async (target, ...args) => {
    if (target === file) reads++;
    return readFile(target, ...args);
  });
  try {
    await fs.writeFile(file, Buffer.alloc(FACE_MODEL_BYTES));
    assert.equal(await faceModelReady(file), false);
    assert.equal(await faceModelReady(file), false);
    assert.equal(reads, 1);
    const stat = await fs.stat(file);
    await fs.utimes(file, stat.atime, new Date(stat.mtimeMs + 2000));
    assert.equal(await faceModelReady(file), false);
    assert.equal(reads, 2, 'mtime change triggers a fresh hash');
    await fs.writeFile(file, 'short');
    assert.equal(await faceModelReady(file), false);
    assert.equal(reads, 2, 'invalid size rejects before reading');
    await fs.unlink(file);
    assert.equal(await faceModelReady(file), false);
    await fs.writeFile(file, Buffer.alloc(FACE_MODEL_BYTES));
    assert.equal(await faceModelReady(file), false);
    assert.equal(reads, 3, 'a replacement is verified again');
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
