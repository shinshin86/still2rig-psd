import { readFace, TrackingPose, type TrackingInput, type TrackingOptions } from './pose.mjs';

export type CameraState = 'off' | 'starting' | 'tracking' | 'missing' | 'denied' | 'unavailable' | 'model-error' | 'camera-error';
export class FaceCamera {
  options: TrackingOptions = { mirror: true, sensitivity: 1.5, smoothing: 0.3 };
  state: CameraState = 'off';
  private stream: MediaStream | null = null;
  private worker: Worker | null = null;
  private generation = 0;
  private cancelInit: (() => void) | null = null;
  private frameCallback = 0;
  private frameTimer = 0;
  private animation = 0;
  private pose = new TrackingPose();
  constructor(private video: HTMLVideoElement,
    private onInput: (input: TrackingInput | null, weight: number) => void,
    private onState: (state: CameraState) => void) {}
  get active() { return this.state === 'starting' || this.state === 'tracking' || this.state === 'missing'; }
  get liveTracks() { return this.stream?.getTracks().filter(track => track.readyState === 'live').length ?? 0; }
  calibrate() { return this.pose.calibrate(performance.now()); }
  private status(state: CameraState) {
    if (this.state !== state) { this.state = state; this.onState(state); }
  }
  stop() {
    this.generation++;
    this.cancelInit?.(); this.cancelInit = null;
    cancelAnimationFrame(this.animation);
    clearTimeout(this.frameTimer);
    if (this.frameCallback) this.video.cancelVideoFrameCallback?.(this.frameCallback);
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
      await this.video.play();
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
          if (data.type === 'result') this.pose.update(readFace(data.matrix, data.categories), performance.now());
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
      let lastVideoTime = -1;
      const frame = () => {
        if (generation !== this.generation) return;
        if (this.video.requestVideoFrameCallback) this.frameCallback = this.video.requestVideoFrameCallback(frame);
        else this.frameTimer = window.setTimeout(frame, 34);
        const now = performance.now();
        if (busy || this.video.readyState < 2 || now - lastSent < 33 || lastVideoTime === this.video.currentTime) return;
        busy = true; lastSent = now; lastVideoTime = this.video.currentTime;
        void createImageBitmap(this.video).then(bitmap => {
          if (generation !== this.generation) { bitmap.close(); return; }
          worker.postMessage({ type: 'frame', frame: bitmap, timestamp: now }, [bitmap]);
        }).catch(() => {
          if (generation === this.generation) { this.stop(); this.status('camera-error'); }
        });
      };
      const sample = (now: number) => {
        if (generation !== this.generation) return;
        const value = this.pose.sample(now, Math.min(0.1, (now - lastTime) / 1000), this.options);
        lastTime = now;
        this.onInput(value.input, value.weight);
        this.status(value.visible ? 'tracking' : 'missing');
        this.animation = requestAnimationFrame(sample);
      };
      frame(); this.animation = requestAnimationFrame(sample);
    } catch (error) {
      if (generation !== this.generation) return;
      this.stop();
      const name = error instanceof Error ? error.name : '';
      this.status(phase === 'model' ? 'model-error' : name === 'NotAllowedError' ? 'denied'
        : name === 'NotFoundError' || name === 'OverconstrainedError' ? 'unavailable' : 'camera-error');
    }
  }
}
