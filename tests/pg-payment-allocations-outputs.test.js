// #127: kartki klasowe (print) i raport Komisji Rewizyjnej przy wpłacie podzielonej
// na gospodarstwa (payment_allocations, migracja 0104). Kwoty w centach; wyłącznie
// dane syntetyczne. Nie ma tu statusu „dłużnik”: brak części to „brak wpisu”, a nie zaległość.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { loadMigrations } from '../src/postgres-migrations.js';
import { handlePgRequest } from '../src/pg/app.js';
import { request, seedClass, seedSchoolYear, seedUser, seedUserSession } from './helpers/pg.js';

const YEAR = 'y-127-out';
const migrationsDirectory = fileURLToPath(new URL('../postgres/migrations/', import.meta.url));
let shared = null;
let schemaSeq = 0;
let keySeq = 0;
const key = (prefix = 'k') => `${prefix}-127o-${String(++keySeq).padStart(6, '0')}`;
after(async () => { await shared?.close(); });

async function freshDb() {
  shared ??= new PGlite();
  const schema = `payment_allocations_outputs_${++schemaSeq}`;
  await shared.exec(`CREATE SCHEMA ${schema}; SET search_path TO ${schema};`);
  for (const migration of await loadMigrations(migrationsDirectory)) await shared.exec(migration.sql);
  return { query: (...args) => shared.query(...args), exec: (...args) => shared.exec(...args),
    transaction: (fn) => shared.transaction(fn), close: async () => {} };
}

async function setup() {
  const db = await freshDb();
  await seedSchoolYear(db, YEAR, { startsOn: '2026-09-01', endsOn: '2027-08-31' });
  await seedClass(db, { id: 'c-1a', schoolYearId: YEAR, name: '1A' });
  await seedClass(db, { id: 'c-2b', schoolYearId: YEAR, name: '2B' });
  await seedUser(db, { userId: 'u-seed' });
  // h-a i h-b: rodzeństwo przyrodnie w różnych gospodarstwach i klasach; h-c: rodzina bez części.
  for (const id of ['h-a', 'h-b', 'h-c']) await db.query('INSERT INTO households (id) VALUES ($1)', [id]);
  for (const [id, household, first, classId] of [
    ['s-ala', 'h-a', 'Ala', 'c-1a'], ['s-olek', 'h-b', 'Olek', 'c-2b'], ['s-ewa', 'h-c', 'Ewa', 'c-1a'],
  ]) {
    await db.query('INSERT INTO students (id, household_id, first_name, last_name) VALUES ($1,$2,$3,$4)', [id, household, first, 'Syntetyczny']);
    await db.query('INSERT INTO enrollments (id, student_id, class_id, school_year_id) VALUES ($1,$2,$3,$4)', [`e-${id}`, id, classId, YEAR]);
  }
  const cookies = {
    treasurer: await seedUserSession(db, { userId: 'u-treasurer', roles: [{ role: 'treasurer', schoolYearId: YEAR }], mfa: true }),
    treasurerNoMfa: await seedUserSession(db, { userId: 'u-treasurer-nomfa', roles: [{ role: 'treasurer', schoolYearId: YEAR }], mfa: false }),
    audit: await seedUserSession(db, { userId: 'u-audit', roles: [{ role: 'audit', schoolYearId: YEAR }], mfa: true }),
    rep1a: await seedUserSession(db, { userId: 'u-rep', roles: [{ role: 'representative', classId: 'c-1a', schoolYearId: YEAR }], mfa: true }),
  };
  const call = async (path, { cookie, body, idempotencyKey } = {}) => {
    const headers = idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {};
    const response = await handlePgRequest(request(path, {
      cookie, headers, method: body === undefined ? 'GET' : 'POST', body,
    }), { db });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null, text };
  };
  return { db, cookies, call };
}

