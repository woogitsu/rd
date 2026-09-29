// Kontrakt list z kursorem keyset (issue #159): brak cichego obcinania, stabilność
// przy remisach czasu, ważność kursora tylko dla własnego filtra, granice ról.
// Dane wyłącznie syntetyczne (domeny .invalid).

import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { handlePgRequest } from '../src/pg/app.js';
import { createTestDb, request, seedSchoolYear, seedUserSession } from './helpers/pg.js';

const TOTAL = 1200;
let db;
let env;
let admin;
let board;

async function call(path, cookie = admin) {
  const response = await handlePgRequest(request(path, { cookie }), env);
  const text = await response.text();
  return { status: response.status, data: text ? JSON.parse(text) : null };
}

// Przechodzi wszystkie strony; zwraca listę id w kolejności odpowiedzi.
async function walk(path, key, { limit, idOf = (item) => item.id } = {}) {
  const ids = [];
  let cursor = null;
  let pages = 0;
  do {
    const query = new URLSearchParams();
    if (limit) query.set('limit', String(limit));
    if (cursor) query.set('cursor', cursor);
    const joiner = path.includes('?') ? '&' : '?';
    const res = await call(`${path}${query.size ? joiner + query : ''}`);
    assert.equal(res.status, 200, JSON.stringify(res.data));
    ids.push(...res.data[key].map(idOf));
    assert.equal(res.data.truncated, res.data.nextCursor !== null, 'truncated zgodne z nextCursor');
    cursor = res.data.nextCursor;
    pages += 1;
    assert.ok(pages < 100, 'kursor nie może zapętlić listy');
  } while (cursor);
  return { ids, pages };
}

before(async () => {
  db = await createTestDb();
  env = { db };
  await seedSchoolYear(db, 'y-list');
  await seedSchoolYear(db, 'y-other');
  admin = await seedUserSession(db, { userId: 'u-admin', roles: [{ role: 'admin' }], mfa: true });
  board = await seedUserSession(db, { userId: 'u-board', roles: [{ role: 'board', schoolYearId: 'y-list' }], mfa: true });
  // 1 200 użytkowników, każdy z jednym przydziałem i zaproszeniem. Czasy z remisami:
  // po 7 wierszy z identycznym znacznikiem.
  await db.query(
    `INSERT INTO users (id, email, display_name)
     SELECT 'bulk-' || lpad(i::text, 5, '0'), 'bulk-' || lpad(i::text, 5, '0') || '@example.invalid', 'Bulk ' || i
       FROM generate_series(1, ${TOTAL}) i`,
  );
  await db.query(
    `INSERT INTO role_grants (id, user_id, role, school_year_id, granted_by, granted_at)
     SELECT 'g-' || lpad(i::text, 5, '0'), 'bulk-' || lpad(i::text, 5, '0'), 'board', 'y-list', 'u-admin',
            timestamptz '2026-01-01 00:00:00+00' - (i / 7) * interval '1 second'
       FROM generate_series(1, ${TOTAL}) i`,
  );
  await db.query(
    `INSERT INTO invitations (id, email, token_hash, role, school_year_id, created_by, created_at, expires_at)
     SELECT 'inv-' || lpad(i::text, 5, '0'), 'inv-' || i || '@example.invalid', encode(sha256(('t' || i)::bytea), 'hex'),
            'board', 'y-list', 'u-admin',
            timestamptz '2026-01-01 00:00:00+00' - (i / 7) * interval '1 second', timestamptz '2099-01-01 00:00:00+00'
       FROM generate_series(1, ${TOTAL}) i`,
  );
  // Audyt: znaczniki różniące się o mikrosekundy (obcięcie do ms w kursorze zgubiłoby wiersze)
  // oraz remisy.
  await db.query(
    `INSERT INTO audit_events (id, actor_id, action, entity_type, entity_id, occurred_at)
     SELECT 'ae-' || lpad(i::text, 5, '0'), 'u-admin', 'role_grant.created', 'role_grant', 'x-' || i,
            timestamptz '2026-01-01 00:00:00+00' - (i / 7) * interval '1 second' + (CASE WHEN i % 2 = 0 THEN (i % 7) * interval '1 microsecond' ELSE interval '0' END)
       FROM generate_series(1, ${TOTAL}) i`,
  );
  await db.query(
    `INSERT INTO email_campaigns (id, school_year_id, title, audience, subject, body_text, content_hash, created_by, updated_by,
                                  idempotency_key, created_at)
     SELECT 'camp-' || lpad(i::text, 4, '0'), 'y-list', 'Kampania ' || i, 'all_households', 'Temat ' || i, repeat('x', 30),
            repeat('a', 64), 'u-admin', 'u-admin', 'idem-camp-' || i,
            timestamptz '2026-01-01 00:00:00+00' - (i / 5) * interval '1 second'
       FROM generate_series(1, 230) i`,
  );
  await db.query(
    `INSERT INTO documents (id, object_key, mime_type, byte_size, kind, created_by, school_year_id, sha256, idempotency_key, created_at)
     SELECT '00000000-0000-4000-8000-' || lpad(i::text, 12, '0'), 'docs/00000000-0000-4000-8000-' || lpad(i::text, 12, '0'), 'application/pdf', 10, 'board', 'u-admin',
            'y-list', repeat('b', 64), 'idem-doc-' || i,
            timestamptz '2026-01-01 00:00:00+00' - (i / 4) * interval '1 second'
       FROM generate_series(1, 230) i`,
  );
});
after(async () => { await db?.close(); });

