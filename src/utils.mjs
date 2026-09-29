import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const STATE_ROOT = path.join(PROJECT_ROOT, '.still2rig-psd');
export const JOBS_ROOT = path.join(STATE_ROOT, 'jobs');

export function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

export function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, file);
}

export function sha256File(file) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(file));
  return hash.digest('hex');
}

export function safeSlug(value) {
  const slug = value
    .normalize('NFKD')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^[._-]+|[._-]+$/g, '')
    .toLowerCase();
  if (!slug || slug === '.' || slug === '..') throw new Error('The job name does not contain a safe identifier.');
  return slug.slice(0, 80);
}

export function assertJobId(value) {
  if (!/^[a-z0-9][a-z0-9._-]{0,79}$/.test(value)) {
    throw new Error(`Invalid job id: ${value}`);
  }
  return value;
}

export function jobRoot(jobId) {
  assertJobId(jobId);
  const resolved = path.resolve(JOBS_ROOT, jobId);
  if (path.dirname(resolved) !== path.resolve(JOBS_ROOT)) throw new Error('Job path escaped the state directory.');
  return resolved;
}

export function relativeProjectPath(file) {
  const rel = path.relative(PROJECT_ROOT, path.resolve(file));
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('Path is outside the project.');
  return rel.split(path.sep).join('/');
}

export function loadDefaults() {
  return readJson(path.join(PROJECT_ROOT, 'configs', 'default.json'));
}

export function loadLayerMap() {
  return readJson(path.join(PROJECT_ROOT, 'configs', 'layer-map.json'));
}

export function timestampId() {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'z').replace('T', '-');
}

export function parseOptions(argv) {
  const positional = [];
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) {
      positional.push(token);
      continue;
    }
    const key = token.slice(2);
    if (['preview-placeholders', 'json', 'negative-fixture'].includes(key)) {
      options[key] = true;
      continue;
    }
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for --${key}`);
    options[key] = value;
    index += 1;
  }
  return { positional, options };
}
