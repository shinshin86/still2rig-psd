import { detectAnime25RigFromBuffer } from './rig/anime25Rig';
import { createAnime25RigAvatar, type Anime25RigAvatar } from './rig/anime25Renderer';
import { createDefaultPsdMotionProfile } from './psdMotionProfile';
import { inspectEditablePsd } from './psdLayerEditor';
import { parseLayerOrder, parseLiveState, type LiveSettings, type LiveState } from './live/protocol.mjs';

let canvas = document.querySelector<HTMLCanvasElement>('#avatar')!;
const error = document.querySelector<HTMLElement>('#error')!;
const query = new URLSearchParams(location.search);
const psd = query.get('psd') ?? '';
const background = query.get('bg') ?? 'transparent';
const backgroundColor = background === 'green' ? '#00ff00' : background === 'blue' ? '#0000ff' : /^#[a-f\d]{6}$/i.test(background) ? background : 'transparent';
document.body.style.backgroundColor = backgroundColor;
let avatar: Anime25RigAvatar | null = null;
let latest: (LiveState & { at: number }) | null = null;
let applied = '';
let source: EventSource | null = null;
let frame = 0;
let active = false;
let currentWeight = 0;
let voiceMouth: number | null = null;
let ready = false;
let failure: string | null = null;
let originalBuffer: ArrayBuffer;
let originalOrder: string[] = [];
let layerOrder: string[] | null = null;
let requestedOrder: string[] | null = null;
let rebuilding = false;
let closed = false;
const signature = (order: readonly string[] | null) => JSON.stringify(order);

async function rebuild() {
  if (rebuilding || closed) return;
  rebuilding = true;
  try {
    while (!closed && signature(requestedOrder) !== signature(layerOrder)) {
      const order = requestedOrder;
      const detection = await detectAnime25RigFromBuffer(originalBuffer, order);
      if (closed) return;
      if (signature(order) !== signature(requestedOrder)) continue;
      if (!detection.usable || !detection.rig) return;
      const nextCanvas = canvas.cloneNode(false) as HTMLCanvasElement;
      const next = createAnime25RigAvatar(nextCanvas, detection.rig);
      const previous = avatar!;
      next.setViewTransform(0, 0, 0.9);
      applySettings(latest?.settings, !active, next);
      next.setTrackingInput(currentWeight > 0.005 ? latest?.input ?? null : null, currentWeight);
      next.setVoiceMouth(voiceMouth);
      next.setAnimationState(previous.getAnimationState());
      canvas.replaceWith(nextCanvas); canvas = nextCanvas; avatar = next;
      previous.dispose();
      layerOrder = order;
    }
  } finally { rebuilding = false; }
}
function receiveOrder(value: unknown) {
  const order = parseLayerOrder(value);
  if (order && (order.length !== originalOrder.length || order.some(id => !originalOrder.includes(id)))) return;
  requestedOrder = order && signature(order) !== signature(originalOrder) ? order : null;
  void rebuild().catch(() => { /* Keep the last complete avatar if rebuilding fails. */ });
}

declare global {
  interface Window { streamQa: { state: () => { ready: boolean; active: boolean; weight: number; voiceMouth: number | null; settings: LiveSettings | null; error: string | null; layerOrder: string[] | null } }; }
}
window.streamQa = { state: () => ({ ready, active, weight: currentWeight, voiceMouth, settings: latest?.settings ?? null, error: failure, layerOrder: layerOrder ? [...layerOrder] : null }) };

function applySettings(settings: LiveSettings | undefined, waiting: boolean, target = avatar) {
  if (!target) return;
  const profile = createDefaultPsdMotionProfile();
  Object.assign(profile.parameters, settings?.parameters, settings ? { eyeOpenL: settings.eyeOpen, eyeOpenR: settings.eyeOpen, mouthOpen: 0 } : {});
  profile.automation = {
    idle: waiting || settings?.mode === 'idle-physics', randomMotion: false,
    blink: waiting || (settings?.autoBlink ?? true), physics: waiting || settings?.mode !== 'static',
  };
  target.setMotionEnabled(true);
  target.setMotionProfile(profile);
  target.setEyeOpen(waiting || settings?.autoBlink ? null : settings?.eyeOpen ?? null);
  target.setMouthOpen(settings?.mouthOpen ?? 0);
  if (settings) { target.setMotionTuning(settings.tuning); target.setIntensity(settings.tuning.intensity ?? 1); }
}
function sample() {
  const age = latest ? Date.now() - latest.at : Infinity;
  active = age <= 1000;
  const key = `${active}:${JSON.stringify(latest?.settings)}`;
  if (applied !== key) { applySettings(latest?.settings, !active); applied = key; }
  currentWeight = latest ? latest.weight * Math.exp(-Math.max(0, age - 1000) / 180) : 0;
  avatar?.setTrackingInput(currentWeight > 0.005 ? latest!.input : null, currentWeight);
  const voice = latest?.voiceMouth;
  const decay = Math.exp(-Math.max(0, age - 1000) / 180);
  voiceMouth = voice == null ? null : voice * decay;
  if (!active && voiceMouth !== null && voiceMouth < 0.005) voiceMouth = null;
  avatar?.setVoiceMouth(voiceMouth);
  canvas.dataset.live = active ? 'active' : 'idle';
  frame = requestAnimationFrame(sample);
}
async function run() {
  try {
    if (!/^[a-zA-Z0-9_-]{1,1024}$/.test(psd)) throw new Error();
    const response = await fetch(`/api/generated-psds/${encodeURIComponent(psd)}`);
    if (!response.ok) throw new Error();
    originalBuffer = await response.arrayBuffer();
    originalOrder = inspectEditablePsd(originalBuffer).layers.map(layer => layer.id);
    const detection = await detectAnime25RigFromBuffer(originalBuffer);
    if (!detection.usable || !detection.rig) throw new Error();
    avatar = createAnime25RigAvatar(canvas, detection.rig);
    avatar.setViewTransform(0, 0, 0.9);
    const resize = () => {
      const ratios = [innerWidth / canvas.width, innerHeight / canvas.height];
      const scale = query.get('fit') === 'cover' ? Math.max(...ratios) : Math.min(...ratios);
      canvas.style.width = `${canvas.width * scale}px`; canvas.style.height = `${canvas.height * scale}px`;
    };
    resize(); window.addEventListener('resize', resize);
    source = new EventSource(`/api/live/events?psd=${encodeURIComponent(psd)}`);
    source.onmessage = event => {
      try {
        const raw = JSON.parse(event.data);
        if (raw.psd === psd && Object.keys(raw).every(key => ['psd', 'layerOrder'].includes(key)) && Object.hasOwn(raw, 'layerOrder')) {
          receiveOrder(raw.layerOrder); return;
        }
        const { at, ...state } = raw;
        if (!Number.isFinite(at) || state.psd !== psd) return;
        latest = { ...parseLiveState(state), at };
        receiveOrder(latest.layerOrder);
      } catch { /* Ignore malformed events and retain the most recent verified pose. */ }
    };
    ready = true; sample();
    window.addEventListener('pagehide', () => {
      closed = true; cancelAnimationFrame(frame); source?.close(); avatar?.dispose(); window.removeEventListener('resize', resize);
    }, { once: true });
  } catch {
    failure = 'キャラクターのファイルが見つかりません。カメラの画面からURLをコピーし直してください。';
    error.textContent = failure; error.hidden = false;
  }
}
void run();
