import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createExpressionTokenStore, expressionRemotePlugin } from '../webui/server/expression-remote.mjs';
import { liveRelayPlugin } from '../webui/server/live-relay.mjs';

async function harness(t, hook = 'configureServer', tokenFile) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'still2rig-expression-'));
  const file = tokenFile ?? path.join(root, 'expression-token');
  const middleware = [];
  const server = http.createServer((request, response) => {
    let index = 0;
    const next = () => {
      const handler = middleware[index++];
      if (handler) handler(request, response, next);
      else { response.statusCode = 404; response.end(); }
    };
    next();
  });
  const sendJson = (res, value, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
  const trusted = (req, action) => {
    if (action !== null && req.headers['x-still2rig-action'] !== action) return false;
    if (!req.headers.origin) return !req.headers['sec-fetch-site'] || ['same-origin', 'none'].includes(req.headers['sec-fetch-site']);
    try { return new URL(req.headers.origin).host === req.headers.host; } catch { return false; }
  };
  const listPsds = () => [{ id: 'first_psd' }, { id: 'second_psd' }];
  const relay = liveRelayPlugin({ listPsds, trusted, sendJson });
  const remote = expressionRemotePlugin({ listPsds, trusted, sendJson, tokenFile: file, activeSource: psd => relay.activeSource(psd) });
  const fake = { httpServer: server, middlewares: { use(fn) { middleware.push(fn); } } };
  relay[hook](fake); remote[hook](fake);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const streams = [];
  t.after(async () => {
    for (const stream of streams) stream.abort.abort();
    await Promise.all(streams.map(stream => stream.reading));
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const credential = async (rotate = false, headers = {}) => fetch(base + '/api/expression/token' + (rotate ? '/rotate' : ''), {
    method: 'POST', headers: { 'X-Still2Rig-Action': rotate ? 'rotate-expression-token' : 'expression-token', ...headers },
  });
  const post = (body, headers = {}) => fetch(base + '/__live/expression', { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });
  const connect = async (source, psd = 'first_psd') => {
    const stream = { abort: new AbortController(), events: [], reading: null };
    const response = await fetch(`${base}/api/live/commands?source=${source}&psd=${psd}`, { signal: stream.abort.signal });
    assert.equal(response.status, 200);
    const reader = response.body.getReader();
    stream.reading = (async () => {
      let buffer = '';
      try {
        while (true) {
          const { value, done } = await reader.read(); if (done) break;
          buffer += new TextDecoder().decode(value);
          let boundary;
          while ((boundary = buffer.indexOf('\n\n')) >= 0) {
            const event = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
            if (event.startsWith('data: ')) stream.events.push(JSON.parse(event.slice(6)));
          }
        }
      } catch (error) { if (!stream.abort.signal.aborted) throw error; }
    })();
    streams.push(stream);
    return stream;
  };
  return { root, file, base, post, connect, credential, publish: async source => {
    const response = await fetch(base + '/api/live/state', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Still2Rig-Action': 'live-state' },
      body: JSON.stringify({ psd: 'first_psd', source, input: null, weight: 0, settings: { mode: 'static', autoBlink: false, eyeOpen: 1, mouthOpen: 0, parameters: {}, tuning: {} } }) });
    assert.equal(response.status, 200);
  } };
}
async function waitEvents(stream, count) {
  const deadline = Date.now() + 2000;
  while (stream.events.length < count && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(stream.events.length, count);
}

test('commands require either exact credential header, reject invalid names and bound JSON', async t => {
  const h = await harness(t), token = (await (await h.credential()).json()).token;
  assert.equal((await h.post({ expression: 'joy' })).status, 401);
  assert.equal((await h.post({ expression: 'joy' }, { 'X-Studio-Token': 'wrong' })).status, 401);
  assert.equal((await h.post({ expression: 'joy' }, { 'X-Studio-Token': token })).status, 409);
  const controller = await h.connect('controller-one');
  for (const [index, expression] of ['neutral', 'joy', 'shy', 'angry', 'sad', 'surprised', 'flustered', 'unamused', 'wink'].entries()) {
    const response = await h.post({ expression }, index % 2 ? { Authorization: `Bearer ${token}` } : { 'X-Studio-Token': token });
    assert.equal(response.headers.has('access-control-allow-origin'), false);
    assert.deepEqual(await response.json(), { ok: true, expression });
  }
  await waitEvents(controller, 9);
  for (const expression of ['missing', '1', 1, null]) assert.equal((await h.post({ expression }, { 'X-Studio-Token': token })).status, 400);
  assert.equal((await h.post('x'.repeat(4097), { 'X-Studio-Token': token })).status, 413);
  assert.equal((await h.post('{', { 'X-Studio-Token': token })).status, 400);
});

test('aliases resolve and only the newest controller receives commands until the live source takes priority', async t => {
  const h = await harness(t), token = (await (await h.credential()).json()).token;
  const first = await h.connect('controller-first'), last = await h.connect('controller-last');
  const other = await h.connect('controller-other', 'second_psd');
  assert.equal((await h.post({ expression: 'smile' }, { 'X-Studio-Token': token })).status, 200);
  await waitEvents(other, 1); assert.equal(other.events[0].expression, 'joy');
  await h.post({ expression: 'surprise', psd: 'first_psd' }, { 'X-Studio-Token': token });
  await waitEvents(last, 1); assert.equal(last.events[0].expression, 'surprised');
  await h.publish('controller-first');
  await h.post({ expression: 'halfLidded' }, { 'X-Studio-Token': token });
  await waitEvents(first, 1); assert.equal(first.events[0].expression, 'unamused');
  assert.equal(last.events.length, 1); assert.equal(other.events.length, 1);
  assert.equal((await h.post({ expression: 'joy', psd: 'absent_psd' }, { 'X-Studio-Token': token })).status, 409);
});

test('token retrieval, SSE and commands reject foreign sites and never enable CORS', async t => {
  const h = await harness(t), token = (await (await h.credential()).json()).token;
  for (const headers of [{ Origin: 'https://example.com' }, { 'Sec-Fetch-Site': 'cross-site' }]) {
    assert.equal((await h.credential(false, headers)).status, 403);
    assert.equal((await h.post({ expression: 'joy' }, { 'X-Studio-Token': token, ...headers })).status, 403);
    assert.equal((await fetch(h.base + '/api/live/commands?source=controller-foreign&psd=first_psd', { headers })).status, 403);
  }
  assert.equal((await h.credential(false, { 'X-Still2Rig-Action': 'wrong' })).status, 403);
  assert.equal((await fetch(h.base + '/api/expression/token')).status, 405);
  const options = await fetch(h.base + '/__live/expression', { method: 'OPTIONS', headers: { Origin: h.base, 'Access-Control-Request-Headers': 'x-studio-token' } });
  assert.equal(options.status, 405);
  assert.equal([...options.headers].some(([key]) => key.startsWith('access-control-allow-')), false);
  const rejected = await h.post({ expression: 'joy' }, { Origin: 'https://example.com', 'X-Studio-Token': token });
  assert.equal([...rejected.headers].some(([key]) => key.startsWith('access-control-allow-')), false);
});

test('credentials persist across instances and rotation invalidates the old value in dev and preview', async t => {
  for (const hook of ['configureServer', 'configurePreviewServer']) {
    const h = await harness(t, hook);
    const first = (await (await h.credential()).json()).token;
    assert.equal(createExpressionTokenStore(h.file).get(), first);
    assert.equal(fs.statSync(h.file).mode & 0o777, 0o600);
    const second = (await (await h.credential(true)).json()).token;
    assert.notEqual(second, first);
    assert.equal(createExpressionTokenStore(h.file).get(), second);
    await h.connect(`controller-${hook}`);
    assert.equal((await h.post({ expression: 'neutral' }, { 'X-Studio-Token': first })).status, 401);
    assert.equal((await h.post({ expression: 'neutral' }, { Authorization: `Bearer ${second}` })).status, 200);
  }
});
