import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import path from 'node:path';
import { PROJECT_ROOT } from '../src/utils.mjs';

test('landmark split rules use synthetic geometry, colours and protected compositing', () => {
  const result = spawnSync('python3', [path.join(PROJECT_ROOT, 'test', 'split_rules.py')], { cwd: PROJECT_ROOT, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
