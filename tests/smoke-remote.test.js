// scripts/smoke-remote.js — bezpieczniki jak w scripts/load-test.js (issue #119).
// Testujemy tylko odmowy PRZED pierwszym żądaniem: żaden test nie może wysłać
// prawdziwego żądania sieciowego (AGENTS.md).
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs, smokeRemote } from '../scripts/smoke-remote.js';
import { UsageError } from '../scripts/load-test.js';

const script = fileURLToPath(new URL('../scripts/smoke-remote.js', import.meta.url));
const stagingEnv = { LOAD_TEST_ALLOWED_HOSTS: 'rd-staging.example.test', APP_ENV: 'staging' };

test('parseArgs requires --target and rejects unknown flags', () => {
  assert.throws(() => parseArgs([]), /--target is required/);
  assert.throws(() => parseArgs(['--target', 'https://x', '--bogus']), UsageError);
  const options = parseArgs(['--target=https://rd-staging.example.test', '--i-confirm-staging']);
  assert.equal(options.target, 'https://rd-staging.example.test');
  assert.equal(options.confirmStaging, true);
});

test('smokeRemote refuses before the first request: no confirmation', async () => {
  await assert.rejects(
    () => smokeRemote({ target: 'https://rd-staging.example.test', timeoutMs: 1000 }, { env: stagingEnv }),
    /--i-confirm-staging/,
  );
});

test('smokeRemote refuses before the first request: host outside the allow-list', async () => {
  await assert.rejects(
    () => smokeRemote({ target: 'https://rd-prod.example.test', confirmStaging: true, timeoutMs: 1000 }, { env: stagingEnv }),
    /not listed/,
  );
});

test('smokeRemote refuses before the first request: APP_ENV=production', async () => {
  await assert.rejects(
    () => smokeRemote({ target: 'https://rd-staging.example.test', confirmStaging: true, timeoutMs: 1000 },
      { env: { ...stagingEnv, APP_ENV: 'production' } }),
    /production/,
  );
});

test('smokeRemote refuses before the first request: http:// target', async () => {
  await assert.rejects(
    () => smokeRemote({ target: 'http://rd-staging.example.test', confirmStaging: true, timeoutMs: 1000 }, { env: stagingEnv }),
    /https/,
  );
});

test('CLI refuses a remote target without confirmation (exit 2, nothing printed)', () => {
  const result = spawnSync(process.execPath, [script, '--target', 'https://rd-staging.example.test'], {
    env: { PATH: process.env.PATH, ...stagingEnv }, encoding: 'utf8', timeout: 20_000,
  });
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /refused: .*--i-confirm-staging/);
  assert.equal(result.stdout, '');
});
