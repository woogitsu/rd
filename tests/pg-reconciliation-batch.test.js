// Wsadowe zatwierdzenie propozycji dopasowań (#115): POST /api/reconciliations/{id}/matches/batch.
// Wyłącznie dane syntetyczne.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { loadMigrations } from '../src/postgres-migrations.js';
import { handlePgRequest } from '../src/pg/app.js';
import { request, seedSchoolYear, seedUserSession } from './helpers/pg.js';

const YEAR = 'y-batch';
let keySeq = 0;
const key = (prefix = 'bat') => `${prefix}-key-${++keySeq}-${Date.now()}`;
const migrationsDirectory = fileURLToPath(new URL('../postgres/migrations/', import.meta.url));
let shared = null;
let schemaSeq = 0;
after(async () => { await shared?.close(); });

async function setup() {
  shared ??= new PGlite();
  const schema = `batch_test_${++schemaSeq}`;
  await shared.exec(`CREATE SCHEMA ${schema}; SET search_path TO ${schema};`);
  for (const migration of await loadMigrations(migrationsDirectory)) await shared.exec(migration.sql);
  const db = { query: (...a) => shared.query(...a), exec: (...a) => shared.exec(...a),
    transaction: (fn) => shared.transaction(fn), close: async () => {} };
  await seedSchoolYear(db, YEAR);
  const cookies = {
    treasurer: await seedUserSession(db, { userId: 'u-treasurer', roles: [{ role: 'treasurer', schoolYearId: YEAR }], mfa: true }),
    board: await seedUserSession(db, { userId: 'u-board', roles: [{ role: 'board', schoolYearId: YEAR }], mfa: true }),
    admin: await seedUserSession(db, { userId: 'u-admin', roles: [{ role: 'admin' }], mfa: true }),
    audit: await seedUserSession(db, { userId: 'u-audit', roles: [{ role: 'audit', schoolYearId: YEAR }], mfa: true }),
    principal: await seedUserSession(db, { userId: 'u-principal', roles: [{ role: 'principal', schoolYearId: YEAR }], mfa: true }),
    treasurerNoMfa: await seedUserSession(db, { userId: 'u-treasurer', mfa: false }),
    rep: await seedUserSession(db, { userId: 'u-rep', roles: [{ role: 'representative', classId: 'c-1a', schoolYearId: YEAR }], mfa: true }),
  };
  await db.query("INSERT INTO households (id) VALUES ('h-1'), ('h-2')");
  const call = (path, options = {}) => handlePgRequest(request(path, options), { db });
  return { db, cookies, call };
}

async function seedPayments(db, rows) {
  for (const [id, cents, method = 'bank'] of rows) {
    await db.query(`INSERT INTO payment_entries (id, household_id, school_year_id, amount_cents, received_on, method,
      reference, status, created_by, idempotency_key)
      VALUES ($1, 'h-1', $2, $3, '2026-09-14', $4, NULL, 'recorded', 'u-treasurer', $5)`,
    [id, YEAR, cents, method, `pay-key-${id}`]);
  }
}

async function draft(call, cookies, amounts) {
  const created = await call('/api/reconciliations', {
    method: 'POST', cookie: cookies.treasurer, headers: { 'Idempotency-Key': key('rec') },
    body: { schoolYearId: YEAR, statementDate: '2026-09-30', statementBalanceCents: 0 },
  });
  const id = (await created.json()).reconciliation.id;
  const imported = await call(`/api/reconciliations/${id}/lines`, {
    method: 'POST', cookie: cookies.treasurer, headers: { 'Idempotency-Key': key('imp') },
    body: { lines: amounts.map((amountCents, i) => ({ bookedOn: `2026-09-${String(14 + i).padStart(2, '0')}`, amountCents })) },
  });
  assert.equal(imported.status, 201);
  const detail = await (await call(`/api/reconciliations/${id}`, { cookie: cookies.treasurer })).json();
  const lineIds = detail.lines.sort((a, b) => a.amountCents - b.amountCents || (a.id < b.id ? -1 : 1)).map((l) => l.id);
  return { id, lineIds, lines: detail.lines };
}

