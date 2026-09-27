// Krótki wariant testu wydajności (5 wirtualnych użytkowników, 3 s) na PGlite
// w procesie i danych syntetycznych, oraz bezpieczniki trybu zdalnego.
// Pełny przebieg: `npm run load:test` (docs/RAILWAY_OPERATIONS.md).
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  checkThresholds, DEFAULT_THRESHOLDS, loadTest, parseArgs, percentile, remoteActorsFromEnv, UsageError,
  validateRemoteTarget,
} from '../scripts/load-test.js';

const script = fileURLToPath(new URL('../scripts/load-test.js', import.meta.url));
const stagingEnv = { LOAD_TEST_ALLOWED_HOSTS: 'rd-staging.example.test, other.example.test', APP_ENV: 'staging' };

test('remote target is refused without explicit staging confirmation and allow-list', () => {
  const target = 'https://rd-staging.example.test';
  assert.throws(() => validateRemoteTarget(target, { env: stagingEnv }), /--i-confirm-staging/);
  assert.throws(() => validateRemoteTarget(target, { confirmStaging: true, env: {} }), /LOAD_TEST_ALLOWED_HOSTS/);
  assert.throws(() => validateRemoteTarget(target, { confirmStaging: true, env: { ...stagingEnv, APP_ENV: 'production' } }), /production/);
  assert.throws(() => validateRemoteTarget(target, { confirmStaging: true, env: { ...stagingEnv, APP_ENV: ' Production ' } }), /production/);
  assert.throws(() => validateRemoteTarget('http://rd-staging.example.test', { confirmStaging: true, env: stagingEnv }), /https/);
  assert.throws(() => validateRemoteTarget('https://rd-prod.example.test', { confirmStaging: true, env: stagingEnv }), /not listed/);
  // Brak dopasowania po sufiksie ani prefiksie.
  assert.throws(() => validateRemoteTarget('https://evil.rd-staging.example.test', { confirmStaging: true, env: stagingEnv }), /not listed/);
  assert.throws(() => validateRemoteTarget('https://u:p@rd-staging.example.test', { confirmStaging: true, env: stagingEnv }), /credentials/);
  assert.throws(() => validateRemoteTarget('not a url', { confirmStaging: true, env: stagingEnv }), UsageError);
  assert.equal(validateRemoteTarget('https://RD-staging.example.test/any/path', { confirmStaging: true, env: stagingEnv }),
    'https://rd-staging.example.test');
});

test('remote sessions come only from documented env names', () => {
  assert.throws(() => remoteActorsFromEnv({ LOAD_TEST_SESSION_BOARD: 'x' }), /LOAD_TEST_SCHOOL_YEAR_ID/);
  assert.throws(() => remoteActorsFromEnv({ LOAD_TEST_SCHOOL_YEAR_ID: 'y-test' }), /LOAD_TEST_SESSION_/);
  const { actors, schoolYearId } = remoteActorsFromEnv({
    LOAD_TEST_SCHOOL_YEAR_ID: 'y-test', LOAD_TEST_SESSION_TREASURER: 'abc', LOAD_TEST_SESSION_BOARD: 'rd_session=def',
  });
  assert.equal(schoolYearId, 'y-test');
  assert.deepEqual(actors.map((a) => [a.role, a.cookie]).sort(), [['board', 'rd_session=def'], ['treasurer', 'rd_session=abc']]);
});

test('CLI refuses a remote target without confirmation (exit 2, no requests)', () => {
  const result = spawnSync(process.execPath, [script, '--target', 'https://rd-staging.example.test', '--duration', '1'], {
    env: { PATH: process.env.PATH, ...stagingEnv }, encoding: 'utf8', timeout: 20_000,
  });
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /refused: .*--i-confirm-staging/);
  assert.equal(result.stdout, '');
});

test('arguments, percentiles and thresholds', () => {
  const options = parseArgs(['--users', '5', '--duration=3', '--p95-ms', '250', '--max-error-rate', '0', '--read-only']);
  assert.equal(options.users, 5);
  assert.equal(options.durationSec, 3);
  assert.equal(options.allowWrites, false);
  assert.deepEqual(options.thresholds, { ...DEFAULT_THRESHOLDS, p95Ms: 250, maxErrorRate: 0 });
  assert.throws(() => parseArgs(['--users', '0']), UsageError);
  assert.throws(() => parseArgs(['--bogus']), UsageError);

  const sorted = Array.from({ length: 100 }, (_, i) => i + 1);
  assert.equal(percentile(sorted, 50), 50);
  assert.equal(percentile(sorted, 95), 95);
  assert.equal(percentile(sorted, 99), 99);
  assert.equal(percentile([], 95), 0);

  const ok = { requests: 10, errorRate: 0, throughputRps: 10, latencyMs: { p95: 100, p99: 200 } };
  assert.deepEqual(checkThresholds(ok, DEFAULT_THRESHOLDS), []);
  const bad = { requests: 10, errorRate: 0.5, throughputRps: 1, latencyMs: { p95: 5000, p99: 9000 } };
  assert.equal(checkThresholds(bad, { ...DEFAULT_THRESHOLDS, minRps: 5 }).length, 4);
});

test('smoke load: 5 virtual users for 3 s on PGlite with 1000/2000/50 synthetic dataset', { timeout: 60_000 }, async () => {
  const report = await loadTest({
    users: 5, durationSec: 3, thinkMs: 0, timeoutMs: 10_000, target: null, allowWrites: null,
    // Współdzielony runner CI: progi luźne, liczy się brak błędów i kompletność raportu.
    thresholds: { p95Ms: 5000, p99Ms: 10_000, maxErrorRate: 0, minRps: 1 },
  });
  assert.equal(report.mode, 'local');
  assert.match(report.target, /not representative/);
  assert.deepEqual(report.dataset, { students: 1000, guardians: 2000, users: 50 });
  assert.deepEqual(report.rolesCovered, ['admin', 'board', 'representative', 'treasurer']);
  assert.equal(report.writes, true);
  assert.ok(report.requests > 20, `only ${report.requests} requests`);
  assert.equal(report.errors, 0, JSON.stringify(report.errorSamples));
  assert.deepEqual(report.breaches, []);
  assert.equal(report.passed, true);
  for (const key of ['p50', 'p95', 'p99', 'max', 'mean']) assert.equal(typeof report.latencyMs[key], 'number');
  assert.ok(report.latencyMs.p50 <= report.latencyMs.p95 && report.latencyMs.p95 <= report.latencyMs.p99);
  assert.ok(report.throughputRps > 0);
  assert.ok(report.byOperation['GET /api/session']?.requests > 0);
  assert.ok(report.byOperation['GET /api/public/events']?.requests > 0);
  // Żadna odpowiedź 5xx ani błąd sieci.
  assert.ok(Object.keys(report.statusCounts).every((status) => /^[234]\d\d$/.test(status)), JSON.stringify(report.statusCounts));
});
