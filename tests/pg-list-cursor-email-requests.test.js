// Kursor keyset dla list e-mail (wyłączenia, „do sprawdzenia”, odbiorcy kampanii) i rejestru
// żądań osób (#159). Wyłącznie dane syntetyczne (domeny .invalid).

import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { handlePgRequest } from '../src/pg/app.js';
import { createTestDb, request, seedSchoolYear, seedUserSession, seedPublishedPrivacyNotice } from './helpers/pg.js';
import { assertEvery } from './helpers/assertions.js';

const YEAR = 'y-list';
const RECIPIENTS = 450;
const SUPPRESSIONS = 620;
const REQUESTS = 530;
let db;
let env;
let admin;
let board;
let campaignId = 'camp-list-1';

async function call(path, cookie = board) {
  const response = await handlePgRequest(request(path, { cookie }), env);
  const text = await response.text();
  return { status: response.status, data: text ? JSON.parse(text) : null };
}

async function walk(path, key, { limit, cookie, idOf }) {
  const ids = [];
  let cursor = null;
  let pages = 0;
  do {
    const query = new URLSearchParams();
    if (limit) query.set('limit', String(limit));
    if (cursor) query.set('cursor', cursor);
    const res = await call(`${path}${path.includes('?') ? '&' : '?'}${query}`, cookie);
    assert.equal(res.status, 200, JSON.stringify(res.data));
    ids.push(...res.data[key].map(idOf));
    assert.equal(res.data.truncated, res.data.nextCursor !== null);
    cursor = res.data.nextCursor;
    pages += 1;
    assert.ok(pages < 100);
  } while (cursor);
  return { ids, pages };
}

before(async () => {
  db = await createTestDb();
  await seedPublishedPrivacyNotice(db);
  env = { db };
  await seedSchoolYear(db, YEAR);
  admin = await seedUserSession(db, { userId: 'u-admin', roles: [{ role: 'admin' }], mfa: true });
  board = await seedUserSession(db, { userId: 'u-board', roles: [{ role: 'board', schoolYearId: YEAR }], mfa: true });
  await db.query(
    `INSERT INTO households (id) SELECT 'hh-' || lpad(i::text, 4, '0') FROM generate_series(1, ${RECIPIENTS}) i`,
  );
  await db.query(
    `INSERT INTO guardians (id, household_id, first_name, last_name, email, contact_allowed)
     SELECT 'gg-' || lpad(i::text, 4, '0'), 'hh-' || lpad(i::text, 4, '0'), 'Opiekun', 'Testowy',
            'g' || i || '@example.invalid', true
       FROM generate_series(1, ${RECIPIENTS}) i`,
  );
  await db.query(
    `INSERT INTO email_campaigns (id, school_year_id, title, audience, subject, body_text, content_hash, created_by, updated_by, idempotency_key)
     VALUES ($1, $2, 'Kampania testowa', 'all_households', 'Temat', repeat('x', 30), repeat('a', 64), 'u-admin', 'u-admin', 'idem-camp-list-1')`,
    [campaignId, YEAR],
  );
  await db.query(
    `INSERT INTO email_campaign_recipients (id, campaign_id, household_id, guardian_id, email, email_hash)
     SELECT 'rr-' || lpad(i::text, 4, '0'), '${campaignId}', 'hh-' || lpad(i::text, 4, '0'), 'gg-' || lpad(i::text, 4, '0'),
            'g' || i || '@example.invalid', encode(sha256(('r' || i)::bytea), 'hex')
       FROM generate_series(1, ${RECIPIENTS}) i`,
  );
  // Co druga wiadomość „failed” — trafia na listę „do sprawdzenia” (450/2 = 225 > 200).
  // Kolejka wymaga zatwierdzonej kampanii; fixture omija trigger (wzorzec z testów zamrożenia roku).
  await db.query('SET session_replication_role = replica');
  await db.query(
    `INSERT INTO email_outbox (id, campaign_id, household_id, recipient_id, idempotency_key, state, last_error)
     SELECT 'ob-' || lpad(i::text, 4, '0'), '${campaignId}', 'hh-' || lpad(i::text, 4, '0'), 'rr-' || lpad(i::text, 4, '0'),
            'campaign:${campaignId}:household:hh-' || lpad(i::text, 4, '0'), 'failed', 'brevo_rejected'
       FROM generate_series(1, ${RECIPIENTS}) i WHERE i % 2 = 0`,
  );
  await db.query('SET session_replication_role = origin');
  // Wyłączenia z remisami czasu: po 9 wierszy z identycznym znacznikiem.
  await db.query(
    `INSERT INTO email_suppressions (id, email_hash, reason, created_at)
     SELECT 'sup-' || i, encode(sha256(('s' || i)::bytea), 'hex'), 'hard_bounce',
            timestamptz '2026-01-01 00:00:00+00' - (i / 9) * interval '1 second'
       FROM generate_series(1, ${SUPPRESSIONS}) i`,
  );
  // Rejestr żądań: remisy received_on i created_at.
  await db.query(
    `INSERT INTO data_subject_requests (id, kind, household_id, received_on, status, created_by, created_at, updated_at)
     SELECT gen_random_uuid()::text, CASE WHEN i % 3 = 0 THEN 'access' ELSE 'erasure' END, 'hh-' || lpad(((i % ${RECIPIENTS}) + 1)::text, 4, '0'),
            date '2026-01-01' + (i / 11), CASE WHEN i % 5 = 0 THEN 'answered' ELSE 'received' END, 'u-admin',
            timestamptz '2026-01-01 00:00:00+00' + (i / 4) * interval '1 second', timestamptz '2026-01-01 00:00:00+00' + (i / 4) * interval '1 second'
       FROM generate_series(1, ${REQUESTS}) i`,
  );
});
after(async () => { await db?.close(); });