async function batch(call, cookie, id, matches, idempotencyKey = key(), extra = {}) {
  const response = await call(`/api/reconciliations/${id}/matches/batch`, {
    method: 'POST', cookie, headers: { 'Idempotency-Key': idempotencyKey }, body: { matches }, ...extra,
  });
  return { status: response.status, headers: response.headers, body: await response.json() };
}

const activeCount = async (db, id) => Number((await db.query(
  'SELECT count(*) AS n FROM bank_reconciliation_matches WHERE reconciliation_id = $1 AND revoked_at IS NULL', [id])).rows[0].n);

test('partia: zatwierdza wskazane pary w jednej transakcji, audyt per para bez kwot', async () => {
  const { db, cookies, call } = await setup();
  await seedPayments(db, [['p-a', 1000], ['p-b', 2000], ['p-c', 3000]]);
  const { id, lineIds } = await draft(call, cookies, [1000, 2000, 3000]);
  // Wybrano tylko dwie z trzech możliwych par; trzecia zostaje bez zmian.
  const result = await batch(call, cookies.treasurer, id, [
    { statementLineId: lineIds[1], paymentEntryId: 'p-b' }, { statementLineId: lineIds[0], paymentEntryId: 'p-a' },
  ]);
  assert.equal(result.status, 201);
  assert.equal(result.headers.get('Idempotency-Replayed'), 'false');
  assert.equal(result.body.matches.length, 2);
  assert.equal(await activeCount(db, id), 2);
  const events = await db.query("SELECT metadata_json FROM audit_events WHERE action = 'reconciliation.match.confirmed' ORDER BY occurred_at");
  assert.equal(events.rows.length, 2);
  for (const event of events.rows) {
    const metadata = typeof event.metadata_json === 'string' ? JSON.parse(event.metadata_json) : event.metadata_json;
    assert.equal(metadata.schoolYearId, YEAR);
    assert.equal(metadata.source, 'batch');
    assert.deepEqual(Object.keys(metadata).sort(), ['paymentEntryId', 'reconciliationId', 'schoolYearId', 'source', 'statementLineId']);
  }
});

test('podwójne kliknięcie: ten sam klucz i te same pary → 200, jedno zapisanie; inny zbiór z tym kluczem → 409', async () => {
  const { db, cookies, call } = await setup();
  await seedPayments(db, [['p-a', 1000], ['p-b', 2000], ['p-c', 3000]]);
  const { id, lineIds } = await draft(call, cookies, [1000, 2000, 3000]);
  const pairs = [{ statementLineId: lineIds[0], paymentEntryId: 'p-a' }, { statementLineId: lineIds[1], paymentEntryId: 'p-b' }];
  const idempotencyKey = key();
  const first = await batch(call, cookies.treasurer, id, pairs, idempotencyKey);
  assert.equal(first.status, 201);
  const replay = await batch(call, cookies.treasurer, id, [...pairs].reverse(), idempotencyKey);
  assert.equal(replay.status, 200);
  assert.equal(replay.headers.get('Idempotency-Replayed'), 'true');
  assert.deepEqual(replay.body.matches.map((m) => m.id).sort(), first.body.matches.map((m) => m.id).sort());
  assert.equal(await activeCount(db, id), 2);
  assert.equal(Number((await db.query("SELECT count(*) AS n FROM audit_events WHERE action = 'reconciliation.match.confirmed'")).rows[0].n), 2);
  const other = await batch(call, cookies.treasurer, id, [{ statementLineId: lineIds[2], paymentEntryId: 'p-c' }], idempotencyKey);
  assert.equal(other.status, 409);
  assert.equal(other.body.error, 'idempotency_conflict');
  const subset = await batch(call, cookies.treasurer, id, [pairs[0]], idempotencyKey);
  assert.equal(subset.body.error, 'idempotency_conflict');
  assert.equal(await activeCount(db, id), 2);
});

