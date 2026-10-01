// Kursor keyset dla rejestrów wniosków o role chronione i reset kont (#159):
// GET /api/admin/account-requests i /api/admin/grant-requests. Wyłącznie dane syntetyczne.

import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { handlePgRequest } from '../src/pg/app.js';
import { createTestDb, request, seedSchoolYear, seedUserSession } from './helpers/pg.js';
import { assertEvery } from './helpers/assertions.js';

const YEAR = 'y-req';
const TOTAL = 430;
let db;
let env;
let admin;
let board;

async function call(path, cookie = admin) {
  const response = await handlePgRequest(request(path, { cookie }), env);
  const text = await response.text();
  return { status: response.status, data: text ? JSON.parse(text) : null };
}

async function walk(path, { limit } = {}) {
  const ids = [];
  let cursor = null;
  let pages = 0;
  do {
    const query = new URLSearchParams();
    if (limit) query.set('limit', String(limit));
    if (cursor) query.set('cursor', cursor);
    const res = await call(`${path}${path.includes('?') ? '&' : '?'}${query}`);
    assert.equal(res.status, 200, JSON.stringify(res.data));
    ids.push(...res.data.requests.map((item) => item.id));
    assert.equal(res.data.truncated, res.data.nextCursor !== null);
    cursor = res.data.nextCursor;
    pages += 1;
    assert.ok(pages < 100);
  } while (cursor);
  return { ids, pages };
}

before(async () => {
  db = await createTestDb();
  env = { db };
  await seedSchoolYear(db, YEAR);
  admin = await seedUserSession(db, { userId: 'u-admin', roles: [{ role: 'admin' }], mfa: true });
  await seedUserSession(db, { userId: 'u-admin2', roles: [{ role: 'admin' }], mfa: true });
  await seedUserSession(db, { userId: 'u-target', roles: [{ role: 'board', schoolYearId: YEAR }], mfa: true });
  board = await seedUserSession(db, { userId: 'u-board', roles: [{ role: 'board', schoolYearId: YEAR }], mfa: true });
  // Wnioski rozstrzygnięte (brak ograniczenia „jeden otwarty”), remisy created_at po 6 wierszy.
  await db.query(
    `INSERT INTO account_recovery_requests (id, kind, target_user_id, requested_by, status, created_at, expires_at, decided_by, decided_at)
     SELECT 'ar-' || lpad(i::text, 4, '0'), CASE WHEN i % 2 = 0 THEN 'mfa_reset' ELSE 'password_reset' END, 'u-target', 'u-admin',
            CASE WHEN i % 4 = 0 THEN 'approved' ELSE 'rejected' END,
            timestamptz '2026-01-01 00:00:00+00' + (i / 6) * interval '1 second',
            timestamptz '2027-01-01 00:00:00+00', 'u-admin2', timestamptz '2026-06-01 00:00:00+00'
       FROM generate_series(1, ${TOTAL}) i`,
  );
  await db.query(
    `INSERT INTO role_grant_requests (id, kind, role, target_user_id, school_year_id, requested_by, status, created_at, expires_at, decided_by, decided_at)
     SELECT 'gr-' || lpad(i::text, 4, '0'), 'grant', 'board', 'u-target', '${YEAR}', 'u-admin', 'rejected',
            timestamptz '2026-01-01 00:00:00+00' + (i / 6) * interval '1 second',
            timestamptz '2027-01-01 00:00:00+00', 'u-admin2', timestamptz '2026-06-01 00:00:00+00'
       FROM generate_series(1, ${TOTAL}) i`,
  );
});
after(async () => { await db?.close(); });

const LISTS = [
  { name: 'wnioski o reset konta', path: '/api/admin/account-requests', table: 'account_recovery_requests' },
  { name: 'wnioski o rolę chronioną', path: '/api/admin/grant-requests', table: 'role_grant_requests' },
];

for (const { name, path, table } of LISTS) {
  test(`${name}: >200 wierszy — jawne obcięcie i wszystkie strony bez luk i duplikatów`, async () => {
    const expected = (await db.query(`SELECT id FROM ${table} WHERE status = 'rejected' ORDER BY created_at DESC, id`)).rows.map((r) => r.id);
    assert.ok(expected.length > 200);
    const first = await call(`${path}?status=rejected`);
    assert.equal(first.status, 200);
    assert.equal(first.data.requests.length, 200);
    assert.equal(first.data.truncated, true);
    assert.ok(first.data.nextCursor);
    for (const limit of [undefined, 37]) {
      const { ids } = await walk(`${path}?status=rejected`, { limit });
      assert.deepEqual(ids, expected);
    }
    const all = (await db.query(`SELECT id FROM ${table} ORDER BY created_at DESC, id`)).rows.map((r) => r.id);
    const { ids: walkedAll } = await walk(`${path}?status=all`, { limit: 90 });
    assert.deepEqual(walkedAll, all);
    assert.equal(new Set(walkedAll).size, walkedAll.length);
  });

  test(`${name}: podwójne kliknięcie na tym samym kursorze daje tę samą stronę`, async () => {
    const first = await call(`${path}?status=rejected&limit=50`);
    const a = await call(`${path}?status=rejected&limit=50&cursor=${first.data.nextCursor}`);
    const b = await call(`${path}?status=rejected&limit=50&cursor=${first.data.nextCursor}`);
    assert.deepEqual(a.data.requests, b.data.requests);
    assert.equal(a.data.requests.length, 50);
    const firstIds = new Set(first.data.requests.map((item) => item.id));
    assertEvery(a.data.requests, (item) => !firstIds.has(item.id), 'kolejna strona nie powtarza poprzedniej');
  });

  test(`${name}: zły kursor, kursor innego filtra, zły limit — 400`, async () => {
    const page = await call(`${path}?status=rejected&limit=10`);
    for (const bad of ['%%%', 'abc', Buffer.from('[1]').toString('base64url')]) {
      const res = await call(`${path}?status=rejected&cursor=${bad}`);
      assert.deepEqual([res.status, res.data.error], [400, 'invalid_cursor'], bad);
    }
    const other = await call(`${path}?status=all&limit=10&cursor=${page.data.nextCursor}`);
    assert.deepEqual([other.status, other.data.error], [400, 'invalid_cursor']);
    for (const limit of ['0', '201', 'abc', '-1']) {
      const res = await call(`${path}?status=rejected&limit=${limit}`);
      assert.deepEqual([res.status, res.data.error], [400, 'invalid_limit'], limit);
    }
    assert.equal((await call(`${path}?status=bogus`)).data.error, 'invalid_status');
  });

  test(`${name}: granice ról bez zmian`, async () => {
    assert.equal((await call(path, null)).status, 401);
    assert.equal((await call(`${path}?status=rejected&limit=10`, board)).status, 403);
  });
}
