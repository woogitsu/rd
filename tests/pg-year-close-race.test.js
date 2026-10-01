// #212: równoległe „Zamknij rok” na PRAWDZIWYM PostgreSQL. PGlite wykonuje
// transakcje po kolei, więc zakleszczenia (40P01) z issue na nim nie widać —
// testy w tests/pg-year-close.test.js sprawdzają tylko wynik końcowy. Tu każde
// żądanie idzie osobnym połączeniem puli z src/db.js. Plik działa wyłącznie
// z RD_TEST_PG_URL (npm run test:pg-real); bez niej jest pomijany.
// Wyłącznie dane syntetyczne, żadnej sieci.
//
// Przeplot jest wymuszany, a nie zgadywany: pierwsze zamknięcie jest
// wstrzymywane W TRANSAKCJI zaraz po `LOCK TABLE … IN SHARE MODE` (moment,
// w którym przed poprawką druga transakcja też dostawała SHARE) albo przed
// COMMIT. Kolejne żądania startują w tym czasie i test czeka, aż w bazie
// będą faktycznie czekały na blokadę (pg_stat_activity.wait_event_type =
// 'Lock'); dopiero wtedy pierwsze zamknięcie jest wznawiane.
//
// Ponowienie transakcji przy 40P01 (src/db.js, #156) ukryłoby zakleszczenie
// (użytkownik dostałby 200 po sekundzie przestoju księgi), dlatego środowisko
// testowe wymusza `retries: 0` i liczy błędy 40P01 — każde zakleszczenie
// jest widoczne jako porażka testu. Kontrola pozytywna (ostatnie testy): te
// same przeploty bez blokady doradczej `rd_year_close` MUSZĄ skończyć się
// 40P01, więc test naprawdę wykrywa regresję.
import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { handlePgRequest } from '../src/pg/app.js';
import { CHECKLIST_ITEMS } from '../src/pg/routes/year-close.js';
import { createRealTestDb, request, seedClass, seedUserSession } from './helpers/pg.js';

const skip = process.env.RD_TEST_PG_URL ? false : 'brak RD_TEST_PG_URL (wymaga prawdziwego PostgreSQL)';
const OLD = 'y-2026';
const NEW = 'y-2027';
const OTHER = 'y-2028';
const OTHER_NEXT = 'y-2029';
const LOCK_TABLE = /LOCK TABLE ledger_entries/;
const ADVISORY = /pg_advisory_xact_lock/;

let seq = 0;
const key = (prefix) => `${prefix}-${String(++seq).padStart(6, '0')}-${crypto.randomUUID().slice(0, 8)}`;

// Środowisko żądania: bez ponowień (40P01 widoczne), licznik kodów błędów
// transakcji, opcjonalna pauza po zapytaniu pasującym do `pauseAfter` albo
// przed COMMIT (`pauseBeforeCommit`), opcjonalne pominięcie blokady doradczej
// (wyłącznie kontrola pozytywna — odtworzenie stanu sprzed poprawki).
function raceEnv(db, { pauseAfter = null, pauseBeforeCommit = false, dropAdvisoryLock = false, errors = [] } = {}) {
  let armed = Boolean(pauseAfter) || pauseBeforeCommit;
  let reach;
  let open;
  const reached = new Promise((resolve) => { reach = resolve; });
  const gate = new Promise((resolve) => { open = resolve; });
  const pause = async () => { armed = false; reach(); await gate; };
  const env = {
    db: {
      query: (...a) => db.query(...a),
      probe: (...a) => db.probe(...a),
      transaction: async (fn) => {
        try {
          return await db.transaction(async (tx) => {
            let hit = false;
            const wrapped = {
              query: async (sql, params) => {
                const text = String(sql);
                if (dropAdvisoryLock && ADVISORY.test(text) && params?.[0] === 'rd_year_close') return { rows: [], rowCount: 0 };
                const result = await tx.query(sql, params);
                if (pauseAfter && armed && pauseAfter.test(text)) await pause();
                if (pauseBeforeCommit && LOCK_TABLE.test(text)) hit = true;
                return result;
              },
            };
            const result = await fn(wrapped);
            if (pauseBeforeCommit && armed && hit) await pause();
            return result;
          }, { retries: 0 });
        } catch (error) {
          // Tylko SQLSTATE (błędy bazy), nie kody odmów aplikacji (np. four_eyes_required).
          if (typeof error?.code === 'string' && /^[0-9A-Z]{5}$/.test(error.code)) errors.push(error.code);
          throw error;
        }
      },
    },
  };
  return { env, reached, release: () => open() };
}