async function createPayment(call, cookie, { amountCents, householdId = null }) {
  const res = await call('/api/payments', {
    cookie, idempotencyKey: key('pay'),
    body: { schoolYearId: YEAR, householdId, amountCents, receivedOn: '2026-10-01', method: 'bank', reference: 'Przelew syntetyczny' },
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body.payment.id;
}

const allocate = (call, cookie, paymentId, householdId, amountCents) =>
  call(`/api/payments/${paymentId}/allocations`, { cookie, idempotencyKey: key('alloc'), body: { householdId, amountCents } });

const cardAmounts = async (call, cookie, query = `schoolYearId=${YEAR}`) => {
  const res = await call(`/api/print/cards?${query}`, { cookie });
  assert.equal(res.status, 200, res.text);
  return { res, byHousehold: Object.fromEntries(res.body.rows.map((row) => [row.householdId, row.recordedNetCents])) };
};

test('kartki: wpłata podzielona po korekcie i częściowo przypisana pokazuje części, nie pełną kwotę wpłaty', async () => {
  const { db, cookies, call } = await setup();
  try {
    // 50,00 EUR minus korekta 10,00 = 40,00 netto; części 25,00 + 10,00, nieprzypisane 5,00.
    const paymentId = await createPayment(call, cookies.treasurer, { amountCents: 5000 });
    const correction = await call(`/api/payments/${paymentId}/corrections`, {
      cookie: cookies.treasurer, idempotencyKey: key('cor'), body: { amountCents: 1000, reason: 'Korekta syntetyczna' },
    });
    assert.equal(correction.status, 201, JSON.stringify(correction.body));
    assert.equal((await allocate(call, cookies.treasurer, paymentId, 'h-a', 2500)).status, 201);
    assert.equal((await allocate(call, cookies.treasurer, paymentId, 'h-b', 1000)).status, 201);
    // Osobna, w pełni przypisana wpłata h-c (nie może się mieszać z częściami).
    await createPayment(call, cookies.treasurer, { amountCents: 700, householdId: 'h-c' });

    const { res, byHousehold } = await cardAmounts(call, cookies.treasurer);
    assert.deepEqual(byHousehold, { 'h-a': 2500, 'h-b': 1000, 'h-c': 700 });
    // Suma na kartkach = części + wpłata h-c; nie 5000 ani 4000 na rodzinę.
    assert.equal(Object.values(byHousehold).reduce((a, b) => a + b, 0), 4200);
    assert.ok(!/dłużnik|zaległ/i.test(res.text));

    // Filtr klasy nie zmienia kwoty części (rodzeństwo w dwóch klasach).
    assert.deepEqual((await cardAmounts(call, cookies.treasurer, `schoolYearId=${YEAR}&classId=c-2b`)).byHousehold, { 'h-b': 1000 });

    // Cofnięcie części to nowy zapis: kartka pokazuje pozostałe części.
    const current = (await db.query('SELECT id FROM payment_allocations_current WHERE household_id = $1', ['h-b'])).rows[0];
    const reversal = await call(`/api/payments/${paymentId}/allocations/${current.id}/reversal`, {
      cookie: cookies.treasurer, idempotencyKey: key('rev'), body: { reason: 'Błędna część syntetyczna' },
    });
    assert.equal(reversal.status, 201, JSON.stringify(reversal.body));
    assert.deepEqual((await cardAmounts(call, cookies.treasurer)).byHousehold, { 'h-a': 2500, 'h-b': 0, 'h-c': 700 });
  } finally { await db.close(); }
});

test('kartki: kwoty z części tylko dla roli finansowej z MFA; przedstawiciel i brak MFA nie dostają pola', async () => {
  const { db, cookies, call } = await setup();
  try {
    const paymentId = await createPayment(call, cookies.treasurer, { amountCents: 5000 });
    await allocate(call, cookies.treasurer, paymentId, 'h-a', 2500);
    await allocate(call, cookies.treasurer, paymentId, 'h-b', 2500);
    for (const cookie of [cookies.rep1a, cookies.treasurerNoMfa]) {
      const res = await call(`/api/print/cards?schoolYearId=${YEAR}&classId=c-1a`, { cookie });
      if (res.status === 200) {
        assert.ok(res.body.rows.length > 0);
        for (const row of res.body.rows) assert.ok(!('recordedNetCents' in row), JSON.stringify(row));
        // #214: kwota jako osobna liczba, nie podciąg losowego identyfikatora.
        assert.ok(!/(?<![\w-])(?:2500|5000)(?![\w-])/.test(res.text), res.text);
      } else {
        assert.equal(res.status, 403);
      }
    }
    const rep = await call(`/api/print/cards?schoolYearId=${YEAR}&classId=c-1a`, { cookie: cookies.rep1a });
    assert.equal(rep.status, 200);
    assert.deepEqual(rep.body.rows.map((row) => row.householdId), ['h-a', 'h-c']);
    // Przedstawiciel nie widzi też rodzeństwa z innej klasy (h-b).
    assert.ok(!rep.text.includes('h-b'));
  } finally { await db.close(); }
});

test('raport KR: wpłata podzielona nie zawyża sum wpłat (pełna kwota wpłaty nie trafia do „zaksięgowanych”); brak części rodzin w raporcie', async () => {
  const { db, cookies, call } = await setup();
  try {
    const fetchChecks = async () => {
      const res = await call(`/api/reports/audit?schoolYearId=${YEAR}`, { cookie: cookies.audit });
      assert.equal(res.status, 200, res.text);
      return { res, checks: Object.fromEntries(res.body.report.checks.items.map((item) => [item.id, item])) };
    };
    // Zaksięgowana wpłata bez wpisu księgi: 30,00 EUR (h-c).
    await createPayment(call, cookies.treasurer, { amountCents: 3000, householdId: 'h-c' });
    const before = (await fetchChecks()).checks.payments_in_ledger;
    assert.equal(before.paymentsNetCents, 3000);
    assert.equal(before.paymentsWithoutLedgerEntry, 1);

    // Przelew zbiorczy 50,00 EUR z korektą 10,00 i częściami 25,00 + 10,00.
    const paymentId = await createPayment(call, cookies.treasurer, { amountCents: 5000 });
    await call(`/api/payments/${paymentId}/corrections`, {
      cookie: cookies.treasurer, idempotencyKey: key('cor'), body: { amountCents: 1000, reason: 'Korekta syntetyczna' },
    });
    await allocate(call, cookies.treasurer, paymentId, 'h-a', 2500);
    await allocate(call, cookies.treasurer, paymentId, 'h-b', 1000);

    const { res, checks } = await fetchChecks();
    // Wpłata podzielona jest „nieprzypisana” (status unmatched): ani pełna kwota (5000/4000),
    // ani części (3500) nie zwiększają sumy wpłat zaksięgowanych — suma jak przed podziałem.
    assert.equal(checks.payments_in_ledger.paymentsNetCents, 3000);
    assert.equal(checks.payments_in_ledger.paymentsWithoutLedgerEntry, 1);
    assert.equal(checks.payments_in_ledger.ledgerLinkedNetCents, 0);
    // Raport nie ujawnia identyfikatorów rodzin ani kwot części.
    assert.ok(!/h-a|h-b|2500/.test(res.text.replace(/"id":"[^"]*"/g, '')), 'identyfikatory rodzin w raporcie');
    assert.ok(!/dłużnik/i.test(res.text));

    // Części w bazie: 25,00 + 10,00 (nieprzypisane 5,00 zostaje do wyjaśnienia).
    const rows = (await db.query(
      `SELECT COALESCE(sum(a.amount_cents), 0)::int AS allocated FROM payment_allocations_current a WHERE a.payment_entry_id = $1`, [paymentId],
    )).rows;
    assert.equal(rows[0].allocated, 3500);
  } finally { await db.close(); }
});