const ids = async (sql) => (await db.query(sql)).rows.map((row) => row.id);

test('wyłączenia e-mail: >500 wierszy — jawne obcięcie i przejście wszystkich stron bez luk i duplikatów', async () => {
  const first = await call(`/api/email/suppressions?schoolYearId=${YEAR}`);
  assert.equal(first.data.suppressions.length, 500);
  assert.equal(first.data.truncated, true);
  assert.ok(first.data.nextCursor);
  const expected = await ids('SELECT email_hash AS id FROM email_active_suppressions ORDER BY created_at DESC, email_hash');
  assert.equal(expected.length, SUPPRESSIONS);
  for (const limit of [undefined, 70]) {
    const { ids: walked } = await walk(`/api/email/suppressions?schoolYearId=${YEAR}`, 'suppressions', { limit, idOf: (item) => item.emailHash });
    assert.deepEqual(walked, expected);
  }
});

test('wyłączenia e-mail: kursor z innym rokiem, zły limit, brak sesji i rola bez uprawnień', async () => {
  await seedSchoolYear(db, 'y-other');
  const first = await call(`/api/email/suppressions?schoolYearId=${YEAR}&limit=50`);
  const other = await call(`/api/email/suppressions?schoolYearId=y-other&limit=50&cursor=${first.data.nextCursor}`);
  assert.deepEqual([other.status, other.data.error], [403, 'forbidden']);
  const both = await seedUserSession(db, { userId: 'u-both', roles: [{ role: 'board', schoolYearId: YEAR }, { role: 'board', schoolYearId: 'y-other' }], mfa: true });
  const adminOther = await call(`/api/email/suppressions?schoolYearId=y-other&limit=50&cursor=${first.data.nextCursor}`, both);
  assert.deepEqual([adminOther.status, adminOther.data.error], [400, 'invalid_cursor']);
  for (const limit of ['0', '501', 'abc']) {
    const bad = await call(`/api/email/suppressions?schoolYearId=${YEAR}&limit=${limit}`);
    assert.deepEqual([bad.status, bad.data.error], [400, 'invalid_limit'], limit);
  }
  assert.equal((await call(`/api/email/suppressions?schoolYearId=${YEAR}&cursor=%%%`)).status, 400);
  assert.equal((await call(`/api/email/suppressions?schoolYearId=${YEAR}`, null)).status, 401);
  const rep = await seedUserSession(db, { userId: 'u-rep', roles: [{ role: 'representative', schoolYearId: YEAR, classId: 'c-r' }], mfa: true });
  assert.equal((await call(`/api/email/suppressions?schoolYearId=${YEAR}`, rep)).status, 403);
});

test('lista „do sprawdzenia”: >200 wierszy — kursor bez luk, każdy odczyt w dzienniku', async () => {
  const first = await call(`/api/email/campaigns/${campaignId}/attention`);
  assert.equal(first.data.rows.length, 200);
  assert.equal(first.data.truncated, true);
  const expected = await ids("SELECT id FROM email_outbox WHERE state = 'failed' ORDER BY id");
  for (const limit of [undefined, 33]) {
    const { ids: walked } = await walk(`/api/email/campaigns/${campaignId}/attention`, 'rows', { limit, idOf: (row) => row.outboxId });
    assert.deepEqual(walked, expected);
  }
  const { rows } = await db.query("SELECT count(*)::int AS n FROM audit_events WHERE action = 'email.attention_list.viewed'");
  assert.ok(rows[0].n >= 3);
  // Adres zostaje zamaskowany także na kolejnych stronach.
  assertEvery(first.data.rows, (row) => /^g\*\*\*@example\.invalid$/.test(row.email), 'adres zamaskowany (pierwsza litera + ***)');
});

