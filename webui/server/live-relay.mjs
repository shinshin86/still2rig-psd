import { parseLiveState } from '../src/live/protocol.mjs';

const maxBytes = 16384;
async function readState(request) {
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size <= maxBytes) chunks.push(chunk);
  }
  if (size > maxBytes) throw Object.assign(new Error('Too large'), { status: 413 });
  try { return parseLiveState(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
  catch { throw Object.assign(new Error('Invalid state'), { status: 400 }); }
}

export function liveRelayPlugin({ listPsds, trusted, sendJson }) {
  function install(server) {
    const channels = new Map();
    const channel = psd => {
      if (!channels.has(psd)) channels.set(psd, { latest: null, clients: new Set(), sent: null });
      return channels.get(psd);
    };
    const tick = setInterval(() => {
      for (const [psd, room] of channels) {
        if (room.latest !== room.sent) {
          room.sent = room.latest;
          for (const client of room.clients) client.offer(room.latest);
        }
        if (!room.clients.size && (!room.latest || Date.now() - room.latest.at > 10000)) channels.delete(psd);
      }
    }, 34);
    const heartbeat = setInterval(() => {
      for (const room of channels.values()) for (const client of room.clients) client.heartbeat();
    }, 15000);
    tick.unref(); heartbeat.unref();
    server.httpServer?.once('close', () => {
      clearInterval(tick); clearInterval(heartbeat);
      for (const room of channels.values()) for (const client of room.clients) client.close();
      channels.clear();
    });
    server.middlewares.use((request, response, next) => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      if (!url.pathname.startsWith('/api/live/')) return next();
      if (!trusted(request, request.method === 'POST' ? 'live-state' : null)) return sendJson(response, { error: 'この操作を受け付けられませんでした。' }, 403);
      if (request.method === 'POST' && url.pathname === '/api/live/state') {
        void (async () => {
          try {
            const state = await readState(request);
            if (!listPsds().some(item => item.id === state.psd)) return sendJson(response, { error: '選択したPSDが見つかりません。' }, 404);
            const room = channel(state.psd);
            // Keep one source until its heartbeat expires, preventing competing tabs from alternating.
            if (room.latest && room.latest.source !== state.source && Date.now() - room.latest.at < 1500) {
              return sendJson(response, { error: '別のページから動かしています。' }, 409);
            }
            room.latest = { ...state, at: Date.now() };
            sendJson(response, { ok: true });
          } catch (error) { sendJson(response, { error: '動きの情報を受け取れませんでした。' }, error.status ?? 400); }
        })();
        return;
      }
      const psd = url.searchParams.get('psd');
      if (request.method !== 'GET' || !listPsds().some(item => item.id === psd)) return sendJson(response, { error: '選択したPSDが見つかりません。' }, 404);
      const room = channel(psd);
      if (url.pathname === '/api/live/status') return sendJson(response, { connected: room.clients.size });
      if (url.pathname !== '/api/live/events') return sendJson(response, { error: '見つかりません。' }, 404);
      response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      response.write(': connected\n\n');
      let blocked = false;
      let pending = null;
      const write = text => { blocked = !response.write(text); };
      const client = {
        offer(state) {
          if (!state || response.destroyed) return;
          pending = state;
          if (!blocked) { const value = pending; pending = null; write(`data: ${JSON.stringify(value)}\n\n`); }
        },
        heartbeat() { if (!blocked && !response.destroyed) write(': alive\n\n'); },
        close() { response.end(); },
      };
      response.on('drain', () => { blocked = false; if (pending) client.offer(pending); });
      room.clients.add(client);
      client.offer(room.latest);
      response.on('close', () => room.clients.delete(client));
    });
  }
  return { name: 'still2rig-live', configureServer: install, configurePreviewServer: install };
}
