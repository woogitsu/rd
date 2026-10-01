// #208 (dalsza część): testy z barierą na PRAWDZIWYM PostgreSQL dla blokad
// `FOR UPDATE` w ścieżkach finansowych, których nie obejmuje
// tests/pg-real-double-click.test.js: zwroty wpłat, części wpłaty
// (payment_allocations), cofnięcie części, ponowne przypisanie wpłaty i storno
// przeniesienia kasa ↔ rachunek. Wzorzec jak w pg-real-double-click: pierwsze
// żądanie staje W TRANSAKCJI po zapisie (bariera z tests/helpers/pg-barrier.js),
// drugie startuje osobnym połączeniem, test sprawdza w pg_stat_activity, że
// czeka na blokadę z kodu trasy (tekst czekającego zapytania), i dopiero
// wtedy pierwsze zatwierdza. Transakcje biegną z `retries: 0`.
//
// Kontrola mutacyjna: scripts/check-lock-mutations.js usuwa `FOR UPDATE` z danej
// funkcji trasy; bez niego drugie żądanie nie czeka już na blokadę z API
// (przechodzi dalej i staje dopiero na INSERT / triggerze), więc asercja
// `assertWaitsOn` robi się czerwona. Część ścieżek ma drugą warstwę w bazie
// (trigger payment_allocation_guard, unikalność storna) — ostateczny stan
// danych byłby ten sam, dlatego test sprawdza punkt serializacji w kodzie.
//
// Plik działa wyłącznie z RD_TEST_PG_URL (npm run test:pg-real). Wyłącznie
// dane syntetyczne (@example.invalid); nic nie wysyła e-maili.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRealTestDb, seedEnrolledHousehold, seedSchoolYear, seedUserSession } from './helpers/pg.js';
import { barrierEnv, callApi, countRows, waitForLockWaitersWithQuery } from './helpers/pg-barrier.js';

const skip = process.env.RD_TEST_PG_URL ? false : 'brak RD_TEST_PG_URL (wymaga prawdziwego PostgreSQL)';
const YEAR = 'y-2026';
let seq = 0;
const key = (prefix) => `${prefix}-${String(++seq).padStart(6, '0')}-${crypto.randomUUID().slice(0, 8)}`;
const count = (db, sql, params) => countRows(db, sql, params);
const auditCount = (db, action) => count(db, 'SELECT count(*)::int AS n FROM audit_events WHERE action = $1', [action]);

function assertWaitsOn({ waits, waitingSql }, pattern, message) {
  assert.equal(waits.length, 1, `${message}: ${JSON.stringify(waits)}`);
  assert.match(waitingSql, pattern, `${message} — czekające zapytanie: ${waitingSql}`);
}

async function withReal(fn) {
  const db = await createRealTestDb();
  try { return await fn(db); } finally { await db.close(); }
}

async function race(db, { pauseAfter, first, others }) {
  const errors = [];
  const gated = barrierEnv(db, { pauseAfter, errors });
  const a = first(gated.env);
  await gated.reached;
  const plainEnv = barrierEnv(db, { errors }).env;
  const pending = others.map((start) => start(plainEnv));
  let waiters = [];
  try { waiters = await waitForLockWaitersWithQuery(db, pending.length); } finally { gated.release(); }
  const results = await Promise.all([a, ...pending]);
  return { results, errors, waits: waiters.map((w) => w.event), waitingSql: waiters.map((w) => w.query).join('\n') };
}

