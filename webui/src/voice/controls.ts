import { VoiceMicrophone, type MicrophoneState } from './microphone';

export function installVoiceControls(callbacks: { level: (level: number | null) => void; active: (active: boolean) => void }) {
  const element = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
  const start = element<HTMLButtonElement>('voice-start');
  const stop = element<HTMLButtonElement>('voice-stop');
  const device = element<HTMLSelectElement>('voice-device');
  const state = element('voice-state');
  const meter = element<HTMLMeterElement>('voice-meter');
  const messages: Record<MicrophoneState, string> = {
    off: 'マイクは停止しています。', starting: 'マイクを準備しています…', listening: '声を聞き取っています。',
    denied: 'マイクの使用が許可されていません。ブラウザの設定を確認してください。',
    unavailable: 'マイクが見つかりません。接続を確認してください。',
    busy: 'マイクを使えません。ほかのアプリで使っていないか確認してください。',
    error: 'マイクの音を読み取れませんでした。接続を確認して、もう一度お試しください。',
  };
  let avatarReady = false;
  const microphone = new VoiceMicrophone(level => { meter.value = level ?? 0; callbacks.level(level); }, next => {
    state.textContent = messages[next]; sync(); callbacks.active(microphone.active);
    if (next === 'listening') void refreshDevices();
  });
  function sync() {
    start.disabled = !avatarReady || microphone.active;
    stop.disabled = !microphone.active;
    device.disabled = microphone.active;
    element('voice-conflict').hidden = !microphone.active;
  }
  async function refreshDevices() {
    try {
      const devices = (await navigator.mediaDevices.enumerateDevices()).filter(item => item.kind === 'audioinput');
      const selected = device.value;
      device.replaceChildren(...devices.map((item, index) => new Option(item.label || `マイク ${index + 1}`, item.deviceId)));
      if (devices.some(item => item.deviceId === selected)) device.value = selected;
      element('voice-device-field').hidden = devices.length < 2;
    } catch { /* Device selection is optional. */ }
  }
  start.addEventListener('click', () => { void microphone.start(device.value); });
  stop.addEventListener('click', () => microphone.stop());
  element<HTMLInputElement>('voice-sensitivity').addEventListener('input', event => {
    microphone.sensitivity = Number((event.target as HTMLInputElement).value);
  });
  navigator.mediaDevices?.addEventListener('devicechange', refreshDevices);
  window.addEventListener('pagehide', () => microphone.stop());
  void refreshDevices(); sync();
  return {
    setAvatarReady(ready: boolean) { avatarReady = ready; sync(); },
    stop() { microphone.stop(); },
    getState() { return { state: microphone.state, active: microphone.active, liveTracks: microphone.liveTracks }; },
  };
}
