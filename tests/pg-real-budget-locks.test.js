// #208 (dalsza część): testy z barierą na PRAWDZIWYM PostgreSQL dla blokad
// `FOR UPDATE` w preliminarzu (src/pg/routes/ledger-budget.js: `deactivateCategory`
// — wiersz kategorii, `reviseLine` — wiersz linii) i w poprawkach bilansu
// otwarcia (src/pg/routes/ledger-cash.js: `createAdjustment` — wiersz bilansu).
// Wzorzec jak w pg-real-cost-center-locks: pierwsze żądanie staje W TRANSAKCJI po
// zapisie (tests/helpers/pg-barrier.js), drugie startuje osobnym połączeniem,
// test sprawdza w pg_stat_activity, że czeka na blokadę z kodu trasy (tekst
// czekającego zapytania), i dopiero wtedy pierwsze zatwierdza. Transakcje biegną
// z `retries: 0`. Po fakcie liczone są wiersze i zdarzenia audytu.
//
// Kontrola mutacyjna: scripts/check-lock-mutations.js (mutanty `budget-category`,
// `budget-revision`, `opening-adjustment`) usuwa `FOR UPDATE` z odpowiedniej
// funkcji; bez niego drugie żądanie nie czeka na blokadę z API (albo stoi na
// innym zapytaniu, albo wcale), więc asercja `assertWaitsOn` robi się czerwona.
// Poza zakresem: `createOpening` używa `LOCK TABLE`, nie `FOR UPDATE`.
//
// Plik działa wyłącznie z RD_TEST_PG_URL (npm run test:pg-real). Wyłącznie
// dane syntetyczne (@example.invalid); nic nie wysyła e-maili.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRealTestDb, seedSchoolYear, seedUserSession } from './helpers/pg.js';
import { barrierEnv, callApi, countRows, waitForLockWaitersWithQuery } from './helpers/pg-barrier.js';

const skip = process.env.RD_TEST_PG_URL ? false : 'brak RD_TEST_PG_URL (wymaga prawdziwego PostgreSQL)';
const YEAR = 'y-2026';
let seq = 0;
const key = (prefix) => `${prefix}-${String(++seq).padStart(6, '0')}-${crypto.randomUUID().slice(0, 8)}`;
const count = (db, sql, params) => countRows(db, sql, params);
const auditCount = (db, action) => count(db, 'SELECT count(*)::int AS n FROM audit_events WHERE action = $1', [action]);
const FOR_UPDATE_CATEGORY = /FROM ledger_categories WHERE id = \$1 FOR UPDATE/;
const FOR_UPDATE_LINE = /FROM ledger_budget_lines l WHERE l\.id = \$1 FOR UPDATE/;
const FOR_UPDATE_OPENING = /FROM ledger_opening_balances WHERE school_year_id = \$1 FOR UPDATE/;

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

async function setup(db, { role = 'treasurer' } = {}) {
  await seedSchoolYear(db, YEAR);
  const cookie = await seedUserSession(db, { userId: 'u-fin', mfa: true, roles: [{ role, schoolYearId: YEAR }] });
  await db.query("INSERT INTO ledger_categories (id, school_year_id, direction, name, created_by) VALUES ('cat-out', $1, 'expense', 'Wydatki syntetyczne', 'u-fin')", [YEAR]);
  return cookie;
}
async function seedLine(db) {
  await db.query(`INSERT INTO ledger_budget_lines (id, school_year_id, category_id, planned_cents, created_by, idempotency_key)
    VALUES ('bl-1', $1, 'cat-out', 10000, 'u-fin', 'bl-1-key-0001')`, [YEAR]);
}
async function seedOpening(db) {
  await db.query(`INSERT INTO ledger_opening_balances (id, school_year_id, amount_cents, cash_cents, note, created_by, idempotency_key)
    VALUES ('ob-1', $1, 10000, 10000, 'Bilans syntetyczny', 'u-fin', 'ob-1-key-0001')`, [YEAR]);
}