test('konflikt: pozycja już dopasowana → 409 match_batch_rejected, nic z partii nie zostaje zapisane', async () => {
  const { db, cookies, call } = await setup();
  await seedPayments(db, [['p-a', 1000], ['p-b', 2000]]);
  const { id, lineIds } = await draft(call, cookies, [1000, 2000]);
  const single = await call(`/api/reconciliations/${id}/matches`, {
    method: 'POST', cookie: cookies.treasurer, headers: { 'Idempotency-Key': key() },
    body: { statementLineId: lineIds[0], paymentEntryId: 'p-a' },
  });
  assert.equal(single.status, 201);
  const result = await batch(call, cookies.treasurer, id, [
    { statementLineId: lineIds[0], paymentEntryId: 'p-a' }, { statementLineId: lineIds[1], paymentEntryId: 'p-b' },
  ]);
  assert.equal(result.status, 409);
  assert.equal(result.body.error, 'match_batch_rejected');
  assert.deepEqual(result.body.failures, [{ statementLineId: lineIds[0], paymentEntryId: 'p-a', error: 'already_matched' }]);
  assert.equal(await activeCount(db, id), 1);
  // Po usunięciu konfliktu ta sama partia bez zajętej pary przechodzi.
  const retry = await batch(call, cookies.treasurer, id, [{ statementLineId: lineIds[1], paymentEntryId: 'p-b' }]);
  assert.equal(retry.status, 201);
});

test('mieszana partia: dobra, gotówkowa, niezgodna kwota i nieistniejąca wpłata → nic nie zapisano, komplet powodów', async () => {
  const { db, cookies, call } = await setup();
  await seedPayments(db, [['p-ok', 1000], ['p-cash', 2000, 'cash'], ['p-amt', 999], ['p-x', 4000]]);
  const { id, lineIds } = await draft(call, cookies, [1000, 2000, 3000, 4000]);
  const result = await batch(call, cookies.treasurer, id, [
    { statementLineId: lineIds[0], paymentEntryId: 'p-ok' },
    { statementLineId: lineIds[1], paymentEntryId: 'p-cash' },
    { statementLineId: lineIds[2], paymentEntryId: 'p-amt' },
    { statementLineId: lineIds[3], paymentEntryId: 'p-missing' },
  ]);
  assert.equal(result.status, 409);
  assert.equal(result.body.error, 'match_batch_rejected');
  const byPayment = Object.fromEntries(result.body.failures.map((f) => [f.paymentEntryId, f.error]));
  assert.deepEqual(byPayment, { 'p-cash': 'match_method_mismatch', 'p-amt': 'match_amount_mismatch', 'p-missing': 'invalid_match_target' });
  assert.equal(await activeCount(db, id), 0);
  assert.equal(Number((await db.query("SELECT count(*) AS n FROM audit_events WHERE action = 'reconciliation.match.confirmed'")).rows[0].n), 0);
});