async function setup(db, { households = ['h1', 'h2'] } = {}) {
  await seedSchoolYear(db, YEAR);
  for (const household of households) await seedEnrolledHousehold(db, household, [YEAR]);
  return seedUserSession(db, { userId: 'u-tr', mfa: true, roles: [{ role: 'treasurer', schoolYearId: YEAR }] });
}
const paymentBody = (patch = {}) => ({
  schoolYearId: YEAR, householdId: 'h1', amountCents: 10000, receivedOn: '2026-10-05', method: 'bank', reference: 'Składka syntetyczna', ...patch,
});
const createPayment = async (db, cookie, patch) => (await callApi({ db }, 'POST', '/api/payments', cookie, paymentBody(patch), key('pay'))).body.payment;
const netCents = async (db, id) => Number((await db.query('SELECT net_amount_cents FROM payment_entry_net WHERE id = $1', [id])).rows[0].net_amount_cents);
const refundBody = (patch = {}) => ({ amountCents: 7000, refundedOn: '2026-10-06', method: 'bank', reason: 'Zwrot syntetyczny', ...patch });
const FOR_UPDATE_PAYMENT = /FROM payment_entries WHERE id = \$1 FOR UPDATE/;

test('#208 (bariera): dwa zwroty wpłaty 70 + 70 € przy 100 € — drugi czeka na blokadę wpłaty i dostaje 409 refund_exceeds_remaining_amount', { skip }, async () => {
  await withReal(async (db) => {
    const cookie = await setup(db);
    const payment = await createPayment(db, cookie);
    const path = `/api/payments/${payment.id}/refunds`;
    const { results: [a, b], waits, waitingSql, errors } = await race(db, {
      pauseAfter: /INSERT INTO payment_refunds/,
      first: (env) => callApi(env, 'POST', path, cookie, refundBody({ reason: 'Pierwszy zwrot syntetyczny' }), key('rf')),
      others: [(env) => callApi(env, 'POST', path, cookie, refundBody({ reason: 'Drugi zwrot syntetyczny' }), key('rf'))],
    });
    assertWaitsOn({ waits, waitingSql }, FOR_UPDATE_PAYMENT, 'drugi zwrot czeka na blokadę wpłaty');
    assert.equal(a.status, 201, JSON.stringify(a.body));
    assert.deepEqual([b.status, b.body.error], [409, 'refund_exceeds_remaining_amount']);
    assert.deepEqual(errors, []);
    assert.equal(await count(db, 'SELECT count(*)::int AS n FROM payment_refunds'), 1);
    assert.equal(await netCents(db, payment.id), 3000);
    assert.equal(await auditCount(db, 'payment.refund.created'), 1);
  });
});

test('#208 (bariera): korekta 70 € i zwrot 70 € tej samej wpłaty 100 € — wspólna blokada wiersza wpłaty, druga operacja dostaje 409', { skip }, async () => {
  await withReal(async (db) => {
    const cookie = await setup(db);
    const payment = await createPayment(db, cookie);
    const { results: [a, b], waits, waitingSql } = await race(db, {
      pauseAfter: /INSERT INTO payment_corrections/,
      first: (env) => callApi(env, 'POST', `/api/payments/${payment.id}/corrections`, cookie, { amountCents: 7000, reason: 'Korekta syntetyczna' }, key('pc')),
      others: [(env) => callApi(env, 'POST', `/api/payments/${payment.id}/refunds`, cookie, refundBody(), key('rf'))],
    });
    assertWaitsOn({ waits, waitingSql }, FOR_UPDATE_PAYMENT, 'zwrot czeka na blokadę wpłaty trzymaną przez korektę');
    assert.equal(a.status, 201, JSON.stringify(a.body));
    assert.deepEqual([b.status, b.body.error], [409, 'refund_exceeds_remaining_amount']);
    assert.equal(await count(db, 'SELECT count(*)::int AS n FROM payment_refunds'), 0);
    assert.equal(await netCents(db, payment.id), 3000);
  });
});