test('#208 (bariera): dwie dezaktywacje tej samej kategorii (różne klucze) — druga czeka na blokadę kategorii i dostaje 409 category_inactive', { skip }, async () => {
  await withReal(async (db) => {
    const cookie = await setup(db);
    const path = '/api/ledger/categories/cat-out/deactivation';
    const { results: [a, b], waits, waitingSql } = await race(db, {
      pauseAfter: /INSERT INTO ledger_category_deactivations/,
      first: (env) => callApi(env, 'POST', path, cookie, { reason: 'Powód syntetyczny A' }, key('cd')),
      others: [(env) => callApi(env, 'POST', path, cookie, { reason: 'Powód syntetyczny B' }, key('cd'))],
    });
    assertWaitsOn({ waits, waitingSql }, FOR_UPDATE_CATEGORY, 'druga dezaktywacja czeka na blokadę kategorii');
    assert.equal(a.status, 201, JSON.stringify(a.body));
    assert.deepEqual([b.status, b.body.error], [409, 'category_inactive']);
    assert.equal(await count(db, "SELECT count(*)::int AS n FROM ledger_category_deactivations WHERE category_id = 'cat-out'"), 1);
    assert.equal(await count(db, "SELECT count(*)::int AS n FROM ledger_categories WHERE id = 'cat-out' AND NOT active"), 1);
    assert.equal(await auditCount(db, 'ledger.category.deactivated'), 1);
  });
});

test('#208 (bariera): dwie rewizje tej samej linii preliminarza (różne klucze) — druga czeka na blokadę linii i dostaje 409 budget_line_superseded', { skip }, async () => {
  await withReal(async (db) => {
    const cookie = await setup(db);
    await seedLine(db);
    const path = '/api/ledger/budget/bl-1/revisions';
    const { results: [a, b], waits, waitingSql } = await race(db, {
      pauseAfter: /INSERT INTO ledger_budget_lines/,
      first: (env) => callApi(env, 'POST', path, cookie, { plannedCents: 12000, reason: 'Rewizja syntetyczna A' }, key('br')),
      others: [(env) => callApi(env, 'POST', path, cookie, { plannedCents: 15000, reason: 'Rewizja syntetyczna B' }, key('br'))],
    });
    assertWaitsOn({ waits, waitingSql }, FOR_UPDATE_LINE, 'druga rewizja czeka na blokadę linii');
    assert.equal(a.status, 201, JSON.stringify(a.body));
    assert.deepEqual([b.status, b.body.error], [409, 'budget_line_superseded']);
    assert.equal(await count(db, "SELECT count(*)::int AS n FROM ledger_budget_lines WHERE supersedes_id = 'bl-1'"), 1);
    assert.equal(await count(db, 'SELECT count(*)::int AS n FROM ledger_budget_lines'), 2);
    assert.equal(await auditCount(db, 'ledger.budget_line.revised'), 1);
  });
});

test('#208 (bariera): dwie poprawki kasy -60 € przy 100 € w bilansie otwarcia — druga czeka na blokadę bilansu i dostaje 409 cash_below_zero', { skip }, async () => {
  await withReal(async (db) => {
    const cookie = await setup(db, { role: 'board' });
    await seedOpening(db);
    const path = '/api/ledger/opening-balance/adjustments';
    const body = (reason) => ({ schoolYearId: YEAR, amountCents: -6000, cashCents: -6000, reason });
    const { results: [a, b], waits, waitingSql } = await race(db, {
      pauseAfter: /INSERT INTO ledger_opening_balance_adjustments/,
      first: (env) => callApi(env, 'POST', path, cookie, body('Poprawka syntetyczna A'), key('oa')),
      others: [(env) => callApi(env, 'POST', path, cookie, body('Poprawka syntetyczna B'), key('oa'))],
    });
    assertWaitsOn({ waits, waitingSql }, FOR_UPDATE_OPENING, 'druga poprawka czeka na blokadę bilansu otwarcia');
    assert.equal(a.status, 201, JSON.stringify(a.body));
    assert.deepEqual([b.status, b.body.error], [409, 'cash_below_zero']);
    assert.equal(await count(db, 'SELECT count(*)::int AS n FROM ledger_opening_balance_adjustments'), 1);
    assert.equal(await auditCount(db, 'ledger_opening_balance.adjusted'), 1);
  });
});
