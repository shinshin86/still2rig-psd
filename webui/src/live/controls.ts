export function installStreamControls(getPsd: () => string, start: () => void) {
  const background = document.querySelector<HTMLSelectElement>('#stream-background')!;
  const color = document.querySelector<HTMLInputElement>('#stream-color')!;
  const copy = document.querySelector<HTMLButtonElement>('#stream-copy')!;
  const open = document.querySelector<HTMLButtonElement>('#stream-open')!;
  const note = document.querySelector<HTMLElement>('#stream-note')!;
  const result = document.querySelector<HTMLElement>('#stream-status')!;
  const url = () => {
    const target = new URL('stream.html', location.href);
    target.search = '';
    target.searchParams.set('psd', getPsd());
    target.searchParams.set('bg', background.value === 'custom' ? color.value : background.value);
    return target.href;
  };
  const sync = () => {
    copy.disabled = open.disabled = !getPsd();
    color.hidden = background.value !== 'custom';
    note.textContent = getPsd()
      ? 'OBSで「ブラウザ」ソースを追加し、コピーしたURLを貼ってください。幅と高さは1080をおすすめします。'
      : '配信画面では、保存先の一覧から選んだPSDだけを使えます。';
  };
  background.addEventListener('change', sync);
  copy.addEventListener('click', async () => {
    if (!getPsd()) return;
    try { await navigator.clipboard.writeText(url()); start(); result.textContent = '配信用のURLをコピーしました。'; }
    catch { result.textContent = 'コピーできませんでした。ブラウザの設定を確認してください。'; }
  });
  open.addEventListener('click', () => {
    if (!getPsd()) return;
    start(); window.open(url(), '_blank', 'noopener,noreferrer');
  });
  sync();
  return { sync, status(message: string) { result.textContent = message; } };
}