test('#208 (bariera): ponowne przypisanie wpłaty do tego samego gospodarstwa dwa razy — drugie czeka na blokadę wpłaty i dostaje 409 payment_reassignment_same_household', { skip }, async () => {
  await withReal(async (db) => {
    const cookie = await setup(db);
    const payment = await createPayment(db, cookie);
    const path = `/api/payments/${payment.id}/reassignment`;
    const { results: [a, b], waits, waitingSql, errors } = await race(db, {
      pauseAfter: /INSERT INTO payment_reassignments/,
      first: (env) => callApi(env, 'POST', path, cookie, { householdId: 'h2', reason: 'Pierwsze przeksięgowanie syntetyczne' }, key('ra')),
      others: [(env) => callApi(env, 'POST', path, cookie, { householdId: 'h2', reason: 'Drugie przeksięgowanie syntetyczne' }, key('ra'))],
    });
    assertWaitsOn({ waits, waitingSql }, FOR_UPDATE_PAYMENT, 'drugie przeksięgowanie czeka na blokadę wpłaty');
    assert.equal(a.status, 201, JSON.stringify(a.body));
    assert.deepEqual([b.status, b.body.error], [409, 'payment_reassignment_same_household']);
    assert.deepEqual(errors, []);
    assert.equal((await db.query('SELECT household_id FROM payment_entries WHERE id = $1', [payment.id])).rows[0].household_id, 'h2');
    assert.equal(await count(db, 'SELECT count(*)::int AS n FROM payment_reassignments'), 1);
    assert.equal(await auditCount(db, 'payment.reassigned'), 1);
  });
});

test('#208 (bariera): dwie części wpłaty 70 + 70 € przy 100 € — druga czeka na blokadę wpłaty i nie zostaje zapis ponad kwotę', { skip }, async () => {
  await withReal(async (db) => {
    const cookie = await setup(db);
    const payment = await createPayment(db, cookie, { householdId: null });
    const path = `/api/payments/${payment.id}/allocations`;
    const { results: [a, b], waits, waitingSql } = await race(db, {
      pauseAfter: /INSERT INTO payment_allocations/,
      first: (env) => callApi(env, 'POST', path, cookie, { householdId: 'h1', amountCents: 7000 }, key('al')),
      others: [(env) => callApi(env, 'POST', path, cookie, { householdId: 'h2', amountCents: 7000 }, key('al'))],
    });
    assertWaitsOn({ waits, waitingSql }, FOR_UPDATE_PAYMENT, 'druga część czeka na blokadę wpłaty');
    assert.equal(a.status, 201, JSON.stringify(a.body));
    assert.equal(b.status, 409, JSON.stringify(b.body));
    assert.equal(await count(db, 'SELECT count(*)::int AS n FROM payment_allocations'), 1);
    assert.equal(await auditCount(db, 'payment.allocation.created'), 1);
  });
});

test('#208 (bariera): cofnięcie części 100 € i nowa część 100 € — nowa czeka na blokadę wpłaty i po cofnięciu przechodzi', { skip }, async () => {
  await withReal(async (db) => {
    const cookie = await setup(db);
    const payment = await createPayment(db, cookie, { householdId: null });
    const path = `/api/payments/${payment.id}/allocations`;
    const first = await callApi({ db }, 'POST', path, cookie, { householdId: 'h1', amountCents: 10000 }, key('al'));
    assert.equal(first.status, 201, JSON.stringify(first.body));
    const { results: [a, b], waits, waitingSql } = await race(db, {
      pauseAfter: /INSERT INTO payment_allocation_reversals/,
      first: (env) => callApi(env, 'POST', `${path}/${first.body.allocation.id}/reversal`, cookie, { reason: 'Błędna część syntetyczna' }, key('ar')),
      others: [(env) => callApi(env, 'POST', path, cookie, { householdId: 'h2', amountCents: 10000 }, key('al'))],
    });
    assertWaitsOn({ waits, waitingSql }, FOR_UPDATE_PAYMENT, 'nowa część czeka na blokadę wpłaty trzymaną przez cofnięcie');
    assert.equal(a.status, 201, JSON.stringify(a.body));
    assert.equal(b.status, 201, JSON.stringify(b.body));
    assert.equal(await count(db, 'SELECT count(*)::int AS n FROM payment_allocations'), 2);
    assert.equal(await count(db, 'SELECT count(*)::int AS n FROM payment_allocation_reversals'), 1);
  });
});