async function expectedIds(sql) {
  return (await db.query(sql)).rows.map((row) => row.id);
}

test('users: >500 wierszy — domyślna strona jawnie obcięta, kolejne strony bez luk i duplikatów', async () => {
  const first = await call('/api/admin/users');
  assert.equal(first.data.users.length, 500);
  assert.equal(first.data.truncated, true);
  assert.ok(first.data.nextCursor);
  assert.equal(first.data.limit, 500);
  const expected = await expectedIds('SELECT id FROM users ORDER BY lower(email), id');
  const { ids, pages } = await walk('/api/admin/users', 'users');
  assert.deepEqual(ids, expected);
  assert.ok(expected.length > 1200);
  assert.equal(pages, 3);
});

test('users: mała strona i ostatnia strona bez nextCursor', async () => {
  const { ids } = await walk('/api/admin/users', 'users', { limit: 250 });
  assert.equal(new Set(ids).size, ids.length);
  const last = await call('/api/admin/users?limit=500');
  assert.equal(last.data.users.length, 500);
});

test('grants: remisy granted_at rozstrzyga id; przejście 1 200+ przydziałów', async () => {
  const expected = await expectedIds('SELECT id FROM role_grants ORDER BY granted_at DESC, id');
  const { ids } = await walk('/api/admin/grants?status=all', 'grants', { limit: 100 });
  assert.deepEqual(ids, expected);
  const { ids: defaultIds, pages } = await walk('/api/admin/grants?status=all', 'grants');
  assert.deepEqual(defaultIds, expected);
  assert.equal(pages, 3);
});

test('grants: kursor z innym filtrem to 400 invalid_cursor', async () => {
  const first = await call('/api/admin/grants?status=all&limit=10');
  const other = await call(`/api/admin/grants?status=active&limit=10&cursor=${first.data.nextCursor}`);
  assert.equal(other.status, 400);
  assert.equal(other.data.error, 'invalid_cursor');
});

test('invitations: przejście wszystkich stron w kolejności (created_at DESC, id)', async () => {
  const expected = await expectedIds('SELECT id FROM invitations ORDER BY created_at DESC, id');
  const { ids } = await walk('/api/admin/invitations', 'invitations', { limit: 300 });
  assert.deepEqual(ids, expected);
});

test('audit: 1 200 zdarzeń, mikrosekundy i remisy — wszystkie strony bez duplikatów i luk', async () => {
  const expected = await expectedIds(
    "SELECT id FROM audit_events WHERE action = 'role_grant.created' ORDER BY occurred_at DESC, id",
  );
  const { ids } = await walk('/api/admin/audit', 'events', { limit: 50 });
  assert.equal(ids.length, expected.length);
  assert.deepEqual(ids, expected);
  const { ids: big } = await walk('/api/admin/audit', 'events', { limit: 500 });
  assert.deepEqual(big, expected);
});

