// Podział jednej wpłaty na kilka gospodarstw (#127, część 1; migracja 0104).
// Wyłącznie dane syntetyczne (@example.invalid). Jedna instancja PGlite, osobny schemat na test.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { loadMigrations } from '../src/postgres-migrations.js';
import { handlePgRequest } from '../src/pg/app.js';
import { request, seedSchoolYear, seedUserSession } from './helpers/pg.js';

const YEAR = 'y-127';
const OTHER = 'y-127-inny';
const migrationsDirectory = fileURLToPath(new URL('../postgres/migrations/', import.meta.url));
let shared = null;
let schemaSeq = 0;
let keySeq = 0;
const key = (prefix = 'k') => `${prefix}-127-${String(++keySeq).padStart(6, '0')}`;
after(async () => { await shared?.close(); });

async function freshDb() {
  shared ??= new PGlite();
  const schema = `payment_allocations_test_${++schemaSeq}`;
  await shared.exec(`CREATE SCHEMA ${schema}; SET search_path TO ${schema};`);
  for (const migration of await loadMigrations(migrationsDirectory)) await shared.exec(migration.sql);
  return { query: (...args) => shared.query(...args), exec: (...args) => shared.exec(...args),
    transaction: (fn) => shared.transaction(fn), close: async () => {} };
}

async function setup() {
  const db = await freshDb();
  await seedSchoolYear(db, YEAR, { startsOn: '2026-09-01', endsOn: '2027-08-31' });
  await seedSchoolYear(db, OTHER, { startsOn: '2027-09-01', endsOn: '2028-08-31' });
  // h-a i h-b: rodzeństwo przyrodnie w dwóch gospodarstwach; h-c: trzecia rodzina z przelewu zbiorczego.
  await db.query("INSERT INTO households (id) VALUES ('h-a'), ('h-b'), ('h-c')");
  const cookies = {
    treasurer: await seedUserSession(db, { userId: 'u-treasurer', roles: [{ role: 'treasurer', schoolYearId: YEAR }], mfa: true }),
    board: await seedUserSession(db, { userId: 'u-board', roles: [{ role: 'board', schoolYearId: YEAR }], mfa: true }),
    treasurerNoMfa: await seedUserSession(db, { userId: 'u-treasurer', mfa: false }),
    otherYear: await seedUserSession(db, { userId: 'u-other', roles: [{ role: 'treasurer', schoolYearId: OTHER }], mfa: true }),
    audit: await seedUserSession(db, { userId: 'u-audit', roles: [{ role: 'audit', schoolYearId: YEAR }], mfa: true }),
    principal: await seedUserSession(db, { userId: 'u-principal', roles: [{ role: 'principal', schoolYearId: YEAR }], mfa: true }),
    rep: await seedUserSession(db, {
      userId: 'u-rep', roles: [{ role: 'representative', classId: 'c-1a', schoolYearId: YEAR }], mfa: true,
    }),
  };
  const call = async (path, { cookie, body, idempotencyKey } = {}) => {
    const headers = idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {};
    const response = await handlePgRequest(request(path, {
      cookie, headers, method: body === undefined ? 'GET' : 'POST', body,
    }), { db });
    const text = await response.text();
    return { status: response.status, headers: response.headers, body: text ? JSON.parse(text) : null };
  };
  return { db, cookies, call };
}

