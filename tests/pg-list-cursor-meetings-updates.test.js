// Kursor keyset dla listy zebrań i kolejki próśb o zmianę kontaktu oraz jawny sygnał
// obcięcia list stałych (#159). Wyłącznie dane syntetyczne (domeny .invalid).

import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { handlePgRequest } from '../src/pg/app.js';
import { createTestDb, request, seedSchoolYear, seedUserSession } from './helpers/pg.js';

const YEAR = 'y-mt';
const MEETINGS = 530;
const REQUESTS = 230;
let db;
let env;
let board;
let rep;

async function call(path, cookie = board) {
  const response = await handlePgRequest(request(path, { cookie }), env);
  const text = await response.text();
  return { status: response.status, data: text ? JSON.parse(text) : null };
}

async function walk(path, key, { limit, cookie }) {
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
  board = await seedUserSession(db, { userId: 'u-board', roles: [{ role: 'board', schoolYearId: YEAR }], mfa: true });
  rep = await seedUserSession(db, { userId: 'u-rep', roles: [{ role: 'representative', classId: 'c-x', schoolYearId: YEAR }] });
  // Co trzecie zebranie ma ten sam czas — remis rozstrzyga id.
  await db.query(
    `INSERT INTO meetings (id, school_year_id, kind, title, scheduled_at, created_by)
     SELECT 'mt-' || lpad(i::text, 4, '0'), '${YEAR}', 'plenary', 'Zebranie testowe',
            timestamptz '2026-01-01 10:00+00' + ((i / 3) * interval '1 day'), 'u-board'
       FROM generate_series(1, ${MEETINGS}) i`,
  );
  await db.query(`INSERT INTO households (id) VALUES ('hh-1')`);
  await db.query(
    `INSERT INTO guardians (id, household_id, first_name, last_name, email, contact_allowed)
     VALUES ('gg-1', 'hh-1', 'Opiekun', 'Testowy', 'g1@example.invalid', true)`,
  );
  await db.query(
    `INSERT INTO guardian_update_links (id, guardian_id, token_hash, created_by, created_at, expires_at)
     VALUES ('ln-1', 'gg-1', repeat('b', 64), 'u-board', now() - interval '2 day', now() + interval '10 day')`,
  );
  // Po cztery prośby o tym samym czasie — remis rozstrzyga id.
  await db.query(
    `INSERT INTO guardian_update_requests (id, link_id, guardian_id, proposed_contact_allowed, proposed_contact_allowed_set, created_at)
     SELECT 'rq-' || lpad(i::text, 4, '0'), 'ln-1', 'gg-1', false, true,
            timestamptz '2026-02-01 08:00+00' + ((i / 4) * interval '1 minute')
       FROM generate_series(1, ${REQUESTS}) i`,
  );
});

after(async () => { await db?.close?.(); });

test('lista zebrań: kursor zwraca wszystkie wiersze bez duplikatów, także przy remisach czasu', async () => {
  const path = `/api/meetings?schoolYearId=${YEAR}`;
  const first = await call(path);
  assert.equal(first.status, 200);
  assert.equal(first.data.meetings.length, 500);
  assert.equal(first.data.truncated, true);
  assert.ok(first.data.nextCursor);
  const { ids, pages } = await walk(path, 'meetings', { cookie: board });
  assert.equal(pages, 2);
  assert.equal(ids.length, MEETINGS);
  assert.equal(new Set(ids).size, MEETINGS);
  const small = await walk(path, 'meetings', { limit: 77, cookie: board });
  assert.deepEqual(small.ids, ids);
});

test('lista zebrań: ten sam kursor daje identyczną stronę, zły kursor i limit to 400', async () => {
  const path = `/api/meetings?schoolYearId=${YEAR}`;
  const first = await call(`${path}&limit=100`);
  const a = await call(`${path}&limit=100&cursor=${first.data.nextCursor}`);
  const b = await call(`${path}&limit=100&cursor=${first.data.nextCursor}`);
  assert.deepEqual(a.data, b.data);
  const overlap = first.data.meetings.filter((m) => a.data.meetings.some((n) => n.id === m.id));
  assert.equal(overlap.length, 0);
  assert.equal((await call(`${path}&cursor=zly`)).data.error, 'invalid_cursor');
  assert.equal((await call(`${path}&limit=0`)).data.error, 'invalid_limit');
  assert.equal((await call(`${path}&limit=501`)).data.error, 'invalid_limit');
  // Kursor wydany dla innego roku nie jest przyjmowany.
  const other = await call(`/api/meetings?schoolYearId=inny&cursor=${first.data.nextCursor}`);
  assert.ok(other.status >= 400);
});

test('lista zebrań: granice ról bez zmian (przedstawiciel nie czyta listy)', async () => {
  assert.equal((await call(`/api/meetings?schoolYearId=${YEAR}`, rep)).status, 403);
});

