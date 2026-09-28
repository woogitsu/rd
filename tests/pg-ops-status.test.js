// GET /api/admin/ops-status (issue #149). Wyłącznie dane syntetyczne.
import test from 'node:test';
import assert from 'node:assert/strict';
import { handlePgRequest } from '../src/pg/app.js';
import { createTestDb, request, seedUser, seedUserSession } from './helpers/pg.js';

async function call(env, path, { cookie, method = 'GET' } = {}) {
  const response = await handlePgRequest(request(path, { method, cookie }), env);
  const text = await response.text();
  return { status: response.status, data: text ? JSON.parse(text) : null, headers: response.headers };
}

test('ops-status: 401 anonymous, 403 for every non-admin role, 200 for admin with MFA', async () => {
  const db = await createTestDb();
  try {
    const env = { db };
    assert.equal((await call(env, '/api/admin/ops-status')).status, 401);

    for (const role of ['board', 'treasurer', 'audit', 'principal']) {
      const cookie = await seedUserSession(db, { userId: `u-${role}`, roles: [{ role }], mfa: true });
      assert.equal((await call(env, '/api/admin/ops-status', { cookie })).status, 403, `role ${role} must not see ops-status`);
    }
    const rep = await seedUserSession(db, {
      userId: 'u-rep-multi',
      roles: [
        { role: 'representative', classId: 'c-1a', schoolYearId: 'y-test' },
        { role: 'representative', classId: 'c-2b', schoolYearId: 'y-test' },
      ],
      mfa: true,
    });
    assert.equal((await call(env, '/api/admin/ops-status', { cookie: rep })).status, 403);

    const expiredAdmin = await seedUserSession(db, {
      userId: 'u-admin-expired', roles: [{ role: 'admin', expiresAt: '2020-01-01T00:00:00Z' }], mfa: true,
    });
    assert.equal((await call(env, '/api/admin/ops-status', { cookie: expiredAdmin })).status, 403);

    const admin = await seedUserSession(db, { userId: 'u-admin', roles: [{ role: 'admin' }], mfa: true });
    const res = await call(env, '/api/admin/ops-status', { cookie: admin });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'no-store');
  } finally {
    await db.close();
  }
});

test('ops-status: no personal data or secrets in the response (synthetic seed scan)', async () => {
  const db = await createTestDb();
  try {
    const env = { db };
    await seedUser(db, { userId: 'u-jan', email: 'jan.kowalski@example.invalid', displayName: 'Jan Kowalski' });
    const admin = await seedUserSession(db, { userId: 'u-admin', roles: [{ role: 'admin' }], mfa: true });
    const res = await call(env, '/api/admin/ops-status', { cookie: admin });
    const text = JSON.stringify(res.data);
    assert.doesNotMatch(text, /@/);
    assert.doesNotMatch(text, /Kowalski|Jan/);
    assert.doesNotMatch(text, /[A-Z]{2}\d{2}[A-Z0-9]{4,30}/, 'looks like an IBAN');
  } finally {
    await db.close();
  }
});

test('ops-status: missing backup log on a fresh database reports no_data, not ok', async () => {
  const db = await createTestDb();
  try {
    const env = { db };
    const admin = await seedUserSession(db, { userId: 'u-admin', roles: [{ role: 'admin' }], mfa: true });
    const res = await call(env, '/api/admin/ops-status', { cookie: admin });
    assert.equal(res.data.backup.status, 'no_data');
    assert.equal(res.data.storageBackup.status, 'no_data');
    // createTestDb (tests/helpers/pg.js) nakłada SQL migracji bezpośrednio
    // (db.exec), bez migratora — schema_migrations więc tu nie istnieje;
    // to musi zostać "brak danych", nie fałszywe 0 ani wyjątek.
    assert.equal(res.data.migrations.pendingCount, null);
  } finally {
    await db.close();
  }
});

test('ops-status: worker run with retries after a failure is shown once, no duplicates', async () => {
  const db = await createTestDb();
  try {
    const env = { db };
    const admin = await seedUserSession(db, { userId: 'u-admin', roles: [{ role: 'admin' }], mfa: true });
    const day = '2026-09-27';
    await db.query(
      `INSERT INTO email_worker_runs (id, mode, day, started_at, remaining_quota, planned, sent, retried, failed, stopped_reason)
       VALUES ('run-1', 'live', $1, now() - interval '2 hours', 100, 5, 3, 1, 1, NULL)`,
      [day],
    );
    const res = await call(env, '/api/admin/ops-status', { cookie: admin });
    assert.equal(res.data.emailWorker.retried, 1);
    assert.equal(res.data.emailWorker.failed, 1);
  } finally {
    await db.close();
  }
});
