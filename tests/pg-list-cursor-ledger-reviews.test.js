// Kursor keyset dla GET /api/ledger/reviews (#159): lista weryfikacji wydatków
// nie obcina już po cichu. Wyłącznie dane syntetyczne, kwoty w centach EUR.

import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { handlePgRequest } from '../src/pg/app.js';
import { createTestDb, request, seedClass, seedSchoolYear, seedUserSession } from './helpers/pg.js';
import { assertEvery } from './helpers/assertions.js';

const YEAR = 'y-lr';
const OTHER_YEAR = 'y-lr2';
const TOTAL = 530;
let db;
let env;
const cookies = {};

async function call(path, cookie = cookies.treasurer) {
  const response = await handlePgRequest(request(path, { cookie }), env);
  const text = await response.text();
  return { status: response.status, data: text ? JSON.parse(text) : null };
}

async function walk(path, { limit, cookie } = {}) {
  const ids = [];
  let cursor = null;
  let pages = 0;
  do {
    const query = new URLSearchParams();
    if (limit) query.set('limit', String(limit));
    if (cursor) query.set('cursor', cursor);
    const res = await call(`${path}&${query}`, cookie);
    assert.equal(res.status, 200, JSON.stringify(res.data));
    ids.push(...res.data.reviews.map((item) => item.ledgerEntryId));
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
  await seedSchoolYear(db, OTHER_YEAR, { startsOn: '2027-09-01', endsOn: '2028-08-31' });
  await seedClass(db, { id: 'c-lr', schoolYearId: YEAR });
  const finance = (role, userId) => seedUserSession(db, {
    userId, mfa: true, roles: [YEAR, OTHER_YEAR].map((schoolYearId) => ({ role, schoolYearId })),
  });
  cookies.treasurer = await finance('treasurer', 'u-lr-treasurer');
  cookies.board = await finance('board', 'u-lr-board');
  cookies.admin = await seedUserSession(db, { userId: 'u-lr-admin', mfa: true, roles: [{ role: 'admin' }] });
  cookies.audit = await finance('audit', 'u-lr-audit');
  cookies.rep = await seedUserSession(db, { userId: 'u-lr-rep', mfa: true, roles: [{ role: 'representative', classId: 'c-lr', schoolYearId: YEAR }] });
  // Skarbnik tylko w pierwszym roku: nie przekroczy go żadnym kursorem.
  cookies.treasurerOne = await seedUserSession(db, { userId: 'u-lr-treasurer1', mfa: true, roles: [{ role: 'treasurer', schoolYearId: YEAR }] });
  await db.query(`INSERT INTO ledger_categories (id, school_year_id, direction, name, created_by) VALUES
    ('cat-lr', '${YEAR}', 'expense', 'Wydarzenia', 'u-lr-treasurer'),
    ('cat-lr2', '${OTHER_YEAR}', 'expense', 'Wydarzenia', 'u-lr-treasurer')`);
  // Co cztery wpisy mają ten sam dzień — remis rozstrzyga id.
  await db.query(
    `INSERT INTO ledger_entries (id, school_year_id, direction, amount_cents, category_id, description, occurred_on, method, created_by, idempotency_key)
     SELECT 'le-' || lpad(i::text, 4, '0'), '${YEAR}', 'expense', 1000 + i, 'cat-lr', 'Wydatek testowy ' || i,
            date '2026-09-10' + (i / 4), 'bank', 'u-lr-treasurer', 'idem-lr-' || lpad(i::text, 4, '0')
       FROM generate_series(1, ${TOTAL}) i`,
  );
  await db.query(
    `INSERT INTO ledger_entries (id, school_year_id, direction, amount_cents, category_id, description, occurred_on, method, created_by, idempotency_key)
     VALUES ('le-other-1', '${OTHER_YEAR}', 'expense', 2500, 'cat-lr2', 'Wydatek innego roku', '2027-10-01', 'bank', 'u-lr-treasurer', 'idem-lr-other-1')`,
  );
  // Co piąty wpis zweryfikowany przez drugą osobę.
  await db.query(
    `INSERT INTO ledger_entry_reviews (id, school_year_id, ledger_entry_id, decision, reviewed_by, idempotency_key)
     SELECT 'lr-' || lpad(i::text, 4, '0'), '${YEAR}', 'le-' || lpad(i::text, 4, '0'), 'verified', 'u-lr-board', 'idem-lrr-' || lpad(i::text, 4, '0')
       FROM generate_series(5, ${TOTAL}, 5) i`,
  );
});

after(async () => { await db?.close?.(); });

