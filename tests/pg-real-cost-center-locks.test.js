// #208 (dalsza część): testy z barierą na PRAWDZIWYM PostgreSQL dla blokady
// wpisu księgi w przypisaniu do centrów kosztów (src/pg/routes/ledger-cost-centers.js,
// `loadEntry(..., { lock: true })` → `SELECT id FROM ledger_entries WHERE id = $1
// FOR UPDATE`). Wzorzec jak w pg-real-payment-locks: pierwsze żądanie staje W
// TRANSAKCJI po zapisie (tests/helpers/pg-barrier.js), drugie startuje osobnym
// połączeniem, test sprawdza w pg_stat_activity, że czeka na blokadę z kodu
// trasy (tekst czekającego zapytania), i dopiero wtedy pierwsze zatwierdza.
// Transakcje biegną z `retries: 0`.
//
// Kontrola mutacyjna: scripts/check-lock-mutations.js (mutant
// `cost-center-allocation`) usuwa `FOR UPDATE` z `loadEntry`; bez niego drugie
// żądanie nie czeka na blokadę z API, tylko staje dopiero na indeksie
// unikalnym wersji przypisania, więc asercja `assertWaitsOn` robi się czerwona.
//
// Plik działa wyłącznie z RD_TEST_PG_URL (npm run test:pg-real). Wyłącznie
// dane syntetyczne (@example.invalid); nic nie wysyła e-maili.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRealTestDb, seedClass, seedSchoolYear, seedUserSession } from './helpers/pg.js';
import { barrierEnv, callApi, countRows, waitForLockWaitersWithQuery } from './helpers/pg-barrier.js';

const skip = process.env.RD_TEST_PG_URL ? false : 'brak RD_TEST_PG_URL (wymaga prawdziwego PostgreSQL)';
const YEAR = 'y-2026';
let seq = 0;
const key = (prefix) => `${prefix}-${String(++seq).padStart(6, '0')}-${crypto.randomUUID().slice(0, 8)}`;
const count = (db, sql, params) => countRows(db, sql, params);
const auditCount = (db, action) => count(db, 'SELECT count(*)::int AS n FROM audit_events WHERE action = $1', [action]);
const FOR_UPDATE_ENTRY = /FROM ledger_entries WHERE id = \$1 FOR UPDATE/;

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

async function setup(db) {
  await seedSchoolYear(db, YEAR);
  await seedClass(db, { id: 'cl-1', schoolYearId: YEAR, name: 'Klasa syntetyczna 1' });
  await seedClass(db, { id: 'cl-2', schoolYearId: YEAR, name: 'Klasa syntetyczna 2' });
  const cookie = await seedUserSession(db, { userId: 'u-tr', mfa: true, roles: [{ role: 'treasurer', schoolYearId: YEAR }] });
  await db.query("INSERT INTO ledger_categories (id, school_year_id, direction, name, created_by) VALUES ('cat-in', $1, 'income', 'Składki dobrowolne', 'u-tr')", [YEAR]);
  await db.query(`INSERT INTO ledger_entries (id, school_year_id, direction, amount_cents, category_id, description, occurred_on, method, created_by, idempotency_key)
    VALUES ('le-1', $1, 'income', 10000, 'cat-in', 'Wpis syntetyczny', '2026-10-01', 'bank', 'u-tr', 'le-1-key-0001')`, [YEAR]);
  return cookie;
}
const path = '/api/ledger/le-1/allocations';
const allocationBody = (classId, amountCents) => ({ items: [{ classId, amountCents }] });

test('#208 (bariera): dwa pierwsze przypisania tego samego wpisu (różne klucze) — drugie czeka na blokadę wpisu i dostaje 409 allocation_version_conflict', { skip }, async () => {
  await withReal(async (db) => {
    const cookie = await setup(db);
    const { results: [a, b], waits, waitingSql } = await race(db, {
      pauseAfter: /INSERT INTO ledger_allocation_items/,
      first: (env) => callApi(env, 'POST', path, cookie, allocationBody('cl-1', 6000), key('al')),
      others: [(env) => callApi(env, 'POST', path, cookie, allocationBody('cl-2', 6000), key('al'))],
    });
    assertWaitsOn({ waits, waitingSql }, FOR_UPDATE_ENTRY, 'drugie przypisanie czeka na blokadę wpisu');
    assert.equal(a.status, 201, JSON.stringify(a.body));
    assert.deepEqual([b.status, b.body.error], [409, 'allocation_version_conflict']);
    assert.equal(await count(db, "SELECT count(*)::int AS n FROM ledger_allocation_versions WHERE ledger_entry_id = 'le-1'"), 1);
    assert.equal(await count(db, "SELECT count(*)::int AS n FROM ledger_allocation_items WHERE class_id = 'cl-2'"), 0);
    assert.equal(await auditCount(db, 'ledger.allocation.created'), 1);
  });
});

test('#208 (bariera): korekta wpisu 70 € w toku i przypisanie 100 € — przypisanie czeka na blokadę wpisu i po korekcie dostaje 409 allocation_exceeds_net', { skip }, async () => {
  await withReal(async (db) => {
    const cookie = await setup(db);
    const { results: [a, b], waits, waitingSql } = await race(db, {
      pauseAfter: /INSERT INTO ledger_corrections/,
      first: (env) => callApi(env, 'POST', '/api/ledger/le-1/corrections', cookie, { amountCents: 7000, reason: 'Korekta syntetyczna' }, key('lc')),
      others: [(env) => callApi(env, 'POST', path, cookie, allocationBody('cl-1', 10000), key('al'))],
    });
    assertWaitsOn({ waits, waitingSql }, FOR_UPDATE_ENTRY, 'przypisanie czeka na blokadę wpisu trzymaną przez korektę');
    assert.equal(a.status, 201, JSON.stringify(a.body));
    assert.deepEqual([b.status, b.body.error], [409, 'allocation_exceeds_net']);
    assert.equal(await count(db, 'SELECT count(*)::int AS n FROM ledger_allocation_versions'), 0);
    assert.equal(await auditCount(db, 'ledger.allocation.created'), 0);
  });
});
