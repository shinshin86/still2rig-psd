import { FaceCamera, type CameraState } from './camera';
import type { TrackingInput } from './pose.mjs';

export function installCameraControls(callbacks: {
  input: (input: TrackingInput | null, weight: number) => void;
  active: (active: boolean) => void;
}) {
  const element = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
  const video = element<HTMLVideoElement>('camera-video');
  const start = element<HTMLButtonElement>('camera-start');
  const stop = element<HTMLButtonElement>('camera-stop');
  const prepare = element<HTMLButtonElement>('camera-prepare');
  const calibrate = element<HTMLButtonElement>('camera-calibrate');
  const device = element<HTMLSelectElement>('camera-device');
  const state = element<HTMLParagraphElement>('camera-state');
  const mirror = element<HTMLInputElement>('camera-mirror');
  const preview = element<HTMLInputElement>('camera-preview');
  const messages: Record<CameraState, string> = {
    off: 'カメラは停止しています。', starting: 'カメラを準備しています…', tracking: '顔を読み取っています。',
    missing: '顔が見つかりません。カメラに顔を向けてください。', denied: 'カメラの使用が許可されていません。ブラウザの設定を確認してください。',
    unavailable: '使えるカメラが見つかりません。接続を確認してください。',
    'model-error': '顔の動きを読み取れませんでした。ページを開き直して、もう一度お試しください。',
    'camera-error': 'カメラを使えませんでした。ほかのアプリで使っていないか確認してください。',
  };
  let modelReady = false;
  let avatarReady = false;
  let preparing = false;
  const camera = new FaceCamera(video, callbacks.input, next => {
    state.textContent = messages[next];
    callbacks.active(camera.active);
    sync();
    if (next === 'tracking' || next === 'missing') void refreshDevices();
  });
  function sync() {
    start.disabled = !modelReady || !avatarReady || camera.active || preparing;
    stop.disabled = !camera.active;
    calibrate.disabled = camera.state !== 'tracking';
    device.disabled = camera.active;
    video.hidden = !preview.checked || !camera.active;
    video.style.transform = mirror.checked ? 'scaleX(-1)' : '';
    element('camera-conflict').hidden = !camera.active;
    if (!avatarReady && camera.state === 'off' && modelReady) state.textContent = 'PSDを読み込むと、カメラで動かせます。';
  }
  async function refreshDevices() {
    try {
      const cameras = (await navigator.mediaDevices.enumerateDevices()).filter(item => item.kind === 'videoinput');
      const selected = device.value;
      device.replaceChildren(...cameras.map((item, index) => new Option(item.label || `カメラ ${index + 1}`, item.deviceId)));
      if (cameras.some(item => item.deviceId === selected)) device.value = selected;
      element('camera-device-field').hidden = cameras.length < 2;
    } catch { /* Camera selection is optional on browsers without enumeration. */ }
  }
  async function checkModel() {
    try {
      const response = await fetch('/api/face-model/status');
      if (!response.ok) throw new Error();
      modelReady = (await response.json()).ready === true;
      prepare.hidden = modelReady;
      if (!modelReady) state.textContent = '最初に、顔の動きを読み取る準備をしてください。';
    } catch { state.textContent = '準備の状況を確認できませんでした。ページを開き直してください。'; }
    sync();
  }
  prepare.addEventListener('click', async () => {
    preparing = true; prepare.disabled = true;
    state.textContent = '顔の動きを読み取るためのファイルを取得しています…';
    sync();
    try {
      const response = await fetch('/api/face-model', { method: 'POST', headers: { 'X-Still2Rig-Action': 'prepare-face-model' } });
      if (!response.ok) throw new Error();
      if ((await response.json()).ready !== true) throw new Error();
      modelReady = true;
      prepare.hidden = true;
      state.textContent = '準備ができました。カメラを開始できます。';
    } catch { state.textContent = '取得できませんでした。インターネット接続を確認して、もう一度お試しください。'; }
    finally { preparing = false; prepare.disabled = false; sync(); }
  });
  start.addEventListener('click', () => { void camera.start(device.value); });
  stop.addEventListener('click', () => camera.stop());
  calibrate.addEventListener('click', () => {
    state.textContent = camera.calibrate() ? 'いまの顔を正面として登録しました。' : '顔が見えているときに登録してください。';
  });
  const changeOptions = () => {
    camera.options = { mirror: mirror.checked,
      sensitivity: Number(element<HTMLInputElement>('camera-sensitivity').value),
      smoothing: Number(element<HTMLInputElement>('camera-smoothing').value),
    };
    sync();
  };
  for (const id of ['camera-mirror', 'camera-sensitivity', 'camera-smoothing']) element(id).addEventListener('input', changeOptions);
  preview.addEventListener('change', sync);
  window.addEventListener('pagehide', () => camera.stop());
  void checkModel();
  return {
    setAvatarReady(ready: boolean) {
      avatarReady = ready;
      if (ready && modelReady && camera.state === 'off') state.textContent = messages.off;
      sync();
    },
    stop() { camera.stop(); },
    getState() { return { state: camera.state, active: camera.active, liveTracks: camera.liveTracks }; },
  };
}