test('kolejka próśb o zmianę kontaktu: kursor keyset, wszystkie wiersze bez duplikatów', async () => {
  const path = '/api/admin/guardian-update-requests?status=pending';
  const first = await call(path);
  assert.equal(first.status, 200);
  assert.equal(first.data.requests.length, 200);
  assert.equal(first.data.truncated, true);
  const all = await walk(path, 'requests', { cookie: board });
  assert.equal(all.ids.length, REQUESTS);
  assert.equal(new Set(all.ids).size, REQUESTS);
  const small = await walk(path, 'requests', { limit: 33, cookie: board });
  assert.deepEqual(small.ids, all.ids);
  assert.equal((await call(`${path}&cursor=zly`)).data.error, 'invalid_cursor');
  assert.equal((await call(`${path}&limit=0`)).data.error, 'invalid_limit');
});

test('kolejka próśb: kursor innego statusu jest odrzucany, przedstawiciel dostaje 403', async () => {
  const first = await call('/api/admin/guardian-update-requests?status=pending&limit=10');
  const other = await call(`/api/admin/guardian-update-requests?status=approved&cursor=${first.data.nextCursor}`);
  assert.equal(other.data.error, 'invalid_cursor');
  assert.equal((await call('/api/admin/guardian-update-requests', rep)).status, 403);
});

test('wersje szablonu kodu weryfikacyjnego: kursor po version, truncated, obowiązująca wersja spoza strony', async () => {
  const TEMPLATES = 130;
  const path = '/api/admin/guardian-verify-templates';
  const newest = `tpl-${String(TEMPLATES).padStart(4, '0')}`;
  await db.query("INSERT INTO users (id, email, display_name) VALUES ('u-approver', 'approver@example.invalid', 'Zatwierdzający')");
  // Najstarsza wersja jest zatwierdzona, a nowsze to szkice: obowiązująca leży poza pierwszą stroną.
  const body = 'Kod potwierdzający to {kod}. Jeśli to nie Ty, zignoruj wiadomość.';
  await db.query(
    `INSERT INTO guardian_verify_templates (id, subject, body_text, content_hash, status, created_by, approved_by, approved_at)
     VALUES ('tpl-0001', 'Potwierdzenie adresu', $1, $2, 'approved', 'u-board', 'u-approver', now())`,
    [body, 'a'.repeat(64)],
  );
  await db.query(
    `INSERT INTO guardian_verify_templates (id, subject, body_text, content_hash, created_by)
     SELECT 'tpl-' || lpad(i::text, 4, '0'), 'Potwierdzenie adresu', $1, $2, 'u-board'
       FROM generate_series(2, ${TEMPLATES}) i`,
    [body, 'b'.repeat(64)],
  );

  const first = await call(path);
  assert.equal(first.status, 200, JSON.stringify(first.data));
  assert.equal(first.data.templates.length, 100);
  assert.equal(first.data.truncated, true);
  assert.equal(typeof first.data.nextCursor, 'string');
  assert.equal(first.data.limit, 100);
  assert.equal(first.data.templates[0].id, newest, 'najnowsza wersja pierwsza');
  assert.equal(first.data.templates.some((template) => template.id === 'tpl-0001'), false, 'zatwierdzona wersja jest poza stroną');
  assert.equal(first.data.currentTemplateId, 'tpl-0001', 'obowiązująca wersja nie zależy od strony');

  const tail = await call(`${path}?cursor=${first.data.nextCursor}`);
  assert.equal(tail.status, 200, JSON.stringify(tail.data));
  assert.equal(tail.data.templates.length, TEMPLATES - 100);
  assert.deepEqual([tail.data.truncated, tail.data.nextCursor], [false, null]);
  assert.equal(tail.data.templates.at(-1).id, 'tpl-0001');
  assert.equal(tail.data.currentTemplateId, 'tpl-0001');

  const all = await walk(path, 'templates', { limit: 33, cookie: board });
  assert.equal(all.pages, 4);
  assert.equal(all.ids.length, TEMPLATES);
  assert.equal(new Set(all.ids).size, TEMPLATES);
  assert.deepEqual(all.ids, [...all.ids].sort().reverse(), 'wersje malejąco, bez powtórzeń');

  assert.deepEqual((await call(`${path}?cursor=zly`)).data, { error: 'invalid_cursor' });
  const forgedKey = Buffer.from(JSON.stringify(['abc', 'tpl-0001', JSON.stringify(['guardian-verify-templates'])])).toString('base64url');
  assert.deepEqual((await call(`${path}?cursor=${forgedKey}`)).data, { error: 'invalid_cursor' });
  const foreign = Buffer.from(JSON.stringify(['5', 'tpl-0005', JSON.stringify(['guardian-update-requests', 'pending'])])).toString('base64url');
  assert.deepEqual((await call(`${path}?cursor=${foreign}`)).data, { error: 'invalid_cursor' });
  for (const limit of ['0', '101', 'abc']) assert.deepEqual((await call(`${path}?limit=${limit}`)).data, { error: 'invalid_limit' }, limit);
  assert.equal((await call(path, rep)).status, 403, 'przedstawiciel klasy nie czyta szablonu');
});
