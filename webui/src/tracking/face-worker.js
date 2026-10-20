// Classic worker: the pinned WASM loader uses importScripts internally.
self.exports = {};
let detector;
let delegate = 'GPU';
let samples = 0;
let elapsedTotal = 0;
let frames = 0;
let consecutiveFailures = 0;
const failureLimit = 4;
let files;
let options;
async function useCpu() {
  detector?.close();
  delegate = 'CPU';
  detector = await self.exports.FaceLandmarker.createFromOptions(files, {
    ...options, baseOptions: { modelAssetPath: '/api/face-model', delegate },
  });
}
self.onmessage = async ({ data }) => {
  if (data.type === 'init') {
    try {
      importScripts('/api/face-assets/vision_bundle.js');
      files = await self.exports.FilesetResolver.forVisionTasks('/api/face-assets');
      options = {
        runningMode: 'VIDEO', numFaces: 1,
        outputFaceBlendshapes: true, outputFacialTransformationMatrixes: true,
      };
      try {
        detector = await self.exports.FaceLandmarker.createFromOptions(files, {
          ...options, baseOptions: { modelAssetPath: '/api/face-model', delegate },
        });
      } catch { await useCpu(); }
      self.postMessage({ type: 'ready' });
    } catch { self.postMessage({ type: 'error' }); }
    return;
  }
  if (data.type !== 'frame') return;
  try {
    const start = performance.now();
    let result;
    try { result = detector.detectForVideo(data.frame, data.timestamp); }
    catch (error) {
      if (delegate !== 'GPU') throw error;
      try { await useCpu(); }
      catch { self.postMessage({ type: 'error' }); return; }
      result = detector.detectForVideo(data.frame, data.timestamp);
    }
    consecutiveFailures = 0;
    self.postMessage({ type: 'result',
      matrix: result.facialTransformationMatrixes[0]?.data,
      categories: result.faceBlendshapes[0]?.categories ?? [],
    });
    if (delegate === 'GPU' && ++frames > 5) {
      elapsedTotal += performance.now() - start;
      if (++samples === 8) {
        if (elapsedTotal / samples > 1000 / 15) {
          try { await useCpu(); }
          catch { self.postMessage({ type: 'error' }); return; }
        }
        samples = 0; elapsedTotal = 0;
      }
    }
  } catch {
    // Discard isolated bad frames. Only a sustained inference failure stops capture.
    if (++consecutiveFailures >= failureLimit) self.postMessage({ type: 'error' });
  }
  finally { data.frame.close(); self.postMessage({ type: 'consumed' }); }
};
