import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

import { defineConfig } from 'vite';
import { liveRelayPlugin } from './server/live-relay.mjs';
import { expressionRemotePlugin } from './server/expression-remote.mjs';
import { createRequire } from 'node:module';
import { ensureFaceModel, faceModelFile, faceModelReady } from '../src/face-model.mjs';

const repositoryRoot = path.resolve(import.meta.dirname, '..');
const configuredJobsRoot = process.env.STILL2RIG_PSD_JOBS_ROOT;
const jobsRoot = configuredJobsRoot
  ? path.resolve(repositoryRoot, configuredJobsRoot)
  : path.join(repositoryRoot, '.still2rig-psd', 'jobs');

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function listGeneratedPsds() {
  if (!fs.existsSync(jobsRoot) || !fs.lstatSync(jobsRoot).isDirectory()) return [];
  const results = [];
  for (const entry of fs.readdirSync(jobsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const jobRoot = path.join(jobsRoot, entry.name);
    const outputRoot = path.join(jobRoot, 'output');
    if (!fs.existsSync(outputRoot) || !fs.lstatSync(outputRoot).isDirectory()) continue;
    const manifest = readJson(path.join(jobRoot, 'job.json'));
    for (const fileName of fs.readdirSync(outputRoot)) {
      if (!/\.psd$/i.test(fileName)) continue;
      const file = path.join(outputRoot, fileName);
      const stat = fs.lstatSync(file);
      if (!stat.isFile()) continue;
      const relativeFile = path.relative(jobsRoot, file);
      const id = Buffer.from(relativeFile).toString('base64url');
      results.push({
        id,
        name: fileName,
        url: `/api/generated-psds/${id}`,
        createdAt: manifest?.createdAt ?? stat.mtime.toISOString(),
        state: manifest?.state ?? 'generated',
        productionReady: manifest?.result?.productionReady ?? null,
        bytes: stat.size,
        jobId: manifest?.jobId === entry.name && /^[a-z0-9][a-z0-9._-]{0,79}$/.test(entry.name)
          ? entry.name : null,
        file,
      });
    }
  }
  return results.sort((left, right) =>
    String(right.createdAt).localeCompare(String(left.createdAt)),
  );
}

function sendJson(response, value, statusCode = 200) {
  const body = JSON.stringify(value);
  response.statusCode = statusCode;
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.setHeader('Cache-Control', 'no-store');
  response.end(body);
}

function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    let body = '';
    let tooLarge = false;
    request.setEncoding('utf8');
    request.on('data', (chunk) => {
      if (tooLarge) return;
      body += chunk;
      if (body.length > 4096) {
        body = '';
        tooLarge = true;
      }
    });
    request.on('end', () => {
      if (tooLarge) {
        reject(new Error('Request body is too large.'));
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error('Request body is not valid JSON.'));
      }
    });
    request.on('error', reject);
  });
}

function isTrustedActionRequest(request, action) {
  if (action !== null && request.headers['x-still2rig-action'] !== action) return false;
  const origin = request.headers.origin;
  if (!origin) {
    const fetchSite = request.headers['sec-fetch-site'];
    return !fetchSite || fetchSite === 'same-origin' || fetchSite === 'none';
  }
  try {
    return new URL(origin).host === request.headers.host;
  } catch {
    return false;
  }
}