test('walidacja: pusta lista, brak listy, zbyt duża partia, duplikaty, obce pola, brak klucza', async () => {
  const { db, cookies, call } = await setup();
  await seedPayments(db, [['p-a', 1000]]);
  const { id, lineIds } = await draft(call, cookies, [1000]);
  const pair = { statementLineId: lineIds[0], paymentEntryId: 'p-a' };
  assert.equal((await batch(call, cookies.treasurer, id, [])).body.error, 'match_batch_empty');
  const missing = await call(`/api/reconciliations/${id}/matches/batch`, {
    method: 'POST', cookie: cookies.treasurer, headers: { 'Idempotency-Key': key() }, body: { all: true },
  });
  assert.equal((await missing.json()).error, 'match_batch_empty');
  const many = Array.from({ length: 51 }, (_, i) => ({ statementLineId: `l-${i}`, paymentEntryId: `p-${i}` }));
  assert.equal((await batch(call, cookies.treasurer, id, many)).body.error, 'match_batch_too_large');
  assert.equal((await batch(call, cookies.treasurer, id, [pair, { statementLineId: lineIds[0], paymentEntryId: 'p-z' }])).body.error, 'match_batch_duplicate');
  assert.equal((await batch(call, cookies.treasurer, id, [pair, { statementLineId: 'l-z', paymentEntryId: 'p-a' }])).body.error, 'match_batch_duplicate');
  assert.equal((await batch(call, cookies.treasurer, id, [{ ...pair, ledgerEntryId: 'le-1' }])).body.error, 'invalid_request');
  const noKey = await call(`/api/reconciliations/${id}/matches/batch`, { method: 'POST', cookie: cookies.treasurer, body: { matches: [pair] } });
  assert.equal(noKey.status, 400);
  assert.equal((await noKey.json()).error, 'invalid_idempotency_key');
  assert.equal(await activeCount(db, id), 0);
});

test('granice ról: admin i board tak; audit, dyrekcja, przedstawiciel, brak MFA, obcy Origin i inny rok → 403', async () => {
  const { db, cookies, call } = await setup();
  await seedPayments(db, [['p-a', 1000], ['p-b', 2000]]);
  const { id, lineIds } = await draft(call, cookies, [1000, 2000]);
  const pair = (i, p) => [{ statementLineId: lineIds[i], paymentEntryId: p }];
  await seedSchoolYear(db, 'y-other', { startsOn: '2027-09-01', endsOn: '2028-08-31' });
  const otherYear = await seedUserSession(db, { userId: 'u-other', roles: [{ role: 'treasurer', schoolYearId: 'y-other' }], mfa: true });
  for (const cookie of [cookies.audit, cookies.principal, cookies.rep, cookies.treasurerNoMfa, otherYear]) {
    const denied = await batch(call, cookie, id, pair(0, 'p-a'));
    assert.equal(denied.status, 403);
  }
  assert.equal((await batch(call, cookies.board, id, pair(0, 'p-a'), key(), { origin: 'https://evil.example' })).status, 403);
  const anonymous = await call(`/api/reconciliations/${id}/matches/batch`, {
    method: 'POST', headers: { 'Idempotency-Key': key() }, body: { matches: pair(0, 'p-a') },
  });
  assert.equal(anonymous.status, 401);
  assert.equal(await activeCount(db, id), 0);
  assert.equal((await batch(call, cookies.board, id, pair(0, 'p-a'))).status, 201);
  assert.equal((await batch(call, cookies.admin, id, pair(1, 'p-b'))).status, 201);
  const wrongMethod = await call(`/api/reconciliations/${id}/matches/batch`, { cookie: cookies.treasurer });
  assert.equal(wrongMethod.status, 405);
});

test('rok zamknięty i uzgodnienie zatwierdzone → 409, nic nie zapisano', async () => {
  const { db, cookies, call } = await setup();
  await seedPayments(db, [['p-a', 1000], ['p-b', 2000]]);
  const { id, lineIds } = await draft(call, cookies, [1000, 2000]);
  await seedSchoolYear(db, 'y-next', { startsOn: '2027-09-01', endsOn: '2028-08-31' });
  await db.exec(`
    SET session_replication_role = replica;
    INSERT INTO school_year_closures (id, school_year_id, next_school_year_id, status, initiated_by,
      closed_by, closed_at, income_cents, expense_cents, opening_balance_cents, closing_balance_cents,
      carried_opening_balance_id, expired_grant_count)
    VALUES ('clo-batch', '${YEAR}', 'y-next', 'closed', 'u-treasurer', 'u-board', now(), 0, 0, 0, 0, 'ob-next', 0);
    SET session_replication_role = origin;
  `);
  const closed = await batch(call, cookies.treasurer, id, [
    { statementLineId: lineIds[0], paymentEntryId: 'p-a' }, { statementLineId: lineIds[1], paymentEntryId: 'p-b' },
  ]);
  assert.equal(closed.status, 409);
  assert.equal(closed.body.error, 'school_year_closed');
  assert.equal(await activeCount(db, id), 0);
});