test('audit: okno from/to przechodzi całą historię z kursorem', async () => {
  const from = '2025-12-31T23:50:00Z';
  const to = '2026-01-01T00:00:00Z';
  const expected = await expectedIds(
    `SELECT id FROM audit_events WHERE action = 'role_grant.created' AND occurred_at >= '${from}' AND occurred_at <= '${to}'
      ORDER BY occurred_at DESC, id`,
  );
  const { ids } = await walk(`/api/admin/audit?from=${from}&to=${to}`, 'events', { limit: 40 });
  assert.deepEqual(ids, expected);
  assert.ok(expected.length > 100);
});

test('audit: podwójne kliknięcie „następna strona” z tym samym kursorem daje identyczną stronę', async () => {
  const first = await call('/api/admin/audit?limit=30');
  const a = await call(`/api/admin/audit?limit=30&cursor=${first.data.nextCursor}`);
  const b = await call(`/api/admin/audit?limit=30&cursor=${first.data.nextCursor}`);
  assert.deepEqual(a.data.events.map((e) => e.id), b.data.events.map((e) => e.id));
  assert.equal(a.data.nextCursor, b.data.nextCursor);
});

test('audit: nowe zdarzenie wstawione między stronami nie powtarza wierszy ani nie gubi starszych', async () => {
  const first = await call('/api/admin/audit?limit=100');
  const before = (await db.query("SELECT count(*)::int AS n FROM audit_events WHERE action = ANY($1::text[])", [['role_grant.created']])).rows[0].n;
  await db.query(
    `INSERT INTO audit_events (id, actor_id, action, entity_type, entity_id, occurred_at)
     VALUES ('ae-late', 'u-admin', 'role_grant.created', 'role_grant', 'x-late', now())`,
  );
  {
    const seen = new Set(first.data.events.map((e) => e.id));
    let cursor = first.data.nextCursor;
    while (cursor) {
      const page = await call(`/api/admin/audit?limit=100&cursor=${cursor}`);
      for (const event of page.data.events) {
        assert.ok(!seen.has(event.id), `duplikat ${event.id}`);
        seen.add(event.id);
      }
      cursor = page.data.nextCursor;
    }
    assert.equal(seen.size, before, 'wszystkie zdarzenia sprzed wstawienia obejrzane raz');
    assert.ok(!seen.has('ae-late'));
  }
});

test('audit: kursor z innym filtrem lub uszkodzony to 400 invalid_cursor; zły limit to 400 invalid_limit', async () => {
  const first = await call('/api/admin/audit?limit=10&domain=access');
  assert.ok(first.data.nextCursor);
  const otherDomain = await call(`/api/admin/audit?limit=10&domain=finance&cursor=${first.data.nextCursor}`);
  assert.equal(otherDomain.data.error, 'invalid_cursor');
  const otherWindow = await call(`/api/admin/audit?limit=10&domain=access&from=2020-01-01T00:00:00Z&cursor=${first.data.nextCursor}`);
  assert.equal(otherWindow.data.error, 'invalid_cursor');
  for (const cursor of ['x', '!!!', Buffer.from('[1,2]').toString('base64url'),
    Buffer.from(JSON.stringify(['not-a-date', 'id', 'x'])).toString('base64url')]) {
    const res = await call(`/api/admin/audit?cursor=${cursor}`);
    assert.equal(res.status, 400, cursor);
    assert.equal(res.data.error, 'invalid_cursor');
  }
  // Kursor z innej listy (users) nie działa na audycie.
  const users = await call('/api/admin/users?limit=5');
  assert.equal((await call(`/api/admin/audit?cursor=${users.data.nextCursor}`)).data.error, 'invalid_cursor');
  for (const limit of ['0', '-1', '501', 'abc', '1.5']) {
    const res = await call(`/api/admin/audit?limit=${limit}`);
    assert.equal(res.status, 400, limit);
    assert.equal(res.data.error, 'invalid_limit');
  }
  assert.equal((await call('/api/admin/users?limit=501')).data.error, 'invalid_limit');
});

