// Kursor keyset dla GET /api/news-photos i GET /api/meetings/public-notices (#159).
// Wyłącznie dane syntetyczne (domeny .invalid).

import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { handlePgRequest } from '../src/pg/app.js';
import { createTestDb, request, seedDocument, seedSchoolYear, seedUserSession } from './helpers/pg.js';

const YEAR = 'y-pl';
const NOTICES = 230;
const PHOTOS = 230;
let db;
let env;
let admin;
let rep;

async function call(path, cookie) {
  const response = await handlePgRequest(request(path, cookie ? { cookie } : {}), env);
  const text = await response.text();
  return { status: response.status, data: text ? JSON.parse(text) : null };
}

async function walk(path, key, { limit, cookie } = {}) {
  const ids = [];
  let cursor = null;
  let pages = 0;
  do {
    const query = new URLSearchParams();
    if (limit) query.set('limit', String(limit));
    if (cursor) query.set('cursor', cursor);
    const res = await call(`${path}${path.includes('?') ? '&' : '?'}${query}`, cookie);
    assert.equal(res.status, 200, JSON.stringify(res.data));
    ids.push(...res.data[key].map((item) => item.id));
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
  admin = await seedUserSession(db, { userId: 'u-adm', roles: [{ role: 'admin' }], mfa: true });
  await seedUserSession(db, { userId: 'u-appr', roles: [{ role: 'board', schoolYearId: YEAR }], mfa: true });
  rep = await seedUserSession(db, { userId: 'u-rep', roles: [{ role: 'representative', classId: 'c-x', schoolYearId: YEAR }] });
  await db.query(
    `INSERT INTO meetings (id, school_year_id, kind, title, scheduled_at, status, created_by)
     SELECT 'pm-' || lpad(i::text, 4, '0'), '${YEAR}', 'plenary', 'Zebranie ogólne', now() + interval '30 day', 'scheduled', 'u-adm'
       FROM generate_series(1, ${NOTICES}) i`,
  );
  await db.query(
    `INSERT INTO meeting_agenda_versions (id, meeting_id, school_year_id, version, snapshot, content_hash, created_by)
     SELECT 'pa-' || lpad(i::text, 4, '0'), 'pm-' || lpad(i::text, 4, '0'), '${YEAR}', 1,
            '[{"position":1,"title":"Punkt testowy"}]'::jsonb, repeat('c', 64), 'u-adm'
       FROM generate_series(1, ${NOTICES}) i`,
  );
  // Co trzecie zawiadomienie ma ten sam termin — remis rozstrzyga id.
  await db.query(
    `INSERT INTO meeting_notices (id, meeting_id, school_year_id, version, kind, title, scheduled_at, agenda_version_id, content_hash, created_by)
     SELECT 'pn-' || lpad(i::text, 4, '0'), 'pm-' || lpad(i::text, 4, '0'), '${YEAR}', 1, 'invitation', 'Zawiadomienie testowe',
            timestamptz '2027-03-01 17:00+00' + ((i / 3) * interval '1 day'), 'pa-' || lpad(i::text, 4, '0'), repeat('a', 64), 'u-adm'
       FROM generate_series(1, ${NOTICES}) i`,
  );
  await db.query(
    `UPDATE meeting_notices SET status = 'approved', approved_by = 'u-appr', approved_at = now(), notice_days_before = 14`,
  );
  // Zebranie w szkicu nie może trafić do widoku publicznego.
  await db.query(
    `INSERT INTO meetings (id, school_year_id, kind, title, scheduled_at, status, created_by)
     VALUES ('pm-draft', '${YEAR}', 'plenary', 'Zebranie szkic', now() + interval '40 day', 'draft', 'u-adm')`,
  );
  await db.query(
    `INSERT INTO meeting_agenda_versions (id, meeting_id, school_year_id, version, snapshot, content_hash, created_by)
     VALUES ('pa-draft', 'pm-draft', '${YEAR}', 1, '[]'::jsonb, repeat('d', 64), 'u-adm')`,
  );
  await db.query(
    `INSERT INTO meeting_notices (id, meeting_id, school_year_id, version, kind, title, scheduled_at, agenda_version_id, content_hash, created_by)
     VALUES ('pn-draft', 'pm-draft', '${YEAR}', 1, 'invitation', 'Zawiadomienie szkic', now() + interval '40 day', 'pa-draft', repeat('b', 64), 'u-adm')`,
  );
  await seedDocument(db, { id: 'doc-pl', createdBy: 'u-adm' });
  // Co czwarte zdjęcie ma ten sam czas wysłania — remis rozstrzyga id.
  await db.query(
    `INSERT INTO news_photos (id, document_id, author, source, taken_on, license_text, depicts_children, alt_text, uploaded_by, uploaded_at)
     SELECT 'ph-' || lpad(i::text, 4, '0'), 'doc-pl', 'Autor Testowy', 'own_work', DATE '2026-05-01',
            'Zdjęcie własne autora, zgoda na publikację', false, 'Opis zastępczy testowy', 'u-adm',
            timestamptz '2026-06-01 09:00+00' + ((i / 4) * interval '1 minute')
       FROM generate_series(1, ${PHOTOS}) i`,
  );
});

