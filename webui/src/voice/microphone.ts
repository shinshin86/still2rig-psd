import { mouthTarget, rmsLevel, smoothMouth } from './level.mjs';

export type MicrophoneState = 'off' | 'starting' | 'listening' | 'denied' | 'unavailable' | 'busy' | 'error';

export class VoiceMicrophone {
  state: MicrophoneState = 'off';
  sensitivity = 1;
  private stream: MediaStream | null = null;
  private context: AudioContext | null = null;
  private clock: Worker | null = null;
  private generation = 0;
  constructor(private onLevel: (level: number | null) => void, private onState: (state: MicrophoneState) => void) {}
  get active() { return this.state === 'starting' || this.state === 'listening'; }
  get liveTracks() { return this.stream?.getTracks().filter(track => track.readyState === 'live').length ?? 0; }
  private status(state: MicrophoneState) { this.state = state; this.onState(state); }
  stop() {
    this.generation++;
    this.clock?.terminate(); this.clock = null;
    this.stream?.getTracks().forEach(track => track.stop()); this.stream = null;
    const context = this.context; this.context = null;
    if (context) void context.close().catch(() => {});
    this.onLevel(null);
    this.status('off');
  }
  async start(deviceId = '') {
    this.stop();
    const generation = this.generation;
    this.status('starting');
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw new DOMException('', 'NotFoundError');
      // Construct and resume synchronously from the Start button's user gesture.
      const context = new AudioContext(); this.context = context;
      const resumed = context.resume().then(() => null, error => error);
      const pendingStream = navigator.mediaDevices.getUserMedia({ video: false, audio: {
        echoCancellation: true, noiseSuppression: true, autoGainControl: false,
        ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
      } });
      // Always handle the permission reply, including when Stop won the race.
      const stream = await pendingStream;
      if (generation !== this.generation) { stream.getTracks().forEach(track => track.stop()); return; }
      this.stream = stream;
      const resumeError = await resumed;
      if (resumeError) throw resumeError;
      if (generation !== this.generation) return;
      stream.getAudioTracks()[0]?.addEventListener('ended', () => {
        if (generation === this.generation) { this.stop(); this.status('error'); }
      });
      const source = context.createMediaStreamSource(stream);
      const analyser = context.createAnalyser(); analyser.fftSize = 1024;
      source.connect(analyser); // No connection to the speakers: never play back microphone audio.
      const samples = new Float32Array(analyser.fftSize);
      let previous = 0;
      let lastTime = performance.now();
      const clock = new Worker(new URL('../tracking/clock-worker.js', import.meta.url));
      this.clock = clock;
      clock.onmessage = () => {
        if (generation !== this.generation) return;
        const now = performance.now();
        analyser.getFloatTimeDomainData(samples);
        previous = smoothMouth(previous, mouthTarget(rmsLevel(samples), this.sensitivity), (now - lastTime) / 1000);
        lastTime = now;
        this.onLevel(previous);
      };
      this.status('listening');
    } catch (error) {
      if (generation !== this.generation) return;
      this.stop();
      const name = error instanceof Error ? error.name : '';
      this.status(name === 'NotAllowedError' || name === 'SecurityError' ? 'denied'
        : name === 'NotFoundError' || name === 'OverconstrainedError' ? 'unavailable'
        : name === 'NotReadableError' ? 'busy' : 'error');
    }
  }
}
