// #169: zamknięcie roku sprawdza saldo końca roku (ledger_balance_at na ends_on,
// z podziałem gotówka/rachunek) względem bilansu zamknięcia i przy rozbieżności
// wymaga jawnego potwierdzenia z powodem. Wyłącznie dane syntetyczne.
import test from 'node:test';
import assert from 'node:assert/strict';
import { handlePgRequest } from '../src/pg/app.js';
import { CHECKLIST_ITEMS } from '../src/pg/routes/year-close.js';
import { createTestDb, request, seedClass, seedUserSession } from './helpers/pg.js';

const OLD = 'y-ye-2026';
const NEW = 'y-ye-2027';

async function setup({ lateEntries = [] } = {}) {
  const db = await createTestDb();
  await db.query(`INSERT INTO school_years (id, label, starts_on, ends_on) VALUES
    ($1, '2026/27 test', '2026-09-01', '2027-08-31'),
    ($2, '2027/28 test', '2027-09-01', '2028-08-31')`, [OLD, NEW]);
  await seedClass(db, { id: 'c-ye-1a', schoolYearId: OLD, name: '1A' });
  const cookies = {
    boardA: await seedUserSession(db, { userId: 'u-ye-board-a', roles: [{ role: 'board', schoolYearId: OLD }], mfa: true }),
    boardB: await seedUserSession(db, { userId: 'u-ye-board-b', roles: [{ role: 'board' }], mfa: true }),
    treasurer: await seedUserSession(db, { userId: 'u-ye-treasurer', roles: [{ role: 'treasurer', schoolYearId: OLD }], mfa: true }),
    rep: await seedUserSession(db, { userId: 'u-ye-rep', roles: [{ role: 'representative', schoolYearId: OLD, classId: 'c-ye-1a' }], mfa: true }),
  };
  await db.query(`INSERT INTO ledger_categories (id, school_year_id, direction, name, created_by) VALUES
    ('cat-ye-in', $1, 'income', 'Składki dobrowolne', 'u-ye-treasurer')`, [OLD]);
  await db.query(`INSERT INTO ledger_opening_balances (id, school_year_id, amount_cents, cash_cents, created_by, idempotency_key)
    VALUES ('ob-ye', $1, 10000, 2000, 'u-ye-treasurer', 'ob-ye-key-001')`, [OLD]);
  await db.query(`INSERT INTO ledger_entries (id, school_year_id, direction, amount_cents, category_id, description, occurred_on, method, created_by, idempotency_key)
    VALUES ('le-ye-in', $1, 'income', 50000, 'cat-ye-in', 'Wpływ syntetyczny', '2026-10-01', 'bank', 'u-ye-treasurer', 'le-ye-in-key-1')`, [OLD]);
  // Wpisy datowane PO końcu roku mogą istnieć tylko jako wiersze sprzed
  // walidacji 0027 albo zapisane z pominięciem triggera — odtwarzamy to
  // wyłącznie w bazie testowej.
  for (const [index, late] of lateEntries.entries()) {
    await db.exec('SET session_replication_role = replica');
    await db.query(`INSERT INTO ledger_entries (id, school_year_id, direction, amount_cents, category_id, description, occurred_on, method, created_by, idempotency_key)
      VALUES ($1, $2, 'income', $3, 'cat-ye-in', 'Wpis po końcu roku', '2027-09-15', $4, 'u-ye-treasurer', $5)`,
    [`le-ye-late-${index}`, OLD, late.cents, late.method, `le-ye-late-key-${index}`]);
    await db.exec('SET session_replication_role = origin');
  }
  return { db, env: { db }, cookies };
}

const post = (env, path, cookie, body = {}) => handlePgRequest(request(path, { method: 'POST', cookie, body }), env);
const get = (env, path, cookie) => handlePgRequest(request(path, { cookie }), env);
const closeUrl = `/api/year-close/${OLD}/close`;

async function startAndConfirm(env, cookies) {
  const started = await post(env, `/api/year-close/${OLD}/start`, cookies.boardA, { nextSchoolYearId: NEW });
  assert.equal(started.status, 201);
  for (const [index, item] of CHECKLIST_ITEMS.entries()) {
    const cookie = index % 2 ? cookies.treasurer : cookies.boardA;
    assert.equal((await post(env, `/api/year-close/${OLD}/checklist/${item}`, cookie, { note: `Potwierdzenie ${item}` })).status, 201);
  }
}

async function counts(db) {
  const opening = await db.query('SELECT count(*)::int AS n FROM ledger_opening_balances WHERE school_year_id = $1', [NEW]);
  const closed = await db.query(`SELECT count(*)::int AS n FROM school_year_closures WHERE school_year_id = $1 AND status = 'closed'`, [OLD]);
  const events = await db.query(`SELECT action, count(*)::int AS n FROM audit_events WHERE action LIKE 'year_close.%' GROUP BY action`);
  return { opening: opening.rows[0].n, closed: closed.rows[0].n, events: Object.fromEntries(events.rows.map((r) => [r.action, r.n])) };
}

