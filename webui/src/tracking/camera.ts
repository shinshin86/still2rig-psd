import { readFace, TrackingPose, type TrackingInput, type TrackingOptions } from './pose.mjs';

type TrackProcessor = new (options: { track: MediaStreamTrack; maxBufferSize: number }) => { readable: ReadableStream<VideoFrame> };

export type CameraState = 'off' | 'starting' | 'tracking' | 'missing' | 'denied' | 'unavailable' | 'model-error' | 'camera-error';
export class FaceCamera {
  options: TrackingOptions = { mirror: true, sensitivity: 1.5, smoothing: 0.3 };
  state: CameraState = 'off';
  private stream: MediaStream | null = null;
  private worker: Worker | null = null;
  private generation = 0;
  private cancelInit: (() => void) | null = null;
  private clock: Worker | null = null;
  private reader: ReadableStreamDefaultReader<VideoFrame> | null = null;
  private results: number[] = [];
  private pose = new TrackingPose();
  constructor(private video: HTMLVideoElement,
    private onInput: (input: TrackingInput | null, weight: number) => void,
    private onState: (state: CameraState) => void,
    private onSlow: (slow: boolean) => void = () => {}) {}
  get active() { return this.state === 'starting' || this.state === 'tracking' || this.state === 'missing'; }
  get liveTracks() { return this.stream?.getTracks().filter(track => track.readyState === 'live').length ?? 0; }
  calibrate() { return this.pose.calibrate(performance.now()); }
  private status(state: CameraState) {
    if (this.state !== state) { this.state = state; this.onState(state); }
  }
  stop() {
    this.generation++;
    this.cancelInit?.(); this.cancelInit = null;
    this.clock?.terminate(); this.clock = null;
    void this.reader?.cancel().catch(() => {}); this.reader = null;
    this.results = []; this.onSlow(false);
    this.worker?.terminate(); this.worker = null;
    this.stream?.getTracks().forEach(track => track.stop()); this.stream = null;
    this.video.pause(); this.video.srcObject = null;
    this.pose = new TrackingPose();
    this.onInput(null, 0);
    this.status('off');
  }
  async start(deviceId = '') {
    this.stop();
    const generation = this.generation;
    this.status('starting');
    let phase: 'camera' | 'model' = 'camera';
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw new DOMException('', 'NotFoundError');
      const stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: {
        width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 30, max: 30 },
        ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
      } });
      if (generation !== this.generation) { stream.getTracks().forEach(track => track.stop()); return; }
      this.stream = stream;
      stream.getVideoTracks()[0]?.addEventListener('ended', () => {
        if (generation === this.generation) { this.stop(); this.status('camera-error'); }
      });
      this.video.srcObject = stream;
      void this.video.play().catch(() => {});
      if (generation !== this.generation) return;
      phase = 'model';
      const worker = new Worker(new URL('./face-worker.js', import.meta.url));
      this.worker = worker;
      let busy = false;
      await new Promise<void>((resolve, reject) => {
        const timeout = window.setTimeout(() => reject(new Error('Face reader timed out.')), 30000);
        const finish = (error?: Error) => {
          clearTimeout(timeout); this.cancelInit = null;
          if (error) reject(error); else resolve();
        };
        this.cancelInit = () => finish(new Error('Stopped.'));
        worker.onerror = () => {
          finish(new Error('Face reader failed.'));
          if (generation === this.generation) { this.stop(); this.status('model-error'); }
        };
        worker.onmessage = ({ data }) => {
          if (generation !== this.generation) return;
          if (data.type === 'ready') finish();
          if (data.type === 'result') {
            const now = performance.now();
            this.results.push(now);
            this.pose.update(readFace(data.matrix, data.categories), now);
          }
          if (data.type === 'consumed') busy = false;
          if (data.type === 'error') {
            finish(new Error('Face reader failed.'));
            this.stop(); this.status('model-error');
          }
        };
        worker.postMessage({ type: 'init' });
      });
      if (generation !== this.generation) return;
      let lastSent = -Infinity;
      let lastTime = performance.now();
      const started = lastTime;
      let lastVideoTime = -1;
      const send = (frame: VideoFrame | ImageBitmap, now: number) => {
        if (generation !== this.generation || busy || now - lastSent < 33) { frame.close(); return; }
        lastSent = now; busy = true;
        try { worker.postMessage({ type: 'frame', frame, timestamp: now }, [frame]); }
        catch { frame.close(); busy = false; this.stop(); this.status('model-error'); }
      };
      const Processor = (globalThis as typeof globalThis & { MediaStreamTrackProcessor?: TrackProcessor }).MediaStreamTrackProcessor;
      if (Processor) {
        try {
          const reader = new Processor({ track: stream.getVideoTracks()[0]!, maxBufferSize: 1 }).readable.getReader();
          this.reader = reader;
          void (async () => {
            try {
              while (generation === this.generation) {
                const { done, value } = await reader.read();
                if (done) break;
                send(value, performance.now());
              }
            } catch { /* A browser may expose a processor that cannot read this device. */ }
            finally { reader.releaseLock(); if (this.reader === reader) this.reader = null; }
          })();
        } catch { /* Use local video frames if track processing is unavailable. */ }
      }
      const clock = new Worker(new URL('./clock-worker.js', import.meta.url));
      this.clock = clock;
      clock.onmessage = () => {
        if (generation !== this.generation) return;
        const now = performance.now();
        if (!this.reader && !busy && this.video.readyState >= 2 && this.video.currentTime !== lastVideoTime && now - lastSent >= 33) {
          busy = true; lastVideoTime = this.video.currentTime;
          void createImageBitmap(this.video).then(bitmap => {
            if (generation !== this.generation) { bitmap.close(); return; }
            busy = false; send(bitmap, performance.now());
          }).catch(() => {
            if (generation === this.generation) { this.stop(); this.status('camera-error'); }
          });
        }
        const value = this.pose.sample(now, Math.min(0.1, (now - lastTime) / 1000), this.options);
        lastTime = now;
        this.onInput(value.input, value.weight);
        this.status(value.visible ? 'tracking' : 'missing');
        this.results = this.results.filter(time => now - time <= 2000);
        this.onSlow(document.hidden && now - started > 2000 && this.results.length < 30);
      };
    } catch (error) {
      if (generation !== this.generation) return;
      this.stop();
      const name = error instanceof Error ? error.name : '';
      this.status(phase === 'model' ? 'model-error' : name === 'NotAllowedError' ? 'denied'
        : name === 'NotFoundError' || name === 'OverconstrainedError' ? 'unavailable' : 'camera-error');
    }
  }
}
