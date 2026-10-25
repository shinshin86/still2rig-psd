import { expressionPresets } from '../../../src/expressionPresets.mjs';

export function installExpressionRemoteControls(source: string, select: (id: string) => void) {
  const panel = document.querySelector<HTMLDetailsElement>('#expression-remote')!;
  const address = document.querySelector<HTMLInputElement>('#expression-remote-url')!;
  const copyUrl = document.querySelector<HTMLButtonElement>('#expression-remote-copy-url')!;
  const copySecret = document.querySelector<HTMLButtonElement>('#expression-remote-copy-secret')!;
  const rotate = document.querySelector<HTMLButtonElement>('#expression-remote-rotate')!;
  const status = document.querySelector<HTMLElement>('#expression-remote-status')!;
  address.value = location.origin + '/__live/expression';
  let events: EventSource | null = null;
  let currentPsd = '';
  const credential = async (replace: boolean) => {
    const response = await fetch('/api/expression/token' + (replace ? '/rotate' : ''), {
      method: 'POST', headers: { 'X-Still2Rig-Action': replace ? 'rotate-expression-token' : 'expression-token' },
    });
    if (!response.ok) throw new Error('合言葉を読み書きできませんでした。もう一度お試しください。');
    return (await response.json()).token as string;
  };
  copyUrl.addEventListener('click', () => {
    void navigator.clipboard.writeText(address.value)
      .then(() => { status.textContent = '送り先のURLをコピーしました。'; })
      .catch(() => { status.textContent = 'コピーできませんでした。ブラウザの設定を確認してください。'; });
  });
  copySecret.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(await credential(false));
      status.textContent = '合言葉をコピーしました。使うアプリに貼り付けてください。';
    } catch { status.textContent = '合言葉をコピーできませんでした。もう一度お試しください。'; }
  });
  rotate.addEventListener('click', async () => {
    rotate.disabled = true;
    try {
      await credential(true);
      status.textContent = '合言葉を作り直しました。新しい合言葉をコピーし、使うアプリの設定を更新してください。';
    } catch { status.textContent = '合言葉を作り直せませんでした。もう一度お試しください。'; }
    finally { rotate.disabled = false; }
  });
  const close = () => { events?.close(); events = null; };
  window.addEventListener('pagehide', close, { once: true });
  return {
    connect(psd: string) {
      if (psd === currentPsd) return;
      currentPsd = psd;
      close();
      panel.dataset.connected = 'false';
      if (!psd) return;
      events = new EventSource(`/api/live/commands?psd=${encodeURIComponent(psd)}&source=${encodeURIComponent(source)}`);
      events.onopen = () => { panel.dataset.connected = 'true'; };
      events.onerror = () => { panel.dataset.connected = 'false'; };
      events.onmessage = event => {
        try {
          const value = JSON.parse(event.data);
          if (expressionPresets.some(item => item.id === value.expression)) select(value.expression);
        } catch { /* Keep the current face for malformed or unknown commands. */ }
      };
    },
  };
}