test('lista weryfikacji: kursor zwraca wszystkie wiersze raz, także przy remisach daty', async () => {
  const path = `/api/ledger/reviews?schoolYearId=${YEAR}`;
  const first = await call(path);
  assert.equal(first.status, 200);
  assert.equal(first.data.reviews.length, 500);
  assert.equal(first.data.limit, 500);
  assert.equal(first.data.truncated, true);
  assert.notEqual(first.data.nextCursor, null);
  assert.deepEqual(Object.keys(first.data.reviews[0]).sort(), [
    'categoryName', 'createdBy', 'description', 'lastReviewedAt', 'lastReviewedBy', 'ledgerEntryId',
    'netAmountCents', 'occurredOn', 'reviewCount', 'reviewStatus',
  ]);

  const full = await walk(path, { limit: 70 });
  assert.equal(full.ids.length, TOTAL);
  assert.equal(new Set(full.ids).size, TOTAL);
  assert.ok(!full.ids.includes('le-other-1'));
  assert.equal(full.pages, Math.ceil(TOTAL / 70));
  const single = await walk(path);
  assert.deepEqual(single.ids, full.ids);

  const exact = await call(`${path}&limit=500`);
  assert.equal(exact.data.truncated, true);
  const last = await call(`${path}&limit=500&cursor=${exact.data.nextCursor}`);
  assert.equal(last.data.reviews.length, TOTAL - 500);
  assert.equal(last.data.truncated, false);
  assert.equal(last.data.nextCursor, null);
});

test('lista weryfikacji: kursor związany z filtrem, zła wartość daje 400', async () => {
  const path = `/api/ledger/reviews?schoolYearId=${YEAR}`;
  const verified = await call(`${path}&reviewStatus=verified&limit=30`);
  assert.equal(verified.status, 200);
  assertEvery(verified.data.reviews, (item) => item.reviewStatus === 'verified', 'filtr statusu');
  assert.equal(verified.data.truncated, true);
  const walked = await walk(`${path}&reviewStatus=verified`, { limit: 30 });
  assert.equal(walked.ids.length, TOTAL / 5);

  const cursor = verified.data.nextCursor;
  const wrongStatus = await call(`${path}&reviewStatus=unverified&limit=30&cursor=${cursor}`);
  assert.deepEqual([wrongStatus.status, wrongStatus.data.error], [400, 'invalid_cursor']);
  const noStatus = await call(`${path}&limit=30&cursor=${cursor}`);
  assert.deepEqual([noStatus.status, noStatus.data.error], [400, 'invalid_cursor']);
  const otherYear = await call(`/api/ledger/reviews?schoolYearId=${OTHER_YEAR}&reviewStatus=verified&cursor=${cursor}`);
  assert.deepEqual([otherYear.status, otherYear.data.error], [400, 'invalid_cursor']);
  // Kursor listy księgi (GET /api/ledger) nie pasuje do tej trasy.
  const ledger = await call(`/api/ledger?schoolYearId=${YEAR}&limit=5`);
  assert.notEqual(ledger.data.nextCursor, null);
  const foreign = await call(`${path}&cursor=${ledger.data.nextCursor}`);
  assert.deepEqual([foreign.status, foreign.data.error], [400, 'invalid_cursor']);

  for (const bad of ['!!!', 'a'.repeat(2000), Buffer.from('[1,2]').toString('base64url')]) {
    const res = await call(`${path}&cursor=${bad}`);
    assert.deepEqual([res.status, res.data.error], [400, 'invalid_cursor']);
  }
  for (const bad of ['0', '501', '-1', 'abc', '1.5']) {
    const res = await call(`${path}&limit=${bad}`);
    assert.deepEqual([res.status, res.data.error], [400, 'invalid_limit']);
  }
  assert.equal((await call(`${path}&reviewStatus=x`)).status, 400);
});

test('lista weryfikacji: role — kursor niczego nie odblokowuje', async () => {
  const path = `/api/ledger/reviews?schoolYearId=${YEAR}`;
  const page = await call(`${path}&limit=10`);
  const cursor = page.data.nextCursor;
  for (const name of ['treasurer', 'board', 'admin']) {
    const res = await call(`${path}&limit=10&cursor=${cursor}`, cookies[name]);
    assert.equal(res.status, 200, name);
    assert.equal(res.data.reviews.length, 10);
  }
  // Przedstawiciel klasy i Komisja Rewizyjna: 403 także z ważnym kursorem, bez wierszy.
  for (const name of ['rep', 'audit']) {
    const res = await call(`${path}&limit=10&cursor=${cursor}`, cookies[name]);
    assert.equal(res.status, 403, name);
    assert.equal(res.data.reviews, undefined);
  }
  assert.equal((await call(`${path}&limit=10&cursor=${cursor}`, null)).status, 401);
  // Skarbnik bez przydziału na drugi rok nie czyta go; własny rok działa.
  const denied = await call(`/api/ledger/reviews?schoolYearId=${OTHER_YEAR}&limit=10`, cookies.treasurerOne);
  assert.equal(denied.status, 403);
  assert.equal(denied.data.reviews, undefined);
  assert.equal((await call(`${path}&limit=10`, cookies.treasurerOne)).status, 200);
});