test('#208 (bariera): dwa cofnięcia tej samej części różnymi kluczami — drugie czeka na blokadę wpłaty i dostaje 409 payment_allocation_already_reversed', { skip }, async () => {
  await withReal(async (db) => {
    const cookie = await setup(db);
    const payment = await createPayment(db, cookie, { householdId: null });
    const path = `/api/payments/${payment.id}/allocations`;
    const allocation = await callApi({ db }, 'POST', path, cookie, { householdId: 'h1', amountCents: 4000 }, key('al'));
    assert.equal(allocation.status, 201, JSON.stringify(allocation.body));
    const reversal = `${path}/${allocation.body.allocation.id}/reversal`;
    const { results: [a, b], waits, waitingSql, errors } = await race(db, {
      pauseAfter: /INSERT INTO payment_allocation_reversals/,
      first: (env) => callApi(env, 'POST', reversal, cookie, { reason: 'Pierwsze cofnięcie syntetyczne' }, key('ar')),
      others: [(env) => callApi(env, 'POST', reversal, cookie, { reason: 'Drugie cofnięcie syntetyczne' }, key('ar'))],
    });
    assertWaitsOn({ waits, waitingSql }, FOR_UPDATE_PAYMENT, 'drugie cofnięcie czeka na blokadę wpłaty');
    assert.equal(a.status, 201, JSON.stringify(a.body));
    assert.deepEqual([b.status, b.body.error], [409, 'payment_allocation_already_reversed']);
    assert.deepEqual(errors, [], 'odmowa z kodu trasy, nie z indeksu unikalnego (23505)');
    assert.equal(await count(db, 'SELECT count(*)::int AS n FROM payment_allocation_reversals'), 1);
    assert.equal(await auditCount(db, 'payment.allocation.reversed'), 1);
  });
});

test('#208 (bariera): dwa storna tego samego przeniesienia kasa → rachunek — drugie czeka na blokadę przeniesienia i dostaje 409 transfer_already_reversed', { skip }, async () => {
  await withReal(async (db) => {
    const cookie = await setup(db, { households: [] });
    const created = await callApi({ db }, 'POST', '/api/ledger/transfers', cookie, {
      schoolYearId: YEAR, direction: 'cash_to_bank', amountCents: 3000, transferredOn: '2026-09-25', description: 'Wpłata gotówki na rachunek',
    }, key('tr'));
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const reversesId = created.body.transfer.id;
    const { results: [a, b], waits, waitingSql } = await race(db, {
      pauseAfter: /INSERT INTO ledger_transfers/,
      first: (env) => callApi(env, 'POST', '/api/ledger/transfers', cookie, { schoolYearId: YEAR, reversesId, description: 'Storno pierwsze' }, key('tr')),
      others: [(env) => callApi(env, 'POST', '/api/ledger/transfers', cookie, { schoolYearId: YEAR, reversesId, description: 'Storno drugie' }, key('tr'))],
    });
    assertWaitsOn({ waits, waitingSql }, /FROM ledger_transfers WHERE id = \$1 FOR UPDATE/, 'drugie storno czeka na blokadę przeniesienia');
    assert.equal(a.status, 201, JSON.stringify(a.body));
    assert.deepEqual([b.status, b.body.error], [409, 'transfer_already_reversed']);
    assert.equal(await count(db, 'SELECT count(*)::int AS n FROM ledger_transfers WHERE reverses_id = $1', [reversesId]), 1);
    assert.equal(await auditCount(db, 'ledger.transfer.reversed'), 1);
  });
});