after(async () => { await db?.close?.(); });

test('zawiadomienia publiczne: kursor zwraca wszystkie wiersze bez luk i duplikatów przy remisach czasu', async () => {
  const path = `/api/meetings/public-notices?schoolYearId=${YEAR}`;
  const first = await call(path);
  assert.equal(first.status, 200);
  assert.equal(first.data.notices.length, 200);
  assert.equal(first.data.truncated, true);
  assert.equal(first.data.limit, 200);
  assert.ok(first.data.nextCursor);
  const all = await walk(path, 'notices');
  assert.equal(all.pages, 2);
  assert.equal(all.ids.length, NOTICES);
  assert.equal(new Set(all.ids).size, NOTICES);
  assert.deepEqual(all.ids, [...all.ids].sort(), 'termin rosnąco, remis po id');
  assert.ok(!all.ids.includes('pn-draft'));
  const small = await walk(path, 'notices', { limit: 7 });
  assert.deepEqual(small.ids, all.ids);
  const full = await call(`${path}&limit=200`);
  assert.equal(full.data.notices.length, 200);
  assert.equal(full.data.truncated, true);
});

test('zawiadomienia publiczne: ten sam kursor daje tę samą stronę, zły kursor i limit to 400, kursor związany z rokiem', async () => {
  const path = `/api/meetings/public-notices?schoolYearId=${YEAR}`;
  const first = await call(`${path}&limit=50`);
  const a = await call(`${path}&limit=50&cursor=${first.data.nextCursor}`);
  const b = await call(`${path}&limit=50&cursor=${first.data.nextCursor}`);
  assert.deepEqual(a.data, b.data);
  assert.equal(first.data.notices.filter((n) => a.data.notices.some((m) => m.id === n.id)).length, 0);
  for (const bad of ['cursor=zly', 'limit=0', 'limit=201', 'limit=abc']) {
    const res = await call(`${path}&${bad}`);
    assert.equal(res.status, 400, bad);
    assert.ok(['invalid_cursor', 'invalid_limit'].includes(res.data.error));
  }
  const other = await call(`/api/meetings/public-notices?schoolYearId=inny&cursor=${first.data.nextCursor}`);
  assert.equal(other.status, 400);
  assert.equal(other.data.error, 'invalid_cursor');
});

test('zawiadomienia publiczne: widok nadal publiczny i bez dodatkowych pól', async () => {
  const res = await call(`/api/meetings/public-notices?schoolYearId=${YEAR}&limit=5`);
  assert.equal(res.status, 200);
  assert.equal(res.data.notices.length, 5);
  assert.deepEqual(Object.keys(res.data.notices[0]).sort(),
    ['agenda', 'approvedAt', 'cancelled', 'id', 'kind', 'location', 'previousScheduledAt', 'scheduledAt', 'title']);
});

test('rejestr zdjęć: kursor zwraca wszystkie wiersze bez luk i duplikatów przy remisach czasu', async () => {
  const path = '/api/news-photos';
  const first = await call(path, admin);
  assert.equal(first.status, 200);
  assert.equal(first.data.photos.length, 200);
  assert.equal(first.data.truncated, true);
  assert.equal(first.data.limit, 200);
  const all = await walk(path, 'photos', { cookie: admin });
  assert.equal(all.pages, 2);
  assert.equal(all.ids.length, PHOTOS);
  assert.equal(new Set(all.ids).size, PHOTOS);
  const small = await walk(path, 'photos', { limit: 9, cookie: admin });
  assert.deepEqual(small.ids, all.ids);
  const filtered = await walk('/api/news-photos?status=pending', 'photos', { limit: 60, cookie: admin });
  assert.deepEqual(filtered.ids, all.ids);
});

test('rejestr zdjęć: zły kursor i limit to 400, kursor związany ze statusem', async () => {
  const first = await call('/api/news-photos?status=pending&limit=10', admin);
  const again = await call(`/api/news-photos?status=pending&limit=10&cursor=${first.data.nextCursor}`, admin);
  const twice = await call(`/api/news-photos?status=pending&limit=10&cursor=${first.data.nextCursor}`, admin);
  assert.deepEqual(again.data, twice.data);
  for (const bad of ['cursor=zly', 'limit=0', 'limit=201', 'limit=x']) {
    const res = await call(`/api/news-photos?${bad}`, admin);
    assert.equal(res.status, 400, bad);
  }
  const other = await call(`/api/news-photos?status=verified&cursor=${first.data.nextCursor}`, admin);
  assert.equal(other.status, 400);
  assert.equal(other.data.error, 'invalid_cursor');
  const noStatus = await call(`/api/news-photos?cursor=${first.data.nextCursor}`, admin);
  assert.equal(noStatus.data.error, 'invalid_cursor');
  const verified = await call('/api/news-photos?status=verified', admin);
  assert.equal(verified.status, 200);
  assert.deepEqual(verified.data.photos, []);
  assert.equal(verified.data.nextCursor, null);
});

test('rejestr zdjęć: granice ról bez zmian', async () => {
  assert.equal((await call('/api/news-photos', rep)).status, 403);
  assert.equal((await call('/api/news-photos?limit=5', rep)).status, 403);
  assert.equal((await call('/api/news-photos')).status, 401);
});