test('lista „do sprawdzenia”: kursor innej kampanii → 400, zły limit → 400', async () => {
  await db.query(
    `INSERT INTO email_campaigns (id, school_year_id, title, audience, subject, body_text, content_hash, created_by, updated_by, idempotency_key)
     VALUES ('camp-list-2', $1, 'Druga', 'all_households', 'Temat', repeat('x', 30), repeat('a', 64), 'u-admin', 'u-admin', 'idem-camp-list-2')`,
    [YEAR],
  );
  const first = await call(`/api/email/campaigns/${campaignId}/attention?limit=10`);
  const other = await call(`/api/email/campaigns/camp-list-2/attention?limit=10&cursor=${first.data.nextCursor}`);
  assert.deepEqual([other.status, other.data.error], [400, 'invalid_cursor']);
  assert.equal((await call(`/api/email/campaigns/${campaignId}/attention?limit=201`)).data.error, 'invalid_limit');
});

test('odbiorcy kampanii: keyset zamiast OFFSET, wszystkie strony w kolejności (household_id, id)', async () => {
  const expected = await ids(`SELECT id FROM email_campaign_recipients WHERE campaign_id = '${campaignId}' ORDER BY household_id, id`);
  const first = await call(`/api/email/campaigns/${campaignId}/recipients`);
  assert.equal(first.data.recipients.length, 200);
  assert.equal(first.data.truncated, true);
  assert.equal('nextOffset' in first.data, false);
  const byHousehold = (await db.query(`SELECT household_id FROM email_campaign_recipients WHERE campaign_id = '${campaignId}' ORDER BY household_id, id`)).rows.map((r) => r.household_id);
  const { ids: walked, pages } = await walk(`/api/email/campaigns/${campaignId}/recipients`, 'recipients', { idOf: (row) => row.householdId });
  assert.deepEqual(walked, byHousehold);
  assert.equal(pages, 3);
  assert.equal(expected.length, RECIPIENTS);
  // Podwójne kliknięcie „Wczytaj następne”: ten sam kursor daje tę samą stronę.
  const a = await call(`/api/email/campaigns/${campaignId}/recipients?cursor=${first.data.nextCursor}`);
  const b = await call(`/api/email/campaigns/${campaignId}/recipients?cursor=${first.data.nextCursor}`);
  assert.deepEqual(a.data.recipients, b.data.recipients);
  const foreign = await call(`/api/email/campaigns/camp-list-2/recipients?cursor=${first.data.nextCursor}`);
  assert.deepEqual([foreign.status, foreign.data.error], [400, 'invalid_cursor']);
  const { rows } = await db.query("SELECT metadata_json FROM audit_events WHERE action = 'email.recipients.viewed' ORDER BY occurred_at DESC LIMIT 1");
  const metadata = typeof rows[0].metadata_json === 'string' ? JSON.parse(rows[0].metadata_json) : rows[0].metadata_json;
  assert.equal('offset' in metadata, false);
});

test('rejestr żądań osób: >500 wierszy — kursor, remisy dat, filtry związane z kursorem', async () => {
  const expected = await ids('SELECT id FROM data_subject_requests ORDER BY received_on, created_at, id');
  assert.equal(expected.length, REQUESTS);
  const first = await call('/api/admin/data-requests', admin);
  assert.equal(first.data.requests.length, 500);
  assert.equal(first.data.truncated, true);
  for (const limit of [undefined, 60]) {
    const { ids: walked } = await walk('/api/admin/data-requests', 'requests', { limit, cookie: admin, idOf: (item) => item.id });
    assert.deepEqual(walked, expected);
  }
  const filtered = await ids("SELECT id FROM data_subject_requests WHERE status = 'answered' AND kind = 'access' ORDER BY received_on, created_at, id");
  const { ids: walkedFiltered } = await walk('/api/admin/data-requests?status=answered&kind=access', 'requests', { limit: 7, cookie: admin, idOf: (item) => item.id });
  assert.deepEqual(walkedFiltered, filtered);
  const page = await call('/api/admin/data-requests?status=received&limit=10', admin);
  for (const query of ['status=answered&limit=10', 'status=received&kind=access&limit=10', 'limit=10']) {
    const other = await call(`/api/admin/data-requests?${query}&cursor=${page.data.nextCursor}`, admin);
    assert.deepEqual([other.status, other.data.error], [400, 'invalid_cursor'], query);
  }
  assert.equal((await call('/api/admin/data-requests?limit=0', admin)).data.error, 'invalid_limit');
});

test('rejestr żądań osób: nowy wpis między stronami nie powtarza wierszy; rola board nadal 403', async () => {
  const first = await call('/api/admin/data-requests?limit=100', admin);
  await db.query(
    `INSERT INTO data_subject_requests (id, kind, household_id, received_on, created_by)
     VALUES (gen_random_uuid()::text, 'access', 'hh-0001', date '2026-01-01', 'u-admin')`,
  );
  const second = await call(`/api/admin/data-requests?limit=100&cursor=${first.data.nextCursor}`, admin);
  const firstIds = new Set(first.data.requests.map((item) => item.id));
  assertEvery(second.data.requests, (item) => !firstIds.has(item.id));
  assert.equal((await call('/api/admin/data-requests', board)).status, 403);
  assert.equal((await call('/api/admin/data-requests', null)).status, 401);
});