async function createPayment(call, cookie, { amountCents, householdId = null, reference = 'Przelew syntetyczny' }) {
  const res = await call('/api/payments', {
    cookie, idempotencyKey: key('pay'),
    body: { schoolYearId: YEAR, householdId, amountCents, receivedOn: '2026-10-01', method: 'bank', reference },
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body.payment.id;
}

const allocate = (call, cookie, paymentId, householdId, amountCents, idempotencyKey = key('alloc')) =>
  call(`/api/payments/${paymentId}/allocations`, { cookie, idempotencyKey, body: { householdId, amountCents } });

const reverse = (call, cookie, paymentId, allocationId, idempotencyKey = key('rev'), reason = 'Błędna część — syntetyczne') =>
  call(`/api/payments/${paymentId}/allocations/${allocationId}/reversal`, { cookie, idempotencyKey, body: { reason } });

async function totals(db) {
  const { rows } = await db.query(
    `SELECT household_id, net_amount_cents::int AS net, payment_count::int AS count
       FROM household_payment_totals WHERE school_year_id = $1 ORDER BY household_id`,
    [YEAR],
  );
  return Object.fromEntries(rows.map((row) => [row.household_id, { net: row.net, count: row.count }]));
}

test('rodzeństwo w jednym gospodarstwie: jedna wpłata, jedno przypisanie; sumy jak przed migracją (bez części)', async () => {
  const { db, cookies, call } = await setup();
  await createPayment(call, cookies.treasurer, { amountCents: 5000, householdId: 'h-a' });
  // Dwoje opiekunów w różnych gospodarstwach płaci osobno za to samo dziecko: dwie wpłaty, bez łączenia.
  await createPayment(call, cookies.treasurer, { amountCents: 2000, householdId: 'h-b' });
  await createPayment(call, cookies.treasurer, { amountCents: 1000, householdId: 'h-b' });
  assert.deepEqual(await totals(db), { 'h-a': { net: 5000, count: 1 }, 'h-b': { net: 3000, count: 2 } });
  // Równoważność z definicją widoku z 0002 (wpłaty przypisane).
  const legacy = await db.query(
    `SELECT household_id, sum(net_amount_cents)::int AS net FROM payment_entry_net
      WHERE status = 'recorded' AND household_id IS NOT NULL AND school_year_id = $1 GROUP BY 1 ORDER BY 1`, [YEAR]);
  assert.deepEqual(legacy.rows.map((r) => [r.household_id, r.net]), [['h-a', 5000], ['h-b', 3000]]);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM payment_allocations')).rows[0].n, 0);
});

test('rodzeństwo w dwóch gospodarstwach: przelew 50 EUR dzielony 25/25; każde gospodarstwo widzi tylko swoją część', async () => {
  const { db, cookies, call } = await setup();
  const paymentId = await createPayment(call, cookies.treasurer, { amountCents: 5000 });
  const first = await allocate(call, cookies.treasurer, paymentId, 'h-a', 2500);
  assert.equal(first.status, 201, JSON.stringify(first.body));
  assert.equal(first.headers.get('Idempotency-Replayed'), 'false');
  const second = await allocate(call, cookies.board, paymentId, 'h-b', 2500);
  assert.equal(second.status, 201);
  assert.deepEqual(await totals(db), { 'h-a': { net: 2500, count: 1 }, 'h-b': { net: 2500, count: 1 } });

  const detail = await call(`/api/payments/${paymentId}/allocations`, { cookie: cookies.treasurer });
  assert.equal(detail.status, 200);
  assert.equal(detail.body.status, 'unmatched');
  assert.equal(detail.body.netAmountCents, 5000);
  assert.equal(detail.body.allocatedCents, 5000);
  assert.equal(detail.body.unallocatedCents, 0);
  assert.deepEqual(detail.body.allocations.map((a) => [a.householdId, a.amountCents, a.reversal]), [['h-a', 2500, null], ['h-b', 2500, null]]);

  // Dziennik: w transakcji, z rokiem, bez kwot i identyfikatorów gospodarstw.
  const { rows } = await db.query("SELECT metadata_json FROM audit_events WHERE action = 'payment.allocation.created'");
  assert.equal(rows.length, 2);
  for (const { metadata_json: metadata } of rows) {
    assert.equal(metadata.schoolYearId, YEAR);
    assert.equal(metadata.paymentEntryId, paymentId);
    const text = JSON.stringify(metadata);
    assert.ok(!text.includes('h-a') && !text.includes('h-b') && !text.includes('2500'), text);
  }

  // Przelew zbiorczy: wpłata zostaje jedną wpłatą o pełnej kwocie, więc pozycja wyciągu 50 EUR łączy się 1:1.
  const draft = await call('/api/reconciliations', {
    cookie: cookies.treasurer, idempotencyKey: key('rec'),
    body: { schoolYearId: YEAR, statementDate: '2026-10-31', statementBalanceCents: 5000 },
  });
  assert.equal(draft.status, 201, JSON.stringify(draft.body));
  const reconciliationId = draft.body.reconciliation.id;
  const imported = await call(`/api/reconciliations/${reconciliationId}/lines`, {
    cookie: cookies.treasurer, idempotencyKey: key('imp'),
    body: { lines: [{ bookedOn: '2026-10-01', amountCents: 5000, reference: 'Przelew zbiorczy syntetyczny' }] },
  });
  assert.equal(imported.status, 201);
  const lines = await call(`/api/reconciliations/${reconciliationId}`, { cookie: cookies.treasurer });
  const match = await call(`/api/reconciliations/${reconciliationId}/matches`, {
    cookie: cookies.treasurer, idempotencyKey: key('m'),
    body: { statementLineId: lines.body.lines[0].id, paymentEntryId: paymentId },
  });
  assert.equal(match.status, 201, JSON.stringify(match.body));
});

test('wpłata częściowo podzielona: reszta jako „nieprzypisana część”; suma części ponad netto jest odrzucana', async () => {
  const { db, cookies, call } = await setup();
  const paymentId = await createPayment(call, cookies.treasurer, { amountCents: 7500 });
  assert.equal((await allocate(call, cookies.treasurer, paymentId, 'h-a', 2500)).status, 201);
  const detail = await call(`/api/payments/${paymentId}/allocations`, { cookie: cookies.treasurer });
  assert.equal(detail.body.unallocatedCents, 5000);
  assert.deepEqual(await totals(db), { 'h-a': { net: 2500, count: 1 } });

  const over = await allocate(call, cookies.treasurer, paymentId, 'h-b', 5001);
  assert.equal(over.status, 409);
  assert.equal(over.body.error, 'payment_allocation_exceeds_net');
  assert.equal((await allocate(call, cookies.treasurer, paymentId, 'h-b', 5000)).status, 201);
  const third = await allocate(call, cookies.treasurer, paymentId, 'h-c', 1);
  assert.equal(third.body.error, 'payment_allocation_exceeds_net');

  // Wpłata przypisana do jednego gospodarstwa nie jest dzielona; zła kwota i nieznane gospodarstwo — 400.
  const assigned = await createPayment(call, cookies.treasurer, { amountCents: 1000, householdId: 'h-a' });
  assert.equal((await allocate(call, cookies.treasurer, assigned, 'h-b', 500)).body.error, 'payment_already_assigned');
  assert.equal((await allocate(call, cookies.treasurer, paymentId, 'h-b', 0)).body.error, 'invalid_amount');
  assert.equal((await allocate(call, cookies.treasurer, paymentId, 'h-nieznane', 1)).body.error, 'invalid_reference');
  assert.equal((await allocate(call, cookies.treasurer, 'brak-wplaty', 'h-a', 1)).status, 404);

  // Bezpośredni zapis poza API: ta sama reguła w bazie.
  await assert.rejects(db.query(`INSERT INTO payment_allocations (id, payment_entry_id, school_year_id, household_id, amount_cents, created_by, idempotency_key)
    VALUES ('pa-direct', $1, $2, 'h-c', 1, 'u-treasurer', 'pa-direct-key')`, [paymentId, YEAR]), /payment_allocation_exceeds_net|payment_allocation_household_exists/);
  await assert.rejects(db.query(`INSERT INTO payment_allocations (id, payment_entry_id, school_year_id, household_id, amount_cents, created_by, idempotency_key)
    VALUES ('pa-year', $1, $2, 'h-c', 1, 'u-treasurer', 'pa-year-key')`, [paymentId, OTHER]), /payment_allocation_year_mismatch|school_year/);
  await assert.rejects(db.query("UPDATE payment_allocations SET amount_cents = 1"), /payment_allocations_cannot_be_changed/);
  await assert.rejects(db.query('DELETE FROM payment_allocations'), /payment_allocations_cannot_be_changed/);
  await assert.rejects(db.query('TRUNCATE payment_allocations CASCADE'), /truncate_not_allowed/);
});

test('podwójne kliknięcie: ten sam klucz powtarza odpowiedź; nowy klucz dla tego samego gospodarstwa — 409; równoległe przekroczenie — jedno odrzucone', async () => {
  const { db, cookies, call } = await setup();
  const paymentId = await createPayment(call, cookies.treasurer, { amountCents: 5000 });
  const idempotencyKey = key('dbl');
  const [a, b] = await Promise.all([
    allocate(call, cookies.treasurer, paymentId, 'h-a', 2000, idempotencyKey),
    allocate(call, cookies.treasurer, paymentId, 'h-a', 2000, idempotencyKey),
  ]);
  assert.deepEqual([a.status, b.status].sort(), [200, 201]);
  assert.equal(a.body.allocation.id, b.body.allocation.id);
  const conflict = await allocate(call, cookies.treasurer, paymentId, 'h-a', 3000, idempotencyKey);
  assert.equal(conflict.body.error, 'idempotency_conflict');
  const sameHousehold = await allocate(call, cookies.treasurer, paymentId, 'h-a', 2000);
  assert.equal(sameHousehold.status, 409);
  assert.equal(sameHousehold.body.error, 'payment_allocation_household_exists');

  const results = await Promise.all([
    allocate(call, cookies.treasurer, paymentId, 'h-b', 2000),
    allocate(call, cookies.board, paymentId, 'h-c', 2000),
  ]);
  assert.deepEqual(results.map((r) => r.status).sort(), [201, 409]);
  const { rows } = await db.query('SELECT sum(amount_cents)::int AS s, count(*)::int AS n FROM payment_allocations_current WHERE payment_entry_id = $1', [paymentId]);
  assert.deepEqual(rows[0], { s: 4000, n: 2 });
});

test('korekta po podziale: nie schodzi poniżej części; błąd = cofnięcie części + nowa część; historia zostaje', async () => {
  const { db, cookies, call } = await setup();
  const paymentId = await createPayment(call, cookies.treasurer, { amountCents: 5000 });
  const partA = (await allocate(call, cookies.treasurer, paymentId, 'h-a', 2500)).body.allocation;
  await allocate(call, cookies.treasurer, paymentId, 'h-b', 2500);

  const correction = await call(`/api/payments/${paymentId}/corrections`, {
    cookie: cookies.treasurer, idempotencyKey: key('cor'), body: { amountCents: 1000, reason: 'Błędna kwota — syntetyczne' },
  });
  assert.equal(correction.status, 409);
  assert.equal(correction.body.error, 'payment_allocation_exceeds_net');
  const refund = await call(`/api/payments/${paymentId}/refunds`, {
    cookie: cookies.treasurer, idempotencyKey: key('ref'),
    body: { amountCents: 1000, refundedOn: '2026-10-05', method: 'bank', reason: 'Zwrot syntetyczny' },
  });
  assert.equal(refund.body.error, 'payment_allocation_exceeds_net');
  const assignment = await call(`/api/payments/${paymentId}/assignment`, {
    cookie: cookies.treasurer, idempotencyKey: key('asg'), body: { householdId: 'h-c' },
  });
  assert.equal(assignment.status, 409);
  assert.equal(assignment.body.error, 'payment_has_allocations');

  // Cofnięcie części (nowy zapis), korekta, nowa, mniejsza część.
  const reversalKey = key('rev');
  const reversal = await reverse(call, cookies.treasurer, paymentId, partA.id, reversalKey);
  assert.equal(reversal.status, 201, JSON.stringify(reversal.body));
  const replay = await reverse(call, cookies.treasurer, paymentId, partA.id, reversalKey);
  assert.equal(replay.status, 200);
  assert.equal(replay.body.reversal.id, reversal.body.reversal.id);
  const again = await reverse(call, cookies.board, paymentId, partA.id);
  assert.equal(again.body.error, 'payment_allocation_already_reversed');
  assert.equal((await reverse(call, cookies.treasurer, paymentId, 'brak-czesci')).status, 404);
  assert.equal((await reverse(call, cookies.treasurer, paymentId, partA.id, key('rev'), 'x')).body.error, 'invalid_reason');

  const retry = await call(`/api/payments/${paymentId}/corrections`, {
    cookie: cookies.treasurer, idempotencyKey: key('cor'), body: { amountCents: 1000, reason: 'Błędna kwota — syntetyczne' },
  });
  assert.equal(retry.status, 201, JSON.stringify(retry.body));
  assert.equal((await allocate(call, cookies.treasurer, paymentId, 'h-a', 1501)).body.error, 'payment_allocation_exceeds_net');
  assert.equal((await allocate(call, cookies.treasurer, paymentId, 'h-a', 1500)).status, 201);
  assert.deepEqual(await totals(db), { 'h-a': { net: 1500, count: 1 }, 'h-b': { net: 2500, count: 1 } });

  const detail = await call(`/api/payments/${paymentId}/allocations`, { cookie: cookies.treasurer });
  assert.equal(detail.body.netAmountCents, 4000);
  assert.equal(detail.body.allocations.length, 3, 'cofnięta część zostaje w historii');
  assert.equal(detail.body.allocations.filter((a) => a.reversal).length, 1);
  const events = await db.query("SELECT metadata_json FROM audit_events WHERE action = 'payment.allocation.reversed'");
  assert.equal(events.rows.length, 1);
  assert.equal(events.rows[0].metadata_json.schoolYearId, YEAR);
  await assert.rejects(db.query('DELETE FROM payment_allocation_reversals'), /payment_allocation_reversals_cannot_be_changed/);
  await assert.rejects(db.query('TRUNCATE payment_allocation_reversals'), /truncate_not_allowed/);

  // Po cofnięciu wszystkich części wpłata może dostać jedno gospodarstwo.
  const current = (await db.query('SELECT id FROM payment_allocations_current WHERE payment_entry_id = $1', [paymentId])).rows;
  for (const { id } of current) assert.equal((await reverse(call, cookies.treasurer, paymentId, id)).status, 201);
  const assigned = await call(`/api/payments/${paymentId}/assignment`, {
    cookie: cookies.treasurer, idempotencyKey: key('asg'), body: { householdId: 'h-c' },
  });
  assert.equal(assigned.status, 201, JSON.stringify(assigned.body));
  assert.deepEqual(await totals(db), { 'h-c': { net: 4000, count: 1 } });
});

test('przedstawiciel, KR, dyrekcja, inny rok i brak MFA: 403 na odczyt i zapis części; bez zapisu w bazie', async () => {
  const { db, cookies, call } = await setup();
  const paymentId = await createPayment(call, cookies.treasurer, { amountCents: 5000 });
  const part = (await allocate(call, cookies.treasurer, paymentId, 'h-a', 2500)).body.allocation;
  for (const cookie of [cookies.rep, cookies.audit, cookies.principal, cookies.otherYear, cookies.treasurerNoMfa]) {
    assert.equal((await call(`/api/payments/${paymentId}/allocations`, { cookie })).status, 403);
    assert.equal((await allocate(call, cookie, paymentId, 'h-b', 100)).status, 403);
    assert.equal((await reverse(call, cookie, paymentId, part.id)).status, 403);
  }
  assert.equal((await call(`/api/payments/${paymentId}/allocations`)).status, 401);
  const { rows } = await db.query(`SELECT (SELECT count(*)::int FROM payment_allocations) AS a,
    (SELECT count(*)::int FROM payment_allocation_reversals) AS r`);
  assert.deepEqual(rows[0], { a: 1, r: 0 });
});

test('rok zamknięty: nowa część i cofnięcie są odrzucane (409 school_year_closed)', async () => {
  const { db, cookies, call } = await setup();
  const paymentId = await createPayment(call, cookies.treasurer, { amountCents: 5000 });
  const part = (await allocate(call, cookies.treasurer, paymentId, 'h-a', 2500)).body.allocation;
  await db.exec(`
    SET session_replication_role = replica;
    INSERT INTO school_year_closures (id, school_year_id, next_school_year_id, status, initiated_by,
      closed_by, closed_at, income_cents, expense_cents, opening_balance_cents, closing_balance_cents,
      carried_opening_balance_id, expired_grant_count)
    VALUES ('clo-127', '${YEAR}', '${OTHER}', 'closed', 'u-treasurer', 'u-board', now(), 0, 0, 0, 0, 'ob-next', 0);
    SET session_replication_role = origin;
  `);
  const created = await allocate(call, cookies.treasurer, paymentId, 'h-b', 100);
  assert.equal(created.status, 409);
  assert.equal(created.body.error, 'school_year_closed');
  const reversed = await reverse(call, cookies.treasurer, paymentId, part.id);
  assert.equal(reversed.status, 409);
  assert.equal(reversed.body.error, 'school_year_closed');
});
