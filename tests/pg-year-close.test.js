// Zamknięcie roku i przekazanie dokumentacji (#15). Wyłącznie dane syntetyczne.
import test, { after, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import { handlePgRequest } from '../src/pg/app.js';
import { CHECKLIST_ITEMS } from '../src/pg/routes/year-close.js';
import { createTestDb, request, seedClass, seedUserSession } from './helpers/pg.js';
import { assertEvery } from './helpers/assertions.js';

const OLD = 'y-2026';
const NEW = 'y-2027';

async function setup() {
  const db = await createTestDb();
  await db.query(`INSERT INTO school_years (id, label, starts_on, ends_on) VALUES
    ($1, '2026/27 test', '2026-09-01', '2027-08-31'),
    ($2, '2027/28 test', '2027-09-01', '2028-08-31')`, [OLD, NEW]);
  await seedClass(db, { id: 'c-1a', schoolYearId: OLD, name: '1A' });
  await seedClass(db, { id: 'c-2a', schoolYearId: NEW, name: '2A' });

  const cookies = {
    boardA: await seedUserSession(db, { userId: 'u-board-a', roles: [{ role: 'board', schoolYearId: OLD }], mfa: true }),
    boardB: await seedUserSession(db, { userId: 'u-board-b', roles: [{ role: 'board', schoolYearId: OLD }], mfa: true }),
    boardGlobal: await seedUserSession(db, { userId: 'u-board-global', roles: [{ role: 'board' }], mfa: true }),
    boardNoMfa: await seedUserSession(db, { userId: 'u-board-nomfa', roles: [{ role: 'board', schoolYearId: OLD }], mfa: false }),
    classBoard: await seedUserSession(db, { userId: 'u-board-class', roles: [{ role: 'board', schoolYearId: OLD, classId: 'c-1a' }], mfa: true }),
    treasurer: await seedUserSession(db, { userId: 'u-treasurer', roles: [{ role: 'treasurer', schoolYearId: OLD }], mfa: true }),
    rep: await seedUserSession(db, { userId: 'u-rep', roles: [{ role: 'representative', schoolYearId: OLD, classId: 'c-1a' }], mfa: true }),
    auditor: await seedUserSession(db, { userId: 'u-audit', roles: [{ role: 'audit', schoolYearId: OLD }], mfa: true }),
    boardNew: await seedUserSession(db, { userId: 'u-board-new', roles: [{ role: 'board', schoolYearId: NEW }], mfa: true }),
    repNew: await seedUserSession(db, { userId: 'u-rep-new', roles: [{ role: 'representative', schoolYearId: NEW, classId: 'c-2a' }], mfa: true }),
  };

  // Księga starego roku: bilans otwarcia 500,00 z poprawką −15,00, przychód 1200,00,
  // wydatek 300,00 z korektą 50,00. Bilans zamknięcia = 485,00 + 1200,00 − 250,00 = 1435,00 EUR.
  await db.query(`INSERT INTO ledger_categories (id, school_year_id, direction, name, created_by) VALUES
    ('cat-in', $1, 'income', 'Składki dobrowolne', 'u-treasurer'),
    ('cat-out', $1, 'expense', 'Wydarzenia', 'u-treasurer'),
    ('cat-in-new', $2, 'income', 'Składki dobrowolne', 'u-treasurer')`, [OLD, NEW]);
  await db.query(`INSERT INTO ledger_opening_balances (id, school_year_id, amount_cents, created_by, idempotency_key)
    VALUES ('ob-old', $1, 50000, 'u-treasurer', 'ob-old-key-1')`, [OLD]);
  await db.query(`INSERT INTO ledger_opening_balance_adjustments (id, opening_balance_id, amount_cents, reason, created_by, idempotency_key)
    VALUES ('oba-old', 'ob-old', -1500, 'Poprawka testowa', 'u-treasurer', 'oba-old-key-1')`);
  await db.query(`INSERT INTO ledger_entries (id, school_year_id, direction, amount_cents, category_id, description, occurred_on, method, created_by, idempotency_key) VALUES
    ('le-in', $1, 'income', 120000, 'cat-in', 'Wpływy syntetyczne', '2026-10-01', 'bank', 'u-treasurer', 'le-in-key-1'),
    ('le-out', $1, 'expense', 30000, 'cat-out', 'Wydatek syntetyczny', '2026-11-01', 'bank', 'u-treasurer', 'le-out-key-1')`, [OLD]);
  await db.query(`INSERT INTO ledger_corrections (id, ledger_entry_id, amount_cents, reason, created_by, idempotency_key)
    VALUES ('lc-out', 'le-out', 5000, 'Zwrot części kosztu', 'u-treasurer', 'lc-out-key-1')`);

  await db.query("INSERT INTO households (id) VALUES ('h-1'), ('h-2')");
  await db.query(`INSERT INTO payment_entries (id, household_id, school_year_id, amount_cents, received_on, method, status, created_by, idempotency_key)
    VALUES ('p-1', 'h-1', $1, 2000, '2026-10-02', 'bank', 'recorded', 'u-treasurer', 'p-1-key-001'),
           ('p-2', NULL, $1, 1500, '2026-10-03', 'bank', 'unmatched', 'u-treasurer', 'p-2-key-001')`, [OLD]);
  await db.query(`INSERT INTO events (id, school_year_id, title, begins_at, created_by)
    VALUES ('ev-old', $1, 'Piknik syntetyczny', '2027-05-01T10:00:00Z', 'u-board-a')`, [OLD]);
  await db.query(`INSERT INTO meetings (id, school_year_id, kind, title, scheduled_at, created_by)
    VALUES ('m-old', $1, 'plenary', 'Zebranie syntetyczne', '2027-06-01T17:00:00Z', 'u-board-a')`, [OLD]);

  return { db, env: { db }, cookies };
}

function post(env, path, cookie, body = {}) {
  return handlePgRequest(request(path, { method: 'POST', cookie, body }), env);
}

function get(env, path, cookie) {
  return handlePgRequest(request(path, { cookie }), env);
}

async function startAndConfirm(env, cookies) {
  const started = await post(env, `/api/year-close/${OLD}/start`, cookies.boardA, { nextSchoolYearId: NEW });
  assert.equal(started.status, 201);
  for (const [index, item] of CHECKLIST_ITEMS.entries()) {
    const cookie = index % 2 ? cookies.treasurer : cookies.boardA;
    const response = await post(env, `/api/year-close/${OLD}/checklist/${item}`, cookie, { note: `Potwierdzenie ${item}` });
    assert.equal(response.status, 201, item);
  }
}

async function auditCount(db, action) {
  const { rows } = await db.query('SELECT count(*)::int AS n FROM audit_events WHERE action = $1', [action]);
  return rows[0].n;
}

describe('po zamknięciu roku przez drugą osobę z zarządu', () => {
  let db; let env; let cookies; let liveBefore; let historyBefore; let auditBefore; let closedStatus; let closedBody;
  const snapshot = async () => ({
    summary: (await db.query('SELECT * FROM ledger_year_summary WHERE school_year_id = $1', [OLD])).rows,
    entries: (await db.query('SELECT id, amount_cents, net_amount_cents FROM ledger_entry_net WHERE school_year_id = $1 ORDER BY id', [OLD])).rows,
    payments: (await db.query('SELECT id, status, net_amount_cents FROM payment_entry_net WHERE school_year_id = $1 ORDER BY id', [OLD])).rows,
    meetings: (await db.query('SELECT id, status FROM meetings WHERE school_year_id = $1', [OLD])).rows,
    events: (await db.query('SELECT id, status, revision_no FROM events WHERE school_year_id = $1', [OLD])).rows,
  });

  // Jedna baza dla czterech testów (mniej instancji PGlite w pamięci).
  // Testy poniżej nie zmieniają stanu starego roku.
  before(async () => {
    ({ db, env, cookies } = await setup());
    liveBefore = await (await get(env, `/api/year-close/${OLD}`, cookies.boardA)).json();
    historyBefore = await snapshot();
    auditBefore = (await db.query('SELECT id FROM audit_events')).rows.map((row) => row.id);
    await startAndConfirm(env, cookies);
    const closed = await post(env, `/api/year-close/${OLD}/close`, cookies.boardB);
    closedStatus = closed.status;
    closedBody = await closed.json();
  });
  after(() => db.close());

  test('zapisy przypisane do zamkniętego roku są odrzucane', async () => {
    const refused = [
      [`INSERT INTO ledger_entries (id, school_year_id, direction, amount_cents, category_id, description, occurred_on, method, created_by, idempotency_key)
        VALUES ('le-late', $1, 'income', 100, 'cat-in', 'Spóźniony wpis', '2027-08-30', 'bank', 'u-treasurer', 'le-late-key-1')`, [OLD]],
      [`INSERT INTO ledger_corrections (id, ledger_entry_id, amount_cents, reason, created_by, idempotency_key)
        VALUES ('lc-late', 'le-in', 100, 'Spóźniona korekta', 'u-treasurer', 'lc-late-key-1')`, []],
      [`INSERT INTO ledger_opening_balance_adjustments (id, opening_balance_id, amount_cents, reason, created_by, idempotency_key)
        VALUES ('oba-late', 'ob-old', 100, 'Spóźniona poprawka', 'u-treasurer', 'oba-late-key-1')`, []],
      [`INSERT INTO ledger_categories (id, school_year_id, direction, name, created_by)
        VALUES ('cat-late', $1, 'income', 'Nowa kategoria', 'u-treasurer')`, [OLD]],
      ['UPDATE ledger_categories SET active = false WHERE id = $1', ['cat-in']],
      [`INSERT INTO payment_entries (id, household_id, school_year_id, amount_cents, received_on, method, status, created_by, idempotency_key)
        VALUES ('p-late', 'h-2', $1, 500, '2027-08-30', 'bank', 'recorded', 'u-treasurer', 'p-late-key-1')`, [OLD]],
      [`INSERT INTO payment_corrections (id, payment_entry_id, amount_cents, reason, created_by, idempotency_key)
        VALUES ('pc-late', 'p-1', 100, 'Spóźniona korekta', 'u-treasurer', 'pc-late-key-1')`, []],
      [`INSERT INTO payment_assignments (id, payment_entry_id, household_id, created_by, idempotency_key)
        VALUES ('pa-late', 'p-2', 'h-2', 'u-treasurer', 'pa-late-key-1')`, []],
      [`INSERT INTO events (id, school_year_id, title, begins_at, created_by)
        VALUES ('ev-late', $1, 'Spóźnione wydarzenie', '2027-06-01T10:00:00Z', 'u-board-a')`, [OLD]],
      ["UPDATE events SET title = 'Zmieniony tytuł', updated_by = created_by WHERE id = 'ev-old'", []],
      [`INSERT INTO meetings (id, school_year_id, kind, title, scheduled_at, created_by)
        VALUES ('m-late', $1, 'plenary', 'Spóźnione zebranie', '2027-06-02T17:00:00Z', 'u-board-a')`, [OLD]],
      ["UPDATE meetings SET title = 'Zmieniony tytuł' WHERE id = 'm-old'", []],
      [`INSERT INTO meeting_agenda_items (id, meeting_id, position, title, created_by)
        VALUES ('ag-late', 'm-old', 1, 'Punkt spóźniony', 'u-board-a')`, []],
      [`INSERT INTO role_grants (id, user_id, role, school_year_id) VALUES ('g-late', 'u-board-new', 'board', $1)`, [OLD]],
    ];
    for (const [sql, params] of refused) {
      await assert.rejects(db.query(sql, params), /school_year_closed/, sql);
    }

    // Przez API: wpłata w zamkniętym roku nie zostaje zapisana.
    const response = await handlePgRequest(request('/api/payments', {
      method: 'POST', cookie: cookies.boardGlobal, headers: { 'Idempotency-Key': 'api-late-payment-1' },
      body: { householdId: 'h-2', schoolYearId: OLD, amountCents: 700, receivedOn: '2027-08-30', method: 'bank' },
    }), env);
    assert.notEqual(response.status, 201);
    const { rows } = await db.query('SELECT count(*)::int AS n FROM payment_entries WHERE school_year_id = $1', [OLD]);
    assert.equal(rows[0].n, 2);

    // Zamknięcie jest ostateczne na poziomie bazy.
    await assert.rejects(db.query("UPDATE school_year_closures SET status = 'closing' WHERE school_year_id = $1", [OLD]),
      /school_year_closure_is_final/);
    await assert.rejects(db.query('DELETE FROM school_year_closures WHERE school_year_id = $1', [OLD]),
      /school_year_closures_cannot_be_deleted/);
  });

  test('role starej kadencji wygasają, role nowego roku pozostają', async () => {
    const closed = closedBody;

    const { rows: oldGrants } = await db.query(
      'SELECT id, expires_at, revoked_at FROM role_grants WHERE school_year_id = $1', [OLD]);
    assert.equal(oldGrants.length, 7);
    assertEvery(oldGrants, (grant) => grant.expires_at && !grant.revoked_at);
    assert.equal(closed.expiredGrantCount, 7);
    assert.equal(await auditCount(db, 'role_grant.expired'), 7);

    const { rows: newGrants } = await db.query(
      'SELECT expires_at FROM role_grants WHERE school_year_id = $1 OR school_year_id IS NULL', [NEW]);
    assert.ok(newGrants.length >= 3);
    assertEvery(newGrants, (grant) => grant.expires_at === null);

    // Stara kadencja traci dostęp, nowa zachowuje.
    assert.equal((await get(env, `/api/year-close/${OLD}`, cookies.boardA)).status, 403);
    assert.equal((await get(env, `/api/year-close/${OLD}`, cookies.treasurer)).status, 403);
    assert.equal((await get(env, `/api/year-close/${NEW}`, cookies.boardNew)).status, 200);
    const handover = await (await get(env, `/api/year-close/${OLD}/handover`, cookies.boardGlobal)).json();
    assert.deepEqual(handover.roles.activeGrantsNextYearByRole, { board: 1, representative: 1 });
  });

  test('historia zamkniętego roku pozostaje nienaruszona i czytelna', async () => {
    assert.deepEqual(await snapshot(), historyBefore);
    const auditAfter = (await db.query('SELECT id FROM audit_events')).rows.map((row) => row.id);
    for (const id of auditBefore) assert.ok(auditAfter.includes(id));
    assert.ok(await auditCount(db, 'year_close.closed') === 1);

    // Odczyt przez API nadal działa dla uprawnionej osoby.
    const payments = await get(env, `/api/payments?schoolYearId=${OLD}`, cookies.boardGlobal);
    assert.equal(payments.status, 200);
    const list = await payments.json();
    assert.deepEqual(list.payments.map((payment) => payment.id).sort(), ['p-1', 'p-2']);

    const handover = await get(env, `/api/year-close/${OLD}/handover`, cookies.boardGlobal);
    assert.equal(handover.status, 200);
    const summary = await handover.json();
    assert.equal(summary.final, true);
    assert.equal(summary.finance.closingBalanceCents, 143500);
    assert.equal(summary.finance.ledgerEntryCount, 2);
    assert.equal(summary.finance.ledgerCorrectionCount, 1);
    assert.deepEqual(summary.finance.nextYearOpeningBalance.amountCents, 143500);
    assert.equal(summary.finance.nextYearOpeningBalance.carriedFromClosure, true);
    assert.deepEqual(summary.payments, {
      recordedCount: 1, recordedNetCents: 2000, unmatchedCount: 1, unmatchedNetCents: 1500, unmatchedAllocatedCents: 0, correctionCount: 0,
    });
    assert.deepEqual(summary.meetings.byStatus, { draft: 1 });
    assert.ok(summary.checklist.length > 0 && summary.checklist.every((entry) => entry.confirmed && entry.confirmedBy && entry.confirmedAt), 'lista kontrolna jest niepusta i w całości potwierdzona');
    assert.equal(JSON.stringify(summary).includes('@'), false, 'zestawienie bez adresów e-mail');
  });

  test('zamknięcie przenosi bilans zamknięcia dokładnie do bilansu otwarcia nowego roku', async () => {
    assert.equal(liveBefore.status, 'open');
    assert.deepEqual(liveBefore.balance, {
      source: 'live', openingBalanceCents: 48500, incomeCents: 120000, expenseCents: 25000, closingBalanceCents: 143500,
      // Podział rachunek/kasa (#199): wszystkie wpisy przelewem, kasa 0.
      openingCashCents: 0, closingCashCents: 0, closingBankCents: 143500,
    });

    assert.equal(closedStatus, 200);
    const body = closedBody;
    assert.equal(body.status, 'closed');
    assert.equal(body.closedBy, 'u-board-b');
    assert.equal(body.initiatedBy, 'u-board-a');
    assert.equal(body.balance.source, 'closed');
    assert.equal(body.balance.closingBalanceCents, 143500);
    assert.deepEqual(body.missingChecklistItems, []);

    const { rows: opening } = await db.query('SELECT id, amount_cents, created_by FROM ledger_opening_balances WHERE school_year_id = $1', [NEW]);
    assert.equal(opening.length, 1);
    assert.equal(opening[0].amount_cents, 143500);
    assert.equal(opening[0].id, body.carriedOpeningBalanceId);
    const { rows: nextSummary } = await db.query('SELECT opening_balance_cents FROM ledger_year_summary WHERE school_year_id = $1', [NEW]);
    assert.equal(Number(nextSummary[0].opening_balance_cents), 143500);

    // Nowy rok pracuje normalnie: zapis w otwartym roku jest przyjmowany.
    await db.query(`INSERT INTO ledger_entries (id, school_year_id, direction, amount_cents, category_id, description, occurred_on, method, created_by, idempotency_key)
      VALUES ('le-new', $1, 'income', 1000, 'cat-in-new', 'Wpływ nowego roku', '2027-09-10', 'bank', 'u-treasurer', 'le-new-key-1')`, [NEW]);
    const { rows: nextAfter } = await db.query('SELECT closing_balance_cents FROM ledger_year_summary WHERE school_year_id = $1', [NEW]);
    assert.equal(Number(nextAfter[0].closing_balance_cents), 144500);
  });
});

test('zamknięcie wymaga pełnej listy kontrolnej i drugiej osoby', async () => {
  const { db, env, cookies } = await setup();
  try {
    assert.equal((await post(env, `/api/year-close/${OLD}/close`, cookies.boardB)).status, 409);
    const started = await post(env, `/api/year-close/${OLD}/start`, cookies.boardA, { nextSchoolYearId: NEW });
    assert.equal(started.status, 201);

    const partial = await post(env, `/api/year-close/${OLD}/close`, cookies.boardB);
    assert.equal(partial.status, 409);
    const partialBody = await partial.json();
    assert.equal(partialBody.error, 'checklist_incomplete');
    assert.deepEqual(partialBody.missingChecklistItems, CHECKLIST_ITEMS);

    for (const item of CHECKLIST_ITEMS) {
      assert.equal((await post(env, `/api/year-close/${OLD}/checklist/${item}`, cookies.treasurer)).status, 201);
    }
    const replayItem = await post(env, `/api/year-close/${OLD}/checklist/financial_report`, cookies.boardB);
    assert.equal(replayItem.status, 200);
    assert.equal((await replayItem.json()).checklist[0].confirmedBy, 'u-treasurer');
    assert.equal((await post(env, `/api/year-close/${OLD}/checklist/unknown_item`, cookies.treasurer)).status, 404);

    const self = await post(env, `/api/year-close/${OLD}/close`, cookies.boardA);
    assert.equal(self.status, 409);
    assert.equal((await self.json()).error, 'four_eyes_required');
    await assert.rejects(db.query(
      "UPDATE school_year_closures SET closed_by = initiated_by WHERE school_year_id = $1", [OLD]), /year_close_four_eyes/);

    const { rows } = await db.query('SELECT count(*)::int AS n FROM ledger_opening_balances WHERE school_year_id = $1', [NEW]);
    assert.equal(rows[0].n, 0);
    const status = await (await get(env, `/api/year-close/${OLD}`, cookies.boardB)).json();
    assert.equal(status.status, 'closing');
  } finally {
    await db.close();
  }
});

test('przedstawiciel, Komisja Rewizyjna, zarząd klasy i sesja bez MFA nie zamykają roku', async () => {
  const { db, env, cookies } = await setup();
  try {
    assert.equal((await get(env, `/api/year-close/${OLD}`)).status, 401);
    for (const cookie of [cookies.rep, cookies.auditor, cookies.classBoard, cookies.boardNoMfa, cookies.boardNew]) {
      assert.equal((await get(env, `/api/year-close/${OLD}`, cookie)).status, 403);
      assert.equal((await post(env, `/api/year-close/${OLD}/start`, cookie, { nextSchoolYearId: NEW })).status, 403);
      assert.equal((await get(env, `/api/year-close/${OLD}/handover`, cookie)).status, 403);
    }
    // Skarbnik potwierdza punkty listy, ale nie rozpoczyna ani nie zamyka.
    assert.equal((await post(env, `/api/year-close/${OLD}/start`, cookies.treasurer, { nextSchoolYearId: NEW })).status, 403);
    await startAndConfirm(env, cookies);
    for (const cookie of [cookies.rep, cookies.treasurer, cookies.auditor, cookies.boardNoMfa]) {
      assert.equal((await post(env, `/api/year-close/${OLD}/close`, cookie)).status, 403);
    }
    for (const cookie of [cookies.rep, cookies.auditor, cookies.boardNoMfa, cookies.classBoard]) {
      assert.equal((await post(env, `/api/year-close/${OLD}/checklist/financial_report`, cookie)).status, 403);
    }
    const crossOrigin = await handlePgRequest(request(`/api/year-close/${OLD}/close`, {
      method: 'POST', cookie: cookies.boardB, origin: 'https://evil.example', body: {},
    }), env);
    assert.equal(crossOrigin.status, 403);
    const { rows } = await db.query('SELECT status FROM school_year_closures WHERE school_year_id = $1', [OLD]);
    assert.equal(rows[0].status, 'closing');
  } finally {
    await db.close();
  }
});

test('ponowne zamknięcie jest idempotentne i nie dubluje bilansu ani audytu', async () => {
  const { db, env, cookies } = await setup();
  try {
    await startAndConfirm(env, cookies);
    const replayStart = await post(env, `/api/year-close/${OLD}/start`, cookies.boardB, { nextSchoolYearId: NEW });
    assert.equal(replayStart.status, 200);
    assert.equal((await replayStart.json()).replayed, true);
    assert.equal(await auditCount(db, 'year_close.started'), 1);
    assert.equal(await auditCount(db, 'year_close.checklist_confirmed'), CHECKLIST_ITEMS.length);

    const first = await post(env, `/api/year-close/${OLD}/close`, cookies.boardGlobal);
    assert.equal(first.status, 200);
    const firstBody = await first.json();
    assert.equal(firstBody.replayed, false);

    const second = await post(env, `/api/year-close/${OLD}/close`, cookies.boardGlobal);
    assert.equal(second.status, 200);
    const secondBody = await second.json();
    assert.equal(secondBody.replayed, true);
    assert.equal(secondBody.carriedOpeningBalanceId, firstBody.carriedOpeningBalanceId);
    assert.equal(secondBody.balance.closingBalanceCents, 143500);

    const { rows } = await db.query('SELECT count(*)::int AS n FROM ledger_opening_balances WHERE school_year_id = $1', [NEW]);
    assert.equal(rows[0].n, 1);
    assert.equal(await auditCount(db, 'year_close.closed'), 1);
    assert.equal(await auditCount(db, 'ledger_opening_balance.carried_forward'), 1);

    const restart = await post(env, `/api/year-close/${OLD}/start`, cookies.boardGlobal, { nextSchoolYearId: NEW });
    assert.equal(restart.status, 409);
    assert.equal((await restart.json()).error, 'school_year_closed');
    const lateItem = await post(env, `/api/year-close/${OLD}/checklist/financial_report`, cookies.boardGlobal);
    assert.equal(lateItem.status, 409);

    // Audyt bez danych osobowych.
    const { rows: audit } = await db.query("SELECT metadata_json FROM audit_events WHERE action LIKE 'year_close.%' OR action = 'role_grant.expired'");
    assert.equal(JSON.stringify(audit).includes('@'), false);
  } finally {
    await db.close();
  }
});

test('#212: dwa „Zamknij rok” przez Promise.all (dwie osoby albo podwójne kliknięcie; PGlite wykonuje je po kolei — zakleszczenie sprawdza pg-year-close-race) — dokładnie jeden bilans otwarcia', async () => {
  const { db, env, cookies } = await setup();
  try {
    await startAndConfirm(env, cookies);
    // Dwóch różnych członków zarządu (żaden nie rozpoczynał — boardA
    // rozpoczęła) naraz. PGlite serializuje same transakcje, ale obie
    // odpowiedzi przechodzą przez tę samą ścieżkę kodu co na prawdziwym
    // PostgreSQL: advisory lock szereguje wejście do transakcji.
    // boardB ma rolę board ZAWĘŻONĄ do roku OLD — jeśli boardGlobal zamknie
    // rok jako pierwszy, zanim żądanie boardB dotrze do własnego
    // `authorize()`, własny przydział boardB jest już wygaszony przez to
    // zamknięcie: dostaje wtedy `409 school_year_closed` (wariant
    // zachowawczy — bez ujawniania bilansu komuś, kto już nie ma roli w tym
    // roku), a nie `403 forbidden` ani pełny `replayed:true`. boardGlobal ma
    // rolę BEZ zawężenia do roku — jego przydział nigdy nie wygasa przez to
    // zamknięcie, więc zawsze dostaje 200 (replayed:true albo false).
    const [a, b] = await Promise.all([
      post(env, `/api/year-close/${OLD}/close`, cookies.boardB),
      post(env, `/api/year-close/${OLD}/close`, cookies.boardGlobal),
    ]);
    const [bodyA, bodyB] = await Promise.all([a.json(), b.json()]);
    assert.equal(b.status, 200, `boardGlobal (rola bez zawężenia do roku) zawsze 200: ${b.status}`);
    assert.equal(
      a.status === 200 || (a.status === 409 && bodyA.error === 'school_year_closed'),
      true,
      `boardB: 200 albo 409 school_year_closed, dostał ${a.status} ${JSON.stringify(bodyA)}`,
    );
    if (a.status === 409) assert.equal('balance' in bodyA, false, '409 school_year_closed nie ujawnia bilansu');

    const writers = [a.status === 200 ? bodyA.replayed : null, bodyB.replayed].filter((v) => v === false);
    assert.equal(writers.length, 1, 'dokładnie jedna odpowiedź 200 zapisała (replayed:false)');

    const { rows } = await db.query('SELECT count(*)::int AS n FROM ledger_opening_balances WHERE school_year_id = $1', [NEW]);
    assert.equal(rows[0].n, 1, 'dokładnie jeden bilans otwarcia');
    assert.equal(await auditCount(db, 'year_close.closed'), 1, 'dokładnie jedno zdarzenie year_close.closed');
  } finally {
    await db.close();
  }
});

test('#212: zamknięcie roku wygasza WŁASNY przydział drugiej osoby zarządu — 409 school_year_closed bez bilansu, nie 403', async () => {
  // Deterministyczna wersja przyczyny niestabilności #212 (bez zależności od
  // realnego przeplotu Promise.all): zamknięcie wygasza w tej samej
  // transakcji przydziały zarządu zawężone do zamykanego roku
  // (`role_grant_in_school_year`, src/pg/routes/year-close.js). boardB ma
  // rolę board ZE ZAWĘŻENIEM do roku OLD. Jeśli boardGlobal zamknie rok
  // jako pierwszy (choćby przez to, że pod obciążeniem CI kolejka żądań
  // boardB dotarła do `authorize()` później — patrz komentarz przy
  // `wasAuthorizedAtOwnClosure`), własny przydział boardB jest już wygasły,
  // gdy jego żądanie w końcu trafia do serwera. Sekwencyjnie odtwarza to
  // dokładnie ten sam stan bez potrzeby wygrywania realnego wyścigu.
  //
  // Wariant zachowawczy (najmniej uprawnień): boardB nie dostaje pełnej
  // odpowiedzi replay (bilans, identyfikatory) — jego przydział do tego roku
  // już nie istnieje, więc nie ma dziś prawa tych danych czytać. Dostaje
  // sam fakt "rok zamknięty" (409, kod używany też przez `start`), bez
  // wymogu świeżego MFA i bez nowego zdarzenia audytu.
  const { db, env, cookies } = await setup();
  try {
    await startAndConfirm(env, cookies);
    // Rola board zawężona do roku OLD, ale COFNIĘTA (revoked_at) — zasiana
    // PRZED zamknięciem, bo trigger zamrożenia (0017) odrzuca nowe przydziały
    // dla już zamkniętego roku. To zwykły brak uprawnień (nigdy nie miała
    // prawa zamknąć), a nie skutek uboczny TEGO zamknięcia.
    const boardRevoked = await seedUserSession(db, {
      userId: 'u-board-revoked', roles: [{ role: 'board', schoolYearId: OLD, revoked: true }], mfa: true,
    });

    const auditBefore = await auditCount(db, 'year_close.closed');
    const first = await post(env, `/api/year-close/${OLD}/close`, cookies.boardGlobal);
    assert.equal(first.status, 200);
    assert.equal((await first.json()).replayed, false);

    const { rows } = await db.query(
      "SELECT expires_at FROM role_grants WHERE user_id = 'u-board-b' AND school_year_id = $1", [OLD]);
    assert.notEqual(rows[0]?.expires_at, null, 'przydział boardB do roku OLD jest wygaszony przez zamknięcie');

    const second = await post(env, `/api/year-close/${OLD}/close`, cookies.boardB);
    assert.equal(second.status, 409, `boardB stracił własny przydział przez to zamknięcie: ${second.status}`);
    const secondBody = await second.json();
    assert.equal(secondBody.error, 'school_year_closed');
    assert.equal('balance' in secondBody, false, 'bez bilansu');
    assert.equal('carriedOpeningBalanceId' in secondBody, false, 'bez identyfikatora bilansu otwarcia');
    assert.equal('replayed' in secondBody, false, 'bez replayed — to nie jest odpowiedź zamknięcia');
    assert.equal(await auditCount(db, 'year_close.closed'), auditBefore + 1, 'brak nowego zdarzenia audytu przy 409');

    // boardNew: rola board zawężona do INNEGO roku (NEW) — przydział nie
    // został i nie mógł zostać wygaszony przez zamknięcie roku OLD, więc to
    // zwykły brak uprawnień, nie "właśnie zamknięte przeze mnie".
    assert.equal((await post(env, `/api/year-close/${OLD}/close`, cookies.boardNew)).status, 403);
    assert.equal((await post(env, `/api/year-close/${OLD}/close`, boardRevoked)).status, 403);
  } finally {
    await db.close();
  }
});

test('#212: podwójne kliknięcie „Zamknij rok” przez tę samą osobę (PGlite: po kolei; zakleszczenie sprawdza pg-year-close-race) — drugie replayed:true', async () => {
  const { db, env, cookies } = await setup();
  try {
    await startAndConfirm(env, cookies);
    const [a, b] = await Promise.all([
      post(env, `/api/year-close/${OLD}/close`, cookies.boardGlobal),
      post(env, `/api/year-close/${OLD}/close`, cookies.boardGlobal),
    ]);
    assert.equal(a.status < 300, true);
    assert.equal(b.status < 300, true);
    const [bodyA, bodyB] = await Promise.all([a.json(), b.json()]);
    assert.deepEqual([bodyA.replayed, bodyB.replayed].sort(), [false, true]);

    const { rows } = await db.query('SELECT count(*)::int AS n FROM ledger_opening_balances WHERE school_year_id = $1', [NEW]);
    assert.equal(rows[0].n, 1);
  } finally {
    await db.close();
  }
});

test('zamknięcie odmawia, gdy nowy rok ma już bilans otwarcia lub rok następny jest niepoprawny', async () => {
  const { db, env, cookies } = await setup();
  try {
    const backwards = await post(env, `/api/year-close/${NEW}/start`, cookies.boardGlobal, { nextSchoolYearId: OLD });
    assert.equal(backwards.status, 409);
    assert.equal((await backwards.json()).error, 'invalid_next_school_year');
    assert.equal((await post(env, `/api/year-close/${OLD}/start`, cookies.boardA, { nextSchoolYearId: 'y-missing' })).status, 404);
    assert.equal((await post(env, `/api/year-close/${OLD}/start`, cookies.boardA, { nextSchoolYearId: OLD })).status, 409);

    await startAndConfirm(env, cookies);
    await db.query(`INSERT INTO ledger_opening_balances (id, school_year_id, amount_cents, created_by, idempotency_key)
      VALUES ('ob-manual', $1, 100, 'u-treasurer', 'ob-manual-key-1')`, [NEW]);
    const refused = await post(env, `/api/year-close/${OLD}/close`, cookies.boardB);
    assert.equal(refused.status, 409);
    assert.equal((await refused.json()).error, 'next_year_opening_balance_exists');
    const { rows } = await db.query('SELECT count(*)::int AS n FROM role_grants WHERE school_year_id = $1 AND expires_at IS NOT NULL', [OLD]);
    assert.equal(rows[0].n, 0, 'odmowa nie wygasza ról');
  } finally {
    await db.close();
  }
});

// #150 (SR-10, krok w górę): samo zamknięcie roku (operacja nieodwracalna)
// wymaga MFA potwierdzonego od niedawna (15 min), nie tylko kiedyś w sesji.
// Rozpoczęcie i checklista zostają przy MFA "kiedyś w sesji" — poza zakresem.
test('zamknięcie roku wymaga ŚWIEŻEGO MFA (krok w górę): stare potwierdzenie to 403 mfa_stale', async () => {
  const { db, env, cookies } = await setup();
  try {
    await startAndConfirm(env, cookies);
    await db.query("UPDATE sessions SET mfa_verified_at = now() - interval '20 minutes' WHERE user_id = 'u-board-b'");

    const stale = await post(env, `/api/year-close/${OLD}/close`, cookies.boardB);
    assert.equal(stale.status, 403);
    assert.equal((await stale.json()).error, 'mfa_stale');
    assert.equal(await auditCount(db, 'year_close.closed'), 0, 'odmowa mfa_stale nic nie zapisuje');

    // Rozpoczęcie i checklista dalej działają z MFA sprzed 20 minut (poza zakresem #150 część 2).
    assert.equal((await get(env, `/api/year-close/${OLD}`, cookies.boardB)).status, 200);

    await db.query("UPDATE sessions SET mfa_verified_at = now() WHERE user_id = 'u-board-b'");
    const closed = await post(env, `/api/year-close/${OLD}/close`, cookies.boardB);
    assert.equal(closed.status, 200);
    assert.equal(await auditCount(db, 'year_close.closed'), 1);
  } finally {
    await db.close();
  }
});
