// Spójność wpłata <-> księga, zwroty i ponowne przypisanie (#138).
// Wyłącznie dane syntetyczne (@example.invalid). PGlite w pamięci.
import test from 'node:test';
import assert from 'node:assert/strict';
import { handlePgRequest } from '../src/pg/app.js';
import { createTestDb, seedEnrolledHousehold, seedSchoolYear, seedUserSession, TEST_ORIGIN } from './helpers/pg.js';

const YEAR = 'y-138';

function req(path, { cookie, method, body, key } = {}) {
  const headers = new Headers();
  if (cookie) headers.set('Cookie', cookie);
  const upper = method ?? (body !== undefined ? 'POST' : 'GET');
  if (upper !== 'GET') headers.set('Origin', TEST_ORIGIN);
  if (key) headers.set('Idempotency-Key', key);
  if (body !== undefined) headers.set('Content-Type', 'application/json');
  return new Request(`${TEST_ORIGIN}${path}`, {
    method: upper, headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function readJson(response) {
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

async function setup() {
  const db = await createTestDb();
  await seedSchoolYear(db, YEAR, { startsOn: '2026-09-01', endsOn: '2027-08-31' });
  for (const householdId of ['h1', 'h2']) await seedEnrolledHousehold(db, householdId, [YEAR]);
  const cookie = await seedUserSession(db, { userId: 'u-treasurer', mfa: true, roles: [{ role: 'treasurer', schoolYearId: YEAR }] });
  await db.query(
    `INSERT INTO ledger_categories (id, school_year_id, direction, name, created_by)
     VALUES ('cat-in', $1, 'income', 'Składki', 'u-treasurer')`,
    [YEAR],
  );
  const env = { db };
  const fetch = (request) => handlePgRequest(request, env);
  return { db, cookie, fetch };
}

async function createPayment(fetch, cookie, { amountCents, key, householdId = 'h1' }) {
  const res = await readJson(await fetch(req('/api/payments', {
    cookie, key,
    body: { schoolYearId: YEAR, householdId, amountCents, receivedOn: '2026-10-01', method: 'bank', reference: 'Wpłata syntetyczna' },
  })));
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body.payment.id;
}

async function linkLedgerEntry(fetch, cookie, { paymentEntryId, amountCents, key }) {
  return readJson(await fetch(req('/api/ledger', {
    cookie, key,
    body: {
      schoolYearId: YEAR, direction: 'income', amountCents, categoryId: 'cat-in',
      description: 'Ujęcie wpłaty w księdze', occurredOn: '2026-10-01', method: 'bank', paymentEntryId,
    },
  })));
}

test('wpis księgi z kwotą inną niż netto wpłaty jest odrzucany (422)', async () => {
  const { db, cookie, fetch } = await setup();
  try {
    const paymentId = await createPayment(fetch, cookie, { amountCents: 2500, key: 'k-pay-mismatch-001' });
    const res = await linkLedgerEntry(fetch, cookie, { paymentEntryId: paymentId, amountCents: 25000, key: 'k-led-mismatch-001' });
    assert.equal(res.status, 422);
    assert.equal(res.body.error, 'payment_amount_mismatch');
    assert.equal(await db.query('SELECT count(*)::int AS n FROM ledger_entries').then((r) => r.rows[0].n), 0);
  } finally { await db.close(); }
});

test('wpis księgi z kwotą równą netto wpłaty jest przyjęty', async () => {
  const { db, cookie, fetch } = await setup();
  try {
    const paymentId = await createPayment(fetch, cookie, { amountCents: 2500, key: 'k-pay-match-001' });
    const res = await linkLedgerEntry(fetch, cookie, { paymentEntryId: paymentId, amountCents: 2500, key: 'k-led-match-001' });
    assert.equal(res.status, 201, JSON.stringify(res.body));
  } finally { await db.close(); }
});

test('korekta wpłaty powiązanej z księgą jest blokowana, dopóki wpis księgi nie zostanie skorygowany o tę samą kwotę', async () => {
  const { db, cookie, fetch } = await setup();
  try {
    const paymentId = await createPayment(fetch, cookie, { amountCents: 4000, key: 'k-pay-corr-001' });
    const linked = await linkLedgerEntry(fetch, cookie, { paymentEntryId: paymentId, amountCents: 4000, key: 'k-led-corr-001' });
    assert.equal(linked.status, 201);
    const ledgerEntryId = linked.body.entry.id;

    // Korekta wpłaty przed korektą księgi -> zablokowana.
    const blocked = await readJson(await fetch(req(`/api/payments/${paymentId}/corrections`, {
      cookie, key: 'k-corr-pay-blocked-001', body: { amountCents: 1500, reason: 'Pomyłka w kwocie' },
    })));
    assert.equal(blocked.status, 409);
    assert.equal(blocked.body.error, 'ledger_correction_required');
    assert.equal(await db.query('SELECT count(*)::int AS n FROM payment_corrections').then((r) => r.rows[0].n), 0);

    // Najpierw korekta księgi o tę samą kwotę.
    const ledgerCorr = await readJson(await fetch(req(`/api/ledger/${ledgerEntryId}/corrections`, {
      cookie, key: 'k-corr-ledger-001', body: { amountCents: 1500, reason: 'Zgodna korekta księgi' },
    })));
    assert.equal(ledgerCorr.status, 201, JSON.stringify(ledgerCorr.body));

    // Teraz korekta wpłaty przechodzi.
    const ok = await readJson(await fetch(req(`/api/payments/${paymentId}/corrections`, {
      cookie, key: 'k-corr-pay-ok-001', body: { amountCents: 1500, reason: 'Pomyłka w kwocie' },
    })));
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
  } finally { await db.close(); }
});

test('zwrot: podwójny przelew tej samej rodziny zostaje jako dwie wpłaty; zwrot jednej po prośbie rodziny', async () => {
  const { db, cookie, fetch } = await setup();
  try {
    const p1 = await createPayment(fetch, cookie, { amountCents: 5000, key: 'k-pay-dup-001' });
    const p2 = await createPayment(fetch, cookie, { amountCents: 5000, key: 'k-pay-dup-002' });
    assert.notEqual(p1, p2);
    const refund = await readJson(await fetch(req(`/api/payments/${p2}/refunds`, {
      cookie, key: 'k-refund-dup-001',
      body: { amountCents: 5000, refundedOn: '2026-10-05', method: 'bank', reason: 'Rodzina poprosiła o zwrot nadpłaty' },
    })));
    assert.equal(refund.status, 201, JSON.stringify(refund.body));
    const listed = await readJson(await fetch(req(`/api/payments?schoolYearId=${YEAR}`, { cookie })));
    const row2 = listed.body.payments.find((entry) => entry.id === p2);
    assert.equal(row2.netAmountCents, 0);
    const row1 = listed.body.payments.find((entry) => entry.id === p1);
    assert.equal(row1.netAmountCents, 5000);
  } finally { await db.close(); }
});

test('zwrot większy niż kwota netto jest odrzucony; dwa równoległe zwroty — jeden odrzucony (PGlite: po kolei, nie wyścig)', async () => {
  const { db, cookie, fetch } = await setup();
  try {
    const paymentId = await createPayment(fetch, cookie, { amountCents: 3000, key: 'k-pay-refund-cap-001' });
    const tooBig = await readJson(await fetch(req(`/api/payments/${paymentId}/refunds`, {
      cookie, key: 'k-refund-cap-001',
      body: { amountCents: 3001, refundedOn: '2026-10-05', method: 'bank', reason: 'Zwrot ponad kwotę' },
    })));
    assert.equal(tooBig.status, 409);
    assert.equal(tooBig.body.error, 'refund_exceeds_remaining_amount');

    const [first, second] = await Promise.all([
      fetch(req(`/api/payments/${paymentId}/refunds`, {
        cookie, key: 'k-refund-race-001',
        body: { amountCents: 2000, refundedOn: '2026-10-05', method: 'bank', reason: 'Zwrot A' },
      })),
      fetch(req(`/api/payments/${paymentId}/refunds`, {
        cookie, key: 'k-refund-race-002',
        body: { amountCents: 2000, refundedOn: '2026-10-05', method: 'bank', reason: 'Zwrot B' },
      })),
    ]);
    const statuses = [(await readJson(first)).status, (await readJson(second)).status].sort();
    assert.deepEqual(statuses, [201, 409]);
  } finally { await db.close(); }
});

test('podwójne kliknięcie zwrotu (ten sam klucz) i ponowienie żądania zwracają ten sam zapis', async () => {
  const { db, cookie, fetch } = await setup();
  try {
    const paymentId = await createPayment(fetch, cookie, { amountCents: 3000, key: 'k-pay-refund-idem-001' });
    const body = { amountCents: 500, refundedOn: '2026-10-05', method: 'bank', reason: 'Zwrot idempotentny' };
    const first = await readJson(await fetch(req(`/api/payments/${paymentId}/refunds`, { cookie, key: 'k-refund-idem-001', body })));
    assert.equal(first.status, 201);
    const replay = await readJson(await fetch(req(`/api/payments/${paymentId}/refunds`, { cookie, key: 'k-refund-idem-001', body })));
    assert.equal(replay.status, 200);
    assert.equal(replay.body.refund.id, first.body.refund.id);
    assert.equal(await db.query('SELECT count(*)::int AS n FROM payment_refunds').then((r) => r.rows[0].n), 1);
  } finally { await db.close(); }
});

test('błędne przypisanie do rodzeństwa w innym gospodarstwie: ponowne przypisanie, sumy obu gospodarstw poprawne', async () => {
  const { db, cookie, fetch } = await setup();
  try {
    const paymentId = await createPayment(fetch, cookie, { amountCents: 6000, key: 'k-pay-reassign-001', householdId: 'h1' });
    const reassign = await readJson(await fetch(req(`/api/payments/${paymentId}/reassignment`, {
      cookie, key: 'k-reassign-001',
      body: { householdId: 'h2', reason: 'Wpłata trafiła do niewłaściwego rodzeństwa' },
    })));
    assert.equal(reassign.status, 201, JSON.stringify(reassign.body));
    const totals = await db.query(
      `SELECT household_id, sum(net_amount_cents)::int AS total FROM payment_entry_net
        WHERE school_year_id = $1 AND status = 'recorded' GROUP BY household_id`,
      [YEAR],
    );
    const byHousehold = Object.fromEntries(totals.rows.map((row) => [row.household_id, row.total]));
    assert.equal(byHousehold.h1 ?? 0, 0);
    assert.equal(byHousehold.h2, 6000);
    // Historia zostaje: zdarzenie ponownego przypisania jest widoczne.
    const history = await db.query('SELECT old_household_id, new_household_id FROM payment_reassignments WHERE payment_entry_id = $1', [paymentId]);
    assert.equal(history.rows.length, 1);
    assert.equal(history.rows[0].old_household_id, 'h1');
    assert.equal(history.rows[0].new_household_id, 'h2');
  } finally { await db.close(); }
});

test('dwoje opiekunów zapłaciło osobno: brak automatycznego zwrotu ani ostrzeżenia „duplikat”', async () => {
  const { db, cookie, fetch } = await setup();
  try {
    const p1 = await createPayment(fetch, cookie, { amountCents: 4000, key: 'k-pay-two-guardians-001' });
    const p2 = await createPayment(fetch, cookie, { amountCents: 4000, key: 'k-pay-two-guardians-002' });
    const listed = await readJson(await fetch(req(`/api/payments?schoolYearId=${YEAR}`, { cookie })));
    const ids = listed.body.payments.map((entry) => entry.id);
    assert.ok(ids.includes(p1) && ids.includes(p2));
    assert.equal(await db.query('SELECT count(*)::int AS n FROM payment_refunds').then((r) => r.rows[0].n), 0);
  } finally { await db.close(); }
});

test('rola bez dostępu finansowego dostaje 403 na zwrocie i ponownym przypisaniu; brak MFA — odmowa', async () => {
  const { db, cookie, fetch } = await setup();
  try {
    const paymentId = await createPayment(fetch, cookie, { amountCents: 1000, key: 'k-pay-forbidden-001' });
    const repCookie = await seedUserSession(db, { userId: 'u-rep', roles: [{ role: 'representative', schoolYearId: YEAR, classId: 'kl-x' }] });
    const noMfaCookie = await seedUserSession(db, { userId: 'u-treasurer-nomfa', mfa: false, roles: [{ role: 'treasurer', schoolYearId: YEAR }] });

    const asRep = await readJson(await fetch(req(`/api/payments/${paymentId}/refunds`, {
      cookie: repCookie, key: 'k-refund-forbidden-001',
      body: { amountCents: 100, refundedOn: '2026-10-05', method: 'bank', reason: 'Test uprawnień' },
    })));
    assert.equal(asRep.status, 403);

    const asNoMfa = await readJson(await fetch(req(`/api/payments/${paymentId}/reassignment`, {
      cookie: noMfaCookie, key: 'k-reassign-forbidden-001',
      body: { householdId: 'h2', reason: 'Test MFA' },
    })));
    assert.equal(asNoMfa.status, 403);
  } finally { await db.close(); }
});

test('ponowienie udanego przypisania (ten sam klucz i treść) zwraca zapisany wynik zamiast fałszywego 409 (#138)', async () => {
  const { db, cookie, fetch } = await setup();
  try {
    const paymentId = await createPayment(fetch, cookie, { amountCents: 6000, key: 'k-pay-reassign-replay-001', householdId: 'h1' });
    const path = `/api/payments/${paymentId}/reassignment`;
    const body = { householdId: 'h2', reason: 'Wpłata trafiła do niewłaściwego rodzeństwa' };
    const first = await fetch(req(path, { cookie, key: 'k-reassign-replay-001', body }));
    assert.equal(first.status, 201);
    const created = (await readJson(first)).body;

    // Podwójne kliknięcie / ponowienie po sukcesie: bieżące household_id to już h2.
    const replay = await fetch(req(path, { cookie, key: 'k-reassign-replay-001', body }));
    assert.equal(replay.status, 200);
    assert.equal(replay.headers.get('Idempotency-Replayed'), 'true');
    assert.deepEqual((await readJson(replay)).body, created);
    assert.equal(created.reassignment.oldHouseholdId, 'h1');

    // Ten sam klucz z inną treścią albo od innej osoby to nadal konflikt.
    const otherReason = await readJson(await fetch(req(path, { cookie, key: 'k-reassign-replay-001', body: { ...body, reason: 'Inny powód niż poprzednio' } })));
    assert.deepEqual([otherReason.status, otherReason.body], [409, { error: 'idempotency_conflict' }]);
    const otherHousehold = await readJson(await fetch(req(path, { cookie, key: 'k-reassign-replay-001', body: { ...body, householdId: 'h1' } })));
    assert.deepEqual([otherHousehold.status, otherHousehold.body], [409, { error: 'idempotency_conflict' }]);
    const otherCookie = await seedUserSession(db, { userId: 'u-treasurer-2', mfa: true, roles: [{ role: 'treasurer', schoolYearId: YEAR }] });
    const otherActor = await readJson(await fetch(req(path, { cookie: otherCookie, key: 'k-reassign-replay-001', body })));
    assert.deepEqual([otherActor.status, otherActor.body], [409, { error: 'idempotency_conflict' }]);
    // Ten sam klucz dla innej wpłaty to też konflikt.
    const otherPaymentId = await createPayment(fetch, cookie, { amountCents: 1000, key: 'k-pay-reassign-replay-002', householdId: 'h1' });
    const otherPayment = await readJson(await fetch(req(`/api/payments/${otherPaymentId}/reassignment`, { cookie, key: 'k-reassign-replay-001', body })));
    assert.deepEqual([otherPayment.status, otherPayment.body], [409, { error: 'idempotency_conflict' }]);

    // Nowy klucz do tego samego gospodarstwa: wpłata już tam jest.
    const again = await readJson(await fetch(req(path, { cookie, key: 'k-reassign-replay-002', body })));
    assert.deepEqual([again.status, again.body], [409, { error: 'payment_reassignment_same_household' }]);

    assert.equal(await db.query('SELECT count(*)::int AS n FROM payment_reassignments').then((r) => r.rows[0].n), 1);
    assert.equal(await db.query("SELECT count(*)::int AS n FROM audit_events WHERE action = 'payment.reassigned'").then((r) => r.rows[0].n), 1);
  } finally { await db.close(); }
});

test('równoległe ponowienie ponownego przypisania (podwójne kliknięcie): jeden zapis i jedno odtworzenie (PGlite: po kolei, nie wyścig)', async () => {
  const { db, cookie, fetch } = await setup();
  try {
    const paymentId = await createPayment(fetch, cookie, { amountCents: 6000, key: 'k-pay-reassign-par-001', householdId: 'h1' });
    const send = () => fetch(req(`/api/payments/${paymentId}/reassignment`, {
      cookie, key: 'k-reassign-par-001', body: { householdId: 'h2', reason: 'Równoległe kliknięcie' },
    })).then(readJson);
    const results = await Promise.all([send(), send()]);
    assert.deepEqual(results.map((r) => r.status).sort(), [200, 201]);
    assert.equal(results[0].body.reassignment.id, results[1].body.reassignment.id);
    assert.equal(await db.query('SELECT count(*)::int AS n FROM payment_reassignments').then((r) => r.rows[0].n), 1);
  } finally { await db.close(); }
});

async function createUnassignedPayment(fetch, cookie, key) {
  const res = await readJson(await fetch(req('/api/payments', {
    cookie, key,
    body: { schoolYearId: YEAR, amountCents: 2500, receivedOn: '2026-10-01', method: 'bank', reference: 'Wpłata syntetyczna', status: 'unmatched' },
  })));
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body.payment.id;
}

test('przypisanie wpłaty: podwójne kliknięcie równolegle daje zapis i odtworzenie, nie payment_already_assigned (#6)', async () => {
  const { db, cookie, fetch } = await setup();
  try {
    const paymentId = await createUnassignedPayment(fetch, cookie, 'k-pay-assign-par-001');
    const send = () => fetch(req(`/api/payments/${paymentId}/assignment`, {
      cookie, key: 'k-assign-par-0001', body: { householdId: 'h1' },
    })).then(readJson);
    const results = await Promise.all([send(), send(), send()]);
    assert.deepEqual(results.map((r) => r.status).sort(), [200, 200, 201]);
    assert.equal(new Set(results.map((r) => r.body.assignment.id)).size, 1);
    assert.equal(await db.query('SELECT count(*)::int AS n FROM payment_assignments').then((r) => r.rows[0].n), 1);
    assert.equal(await db.query("SELECT count(*)::int AS n FROM audit_events WHERE action = 'payment.assigned'").then((r) => r.rows[0].n), 1);
  } finally { await db.close(); }
});

test('przypisanie wpłaty: wyścig na jednym kluczu przy nieaktualnym odczycie klucza kończy się odtworzeniem lub idempotency_conflict (#6)', async () => {
  const { db, cookie } = await setup();
  try {
    // Symulacja wyścigu na prawdziwym PostgreSQL: drugie żądanie nie widzi jeszcze
    // zatwierdzonego wiersza o tym kluczu (odczyt przed commitem pierwszego), więc
    // dopiero INSERT trafia na unikalny indeks klucza.
    let staleLookups = 0;
    const racingDb = {
      query: (...args) => db.query(...args),
      transaction: (fn) => db.transaction((tx) => fn({
        query: async (text, params) => {
          if (staleLookups > 0 && /FROM payment_assignments WHERE idempotency_key/.test(text)) {
            staleLookups -= 1;
            return { rows: [] };
          }
          return tx.query(text, params);
        },
      })),
    };
    const fetch = (request) => handlePgRequest(request, { db: racingDb });
    const paymentA = await createUnassignedPayment(fetch, cookie, 'k-pay-assign-race-001');
    const paymentB = await createUnassignedPayment(fetch, cookie, 'k-pay-assign-race-002');
    const assign = (paymentId, householdId) => fetch(req(`/api/payments/${paymentId}/assignment`, {
      cookie, key: 'k-assign-race-0001', body: { householdId },
    })).then(readJson);

    assert.equal((await assign(paymentA, 'h1')).status, 201);
    // Ta sama wpłata i treść, zwykły odczyt klucza: odtworzenie zapisanego wyniku.
    const replayed = await assign(paymentA, 'h1');
    assert.equal(replayed.status, 200);
    // Ten sam klucz, inna wpłata: konflikt idempotencji, nie payment_already_assigned.
    staleLookups = 1;
    const otherPayment = await assign(paymentB, 'h1');
    assert.deepEqual([otherPayment.status, otherPayment.body], [409, { error: 'idempotency_conflict' }]);
    // Ten sam klucz, inne gospodarstwo tej samej wpłaty: konflikt idempotencji.
    const otherHousehold = await assign(paymentA, 'h2');
    assert.deepEqual([otherHousehold.status, otherHousehold.body], [409, { error: 'idempotency_conflict' }]);
    // Inny klucz dla już przypisanej wpłaty: prawdziwe payment_already_assigned.
    const late = await readJson(await fetch(req(`/api/payments/${paymentA}/assignment`, {
      cookie, key: 'k-assign-race-0002', body: { householdId: 'h2' },
    })));
    assert.deepEqual([late.status, late.body], [409, { error: 'payment_already_assigned' }]);
    assert.equal(staleLookups, 0);
    assert.equal(await db.query('SELECT count(*)::int AS n FROM payment_assignments').then((r) => r.rows[0].n), 1);
  } finally { await db.close(); }
});
