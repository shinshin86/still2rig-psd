import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { expressionPresets } from '../../src/expressionPresets.mjs';

const aliases = new Map([['smile', 'joy'], ['surprise', 'surprised'], ['halfLidded', 'unamused']]);
const names = new Set(expressionPresets.map(item => item.id));
export function resolveExpression(value) {
  if (typeof value !== 'string') return null;
  const name = aliases.get(value) ?? value;
  return names.has(name) ? name : null;
}

export function createExpressionTokenStore(file) {
  const generate = () => crypto.randomBytes(32).toString('base64url');
  return {
    get() {
      try {
        const value = fs.readFileSync(file, 'utf8').trim();
        if (!/^[\w-]{43}$/.test(value)) throw new Error('Invalid saved expression credential');
        return value;
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        fs.mkdirSync(path.dirname(file), { recursive: true });
        const value = generate();
        try { fs.writeFileSync(file, value + '\n', { mode: 0o600, flag: 'wx' }); }
        catch (writeError) { if (writeError.code === 'EEXIST') return this.get(); throw writeError; }
        return value;
      }
    },
    rotate() {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const value = generate();
      const temporary = `${file}.${crypto.randomUUID()}.tmp`;
      try {
        fs.writeFileSync(temporary, value + '\n', { mode: 0o600, flag: 'wx' });
        fs.renameSync(temporary, file);
      } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
      return value;
    },
    matches(value) {
      if (typeof value !== 'string') return false;
      const expected = Buffer.from(this.get());
      const received = Buffer.from(value);
      return expected.length === received.length && crypto.timingSafeEqual(expected, received);
    },
  };
}

async function readCommand(request) {
  let bytes = 0;
  const chunks = [];
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes <= 4096) chunks.push(chunk);
  }
  if (bytes > 4096) throw Object.assign(new Error('Too large'), { status: 413 });
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw Object.assign(new Error('Invalid JSON'), { status: 400 }); }
}

export function expressionRemotePlugin({ listPsds, trusted, sendJson, tokenFile, activeSource }) {
  const credentials = createExpressionTokenStore(tokenFile);
  function install(server) {
    const clients = new Map();
    let sequence = 0;
    const heartbeat = setInterval(() => {
      for (const client of clients.values()) client.heartbeat();
    }, 15000);
    heartbeat.unref();
    server.httpServer?.once('close', () => {
      clearInterval(heartbeat);
      for (const client of clients.values()) client.close();
      clients.clear();
    });
    server.middlewares.use((request, response, next) => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      const command = url.pathname === '/__live/expression';
      const stream = url.pathname === '/api/live/commands';
      const token = url.pathname === '/api/expression/token';
      const rotate = url.pathname === '/api/expression/token/rotate';
      if (!command && !stream && !token && !rotate) return next();
      // These endpoints are local even if the server is explicitly bound more broadly.
      let hostname;
      try { hostname = new URL(`http://${request.headers.host}`).hostname; } catch { /* Reject below. */ }
      const local = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(request.socket.remoteAddress);
      if (!local || !['127.0.0.1', 'localhost', '[::1]'].includes(hostname) || !trusted(request, null)) {
        return sendJson(response, { error: 'この操作を受け付けられませんでした。' }, 403);
      }
      if (stream) {
        if (request.method !== 'GET') return sendJson(response, { error: 'この方法では操作できません。' }, 405);
        const source = url.searchParams.get('source');
        const psd = url.searchParams.get('psd');
        if (!/^[a-zA-Z0-9_-]{8,80}$/.test(source ?? '') || !listPsds().some(item => item.id === psd)) {
          return sendJson(response, { error: '選択したPSDが見つかりません。' }, 400);
        }
        clients.get(source)?.close();
        response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
        response.write(': connected\n\n');
        let blocked = false;
        let pending = null;
        const write = text => { blocked = !response.write(text); };
        const client = {
          psd, source, sequence: ++sequence,
          offer(value) {
            pending = value;
            if (!blocked && !response.destroyed) {
              const message = pending; pending = null;
              write(`data: ${JSON.stringify(message)}\n\n`);
            }
          },
          heartbeat() { if (!blocked && !response.destroyed) write(': alive\n\n'); },
          close() { response.end(); },
          alive() { return !response.destroyed && !response.writableEnded; },
        };
        response.on('drain', () => { blocked = false; if (pending) client.offer(pending); });
        clients.set(source, client);
        response.on('close', () => { if (clients.get(source) === client) clients.delete(source); });
        return;
      }
      if (request.method !== 'POST') return sendJson(response, { error: 'この方法では操作できません。' }, 405);
      if (token || rotate) {
        if (!trusted(request, rotate ? 'rotate-expression-token' : 'expression-token')) {
          return sendJson(response, { error: 'この操作を受け付けられませんでした。' }, 403);
        }
        try { return sendJson(response, { token: rotate ? credentials.rotate() : credentials.get() }); }
        catch { return sendJson(response, { error: '合言葉を読み書きできませんでした。' }, 500); }
      }
      void (async () => {
        try {
          const bearer = /^Bearer (\S+)$/i.exec(request.headers.authorization ?? '')?.[1];
          if (!credentials.matches(request.headers['x-studio-token']) && !credentials.matches(bearer)) {
            return sendJson(response, { error: '合言葉を確認してください。' }, 401);
          }
          const body = await readCommand(request);
          const expression = resolveExpression(body?.expression);
          if (!body || Array.isArray(body) || typeof body !== 'object' || !expression ||
              Object.keys(body).some(key => !['expression', 'psd'].includes(key)) ||
              (Object.hasOwn(body, 'psd') && (typeof body.psd !== 'string' || !/^[a-zA-Z0-9_-]{1,1024}$/.test(body.psd)))) {
            return sendJson(response, { error: '表情の名前と送り先を確認してください。' }, 400);
          }
          const candidates = [...clients.values()].filter(client => client.alive() && (!body.psd || client.psd === body.psd));
          candidates.sort((left, right) => {
            const a = activeSource(left.psd), b = activeSource(right.psd);
            const leftActive = a?.source === left.source ? a.at : 0;
            const rightActive = b?.source === right.source ? b.at : 0;
            return rightActive - leftActive || right.sequence - left.sequence;
          });
          if (!candidates.length) return sendJson(response, { error: '操作画面が開いていません' }, 409);
          // Availability belongs to selectExpression in the chosen controller, just like buttons.
          candidates[0].offer({ expression });
          sendJson(response, { ok: true, expression });
        } catch (error) {
          sendJson(response, { error: '表情の切り替えを受け付けられませんでした。' }, error.status ?? 400);
        }
      })();
    });
  }
  return { name: 'still2rig-expression-remote', configureServer: install, configurePreviewServer: install };
}
