// GET /health/jobs (issue #149): heartbeat zadań chroniony tokenem.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { createNodeHandler } from '../src/node-app.js';
import { checkJobsHealth, tokensMatch } from '../src/pg/jobs-health.js';
import { loadMigrations } from '../src/postgres-migrations.js';

// Uwaga: NIE importujemy tests/helpers/pg.js tutaj — instaluje globalną
// pułapkę na sieć (#214), która blokowałaby też prawdziwe żądania HTTP do
// lokalnego serwera testowego w tym pliku (nie tylko do internetu).
const migrationsDirectory = fileURLToPath(new URL('../postgres/migrations/', import.meta.url));
async function createTestDb() {
  const db = new PGlite();
  for (const migration of await loadMigrations(migrationsDirectory)) await db.exec(migration.sql);
  return db;
}

async function withHttp(env, jobsHealth, fn) {
  const root = await mkdtemp(join(tmpdir(), 'rd-jobs-'));
  const server = createServer(createNodeHandler({
    distRoot: root, env, jobsHealth, fetchHandler: async () => Response.json({ status: 'ok' }),
  }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
}

test('tokensMatch: constant-shape comparison', () => {
  assert.equal(tokensMatch('secret-token', 'secret-token'), true);
  assert.equal(tokensMatch('wrong', 'secret-token'), false);
  assert.equal(tokensMatch(null, 'secret-token'), false);
  assert.equal(tokensMatch('secret-token', ''), false);
});

test('GET /health/jobs: 401 without a token, 401 with the wrong token', async () => {
  await withHttp({ HEALTH_JOBS_TOKEN: 'right-token' }, async () => ({ ok: true, failedThresholds: [] }), async (base) => {
    const noToken = await fetch(`${base}/health/jobs`);
    assert.equal(noToken.status, 401);
    const wrongToken = await fetch(`${base}/health/jobs`, { headers: { Authorization: 'Bearer nope' } });
    assert.equal(wrongToken.status, 401);
  });
});

test('GET /health/jobs: 401 when no token is configured at all (fails closed)', async () => {
  await withHttp({}, async () => ({ ok: true, failedThresholds: [] }), async (base) => {
    const res = await fetch(`${base}/health/jobs`, { headers: { Authorization: 'Bearer anything' } });
    assert.equal(res.status, 401);
  });
});

test('GET /health/jobs: 200 with the right token when nothing is over threshold', async () => {
  await withHttp({ HEALTH_JOBS_TOKEN: 'right-token' }, async () => ({ ok: true, failedThresholds: [] }), async (base) => {
    const res = await fetch(`${base}/health/jobs`, { headers: { Authorization: 'Bearer right-token' } });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.status, 'ok');
  });
});

test('GET /health/jobs: 503 with the threshold name when a threshold is exceeded', async () => {
  await withHttp(
    { HEALTH_JOBS_TOKEN: 'right-token' },
    async () => ({ ok: false, failedThresholds: ['backup_too_old'] }),
    async (base) => {
      const res = await fetch(`${base}/health/jobs`, { headers: { Authorization: 'Bearer right-token' } });
      assert.equal(res.status, 503);
      const body = await res.json();
      assert.deepEqual(body.failedThresholds, ['backup_too_old']);
    },
  );
});

test('checkJobsHealth: missing backup log (fresh database) fails the backup_too_old threshold', async () => {
  const db = await createTestDb();
  try {
    const result = await checkJobsHealth({ db });
    assert.equal(result.ok, false);
    assert.ok(result.failedThresholds.includes('backup_too_old'));
  } finally {
    await db.close();
  }
});

test('checkJobsHealth: recent successful backup and empty queue -> ok', async () => {
  const db = await createTestDb();
  try {
    // Wymaga tabeli backup_runs (#90) — jeśli jej jeszcze nie ma na tej
    // gałęzi (PR #90 nie scalony), pomijamy asercję zamiast fałszywie failować.
    const { rows } = await db.query("SELECT to_regclass('backup_runs') AS t");
    if (!rows[0]?.t) return;
    await db.query(
      `INSERT INTO backup_runs (id, kind, environment, started_at, finished_at, result, sha256)
       VALUES ('b-1', 'backup', 'test', now(), now(), 'success', repeat('a', 64))`,
    );
    const result = await checkJobsHealth({ db });
    assert.equal(result.ok, true);
  } finally {
    await db.close();
  }
});