test('kampanie e-mail: >100 wierszy — jawne obcięcie i pełne przejście z kursorem', async () => {
  const first = await call('/api/email/campaigns?schoolYearId=y-list', board);
  assert.equal(first.data.campaigns.length, 100);
  assert.equal(first.data.truncated, true);
  const expected = await expectedIds("SELECT id FROM email_campaigns WHERE school_year_id = 'y-list' ORDER BY created_at DESC, id");
  const seen = [];
  let cursor = null;
  do {
    const res = await call(`/api/email/campaigns?schoolYearId=y-list&limit=60${cursor ? `&cursor=${cursor}` : ''}`, board);
    assert.equal(res.status, 200);
    seen.push(...res.data.campaigns.map((c) => c.id));
    cursor = res.data.nextCursor;
  } while (cursor);
  assert.deepEqual(seen, expected);
  assert.equal((await call('/api/email/campaigns?schoolYearId=y-list&limit=101', board)).data.error, 'invalid_limit');
  const other = await call(`/api/email/campaigns?schoolYearId=y-other&cursor=${first.data.nextCursor}`, admin);
  assert.equal(other.status, 403);
});

test('dokumenty: kursor keyset zamiast OFFSET; kursor związany z filtrem; zły limit to 400', async () => {
  const expected = await expectedIds("SELECT id FROM documents WHERE school_year_id = 'y-list' ORDER BY created_at DESC, id");
  const seen = [];
  let cursor = null;
  let pages = 0;
  do {
    const res = await call(`/api/documents?schoolYearId=y-list&limit=100${cursor ? `&cursor=${cursor}` : ''}`);
    assert.equal(res.status, 200, JSON.stringify(res.data));
    seen.push(...res.data.documents.map((d) => d.id));
    assert.equal(res.data.truncated, res.data.nextCursor !== null);
    cursor = res.data.nextCursor;
    pages += 1;
  } while (cursor);
  assert.deepEqual(seen, expected);
  assert.equal(pages, 3);
  const first = await call('/api/documents?schoolYearId=y-list&limit=10');
  assert.equal(first.data.offset, 0);
  const other = await call(`/api/documents?schoolYearId=y-list&kind=board&limit=10&cursor=${first.data.nextCursor}`);
  assert.equal(other.status, 400);
  assert.equal(other.data.error, 'invalid_cursor');
  for (const limit of ['0', '101', 'abc']) {
    const res = await call(`/api/documents?schoolYearId=y-list&limit=${limit}`);
    assert.equal(res.status, 400, limit);
    assert.equal(res.data.error, 'invalid_limit');
  }
});

test('granice ról: listy z kursorem zostają zamknięte dla nie-administratorów, bez MFA i anonimów', async () => {
  const rep = await seedUserSession(db, {
    userId: 'u-rep', mfa: true, roles: [{ role: 'representative', classId: 'c-list-1a', schoolYearId: 'y-list' }],
  });
  const treasurer = await seedUserSession(db, { userId: 'u-treasurer', roles: [{ role: 'treasurer', schoolYearId: 'y-list' }], mfa: true });
  const noMfa = await seedUserSession(db, { userId: 'u-admin-nomfa', roles: [{ role: 'admin' }], mfa: false });
  const cursor = (await call('/api/admin/audit?limit=5')).data.nextCursor;
  for (const path of ['/api/admin/users', '/api/admin/grants', '/api/admin/invitations', '/api/admin/audit']) {
    for (const cookie of [board, treasurer, rep, noMfa]) {
      assert.equal((await call(`${path}?limit=5&cursor=${cursor}`, cookie)).status, 403, `${path} ${cookie}`);
    }
    assert.equal((await call(`${path}?limit=5`, null)).status, 401, path);
  }
  // Przedstawiciel klasy nie edytuje kampanii ani nie widzi dokumentów zarządu.
  assert.equal((await call('/api/email/campaigns?schoolYearId=y-list', rep)).status, 403);
  const repDocs = await call('/api/documents?schoolYearId=y-list&limit=5', rep);
  assert.equal(repDocs.status, 200);
  assert.deepEqual(repDocs.data.documents, [], 'dokumenty zarządu nie trafiają do przedstawiciela klasy');
  assert.equal(repDocs.data.nextCursor, null, 'kursor nie ujawnia istnienia ukrytych dokumentów');
  // Zarząd innego roku nie czyta kampanii y-other z kursorem z y-list.
  assert.equal((await call('/api/email/campaigns?schoolYearId=y-other', board)).status, 403);
});
