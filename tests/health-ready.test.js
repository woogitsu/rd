import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { checkReadiness } from '../src/health.js';
import { createLogger } from '../src/log.js';
import { createNodeHandler } from '../src/node-app.js';
import { applyMigrations, loadMigrations } from '../src/postgres-migrations.js';
import { pgliteClient } from '../scripts/smoke-postgres.js';

const migrationsDir = fileURLToPath(new URL('../postgres/migrations/', import.meta.url));
const migrations = await loadMigrations(migrationsDir);
const names = migrations.map((migration) => migration.name);

function quietLogger() {
  const lines = [];
  return { logger: createLogger({ level: 'debug', sink: (line) => lines.push(line) }), lines };
}

// Jedna instancja PGlite na plik (oszczędność pamięci); testy przywracają stan.
let shared;
async function migratedDb() {
  if (!shared) {
    shared = new PGlite();
    await applyMigrations(pgliteClient(shared), migrations);
  }
  return shared;
}
test.after(async () => { await shared?.close(); });

async function withHttp(env, fn) {
  const root = await mkdtemp(join(tmpdir(), 'rd-ready-'));
  const { logger, lines } = quietLogger();
  const readiness = (e) => checkReadiness(e, { logger, timeoutMs: 500 });
  const server = createServer(createNodeHandler({ distRoot: root, env, logger, readiness, fetchHandler: async () => Response.json({ status: 'ok' }) }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    await fn(`http://127.0.0.1:${server.address().port}`, lines);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
}

test('ready when the database answers and every repository migration is applied', async () => {
  const db = await migratedDb();
  const { logger } = quietLogger();
  const result = await checkReadiness({ db }, { logger });
  assert.equal(result.ready, true);
  assert.deepEqual(result.body, {
    status: 'ready',
    checks: { database: 'ok', migrations: 'ok' },
    migrations: { expected: names.length, applied: names.length },
  });
  await withHttp({ db }, async (base) => {
    const response = await fetch(`${base}/health/ready`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal((await response.json()).status, 'ready');
    const head = await fetch(`${base}/health/ready`, { method: 'HEAD' });
    assert.equal(head.status, 200);
    // Liveness bez zmian: delegowane do routera, niezależne od bazy.
    const live = await fetch(`${base}/health`);
    assert.deepEqual([live.status, await live.json()], [200, { status: 'ok' }]);
  });
});

test('503 with only the count and names of missing migrations', async () => {
  const db = await migratedDb();
  try {
    const last = names.at(-1);
    await db.query('DELETE FROM schema_migrations WHERE name = $1', [last]);
    const { logger, lines } = quietLogger();
    const result = await checkReadiness({ db }, { logger });
    assert.equal(result.ready, false);
    assert.deepEqual(result.body, {
      status: 'not_ready',
      checks: { database: 'ok', migrations: 'pending' },
      migrations: { expected: names.length, applied: names.length - 1, missing_count: 1, missing: [last] },
    });
    assert.equal(JSON.parse(lines[0]).event, 'readiness_migrations_pending');
    await withHttp({ db }, async (base) => {
      const response = await fetch(`${base}/health/ready`);
      assert.equal(response.status, 503);
      assert.equal((await response.json()).migrations.missing_count, 1);
    });
  } finally {
    const restored = migrations.at(-1);
    await db.query('INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2) ON CONFLICT DO NOTHING', [restored.name, restored.checksum]);
  }
});

test('503 when schema_migrations does not exist yet (fresh database)', async () => {
  const db = await migratedDb();
  await db.query('ALTER TABLE schema_migrations RENAME TO schema_migrations_hidden');
  try {
    const result = await checkReadiness({ db }, { logger: quietLogger().logger });
    assert.equal(result.ready, false);
    assert.equal(result.body.migrations.missing_count, names.length);
    assert.deepEqual(result.body.migrations.missing, names);
  } finally {
    await db.query('ALTER TABLE schema_migrations_hidden RENAME TO schema_migrations');
  }
  assert.equal((await checkReadiness({ db }, { logger: quietLogger().logger })).ready, true);
});

test('503 without leaking error details when the database throws or hangs', async () => {
  const leaky = Object.assign(new Error('connect ECONNREFUSED postgres://user:secret@db.railway.internal rodzic@example.invalid'), { code: 'ECONNREFUSED' });
  const failing = { query: async () => { throw leaky; } };
  const { logger, lines } = quietLogger();
  const result = await checkReadiness({ db: failing }, { logger });
  assert.deepEqual(result, { ready: false, body: { status: 'not_ready', checks: { database: 'error' } } });
  assert.doesNotMatch(lines.join('\n'), /secret|@|postgres:/);
  assert.equal(JSON.parse(lines[0]).code, 'ECONNREFUSED');

  const hanging = { query: () => new Promise(() => {}) };
  const timedOut = await checkReadiness({ db: hanging }, { logger, timeoutMs: 20 });
  assert.deepEqual(timedOut.body, { status: 'not_ready', checks: { database: 'timeout' } });

  await withHttp({ db: failing }, async (base) => {
    const response = await fetch(`${base}/health/ready`);
    assert.equal(response.status, 503);
    const text = await response.text();
    assert.doesNotMatch(text, /secret|ECONNREFUSED|@/);
  });
});

test('503 not_configured when no database is attached', async () => {
  const result = await checkReadiness({}, { logger: quietLogger().logger });
  assert.deepEqual(result, { ready: false, body: { status: 'not_ready', checks: { database: 'not_configured' } } });
});

test('request log contains method, sanitized path, status and duration — no query string', async () => {
  await withHttp({}, async (base, lines) => {
    await fetch(`${base}/api/payments/123?email=rodzic@example.invalid`, { headers: { cookie: 'rd_session=Zx81kQ2m' } });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const entry = lines.map((line) => JSON.parse(line)).find((item) => item.event === 'http_request' && item.path.startsWith('/api/'));
    assert.equal(entry.method, 'GET');
    assert.equal(entry.path, '/api/payments/:id');
    assert.equal(entry.status, 200);
    assert.equal(typeof entry.duration_ms, 'number');
    assert.doesNotMatch(lines.join('\n'), /@|rd_session|email|payments\/123/);
  });
});