// Przeksięgowanie wpisu księgi (ledger.js, createReplacement): storno pozostałej
// kwoty + wpis zastępczy w jednej transakcji pod `FOR UPDATE` zastępowanego wpisu.
async function ledgerEntrySetup(db) {
  const cookie = await setup(db, { households: [] });
  await db.query("INSERT INTO ledger_categories (id, school_year_id, direction, name, created_by) VALUES ('cat-in', $1, 'income', 'Składki dobrowolne', 'u-tr')", [YEAR]);
  await db.query(`INSERT INTO ledger_entries (id, school_year_id, direction, amount_cents, category_id, description, occurred_on, method, created_by, idempotency_key)
    VALUES ('le-1', $1, 'income', 10000, 'cat-in', 'Wpis syntetyczny', '2026-10-01', 'bank', 'u-tr', 'le-1-key-0001')`, [YEAR]);
  return cookie;
}
const replacementBody = (description) => ({
  schoolYearId: YEAR, direction: 'income', amountCents: 10000, categoryId: 'cat-in', description, occurredOn: '2026-10-02', method: 'bank', reason: 'Przeksięgowanie syntetyczne',
});
const FOR_UPDATE_LEDGER_ENTRY = /FROM ledger_entries WHERE id = \$1 FOR UPDATE/;

test('#208 (bariera): dwa przeksięgowania tego samego wpisu księgi różnymi kluczami — drugie czeka na blokadę wpisu i dostaje 409 ledger_entry_already_replaced', { skip }, async () => {
  await withReal(async (db) => {
    const cookie = await ledgerEntrySetup(db);
    const { results: [a, b], waits, waitingSql, errors } = await race(db, {
      pauseAfter: /INSERT INTO ledger_entries/,
      first: (env) => callApi(env, 'POST', '/api/ledger/le-1/replacement', cookie, replacementBody('Zastępczy pierwszy'), key('lr')),
      others: [(env) => callApi(env, 'POST', '/api/ledger/le-1/replacement', cookie, replacementBody('Zastępczy drugi'), key('lr'))],
    });
    assertWaitsOn({ waits, waitingSql }, FOR_UPDATE_LEDGER_ENTRY, 'drugie przeksięgowanie czeka na blokadę wpisu');
    assert.equal(a.status, 201, JSON.stringify(a.body));
    assert.deepEqual([b.status, b.body.error], [409, 'ledger_entry_already_replaced']);
    assert.deepEqual(errors, []);
    assert.equal(await count(db, "SELECT count(*)::int AS n FROM ledger_entries WHERE replaces_entry_id = 'le-1'"), 1);
    assert.equal(await count(db, "SELECT count(*)::int AS n FROM ledger_corrections WHERE ledger_entry_id = 'le-1'"), 1);
    assert.equal(await auditCount(db, 'ledger.entry.replaced'), 1);
  });
});

test('#208 (bariera): przeksięgowanie i korekta 10 € tego samego wpisu księgi — korekta czeka na blokadę wpisu i dostaje 409 correction_exceeds_remaining_amount', { skip }, async () => {
  await withReal(async (db) => {
    const cookie = await ledgerEntrySetup(db);
    const { results: [a, b], waits, waitingSql, errors } = await race(db, {
      pauseAfter: /INSERT INTO ledger_entries/,
      first: (env) => callApi(env, 'POST', '/api/ledger/le-1/replacement', cookie, replacementBody('Zastępczy wpis'), key('lr')),
      others: [(env) => callApi(env, 'POST', '/api/ledger/le-1/corrections', cookie, { amountCents: 1000, reason: 'Korekta syntetyczna' }, key('lc'))],
    });
    assertWaitsOn({ waits, waitingSql }, FOR_UPDATE_LEDGER_ENTRY, 'korekta czeka na blokadę wpisu trzymaną przez przeksięgowanie');
    assert.equal(a.status, 201, JSON.stringify(a.body));
    assert.deepEqual([b.status, b.body.error], [409, 'correction_exceeds_remaining_amount']);
    assert.deepEqual(errors, []);
    assert.equal(await count(db, "SELECT COALESCE(sum(amount_cents), 0)::int AS n FROM ledger_corrections WHERE ledger_entry_id = 'le-1'"), 10000);
    assert.equal(await auditCount(db, 'ledger.correction.created'), 0);
  });
});
