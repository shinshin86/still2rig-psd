import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

export const FACE_MODEL_URL = 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';
export const FACE_MODEL_SHA256 = '64184e229b263107bc2b804c6625db1341ff2bb731874b0bcc2fe6544e0bc9ff';
export const FACE_MODEL_BYTES = 3758596;
const root = path.resolve(import.meta.dirname, '..');
export const faceModelFile = path.resolve(root, process.env.STILL2RIG_PSD_MODELS_ROOT || '.still2rig-psd/models', 'mediapipe/face_landmarker.task');

const verificationCache = new Map();

export async function faceModelReady(file = faceModelFile) {
  try {
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.size !== FACE_MODEL_BYTES) {
      verificationCache.delete(file);
      return false;
    }
    const signature = [stat.size, stat.mtimeMs, stat.ctimeMs, stat.ino, stat.dev].join(':');
    const cached = verificationCache.get(file);
    if (cached?.signature === signature) return cached.result;
    const result = createHash('sha256').update(await fs.readFile(file)).digest('hex') === FACE_MODEL_SHA256;
    verificationCache.set(file, { signature, result });
    return result;
  } catch (error) {
    verificationCache.delete(file);
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

let pending;
export function ensureFaceModel() {
  pending ??= downloadFaceModel().finally(() => { pending = undefined; });
  return pending;
}

async function downloadFaceModel() {
  if (await faceModelReady()) return { ready: true, downloaded: false };
  await fs.mkdir(path.dirname(faceModelFile), { recursive: true });
  const temporary = `${faceModelFile}.${randomUUID()}.tmp`;
  try {
    const response = await fetch(FACE_MODEL_URL, { signal: AbortSignal.timeout(60000), redirect: 'error' });
    if (!response.ok || !response.body) throw new Error('Face model download failed.');
    // Bound the response even if the upstream sends an incorrect Content-Length.
    const chunks = [];
    let bytes = 0;
    for await (const chunk of response.body) {
      bytes += chunk.length;
      if (bytes > FACE_MODEL_BYTES) throw new Error('Face model size mismatch.');
      chunks.push(chunk);
    }
    await fs.writeFile(temporary, Buffer.concat(chunks), { flag: 'wx' });
    if (!await faceModelReady(temporary)) throw new Error('Face model SHA-256 mismatch.');
    // Invalidate before replacement, including when a filesystem reuses timestamps.
    verificationCache.delete(faceModelFile);
    await fs.rename(temporary, faceModelFile);
    verificationCache.delete(faceModelFile);
    return { ready: true, downloaded: true };
  } finally {
    verificationCache.delete(temporary);
    await fs.rm(temporary, { force: true });
  }
}