test('#169: spójne saldo — zamknięcie bez potwierdzenia, brak zdarzenia rozbieżności', async () => {
  const { db, env, cookies } = await setup();
  try {
    await startAndConfirm(env, cookies);
    const status = await (await get(env, `/api/year-close/${OLD}`, cookies.boardA)).json();
    assert.equal(status.yearEndCheck.ok, true);
    assert.equal(status.yearEndCheck.balanceDifferenceCents, 0);
    assert.equal(status.yearEndCheck.closingBalanceCents, 60000);
    assert.equal(status.yearEndCheck.closingCashCents, 2000);
    assert.equal(status.yearEndCheck.closingBankCents, 58000);
    // Zbędne potwierdzenie nie tworzy zdarzenia rozbieżności.
    const res = await post(env, closeUrl, cookies.boardB, {
      confirmYearEndDiscrepancy: { reason: 'explained_outside_system', balanceDifferenceCents: 0, cashDifferenceCents: 0 },
    });
    assert.equal(res.status, 200);
    const after = await counts(db);
    assert.equal(after.closed, 1);
    assert.equal(after.events['year_close.year_end_discrepancy_confirmed'], undefined);
    assert.equal(after.events['year_close.closed'], 1);
  } finally { await db.close(); }
});

test('#169: wpis bankowy po końcu roku — 409 bez potwierdzenia, zamknięcie z potwierdzeniem i audytem', async () => {
  const { db, env, cookies } = await setup({ lateEntries: [{ cents: 12345, method: 'bank' }] });
  try {
    await startAndConfirm(env, cookies);
    const status = await (await get(env, `/api/year-close/${OLD}`, cookies.treasurer)).json();
    assert.equal(status.yearEndCheck.ok, false);
    assert.equal(status.yearEndCheck.closingBalanceCents, 72345);
    assert.equal(status.yearEndCheck.balanceAtYearEndCents, 60000);
    assert.equal(status.yearEndCheck.balanceDifferenceCents, 12345);
    assert.equal(status.yearEndCheck.cashDifferenceCents, 0);
    assert.equal(status.yearEndCheck.bankDifferenceCents, 12345);

    // Bez potwierdzenia: odmowa, nic się nie zapisuje.
    const refused = await post(env, closeUrl, cookies.boardB);
    assert.equal(refused.status, 409);
    const refusedBody = await refused.json();
    assert.equal(refusedBody.error, 'year_end_balance_mismatch');
    assert.equal(refusedBody.yearEndCheck.balanceDifferenceCents, 12345);
    assert.deepEqual(await counts(db), { opening: 0, closed: 0, events: { 'year_close.started': 1, 'year_close.checklist_confirmed': 6 } });

    // Błędny kształt potwierdzenia (bez powodu, powód spoza listy kodów, różnice nie są liczbami) → 400.
    for (const bad of [
      { balanceDifferenceCents: 12345, cashDifferenceCents: 0 },
      { reason: 'Wolny tekst, nie kod', balanceDifferenceCents: 12345, cashDifferenceCents: 0 },
      { reason: 'explained_by_resolution', balanceDifferenceCents: '12345', cashDifferenceCents: 0 },
      { reason: 'explained_by_resolution', balanceDifferenceCents: 12345 },
    ]) {
      const res = await post(env, closeUrl, cookies.boardB, { confirmYearEndDiscrepancy: bad });
      assert.equal(res.status, 400, JSON.stringify(bad));
      assert.equal((await res.json()).error, 'invalid_year_end_confirmation');
    }

    // Potwierdzona inna rozbieżność niż aktualna → 409, bez zapisu.
    const stale = await post(env, closeUrl, cookies.boardB, {
      confirmYearEndDiscrepancy: { reason: 'explained_by_resolution', balanceDifferenceCents: 100, cashDifferenceCents: 0 },
    });
    assert.equal(stale.status, 409);
    assert.equal((await stale.json()).error, 'year_end_confirmation_mismatch');
    assert.equal((await counts(db)).closed, 0);

    // Zasada czterech oczu i role zostają: inicjator, skarbnik i przedstawiciel nie zamkną nawet z potwierdzeniem.
    const confirmation = { reason: 'entry_dated_after_year_end', balanceDifferenceCents: 12345, cashDifferenceCents: 0 };
    const initiator = await post(env, closeUrl, cookies.boardA, { confirmYearEndDiscrepancy: confirmation });
    assert.equal(initiator.status, 409);
    assert.equal((await initiator.json()).error, 'four_eyes_required');
    assert.equal((await post(env, closeUrl, cookies.treasurer, { confirmYearEndDiscrepancy: confirmation })).status, 403);
    assert.equal((await post(env, closeUrl, cookies.rep, { confirmYearEndDiscrepancy: confirmation })).status, 403);
    assert.equal((await counts(db)).closed, 0);

    // Poprawne potwierdzenie przez drugą osobę zarządu.
    const ok = await post(env, closeUrl, cookies.boardB, { confirmYearEndDiscrepancy: confirmation });
    assert.equal(ok.status, 200);
    const closedBody = await ok.json();
    assert.equal(closedBody.status, 'closed');
    assert.equal(closedBody.balance.closingBalanceCents, 72345);
    const carried = await db.query('SELECT amount_cents, cash_cents FROM ledger_opening_balances WHERE school_year_id = $1', [NEW]);
    assert.equal(Number(carried.rows[0].amount_cents), 72345);
    assert.equal(Number(carried.rows[0].cash_cents), 2000);

    const { rows } = await db.query(
      `SELECT actor_id, entity_id, metadata_json AS metadata FROM audit_events WHERE action = 'year_close.year_end_discrepancy_confirmed'`,
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0].actor_id, 'u-ye-board-b');
    const meta = typeof rows[0].metadata === 'string' ? JSON.parse(rows[0].metadata) : rows[0].metadata;
    assert.equal(meta.schoolYearId, OLD);
    assert.equal(meta.reason, confirmation.reason);
    assert.equal(meta.balanceDifferenceCents, 12345);
    assert.equal(meta.bankDifferenceCents, 12345);
    assert.equal(meta.cashDifferenceCents, 0);
    const closedEvent = await db.query(`SELECT metadata_json AS metadata FROM audit_events WHERE action = 'year_close.closed'`);
    const closedMeta = typeof closedEvent.rows[0].metadata === 'string' ? JSON.parse(closedEvent.rows[0].metadata) : closedEvent.rows[0].metadata;
    assert.equal(closedMeta.yearEndDiscrepancyConfirmed, true);

    // Ponowienie po zamknięciu nie dopisuje nic.
    const replay = await post(env, closeUrl, cookies.boardB, { confirmYearEndDiscrepancy: confirmation });
    assert.equal(replay.status, 200);
    assert.equal((await replay.json()).replayed, true);
    const after = await counts(db);
    assert.equal(after.events['year_close.year_end_discrepancy_confirmed'], 1);
    assert.equal(after.events['year_close.closed'], 1);
    assert.equal(after.opening, 1);
  } finally { await db.close(); }
});