test('uzgodnienie zatwierdzone lub porzucone → 409', async () => {
  const { db, cookies, call } = await setup();
  await seedPayments(db, [['p-a', 1000]]);
  const { id, lineIds } = await draft(call, cookies, [1000]);
  const abandoned = await call(`/api/reconciliations/${id}/abandon`, {
    method: 'POST', cookie: cookies.treasurer, body: { reason: 'Test partii na porzuconym szkicu' },
  });
  assert.equal(abandoned.status, 200);
  const result = await batch(call, cookies.treasurer, id, [{ statementLineId: lineIds[0], paymentEntryId: 'p-a' }]);
  assert.equal(result.status, 409);
  assert.equal(result.body.error, 'reconciliation_abandoned');
  assert.equal(await activeCount(db, id), 0);
});

test('wpłata dopasowana w innym uzgodnieniu roku → odrzucenie całej partii', async () => {
  const { db, cookies, call } = await setup();
  await seedPayments(db, [['p-a', 1000], ['p-b', 2000]]);
  const first = await draft(call, cookies, [1000]);
  assert.equal((await batch(call, cookies.treasurer, first.id, [{ statementLineId: first.lineIds[0], paymentEntryId: 'p-a' }])).status, 201);
  const second = await draft(call, cookies, [1000, 2000]);
  const result = await batch(call, cookies.treasurer, second.id, [
    { statementLineId: second.lineIds[0], paymentEntryId: 'p-a' }, { statementLineId: second.lineIds[1], paymentEntryId: 'p-b' },
  ]);
  assert.equal(result.status, 409);
  assert.equal(result.body.error, 'match_batch_rejected');
  assert.equal(result.body.failures[0].error, 'matched_in_other_reconciliation');
  assert.equal(await activeCount(db, second.id), 0);
});

test('wsad: wpłata ujęta w księdze nie może być zatwierdzona, gdy jej wpis księgi jest już powiązany w uzgodnieniu (#162)', async () => {
  const { db, cookies, call } = await setup();
  await seedPayments(db, [['p-dup', 2500]]);
  await db.query(`INSERT INTO ledger_categories (id, school_year_id, direction, name, created_by)
    VALUES ('cat-dues', $1, 'income', 'Składki dobrowolne', 'u-treasurer')`, [YEAR]);
  await db.query(`INSERT INTO ledger_entries (id, school_year_id, direction, amount_cents, category_id, description,
    occurred_on, method, payment_entry_id, created_by, idempotency_key)
    VALUES ('le-dup', $1, 'income', 2500, 'cat-dues', 'Składka syntetyczna z wpłaty', '2026-09-14', 'bank', 'p-dup', 'u-treasurer', 'le-key-dup')`, [YEAR]);
  const { id, lineIds } = await draft(call, cookies, [2500, 2500]);
  // Wpis księgi ujmujący wpłatę zajmuje cel ręcznie; partia z tą samą wpłatą jest odrzucana w całości.
  const manual = await call(`/api/reconciliations/${id}/matches`, {
    method: 'POST', cookie: cookies.treasurer, headers: { 'Idempotency-Key': key('man') },
    body: { statementLineId: lineIds[0], ledgerEntryId: 'le-dup' },
  });
  assert.equal(manual.status, 201);
  const result = await batch(call, cookies.treasurer, id, [{ statementLineId: lineIds[1], paymentEntryId: 'p-dup' }]);
  assert.equal(result.status, 409);
  assert.equal(result.body.error, 'match_batch_rejected');
  assert.equal(result.body.failures.length, 1);
  assert.equal(result.body.failures[0].error, 'already_matched_via_ledger');
  assert.equal(await activeCount(db, id), 1);
});
