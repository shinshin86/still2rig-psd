import type { LiveState } from './protocol.mjs';

export function createLivePublisher(snapshot: () => Omit<LiveState, 'source'> | null, status: (message: string) => void) {
  const source = crypto.randomUUID();
  const clock = new Worker(new URL('../tracking/clock-worker.js', import.meta.url));
  const abort = new AbortController();
  let enabled = false;
  let busy = false;
  let nextAttempt = 0;
  let nextSend = 0;
  let lastStatus = 0;
  let statusBusy = false;
  let closed = false;
  clock.onmessage = () => {
    if (!enabled || closed) return;
    const state = snapshot();
    if (!state) return;
    const now = performance.now();
    if (!statusBusy && now - lastStatus > 2000) {
      lastStatus = now; statusBusy = true;
      void fetch(`/api/live/status?psd=${encodeURIComponent(state.psd)}`, { signal: abort.signal })
        .then(async response => { if (response.ok) status(`配信画面: ${(await response.json()).connected}つ接続中`); })
        .catch(() => {}).finally(() => { statusBusy = false; });
    }
    // Never queue sends. The next clock message samples the newest values after completion.
    if (busy || now < nextAttempt || now < nextSend) return;
    nextSend = now + 34;
    busy = true;
    void fetch('/api/live/state', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Still2Rig-Action': 'live-state' },
      body: JSON.stringify({ ...state, source }), signal: abort.signal,
    }).then(response => {
      if (!response.ok) {
        nextAttempt = performance.now() + 2000;
        status(response.status === 409 ? '別のページから動かしています。そのページを閉じると切り替わります。' : '配信画面に動きを送れませんでした。接続を確認してください。');
      }
    }).catch(() => {
      nextAttempt = performance.now() + 2000;
      if (!closed) status('配信画面に動きを送れませんでした。接続を確認してください。');
    }).finally(() => { busy = false; });
  };
  const close = () => { closed = true; clock.terminate(); abort.abort(); };
  window.addEventListener('pagehide', close, { once: true });
  return {
    source,
    enable(value = true) { enabled = value; },
    async orderChanged() {
      if (enabled || closed) return;
      const state = snapshot();
      if (!state) return;
      try {
        const response = await fetch(`/api/live/status?psd=${encodeURIComponent(state.psd)}`, { signal: abort.signal });
        if (response.ok && (await response.json()).connected > 0 && snapshot()?.psd === state.psd) enabled = true;
      } catch { /* A later edit or camera start can retry. */ }
    },
    close,
  };
}