test('#169: wpis gotówkowy po końcu roku — różnica przypisana do kasy, nie do rachunku', async () => {
  const { db, env, cookies } = await setup({ lateEntries: [{ cents: 700, method: 'cash' }] });
  try {
    await startAndConfirm(env, cookies);
    const status = await (await get(env, `/api/year-close/${OLD}`, cookies.boardB)).json();
    assert.equal(status.yearEndCheck.ok, false);
    assert.equal(status.yearEndCheck.balanceDifferenceCents, 700);
    assert.equal(status.yearEndCheck.cashDifferenceCents, 700);
    assert.equal(status.yearEndCheck.bankDifferenceCents, 0);
    assert.equal(status.yearEndCheck.closingCashCents, 2700);
    assert.equal(status.yearEndCheck.cashAtYearEndCents, 2000);
    const refused = await post(env, closeUrl, cookies.boardB);
    assert.equal(refused.status, 409);
    assert.equal((await refused.json()).error, 'year_end_balance_mismatch');
    // Potwierdzenie samej różnicy całkowitej (bez kasy) nie wystarcza.
    const partial = await post(env, closeUrl, cookies.boardB, {
      confirmYearEndDiscrepancy: { reason: 'explained_by_resolution', balanceDifferenceCents: 700, cashDifferenceCents: 0 },
    });
    assert.equal(partial.status, 409);
    assert.equal((await partial.json()).error, 'year_end_confirmation_mismatch');
    const ok = await post(env, closeUrl, cookies.boardB, {
      confirmYearEndDiscrepancy: { reason: 'entry_dated_after_year_end', balanceDifferenceCents: 700, cashDifferenceCents: 700 },
    });
    assert.equal(ok.status, 200);
    const carried = await db.query('SELECT amount_cents, cash_cents FROM ledger_opening_balances WHERE school_year_id = $1', [NEW]);
    assert.equal(Number(carried.rows[0].amount_cents), 60700);
    assert.equal(Number(carried.rows[0].cash_cents), 2700);
  } finally { await db.close(); }
});

test('#169: podwójne kliknięcie z potwierdzeniem — jedno zamknięcie, jedno zdarzenie rozbieżności', async () => {
  const { db, env, cookies } = await setup({ lateEntries: [{ cents: 500, method: 'bank' }] });
  try {
    await startAndConfirm(env, cookies);
    const confirmation = { reason: 'explained_by_resolution', balanceDifferenceCents: 500, cashDifferenceCents: 0 };
    const results = await Promise.all([
      post(env, closeUrl, cookies.boardB, { confirmYearEndDiscrepancy: confirmation }),
      post(env, closeUrl, cookies.boardB, { confirmYearEndDiscrepancy: confirmation }),
    ]);
    assert.deepEqual(results.map((r) => r.status), [200, 200]);
    const after = await counts(db);
    assert.equal(after.opening, 1);
    assert.equal(after.events['year_close.year_end_discrepancy_confirmed'], 1);
    assert.equal(after.events['year_close.closed'], 1);
  } finally { await db.close(); }
});