async function call(env, method, path, cookie, body = {}, idempotencyKey = null) {
  const headers = idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {};
  const response = await handlePgRequest(request(path, { method, cookie, body: method === 'GET' ? undefined : body, headers }), env);
  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: response.status, body: data };
}

// Czeka, aż co najmniej `n` połączeń aplikacji czeka na blokadę (tabeli,
// wiersza albo doradczą). Zwraca listę wait_event (np. 'advisory', 'relation').
async function waitForLockWaiters(db, n, { timeoutMs = 2500 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let events = [];
  while (Date.now() < deadline) {
    const { rows } = await db.query(
      `SELECT wait_event FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock' AND pid <> pg_backend_pid()`,
    );
    events = rows.map((row) => row.wait_event).sort();
    if (events.length >= n) return events;
    await sleep(10);
  }
  return events;
}

const count = async (db, sql, params = []) => Number((await db.query(sql, params)).rows[0].n);
const auditCount = (db, action) => count(db, 'SELECT count(*)::int AS n FROM audit_events WHERE action = $1', [action]);
const openingCount = (db, year) => count(db, 'SELECT count(*)::int AS n FROM ledger_opening_balances WHERE school_year_id = $1', [year]);

async function withReal(fn) {
  const db = await createRealTestDb();
  try { return await fn(db); } finally { await db.close(); }
}

// Dane jak w tests/pg-year-close.test.js (syntetyczne): rok OLD z księgą,
// wpłatą i korektą, rok NEW z kategorią; opcjonalnie druga para lat.
async function setup(db, { secondPair = false } = {}) {
  await db.query(`INSERT INTO school_years (id, label, starts_on, ends_on) VALUES
    ($1, '2026/27 test', '2026-09-01', '2027-08-31'),
    ($2, '2027/28 test', '2027-09-01', '2028-08-31'),
    ($3, '2028/29 test', '2028-09-01', '2029-08-31'),
    ($4, '2029/30 test', '2029-09-01', '2030-08-31')`, [OLD, NEW, OTHER, OTHER_NEXT]);
  await seedClass(db, { id: 'c-1a', schoolYearId: OLD, name: '1A' });
  const cookies = {
    boardA: await seedUserSession(db, { userId: 'u-board-a', roles: [{ role: 'board', schoolYearId: OLD }], mfa: true }),
    boardB: await seedUserSession(db, { userId: 'u-board-b', roles: [{ role: 'board', schoolYearId: OLD }], mfa: true }),
    boardGlobal: await seedUserSession(db, { userId: 'u-board-global', roles: [{ role: 'board' }], mfa: true }),
    boardGlobal2: await seedUserSession(db, { userId: 'u-board-global-2', roles: [{ role: 'board' }], mfa: true }),
    treasurer: await seedUserSession(db, { userId: 'u-treasurer', roles: [{ role: 'treasurer', schoolYearId: OLD }], mfa: true }),
    treasurerNew: await seedUserSession(db, { userId: 'u-treasurer-new', roles: [{ role: 'treasurer', schoolYearId: NEW }], mfa: true }),
    boardNew: await seedUserSession(db, { userId: 'u-board-new', roles: [{ role: 'board', schoolYearId: NEW }], mfa: true }),
  };
  await db.query(`INSERT INTO ledger_categories (id, school_year_id, direction, name, created_by) VALUES
    ('cat-in', $1, 'income', 'Składki dobrowolne', 'u-treasurer'),
    ('cat-in-new', $2, 'income', 'Składki dobrowolne', 'u-treasurer')`, [OLD, NEW]);
  await db.query(`INSERT INTO ledger_opening_balances (id, school_year_id, amount_cents, created_by, idempotency_key)
    VALUES ('ob-old', $1, 50000, 'u-treasurer', 'ob-old-key-1')`, [OLD]);
  await db.query(`INSERT INTO ledger_entries (id, school_year_id, direction, amount_cents, category_id, description, occurred_on, method, created_by, idempotency_key)
    VALUES ('le-in', $1, 'income', 120000, 'cat-in', 'Wpływy syntetyczne', '2026-10-01', 'bank', 'u-treasurer', 'le-in-key-1')`, [OLD]);
  await db.query("INSERT INTO households (id) VALUES ('h-1')");
  await db.query(`INSERT INTO payment_entries (id, household_id, school_year_id, amount_cents, received_on, method, status, created_by, idempotency_key)
    VALUES ('p-1', 'h-1', $1, 2000, '2026-10-02', 'bank', 'recorded', 'u-treasurer', 'p-1-key-001')`, [OLD]);

  await startAndConfirm(db, OLD, NEW, cookies);
  if (secondPair) await startAndConfirm(db, OTHER, OTHER_NEXT, cookies);
  return cookies;
}

// Rozpoczyna boardA (dla OLD) albo boardGlobal2 (dla drugiej pary) — zamykać
// może każda inna osoba z zarządu (cztery oczy).
async function startAndConfirm(db, year, next, cookies) {
  const env = { db };
  const starter = year === OLD ? cookies.boardA : cookies.boardGlobal2;
  const started = await call(env, 'POST', `/api/year-close/${year}/start`, starter, { nextSchoolYearId: next });
  assert.equal(started.status, 201, JSON.stringify(started.body));
  for (const [index, item] of CHECKLIST_ITEMS.entries()) {
    const cookie = index % 2 && year === OLD ? cookies.treasurer : starter;
    const response = await call(env, 'POST', `/api/year-close/${year}/checklist/${item}`, cookie, { note: `Potwierdzenie ${item}` });
    assert.equal(response.status, 201, `${year} ${item}: ${JSON.stringify(response.body)}`);
  }
}

const closePath = (year) => `/api/year-close/${year}/close`;

test('#212 (PostgreSQL): dwie osoby z zarządu naraz — drugie zamknięcie czeka na blokadę doradczą, oba 200, jeden bilans otwarcia, bez 40P01', { skip }, async () => {
  await withReal(async (db) => {
    const cookies = await setup(db);
    const errors = [];
    const first = raceEnv(db, { pauseAfter: LOCK_TABLE, errors });
    const a = call(first.env, 'POST', closePath(OLD), cookies.boardGlobal);
    await first.reached;
    const b = call(raceEnv(db, { errors }).env, 'POST', closePath(OLD), cookies.boardGlobal2);
    try {
      // Przed poprawką druga transakcja dostawała tu SHARE na księdze i czekała
      // dopiero na wiersz zamknięcia — teraz czeka na blokadę doradczą.
      assert.deepEqual(await waitForLockWaiters(db, 1), ['advisory'], 'drugie zamknięcie czeka na rd_year_close, nie na tabele księgi');
    } finally { first.release(); }
    const [ra, rb] = await Promise.all([a, b]);
    assert.deepEqual([ra.status, rb.status], [200, 200], JSON.stringify([ra.body, rb.body]));
    assert.deepEqual([ra.body.replayed, rb.body.replayed], [false, true]);
    assert.equal(rb.body.closedBy, 'u-board-global', 'druga odpowiedź pokazuje, kto zamknął rok (closedBy ≠ aktor)');
    assert.deepEqual(errors, [], 'bez 40P01 i innych błędów transakcji');
    assert.equal(await openingCount(db, NEW), 1, 'dokładnie jeden bilans otwarcia');
    assert.equal(await auditCount(db, 'year_close.closed'), 1, 'dokładnie jedno year_close.closed');
    assert.equal(await auditCount(db, 'ledger_opening_balance.carried_forward'), 1);
  });
});

test('#212 (PostgreSQL): podwójne kliknięcie tej samej osoby — drugie żądanie replayed:true; ponowienie po zamknięciu bez nowego zapisu', { skip }, async () => {
  await withReal(async (db) => {
    const cookies = await setup(db);
    const errors = [];
    const first = raceEnv(db, { pauseAfter: LOCK_TABLE, errors });
    const a = call(first.env, 'POST', closePath(OLD), cookies.boardB);
    await first.reached;
    const b = call(raceEnv(db, { errors }).env, 'POST', closePath(OLD), cookies.boardB);
    try {
      assert.deepEqual(await waitForLockWaiters(db, 1), ['advisory']);
    } finally { first.release(); }
    const [ra, rb] = await Promise.all([a, b]);
    assert.deepEqual([ra.status, rb.status], [200, 200], JSON.stringify([ra.body, rb.body]));
    assert.deepEqual([ra.body.replayed, rb.body.replayed], [false, true]);
    assert.deepEqual(errors, []);
    assert.equal(rb.body.closedBy, 'u-board-b', 'zamknął ten sam aktor (closedBy === aktor)');
    // Ponowienie po 503/timeoucie (klient nie dostał odpowiedzi), już po
    // zamknięciu: osoba z rolą zarządu bez zawężenia do roku dostaje stan
    // zamknięty z replayed:true. Przydział boardB był zawężony do roku i wygasł
    // przy TYM zamknięciu — wariant zachowawczy z #411: 409 school_year_closed
    // bez bilansu (src/pg/routes/year-close.js, wasAuthorizedAtOwnClosure).
    const retryGlobal = await call({ db }, 'POST', closePath(OLD), cookies.boardGlobal);
    assert.deepEqual([retryGlobal.status, retryGlobal.body.replayed, retryGlobal.body.closedBy], [200, true, 'u-board-b']);
    const retryScoped = await call({ db }, 'POST', closePath(OLD), cookies.boardB);
    assert.deepEqual([retryScoped.status, retryScoped.body.error, 'balance' in retryScoped.body], [409, 'school_year_closed', false]);
    assert.equal(await openingCount(db, NEW), 1);
    assert.equal(await auditCount(db, 'year_close.closed'), 1);
  });
});

test('#212 (PostgreSQL): rozpoczynający (cztery oczy) i inna osoba naraz — 409 four_eyes_required i 200, bez zakleszczenia', { skip }, async () => {
  await withReal(async (db) => {
    const cookies = await setup(db);
    const errors = [];
    const first = raceEnv(db, { pauseAfter: LOCK_TABLE, errors });
    const a = call(first.env, 'POST', closePath(OLD), cookies.boardA);
    await first.reached;
    const b = call(raceEnv(db, { errors }).env, 'POST', closePath(OLD), cookies.boardB);
    try {
      assert.deepEqual(await waitForLockWaiters(db, 1), ['advisory']);
    } finally { first.release(); }
    const [ra, rb] = await Promise.all([a, b]);
    assert.deepEqual([ra.status, ra.body.error], [409, 'four_eyes_required']);
    assert.deepEqual([rb.status, rb.body.replayed], [200, false]);
    assert.deepEqual(errors, [], 'odmowa four_eyes_required to błąd żądania, nie transakcji bazy');
    assert.equal(await openingCount(db, NEW), 1);
    assert.equal(await auditCount(db, 'year_close.closed'), 1);
  });
});

test('#212 (PostgreSQL): zamknięcie dwóch różnych lat naraz — oba 200 bez 40P01, każdy rok ma własny bilans otwarcia', { skip }, async () => {
  await withReal(async (db) => {
    const cookies = await setup(db, { secondPair: true });
    const errors = [];
    const first = raceEnv(db, { pauseAfter: LOCK_TABLE, errors });
    const a = call(first.env, 'POST', closePath(OLD), cookies.boardGlobal);
    await first.reached;
    const b = call(raceEnv(db, { errors }).env, 'POST', closePath(OTHER), cookies.boardGlobal);
    try {
      assert.deepEqual(await waitForLockWaiters(db, 1), ['advisory'], 'zamknięcie innego roku też czeka na rd_year_close');
    } finally { first.release(); }
    const [ra, rb] = await Promise.all([a, b]);
    assert.deepEqual([ra.status, rb.status], [200, 200], JSON.stringify([ra.body, rb.body]));
    assert.deepEqual([ra.body.replayed, rb.body.replayed], [false, false]);
    assert.deepEqual(errors, []);
    assert.equal(await openingCount(db, NEW), 1);
    assert.equal(await openingCount(db, OTHER_NEXT), 1);
    assert.equal(await auditCount(db, 'year_close.closed'), 2);
  });
});

test('#212 (PostgreSQL): zapisy księgi i korekty w trakcie zamknięcia czekają — w zamykanym roku 409 school_year_closed, w innym przechodzą', { skip }, async () => {
  await withReal(async (db) => {
    const cookies = await setup(db);
    const errors = [];
    const incomeBefore = await count(db, "SELECT count(*)::int AS n FROM ledger_entries WHERE school_year_id = $1", [OLD]);
    // Zamknięcie wstrzymane PRZED COMMIT: rok ma już status 'closed' w
    // transakcji, bilans otwarcia NEW jest zapisany, ale nic nie jest zatwierdzone.
    const closing = raceEnv(db, { pauseBeforeCommit: true, errors });
    const close = call(closing.env, 'POST', closePath(OLD), cookies.boardB);
    await closing.reached;
    const env = raceEnv(db, { errors }).env;
    const writes = [
      // Wpis księgi w zamykanym roku: czeka na SHARE na ledger_entries.
      call(env, 'POST', '/api/ledger', cookies.treasurer, {
        schoolYearId: OLD, direction: 'income', amountCents: 1000, categoryId: 'cat-in',
        description: 'Spóźniony wpis syntetyczny', occurredOn: '2027-08-30', method: 'bank',
      }, key('le')),
      // Korekta księgi w zamykanym roku: FOR UPDATE wpisu przechodzi, INSERT korekty czeka.
      call(env, 'POST', '/api/ledger/le-in/corrections', cookies.treasurer, { amountCents: 100, reason: 'Spóźniona korekta syntetyczna' }, key('lc')),
      // Korekta wpłaty (wpłata częściowa): tabele wpłat nie są blokowane przez
      // LOCK TABLE — czeka trigger zamrożenia na wiersz zamknięcia (FOR SHARE).
      call(env, 'POST', '/api/payments/p-1/corrections', cookies.treasurer, { amountCents: 500, reason: 'Korekta częściowa syntetyczna' }, key('pc')),
      // Wpis w INNYM (następnym) roku: czeka tylko na zwolnienie blokady tabeli.
      call(env, 'POST', '/api/ledger', cookies.treasurerNew, {
        schoolYearId: NEW, direction: 'income', amountCents: 3000, categoryId: 'cat-in-new',
        description: 'Wpis syntetyczny nowego roku', occurredOn: '2027-10-01', method: 'bank',
      }, key('le')),
      // Bilans otwarcia nowego roku (LOCK … SHARE ROW EXCLUSIVE w ledger-cash): czeka,
      // potem widzi bilans przeniesiony przez zamknięcie.
      call(env, 'POST', '/api/ledger/opening-balance', cookies.boardNew, {
        schoolYearId: NEW, bankCents: 100, cashCents: 0, note: 'Ręczny bilans syntetyczny',
      }, key('ob')),
    ];
    let waiting;
    try {
      waiting = await waitForLockWaiters(db, writes.length);
    } finally { closing.release(); }
    assert.equal(waiting.length, writes.length, `wszystkie zapisy czekały na blokadę zamknięcia: ${JSON.stringify(waiting)}`);
    const closed = await close;
    assert.deepEqual([closed.status, closed.body.replayed], [200, false], JSON.stringify(closed.body));
    const [entryOld, correctionOld, paymentCorrection, entryNew, opening] = await Promise.all(writes);
    assert.deepEqual([entryOld.status, entryOld.body.error], [409, 'school_year_closed']);
    assert.deepEqual([correctionOld.status, correctionOld.body.error], [409, 'school_year_closed']);
    assert.deepEqual([paymentCorrection.status, paymentCorrection.body.error], [409, 'school_year_closed']);
    assert.equal(entryNew.status, 201, JSON.stringify(entryNew.body));
    assert.deepEqual([opening.status, opening.body.error], [409, 'opening_balance_exists']);
    assert.deepEqual(errors.filter((code) => code === '40P01' || code === '40001'), [], 'bez zakleszczeń i błędów serializacji');

    // Nigdy „w połowie”: nic ze starego roku nie weszło po wyliczeniu bilansu.
    assert.equal(await count(db, 'SELECT count(*)::int AS n FROM ledger_entries WHERE school_year_id = $1', [OLD]), incomeBefore);
    assert.equal(await count(db, "SELECT count(*)::int AS n FROM ledger_corrections WHERE ledger_entry_id = 'le-in'"), 0);
    assert.equal(await count(db, "SELECT count(*)::int AS n FROM payment_corrections WHERE payment_entry_id = 'p-1'"), 0);
    const closure = (await db.query('SELECT closing_balance_cents FROM school_year_closures WHERE school_year_id = $1', [OLD])).rows[0];
    const carried = (await db.query('SELECT amount_cents FROM ledger_opening_balances WHERE school_year_id = $1', [NEW])).rows;
    assert.deepEqual(carried.map((row) => Number(row.amount_cents)), [Number(closure.closing_balance_cents)]);
    assert.equal(Number(closure.closing_balance_cents), 170000, 'bilans 500,00 + 1200,00 EUR bez spóźnionych zapisów');
  });
});

test('#212 (PostgreSQL): korekta wpłaty niezatwierdzona przed zamknięciem — zamknięcie czeka na jej COMMIT (nigdy w połowie)', { skip }, async () => {
  await withReal(async (db) => {
    const cookies = await setup(db);
    const errors = [];
    // Korekta wpłaty wstrzymana przed COMMIT: trzyma FOR SHARE na wierszu zamknięcia.
    const correcting = raceEnv(db, { pauseAfter: /INSERT INTO payment_corrections/, errors });
    const correction = call(correcting.env, 'POST', '/api/payments/p-1/corrections', cookies.treasurer,
      { amountCents: 500, reason: 'Korekta częściowa syntetyczna' }, key('pc'));
    await correcting.reached;
    const close = call(raceEnv(db, { errors }).env, 'POST', closePath(OLD), cookies.boardB);
    try {
      assert.equal((await waitForLockWaiters(db, 1)).length, 1, 'zamknięcie czeka na niezatwierdzoną korektę wpłaty');
    } finally { correcting.release(); }
    const [rc, rclose] = await Promise.all([correction, close]);
    assert.equal(rc.status, 201, JSON.stringify(rc.body));
    assert.deepEqual([rclose.status, rclose.body.replayed], [200, false], JSON.stringify(rclose.body));
    assert.deepEqual(errors, []);
    assert.equal(await count(db, "SELECT count(*)::int AS n FROM payment_corrections WHERE payment_entry_id = 'p-1'"), 1);
  });
});

// ------------------------------------------------ uzgodnienie rachunku a zamknięcie (#80)

// Szkic uzgodnienia roku OLD z jedną pozycją wyciągu równą wpisowi `le-in`
// (1200,00 EUR, 2026-10-01), założony PRZED zamknięciem.
async function reconciliationDraft(db, cookies) {
  const env = { db };
  const created = await call(env, 'POST', '/api/reconciliations', cookies.treasurer,
    { schoolYearId: OLD, statementDate: '2026-10-31', statementBalanceCents: 170000 }, key('rec'));
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const id = created.body.reconciliation.id;
  const lines = await call(env, 'POST', `/api/reconciliations/${id}/lines`, cookies.treasurer,
    { lines: [{ bookedOn: '2026-10-01', amountCents: 120000 }] }, key('imp'));
  assert.equal(lines.status, 201, JSON.stringify(lines.body));
  const detail = await call(env, 'GET', `/api/reconciliations/${id}`, cookies.treasurer, undefined);
  assert.equal(detail.status, 200, JSON.stringify(detail.body));
  return { id, lineId: detail.body.lines[0].id };
}

const matchBody = (draft) => ({ statementLineId: draft.lineId, ledgerEntryId: 'le-in' });
const activeMatches = (db) => count(db, "SELECT count(*)::int AS n FROM bank_reconciliation_matches WHERE revoked_at IS NULL");

test('#80 (PostgreSQL): dopasowanie, nowe uzgodnienie i import w trakcie zamknięcia czekają i dostają 409 school_year_closed, nigdy 503/40P01', { skip }, async () => {
  await withReal(async (db) => {
    const cookies = await setup(db);
    const draft = await reconciliationDraft(db, cookies);
    const errors = [];
    const closing = raceEnv(db, { pauseBeforeCommit: true, errors });
    const close = call(closing.env, 'POST', closePath(OLD), cookies.boardB);
    await closing.reached;
    const env = raceEnv(db, { errors }).env;
    const writes = [
      call(env, 'POST', `/api/reconciliations/${draft.id}/matches`, cookies.treasurer, matchBody(draft), key('m')),
      call(env, 'POST', '/api/reconciliations', cookies.treasurer,
        { schoolYearId: OLD, statementDate: '2026-11-30', statementBalanceCents: 0 }, key('rec')),
      call(env, 'POST', `/api/reconciliations/${draft.id}/lines`, cookies.treasurer,
        { lines: [{ bookedOn: '2026-10-05', amountCents: 100 }] }, key('imp')),
    ];
    let waiting;
    try {
      waiting = await waitForLockWaiters(db, writes.length);
    } finally { closing.release(); }
    assert.equal(waiting.length, writes.length, `wszystkie zapisy uzgodnienia czekały na zamknięcie: ${JSON.stringify(waiting)}`);
    const closed = await close;
    assert.deepEqual([closed.status, closed.body.replayed], [200, false], JSON.stringify(closed.body));
    for (const result of await Promise.all(writes)) {
      assert.deepEqual([result.status, result.body.error], [409, 'school_year_closed'], JSON.stringify(result.body));
    }
    assert.deepEqual(errors.filter((code) => code === '40P01' || code === '40001'), [], 'bez zakleszczeń i błędów serializacji');
    assert.equal(await activeMatches(db), 0, 'dopasowanie nie weszło po zamknięciu');
    assert.equal(await count(db, 'SELECT count(*)::int AS n FROM bank_reconciliations WHERE school_year_id = $1', [OLD]), 1);
    assert.equal(await count(db, 'SELECT count(*)::int AS n FROM bank_statement_lines WHERE reconciliation_id = $1', [draft.id]), 1);
  });
});

test('#80 (PostgreSQL): dopasowanie niezatwierdzone przed zamknięciem — zamknięcie czeka na jego COMMIT; potem cofnięcie i zatwierdzenie → 409 school_year_closed', { skip }, async () => {
  await withReal(async (db) => {
    const cookies = await setup(db);
    const draft = await reconciliationDraft(db, cookies);
    const errors = [];
    // Dopasowanie wstrzymane po INSERT: trzyma FOR SHARE na wierszu zamknięcia
    // (trigger zamrożenia), więc zamknięcie nie może go minąć.
    const matching = raceEnv(db, { pauseAfter: /INSERT INTO bank_reconciliation_matches/, errors });
    const match = call(matching.env, 'POST', `/api/reconciliations/${draft.id}/matches`, cookies.treasurer, matchBody(draft), key('m'));
    await matching.reached;
    const close = call(raceEnv(db, { errors }).env, 'POST', closePath(OLD), cookies.boardB);
    try {
      assert.equal((await waitForLockWaiters(db, 1)).length, 1, 'zamknięcie czeka na niezatwierdzone dopasowanie');
    } finally { matching.release(); }
    const [matched, closed] = await Promise.all([match, close]);
    assert.equal(matched.status, 201, JSON.stringify(matched.body));
    assert.deepEqual([closed.status, closed.body.replayed], [200, false], JSON.stringify(closed.body));
    assert.deepEqual(errors, []);
    assert.equal(await activeMatches(db), 1);

    // Po zamknięciu: przydziały zawężone do roku OLD są wygaszone (krok 5 zamknięcia),
    // więc wołamy rolami bez zakresu roku (to trigger zamrożenia, nie brak roli, ma odmówić).
    // Po zamknięciu: cofnięcie dopasowania i zatwierdzenie uzgodnienia są odrzucane kontrolowanie.
    const env = { db };
    const revoked = await call(env, 'POST', `/api/reconciliations/${draft.id}/matches/${matched.body.match.id}/revocation`,
      cookies.boardGlobal, { reason: 'Cofnięcie syntetyczne po zamknięciu' });
    assert.deepEqual([revoked.status, revoked.body.error], [409, 'school_year_closed'], JSON.stringify(revoked.body));
    const confirmed = await call(env, 'POST', `/api/reconciliations/${draft.id}/confirm`, cookies.boardGlobal2, {});
    assert.deepEqual([confirmed.status, confirmed.body.error], [409, 'school_year_closed'], JSON.stringify(confirmed.body));
    assert.equal(await activeMatches(db), 1, 'dopasowanie sprzed zamknięcia zostaje');
  });
});

// ------------------------------------------------ kontrola pozytywna (stan sprzed #212)

test('#212 kontrola pozytywna: bez blokady doradczej te same przeploty kończą się 40P01 (test wykrywa regresję)', { skip }, async () => {
  for (const [label, secondYear] of [['ten sam rok', OLD], ['dwa różne lata', OTHER]]) {
    await withReal(async (db) => {
      const cookies = await setup(db, { secondPair: secondYear === OTHER });
      const errors = [];
      const first = raceEnv(db, { pauseAfter: LOCK_TABLE, dropAdvisoryLock: true, errors });
      const a = call(first.env, 'POST', closePath(OLD), cookies.boardGlobal);
      await first.reached;
      const b = call(raceEnv(db, { dropAdvisoryLock: true, errors }).env, 'POST', closePath(secondYear),
        secondYear === OTHER ? cookies.boardGlobal : cookies.boardGlobal2);
      let waiting;
      try {
        // Druga transakcja dostała SHARE na księdze (SHARE nie wyklucza sam siebie)
        // i czeka na wiersz zamknięcia (ten sam rok) albo na INSERT bilansu (inny rok).
        waiting = await waitForLockWaiters(db, 1);
      } finally { first.release(); }
      assert.equal(waiting.includes('advisory'), false, `${label}: bez blokady doradczej nikt na nią nie czeka`);
      const results = await Promise.all([a, b]);
      assert.ok(errors.includes('40P01'), `${label}: oczekiwane zakleszczenie 40P01, błędy: ${JSON.stringify(errors)}, odpowiedzi: ${JSON.stringify(results.map((r) => r.status))}`);
      assert.ok(results.some((r) => r.status === 503), `${label}: jedna osoba dostaje 503 (bez ponowienia)`);
    });
  }
});