function openDirectory(directory) {
  if (process.env.STILL2RIG_PSD_OPEN_FOLDER_DRY_RUN === '1') return Promise.resolve();
  const command = process.platform === 'darwin'
    ? { file: 'open', args: [directory] }
    : process.platform === 'win32'
      ? { file: 'explorer.exe', args: [directory] }
      : process.platform === 'linux'
        ? { file: 'xdg-open', args: [directory] }
        : null;
  if (!command) return Promise.reject(new Error(`Unsupported platform: ${process.platform}`));
  return new Promise((resolve, reject) => {
    const child = spawn(command.file, command.args, {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
}

async function openGeneratedPsdFolder(request, response) {
  if (!isTrustedActionRequest(request, 'open-generated-folder')) {
    sendJson(response, { error: 'この操作を受け付けられませんでした。' }, 403);
    return;
  }
  let payload;
  try {
    payload = await readJsonBody(request);
  } catch {
    sendJson(response, { error: '選択したPSDを確認できませんでした。' }, 400);
    return;
  }
  if (!payload || typeof payload.id !== 'string') {
    sendJson(response, { error: '生成済みPSDを選択してください。' }, 400);
    return;
  }
  const item = listGeneratedPsds().find((candidate) => candidate.id === payload.id);
  if (!item) {
    sendJson(response, { error: '選択したPSDが見つかりませんでした。' }, 404);
    return;
  }
  try {
    await openDirectory(path.dirname(item.file));
    sendJson(response, { ok: true });
  } catch {
    sendJson(response, { error: '保存先を開けませんでした。' }, 500);
  }
}

function generatedPsdMiddleware(request, response, next) {
  const requestUrl = new URL(request.url ?? '/', 'http://127.0.0.1');
  if (
    request.method === 'POST' &&
    requestUrl.pathname === '/api/generated-psds/open-folder'
  ) {
    void openGeneratedPsdFolder(request, response);
    return;
  }
  if (request.method !== 'GET' && request.method !== 'HEAD') return next();
  if (requestUrl.pathname === '/api/generated-psds') {
    const publicItems = listGeneratedPsds().map(({ file: _file, ...item }) => item);
    sendJson(response, { items: publicItems });
    return;
  }
  const prefix = '/api/generated-psds/';
  if (!requestUrl.pathname.startsWith(prefix)) return next();
  const id = requestUrl.pathname.slice(prefix.length);
  const item = listGeneratedPsds().find((candidate) => candidate.id === id);
  if (!item) {
    response.statusCode = 404;
    response.end('PSD not found');
    return;
  }
  response.statusCode = 200;
  response.setHeader('Content-Type', 'image/vnd.adobe.photoshop');
  response.setHeader('Content-Length', String(item.bytes));
  response.setHeader('Cache-Control', 'no-store');
  if (request.method === 'HEAD') {
    response.end();
    return;
  }
  fs.createReadStream(item.file).pipe(response);
}

function generatedPsdPlugin() {
  return {
    name: 'still2rig-generated-psds',
    configureServer(server) {
      server.middlewares.use(generatedPsdMiddleware);
    },
    configurePreviewServer(server) {
      server.middlewares.use(generatedPsdMiddleware);
    },
  };
}

function faceAssetsPlugin() {
  const require = createRequire(import.meta.url);
  const assetsRoot = path.dirname(require.resolve('@mediapipe/tasks-vision'));
  const assets = new Map([
    ['vision_bundle.js', path.join(assetsRoot, 'vision_bundle.cjs')],
    ...fs.readdirSync(path.join(assetsRoot, 'wasm')).filter(name => /\.(wasm|js)$/.test(name))
      .map(name => [name, path.join(assetsRoot, 'wasm', name)]),
  ]);
  const middleware = async (request, response, next) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    try {
      if (url.pathname === '/api/face-model' && request.method === 'POST') {
        if (!isTrustedActionRequest(request, 'prepare-face-model')) return sendJson(response, { error: 'この操作を受け付けられませんでした。' }, 403);
        return sendJson(response, await ensureFaceModel());
      }
      if (request.method !== 'GET' && request.method !== 'HEAD') return next();
      if (url.pathname === '/api/face-model/status') return sendJson(response, { ready: await faceModelReady() });
      let file;
      if (url.pathname === '/api/face-model') {
        if (!await faceModelReady()) return sendJson(response, { error: '先に顔の動きを読み取る準備をしてください。' }, 404);
        file = faceModelFile;
      } else if (url.pathname.startsWith('/api/face-assets/')) {
        file = assets.get(url.pathname.slice('/api/face-assets/'.length));
        if (!file) return sendJson(response, { error: 'File not found.' }, 404);
      } else return next();
      response.setHeader('Content-Type', file.endsWith('.wasm') ? 'application/wasm' : file.endsWith('.task') ? 'application/octet-stream' : 'text/javascript');
      response.setHeader('Cache-Control', 'no-store');
      response.setHeader('Content-Length', String(fs.statSync(file).size));
      if (request.method === 'HEAD') return response.end();
      fs.createReadStream(file).pipe(response);
    } catch {
      sendJson(response, { error: '準備できませんでした。接続を確認して、もう一度お試しください。' }, 500);
    }
  };
  return {
    name: 'still2rig-face-assets',
    configureServer(server) { server.middlewares.use((...args) => { void middleware(...args); }); },
    configurePreviewServer(server) { server.middlewares.use((...args) => { void middleware(...args); }); },
  };
}

const liveRelay = liveRelayPlugin({ listPsds: listGeneratedPsds, trusted: isTrustedActionRequest, sendJson });
export default defineConfig({
  // All app APIs are local/same-origin; let protected endpoints reject OPTIONS themselves.
  server: { cors: false },
  preview: { cors: false },
  plugins: [generatedPsdPlugin(), faceAssetsPlugin(), liveRelay, expressionRemotePlugin({
    listPsds: listGeneratedPsds, trusted: isTrustedActionRequest, sendJson,
    tokenFile: path.join(repositoryRoot, '.still2rig-psd', 'expression-token'),
    activeSource: psd => liveRelay.activeSource(psd),
  })],
  build: { rolldownOptions: { input: { main: path.join(import.meta.dirname, 'index.html'), stream: path.join(import.meta.dirname, 'stream.html') } } },
});
